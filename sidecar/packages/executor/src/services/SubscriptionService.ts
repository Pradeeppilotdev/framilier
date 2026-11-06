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

export class SubscriptionService {
  constructor(
    private eventBus: ExecutorEventBus,
    private logger: Logger,
    private explorerService: ExplorerService | null = null
  ) {
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
    const id = this.generateEventId();
    this.listeners[id] = socket;
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
    delete this.listeners[id];
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
    const id = this.generateEventId();
    this.listeners[id] = socket;
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
      try {
        const socket = this.listeners[id];
        if (
          socket.readyState === WebSocket.CLOSED ||
          socket.readyState === WebSocket.CLOSING
        ) {
          this.unsubscribe(socket, id);
          return;
        }
        this.listeners[id].send(JSON.stringify(response));
      } catch (err) {
        this.logger.error(err, `Could not send event. Id: ${id}`);
      }
    }
  }

  private onExplorerEvent(event: LifecycleEvent): void {
    for (const id of [...this.events[ExecutorEvent.explorerEvents]]) {
      this.sendExplorerEvent(id, event);
    }
  }

  // Explorer events are plain JSON: deliberately NOT passed through deepHexlify.
  private sendExplorerEvent(id: string, event: LifecycleEvent): void {
    const socket = this.listeners[id];
    if (!socket) return;
    if (
      socket.readyState === WebSocket.CLOSED ||
      socket.readyState === WebSocket.CLOSING
    ) {
      this.unsubscribe(socket, id);
      return;
    }
    try {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "skandha_subscription",
          params: { subscription: id, result: event },
        })
      );
    } catch (err) {
      this.logger.error(err, `Could not send explorer event. Id: ${id}`);
    }
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
