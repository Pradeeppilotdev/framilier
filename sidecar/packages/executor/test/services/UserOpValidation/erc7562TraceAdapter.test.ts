import { describe, it, expect } from "vitest";
import { selectPrefixTrace } from "../../../src/services/UserOpValidation/erc7562TraceAdapter.js";
import {
  EthrexSimulateFrameTransactionResult,
  FrameCallTraceFrame,
  FrameEntry,
} from "@skandha/types/lib/executor/validation/ethrexFrameTx.js";

const ENTRY_POINT = "0x00000000000000000000000000000000000000aa" as const;
const SENDER = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;

function emptyAccessedSlots() {
  return { reads: {}, writes: {}, transientReads: {}, transientWrites: {} };
}

function baseFrame(overrides: Partial<FrameCallTraceFrame> = {}): FrameCallTraceFrame {
  return {
    from: ENTRY_POINT,
    to: SENDER,
    type: "CALL",
    value: "0x0",
    accessedSlots: emptyAccessedSlots(),
    extCodeAccessInfo: [],
    usedOpcodes: {},
    contractSize: {},
    outOfGas: false,
    ...overrides,
  };
}

function baseResult(
  frames: FrameEntry[],
  overrides: Partial<EthrexSimulateFrameTransactionResult> = {}
): EthrexSimulateFrameTransactionResult {
  return {
    canonicalMempoolValid: true,
    prefixShape: "SelfVerify",
    payer: SENDER,
    maxCost: "0x0",
    canonicalMempoolViolation: null,
    gasUsed: "0x64",
    frames: frames.map(() => ({ gasUsed: "0x1", succeeded: true })),
    executionStatus: "success",
    executionError: null,
    erc7562Trace: frames,
    erc7562TraceError: null,
    ...overrides,
  };
}

describe("selectPrefixTrace", () => {
  it("returns empty epTopLevelCalls/keccak for an empty trace", () => {
    const { epTopLevelCalls, transactionKeccak } = selectPrefixTrace(
      baseResult([], { erc7562Trace: [] }),
      0
    );
    expect(epTopLevelCalls).toEqual([]);
    expect(transactionKeccak).toEqual([]);
  });

  it("maps one FrameEntry per tx.frames[i] into its own root, unchanged", () => {
    const result = baseResult([
      { frameIndex: 0, root: baseFrame({ from: ENTRY_POINT, to: SENDER }) },
      { frameIndex: 1, root: baseFrame({ from: ENTRY_POINT, to: OTHER }) },
    ]);

    const { epTopLevelCalls } = selectPrefixTrace(result, 1);

    expect(epTopLevelCalls).toHaveLength(2);
    expect(epTopLevelCalls[0].from).toBe(ENTRY_POINT);
    expect(epTopLevelCalls[0].to).toBe(SENDER);
    expect(epTopLevelCalls[1].to).toBe(OTHER);
  });

  it("preserves a genuinely nested call (a frame whose root makes an inner CALL) as-is", () => {
    const inner = baseFrame({ from: SENDER, to: OTHER });
    const root = baseFrame({ from: ENTRY_POINT, to: SENDER, calls: [inner] });
    const { epTopLevelCalls } = selectPrefixTrace(baseResult([{ frameIndex: 0, root }]), 0);

    expect(epTopLevelCalls).toHaveLength(1);
    const topLevel = epTopLevelCalls[0];
    expect(topLevel.calls).toHaveLength(1);
    expect(topLevel.calls![0].from).toBe(SENDER);
    expect(topLevel.calls![0].to).toBe(OTHER);
  });

  it("passes a `to: null` root scope (e.g. a CREATE) through unchanged", () => {
    const root = baseFrame({ to: null });
    const { epTopLevelCalls } = selectPrefixTrace(baseResult([{ frameIndex: 0, root }]), 0);
    expect(epTopLevelCalls[0].to).toBeNull();
  });

  it("reads the transaction-wide keccak set off the LAST frame's root, not the first", () => {
    const first = baseFrame({ keccak: ["0xaa"] });
    const last = baseFrame({ keccak: ["0xaa", "0xbb"] });
    const { transactionKeccak } = selectPrefixTrace(
      baseResult([
        { frameIndex: 0, root: first },
        { frameIndex: 1, root: last },
      ]),
      1
    );
    expect(transactionKeccak).toEqual(["0xaa", "0xbb"]);
  });

  it("defaults keccak to [] when the last frame omits the field entirely", () => {
    const last = baseFrame({}); // no `keccak` key at all
    const { transactionKeccak } = selectPrefixTrace(
      baseResult([{ frameIndex: 0, root: last }]),
      0
    );
    expect(transactionKeccak).toEqual([]);
  });

  it("carries usedOpcodes' decimal-string keys through unconverted", () => {
    // 241 = 0xf1 = CALL; 0 = 0x00 = STOP. Hex conversion is now the
    // consumer's (validators/frameTx.ts's) job, not this function's.
    const root = baseFrame({ usedOpcodes: { "241": 3, "0": 1 } });
    const { epTopLevelCalls } = selectPrefixTrace(baseResult([{ frameIndex: 0, root }]), 0);
    expect(epTopLevelCalls[0].usedOpcodes).toEqual({ "241": 3, "0": 1 });
  });

  it("carries accessedSlots (reads/writes/transientReads/transientWrites) through unchanged", () => {
    const slot = "0x" + "1".padStart(64, "0");
    const root = baseFrame({
      accessedSlots: {
        reads: { [slot]: ["0xdead"] },
        writes: { [slot]: 2 },
        transientReads: { [slot]: 2 },
        transientWrites: { [slot]: 1 },
      },
    });
    const { epTopLevelCalls } = selectPrefixTrace(baseResult([{ frameIndex: 0, root }]), 0);
    expect(epTopLevelCalls[0].accessedSlots).toEqual({
      reads: { [slot]: ["0xdead"] },
      writes: { [slot]: 2 },
      transientReads: { [slot]: 2 },
      transientWrites: { [slot]: 1 },
    });
  });

  it("carries extCodeAccessInfo, contractSize and outOfGas through unchanged", () => {
    const root = baseFrame({
      extCodeAccessInfo: [OTHER],
      contractSize: { [OTHER]: { contractSize: 5, opcode: 0x3b } },
      outOfGas: true,
    });
    const { epTopLevelCalls } = selectPrefixTrace(baseResult([{ frameIndex: 0, root }]), 0);
    expect(epTopLevelCalls[0].extCodeAccessInfo).toEqual([OTHER]);
    expect(epTopLevelCalls[0].contractSize).toEqual({ [OTHER]: { contractSize: 5, opcode: 0x3b } });
    expect(epTopLevelCalls[0].outOfGas).toBe(true);
  });

  it("carries a real DELEGATECALL frame's type and value through unchanged", () => {
    const root = baseFrame({ type: "DELEGATECALL", value: "0x0" });
    const { epTopLevelCalls } = selectPrefixTrace(baseResult([{ frameIndex: 0, root }]), 0);
    expect(epTopLevelCalls[0].type).toBe("DELEGATECALL");
  });

  it("carries a nested call's nonzero value through unchanged", () => {
    const inner = baseFrame({ from: SENDER, to: OTHER, value: "0x1" });
    const root = baseFrame({ from: ENTRY_POINT, to: SENDER, calls: [inner] });
    const { epTopLevelCalls } = selectPrefixTrace(baseResult([{ frameIndex: 0, root }]), 0);
    expect(epTopLevelCalls[0].calls![0].value).toBe("0x1");
  });

  describe("lastPrefixIndex filtering", () => {
    it("excludes FrameEntrys whose frameIndex is beyond lastPrefixIndex (a post-prefix body frame)", () => {
      // frameIndex 2 (e.g. a post-prefix post_op frame) must not appear in
      // epTopLevelCalls when lastPrefixIndex is 1 - this is exactly the bug:
      // ignoring frameIndex entirely would include all three.
      const result = baseResult([
        { frameIndex: 0, root: baseFrame({ to: SENDER }) },
        { frameIndex: 1, root: baseFrame({ to: OTHER }) },
        { frameIndex: 2, root: baseFrame({ to: OTHER }) },
      ]);

      const { epTopLevelCalls } = selectPrefixTrace(result, 1);

      expect(epTopLevelCalls).toHaveLength(2);
      expect(epTopLevelCalls.map((c) => c.to)).toEqual([SENDER, OTHER]);
    });

    it("sorts included entries by frameIndex rather than trusting array order", () => {
      const result = baseResult([
        { frameIndex: 1, root: baseFrame({ to: OTHER }) },
        { frameIndex: 0, root: baseFrame({ to: SENDER }) },
      ]);

      const { epTopLevelCalls } = selectPrefixTrace(result, 1);

      expect(epTopLevelCalls.map((c) => c.to)).toEqual([SENDER, OTHER]);
    });

    it("still reads the transaction-wide keccak set off the full trace's last entry, not the last INCLUDED one", () => {
      // The accumulated keccak set is transaction-wide (see
      // FrameCallTraceFrame's doc comment) - it must keep reading off the
      // real last erc7562Trace entry even when that entry itself is
      // excluded from epTopLevelCalls by the lastPrefixIndex filter.
      const result = baseResult([
        { frameIndex: 0, root: baseFrame({ keccak: ["0xaa"] }) },
        { frameIndex: 1, root: baseFrame({ keccak: ["0xaa", "0xbb"] }) }, // post-prefix, excluded
      ]);

      const { epTopLevelCalls, transactionKeccak } = selectPrefixTrace(result, 0);

      expect(epTopLevelCalls).toHaveLength(1);
      expect(transactionKeccak).toEqual(["0xaa", "0xbb"]);
    });
  });
});
