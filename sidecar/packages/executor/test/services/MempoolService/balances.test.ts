import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAddress, keccak256 } from "viem";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { frameTxObligations } from "../../../src/services/MempoolService/obligations.js";
import { FrameTxMempoolEntry } from "../../../src/entities/FrameTxMempoolEntry.js";
import { ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { encodeRawFrameTx } from "../../../src/services/FrameTxService/codec.js";

const SENDER = getAddress("0x1111111111111111111111111111111111111111");
const RECIPIENT = "0x3333333333333333333333333333333333333333" as const;

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

/** Self Relay: one VERIFY frame approving execution+payment (payer = sender), plus an optional value transfer. */
const tx = (key: bigint, opts: { value?: bigint; fee?: bigint } = {}): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [key],
  nonceSeq: 0n,
  sender: SENDER,
  frames: [
    {
      mode: FRAME_MODE.VERIFY,
      flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
      target: null,
      limits: { execution: 10n, state: 0n },
      value: 0n,
      data: "0x",
    },
    {
      mode: FRAME_MODE.SENDER,
      flags: 0,
      target: RECIPIENT,
      limits: { execution: 10n, state: 0n },
      value: opts.value ?? 0n,
      data: "0x",
    },
  ],
  signatures: [],
  fees: { maxPriorityFeePerGas: opts.fee ?? 1n, maxFeePerGas: opts.fee ?? 1n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

const hashOf = (t: FrameTransaction) => keccak256(encodeRawFrameTx(t));

describe("frameTxObligations", () => {
  it("charges a self-pay sender both the max gas cost and the top-level frame value", () => {
    const entry = new FrameTxMempoolEntry(tx(1n, { value: 50n }), { maxCost: 40n });
    expect(frameTxObligations(entry)).toEqual(new Map([[SENDER, 90n]]));
  });

  it("falls back to the frames' gas limits at maxFeePerGas when ethrex's figure is unknown", () => {
    const entry = new FrameTxMempoolEntry(tx(1n, { fee: 3n }));
    expect(frameTxObligations(entry)).toEqual(new Map([[SENDER, 60n]])); // (10 + 10) * 3
  });
});

describe("MempoolService - pending obligations never exceed balances", () => {
  let balance: bigint;
  const build = () =>
    new MempoolService(
      memoryDb(),
      1,
      { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any,
      new ExecutorEventBus(),
      { useropsTTL: 300, archiveDuration: 1 } as any,
      { debug: vi.fn(), error: vi.fn() } as any,
      async () => balance
    );
  const add = (pool: MempoolService, t: FrameTransaction, maxCost: bigint) =>
    pool.addFrameTx(t, hashOf(t), undefined, undefined, undefined, undefined, maxCost);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    balance = 100n;
  });
  afterEach(() => vi.useRealTimers());

  it("admits keyed txs while their summed max cost fits, and rejects the one that would not", async () => {
    const pool = build();
    await add(pool, tx(1n), 40n);
    await add(pool, tx(2n), 40n);
    await expect(add(pool, tx(3n), 40n)).rejects.toThrow(
      `${SENDER} cannot cover its pending frame transactions: they would owe 120 wei (40 for this one), its balance is 100 wei`
    );
    await expect(add(pool, tx(3n), 20n)).resolves.toBeDefined();
  });

  it("counts value moved by top-level frames", async () => {
    const pool = build();
    await add(pool, tx(1n, { value: 50n }), 10n);
    await expect(add(pool, tx(2n, { value: 50n }), 10n)).rejects.toThrow(/would owe 120 wei/);
  });

  it("does not count the transaction a fee bump replaces", async () => {
    const pool = build();
    await add(pool, tx(1n, { fee: 10n }), 60n);
    const bump = tx(1n, { fee: 11n });
    await expect(add(pool, bump, 66n)).resolves.toMatchObject({
      replacedTxHash: hashOf(tx(1n, { fee: 10n })),
    });
  });

  it("evicts the newest New entries once the balance drops, leaving Submitted ones alone", async () => {
    const pool = build();
    await add(pool, tx(1n), 30n);
    vi.advanceTimersByTime(1000);
    await add(pool, tx(2n), 30n);
    vi.advanceTimersByTime(1000);
    await add(pool, tx(3n), 30n);
    const first = await pool.getEntryByHash(hashOf(tx(1n)));
    await pool.updateStatus([first!], MempoolEntryStatus.Submitted);

    balance = 45n; // drained elsewhere: room for only one 30-wei obligation
    const evicted = await pool.enforceBalances(123n);

    expect(evicted.map((e) => e.txHash).sort()).toEqual([hashOf(tx(2n)), hashOf(tx(3n))].sort());
    expect(evicted[0].revertReason).toMatch(/can no longer cover .* as of block 123: balance 45 wei/);
    const pending = await pool.fetchPendingUserOps();
    expect(pending.map((e) => e.txHash)).toEqual([hashOf(tx(1n))]);
  });

  it("evicts only as many as needed, newest first", async () => {
    const pool = build();
    for (const key of [1n, 2n, 3n]) {
      await add(pool, tx(key), 30n);
      vi.advanceTimersByTime(1000);
    }
    balance = 60n;
    const evicted = await pool.enforceBalances(1n);
    expect(evicted.map((e) => e.txHash)).toEqual([hashOf(tx(3n))]);
  });

  it("does nothing while every account can still pay", async () => {
    const pool = build();
    await add(pool, tx(1n), 30n);
    expect(await pool.enforceBalances(1n)).toEqual([]);
  });
});
