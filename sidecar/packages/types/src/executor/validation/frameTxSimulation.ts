/**
 * Result shape for `FrameTxSimulationService.simulate()`, modeled after
 * EIP-8141 §Receipt Encoding but deliberately simplified where the
 * simulation-time RPC (`ethrex_simulateFrameTransaction`) doesn't carry
 * enough detail to fill in the real on-chain receipt shape byte-for-byte -
 * see the per-field notes below and `FrameTxSimulationService`'s own header
 * comment. A real mined receipt (`ReceiptService`, via
 * `eth_getTransactionReceipt`) is the authoritative source for anything
 * this simplifies away.
 */

/**
 * Per-frame outcome as reported by `ethrex_simulateFrameTransaction`'s
 * `frames[i]` field, which is only `{gasUsed, succeeded}` - a boolean, not
 * EIP-8141's full per-frame status enum. `"success"`/`"reverted"` mirror the
 * same two-value vocabulary the RPC's own top-level `executionStatus` field
 * uses (see EthrexSimulateFrameTransactionResult), so a consumer already
 * handling that field's values handles this one identically.
 */
export type FrameSimulationStatus = "success" | "reverted";

export interface FrameGasUsed {
  /** Execution gas, taken directly from `frames[i].gasUsed`. */
  execution: `0x${string}`;
  /**
   * State gas. `ethrex_simulateFrameTransaction` does not currently break
   * out execution-vs-state gas separately, so this is always `"0x0"` at
   * simulation time - a documented gap, not a real zero reading.
   */
  state: `0x${string}`;
}

export interface FrameSimulationReceipt {
  status: FrameSimulationStatus;
  gasUsed: FrameGasUsed;
  /**
   * Always `[]`: this simulation RPC does not capture logs (only a real
   * mined receipt, via `eth_getTransactionReceipt`, would).
   */
  logs: string[];
}

export interface FrameTxSimulationResult {
  /** `result.gasUsed` - the accurate total gas across all frames. */
  cumulativeGasUsed: `0x${string}`;
  /** `result.payer` - the payer established by the validation prefix, or `null` if none was established. */
  payer: `0x${string}` | null;
  frameReceipts: FrameSimulationReceipt[];
}
