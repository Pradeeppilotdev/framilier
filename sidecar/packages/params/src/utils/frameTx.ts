import { ValueOf } from "@chainsafe/ssz";
import { ts } from "@skandha/types/lib/index.js";
import { UintBn256, UintBn64 } from "@skandha/types/lib/primitive/sszTypes";
import { fromHex } from "@skandha/utils/lib";
import {
  FrameTransaction,
  Frame,
  SignatureEntry,
  RecentRootReference,
} from "@skandha/types/lib/contracts/FrameTx.js";
import {
  FrameTransaction as FrameTransactionSsz,
  Frame as FrameSsz,
  SignatureEntry as SignatureEntrySsz,
} from "@skandha/types/lib/node/frameTx.js";
import { getAddress, toHex } from "viem";

// TS<->SSZ mapping between EIP-8141 `FrameTransaction`
// (`packages/types/src/contracts/FrameTx.ts`) and its SSZ wire encoding
// (`packages/types/src/node/frameTx.ts`). Mirrors the established
// `serializeUserOp`/`deserializeVerifiedUserOperation` pattern in
// `./userOp.ts` (paired serialize/deserialize functions, one per nested
// container, composed bottom-up), adapted for `FrameTransaction`'s shape.
//
// One deliberate deviation from `userOp.ts`: `UserOperation`'s numeric
// fields are typed `BigNumberish` (bigint | number | hex string | decimal
// string) on the TS side, so `userOp.ts` needs a pair of helpers
// (`bigintToBigNumber`/`bigNumberishToBigint`) to convert between that union
// and a validated `bigint`. Every numeric field on the TS `FrameTransaction`
// type is already a plain `bigint` (see `FrameTx.ts`), so only one direction
// of conversion exists here - still routed through `UintBn256.fromJson` (as
// `userOp.ts` does) so a malformed/out-of-range value is still asserted
// against the ssz type's own rules rather than assigned blindly.
const uintBn256 = (bn: bigint): bigint => UintBn256.fromJson(bn) as unknown as bigint;
const uintBn64 = (bn: bigint): bigint =>
  UintBn64.fromJson(bn) as unknown as bigint;

type SszFrame = ValueOf<typeof FrameSsz>;
type SszSignatureEntry = ValueOf<typeof SignatureEntrySsz>;
type SszFrameTransaction = ValueOf<typeof FrameTransactionSsz>;

export const serializeFrame = (frame: Frame): SszFrame => {
  return {
    mode: frame.mode,
    flags: frame.flags,
    target: frame.target != null ? fromHex(getAddress(frame.target)) : null,
    limits: {
      execution: uintBn256(frame.limits.execution),
      state: uintBn256(frame.limits.state),
    },
    value: uintBn256(frame.value),
    data: fromHex(frame.data),
  };
};

export const deserializeFrame = (frame: SszFrame): Frame => {
  return {
    mode: frame.mode as Frame["mode"],
    flags: frame.flags,
    target:
      frame.target != null
        ? (getAddress(toHex(frame.target)) as `0x${string}`)
        : null,
    limits: {
      execution: frame.limits.execution,
      state: frame.limits.state,
    },
    value: frame.value,
    data: toHex(frame.data),
  };
};

export const serializeSignatureEntry = (
  sig: SignatureEntry
): SszSignatureEntry => {
  return {
    scheme: sig.scheme,
    // `fromHex("0x")` yields a zero-length Uint8Array, the correct ssz
    // encoding for the "empty" (ARBITRARY-scheme / canonical-hash) case -
    // no separate branch needed for the empty-string case.
    signer: fromHex(sig.signer),
    msg: fromHex(sig.msg),
    signature: fromHex(sig.signature),
  };
};

export const deserializeSignatureEntry = (
  sig: SszSignatureEntry
): SignatureEntry => {
  return {
    scheme: sig.scheme as SignatureEntry["scheme"],
    // `toHex` of a zero-length Uint8Array yields exactly "0x", matching the
    // TS type's own "empty" sentinel - no separate branch needed here either.
    signer: toHex(sig.signer) as SignatureEntry["signer"],
    msg: toHex(sig.msg) as SignatureEntry["msg"],
    signature: toHex(sig.signature),
  };
};

export const serializeFrameTx = (tx: FrameTransaction): SszFrameTransaction => {
  return {
    chain_id: uintBn256(tx.chainId),
    nonce_keys: tx.nonceKeys.map(uintBn256),
    nonce_seq: uintBn64(tx.nonceSeq),
    sender: fromHex(getAddress(tx.sender)),
    frames: tx.frames.map(serializeFrame),
    signatures: tx.signatures.map(serializeSignatureEntry),
    fees: {
      max_priority_fee_per_gas: uintBn256(tx.fees.maxPriorityFeePerGas),
      max_fee_per_gas: uintBn256(tx.fees.maxFeePerGas),
      max_fee_per_blob_gas: uintBn256(tx.fees.maxFeePerBlobGas),
    },
    blob_versioned_hashes: tx.blobVersionedHashes.map((hash) => fromHex(hash)),
    recent_root_references: tx.recentRootReferences.map((ref) => ({
      source_id: fromHex(ref.sourceId),
      slot: uintBn64(ref.slot),
      root: fromHex(ref.root),
    })),
  };
};

export const deserializeFrameTx = (tx: SszFrameTransaction): FrameTransaction => {
  return {
    chainId: tx.chain_id,
    nonceKeys: tx.nonce_keys,
    nonceSeq: tx.nonce_seq,
    sender: getAddress(toHex(tx.sender)) as `0x${string}`,
    frames: tx.frames.map(deserializeFrame),
    signatures: tx.signatures.map(deserializeSignatureEntry),
    fees: {
      maxPriorityFeePerGas: tx.fees.max_priority_fee_per_gas,
      maxFeePerGas: tx.fees.max_fee_per_gas,
      maxFeePerBlobGas: tx.fees.max_fee_per_blob_gas,
    },
    blobVersionedHashes: tx.blob_versioned_hashes.map((hash) => toHex(hash)),
    recentRootReferences: tx.recent_root_references.map(
      (ref): RecentRootReference => ({
        sourceId: toHex(ref.source_id),
        slot: ref.slot,
        root: toHex(ref.root),
      })
    ),
  };
};

export const toVerifiedFrameTx = (
  entryPoint: string,
  tx: FrameTransaction,
  blockHash: string
): ts.VerifiedFrameTx => {
  return {
    frame_transaction: serializeFrameTx(tx),
    entry_point: fromHex(getAddress(entryPoint)),
    verified_at_block_hash: uintBn256(BigInt(blockHash)),
  };
};

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const deserializeVerifiedFrameTx = (verifiedFrameTx: ts.VerifiedFrameTx) => {
  const dEntryPoint = toHex(verifiedFrameTx.entry_point);
  const dFrameTx = deserializeFrameTx(verifiedFrameTx.frame_transaction);
  return {
    entryPoint: dEntryPoint,
    tx: dFrameTx,
  };
};
