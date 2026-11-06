import { IsArray, IsDefined, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { FrameTransactionDto } from "./SendFrameTransaction.dto.js";

/**
 * `debug_bundler_setMempool` payload: `txs: FrameTransaction[]`, mirroring
 * the executor-side `SetMempoolArgs`. No `entryPoint` field - there is
 * exactly one fixed `ENTRY_POINT` sentinel address under EIP-8141, not a
 * configurable per-request EntryPoint.
 */
export class SetMempoolArgs {
  @IsDefined()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FrameTransactionDto)
  txs!: FrameTransactionDto[];
}
