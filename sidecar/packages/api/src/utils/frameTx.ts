import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import {
  Frame,
  FrameTransaction,
  RecentRootReference,
  SignatureEntry,
  frameTxNonceAndRootsViolation,
} from "@skandha/types/lib/contracts/FrameTx.js";
import {
  FeeParamsDto,
  FrameDto,
  FrameTransactionDto,
  RecentRootReferenceDto,
  SignatureEntryDto,
} from "../dto/SendFrameTransaction.dto.js";
import { EstimateFrameTransactionArgs } from "../dto/EstimateFrameTransaction.dto.js";
import { toPlainNumber } from "./isHexOrNumber.js";

/**
 * Wire-shape <-> executor-shape conversion for `FrameTransaction`.
 *
 * The wire/JSON-RPC shape (validated by the `class-validator` DTOs in
 * `../dto/`) mirrors `packages/executor/src/entities/interfaces.ts`'s
 * `FrameTransactionSerialized`, also what `FrameTxMempoolEntry.serialize()`
 * produces for responses: every gas/value/chainId/nonce-shaped field is a
 * hex string, `mode`/`flags` are plain numbers, everything else
 * (`sender`/`target`/`data`/`signatures`/`blobVersionedHashes`) is already
 * hex.
 *
 * `packages/executor`'s `Eth.sendFrameTransaction`/`estimateFrameTransactionGas`
 * take a real `FrameTransaction`/`Partial<FrameTransaction>`, whose
 * bigint-ish fields are strictly typed `bigint` - so the DTOs need an
 * explicit hex-string -> bigint conversion step before calling into the
 * executor; these functions are that step.
 */

function toFrame(dto: FrameDto): Frame {
  return {
    // mode/flags are validated (`IsHexOrNumber`) but not transformed by
    // `class-validator` - a hexlified round-trip value may still be a hex
    // string here, so normalize to the plain number the executor's
    // `FrameTransaction` type expects.
    mode: toPlainNumber(dto.mode) as Frame["mode"],
    flags: toPlainNumber(dto.flags)!,
    target: dto.target ?? null,
    limits: {
      execution: BigInt(dto.limits.execution),
      state: BigInt(dto.limits.state),
    },
    value: BigInt(dto.value),
    data: dto.data,
  };
}

function toSignature(dto: SignatureEntryDto): SignatureEntry {
  return {
    scheme: toPlainNumber(dto.scheme) as SignatureEntry["scheme"],
    signer: dto.signer,
    msg: dto.msg,
    signature: dto.signature,
  };
}

function toFees(dto: FeeParamsDto): FrameTransaction["fees"] {
  return {
    maxPriorityFeePerGas: BigInt(dto.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(dto.maxFeePerGas),
    maxFeePerBlobGas: BigInt(dto.maxFeePerBlobGas),
  };
}

function toRecentRootReference(
  dto: RecentRootReferenceDto
): RecentRootReference {
  return {
    sourceId: dto.sourceId,
    slot: BigInt(dto.slot),
    root: dto.root,
  };
}

function invalidParams(message: string): RpcError {
  return new RpcError(message, RpcErrorCodes.INVALID_USEROP);
}

/**
 * Resolves the EIP-8250 nonce from either form the wire accepts: `nonceKeys`
 * + `nonceSeq`, or the linear-domain shorthand `nonce` (= `[0]` / `nonce`).
 * Returns `undefined` when neither is present (only legal for estimation).
 */
function toNonce(dto: {
  nonce?: unknown;
  nonceKeys?: unknown[];
  nonceSeq?: unknown;
}): Pick<FrameTransaction, "nonceKeys" | "nonceSeq"> | undefined {
  const keyed = dto.nonceKeys !== undefined || dto.nonceSeq !== undefined;
  if (dto.nonce !== undefined && keyed) {
    throw invalidParams("send either nonce or nonceKeys/nonceSeq, not both");
  }
  if (dto.nonce !== undefined) {
    return { nonceKeys: [BigInt(0)], nonceSeq: BigInt(dto.nonce as string) };
  }
  if (!keyed) return undefined;
  if (dto.nonceKeys === undefined || dto.nonceSeq === undefined) {
    throw invalidParams("nonceKeys and nonceSeq must be sent together");
  }
  return {
    nonceKeys: dto.nonceKeys.map((k) => BigInt(k as string)),
    nonceSeq: BigInt(dto.nonceSeq as string),
  };
}

function assertStaticallyValid(
  tx: Pick<FrameTransaction, "nonceKeys" | "nonceSeq" | "recentRootReferences">
): void {
  const violation = frameTxNonceAndRootsViolation(tx);
  if (violation !== null) throw invalidParams(violation);
}

/** Full, signed frame transaction (`eth_sendFrameTransaction`, `debug_bundler_setMempool`). */
export function toFrameTransaction(dto: FrameTransactionDto): FrameTransaction {
  const nonce = toNonce(dto);
  if (nonce === undefined) {
    throw invalidParams("missing nonce: send nonceKeys/nonceSeq (or nonce)");
  }
  const tx: FrameTransaction = {
    chainId: BigInt(dto.chainId),
    ...nonce,
    sender: dto.sender,
    frames: dto.frames.map(toFrame),
    signatures: dto.signatures.map(toSignature),
    fees: toFees(dto.fees),
    blobVersionedHashes: dto.blobVersionedHashes,
    recentRootReferences: (dto.recentRootReferences ?? []).map(
      toRecentRootReference
    ),
  };
  assertStaticallyValid(tx);
  return tx;
}

/** Possibly-partial frame transaction (`eth_estimateFrameTransactionGas`). */
export function toPartialFrameTransaction(
  dto: EstimateFrameTransactionArgs
): Partial<FrameTransaction> {
  const nonce = toNonce(dto);
  const recentRootReferences = dto.recentRootReferences?.map(
    toRecentRootReference
  );
  assertStaticallyValid({
    nonceKeys: nonce?.nonceKeys ?? [BigInt(0)],
    nonceSeq: nonce?.nonceSeq ?? BigInt(0),
    recentRootReferences: recentRootReferences ?? [],
  });
  return {
    chainId: dto.chainId !== undefined ? BigInt(dto.chainId) : undefined,
    nonceKeys: nonce?.nonceKeys,
    nonceSeq: nonce?.nonceSeq,
    sender: dto.sender,
    frames: dto.frames.map(toFrame),
    signatures: dto.signatures ? dto.signatures.map(toSignature) : undefined,
    fees: dto.fees ? toFees(dto.fees) : undefined,
    blobVersionedHashes: dto.blobVersionedHashes,
    recentRootReferences,
  };
}
