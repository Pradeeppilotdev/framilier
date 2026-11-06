import { describe, it, expect } from "vitest";
import { RLP, NestedUint8Array } from "@ethereumjs/rlp";
import { toHex, toBytes } from "viem";
import {
  encodeFrameTx,
  decodeFrameTx,
  computeSigHash,
  encodeRawFrameTx,
} from "../../../src/services/FrameTxService/codec.js";
import {
  FRAME_MODE,
  APPROVE_SCOPE,
  FRAME_TX_TYPE,
  FrameTransaction,
} from "@skandha/types/lib/contracts/FrameTx.js";

/** RLP strips leading zeros; an empty byte string is the encoding of 0. */
const bytesToBigInt = (b: Uint8Array): bigint =>
  b.length === 0 ? 0n : BigInt(toHex(b));

const sampleTx: FrameTransaction = {
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender: "0x1111111111111111111111111111111111111111",
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
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
};

const SOURCE_ID = `0x${"a".repeat(64)}` as const;
const ROOT = `0x${"b".repeat(64)}` as const;

describe("FrameTx codec", () => {
  it("round-trips encode -> decode to an identical object", () => {
    const encoded = encodeFrameTx(sampleTx);
    const decoded = decodeFrameTx(encoded);
    expect(decoded).toEqual(sampleTx);
  });

  // A round trip cannot catch a wrong field list - this codec is its own
  // inverse, so it round-trips happily against a format no execution client
  // accepts. These assert the envelope against ethrex's real
  // `impl RLPEncode for FrameTransaction`, the shape
  // `ethrex_simulateFrameTransaction` actually decodes.
  describe("envelope field layout", () => {
    it("encodes the nine EIP-8141/8250/8272 envelope fields in order", () => {
      const decoded = RLP.decode(encodeFrameTx(sampleTx)) as NestedUint8Array;
      expect(decoded).toHaveLength(9);

      const [chainId, nonceKeys, nonceSeq, sender] = decoded;
      expect(bytesToBigInt(chainId as Uint8Array)).toBe(sampleTx.chainId);
      // EIP-8250: the linear (key-0) domain.
      expect((nonceKeys as NestedUint8Array).map((k) => bytesToBigInt(k as Uint8Array))).toEqual([0n]);
      expect(bytesToBigInt(nonceSeq as Uint8Array)).toBe(sampleTx.nonceSeq);
      expect(toHex(sender as Uint8Array)).toBe(sampleTx.sender);
      // EIP-8272 recent_root_references: required trailing list, empty here.
      expect(decoded[8]).toEqual([]);
    });

    it("encodes EIP-8250 keyed nonces and EIP-8272 references as ethrex lays them out", () => {
      const keyed: FrameTransaction = {
        ...sampleTx,
        nonceKeys: [1n, 0xabcdn],
        nonceSeq: 3n,
        recentRootReferences: [{ sourceId: SOURCE_ID, slot: 261223n, root: ROOT }],
      };
      const decoded = RLP.decode(encodeFrameTx(keyed)) as NestedUint8Array;
      expect((decoded[1] as NestedUint8Array).map((k) => bytesToBigInt(k as Uint8Array))).toEqual([1n, 0xabcdn]);
      expect(bytesToBigInt(decoded[2] as Uint8Array)).toBe(3n);
      // [source_id, slot, root], per ethrex's `impl RLPEncode for RecentRootReference`.
      const [ref] = decoded[8] as NestedUint8Array[];
      expect(toHex(ref[0] as Uint8Array)).toBe(SOURCE_ID);
      expect(bytesToBigInt(ref[1] as Uint8Array)).toBe(261223n);
      expect(toHex(ref[2] as Uint8Array)).toBe(ROOT);
    });

    it("round-trips keyed nonces and recent-root references", () => {
      const keyed: FrameTransaction = {
        ...sampleTx,
        nonceKeys: [5n, 2n ** 255n],
        nonceSeq: 0n,
        recentRootReferences: [
          { sourceId: SOURCE_ID, slot: 1n, root: ROOT },
          { sourceId: ROOT, slot: 2n ** 64n - 1n, root: SOURCE_ID },
        ],
      };
      expect(decodeFrameTx(encodeFrameTx(keyed))).toEqual(keyed);
    });

    it("changes the signature hash when the nonce keys or references change", () => {
      const base = computeSigHash(sampleTx);
      expect(computeSigHash({ ...sampleTx, nonceKeys: [1n] })).not.toBe(base);
      expect(
        computeSigHash({
          ...sampleTx,
          recentRootReferences: [{ sourceId: SOURCE_ID, slot: 1n, root: ROOT }],
        })
      ).not.toBe(base);
    });
  });

  it("computeSigHash is deterministic for the same transaction", () => {
    const h1 = computeSigHash(sampleTx);
    const h2 = computeSigHash(sampleTx);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("computeSigHash elides raw signature bytes for empty-msg signatures", () => {
    const txWithSig: FrameTransaction = {
      ...sampleTx,
      signatures: [{ scheme: 1, signer: "0x", msg: "0x", signature: "0xaa" }],
    };
    const txWithDifferentSigBytes: FrameTransaction = {
      ...sampleTx,
      signatures: [{ scheme: 1, signer: "0x", msg: "0x", signature: "0xbb" }],
    };
    // Per EIP-8141 §Signature Hash: raw signature bytes of empty-msg
    // entries are elided before hashing, so these must match.
    expect(computeSigHash(txWithSig)).toBe(computeSigHash(txWithDifferentSigBytes));
  });

  describe("encodeRawFrameTx", () => {
    it("prepends the single FRAME_TX_TYPE byte to encodeFrameTx's RLP output", () => {
      const raw = encodeRawFrameTx(sampleTx);
      const rlpOnly = encodeFrameTx(sampleTx);
      expect(raw.slice(2, 4)).toBe(FRAME_TX_TYPE.toString(16).padStart(2, "0"));
      // Byte 1 onward of the raw hex must equal encodeFrameTx's own hex
      // output, byte-for-byte - i.e. this really is "type byte || RLP",
      // per EIP-2718, not a re-derivation.
      expect(raw.slice(4)).toBe(Buffer.from(rlpOnly).toString("hex"));
    });

    it("preserves real signature bytes, unlike computeSigHash's elided copy", () => {
      const txWithSig: FrameTransaction = {
        ...sampleTx,
        signatures: [{ scheme: 1, signer: "0x", msg: "0x", signature: "0xaabbcc" }],
      };
      const raw = encodeRawFrameTx(txWithSig);
      expect(raw.toLowerCase()).toContain("aabbcc");
    });

    it("round-trips through decodeFrameTx once the leading type byte is stripped", () => {
      const raw = encodeRawFrameTx(sampleTx);
      const decoded = decodeFrameTx(Buffer.from(raw.slice(4), "hex"));
      expect(decoded).toEqual(sampleTx);
    });
  });
});
