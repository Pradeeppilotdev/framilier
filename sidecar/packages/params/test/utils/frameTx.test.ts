import { describe, it, expect } from "vitest";
import {
  FrameTransaction as FrameTransactionSsz,
  VerifiedFrameTx as VerifiedFrameTxSsz,
} from "@skandha/types/lib/node/frameTx.js";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import {
  serializeFrameTx,
  deserializeFrameTx,
  toVerifiedFrameTx,
  deserializeVerifiedFrameTx,
} from "../../src/utils/frameTx.js";

const SENDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045".toLowerCase() as `0x${string}`;
const TARGET = "0x00000000000000000000000000000000000000AA";
const SIGNER = "0x1111111111111111111111111111111111111111";
const MSG = `0x${"22".repeat(32)}` as `0x${string}`;
const SIGNATURE = "0x1234567890abcdef";
const BLOB_HASH = `0x${"33".repeat(32)}` as `0x${string}`;
const ENTRY_POINT = "0x00000000000000000000000000000000000000aa";

function buildFrameTx(): FrameTransaction {
  return {
    chainId: BigInt(1337),
    // EIP-8250: non-linear keys, including one above 2**64.
    nonceKeys: [1n, 2n ** 200n],
    nonceSeq: BigInt(7),
    sender: SENDER,
    frames: [
      {
        mode: 1,
        flags: 0x2,
        target: null,
        limits: { execution: BigInt(100000), state: BigInt(50000) },
        value: BigInt(0),
        data: "0xdeadbeef",
      },
      {
        mode: 0,
        flags: 0x4,
        target: TARGET as `0x${string}`,
        limits: { execution: BigInt(1), state: BigInt(2) },
        value: BigInt(123456789),
        data: "0x",
      },
    ],
    signatures: [
      {
        scheme: 0,
        signer: "0x",
        msg: "0x",
        signature: SIGNATURE,
      },
      {
        scheme: 1,
        signer: SIGNER as `0x${string}`,
        msg: MSG,
        signature: SIGNATURE,
      },
    ],
    fees: {
      maxPriorityFeePerGas: BigInt(1_000_000_000),
      maxFeePerGas: BigInt(2_000_000_000),
      maxFeePerBlobGas: BigInt(3),
    },
    blobVersionedHashes: [BLOB_HASH],
    recentRootReferences: [
      {
        sourceId: `0x${"a".repeat(64)}`,
        slot: 2n ** 64n - 1n,
        root: `0x${"b".repeat(64)}`,
      },
    ],
  };
}

describe("frameTx serializer", () => {
  it("serializeFrameTx maps every field to its ssz equivalent", () => {
    const tx = buildFrameTx();
    const ssz = serializeFrameTx(tx);

    expect(ssz.chain_id).toBe(tx.chainId);
    expect(ssz.nonce_keys).toEqual(tx.nonceKeys);
    expect(ssz.nonce_seq).toBe(tx.nonceSeq);
    expect(ssz.sender).toEqual(
      Uint8Array.from(Buffer.from(SENDER.slice(2), "hex"))
    );

    expect(ssz.frames).toHaveLength(2);
    expect(ssz.frames[0].mode).toBe(1);
    expect(ssz.frames[0].flags).toBe(0x2);
    expect(ssz.frames[0].target).toBeNull();
    expect(ssz.frames[0].limits.execution).toBe(BigInt(100000));
    expect(ssz.frames[0].limits.state).toBe(BigInt(50000));
    expect(ssz.frames[0].data).toEqual(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));

    expect(ssz.frames[1].target).toEqual(
      Uint8Array.from(Buffer.from(TARGET.slice(2), "hex"))
    );
    expect(ssz.frames[1].data).toEqual(new Uint8Array(0));

    expect(ssz.signatures).toHaveLength(2);
    expect(ssz.signatures[0].signer).toEqual(new Uint8Array(0));
    expect(ssz.signatures[0].msg).toEqual(new Uint8Array(0));
    expect(ssz.signatures[1].signer).toEqual(
      Uint8Array.from(Buffer.from(SIGNER.slice(2), "hex"))
    );
    expect(ssz.signatures[1].msg).toEqual(
      Uint8Array.from(Buffer.from(MSG.slice(2), "hex"))
    );

    expect(ssz.fees.max_priority_fee_per_gas).toBe(tx.fees.maxPriorityFeePerGas);
    expect(ssz.fees.max_fee_per_gas).toBe(tx.fees.maxFeePerGas);
    expect(ssz.fees.max_fee_per_blob_gas).toBe(tx.fees.maxFeePerBlobGas);

    expect(ssz.blob_versioned_hashes).toHaveLength(1);
    expect(ssz.blob_versioned_hashes[0]).toEqual(
      Uint8Array.from(Buffer.from(BLOB_HASH.slice(2), "hex"))
    );
  });

  it("round-trips TS -> ssz -> TS via serializeFrameTx/deserializeFrameTx", () => {
    const tx = buildFrameTx();
    const roundTripped = deserializeFrameTx(serializeFrameTx(tx));

    expect(roundTripped.chainId).toBe(tx.chainId);
    expect(roundTripped.nonceKeys).toEqual(tx.nonceKeys);
    expect(roundTripped.nonceSeq).toBe(tx.nonceSeq);
    expect(roundTripped.recentRootReferences).toEqual(tx.recentRootReferences);
    expect(roundTripped.sender.toLowerCase()).toBe(tx.sender.toLowerCase());
    expect(roundTripped.frames).toEqual(tx.frames);
    expect(roundTripped.signatures).toEqual(tx.signatures);
    expect(roundTripped.fees).toEqual(tx.fees);
    expect(roundTripped.blobVersionedHashes).toEqual(tx.blobVersionedHashes);
  });

  it("produces a value that the real ssz FrameTransaction type accepts and round-trips through actual (de)serialization", () => {
    const tx = buildFrameTx();
    const ssz = serializeFrameTx(tx);

    // Throws if the value doesn't conform to the ssz container's own
    // field/byte-length rules (e.g. a wrong-length ByteVector/ByteList).
    const bytes = FrameTransactionSsz.serialize(ssz);
    const decoded = FrameTransactionSsz.deserialize(bytes);

    expect(FrameTransactionSsz.equals(decoded, ssz)).toBe(true);
    expect(deserializeFrameTx(decoded)).toEqual(deserializeFrameTx(ssz));
  });

  it("round-trips through toVerifiedFrameTx/deserializeVerifiedFrameTx and real ssz VerifiedFrameTx encoding", () => {
    const tx = buildFrameTx();
    const blockHash = "0x64"; // 100

    const verified = toVerifiedFrameTx(ENTRY_POINT, tx, blockHash);
    expect(verified.verified_at_block_hash).toBe(BigInt(100));
    expect(verified.entry_point).toEqual(
      Uint8Array.from(Buffer.from(ENTRY_POINT.slice(2), "hex"))
    );

    const bytes = VerifiedFrameTxSsz.serialize(verified);
    const decoded = VerifiedFrameTxSsz.deserialize(bytes);
    expect(VerifiedFrameTxSsz.equals(decoded, verified)).toBe(true);

    const { entryPoint, tx: dTx } = deserializeVerifiedFrameTx(decoded);
    expect(entryPoint.toLowerCase()).toBe(ENTRY_POINT.toLowerCase());
    expect(dTx.sender.toLowerCase()).toBe(tx.sender.toLowerCase());
    expect(dTx.frames).toEqual(tx.frames);
    expect(dTx.signatures).toEqual(tx.signatures);
    expect(dTx.fees).toEqual(tx.fees);
    expect(dTx.blobVersionedHashes).toEqual(tx.blobVersionedHashes);
  });
});
