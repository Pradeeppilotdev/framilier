import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionService, ExecutorEventBus } from "@skandha/executor/lib/services/SubscriptionService.js";
import { ApiApp } from "../../src/app.js";
import { Server } from "../../src/server.js";
import { toErrorResponse } from "../../src/utils/errorResponse.js";

const originalKey = process.env.SKANDHA_ADMIN_KEY;
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.http.close();
  if (originalKey === undefined) delete process.env.SKANDHA_ADMIN_KEY;
  else process.env.SKANDHA_ADMIN_KEY = originalKey;
});
const request = { jsonrpc: "2.0", id: 1, method: "debug_bundler_clearMempool", params: [] };
async function setup(ws = false) {
  process.env.SKANDHA_ADMIN_KEY = "transport-test-secret";
  const server = await Server.init({ host: "127.0.0.1", port: 0, wsPort: 0, ws, cors: "*", enableRequestLogging: false });
  servers.push(server);
  const clearMempool = vi.fn().mockResolvedValue("ok");
  const subscriptions = new SubscriptionService(new ExecutorEventBus(), { debug() {}, error() {} } as any);
  new ApiApp({ server, config: { config: { rpcEndpoint: "http://127.0.0.1:1" } } as any,
    executor: { debug: { clearMempool }, eth: {}, web3: {}, skandha: {}, explorer: {}, subscriptionService: subscriptions } as any,
    testingMode: false, redirectRpc: false });
  server.http.setErrorHandler((err, req, reply) => {
    const result = toErrorResponse(err, req.body);
    return reply.status(result.status).send(result.payload);
  });
  return { server, clearMempool, subscriptions };
}

describe("Admin transport authorization", () => {
  it("rejects a hostile-origin loopback HTTP request and accepts an explicit key", async () => {
    const { server, clearMempool } = await setup();
    const refused = await server.http.inject({ method: "POST", url: "/rpc/", remoteAddress: "127.0.0.1",
      headers: { origin: "https://attacker.invalid", "content-type": "text/plain" }, payload: JSON.stringify(request) });
    expect(refused.json().error).toBeDefined();
    expect(clearMempool).not.toHaveBeenCalled();
    const accepted = await server.http.inject({ method: "POST", url: "/rpc/", remoteAddress: "127.0.0.1",
      headers: { authorization: "transport-test-secret" }, payload: request });
    expect(accepted.json().result).toBe("ok");
    expect(clearMempool).toHaveBeenCalledTimes(1);
  });

  it("applies the same key requirement to real WebSocket connections", async () => {
    const { server, clearMempool } = await setup(true);
    const address = await server.http.listen({ host: "127.0.0.1", port: 0 });
    async function call(key?: string) {
      const socket = new WebSocket(address.replace("http:", "ws:") + "/rpc/", { headers: key ? { authorization: key } : {} });
      try {
        await once(socket, "open");
        const response = once(socket, "message");
        socket.send(JSON.stringify(request));
        return JSON.parse(String((await response)[0]));
      } finally {
        const closed = once(socket, "close");
        socket.close();
        await closed;
      }
    }
    expect((await call()).result).toBeUndefined();
    expect(clearMempool).not.toHaveBeenCalled();
    expect((await call("transport-test-secret")).result).toBe("ok");
    expect(clearMempool).toHaveBeenCalledTimes(1);
  });
  it("releases real WebSocket subscriptions immediately after disconnect", async () => {
    const { server, subscriptions } = await setup(true);
    const address = await server.http.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(address.replace("http:", "ws:") + "/rpc/");
    try {
      await once(socket, "open");
      const response = once(socket, "message");
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "skandha_subscribe", params: ["ping"] }));
      expect(JSON.parse(String((await response)[0])).result).toMatch(/^0x/);
      expect((subscriptions as any).subscriptionCount).toBe(1);
    } finally {
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }
    await new Promise(resolve => setImmediate(resolve));
    expect((subscriptions as any).subscriptionCount).toBe(0);
    expect((subscriptions as any).sockets.size).toBe(0);
  });

});
