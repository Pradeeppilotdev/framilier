import { describe, it, expect } from "vitest";
import {
  FrameTransaction,
  FRAME_MODE,
  APPROVE_SCOPE,
  frameTxNonceAndRootsViolation,
  recentRootWindowViolation,
  isKeyedNonce,
} from "../../src/contracts/FrameTx.js";

describe("FrameTransaction type", () => {
  it("constructs a minimal well-formed transaction object", () => {
    const tx: FrameTransaction = {
      chainId: 1n,
      nonceKeys: [0n],
      nonceSeq: 0n,
      sender: "0x0000000000000000000000000000000000000001",
      frames: [
        {
          mode: FRAME_MODE.VERIFY,
          flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
          target: null,
          limits: { execution: 65536n, state: 0n },
          value: 0n,
          data: "0x",
        },
      ],
      signatures: [],
      fees: {
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 2_000_000_000n,
        maxFeePerBlobGas: 0n,
      },
      blobVersionedHashes: [],
      recentRootReferences: [],
    };
    expect(tx.frames.length).toBe(1);
    expect(tx.frames[0].mode).toBe(FRAME_MODE.VERIFY);
  });
});

describe("frameTxNonceAndRootsViolation (EIP-8250/8272 static rules)", () => {
  const ok = { nonceKeys: [0n], nonceSeq: 0n, recentRootReferences: [] };
  const ref = (slot: bigint) => ({
    sourceId: `0x${"a".repeat(64)}` as const,
    slot,
    root: `0x${"b".repeat(64)}` as const,
  });

  it("accepts the linear domain and well-formed keyed nonces", () => {
    expect(frameTxNonceAndRootsViolation(ok)).toBeNull();
    expect(frameTxNonceAndRootsViolation({ ...ok, nonceKeys: [1n, 2n, 2n ** 256n - 1n] })).toBeNull();
    expect(frameTxNonceAndRootsViolation({ ...ok, nonceSeq: 2n ** 64n - 2n })).toBeNull();
    expect(
      frameTxNonceAndRootsViolation({
        ...ok,
        recentRootReferences: Array.from({ length: 16 }, (_, i) => ref(BigInt(i))),
      })
    ).toBeNull();
  });

  it.each([
    ["no keys", { nonceKeys: [] }, /between 1 and 16/],
    ["17 keys", { nonceKeys: Array.from({ length: 17 }, (_, i) => BigInt(i + 1)) }, /between 1 and 16/],
    ["duplicate keys", { nonceKeys: [1n, 1n] }, /strictly increasing/],
    ["decreasing keys", { nonceKeys: [2n, 1n] }, /strictly increasing/],
    ["key 0 mixed with others", { nonceKeys: [0n, 1n] }, /only valid as the sole/],
    ["key above uint256", { nonceKeys: [2n ** 256n] }, /uint256/],
    ["nonceSeq = 2**64 - 1", { nonceSeq: 2n ** 64n - 1n }, /nonceSeq/],
    ["17 references", { recentRootReferences: Array.from({ length: 17 }, () => ref(1n)) }, /<= 16/],
    ["slot above uint64", { recentRootReferences: [ref(2n ** 64n)] }, /slot/],
  ])("rejects %s", (_, override, message) => {
    expect(frameTxNonceAndRootsViolation({ ...ok, ...override })).toMatch(message);
  });
});

describe("recentRootWindowViolation (EIP-8272, checked at head like ethrex's mempool)", () => {
  // Boundaries confirmed against ethrex_simulateFrameTransaction on the devnet.
  const HEAD = 261_223n;
  const ref = (slot: bigint) => [
    { sourceId: `0x${"a".repeat(64)}` as const, slot, root: `0x${"b".repeat(64)}` as const },
  ];

  it.each([
    ["the head slot itself", HEAD],
    ["the oldest usable slot (head - 8190)", HEAD - 8190n],
  ])("accepts %s", (_, slot) => {
    expect(recentRootWindowViolation(ref(slot), HEAD)).toBeNull();
  });

  it("rejects a slot after the head as too new", () => {
    expect(recentRootWindowViolation(ref(HEAD + 1n), HEAD)).toMatch(
      /slot 261224 is not referenceable before slot 261225/
    );
  });

  it("rejects head - 8191 as expired", () => {
    expect(recentRootWindowViolation(ref(HEAD - 8191n), HEAD)).toMatch(
      /expired: usable through slot 261223/
    );
  });

  it("reports the first bad reference among several", () => {
    expect(recentRootWindowViolation([...ref(HEAD), ...ref(0n)], HEAD)).toMatch(/slot 0 expired/);
    expect(recentRootWindowViolation([], HEAD)).toBeNull();
  });
});

describe("isKeyedNonce", () => {
  it("is false only for the linear [0] domain", () => {
    expect(isKeyedNonce({ nonceKeys: [0n] })).toBe(false);
    expect(isKeyedNonce({ nonceKeys: [1n] })).toBe(true);
    expect(isKeyedNonce({ nonceKeys: [1n, 2n] })).toBe(true);
  });
});
