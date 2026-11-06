import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTransaction, useAcrossInstances, useTransaction } from "./hooks";
import { LiveProvider, type StreamFactory } from "./live";
import type { StreamCallbacks } from "../rpc/stream";
import { RpcMethodError } from "../rpc/errors";
import type { Instance } from "../instances/store";

const A: Instance = { name: "A", url: "https://a.example/rpc" };
const B: Instance = { name: "B", url: "https://b.example/rpc" };
const HASH = `0x${"ab".repeat(32)}`;

/** Every node answers getTransaction with the backend's "not found"; calls are counted per URL. */
function stubFetch(error: { code: number; message: string } = { code: -32600, message: "Frame transaction not found" }) {
  const calls: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls[url] = (calls[url] ?? 0) + 1;
      const body = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error }), { status: 200 });
    }),
  );
  return calls;
}

function Tx({ url }: { url: string }) {
  const query = useTransaction(url, HASH);
  return <p data-testid={`tx-${url}`}>{query.isPending ? "pending" : query.data === null ? "none" : "other"}</p>;
}

function Across({ urls }: { urls: string[] }) {
  const results = useAcrossInstances(urls, HASH);
  return <p data-testid="across">{results.map((r) => (r.isPending ? "pending" : "done")).join(",")}</p>;
}

function mount(children: React.ReactNode) {
  let callbacks!: StreamCallbacks;
  const factory: StreamFactory = (_instance, cb) => {
    callbacks = cb;
    return { start() {}, stop() {} };
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LiveProvider instance={A} createStream={factory}>
        {children}
      </LiveProvider>
    </QueryClientProvider>,
  );
  return { callbacks: () => callbacks };
}

const settle = () => act(async () => vi.advanceTimersByTimeAsync(0));
const tick = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

describe("polling follows the query's own URL", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps refreshing a transaction on another node while the selected node is live", async () => {
    const calls = stubFetch();
    const { callbacks } = mount(<Tx url={B.url} />);
    await settle();
    act(() => callbacks().onStatus("live"));
    const before = calls[B.url] ?? 0;
    await tick(11_000);
    expect(calls[B.url] ?? 0).toBeGreaterThan(before);
  });

  it("stops polling the selected node itself once its stream is live, but polls it while not live", async () => {
    const calls = stubFetch();
    const { callbacks } = mount(<Tx url={A.url} />);
    await settle();
    await tick(11_000);
    expect(calls[A.url] ?? 0).toBeGreaterThanOrEqual(3);
    act(() => callbacks().onStatus("live"));
    await settle();
    const before = calls[A.url] ?? 0;
    await tick(30_000);
    expect(calls[A.url] ?? 0).toBe(before);
  });

  it("refreshes the other nodes of the cross-instance view while the selected node is live", async () => {
    const calls = stubFetch();
    const { callbacks } = mount(<Across urls={[A.url, B.url]} />);
    await settle();
    act(() => callbacks().onStatus("live"));
    await settle();
    const beforeA = calls[A.url] ?? 0;
    const beforeB = calls[B.url] ?? 0;
    await tick(11_000);
    expect(calls[A.url] ?? 0).toBe(beforeA);
    expect(calls[B.url] ?? 0).toBeGreaterThan(beforeB);
  });
});

describe("fetchTransaction not-found handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers null for the backend's not-found error", async () => {
    stubFetch();
    await expect(fetchTransaction(A.url, HASH)).resolves.toBeNull();
  });

  it("does not swallow another error with a similar message or a different code", async () => {
    stubFetch({ code: -32600, message: "Expected a 32-byte hex transaction hash" });
    await expect(fetchTransaction(A.url, HASH)).rejects.toBeInstanceOf(RpcMethodError);
    stubFetch({ code: -32000, message: "Frame transaction not found" });
    await expect(fetchTransaction(A.url, HASH)).rejects.toBeInstanceOf(RpcMethodError);
    stubFetch({ code: -32000, message: "Upstream not found: rpc backend" });
    await expect(fetchTransaction(A.url, HASH)).rejects.toBeInstanceOf(RpcMethodError);
  });
});
