import type { MockNode } from "./state";

export interface Session {
  message(raw: string): void;
  close(): void;
}

function randomId(): string {
  return `0x${Math.floor(Math.random() * 2 ** 48).toString(16).padStart(12, "0")}`;
}

/**
 * One WebSocket connection to a mock node: the `explorerEvents` subscription
 * and the JSON-RPC methods over the socket. It knows nothing about Bun, so it
 * can be unit-tested; `server.ts` wires it to a real socket.
 *
 * `getNode` is read when a request arrives (the server swaps the node on
 * reset); `defer` runs a function after the current message, like the real
 * node's `setImmediate`.
 */
export function createSession(
  getNode: () => MockNode,
  send: (text: string) => void,
  defer: (fn: () => void) => void = (fn) => void setTimeout(fn, 0),
): Session {
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  /** Bumped by every subscribe and unsubscribe, so an older pending registration does nothing. */
  let generation = 0;

  function stopStream(): void {
    generation += 1;
    unsubscribe?.();
    unsubscribe = null;
  }

  return {
    message(raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        send(JSON.stringify({ jsonrpc: "2.0", id: null, error: "Invalid Request" }));
        return;
      }
      const request = parsed as { id?: unknown; method?: unknown; params?: unknown };
      const params = Array.isArray(request.params) ? request.params : [];
      // Captured now: a node swap must not move a stream that subscribed to the old node.
      const node = getNode();

      if (request.method === "skandha_subscribe" && params[0] === "explorerEvents") {
        if (!node.explorerEnabled) {
          // Real WebSocket errors carry a message and no `code`.
          send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              message: "Explorer is disabled: start the node with --explorer.enable",
            }),
          );
          return;
        }
        stopStream();
        const mine = generation;
        const subscription = randomId();
        send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: subscription }));
        const sinceSeq = params[1];
        // Like the real node: register and replay on the next tick, after the response.
        defer(() => {
          if (closed || mine !== generation) return;
          unsubscribe = node.subscribe(typeof sinceSeq === "number" ? sinceSeq : undefined, (event) =>
            send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "skandha_subscription",
                params: { subscription, result: event },
              }),
            ),
          );
        });
        return;
      }
      if (request.method === "skandha_unsubscribe") {
        stopStream();
        send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "ok" }));
        return;
      }
      const outcome = node.handle(String(request.method), params);
      send(
        JSON.stringify(
          "error" in outcome
            ? { jsonrpc: "2.0", id: request.id, message: outcome.error.message }
            : { jsonrpc: "2.0", id: request.id, result: outcome.result },
        ),
      );
    },
    close() {
      closed = true;
      stopStream();
    },
  };
}
