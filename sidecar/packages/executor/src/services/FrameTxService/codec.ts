import { RLP, Input, NestedUint8Array } from "@ethereumjs/rlp";
import { keccak256, toHex, toBytes, Hex } from "viem";
import {
  FrameTransaction,
  Frame,
  SignatureEntry,
  FeeParams,
  FrameMode,
  SigScheme,
  RecentRootReference,
  FRAME_TX_TYPE,
} from "@skandha/types/lib/contracts/FrameTx.js";

function encodeBigint(n: bigint): Uint8Array {
  if (n === BigInt(0)) return new Uint8Array();
  return toBytes(toHex(n));
}

/** Inverse of encodeBigint: RLP strips leading zero bytes, and an empty
 * buffer is the canonical encoding of 0. toHex/BigInt handles both an
 * empty buffer (-> "0x" -> BigInt("0x") throws, so special-case it) and
 * a populated buffer uniformly. */
function decodeBigint(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return BigInt(0);
  return BigInt(toHex(bytes));
}

function decodeNumber(bytes: Uint8Array): number {
  return Number(decodeBigint(bytes));
}

/** Decodes an RLP byte string back into hex. Unlike decodeBigint, this
 * preserves the exact bytes (including any leading zeros) since it's used
 * for opaque byte fields (addresses, calldata, signatures), not integers. */
function decodeHex(bytes: Uint8Array): `0x${string}` {
  return toHex(bytes);
}

function asBytes(x: Uint8Array | NestedUint8Array): Uint8Array {
  if (x instanceof Uint8Array) return x;
  throw new Error("FrameTx codec: expected an RLP byte string, got a nested list");
}

function asList(x: Uint8Array | NestedUint8Array): NestedUint8Array {
  if (Array.isArray(x)) return x;
  throw new Error("FrameTx codec: expected an RLP list, got a byte string");
}

function encodeFrame(f: Frame): Input[] {
  return [
    encodeBigint(BigInt(f.mode)),
    encodeBigint(BigInt(f.flags)),
    f.target ? toBytes(f.target) : new Uint8Array(),
    [encodeBigint(f.limits.execution), encodeBigint(f.limits.state)],
    encodeBigint(f.value),
    toBytes(f.data),
  ];
}

function decodeFrame(item: Uint8Array | NestedUint8Array): Frame {
  const [mode, flags, target, limits, value, data] = asList(item);
  const [execution, state] = asList(limits);
  const targetBytes = asBytes(target);
  return {
    mode: decodeNumber(asBytes(mode)) as FrameMode,
    flags: decodeNumber(asBytes(flags)),
    target: targetBytes.length === 0 ? null : decodeHex(targetBytes),
    limits: {
      execution: decodeBigint(asBytes(execution)),
      state: decodeBigint(asBytes(state)),
    },
    value: decodeBigint(asBytes(value)),
    data: decodeHex(asBytes(data)),
  };
}

function encodeSignature(s: SignatureEntry): Input[] {
  return [
    encodeBigint(BigInt(s.scheme)),
    toBytes(s.signer),
    toBytes(s.msg),
    toBytes(s.signature),
  ];
}

function decodeSignature(item: Uint8Array | NestedUint8Array): SignatureEntry {
  const [scheme, signer, msg, signature] = asList(item);
  return {
    scheme: decodeNumber(asBytes(scheme)) as SigScheme,
    signer: decodeHex(asBytes(signer)),
    msg: decodeHex(asBytes(msg)),
    signature: decodeHex(asBytes(signature)),
  };
}

function encodeFees(fees: FeeParams): Input[] {
  return [
    encodeBigint(fees.maxPriorityFeePerGas),
    encodeBigint(fees.maxFeePerGas),
    encodeBigint(fees.maxFeePerBlobGas),
  ];
}

function decodeFees(item: Uint8Array | NestedUint8Array): FeeParams {
  const [maxPriorityFeePerGas, maxFeePerGas, maxFeePerBlobGas] = asList(item);
  return {
    maxPriorityFeePerGas: decodeBigint(asBytes(maxPriorityFeePerGas)),
    maxFeePerGas: decodeBigint(asBytes(maxFeePerGas)),
    maxFeePerBlobGas: decodeBigint(asBytes(maxFeePerBlobGas)),
  };
}

function encodeRecentRootReference(ref: RecentRootReference): Input[] {
  return [toBytes(ref.sourceId), encodeBigint(ref.slot), toBytes(ref.root)];
}

function decodeRecentRootReference(
  item: Uint8Array | NestedUint8Array
): RecentRootReference {
  const [sourceId, slot, root] = asList(item);
  return {
    sourceId: decodeHex(asBytes(sourceId)),
    slot: decodeBigint(asBytes(slot)),
    root: decodeHex(asBytes(root)),
  };
}

/**
 * Frame transaction payload encoding: a flat RLP list, field-for-field per
 * EIP-8141 §Frame Transaction, EIP-8250 (keyed nonces), and EIP-8272
 * (recent-root references):
 *
 *   [chain_id, nonce_keys, nonce_seq, sender, frames, signatures, fees,
 *    blob_versioned_hashes, recent_root_references]
 *
 * with each reference encoded as `[source_id, slot, root]`.
 *
 * `computeSigHash` and `encodeRawFrameTx` both build on this function, so the
 * signature hash and the canonical wire bytes follow automatically.
 */
export function encodeFrameTx(tx: FrameTransaction): Uint8Array {
  const structure: Input[] = [
    encodeBigint(tx.chainId),
    tx.nonceKeys.map(encodeBigint),
    encodeBigint(tx.nonceSeq),
    toBytes(tx.sender),
    tx.frames.map(encodeFrame),
    tx.signatures.map(encodeSignature),
    encodeFees(tx.fees),
    tx.blobVersionedHashes.map((h) => toBytes(h)),
    tx.recentRootReferences.map(encodeRecentRootReference),
  ];
  return RLP.encode(structure);
}

/** Inverse of encodeFrameTx. @ethereumjs/rlp's decode (non-stream mode)
 * returns a NestedUint8Array mirroring the shape passed to encode: every
 * RLP list becomes a JS array and every RLP byte string becomes a
 * Uint8Array. This walks that shape back into the typed FrameTransaction,
 * inverting each encode* helper above field-for-field. */
export function decodeFrameTx(bytes: Uint8Array): FrameTransaction {
  const decoded = RLP.decode(bytes) as NestedUint8Array;
  const [
    chainId,
    nonceKeys,
    nonceSeq,
    sender,
    frames,
    signatures,
    fees,
    blobVersionedHashes,
    recentRootReferences,
  ] = decoded;

  return {
    chainId: decodeBigint(asBytes(chainId)),
    nonceKeys: asList(nonceKeys).map((k) => decodeBigint(asBytes(k))),
    nonceSeq: decodeBigint(asBytes(nonceSeq)),
    sender: decodeHex(asBytes(sender)),
    frames: asList(frames).map(decodeFrame),
    signatures: asList(signatures).map(decodeSignature),
    fees: decodeFees(fees),
    blobVersionedHashes: asList(blobVersionedHashes).map((h) => decodeHex(asBytes(h))),
    recentRootReferences: asList(recentRootReferences).map(
      decodeRecentRootReference
    ),
  };
}

/** Per EIP-8141 §Signature Hash: elide raw signature bytes for any
 * signature entry whose msg is empty before hashing. */
export function computeSigHash(tx: FrameTransaction): Hex {
  const elided: FrameTransaction = {
    ...tx,
    signatures: tx.signatures.map((s) => (s.msg === "0x" ? { ...s, signature: "0x" as const } : s)),
  };
  const payload = new Uint8Array([FRAME_TX_TYPE, ...encodeFrameTx(elided)]);
  return keccak256(payload);
}

/**
 * Per EIP-2718, a typed transaction's canonical wire encoding is
 * `TransactionType || RLP(fields)`: the single `FRAME_TX_TYPE` (0x06) byte
 * prepended to `encodeFrameTx`'s output, hex-encoded. This is the actual
 * signature-bearing transaction (unlike `computeSigHash`'s `elided` copy),
 * and is what `ethrex_simulateFrameTransaction`'s `rawTx` param expects.
 */
export function encodeRawFrameTx(tx: FrameTransaction): Hex {
  return toHex(new Uint8Array([FRAME_TX_TYPE, ...encodeFrameTx(tx)]));
}
