import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerStream, type SocketLike, type StreamStatus } from "./stream";
import type { Info, LifecycleEventData } from "../protocol/schemas";

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop() {
    this.onclose?.({});
  }
  get subscribeParams(): unknown[] {
    return JSON.parse(this.sent[0] ?? "{}").params;
  }
}

const info = (over: Partial<Info> = {}): Info => ({
  protocolVersion: 1,
  chainId: 1337,
  version: "1",
  commit: "c",
  bundlingMode: "auto",
  p2pEnabled: false,
  latestSeq: 10,
  oldestSeq: 1,
  historyCapacity: 10000,
  bootId: "boot-a",
  minInclusionDenominator: 10,
  throttlingSlack: 10,
  banSlack: 50,
  ...over,
});

const event = (seq: number): LifecycleEventData => ({
  seq,
  txHash: `0x${seq}`,
  at: 1000 + seq,
  kind: "admitted",
});

const notification = (e: LifecycleEventData, subscription = "sub") => ({
  jsonrpc: "2.0",
  method: "skandha_subscription",
  params: { subscription, result: e },
});

function setup(infos: Array<Info | Error>, over: { createSocketThrows?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const statuses: StreamStatus[] = [];
  const events: LifecycleEventData[] = [];
  const resets: string[] = [];
  const fatal: string[] = [];
  const queue = [...infos];
  const fetchInfo = vi.fn(async () => {
    const next = queue.shift() ?? infos[infos.length - 1];
    if (next instanceof Error) throw next;
    return next as Info;
  });
  const stream = new ExplorerStream(
    "ws://node/rpc",
    {
      createSocket: (url) => {
        if (over.createSocketThrows) throw new Error("no socket");
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      fetchInfo,
      setTimer: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        (h as { live: boolean }).live = false;
      },
    },
    {
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      onReset: (r) => resets.push(r),
      onFatal: (m) => fatal.push(m),
    },
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const fireTimer = async () => {
    const t = timers.find((x) => x.live);
    if (!t) throw new Error("no pending timer");
    t.live = false;
    t.fn();
    await flush();
  };
  return { stream, sockets, timers, statuses, events, resets, fatal, fetchInfo, flush, fireTimer };
}

describe("ExplorerStream", () => {
  let ctx: ReturnType<typeof setup>;

  describe("first connection", () => {
    beforeEach(async () => {
      ctx = setup([info({ latestSeq: 10 })]);
      ctx.stream.start();
      await ctx.flush();
    });

    it("reads info, opens the socket and subscribes from the node's latestSeq", () => {
      expect(ctx.statuses).toEqual(["connecting"]);
      expect(ctx.sockets).toHaveLength(1);
      expect(ctx.sockets[0]?.url).toBe("ws://node/rpc");
      ctx.sockets[0]?.open();
      expect(ctx.sockets[0]?.subscribeParams).toEqual(["explorerEvents", 10]);
    });

    it("goes live when the subscription is acknowledged", () => {
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      expect(ctx.statuses).toEqual(["connecting", "live"]);
    });

    it("delivers newer events once, ignoring duplicates, older seqs and malformed notifications", () => {
      const s = ctx.sockets[0]!;
      s.open();
      s.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      s.receive(notification(event(11)));
      s.receive(notification(event(11)));
      s.receive(notification(event(9)));
      s.receive(notification({ seq: "x" } as unknown as LifecycleEventData));
      s.receive({ jsonrpc: "2.0", method: "other", params: {} });
      s.onmessage?.({ data: "not json" });
      s.onmessage?.({ data: 42 });
      s.receive(notification(event(12)));
      expect(ctx.events.map((e) => e.seq)).toEqual([11, 12]);
    });
  });

  describe("reconnecting", () => {
    it("resumes from the last delivered seq when the node is unchanged", async () => {
      ctx = setup([info({ latestSeq: 10 }), info({ latestSeq: 14 })]);
      ctx.stream.start();
      await ctx.flush();
      const first = ctx.sockets[0]!;
      first.open();
      first.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      first.receive(notification(event(11)));
      first.drop();
      expect(ctx.statuses.at(-1)).toBe("reconnecting");
      expect(ctx.timers[0]?.ms).toBe(1000);

      await ctx.fireTimer();
      expect(ctx.sockets).toHaveLength(2);
      ctx.sockets[1]?.open();
      expect(ctx.sockets[1]?.subscribeParams).toEqual(["explorerEvents", 11]);
      expect(ctx.resets).toEqual([]);
    });

    it("asks the caller to reload when bootId changed, and resumes from the new latestSeq", async () => {
      ctx = setup([info({ bootId: "boot-a", latestSeq: 10 }), info({ bootId: "boot-b", latestSeq: 2 })]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive(notification(event(11)));
      ctx.sockets[0]?.drop();
      await ctx.fireTimer();
      expect(ctx.resets).toEqual(["restart"]);
      ctx.sockets[1]?.open();
      expect(ctx.sockets[1]?.subscribeParams).toEqual(["explorerEvents", 2]);
    });

    it("asks the caller to reload when the node evicted events it never saw", async () => {
      ctx = setup([info({ latestSeq: 10, oldestSeq: 1 }), info({ latestSeq: 500, oldestSeq: 300 })]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive(notification(event(11)));
      ctx.sockets[0]?.drop();
      await ctx.fireTimer();
      expect(ctx.resets).toEqual(["gap"]);
      ctx.sockets[1]?.open();
      expect(ctx.sockets[1]?.subscribeParams).toEqual(["explorerEvents", 500]);
    });

    it.each([
      ["an empty history (oldestSeq 0)", { latestSeq: 0, oldestSeq: 0 }],
      ["a resume point right at the oldest retained event", { latestSeq: 40, oldestSeq: 11 }],
    ])("does not reset for %s", async (_name, second) => {
      ctx = setup([info({ latestSeq: 10 }), info(second)]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.drop();
      await ctx.fireTimer();
      expect(ctx.resets).toEqual([]);
    });

    it("backs off while info fails, reports offline after three failures, then recovers", async () => {
      const down = new Error("down");
      ctx = setup([info(), down, down, down, info({ latestSeq: 10 })]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      ctx.sockets[0]?.drop();
      expect(ctx.timers.map((t) => t.ms)).toEqual([1000]);

      await ctx.fireTimer();
      await ctx.fireTimer();
      await ctx.fireTimer();
      expect(ctx.timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000]);
      expect(ctx.statuses.at(-1)).toBe("offline");

      await ctx.fireTimer();
      ctx.sockets[1]?.open();
      ctx.sockets[1]?.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      expect(ctx.statuses.at(-1)).toBe("live");
    });

    it("caps the backoff at 15 seconds", async () => {
      const down = new Error("down");
      ctx = setup([info(), down]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.drop();
      for (let i = 0; i < 7; i++) await ctx.fireTimer();
      expect(Math.max(...ctx.timers.map((t) => t.ms))).toBe(15000);
    });
  });

  describe("failures and shutdown", () => {
    it("stops retrying and reports fatal when the explorer is off", async () => {
      ctx = setup([info()]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({
        jsonrpc: "2.0",
        id: 1,
        message: "Explorer is disabled: start the node with --explorer.enable",
      });
      expect(ctx.fatal).toEqual(["Explorer is disabled: start the node with --explorer.enable"]);
      expect(ctx.statuses.at(-1)).toBe("offline");
      expect(ctx.timers).toHaveLength(0);
      expect(ctx.sockets[0]?.closed).toBe(true);
    });

    it("retries after a subscribe error that is not about the explorer", async () => {
      ctx = setup([info(), info()]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({ jsonrpc: "2.0", id: 1, error: "Internal server error" });
      expect(ctx.fatal).toEqual([]);
      expect(ctx.timers).toHaveLength(1);
    });

    it("stop() closes the socket, cancels a pending retry and silences callbacks", async () => {
      ctx = setup([info(), info()]);
      ctx.stream.start();
      await ctx.flush();
      const s = ctx.sockets[0]!;
      s.open();
      s.drop();
      expect(ctx.timers).toHaveLength(1);
      ctx.stream.stop();
      expect(ctx.timers[0]?.live).toBe(false);

      const before = ctx.statuses.length;
      s.receive(notification(event(50)));
      expect(ctx.events).toEqual([]);
      expect(ctx.statuses.length).toBe(before);
    });

    it("stop() while a socket is open closes it and ignores its later close event", async () => {
      ctx = setup([info()]);
      ctx.stream.start();
      await ctx.flush();
      const s = ctx.sockets[0]!;
      s.open();
      ctx.stream.stop();
      expect(s.closed).toBe(true);
      s.drop();
      expect(ctx.timers).toHaveLength(0);
    });
  });

  describe("run generations", () => {
    function deferredSetup() {
      const resolvers: Array<(i: Info) => void> = [];
      const sockets: FakeSocket[] = [];
      const statuses: StreamStatus[] = [];
      const stream = new ExplorerStream(
        "ws://node/rpc",
        {
          createSocket: (url) => {
            const s = new FakeSocket(url);
            sockets.push(s);
            return s;
          },
          fetchInfo: () => new Promise<Info>((resolve) => resolvers.push(resolve)),
          setTimer: () => ({}),
          clearTimer: () => {},
        },
        {
          onEvent: () => {},
          onStatus: (s) => statuses.push(s),
          onReset: () => {},
          onFatal: () => {},
        },
      );
      const flush = () => new Promise((r) => setTimeout(r, 0));
      return { stream, resolvers, sockets, statuses, flush };
    }

    it("start(); stop(); start() while fetchInfo is in flight opens exactly one socket", async () => {
      const c = deferredSetup();
      c.stream.start();
      c.stream.stop();
      c.stream.start();
      expect(c.resolvers).toHaveLength(2);
      c.resolvers[0]?.(info());
      c.resolvers[1]?.(info());
      await c.flush();
      expect(c.sockets).toHaveLength(1);
    });

    it("start() twice while fetchInfo is in flight opens exactly one socket", async () => {
      const c = deferredSetup();
      c.stream.start();
      c.stream.start();
      c.resolvers.forEach((r) => r(info()));
      await c.flush();
      expect(c.sockets).toHaveLength(1);
    });

    it("start() on a running stream closes the previous socket", async () => {
      const c = deferredSetup();
      c.stream.start();
      c.resolvers[0]?.(info());
      await c.flush();
      c.stream.start();
      c.resolvers[1]?.(info());
      await c.flush();
      expect(c.sockets).toHaveLength(2);
      expect(c.sockets[0]?.closed).toBe(true);
      expect(c.sockets[1]?.closed).toBe(false);
    });
  });

  describe("robustness", () => {
    it("schedules a retry when opening the socket throws", async () => {
      ctx = setup([info()], { createSocketThrows: true });
      ctx.stream.start();
      await ctx.flush();
      expect(ctx.timers).toHaveLength(1);
      expect(ctx.statuses.at(-1)).toBe("reconnecting");
    });

    it("schedules a retry when onReset throws", async () => {
      const timers: Array<() => void> = [];
      const sockets: FakeSocket[] = [];
      const infos = [info({ bootId: "a" }), info({ bootId: "b" })];
      const stream = new ExplorerStream(
        "ws://node/rpc",
        {
          createSocket: (url) => {
            const s = new FakeSocket(url);
            sockets.push(s);
            return s;
          },
          fetchInfo: async () => infos.shift() ?? info({ bootId: "b" }),
          setTimer: (fn) => {
            timers.push(fn);
            return {};
          },
          clearTimer: () => {},
        },
        {
          onEvent: () => {},
          onStatus: () => {},
          onReset: () => {
            throw new Error("boom");
          },
          onFatal: () => {},
        },
      );
      const flush = () => new Promise((r) => setTimeout(r, 0));
      stream.start();
      await flush();
      sockets[0]?.drop();
      expect(timers).toHaveLength(1);
      timers[0]?.();
      await flush();
      expect(timers).toHaveLength(2);
    });

    it("reports an error object frame with its message, not [object Object]", async () => {
      ctx = setup([info(), info()]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Explorer is disabled" } });
      expect(ctx.fatal).toEqual(["Explorer is disabled"]);
    });

    it("retries on an error object that is neither about the explorer nor method-not-found", async () => {
      ctx = setup([info(), info()]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Internal server error" } });
      expect(ctx.fatal).toEqual([]);
      expect(ctx.timers).toHaveLength(1);
    });

    it("treats a -32601 error object as fatal and uses its message", async () => {
      ctx = setup([info()]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
      expect(ctx.fatal).toEqual(["Method not found"]);
      expect(ctx.timers).toHaveLength(0);
    });
  });
});
