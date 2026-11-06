import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { ExecutorEvent, ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";

const SENDER = "0x1111111111111111111111111111111111111111" as const;

function memoryDb() {
  const m = new Map<string, any>();
  return {
    get: async (k: string) => {
      if (!m.has(k)) throw new Error("Not Found");
      return m.get(k);
    },
    put: async (k: string, v: any) => {
      m.set(k, v);
    },
    del: async (k: string) => {
      m.delete(k);
    },
    getMany: async (ks: string[]) => ks.map((k) => m.get(k)).filter(Boolean),
  } as any;
}

const tx = (maxFee = 2n): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender: SENDER,
  frames: [
    {
      mode: FRAME_MODE.VERIFY,
      flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
      target: null,
      limits: { execution: 1n, state: 0n },
      value: 0n,
      data: "0x",
    },
  ],
  signatures: [],
  fees: { maxPriorityFeePerGas: maxFee, maxFeePerGas: maxFee, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

const fakeLogger = () => ({ debug: vi.fn(), error: vi.fn() }) as any;

const build = (archiveDuration = 1) =>
  new MempoolService(
    memoryDb(),
    1,
    { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any,
    new ExecutorEventBus(),
    { useropsTTL: 0, archiveDuration } as any,
    fakeLogger()
  );

describe("MempoolService late-inclusion watch list", () => {
  it("adds a cancelled entry to the watch list, findable via fetchWatchedEntries", async () => {
    const pool = build();
    await pool.addFrameTx(tx(), "0xaaa");
    const entry = await pool.getEntryByHash("0xaaa");
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "banned" });

    const watched = await pool.fetchWatchedEntries();
    expect(watched.map((e) => e.txHash)).toEqual(["0xaaa"]);
  });

  it("adds the OLD entry to the watch list when a replacement lands, keeping its own hash", async () => {
    const pool = build();
    await pool.addFrameTx(tx(2n), "0xaaa");
    const res = await pool.addFrameTx(tx(100n), "0xbbb");
    expect(res.replacedTxHash).toBe("0xaaa");

    const watched = await pool.fetchWatchedEntries();
    expect(watched.map((e) => e.txHash)).toEqual(["0xaaa"]);
    // The active slot now holds the new entry, untouched by the watch list.
    const active = await pool.getEntryByHash("0xbbb");
    expect(active?.txHash).toBe("0xbbb");
  });

  it("resolveWatchedEntry removes the entry from the watch list, updates a still-cancelled active entry, and emits onChainUserOps", async () => {
    const pool = build();
    await pool.addFrameTx(tx(), "0xaaa");
    const entry = await pool.getEntryByHash("0xaaa");
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "banned" });
    const watched = await pool.fetchWatchedEntries();

    const seen: any[] = [];
    (pool as any).eventBus.on(ExecutorEvent.onChainUserOps, (e: any) => seen.push(e));

    await pool.resolveWatchedEntry(watched[0], MempoolEntryStatus.OnChain, {
      includer: "0x9999999999999999999999999999999999999999",
    });

    expect(await pool.fetchWatchedEntries()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].txHash).toBe("0xaaa");
    expect(seen[0].includer).toBe("0x9999999999999999999999999999999999999999");
    expect(seen[0].status).toBe(MempoolEntryStatus.OnChain);

    // The active store (this entry's own sender:nonce slot, still holding
    // it since it was only cancelled, not replaced-away) is updated too, so
    // skandha_frameTransactionStatus/TxScreen agree with the explorer's
    // "included" outcome instead of still showing Cancelled.
    const active = await pool.getEntryByHash("0xaaa");
    expect(active?.status).toBe(MempoolEntryStatus.OnChain);
    expect(active?.includer).toBe("0x9999999999999999999999999999999999999999");
  });

  it("resolveWatchedEntry does not touch the active store when a different (replacing) entry now holds that slot", async () => {
    const pool = build();
    await pool.addFrameTx(tx(2n), "0xaaa");
    await pool.addFrameTx(tx(100n), "0xbbb"); // replaces 0xaaa
    const watched = await pool.fetchWatchedEntries();
    expect(watched.map((e) => e.txHash)).toEqual(["0xaaa"]);

    await pool.resolveWatchedEntry(watched[0], MempoolEntryStatus.OnChain, {
      includer: "0x9999999999999999999999999999999999999999",
    });

    const active = await pool.getEntryByHash("0xbbb");
    expect(active?.txHash).toBe("0xbbb");
    expect(active?.status).toBe(MempoolEntryStatus.New);
  });

  it("does not add the same txHash to the watch list twice", async () => {
    const pool = build();
    await pool.addFrameTx(tx(), "0xaaa");
    const entry = await pool.getEntryByHash("0xaaa");
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "banned" });
    // A second Cancelled transition for the same entry must not duplicate it.
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "banned again" });

    const watched = await pool.fetchWatchedEntries();
    expect(watched.map((e) => e.txHash)).toEqual(["0xaaa"]);
  });

  it("removes a stale watch-list entry when its hash becomes active again", async () => {
    const pool = build();
    await pool.addFrameTx(tx(2n), "0xaaa");
    const entry = await pool.getEntryByHash("0xaaa");
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "banned" });
    expect((await pool.fetchWatchedEntries()).map((e) => e.txHash)).toEqual(["0xaaa"]);

    // Resubmitting the exact same transaction is allowed once cancelled
    // (validateReplaceability) - it must not also still sit on the watch
    // list once it is active again, or it would race its own active entry.
    await pool.addFrameTx(tx(2n), "0xaaa");

    expect(await pool.fetchWatchedEntries()).toEqual([]);
    const active = await pool.getEntryByHash("0xaaa");
    expect(active?.status).toBe(MempoolEntryStatus.New);
  });
});

describe("MempoolService watch-list GC", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("deleteOldWatchedEntries purges watch-list entries past archiveDuration", async () => {
    const pool = build(1); // archiveDuration: 1 second
    await pool.addFrameTx(tx(), "0xaaa");
    const entry = await pool.getEntryByHash("0xaaa");
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "banned" });
    expect((await pool.fetchWatchedEntries()).map((e) => e.txHash)).toEqual(["0xaaa"]);

    vi.advanceTimersByTime(2_000); // past the 1s archiveDuration

    await pool.deleteOldWatchedEntries();

    expect(await pool.fetchWatchedEntries()).toEqual([]);
  });

  it("deleteOldWatchedEntries leaves recently-watched entries alone", async () => {
    const pool = build(100); // archiveDuration: 100 seconds
    await pool.addFrameTx(tx(), "0xaaa");
    const entry = await pool.getEntryByHash("0xaaa");
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "banned" });

    vi.advanceTimersByTime(2_000); // well under the 100s archiveDuration

    await pool.deleteOldWatchedEntries();

    expect((await pool.fetchWatchedEntries()).map((e) => e.txHash)).toEqual(["0xaaa"]);
  });
});
