import { describe, it, expect } from "vitest";
import { FrameTxMempoolEntry } from "../../src/entities/FrameTxMempoolEntry.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import {
  FRAME_MODE,
  APPROVE_SCOPE,
  Frame,
  FrameTransaction,
} from "@skandha/types/lib/contracts/FrameTx.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const PAYMASTER = "0x2222222222222222222222222222222222222222" as const;
const FACTORY = "0x3333333333333333333333333333333333333333" as const;

const selfVerifyFrame = (): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
  target: null,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x" as const,
});

const onlyVerifyFrame = (): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags: APPROVE_SCOPE.EXECUTION,
  target: null,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x" as const,
});

const payFrame = (): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags: APPROVE_SCOPE.PAYMENT,
  target: PAYMASTER,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x" as const,
});

const deployFrame = (): Frame => ({
  mode: FRAME_MODE.DEFAULT,
  flags: 0,
  target: FACTORY,
  limits: { execution: 1n, state: 1n },
  value: 0n,
  data: "0x" as const,
});

const baseTx = (frames: Frame[], overrides: Partial<FrameTransaction> = {}): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender: SENDER,
  frames,
  signatures: [],
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
  ...overrides,
});

describe("FrameTxMempoolEntry", () => {
  it("exposes sender/payer/factory derived from the validation prefix, with no aggregator field", () => {
    const tx = baseTx([selfVerifyFrame()]);
    const entry = new FrameTxMempoolEntry(tx);
    expect(entry.sender).toBe(tx.sender);
    expect(entry.payer).toBe(tx.sender); // self_verify: payer resolves to tx.sender
    expect(entry.factory).toBeUndefined();
    expect((entry as any).aggregator).toBeUndefined();
    expect((entry as any).paymaster).toBeUndefined();
  });

  it("derives payer from the pay frame's target for the canonical-paymaster shape", () => {
    const tx = baseTx([onlyVerifyFrame(), payFrame()]);
    const entry = new FrameTxMempoolEntry(tx);
    expect(entry.sender).toBe(tx.sender);
    expect(entry.payer).toBe(PAYMASTER);
    expect(entry.factory).toBeUndefined();
  });

  it("derives factory from the deploy frame's target when present", () => {
    const tx = baseTx([deployFrame(), selfVerifyFrame()]);
    const entry = new FrameTxMempoolEntry(tx);
    expect(entry.sender).toBe(tx.sender);
    expect(entry.payer).toBe(tx.sender);
    expect(entry.factory).toBe(FACTORY);
  });

  it("defaults status/lastUpdatedTime/submitAttempts and carries through hash/status overrides", () => {
    const tx = baseTx([selfVerifyFrame()]);
    const entry = new FrameTxMempoolEntry(tx, {
      hash: "0xdeadbeef",
      status: MempoolEntryStatus.Pending,
      submitAttempts: 2,
    });
    expect(entry.status).toBe(MempoolEntryStatus.Pending);
    expect(entry.hash).toBe("0xdeadbeef");
    expect(entry.submitAttempts).toBe(2);
    expect(entry.lastUpdatedTime).toBeTypeOf("number");
  });

  it("setStatus updates status/lastUpdatedTime and status-specific fields", () => {
    const tx = baseTx([selfVerifyFrame()]);
    const entry = new FrameTxMempoolEntry(tx);
    const before = entry.lastUpdatedTime;
    entry.setStatus(MempoolEntryStatus.Submitted, { transaction: "0xaaaa" });
    expect(entry.status).toBe(MempoolEntryStatus.Submitted);
    expect(entry.transaction).toBe("0xaaaa");
    expect(entry.lastUpdatedTime).toBeGreaterThanOrEqual(before);

    entry.setStatus(MempoolEntryStatus.OnChain, { transaction: "0xbbbb" });
    expect(entry.actualTransaction).toBe("0xbbbb");

    entry.setStatus(MempoolEntryStatus.Reverted, { revertReason: "oops" });
    expect(entry.revertReason).toBe("oops");
  });

  it("isEqual compares by chainId/sender/nonceKeys/nonceSeq", () => {
    const keyed = new FrameTxMempoolEntry(
      baseTx([selfVerifyFrame()], { nonceKeys: [9n], nonceSeq: 5n })
    );
    const linear = new FrameTxMempoolEntry(baseTx([selfVerifyFrame()], { nonceSeq: 5n }));
    expect(keyed.isEqual(linear)).toBe(false);
    expect(
      keyed.isEqual(
        new FrameTxMempoolEntry(baseTx([selfVerifyFrame()], { nonceKeys: [9n], nonceSeq: 5n }))
      )
    ).toBe(true);
    const a = new FrameTxMempoolEntry(baseTx([selfVerifyFrame()], { nonceSeq: 5n }));
    const b = new FrameTxMempoolEntry(baseTx([selfVerifyFrame()], { nonceSeq: 5n }));
    const c = new FrameTxMempoolEntry(baseTx([selfVerifyFrame()], { nonceSeq: 6n }));
    expect(a.isEqual(b)).toBe(true);
    expect(a.isEqual(c)).toBe(false);
  });

  it("canReplace requires >=10% higher fees for an equal entry, but always allows replacing a finalized one", () => {
    const existing = new FrameTxMempoolEntry(
      baseTx([selfVerifyFrame()], { fees: { maxPriorityFeePerGas: 100n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n } })
    );
    const tooLow = new FrameTxMempoolEntry(
      baseTx([selfVerifyFrame()], { fees: { maxPriorityFeePerGas: 105n, maxFeePerGas: 105n, maxFeePerBlobGas: 0n } })
    );
    expect(tooLow.canReplace(existing)).toBe(false);

    const highEnough = new FrameTxMempoolEntry(
      baseTx([selfVerifyFrame()], { fees: { maxPriorityFeePerGas: 110n, maxFeePerGas: 110n, maxFeePerBlobGas: 0n } })
    );
    expect(highEnough.canReplace(existing)).toBe(true);

    existing.setStatus(MempoolEntryStatus.Finalized);
    expect(tooLow.canReplace(existing)).toBe(true);
  });

  it("canReplaceWithTTL allows replacement once the TTL has elapsed regardless of fees", () => {
    const existing = new FrameTxMempoolEntry(
      baseTx([selfVerifyFrame()], { fees: { maxPriorityFeePerGas: 100n, maxFeePerGas: 100n, maxFeePerBlobGas: 0n } }),
      { lastUpdatedTime: 0 }
    );
    const tooLow = new FrameTxMempoolEntry(
      baseTx([selfVerifyFrame()], { fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, maxFeePerBlobGas: 0n } }),
      { lastUpdatedTime: 1_000_000 }
    );
    expect(tooLow.canReplace(existing)).toBe(false);
    expect(tooLow.canReplaceWithTTL(existing, 10)).toBe(true);
  });

  it("compareByCost sorts descending by maxPriorityFeePerGas", () => {
    const low = new FrameTxMempoolEntry(
      baseTx([selfVerifyFrame()], { fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, maxFeePerBlobGas: 0n } })
    );
    const high = new FrameTxMempoolEntry(
      baseTx([selfVerifyFrame()], { fees: { maxPriorityFeePerGas: 9n, maxFeePerGas: 9n, maxFeePerBlobGas: 0n } })
    );
    const sorted = [low, high].sort(FrameTxMempoolEntry.compareByCost);
    expect(sorted[0]).toBe(high);
    expect(sorted[1]).toBe(low);
  });

  it("groupBySender groups entries by tx.sender", () => {
    const sender2 = "0x5555555555555555555555555555555555555555" as const;
    const a = new FrameTxMempoolEntry(baseTx([selfVerifyFrame()]));
    const b = new FrameTxMempoolEntry(baseTx([selfVerifyFrame()], { sender: sender2 }));
    const c = new FrameTxMempoolEntry(baseTx([selfVerifyFrame()]));
    const grouped = FrameTxMempoolEntry.groupBySender([a, b, c]);
    expect(grouped.map((e) => e.sender)).toEqual([SENDER, SENDER, sender2]);
  });

  it("serialize hex-encodes bigint fields for DB storage", () => {
    const tx = baseTx([selfVerifyFrame()], {
      nonceKeys: [3n, 4n],
      nonceSeq: 7n,
      recentRootReferences: [
        { sourceId: `0x${"a".repeat(64)}`, slot: 10n, root: `0x${"b".repeat(64)}` },
      ],
    });
    const entry = new FrameTxMempoolEntry(tx, { hash: "0xhash" });
    const serialized = entry.serialize();
    expect(serialized.tx.nonceKeys).toEqual(["0x3", "0x4"]);
    expect(serialized.tx.nonceSeq).toBe("0x7");
    expect(serialized.tx.recentRootReferences).toEqual([
      { sourceId: `0x${"a".repeat(64)}`, slot: "0xa", root: `0x${"b".repeat(64)}` },
    ]);
    expect(serialized.tx.sender).toBe(SENDER);
    expect(serialized.sender).toBe(SENDER);
    expect(serialized.payer).toBe(SENDER);
    expect(serialized.factory).toBeUndefined();
    expect(serialized.hash).toBe("0xhash");
    expect(serialized.status).toBe(MempoolEntryStatus.New);
  });
});

describe("FrameTxMempoolEntry.setStatus: the reason a transaction left the pool", () => {
  const entry = () => new FrameTxMempoolEntry(baseTx([selfVerifyFrame()]));

  it("keeps the reason for a cancelled transaction, as for a reverted one", () => {
    const cancelled = entry();
    cancelled.setStatus(MempoolEntryStatus.Cancelled, { revertReason: "payer is banned" });
    expect(cancelled.revertReason).toBe("payer is banned");
    const reverted = entry();
    reverted.setStatus(MempoolEntryStatus.Reverted, { revertReason: "frame 1 (reverted) did not succeed" });
    expect(reverted.revertReason).toBe("frame 1 (reverted) did not succeed");
  });

  it("drops a stale reason when the transaction goes back to New", () => {
    const e = entry();
    e.setStatus(MempoolEntryStatus.Reverted, { revertReason: "old" });
    e.setStatus(MempoolEntryStatus.New);
    expect(e.revertReason).toBeUndefined();
  });

  it("leaves the reason alone for statuses that carry none", () => {
    const e = entry();
    e.setStatus(MempoolEntryStatus.Submitted, { transaction: "0xabc" });
    expect(e.revertReason).toBeUndefined();
  });
});
