import { describe, it, expect } from "vitest";
import { keccak256, encodePacked, toHex, concat } from "viem";
import {
  getAccessInfo,
  hasNestedCallWithValue,
  isSlotAssociatedWith,
  parseEntitySlots,
} from "../../../src/services/UserOpValidation/utils.js";
import { FrameCallTraceFrame } from "@skandha/types/lib/executor/validation/ethrexFrameTx.js";

const ENTRY_POINT = "0x00000000000000000000000000000000000000aa" as const;
const SENDER = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;

function baseFrame(overrides: Partial<FrameCallTraceFrame> = {}): FrameCallTraceFrame {
  return {
    from: ENTRY_POINT,
    to: SENDER,
    type: "CALL",
    value: "0x0",
    accessedSlots: { reads: {}, writes: {}, transientReads: {}, transientWrites: {} },
    extCodeAccessInfo: [],
    usedOpcodes: {},
    contractSize: {},
    outOfGas: false,
    ...overrides,
  };
}

describe("associated storage detection", () => {
  it("detects a slot at keccak(payer||x)+5 as associated with the payer", () => {
    const payerAddr = "0x2222222222222222222222222222222222222222";
    const x = "0x" + "00".repeat(32);
    // Use padded address (32 bytes) to match parseEntitySlots expectations
    const paddedAddr = ("0x" + "00".repeat(12) + payerAddr.slice(2)) as `0x${string}`;
    const packed = encodePacked(["bytes32", "bytes32"], [paddedAddr, x as `0x${string}`]);
    const base = BigInt(keccak256(packed));
    const slot = toHex(base + 5n);
    const entitySlots = parseEntitySlots({ payer: { addr: payerAddr } } as any, [packed]);
    expect(isSlotAssociatedWith(slot, payerAddr, entitySlots)).toBe(true);
  });

  it("does not flag a slot at offset 129 as associated (outside the 0..128 range)", () => {
    const payerAddr = "0x2222222222222222222222222222222222222222";
    const x = "0x" + "00".repeat(32);
    // Use padded address (32 bytes) to match parseEntitySlots expectations
    const paddedAddr = ("0x" + "00".repeat(12) + payerAddr.slice(2)) as `0x${string}`;
    const packed = encodePacked(["bytes32", "bytes32"], [paddedAddr, x as `0x${string}`]);
    const base = BigInt(keccak256(packed));
    const slot = toHex(base + 129n);
    const entitySlots = parseEntitySlots({ payer: { addr: payerAddr } } as any, [packed]);
    expect(isSlotAssociatedWith(slot, payerAddr, entitySlots)).toBe(false);
  });
});

describe("hasNestedCallWithValue", () => {
  it("returns false when no nested call carries value", () => {
    const root = baseFrame({ calls: [baseFrame({ from: SENDER, to: OTHER, value: "0x0" })] });
    expect(hasNestedCallWithValue(root)).toBe(false);
  });

  it("returns true for a direct nested call with nonzero value", () => {
    const root = baseFrame({ calls: [baseFrame({ from: SENDER, to: OTHER, value: "0x1" })] });
    expect(hasNestedCallWithValue(root)).toBe(true);
  });

  it("returns true for a value-carrying call nested two levels deep", () => {
    const grandchild = baseFrame({ from: OTHER, to: SENDER, value: "0x1" });
    const child = baseFrame({ from: SENDER, to: OTHER, value: "0x0", calls: [grandchild] });
    const root = baseFrame({ calls: [child] });
    expect(hasNestedCallWithValue(root)).toBe(true);
  });

  it("ignores the frame's own root-scope value (only .calls are checked)", () => {
    // A frame-transaction frame's own root scope's value is always zero by
    // ethrex's construction, but even if it weren't, it isn't a nested CALL
    // opcode's value - only descendants in .calls represent a real CALL.
    const root = baseFrame({ value: "0x1" });
    expect(hasNestedCallWithValue(root)).toBe(false);
  });
});

describe("getAccessInfo storage-context attribution", () => {
  // DELEGATECALL and CALLCODE both execute against the CALLER's storage -
  // they differ from each other only in msg.sender/msg.value propagation,
  // never in storage context - so both must attribute a call's storage
  // access to `from`, not `to`.
  function readOfOwnSlot(type: "CALL" | "DELEGATECALL" | "CALLCODE") {
    return baseFrame({
      from: SENDER,
      to: OTHER,
      type,
      accessedSlots: {
        reads: { ["0xslot"]: ["0x0"] },
        writes: {},
        transientReads: {},
        transientWrites: {},
      },
    });
  }

  it("attributes a plain CALL's storage access to `to` (the callee)", () => {
    const access = getAccessInfo(readOfOwnSlot("CALL"));
    expect(Object.keys(access)).toEqual([OTHER]);
  });

  it("attributes a DELEGATECALL's storage access to `from` (the caller)", () => {
    const access = getAccessInfo(readOfOwnSlot("DELEGATECALL"));
    expect(Object.keys(access)).toEqual([SENDER]);
  });

  it("attributes a CALLCODE's storage access to `from` (the caller), same as DELEGATECALL", () => {
    const access = getAccessInfo(readOfOwnSlot("CALLCODE"));
    expect(Object.keys(access)).toEqual([SENDER]);
  });

  it("throws rather than silently bucketing storage access under a placeholder address when `to` is null on a non-DELEGATECALL/CALLCODE frame", () => {
    const call = readOfOwnSlot("CALL");
    expect(() => getAccessInfo({ ...call, to: null })).toThrow();
  });
});

describe("getAccessInfo transientReads accumulation", () => {
  it("sums transientReads counts across sibling calls to the same address (counter-shaped, not list-shaped)", () => {
    const slot = "0x" + "1".padStart(64, "0");
    const call1 = baseFrame({
      from: SENDER,
      to: OTHER,
      accessedSlots: {
        reads: {},
        writes: {},
        transientReads: { [slot]: 2 },
        transientWrites: {},
      },
    });
    const call2 = baseFrame({
      from: SENDER,
      to: OTHER,
      accessedSlots: {
        reads: {},
        writes: {},
        transientReads: { [slot]: 3 },
        transientWrites: {},
      },
    });
    const root = baseFrame({ calls: [call1, call2] });

    const access = getAccessInfo(root);

    expect(access[OTHER].transientReads[slot]).toBe(5);
  });
});
