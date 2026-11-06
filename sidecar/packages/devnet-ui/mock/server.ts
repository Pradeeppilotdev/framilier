import type { ServerWebSocket } from "bun";
import { liveTx } from "./fixtures";
import { createSession, type Session } from "./session";
import { MockNode, STATUSES, type Status } from "./state";

interface SocketData {
  session: Session | null;
}

export interface MockServer {
  port: number;
  node: () => MockNode;
  stop(): void;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

/**
 * Serves a `MockNode` the way a sidecar instance does: JSON-RPC over HTTP at
 * `/rpc` (CORS open, RpcError as HTTP 200 with `error.code`) and the
 * `explorerEvents` stream over WebSocket at the same path. `/__mock/*` are
 * test controls, not part of the real API.
 */
export function startMockServer(makeNode: () => MockNode, port = 0): MockServer {
  let node = makeNode();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  let liveCounter = 0;

  const server = Bun.serve<SocketData, string>({
    // Loopback only: the mock has test controls and no authentication.
    hostname: "localhost",
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      if (url.pathname.startsWith("/__mock/")) {
        if (req.method !== "POST") return json({ error: "Use POST" }, 405);
        return control(url.pathname.slice("/__mock/".length), url);
      }

      if (url.pathname === "/rpc" || url.pathname === "/rpc/") {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return srv.upgrade(req, { data: { session: null } })
            ? undefined
            : new Response("Upgrade failed", { status: 400 });
        }
        if (req.method !== "POST") return new Response("GET requests are not supported.", { headers: CORS });
        let body: { id?: unknown; method?: unknown; params?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ error: "Cannot parse request" }, 400);
        }
        const outcome = node.handle(String(body.method), Array.isArray(body.params) ? body.params : []);
        return "error" in outcome
          ? json({ jsonrpc: "2.0", id: body.id, error: outcome.error })
          : json({ jsonrpc: "2.0", id: body.id, result: outcome.result });
      }
      return new Response("Not found", { status: 404, headers: CORS });
    },
    websocket: {
      open(ws) {
        ws.data.session = createSession(
          () => node,
          (text) => ws.send(text),
        );
        sockets.add(ws);
      },
      message(ws, raw) {
        ws.data.session?.message(String(raw));
      },
      close(ws) {
        ws.data.session?.close();
        sockets.delete(ws);
      },
    },
  });

  function control(action: string, url: URL): Response {
    switch (action) {
      case "admit": {
        const tx = liveTx(++liveCounter, Date.now());
        node.admit(tx, "rpc");
        return json({ hash: tx.hash });
      }
      case "status": {
        const hash = url.searchParams.get("hash") ?? "";
        const status = url.searchParams.get("status") ?? "";
        if (!(STATUSES as readonly string[]).includes(status)) return json({ error: "unknown status" }, 400);
        node.setStatus(hash, status as Status, url.searchParams.get("reason") ?? undefined);
        return json({ ok: true });
      }
      case "restart":
        node.restart();
        return json({ bootId: node.bootId });
      case "disconnect":
        for (const ws of sockets) ws.close(1012, "mock disconnect");
        return json({ closed: sockets.size });
      case "reset":
        node = makeNode();
        for (const ws of sockets) ws.close(1012, "mock reset");
        return json({ bootId: node.bootId });
      default:
        return json({ error: "unknown control" }, 404);
    }
  }

  return {
    port: server.port as number,
    node: () => node,
    stop: () => server.stop(true),
  };
}
