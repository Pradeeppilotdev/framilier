import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { keccak256 } from "viem";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { encodeRawFrameTx } from "../../../src/services/FrameTxService/codec.js";

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

const txWithFee = (maxFee: bigint): FrameTransaction => ({
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

describe("MempoolService.addFrameTx return value", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const build = () =>
    new MempoolService(
      memoryDb(),
      1,
      { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any,
      new ExecutorEventBus(),
      { useropsTTL: 0, archiveDuration: 1 } as any,
      { debug: vi.fn(), error: vi.fn() } as any
    );

  it("does not return the replacement while the old hash index still points at its slot", async () => {
    const pool = build();
    const original = txWithFee(10n), replacement = txWithFee(20n);
    const oldHash = keccak256(encodeRawFrameTx(original));
    const newHash = keccak256(encodeRawFrameTx(replacement));
    await pool.addFrameTx(original, oldHash);
    const db = (pool as any).db;
    const put = db.put.bind(db);
    let oldDuringReplacement: unknown;
    let newDuringReplacement: unknown;
    db.put = async (key: string, value: any) => {
      await put(key, value);
      if (value?.txHash === newHash) {
        oldDuringReplacement = await pool.getEntryByHash(oldHash);
        newDuringReplacement = await pool.getEntryByHash(newHash);
      }
    };
    await pool.addFrameTx(replacement, newHash);
    expect(oldDuringReplacement).toBeNull();
    expect(newDuringReplacement).toBeNull(); // index not yet published
    expect((await pool.getEntryByHash(newHash))?.txHash).toBe(newHash);
  });

  it("returns no replacedTxHash for a new transaction", async () => {
    const pool = build();
    const res = await pool.addFrameTx(txWithFee(2n), "0xaaa");
    expect(res.replacedTxHash).toBeUndefined();
  });

  it("never returns the new occupant for the hash of a purged nonce slot", async () => {
    const pool = build();
    await pool.addFrameTx(txWithFee(2n), "0xaaa");
    const archived = await pool.getEntryByHash("0xaaa");
    await pool.updateStatus([archived!], MempoolEntryStatus.Finalized);
    vi.advanceTimersByTime(2_000);
    await pool.deleteOldUserOps();
    expect(await pool.getEntryByHash("0xaaa")).toBeNull();

    await pool.addFrameTx(txWithFee(100n), "0xbbb");
    expect((await pool.getEntryByHash("0xbbb"))?.txHash).toBe("0xbbb");
    expect(await pool.getEntryByHash("0xaaa")).toBeNull();
  });

  it("returns the old transaction's hash when a newer one takes its sender:nonce slot", async () => {
    const pool = build();
    await pool.addFrameTx(txWithFee(2n), "0xaaa");
    vi.advanceTimersByTime(10); // useropsTTL is 0, so any later update may replace
    const res = await pool.addFrameTx(txWithFee(100n), "0xbbb");
    expect(res.replacedTxHash).toBe("0xaaa");
  });
});

describe("MempoolService.validateFrameTxReplaceability", () => {
  const build = (useropsTTL = 0) =>
    new MempoolService(
      memoryDb(),
      1,
      { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any,
      new ExecutorEventBus(),
      { useropsTTL, archiveDuration: 1 } as any,
      { debug: vi.fn(), error: vi.fn() } as any
    );
  const hashOf = (tx: FrameTransaction) => keccak256(encodeRawFrameTx(tx));

  it("says an identical resubmission is already known, not that its fee is too low", async () => {
    const pool = build(300);
    const tx = txWithFee(2n);
    await pool.addFrameTx(tx, hashOf(tx));
    await expect(pool.validateFrameTxReplaceability(tx)).rejects.toMatchObject({ message: expect.stringMatching(/already known/i) });
  });

  it("still says already known after the replacement TTL, when any newer transaction could replace it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const pool = build(1);
      const tx = txWithFee(2n);
      await pool.addFrameTx(tx, hashOf(tx));
      vi.advanceTimersByTime(5_000);
      await expect(pool.validateFrameTxReplaceability(tx)).rejects.toMatchObject({ message: expect.stringMatching(/already known/i) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the same transaction be submitted again once its entry was cancelled", async () => {
    const pool = build(300);
    const tx = txWithFee(2n);
    await pool.addFrameTx(tx, hashOf(tx));
    const entry = await pool.getEntryByHash(hashOf(tx));
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "gave up" });
    await expect(pool.validateFrameTxReplaceability(tx)).resolves.toBe(true);
  });

  it("still says already known for one that is on chain", async () => {
    const pool = build(300);
    const tx = txWithFee(2n);
    await pool.addFrameTx(tx, hashOf(tx));
    const entry = await pool.getEntryByHash(hashOf(tx));
    await pool.updateStatus([entry!], MempoolEntryStatus.OnChain, { transaction: hashOf(tx) });
    await expect(pool.validateFrameTxReplaceability(tx)).rejects.toMatchObject({ message: expect.stringMatching(/already known/i) });
  });

  it("keeps the fee rule for a different transaction in the same sender:nonce slot", async () => {
    const pool = build(300);
    const tx = txWithFee(100n);
    await pool.addFrameTx(tx, hashOf(tx));
    await expect(pool.validateFrameTxReplaceability(txWithFee(101n))).rejects.toMatchObject({
      message: expect.stringMatching(/cannot be replaced: fee too low/),
    });
    await expect(pool.validateFrameTxReplaceability(txWithFee(200n))).resolves.toBe(true);
  });

  it("fee-bumps a keyed transaction with the same key set", async () => {
    const pool = build(300);
    const keyed = { ...txWithFee(100n), nonceKeys: [7n, 9n] };
    await pool.addFrameTx(keyed, hashOf(keyed));
    await expect(
      pool.validateFrameTxReplaceability({ ...txWithFee(200n), nonceKeys: [7n, 9n] })
    ).resolves.toBe(true);
  });

  it("accepts a transaction for an empty slot", async () => {
    await expect(build().validateFrameTxReplaceability(txWithFee(2n))).resolves.toBe(true);
  });
});
