import { describe, it, expect, vi } from "vitest";
import { keccak256 } from "viem";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { MempoolReconciler } from "../../../src/services/BundlingService/reconciliation.js";
import { FrameTxMempoolEntry } from "../../../src/entities/FrameTxMempoolEntry.js";
import { encodeRawFrameTx } from "../../../src/services/FrameTxService/codec.js";
import { logger } from "../../mocks/logger.js";

/**
 * The bug these tests exist to prevent a regression of: `BaseRelayer`'s old
 * `waitForEntry` was "verified" by unit tests whose `mempoolService.find`
 * mock always returned `null` - which made the polling loop's "not found"
 * branch (meant for a genuinely-pruned entry) fire immediately, so the
 * loop's real "still Submitted, keep waiting, eventually give up" behavior
 * was never exercised by any test. These tests use mocks that return a
 * REAL, still-live entry/receipt-absence, matching what `MempoolService`/
 * `ReceiptService` actually do in production, specifically so a similarly
 * unrealistic mock can't hide a bug here too.
 */

const SELF_VERIFY_FRAME = {
  mode: 1,
  flags: 3,
  target: null,
  limits: { execution: 50_000n, state: 50_000n },
  value: 0n,
  data: "0x",
} as const;

function buildTx(nonce = 0n): FrameTransaction {
  return {
    chainId: 1337n,
    nonceKeys: [0n],
    nonceSeq: nonce,
    sender: "0x1111111111111111111111111111111111111111",
    frames: [{ ...SELF_VERIFY_FRAME }],
    signatures: [
      {
        scheme: 1,
        signer: "0x1111111111111111111111111111111111111111",
        msg: "0x",
        signature: `0x${"ab".repeat(65)}`,
      },
    ],
    fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
    recentRootReferences: [],
  } as FrameTransaction;
}

function buildEntry(
  tx: FrameTransaction,
  status: MempoolEntryStatus,
  extra: { transaction?: string } = {}
): FrameTxMempoolEntry {
  return new FrameTxMempoolEntry(tx, {
    txHash: keccak256(encodeRawFrameTx(tx)),
    status,
    ...extra,
  });
}

function buildReconciler(opts: {
  blockNumber?: bigint;
  getReceipt?: ReturnType<typeof vi.fn>;
  simulate?: ReturnType<typeof vi.fn>;
  headSlot?: bigint | null;
} = {}) {
  const mempoolService = {
    fetchPendingUserOps: vi.fn().mockResolvedValue([]),
    enforceBalances: vi.fn().mockResolvedValue([]),
    fetchWatchedEntries: vi.fn().mockResolvedValue([]),
    resolveWatchedEntry: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };
  const receiptService = {
    getReceipt:
      opts.getReceipt ??
      vi.fn().mockResolvedValue({ status: "success", frameReceipts: [], blockNumber: 42n }),
  };
  const frameTxSimulationService = {
    simulate:
      opts.simulate ??
      vi.fn().mockResolvedValue({
        validation: { mempoolMembership: { std: true }, accessedSlots: {} },
        simulation: {},
      }),
  };
  const publicClient = {
    getBlockNumber: vi.fn().mockResolvedValue(opts.blockNumber ?? 1n),
    getChainId: vi.fn().mockResolvedValue(1337),
    getBlock: vi.fn().mockResolvedValue({ miner: "0x7777777777777777777777777777777777777777" }),
    request: vi.fn().mockImplementation(async () =>
      opts.headSlot == null ? {} : { slotNumber: `0x${opts.headSlot.toString(16)}` }
    ),
  };
  const networkConfig = { standardMempoolId: "std" } as any;

  const reconciler = new MempoolReconciler(
    mempoolService as any,
    receiptService as any,
    frameTxSimulationService as any,
    publicClient as any,
    networkConfig,
    null, // metrics
    logger
  );

  return { reconciler, mempoolService, receiptService, frameTxSimulationService, publicClient };
}

describe("MempoolReconciler block-advance guard", () => {
  it("does nothing when the block number hasn't advanced since the last pass", async () => {
    const { reconciler, mempoolService } = buildReconciler({ blockNumber: 5n });

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(mempoolService.fetchPendingUserOps).toHaveBeenCalledTimes(1);
  });

  it("runs again once the block number advances", async () => {
    const { reconciler, mempoolService, publicClient } = buildReconciler({
      blockNumber: 5n,
    });

    await reconciler.reconcile();
    publicClient.getBlockNumber.mockResolvedValue(6n);
    await reconciler.reconcile();

    expect(mempoolService.fetchPendingUserOps).toHaveBeenCalledTimes(2);
  });
});

describe("MempoolReconciler.reconcile - Submitted entries (inclusion detection)", () => {
  it("marks a Submitted entry OnChain once its receipt is found", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Submitted, {
      transaction: "0xaaaa",
    });
    const { reconciler, mempoolService } = buildReconciler({
      getReceipt: vi
        .fn()
        .mockResolvedValue({ cumulativeGasUsed: 1n, status: "success", frameReceipts: [], blockNumber: 42n }),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.OnChain,
      { transaction: "0xaaaa", includer: "0x7777777777777777777777777777777777777777" }
    );
  });

  it("marks a Submitted entry Reverted, naming the failing frame, when its receipt reports transaction failure", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Submitted, {
      transaction: "0xaaaa",
    });
    const { reconciler, mempoolService } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        cumulativeGasUsed: 1n,
        status: "reverted",
        blockNumber: 42n,
        frameReceipts: [
          { status: "success", gasUsed: { execution: 0n, state: 0n }, logs: [] },
          { status: "reverted", gasUsed: { execution: 0n, state: 0n }, logs: [] },
        ],
      }),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.Reverted,
      expect.objectContaining({
        revertReason: expect.stringContaining("1 (reverted)"),
      })
    );
    // A landed-but-reverted transaction is still "done" from this
    // bundler's perspective - not requeued to New.
    expect(mempoolService.updateStatus).not.toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.New
    );
  });

  it("requeues a Submitted entry to New (not Reverted) when no receipt is confirmed absent", async () => {
    // Mirrors ReceiptService.getReceipt's real behavior for "no receipt yet"
    // - a thrown RpcError, not a resolved null.
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Submitted, {
      transaction: "0xaaaa",
    });
    const { reconciler, mempoolService } = buildReconciler({
      getReceipt: vi
        .fn()
        .mockRejectedValue(
          new RpcError("transaction receipt not found", RpcErrorCodes.SERVER_ERROR)
        ),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.New
    );
    expect(mempoolService.updateStatus).not.toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.Reverted,
      expect.anything()
    );
  });

  it("leaves a Submitted entry untouched when the receipt check fails for a non-RpcError (transport) reason", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Submitted, {
      transaction: "0xaaaa",
    });
    const { reconciler, mempoolService } = buildReconciler({
      getReceipt: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).not.toHaveBeenCalled();
  });

  it("passes the including block's miner as includer when a Submitted entry lands", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Submitted, {
      transaction: "0xaaaa",
    });
    const { reconciler, mempoolService, publicClient } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        cumulativeGasUsed: 1n,
        status: "success",
        frameReceipts: [],
        blockNumber: 42n,
      }),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);
    publicClient.getBlock.mockResolvedValue({
      miner: "0x7777777777777777777777777777777777777777",
    });

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.OnChain,
      {
        transaction: "0xaaaa",
        includer: "0x7777777777777777777777777777777777777777",
      }
    );
    expect(publicClient.getBlock).toHaveBeenCalledWith({ blockNumber: 42n });
  });

  it("still marks the entry OnChain when the includer lookup itself fails", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Submitted, {
      transaction: "0xaaaa",
    });
    const { reconciler, mempoolService, publicClient } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        cumulativeGasUsed: 1n,
        status: "success",
        frameReceipts: [],
        blockNumber: 42n,
      }),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);
    publicClient.getBlock.mockRejectedValue(new Error("ECONNREFUSED"));

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.OnChain,
      { transaction: "0xaaaa", includer: undefined }
    );
  });
});

/** A `New` entry that nothing has mined: the receipt lookup answers "not found" with an RpcError. */
const noReceipt = () =>
  vi.fn().mockRejectedValue(new RpcError("transaction receipt not found", RpcErrorCodes.SERVER_ERROR));

describe("MempoolReconciler.reconcile - New entries (revalidation)", () => {
  it("cancels a New entry that is no longer compliant with the standard mempool", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.New);
    const { reconciler, mempoolService } = buildReconciler({
      getReceipt: noReceipt(),
      simulate: vi.fn().mockResolvedValue({
        validation: { mempoolMembership: { std: false }, accessedSlots: {} },
        simulation: {},
      }),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.Cancelled,
      expect.objectContaining({
        revertReason: expect.stringContaining("no longer compliant"),
      })
    );
  });

  it("cancels a New entry whose revalidation throws", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.New);
    const { reconciler, mempoolService } = buildReconciler({
      getReceipt: noReceipt(),
      simulate: vi.fn().mockRejectedValue(new Error("boom")),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.Cancelled,
      expect.objectContaining({ revertReason: expect.stringContaining("boom") })
    );
  });

  it("cancels a New entry for another chain id, saying so, without simulating it", async () => {
    const entry = buildEntry({ ...buildTx(), chainId: 9n }, MempoolEntryStatus.New);
    const { reconciler, mempoolService, frameTxSimulationService } = buildReconciler({ getReceipt: noReceipt() });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.Cancelled,
      expect.objectContaining({ revertReason: expect.stringMatching(/chain id 9 does not match .* 1337/) })
    );
    expect(frameTxSimulationService.simulate).not.toHaveBeenCalled();
  });

  it("keeps revalidating when the node's chain id cannot be read", async () => {
    const entry = buildEntry({ ...buildTx(), chainId: 9n }, MempoolEntryStatus.New);
    const { reconciler, mempoolService, publicClient, frameTxSimulationService } = buildReconciler({ getReceipt: noReceipt() });
    publicClient.getChainId.mockRejectedValue(new Error("rpc down"));
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).not.toHaveBeenCalled();
    expect(frameTxSimulationService.simulate).toHaveBeenCalledTimes(1);
  });

  it("leaves a still-compliant New entry untouched", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.New);
    const { reconciler, mempoolService } = buildReconciler({ getReceipt: noReceipt() });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).not.toHaveBeenCalled();
  });
});

describe("MempoolReconciler.reconcile - New entries mined by someone else (inclusion detection)", () => {
  it("marks a New entry OnChain when its receipt exists, without revalidating it", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.New);
    const { reconciler, mempoolService, receiptService, frameTxSimulationService } = buildReconciler();
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(receiptService.getReceipt).toHaveBeenCalledWith(entry.txHash);
    expect(mempoolService.updateStatus).toHaveBeenCalledWith([entry], MempoolEntryStatus.OnChain, {
      transaction: entry.txHash,
      includer: "0x7777777777777777777777777777777777777777",
    });
    expect(frameTxSimulationService.simulate).not.toHaveBeenCalled();
  });

  it("marks it Reverted, naming the failing frame, when the receipt reports failure", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.New);
    const { reconciler, mempoolService } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        status: "reverted",
        blockNumber: 42n,
        frameReceipts: [{ status: "success" }, { status: "reverted" }],
      }),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith([entry], MempoolEntryStatus.Reverted, {
      revertReason: expect.stringContaining("frame(s) 1 (reverted)"),
      includer: "0x7777777777777777777777777777777777777777",
    });
  });

  it("revalidates as before when there is no receipt", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.New);
    const { reconciler, mempoolService, frameTxSimulationService } = buildReconciler({ getReceipt: noReceipt() });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(frameTxSimulationService.simulate).toHaveBeenCalledTimes(1);
    expect(mempoolService.updateStatus).not.toHaveBeenCalled();
  });

  it("leaves an entry alone, neither marking nor cancelling it, when the receipt check fails for a transport reason", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.New);
    const { reconciler, mempoolService, frameTxSimulationService } = buildReconciler({
      getReceipt: vi.fn().mockRejectedValue(new Error("fetch failed")),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).not.toHaveBeenCalled();
    expect(frameTxSimulationService.simulate).not.toHaveBeenCalled();
  });

  it("looks up at most 50 entries per pass, oldest first, and still revalidates the rest", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => {
      const e = buildEntry(buildTx(BigInt(i)), MempoolEntryStatus.New);
      e.submittedTime = 1_000 + (59 - i); // entry 59 is the oldest
      return e;
    });
    const { reconciler, mempoolService, receiptService, frameTxSimulationService } = buildReconciler({ getReceipt: noReceipt() });
    mempoolService.fetchPendingUserOps.mockResolvedValue(entries);

    await reconciler.reconcile();

    expect(receiptService.getReceipt).toHaveBeenCalledTimes(50);
    const looked = new Set(receiptService.getReceipt.mock.calls.map((c: any[]) => c[0]));
    const oldest50 = [...entries].sort((a, b) => a.submittedTime! - b.submittedTime!).slice(0, 50);
    expect(oldest50.every((e) => looked.has(e.txHash))).toBe(true);
    expect(frameTxSimulationService.simulate).toHaveBeenCalledTimes(60);
  });
});

describe("MempoolReconciler.reconcile - watch list (late inclusion)", () => {
  it("resolves a watched entry as OnChain, passing the landed status and includer", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Cancelled, {
      transaction: undefined,
    });
    const { reconciler, mempoolService, publicClient } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        status: "success",
        frameReceipts: [],
        blockNumber: 42n,
      }),
    });
    mempoolService.fetchWatchedEntries.mockResolvedValue([entry]);
    publicClient.getBlock.mockResolvedValue({
      miner: "0x7777777777777777777777777777777777777777",
    });

    await reconciler.reconcile();

    expect(mempoolService.resolveWatchedEntry).toHaveBeenCalledWith(
      entry,
      MempoolEntryStatus.OnChain,
      { includer: "0x7777777777777777777777777777777777777777", revertReason: undefined }
    );
  });

  it("resolves a watched entry as Reverted, naming the failing frame, when its receipt reports failure", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Cancelled);
    const { reconciler, mempoolService, publicClient } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        status: "reverted",
        blockNumber: 42n,
        frameReceipts: [
          { status: "success" },
          { status: "reverted" },
        ],
      }),
    });
    mempoolService.fetchWatchedEntries.mockResolvedValue([entry]);
    publicClient.getBlock.mockResolvedValue({
      miner: "0x7777777777777777777777777777777777777777",
    });

    await reconciler.reconcile();

    expect(mempoolService.resolveWatchedEntry).toHaveBeenCalledWith(
      entry,
      MempoolEntryStatus.Reverted,
      {
        includer: "0x7777777777777777777777777777777777777777",
        revertReason: expect.stringContaining("1 (reverted)"),
      }
    );
  });

  it("leaves a watched entry alone (does not resolve it) when it still has no receipt", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Cancelled);
    const { reconciler, mempoolService } = buildReconciler({ getReceipt: noReceipt() });
    mempoolService.fetchWatchedEntries.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.resolveWatchedEntry).not.toHaveBeenCalled();
  });

  it("leaves a watched entry on the list when the receipt check fails for a non-RpcError (transport) reason", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Cancelled);
    const { reconciler, mempoolService } = buildReconciler({
      getReceipt: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    mempoolService.fetchWatchedEntries.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.resolveWatchedEntry).not.toHaveBeenCalled();
  });

  it("caps watch-list checks at MAX_INCLUSION_LOOKUPS_PER_PASS per pass", async () => {
    const entries = Array.from({ length: 55 }, (_, i) =>
      buildEntry(buildTx(BigInt(i)), MempoolEntryStatus.Cancelled, {})
    );
    const { reconciler, receiptService, mempoolService } = buildReconciler({
      getReceipt: noReceipt(),
    });
    mempoolService.fetchWatchedEntries.mockResolvedValue(entries);

    await reconciler.reconcile();

    expect(receiptService.getReceipt).toHaveBeenCalledTimes(50);
  });

  it("round-robins over the watch list across passes, so entries beyond the per-pass cap still get checked eventually", async () => {
    // A stable txHash-sorted order (not oldest-first) is the fairness basis
    // - see final-review finding #1: oldest-first would let the same 50
    // entries occupy every pass forever once the list exceeds the cap,
    // starving newer entries (which are just as likely to have landed)
    // until they age out via archiveDuration, up to 24h by default.
    const entries = Array.from({ length: 55 }, (_, i) =>
      buildEntry(buildTx(BigInt(i)), MempoolEntryStatus.Cancelled, {})
    );
    const { reconciler, mempoolService, receiptService, publicClient } = buildReconciler({
      blockNumber: 1n,
      getReceipt: noReceipt(),
    });
    mempoolService.fetchWatchedEntries.mockResolvedValue(entries);

    await reconciler.reconcile();
    const firstPass = new Set(
      receiptService.getReceipt.mock.calls.map((c: any[]) => c[0])
    );
    expect(firstPass.size).toBe(50);

    publicClient.getBlockNumber.mockResolvedValue(2n);
    await reconciler.reconcile();
    const secondPass = receiptService.getReceipt.mock.calls
      .slice(50)
      .map((c: any[]) => c[0]);
    expect(secondPass).toHaveLength(50);

    // Fairness: across two passes (50 + 50 = 100 > 55 unique hashes), the
    // set actually checked must have moved on from pass 1's head, not
    // repeated the identical 50 - at least the remaining 5 unique hashes
    // must show up as new.
    const newInSecondPass = secondPass.filter((h: string) => !firstPass.has(h));
    expect(newInSecondPass.length).toBeGreaterThanOrEqual(5);
  });
});

describe("MempoolReconciler.reconcile - EIP-8272 recent-root window", () => {
  const HEAD = 261_223n;
  const withRef = (slot: bigint, key = 7n): FrameTransaction => ({
    ...buildTx(),
    nonceKeys: [key],
    recentRootReferences: [{ sourceId: `0x${"a".repeat(64)}`, slot, root: `0x${"b".repeat(64)}` }],
  });

  it("cancels a New entry whose reference left the window, without simulating it", async () => {
    const expired = buildEntry(withRef(HEAD - 8191n), MempoolEntryStatus.New);
    const fresh = buildEntry(withRef(HEAD - 10n, 8n), MempoolEntryStatus.New);
    const { reconciler, mempoolService, frameTxSimulationService } = buildReconciler({
      headSlot: HEAD,
      getReceipt: noReceipt(),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([expired, fresh]);

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [expired],
      MempoolEntryStatus.Cancelled,
      { revertReason: expect.stringMatching(/expired: usable through slot 261223 .*, as of block 1/) }
    );
    expect(frameTxSimulationService.simulate).toHaveBeenCalledTimes(1);
    expect(frameTxSimulationService.simulate).toHaveBeenCalledWith(fresh.tx);
  });

  it("revalidates as before when the chain reports no slot", async () => {
    const entry = buildEntry(withRef(1n), MempoolEntryStatus.New);
    const { reconciler, mempoolService, frameTxSimulationService } = buildReconciler({
      headSlot: null,
      getReceipt: noReceipt(),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(frameTxSimulationService.simulate).toHaveBeenCalledWith(entry.tx);
  });

  it("does not read the head slot when no entry declares a reference", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.New);
    const { reconciler, mempoolService, publicClient } = buildReconciler({ getReceipt: noReceipt() });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(publicClient.request).not.toHaveBeenCalled();
  });
});
