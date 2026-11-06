import EventEmitter from "node:events";
import { WebSocket } from "ws";
import { ethers } from "ethers";
import StrictEventEmitter from "strict-event-emitter-types";
import { Logger } from "@skandha/types/lib/index.js";
import { deepHexlify } from "@skandha/utils/lib/hexlify";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import type { LifecycleEvent } from "@skandha/types/lib/explorer/index.js";
import { FrameTxMempoolEntry as MempoolEntry } from "../entities/FrameTxMempoolEntry.js";
import type { ExplorerService } from "./ExplorerService/service.js";

export enum ExecutorEvent {
  pendingUserOps = "pendingUserOps", // user ops that are in the mempool
  submittedUserOps = "submittedUserOps", // user ops submitted onchain, but not yet settled
  onChainUserOps = "onChainUserOps", // user ops found onchain
  ping = "ping",
  explorerEvents = "explorerEvents", // lifecycle events from ExplorerService
}

export type ExecutorEvents = {
  [ExecutorEvent.pendingUserOps]: (entry: MempoolEntry) => void;
  [ExecutorEvent.submittedUserOps]: (entry: MempoolEntry) => void;
  [ExecutorEvent.onChainUserOps]: (entry: MempoolEntry) => void;
  [ExecutorEvent.ping]: () => void;
};

export type IExecutorEventBus = StrictEventEmitter<
  EventEmitter,
  ExecutorEvents
>;

export class ExecutorEventBus extends (EventEmitter as {
  new (): IExecutorEventBus;
}) {}

export interface SubscriptionLimits {
  maxPerSocket: number;
  maxTotal: number;
  maxBufferedBytes: number;
}

export class SubscriptionService {
  constructor(
    private eventBus: ExecutorEventBus,
    private logger: Logger,
    private explorerService: ExplorerService | null = null,
    private limits: SubscriptionLimits = { maxPerSocket: 32, maxTotal: 4096, maxBufferedBytes: 1024 * 1024 }
  ) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid subscription limits");
    }
    this.eventBus.on(
      ExecutorEvent.pendingUserOps,
      this.onPendingUserOps.bind(this)
    );
    this.eventBus.on(
      ExecutorEvent.submittedUserOps,
      this.onSubmittedUserOps.bind(this)
    );
    this.eventBus.on(
      ExecutorEvent.onChainUserOps,
      this.onOnChainUserOps.bind(this)
    );
    this.explorerService?.onEvent((event) => this.onExplorerEvent(event));
  }

  private events: {
    [event in ExecutorEvent]: Set<string>;
  } = {
    [ExecutorEvent.pendingUserOps]: new Set(),
    [ExecutorEvent.submittedUserOps]: new Set(),
    [ExecutorEvent.onChainUserOps]: new Set(),
    [ExecutorEvent.ping]: new Set(),
    [ExecutorEvent.explorerEvents]: new Set(),
  };
  private listeners: { [id: string]: WebSocket } = {};
  private sockets = new Map<WebSocket, { ids: Set<string>; cleanup: () => void }>();
  private subscriptionCount = 0;

  private register(socket: WebSocket): string {
    const existing = this.sockets.get(socket);
    if (socket.readyState !== WebSocket.OPEN) {
      throw new RpcError("Socket is not open", RpcErrorCodes.INVALID_REQUEST);
    }
    if ((existing?.ids.size ?? 0) >= this.limits.maxPerSocket || this.subscriptionCount >= this.limits.maxTotal) {
      throw new RpcError("Subscription limit reached; unsubscribe before retrying", RpcErrorCodes.SERVER_ERROR);
    }
    let owner = existing;
    if (!owner) {
      const cleanup = () => this.unsubscribeSocket(socket);
      owner = { ids: new Set(), cleanup };
      this.sockets.set(socket, owner);
      socket.once("close", cleanup);
      socket.once("error", cleanup);
    }
    const id = this.generateEventId();
    owner.ids.add(id);
    this.listeners[id] = socket;
    this.subscriptionCount++;
    return id;
  }

  private unsubscribeSocket(socket: WebSocket): void {
    for (const id of [...(this.sockets.get(socket)?.ids ?? [])]) this.unsubscribe(socket, id);
  }

  private send(id: string, response: object): void {
    const socket = this.listeners[id];
    if (!socket) return;
    if (socket.readyState !== WebSocket.OPEN) {
      this.unsubscribeSocket(socket);
      return;
    }
    if (socket.bufferedAmount > this.limits.maxBufferedBytes) {
      this.unsubscribeSocket(socket);
      socket.close(1013, "Slow subscription consumer");
      return;
    }
    try { socket.send(JSON.stringify(response)); }
    catch (err) {
      this.unsubscribeSocket(socket);
      this.logger.error(err, "Could not send subscription event");
    }
  }

  listenPendingUserOps(socket: WebSocket): string {
    return this.listen(socket, ExecutorEvent.pendingUserOps);
  }

  listenSubmittedUserOps(socket: WebSocket): string {
    return this.listen(socket, ExecutorEvent.submittedUserOps);
  }

  listenOnChainUserOps(socket: WebSocket): string {
    return this.listen(socket, ExecutorEvent.onChainUserOps);
  }

  listenPing(socket: WebSocket): string {
    return this.listen(socket, ExecutorEvent.ping);
  }

  /**
   * `sinceSeq` given: replay every retained event with a greater `seq`, then
   * continue live. Omitted: live events only.
   *
   * Registration and replay happen on the next tick because `app.ts` sends the
   * subscribe response synchronously after this returns; the client therefore
   * learns its subscription id before any event carrying it arrives. Anything
   * recorded in between is picked up by the replay, so nothing is lost or
   * duplicated.
   */
  listenExplorerEvents(socket: WebSocket, sinceSeq?: number): string {
    const explorer = this.explorerService;
    if (!explorer) {
      throw new RpcError(
        "Explorer is disabled: start the node with --explorer.enable",
        RpcErrorCodes.METHOD_NOT_FOUND
      );
    }
    const id = this.register(socket);
    setImmediate(() => {
      if (this.listeners[id] !== socket) return; // unsubscribed in the meantime
      if (sinceSeq !== undefined) {
        for (const event of explorer.eventsSince(
          sinceSeq,
          Number.MAX_SAFE_INTEGER
        )) {
          this.sendExplorerEvent(id, event);
        }
      }
      // A socket that closed during replay was unsubscribed by
      // sendExplorerEvent; do not re-add its dead id to the live set.
      if (this.listeners[id] === socket) {
        this.events[ExecutorEvent.explorerEvents].add(id);
      }
    });
    this.logger.debug(`${id} subscribed for ${ExecutorEvent.explorerEvents}`);
    return id;
  }

  unsubscribe(socket: WebSocket, id: string): void {
    if (!Object.hasOwn(this.listeners, id) || this.listeners[id] !== socket) return;
    delete this.listeners[id];
    this.subscriptionCount--;
    const owner = this.sockets.get(socket);
    owner?.ids.delete(id);
    if (owner && owner.ids.size === 0) {
      socket.off("close", owner.cleanup);
      socket.off("error", owner.cleanup);
      this.sockets.delete(socket);
    }
    for (const event in ExecutorEvent) {
      this.events[event as ExecutorEvent].delete(id);
    }
    this.logger.debug(`${id} unsubscribed`);
  }

  onPendingUserOps(entry: MempoolEntry): void {
    const { tx, txHash, sender, payer, factory, submittedTime } = entry;
    this.propagate(ExecutorEvent.pendingUserOps, {
      tx,
      txHash,
      sender,
      payer,
      factory,
      submittedTime,
      status: "Pending",
    });
  }

  onSubmittedUserOps(entry: MempoolEntry): void {
    const { tx, txHash, transaction, revertReason } = entry;
    const status =
      Object.keys(MempoolEntryStatus).find(
        (status) =>
          entry.status ===
          MempoolEntryStatus[status as keyof typeof MempoolEntryStatus]
      ) ?? "New";
    this.propagate(ExecutorEvent.submittedUserOps, {
      tx,
      txHash,
      transaction,
      status,
      revertReason: revertReason,
    });
  }

  onOnChainUserOps(entry: MempoolEntry): void {
    const { tx, txHash, actualTransaction } = entry;
    this.propagate(ExecutorEvent.onChainUserOps, {
      tx,
      txHash,
      transaction: actualTransaction,
      status: "onChain",
    });
  }

  onPing(): void {
    this.propagate(ExecutorEvent.ping);
  }

  private listen(socket: WebSocket, event: ExecutorEvent): string {
    const id = this.register(socket);
    this.events[event].add(id);
    this.logger.debug(`${id} subscribed for ${event}`);
    return id;
  }

  private propagate(event: ExecutorEvent, data?: object): void {
    if (data != undefined) {
      data = deepHexlify(data);
    }
    for (const id of this.events[event]) {
      const response: object = {
        jsonrpc: "2.0",
        method: "skandha_subscription",
        params: {
          subscription: id,
          result: data,
        },
      };
      this.send(id, response);
    }
  }

  private onExplorerEvent(event: LifecycleEvent): void {
    for (const id of [...this.events[ExecutorEvent.explorerEvents]]) {
      this.sendExplorerEvent(id, event);
    }
  }

  // Explorer events are plain JSON: deliberately NOT passed through deepHexlify.
  private sendExplorerEvent(id: string, event: LifecycleEvent): void {
    this.send(id, {
      jsonrpc: "2.0",
      method: "skandha_subscription",
      params: { subscription: id, result: event },
    });
  }

  private generateEventId(): string {
    const id = ethers.utils.hexlify(ethers.utils.randomBytes(16));
    for (const event in ExecutorEvent) {
      if (this.events[event as ExecutorEvent].has(id)) {
        // retry if id already exists
        return this.generateEventId();
      }
    }
    return id;
  }
}
