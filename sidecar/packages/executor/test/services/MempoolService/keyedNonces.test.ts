import { describe, it, expect, vi } from "vitest";
import { keccak256 } from "viem";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { frameTxSlotKey } from "../../../src/services/MempoolService/utils.js";
import { ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { encodeRawFrameTx } from "../../../src/services/FrameTxService/codec.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;

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

const build = () =>
  new MempoolService(
    memoryDb(),
    1,
    { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any,
    new ExecutorEventBus(),
    { useropsTTL: 300, archiveDuration: 1 } as any,
    { debug: vi.fn(), error: vi.fn() } as any
  );

const tx = (
  nonceKeys: bigint[],
  nonceSeq = 0n,
  fee = 10n,
  sender: `0x${string}` = SENDER
): FrameTransaction => ({
  chainId: 1n,
  nonceKeys,
  nonceSeq,
  sender,
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
  fees: { maxPriorityFeePerGas: fee, maxFeePerGas: fee, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

const hashOf = (t: FrameTransaction) => keccak256(encodeRawFrameTx(t));
const add = (pool: MempoolService, t: FrameTransaction) => pool.addFrameTx(t, hashOf(t));
const pendingHashes = async (pool: MempoolService) =>
  (await pool.fetchPendingUserOps()).map((e) => e.txHash).sort();

describe("frameTxSlotKey", () => {
  it("keeps the pre-EIP-8250 key for linear txs, so stored entries still resolve", () => {
    expect(frameTxSlotKey(1, tx([0n], 7n))).toBe(`1:${SENDER}:7`);
  });

  it("slots keyed txs by their exact key set and sequence", () => {
    expect(frameTxSlotKey(1, tx([1n, 255n], 0n))).toBe(`1:${SENDER}:k[0x1,0xff]:0`);
    expect(frameTxSlotKey(1, tx([1n], 0n))).not.toBe(frameTxSlotKey(1, tx([2n], 0n)));
    expect(frameTxSlotKey(1, tx([1n], 0n))).not.toBe(frameTxSlotKey(1, tx([0n], 0n)));
  });
});

describe("MempoolService - EIP-8250 keyed nonces", () => {
  it("admits many keyed txs from one sender on disjoint keys, none replacing another", async () => {
    const pool = build();
    const txs = Array.from({ length: 12 }, (_, i) => tx([BigInt(i + 1)]));
    for (const t of txs) {
      expect((await add(pool, t)).replacedTxHash).toBeUndefined();
    }
    expect(await pendingHashes(pool)).toEqual(txs.map(hashOf).sort());
  });

  it("admits disjoint multi-key sets side by side", async () => {
    const pool = build();
    await add(pool, tx([1n, 2n]));
    await add(pool, tx([3n, 4n]));
    expect(await pendingHashes(pool)).toHaveLength(2);
  });

  it("rejects a tx sharing any key with a pending one, naming the key and its holder", async () => {
    const pool = build();
    const holder = tx([1n, 2n]);
    await add(pool, holder);
    for (const conflicting of [tx([2n, 3n]), tx([2n]), tx([1n, 2n, 3n])]) {
      await expect(add(pool, conflicting)).rejects.toThrow(
        new RegExp(`nonce key 0x[12] is already held by pending transaction ${hashOf(holder)}`)
      );
    }
    expect(await pendingHashes(pool)).toEqual([hashOf(holder)]);
  });

  it("allows one pending tx per key: the next sequence on the same key is rejected", async () => {
    const pool = build();
    await add(pool, tx([5n], 0n));
    await expect(add(pool, tx([5n], 1n))).rejects.toThrow(/nonce key 0x5 is already held/);
  });

  it("checks conflicts in the RPC pre-check too (validateFrameTxReplaceability)", async () => {
    const pool = build();
    await add(pool, tx([1n, 2n]));
    await expect(pool.validateFrameTxReplaceability(tx([2n]))).rejects.toThrow(/already held/);
    await expect(pool.validateFrameTxReplaceability(tx([3n]))).resolves.toBe(true);
  });

  it("fee-bumps the exact same key set and sequence, and refuses an underpriced bump", async () => {
    const pool = build();
    const first = tx([1n, 2n], 0n, 100n);
    await add(pool, first);
    // a replacement needs +10% on both fees
    await expect(add(pool, tx([1n, 2n], 0n, 109n))).rejects.toThrow(/fee too low/);
    const bump = tx([1n, 2n], 0n, 110n);
    expect((await add(pool, bump)).replacedTxHash).toBe(hashOf(first));
    expect(await pendingHashes(pool)).toEqual([hashOf(bump)]);
  });

  it("does not let a keyed tx and a linear tx of the same sender block each other", async () => {
    const pool = build();
    await add(pool, tx([0n], 0n));
    await add(pool, tx([1n], 0n));
    await add(pool, tx([0n], 1n));
    expect(await pendingHashes(pool)).toHaveLength(3);
  });

  it("does not see other senders' keys", async () => {
    const pool = build();
    await add(pool, tx([1n], 0n, 10n, SENDER));
    await add(pool, tx([1n], 0n, 10n, OTHER));
    expect(await pendingHashes(pool)).toHaveLength(2);
  });

  it("releases a key once its holder is no longer pending", async () => {
    const pool = build();
    const holder = tx([5n], 0n);
    await add(pool, holder);
    const entry = await pool.getEntryByHash(hashOf(holder));
    await pool.updateStatus([entry!], MempoolEntryStatus.OnChain, { transaction: hashOf(holder) });
    // Key 5 is now at sequence 1 on chain; its next transaction may enter.
    await expect(add(pool, tx([5n], 1n))).resolves.toBeDefined();
  });
});
