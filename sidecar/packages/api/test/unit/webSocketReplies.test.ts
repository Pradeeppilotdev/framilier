import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ApiApp } from "../../src/app.js";
import { SubscriptionService, ExecutorEventBus } from "@skandha/executor/lib/services/SubscriptionService.js";

async function fixture(version = () => "test-client") {
  let connect: any;
  const subscriptions = new SubscriptionService(new ExecutorEventBus(), { debug() {}, error() {} } as any, null, { maxPerSocket: 2, maxTotal: 4, maxBufferedBytes: 1024 });
  new ApiApp({ server: { http: { post() {}, get() {} }, ws: { get(_path: string, _options: object, handler: any) { connect = handler; } } } as any,
    config: { config: { rpcEndpoint: "http://127.0.0.1:1" } } as any,
    executor: { debug: {}, eth: {}, web3: { clientVersion: version }, skandha: {}, explorer: {}, subscriptionService: subscriptions } as any,
    testingMode: false, redirectRpc: false });
  const messages: any[] = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: (raw: string) => messages.push(JSON.parse(raw)) });
  await connect(socket, { ip: "127.0.0.1", headers: {} });
  async function exchange(raw: string) {
    messages.length = 0;
    socket.emit("message", Buffer.from(raw));
    await new Promise(resolve => setImmediate(resolve));
    expect(messages).toHaveLength(1);
    return messages[0];
  }
  async function request(id: number | string | null, method: string, params: unknown[] = []) {
    const response = await exchange(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    expect(response.id).toBe(id);
    return response;
  }
  return { socket, request, exchange };
}

describe("WebSocket response ownership", () => {
  it("sends exactly one reply for subscribe, unsubscribe and ordinary RPC", async () => {
    const { socket, request } = await fixture();
    try {
      const subscribed = await request(1, "skandha_subscribe", ["ping"]);
      expect(subscribed.result).toMatch(/^0x/);
      expect((await request(2, "skandha_unsubscribe", [subscribed.result])).result).toBe("ok");
      expect((await request(3, "web3_clientVersion")).result).toBe("test-client");
    } finally { socket.emit("close"); }
  });

  it("does not send an extra reply for a refused subscription", async () => {
    const { socket, request } = await fixture();
    try {
      const response = await request(4, "skandha_subscribe", ["unknown-event"]);
      expect(response.result).toBeUndefined();
      expect(response.error).toMatchObject({ code: -32601, message: expect.any(String) });
      expect(response.message).toBeUndefined();
    } finally { socket.emit("close"); }
  });
});


describe("WebSocket error envelopes", () => {
  function error(response: any, code: number) {
    expect(response.jsonrpc).toBe("2.0");
    expect(response.error).toMatchObject({ code, message: expect.any(String) });
    expect(response.result).toBeUndefined();
    expect(response.message).toBeUndefined();
    expect(response.data).toBeUndefined();
  }

  it("preserves string request IDs for rejected ordinary RPC", async () => {
    const { socket, request } = await fixture();
    try { error(await request("denied-1", "debug_bundler_clearMempool"), -32601); }
    finally { socket.emit("close"); }
  });

  it("normalizes subscription overflow and invalid parameters", async () => {
    const { socket, request } = await fixture();
    try {
      await request(1, "skandha_subscribe", ["ping"]);
      await request(2, "skandha_subscribe", ["ping"]);
      error(await request(3, "skandha_subscribe", ["ping"]), -32000);
      error(await request(4, "skandha_subscribe", []), -32602);
      error(await request(5, "skandha_unsubscribe", []), -32602);
    } finally { socket.emit("close"); }
  });

  it("redacts unexpected backend errors", async () => {
    const { socket, request } = await fixture(() => { throw new Error("private-backend-marker"); });
    try {
      const response = await request(6, "web3_clientVersion");
      error(response, -32603);
      expect(response.error.message).toBe("Internal error");
      expect(JSON.stringify(response)).not.toContain("private-backend-marker");
    } finally { socket.emit("close"); }
  });

  it("returns a parse error with null ID for malformed JSON", async () => {
    const { socket, exchange } = await fixture();
    try {
      const response = await exchange("{");
      error(response, -32700);
      expect(response.id).toBeNull();
    } finally { socket.emit("close"); }
  });

  it.each([null, 7, [], { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", method: "x", id: {} }])(
    "rejects malformed request shapes without losing the envelope", async raw => {
      const { socket, exchange } = await fixture();
      try {
        const response = await exchange(JSON.stringify(raw));
        error(response, -32600);
        expect(response.id).toBeNull();
      } finally { socket.emit("close"); }
    }
  );
});
