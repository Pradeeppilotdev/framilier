import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveProvider, useFresh, useLive, type StreamFactory } from "./live";
import { LiveFeed } from "./liveFeed";
import { keys } from "./keys";
import type { StreamCallbacks } from "../rpc/stream";
import type { Instance } from "../instances/store";
import type { LifecycleEventData } from "../protocol/schemas";

const A: Instance = { name: "Devnet", url: "https://a.example/rpc" };
const B: Instance = { name: "Local", url: "http://localhost:14337/rpc" };

const event = (seq: number, txHash = `0x${seq}`): LifecycleEventData => ({
  seq,
  txHash,
  at: 1,
  kind: "admitted",
});

function Probe({ hash = "0xaa" }: { hash?: string }) {
  const live = useLive();
  const fresh = useFresh(hash);
  return (
    <div>
      <p data-testid="status">{live.status}</p>
      <p data-testid="fatal">{live.fatal ?? "-"}</p>
      <p data-testid="notice">{live.notice ?? "-"}</p>
      <p data-testid="fresh">{String(fresh)}</p>
      <button onClick={live.dismissNotice}>dismiss</button>
    </div>
  );
}

function setup(instance: Instance | null) {
  const created: Array<{ instance: Instance; callbacks: StreamCallbacks; start: () => void; stop: () => void }> = [];
  const factory: StreamFactory = (inst, callbacks) => {
    const handle = { instance: inst, callbacks, start: vi.fn(), stop: vi.fn() };
    created.push(handle);
    return handle;
  };
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const reset = vi.spyOn(client, "resetQueries");
  const tree = (inst: Instance | null) => (
    <QueryClientProvider client={client}>
      <LiveProvider instance={inst} createStream={factory}>
        <Probe />
      </LiveProvider>
    </QueryClientProvider>
  );
  const view = render(tree(instance));
  return { created, invalidate, reset, view, tree };
}

describe("LiveProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a stream for the selected instance and mirrors its status", () => {
    const { created } = setup(A);
    expect(created).toHaveLength(1);
    expect(created[0]?.instance).toEqual(A);
    expect(created[0]?.start).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status").textContent).toBe("connecting");
    act(() => created[0]?.callbacks.onStatus("reconnecting"));
    expect(screen.getByTestId("status").textContent).toBe("reconnecting");
  });

  it("does not start anything without an instance", () => {
    const { created } = setup(null);
    expect(created).toHaveLength(0);
  });

  it("batches events into one refresh of that instance's queries", () => {
    const { created, invalidate } = setup(A);
    act(() => {
      created[0]?.callbacks.onEvent(event(1));
      created[0]?.callbacks.onEvent(event(2));
      created[0]?.callbacks.onEvent(event(3));
    });
    expect(invalidate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.all(A.url) });
  });

  it("refreshes everything whenever the stream goes live", () => {
    const { created, invalidate } = setup(A);
    act(() => created[0]?.callbacks.onStatus("live"));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.all(A.url) });
  });

  it("highlights a transaction briefly after an event for it", () => {
    const { created } = setup(A);
    expect(screen.getByTestId("fresh").textContent).toBe("false");
    act(() => created[0]?.callbacks.onEvent(event(1, "0xAA")));
    expect(screen.getByTestId("fresh").textContent).toBe("true");
    act(() => vi.advanceTimersByTime(2600));
    expect(screen.getByTestId("fresh").textContent).toBe("false");
  });

  it("resets the instance's queries and explains a restart, until dismissed", () => {
    const { created, reset } = setup(A);
    act(() => created[0]?.callbacks.onReset("restart"));
    expect(reset).toHaveBeenCalledWith({ queryKey: keys.all(A.url) });
    expect(screen.getByTestId("notice").textContent).toContain("restarted");
    act(() => screen.getByText("dismiss").click());
    expect(screen.getByTestId("notice").textContent).toBe("-");
  });

  it("explains a history gap differently from a restart", () => {
    const { created } = setup(A);
    act(() => created[0]?.callbacks.onReset("gap"));
    expect(screen.getByTestId("notice").textContent).toContain("dropped some history");
  });

  it("surfaces a fatal stream error", () => {
    const { created } = setup(A);
    act(() => created[0]?.callbacks.onFatal("Explorer is disabled"));
    expect(screen.getByTestId("fatal").textContent).toBe("Explorer is disabled");
  });

  it("stops the old stream and starts a new one when the instance changes", () => {
    const { created, view, tree } = setup(A);
    view.rerender(tree(B));
    expect(created[0]?.stop).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(2);
    expect(created[1]?.instance).toEqual(B);
    expect(screen.getByTestId("status").textContent).toBe("connecting");
  });

  it("keeps the stream when an instance is only renamed", () => {
    const { created, view, tree } = setup(A);
    view.rerender(tree({ ...A, name: "Renamed" }));
    expect(created).toHaveLength(1);
    expect(created[0]?.stop).not.toHaveBeenCalled();
  });

  it("stops the stream on unmount and cancels a pending refresh", () => {
    const { created, invalidate, view } = setup(A);
    act(() => created[0]?.callbacks.onEvent(event(1)));
    view.unmount();
    expect(created[0]?.stop).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(500));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("LiveProvider isolation between instances", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores every callback of a stream that was stopped by a switch or unmount", () => {
    const { created, view, tree, invalidate, reset } = setup(A);
    const stale = created[0]!.callbacks;
    view.rerender(tree(B));
    invalidate.mockClear();
    reset.mockClear();
    act(() => {
      stale.onStatus("live");
      stale.onEvent(event(1, "0xaa"));
      stale.onReset("restart");
      stale.onFatal("Explorer is disabled");
    });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId("status").textContent).toBe("connecting");
    expect(screen.getByTestId("fatal").textContent).toBe("-");
    expect(screen.getByTestId("notice").textContent).toBe("-");
    expect(screen.getByTestId("fresh").textContent).toBe("false");
    expect(invalidate).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();

    view.unmount();
    act(() => {
      created[1]?.callbacks.onEvent(event(2));
      created[1]?.callbacks.onStatus("live");
    });
    act(() => vi.advanceTimersByTime(500));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("never renders the previous instance's live, notice or fatal state for the new url", () => {
    const renders: Array<[string, string, string]> = [];
    const factory: StreamFactory = (_i, callbacks) => {
      created.push(callbacks);
      return { start() {}, stop() {} };
    };
    const created: StreamCallbacks[] = [];
    function Recorder() {
      const live = useLive();
      renders.push([live.status, live.notice ?? "-", live.fatal ?? "-"]);
      return null;
    }
    const client = new QueryClient();
    const tree = (inst: Instance) => (
      <QueryClientProvider client={client}>
        <LiveProvider instance={inst} createStream={factory}>
          <Recorder />
        </LiveProvider>
      </QueryClientProvider>
    );
    const view = render(tree(A));
    act(() => {
      created[0]?.onStatus("live");
      created[0]?.onReset("restart");
      created[0]?.onFatal("Explorer is disabled");
    });
    expect(renders.at(-1)).toEqual(["live", expect.stringContaining("restarted"), "Explorer is disabled"]);
    renders.length = 0;
    view.rerender(tree(B));
    expect(renders.length).toBeGreaterThan(0);
    for (const entry of renders) expect(entry).toEqual(["connecting", "-", "-"]);
  });

  it("exposes the url the state belongs to", () => {
    let seen: string | null = "unset";
    function Url() {
      seen = useLive().url;
      return null;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LiveProvider instance={A} createStream={() => ({ start() {}, stop() {} })}>
          <Url />
        </LiveProvider>
      </QueryClientProvider>,
    );
    expect(seen).toBe(A.url);
  });
});

describe("LiveFeed", () => {
  it("treats an arrival as fresh until its ttl passes, ignoring hash case", () => {
    let now = 1000;
    const feed = new LiveFeed(() => now, 2500, () => undefined);
    feed.push(event(1, "0xAbC"));
    expect(feed.isFresh("0xabc")).toBe(true);
    now += 2499;
    expect(feed.isFresh("0xABC")).toBe(true);
    now += 1;
    expect(feed.isFresh("0xabc")).toBe(false);
    expect(feed.isFresh("0xother")).toBe(false);
  });

  it("notifies subscribers on push and on expiry, and stops after unsubscribe", () => {
    const timers: Array<() => void> = [];
    const feed = new LiveFeed(() => 0, 2500, (fn) => timers.push(fn));
    const calls: number[] = [];
    const off = feed.subscribe(() => calls.push(feed.getSnapshot()));
    feed.push(event(1));
    expect(calls).toEqual([1]);
    timers[0]?.();
    expect(calls).toEqual([1, 2]);
    off();
    feed.push(event(2));
    expect(calls).toEqual([1, 2]);
  });
});
