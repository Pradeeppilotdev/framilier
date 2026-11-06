import {
  IsArray,
  IsDefined,
  IsEthereumAddress,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { Hex } from "viem";
import {
  APPROVE_SCOPE,
  ATOMIC_BATCH_FLAG,
  FRAME_MODE,
  SIG_SCHEME,
} from "@skandha/types/lib/contracts/FrameTx.js";
import { IsBigNumberish } from "../utils/isBigNumber.js";
import { IsHexOrNumber } from "../utils/isHexOrNumber.js";

/** bits 0-1 (APPROVE_SCOPE) + bit 2 (ATOMIC_BATCH_FLAG) - see `FrameTx.ts`. */
const MAX_FRAME_FLAGS =
  APPROVE_SCOPE.EXECUTION_AND_PAYMENT | ATOMIC_BATCH_FLAG;

type BigNumberish = bigint | number | `0x${string}` | `${number}`;

const BYTES32_REGEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * `FrameTransaction`-shaped `class-validator` DTOs. `FrameTransaction` has
 * no `eip7702Auth` field - there is no executor-side EIP-7702 handling.
 *
 * Field shapes mirror `packages/executor/src/entities/interfaces.ts`'s
 * `FrameTransactionSerialized` - the established wire/hex convention real
 * frame-tx responses already use (`FrameTxMempoolEntry.serialize()`):
 * every gas/value/chainId/nonce-shaped field is a hex STRING (validated
 * here, converted to real `bigint` in `../utils/frameTx.ts` before being
 * handed to the executor), `mode`/`flags` are plain numbers, everything
 * else is already hex.
 */

export class FrameLimitsDto {
  @IsBigNumberish()
  execution!: BigNumberish;

  @IsBigNumberish()
  state!: BigNumberish;
}

export class FrameDto {
  /** plain number OR hex string - see `IsHexOrNumber`'s doc comment. */
  @IsHexOrNumber((n) => (Object.values(FRAME_MODE) as number[]).includes(n))
  mode!: number;

  /**
   * bits 0-1: approval scope; bit 2: ATOMIC_BATCH_FLAG - see `FrameTx.ts`.
   * plain number OR hex string - see `IsHexOrNumber`'s doc comment.
   */
  @IsHexOrNumber((n) => n >= 0 && n <= MAX_FRAME_FLAGS)
  flags!: number;

  /** `null` for a frame with no call target. */
  @IsOptional()
  @IsEthereumAddress()
  target!: Hex | null;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => FrameLimitsDto)
  limits!: FrameLimitsDto;

  @IsBigNumberish()
  value!: BigNumberish;

  @IsString()
  data!: Hex;
}

export class SignatureEntryDto {
  /**
   * SIG_SCHEME: 0 = ARBITRARY, 1 = SECP256K1, 2 = P256.
   * plain number OR hex string - see `IsHexOrNumber`'s doc comment.
   */
  @IsHexOrNumber((n) => (Object.values(SIG_SCHEME) as number[]).includes(n))
  scheme!: number;

  /** empty ("0x") for ARBITRARY; 20-byte address for SECP256K1/P256. */
  @IsString()
  signer!: Hex | "0x";

  /** empty ("0x", canonical sig hash) or an explicit 32-byte digest. */
  @IsString()
  msg!: Hex | "0x";

  @IsString()
  signature!: Hex;
}

/** EIP-8272 `[source_id, slot, root]`; `sourceId`/`root` are 32-byte hex. */
export class RecentRootReferenceDto {
  @Matches(BYTES32_REGEX)
  sourceId!: Hex;

  @IsBigNumberish()
  slot!: BigNumberish;

  @Matches(BYTES32_REGEX)
  root!: Hex;
}

export class FeeParamsDto {
  @IsBigNumberish()
  maxPriorityFeePerGas!: BigNumberish;

  @IsBigNumberish()
  maxFeePerGas!: BigNumberish;

  @IsBigNumberish()
  maxFeePerBlobGas!: BigNumberish;
}

/**
 * A full, signed `FrameTransaction`, as validated directly at the top level
 * of `eth_sendFrameTransaction`'s single param - there is no wrapping
 * `{userOp, entryPoint}` envelope, since EIP-8141 has exactly one fixed
 * `ENTRY_POINT` sentinel, not a caller-supplied EntryPoint address. Also
 * reused, as an array, for `debug_bundler_setMempool`'s `txs`.
 */
export class FrameTransactionDto {
  @IsBigNumberish()
  chainId!: BigNumberish;

  /**
   * EIP-8250 keyed nonce: `nonceKeys` + `nonceSeq`. `nonce` alone is accepted
   * as shorthand for the linear domain (`nonceKeys: [0], nonceSeq: nonce`);
   * sending both forms is rejected in `toFrameTransaction`.
   */
  @IsOptional()
  @IsBigNumberish()
  nonce?: BigNumberish;

  @IsOptional()
  @IsArray()
  @IsBigNumberish({ each: true })
  nonceKeys?: BigNumberish[];

  @IsOptional()
  @IsBigNumberish()
  nonceSeq?: BigNumberish;

  @IsEthereumAddress()
  sender!: Hex;

  @IsDefined()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FrameDto)
  frames!: FrameDto[];

  @IsDefined()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SignatureEntryDto)
  signatures!: SignatureEntryDto[];

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => FeeParamsDto)
  fees!: FeeParamsDto;

  @IsArray()
  blobVersionedHashes!: Hex[];

  /** EIP-8272; omitted means none. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecentRootReferenceDto)
  recentRootReferences?: RecentRootReferenceDto[];
}
