/**
 * Result shape for `ReceiptService.getReceipt()`, modeled after EIP-8141's
 * `ReceiptPayload` (`[cumulative_gas_used, payer, [frame_receipt, ...]]`,
 * `frame_receipt = [status, gas_used, logs]`) - see `ReceiptService`'s own
 * header comment.
 *
 * Deliberately its OWN type family, not a reuse of
 * `frameTxSimulation.ts`'s `FrameSimulationReceipt`/`FrameGasUsed`, for two
 * reasons:
 *  1. A real receipt's per-frame status has a third value (`"skipped"`,
 *     ethrex's `FRAME_RECEIPT_STATUS_SKIPPED`) that simulation-time
 *     `FrameSimulationStatus` has no equivalent for.
 *  2. This type decodes every hex gas amount into `bigint` (see
 *     `ReceiptService`'s header comment for why this diverges from
 *     `FrameTxSimulationResult`, which keeps hex strings) - a real mined
 *     receipt is meant to be the authoritative source callers do
 *     arithmetic against, unlike the simulation-time result.
 */

import { EthrexReceiptLog } from "./ethrexFrameTxReceipt.js";

export type FrameReceiptStatus = "success" | "reverted" | "skipped";

export interface FrameReceiptGasUsed {
  /** Execution gas, decoded from the wire's `gasUsed`. */
  execution: bigint;
  /** EIP-8037 state gas, decoded from the wire's `stateGasUsed`. */
  state: bigint;
}

export interface FrameReceipt {
  status: FrameReceiptStatus;
  gasUsed: FrameReceiptGasUsed;
  /**
   * This frame's own logs, passed through unchanged from the wire
   * (`EthrexReceiptLog[]`) - no consumer needs a further-decoded shape yet.
   */
  logs: EthrexReceiptLog[];
}

export interface FrameTxReceipt {
  /** The accurate total gas across all frames, decoded from the wire's `cumulativeGasUsed`. */
  cumulativeGasUsed: bigint;
  /** The payer established by the validation prefix. */
  payer: `0x${string}`;
  /** The block this transaction was mined in, decoded from the wire's `blockNumber`. */
  blockNumber: bigint;
  /**
   * Whole-TRANSACTION success/failure - the standard Ethereum receipt
   * status bit (`EthrexFrameTxReceipt.status`, `"0x0"`/`"0x1"`), decoded
   * here. NOT derived from `frameReceipts` - ethrex computes this
   * independently, and it's the authoritative answer to "did this
   * transaction succeed," not something worth re-deriving from an
   * aggregation rule over per-frame statuses (which has a third value,
   * `"skipped"`, with no obvious single-bit mapping).
   */
  status: "success" | "reverted";
  frameReceipts: FrameReceipt[];
}
