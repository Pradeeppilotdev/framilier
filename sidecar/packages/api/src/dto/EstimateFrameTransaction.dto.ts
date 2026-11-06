import {
  IsArray,
  IsDefined,
  IsEthereumAddress,
  IsObject,
  IsOptional,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { Hex } from "viem";
import {
  FeeParamsDto,
  FrameDto,
  RecentRootReferenceDto,
  SignatureEntryDto,
} from "./SendFrameTransaction.dto.js";
import { IsBigNumberish } from "../utils/isBigNumber.js";

type BigNumberish = bigint | number | `0x${string}` | `${number}`;

/**
 * `eth_estimateFrameTransactionGas`'s single param: a possibly-partial
 * `FrameTransaction` (executor-side
 * `Eth.estimateFrameTransactionGas(tx: Partial<FrameTransaction>)`).
 *
 * A separate class from `FrameTransactionDto` rather than reusing it
 * wholesale, because they are genuinely not optional in the same places:
 * `Eth.estimateFrameTransactionGas` requires `sender` and a non-empty
 * `frames` up front (throws `INVALID_REQUEST` otherwise) but defaults
 * everything else itself (`chainId` -> `this.chainId`, nonce -> `[0]`/`0`,
 * `signatures` -> `[]`, `fees` -> a placeholder `{1, 1, 0}`,
 * `blobVersionedHashes` -> `[]`) - a dummy-signature/dummy-gas-price
 * estimation convenience. `frames[].limits` are still required per-frame
 * (the executor only overrides BODY-frame limits with a placeholder
 * internally; it still needs the caller's own values for validation-prefix
 * frames, see `eth.ts`'s `estimateFrameTransactionGas` doc comment).
 */
export class EstimateFrameTransactionArgs {
  @IsOptional()
  @IsBigNumberish()
  chainId?: BigNumberish;

  /** Linear-domain shorthand; see `FrameTransactionDto.nonce`. */
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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SignatureEntryDto)
  signatures?: SignatureEntryDto[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => FeeParamsDto)
  fees?: FeeParamsDto;

  @IsOptional()
  @IsArray()
  blobVersionedHashes?: Hex[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecentRootReferenceDto)
  recentRootReferences?: RecentRootReferenceDto[];
}
