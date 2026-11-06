import { describe, it, expect, vi } from "vitest";
import {
  ExecutorEvent,
  ExecutorEventBus,
  SubscriptionService,
} from "../../src/services/SubscriptionService.js";
import { ExplorerService } from "../../src/services/ExplorerService/service.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";

const logger = { debug: vi.fn(), error: vi.fn() } as any;
const socket = () => ({ readyState: 1, send: vi.fn() }) as any;
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
