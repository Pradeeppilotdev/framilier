import { describe, expect, it } from "vitest";
import { TX, disabledNode, primaryNode, secondaryNode } from "./fixtures";
import { createSession } from "./session";
import { MockNode } from "./state";

function harness(getNode: () => MockNode) {
  const sent: Array<Record<string, unknown>> = [];
  const deferred: Array<() => void> = [];
  const session = createSession(
    getNode,
    (text) => sent.push(JSON.parse(text) as Record<string, unknown>),
    (fn) => deferred.push(fn),
  );
  const runDeferred = () => deferred.splice(0).forEach((fn) => fn());
  const subscribe = (params: unknown = ["explorerEvents", 0], id = 1) =>
    session.message(JSON.stringify({ jsonrpc: "2.0", id, method: "skandha_subscribe", params }));
  const events = () => sent.filter((m) => m.method === "skandha_subscription");
  return { session, sent, deferred, runDeferred, subscribe, events };
}

const fresh = (n: number) => ({
  ...TX.fresh,
  hash: `0x${n.toString(16).padStart(64, "0")}`,
  nonce: n,
  frames: TX.fresh.frames.map((f) => ({ ...f })),
});

describe("mock WebSocket session", () => {
  it("answers a frame that is valid JSON but not an object with Invalid Request", () => {
    const h = harness(primaryNode);
    for (const raw of ["42", "null", "[]", '"text"', "true"]) {
      expect(() => h.session.message(raw)).not.toThrow();
    }
    expect(h.sent).toHaveLength(5);
    for (const reply of h.sent) expect(reply).toMatchObject({ error: "Invalid Request" });
  });

  it("ignores a frame that is not JSON", () => {
    const h = harness(primaryNode);
    h.session.message("{oops");
    expect(h.sent).toEqual([]);
  });

  it("subscribes when params is null or not an array by treating them as empty", () => {
    const h = harness(primaryNode);
    h.session.message(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "skandha_explorer_info", params: null }));
    expect(h.sent[0]).toMatchObject({ id: 4, result: { protocolVersion: 1 } });
    h.session.message(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "skandha_explorer_info", params: { a: 1 } }));
    expect(h.sent[1]).toMatchObject({ id: 5, result: { protocolVersion: 1 } });
    h.subscribe(null, 6);
    expect(h.sent[2]).toMatchObject({ id: 6, message: expect.stringContaining("not supported") });
  });

  it("reports the explorer being off as a message without a code", () => {
    const h = harness(disabledNode);
    h.subscribe();
    expect(h.sent[0]).toMatchObject({ id: 1, message: expect.stringContaining("Explorer is disabled") });
    expect(h.sent[0]).not.toHaveProperty("result");
  });

  it("acknowledges a subscription, then registers and replays on the next tick", () => {
    const node = primaryNode();
    const h = harness(() => node);
    h.subscribe(["explorerEvents", 0]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ id: 1, result: expect.stringMatching(/^0x/) });
    expect(h.events()).toHaveLength(0);
    h.runDeferred();
    expect(h.events().length).toBeGreaterThan(0);
    const before = h.events().length;
    node.admit(fresh(1));
    expect(h.events()).toHaveLength(before + 1);
  });

  it("never registers a listener when the socket closed before the deferred tick", () => {
    const node = new MockNode({ name: "n" });
    const h = harness(() => node);
    h.subscribe(["explorerEvents", 0]);
    h.session.close();
    h.runDeferred();
    node.admit(fresh(1));
    expect(h.events()).toHaveLength(0);
  });

  it("stops the stream when the socket closes", () => {
    const node = new MockNode({ name: "n" });
    const h = harness(() => node);
    h.subscribe(["explorerEvents", 0]);
    h.runDeferred();
    node.admit(fresh(1));
    expect(h.events()).toHaveLength(1);
    h.session.close();
    node.admit(fresh(2));
    expect(h.events()).toHaveLength(1);
  });

  it("uses the node it saw at subscribe time, not the one current at the deferred tick", () => {
    const first = new MockNode({ name: "first" });
    const second = new MockNode({ name: "second" });
    let current = first;
    const h = harness(() => current);
    h.subscribe(["explorerEvents", 0]);
    current = second;
    h.runDeferred();
    second.admit(fresh(1));
    expect(h.events()).toHaveLength(0);
    first.admit(fresh(2));
    expect(h.events()).toHaveLength(1);
  });

  it("replaces an earlier subscription instead of leaking it", () => {
    const node = new MockNode({ name: "n" });
    const h = harness(() => node);
    h.subscribe(["explorerEvents", 0], 1);
    h.runDeferred();
    h.subscribe(["explorerEvents", 0], 2);
    h.runDeferred();
    node.admit(fresh(1));
    expect(h.events()).toHaveLength(1);
  });

  it("drops the first registration when a second subscribe comes before its tick", () => {
    const node = new MockNode({ name: "n" });
    const h = harness(() => node);
    h.subscribe(["explorerEvents", 0], 1);
    h.subscribe(["explorerEvents", 0], 2);
    h.runDeferred();
    node.admit(fresh(1));
    expect(h.events()).toHaveLength(1);
  });

  it("implements skandha_unsubscribe: replies ok and stops the stream", () => {
    const node = new MockNode({ name: "n" });
    const h = harness(() => node);
    h.subscribe(["explorerEvents", 0]);
    h.runDeferred();
    node.admit(fresh(1));
    expect(h.events()).toHaveLength(1);
    h.session.message(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "skandha_unsubscribe", params: ["0x1"] }));
    expect(h.sent.at(-1)).toMatchObject({ id: 9, result: "ok" });
    node.admit(fresh(2));
    expect(h.events()).toHaveLength(1);
  });

  it("cancels a pending registration when unsubscribed before the tick", () => {
    const node = new MockNode({ name: "n" });
    const h = harness(() => node);
    h.subscribe(["explorerEvents", 0]);
    h.session.message(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "skandha_unsubscribe", params: [] }));
    h.runDeferred();
    node.admit(fresh(1));
    expect(h.events()).toHaveLength(0);
  });

  it("answers other explorer methods over the socket, with errors as a plain message", () => {
    const h = harness(secondaryNode);
    h.session.message(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "skandha_explorer_getTransaction", params: ["0x12"] }));
    expect(h.sent[0]).toMatchObject({ id: 3, message: "Expected a 32-byte hex transaction hash" });
  });
});
