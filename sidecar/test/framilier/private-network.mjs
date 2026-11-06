// ethrex checks GitHub for a newer release at startup. Give the private fixture
// a local HTTP proxy with no forwarding code. Direct loopback RPC is exempt.
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export async function denyExternalHttp() {
  const denied = [];
  const record = (method, authority) => {
    // Keep only the destination, never a credential, payload, or query string.
    denied.push({ method, authority: authority.split("/")[0].split("@").pop() });
  };
  const server = createServer((req, res) => {
    record(req.method, req.headers.host ?? "");
    res.writeHead(403, { connection: "close" });
    res.end();
  });
  server.on("connect", (req, socket) => {
    record("CONNECT", req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const proxy = "http://127.0.0.1:" + server.address().port;
  const env = {};
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    env[key] = proxy;
    env[key.toLowerCase()] = proxy;
  }
  env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
  return {
    env, denied,
    async confirmReleaseCheckBlocked() {
      for (let i = 0; i < 40; i++) {
        if (denied.some(r => r.method === "CONNECT" && r.authority === "api.github.com:443")) return;
        await delay(50);
      }
      throw new Error("Could not verify local blocking of the pinned ethrex release check; stopping the benchmark");
    },
    async close() {
      const complete = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await complete;
    },
  };
}

