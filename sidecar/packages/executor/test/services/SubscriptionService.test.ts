import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import {
  ExecutorEvent,
  ExecutorEventBus,
  SubscriptionService,
} from "../../src/services/SubscriptionService.js";
import { ExplorerService } from "../../src/services/ExplorerService/service.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";

const logger = { debug: vi.fn(), error: vi.fn() } as any;
const socket = () => Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() }) as any;
const nextTick = () => new Promise((r) => setImmediate(r));
const sent = (s: any) => s.send.mock.calls.map(([m]: [string]) => JSON.parse(m));

describe("SubscriptionService explorerEvents", () => {
  it("refuses to subscribe when the explorer is disabled", () => {
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, null);
    let error: any;
    try {
      svc.listenExplorerEvents(socket());
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: RpcErrorCodes.METHOD_NOT_FOUND });
  });

  it("delivers live events as plain JSON (numbers are not hexlified)", async () => {
    const explorer = new ExplorerService(100, () => 1700000000000);
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    const id = svc.listenExplorerEvents(s);
    await nextTick();

    explorer.recordLifecycle({ txHash: "0xaa", kind: "admitted", status: "New" });

    expect(sent(s)).toEqual([
      {
        jsonrpc: "2.0",
        method: "skandha_subscription",
        params: {
          subscription: id,
          result: { seq: 1, txHash: "0xaa", at: 1700000000000, kind: "admitted", status: "New" },
        },
      },
    ]);
  });

  it("replays events after sinceSeq first, then continues live, with no gap or duplicate", async () => {
    const explorer = new ExplorerService();
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" }); // seq 1
    explorer.recordLifecycle({ txHash: "0x2", kind: "admitted" }); // seq 2
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    svc.listenExplorerEvents(s, 1);
    // recorded between subscribe and the replay tick: must arrive exactly once
    explorer.recordLifecycle({ txHash: "0x3", kind: "admitted" }); // seq 3
    await nextTick();
    explorer.recordLifecycle({ txHash: "0x4", kind: "admitted" }); // seq 4

    expect(sent(s).map((m: any) => m.params.result.seq)).toEqual([2, 3, 4]);
  });

  it("sends only live events when no sinceSeq is given", async () => {
    const explorer = new ExplorerService();
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" });
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    svc.listenExplorerEvents(s);
    await nextTick();
    explorer.recordLifecycle({ txHash: "0x2", kind: "admitted" });
    expect(sent(s).map((m: any) => m.params.result.seq)).toEqual([2]);
  });

  it("stops delivering after unsubscribe, including when it happens before the replay tick", async () => {
    const explorer = new ExplorerService();
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" });
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    const id = svc.listenExplorerEvents(s, 0);
    svc.unsubscribe(s, id);
    await nextTick();
    explorer.recordLifecycle({ txHash: "0x2", kind: "admitted" });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("does not deliver to a closed socket", async () => {
    const explorer = new ExplorerService();
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    svc.listenExplorerEvents(s);
    await nextTick();
    s.readyState = 3; // CLOSED
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("does not leave a dead id in the live set when the socket closes during replay", async () => {
    const explorer = new ExplorerService();
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" });
    explorer.recordLifecycle({ txHash: "0x2", kind: "admitted" });
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    s.send = vi.fn(() => {
      s.readyState = 3; // CLOSED after the first send
    });
    svc.listenExplorerEvents(s, 0);
    await nextTick();
    explorer.recordLifecycle({ txHash: "0x3", kind: "admitted" });
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(sent(s).map((m: any) => m.params.result.seq)).toEqual([1]);
    // the dead subscription must not linger in the live set either
    expect((svc as any).events[ExecutorEvent.explorerEvents].size).toBe(0);
  });
});

describe("SubscriptionService resource and ownership boundaries", () => {
  const limits = { maxPerSocket: 2, maxTotal: 3, maxBufferedBytes: 64 };
  const make = (explorer: ExplorerService | null = null) =>
    new SubscriptionService(new ExecutorEventBus(), logger, explorer, limits);

  it("refuses another socket's unsubscribe without interrupting the owner", () => {
    const svc = make();
    const owner = socket();
    const id = svc.listenPing(owner);
    svc.unsubscribe(socket(), id);
    svc.onPing();
    expect(owner.send).toHaveBeenCalledTimes(1);
    svc.unsubscribe(owner, id);
    svc.onPing();
    expect(owner.send).toHaveBeenCalledTimes(1);
  });

  it("enforces per-socket and total limits and releases capacity on close", () => {
    const svc = make();
    const a = socket(), b = socket(), c = socket();
    svc.listenPing(a);
    svc.listenPendingUserOps(a);
    expect(() => svc.listenOnChainUserOps(a)).toThrow(/limit/);
    svc.listenPing(b);
    expect(() => svc.listenPing(c)).toThrow(/limit/);
    a.readyState = 3;
    a.emit("close");
    expect((svc as any).subscriptionCount).toBe(1);
    expect(a.listenerCount("close")).toBe(0);
    expect(a.listenerCount("error")).toBe(0);
    expect(() => svc.listenPing(c)).not.toThrow();
    b.emit("close");
    c.emit("close");
    expect((svc as any).subscriptionCount).toBe(0);
    expect((svc as any).sockets.size).toBe(0);
    expect(Object.keys((svc as any).listeners)).toHaveLength(0);
  });

  it("bounds explorer subscriptions too and cancels replay on disconnect", async () => {
    const explorer = new ExplorerService();
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" });
    const svc = make(explorer), s = socket();
    svc.listenExplorerEvents(s, 0);
    svc.listenPing(s);
    expect(() => svc.listenExplorerEvents(s, 0)).toThrow(/limit/);
    s.emit("close");
    await nextTick();
    expect(s.send).not.toHaveBeenCalled();
    expect((svc as any).events.explorerEvents.size).toBe(0);
    expect((svc as any).subscriptionCount).toBe(0);
  });

  it("cleans up on transport error and repeated reconnects without waiting for events", () => {
    const svc = make();
    for (let i = 0; i < 100; i++) {
      const s = socket();
      svc.listenPing(s);
      s.emit("error", new Error("transport closed"));
      s.emit("close");
      expect((svc as any).subscriptionCount).toBe(0);
      expect((svc as any).sockets.size).toBe(0);
    }
  });

  it("disconnects slow consumers without blocking healthy subscribers", () => {
    const svc = make(), slow = socket(), healthy = socket();
    svc.listenPing(slow);
    svc.listenPing(healthy);
    slow.bufferedAmount = 65;
    svc.onPing();
    expect(slow.send).not.toHaveBeenCalled();
    expect(slow.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(healthy.send).toHaveBeenCalledTimes(1);
    expect((svc as any).subscriptionCount).toBe(1);
  });

  it("refuses closed sockets and releases a failed sender", () => {
    const svc = make(), s = socket();
    s.readyState = 3;
    expect(() => svc.listenPing(s)).toThrow(/not open/);
    s.readyState = 1;
    svc.listenPing(s);
    s.send.mockImplementation(() => { throw new Error("write failed"); });
    svc.onPing();
    expect((svc as any).subscriptionCount).toBe(0);
  });
});
