import { render } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { vi } from "vitest";
import { App, createAppRouter } from "./app";
import type { StreamFactory } from "./data/live";
import type { Instance } from "./instances/store";
import type { MockNode } from "../mock/state";

/** A stream that never connects, so tests stay in control of live events. */
export const idleStream: StreamFactory = () => ({ start() {}, stop() {} });

/**
 * Routes `fetch` to in-memory mock nodes by URL, answering the way the real API
 * does. A URL with no node behaves like an unreachable host.
 */
export function installMockFetch(nodes: Record<string, MockNode>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const node = nodes[url];
      if (!node) throw new TypeError("Failed to fetch");
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const outcome = node.handle(body.method, body.params);
      const payload =
        "error" in outcome
          ? { jsonrpc: "2.0", id: body.id, error: outcome.error }
          : { jsonrpc: "2.0", id: body.id, result: outcome.result };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

export interface RenderAppOptions {
  path?: string;
  instances: Instance[];
  selectedUrl?: string;
  createStream?: StreamFactory;
}

/** Renders the whole app on a memory router with a fixed instance list. */
export function renderApp({ path = "/", instances, selectedUrl, createStream = idleStream }: RenderAppOptions) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  const view = render(
    <App
      router={router}
      queryClient={queryClient}
      initialInstances={{ instances, selectedUrl: selectedUrl ?? instances[0]?.url ?? null }}
      createStream={createStream}
    />,
  );
  return { ...view, router, queryClient };
}
