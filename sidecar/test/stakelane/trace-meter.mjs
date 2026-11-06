// Test-only observer. It forwards unchanged requests to the fixture's loopback
// execution client and clocks each traced simulation of a watched signed hash.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { performance } from "node:perf_hooks";
import { keccak256 } from "viem";

export async function startTraceMeter(el) {
  const target = new URL(el);
  assert.equal(target.protocol, "http:");
  assert.equal(target.hostname, "127.0.0.1");
  let active;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const buffers = [];
      for await (const chunk of incoming) buffers.push(chunk);
      const body = Buffer.concat(buffers);
      const payload = JSON.parse(body);
      let event;
      if (active && payload.method === "ethrex_simulateFrameTransaction" && payload.params?.[2]?.trace === true) {
        const hash = keccak256(payload.params[0]);
        if (active.watched.has(hash)) {
          event = { hash, start: performance.now(), end: null };
          active.events.push(event);
          if (active.background.has(hash)) active.signal();
        }
      }
      const upstream = request(target, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": body.length },
      }, response => {
        outgoing.writeHead(response.statusCode, { "content-type": "application/json" });
        response.once("end", () => { if (event) event.end = performance.now(); });
        response.on("error", error => outgoing.destroy(error));
        response.pipe(outgoing);
      });
      upstream.on("error", () => { outgoing.writeHead(502); outgoing.end(); });
      upstream.end(body);
    } catch { outgoing.writeHead(400); outgoing.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + server.address().port,
    observe(honest, background) {
      const backgroundSet = new Set(background);
      let signal;
      const firstBackgroundTrace = new Promise(resolve => { signal = resolve; });
      active = { watched: new Set([honest, ...background]), background: backgroundSet, events: [], signal };
      return { events: active.events, firstBackgroundTrace };
    },
    clear() { active = undefined; },
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

