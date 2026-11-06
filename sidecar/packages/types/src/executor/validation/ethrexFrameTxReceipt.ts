/**
 * Wire types for ethrex's `eth_getTransactionReceipt` response for a frame
 * transaction.
 *
 * Unlike `ethrexFrameTx.ts` (`ethrex_simulateFrameTransaction`'s wire
 * types), this is a standard JSON-RPC method - ethrex doesn't add a new
 * method, it adds two extra top-level fields (`payer`, `frameReceipts`) to
 * the standard `RpcReceipt` response, present only when the transaction is
 * a frame transaction (`TxType::Frame`).
 *
 * Mirrors `crates/networking/rpc/types/receipt.rs` (`RpcReceipt`,
 * `#[serde(rename_all = "camelCase")]`, flattening `RpcReceiptInfo` +
 * `RpcReceiptTxInfo` + `RpcReceiptBlockInfo`, plus its own `payer`/
 * `frameReceipts` fields) and `crates/common/types/receipt.rs`
 * (`RpcFrameReceipt` - the RPC's own struct, not the on-chain SSZ/RLP
 * encoding) on ethrex's `eip8141-tracer` branch.
 *
 * A per-frame entry's gas is NOT `gasUsed: {execution, state}` (a nested
 * object) on the wire - ethrex flattens it into two sibling fields,
 * `gasUsed` (execution gas) and `stateGasUsed` (EIP-8037 state gas). This
 * codebase's own output type (`frameTxReceipt.ts`) is free to re-nest these
 * for its own consumers; this wire type must not, since it has to match the
 * real JSON byte-for-byte.
 */

/**
 * A single JSON-RPC log entry as ethrex returns it (standard shape, both at
 * the whole-receipt level and per-frame). Left as raw hex/strings
 * throughout - untouched pass-through, no consumer needs a further-decoded
 * `Log` shape yet.
 */
export interface EthrexReceiptLog {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
  transactionIndex: `0x${string}`;
  blockHash: `0x${string}`;
  logIndex: `0x${string}`;
  removed: boolean;
}

/**
 * `RpcFrameReceipt` (`crates/common/types/receipt.rs`). `status` is a hex
 * BYTE, not a bool-as-hex like the whole-receipt `status` field below:
 * `0x0` = FRAME_RECEIPT_STATUS_FAILURE, `0x1` = ..._SUCCESS,
 * `0x2` = ..._SKIPPED (a frame skipped by the validation-prefix's control
 * flow, e.g. a conditional frame whose condition wasn't met - there is no
 * equivalent third state in the simulation-time `FrameSimulationStatus`,
 * which only distinguishes success/reverted).
 */
export interface EthrexFrameReceipt {
  status: "0x0" | "0x1" | "0x2";
  /** Execution gas for this frame, hex u64. */
  gasUsed: `0x${string}`;
  /** EIP-8037 state gas for this frame, hex u64 - a SEPARATE sibling field, not nested under `gasUsed`. */
  stateGasUsed: `0x${string}`;
  logs: EthrexReceiptLog[];
}

/**
 * `RpcReceipt` (`#[serde(rename_all = "camelCase")]`), as returned by
 * `eth_getTransactionReceipt`. Only the fields this codebase actually reads
 * are documented in depth; the rest are standard Ethereum receipt fields
 * listed for completeness/type-safety of the raw RPC response.
 */
export interface EthrexFrameTxReceipt {
  /** `"0x6"` for a frame tx (`FRAME_TX_TYPE`). */
  type: `0x${string}`;
  /** Whole-TRANSACTION success/failure (serde_utils::bool as hex `0x0`/`0x1`) - NOT the same encoding as a per-frame `status` byte above. */
  status: "0x0" | "0x1";
  cumulativeGasUsed: `0x${string}`;
  logsBloom: `0x${string}`;
  /** Whole-transaction logs (RpcReceiptInfo's own) - NOT the per-frame `logs` under `frameReceipts[i]`. */
  logs: EthrexReceiptLog[];
  transactionHash: `0x${string}`;
  transactionIndex: `0x${string}`;
  blockHash: `0x${string}`;
  blockNumber: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}` | null;
  /** Whole-TX gasUsed (the standard receipt field) - NOT to be confused with a per-frame entry's own `gasUsed`. */
  gasUsed: `0x${string}`;
  effectiveGasPrice: `0x${string}`;
  contractAddress: `0x${string}` | null;
  /**
   * EIP-8141-specific. Omitted entirely (not `null`) by ethrex when absent
   * (`#[serde(skip_serializing_if = "Option::is_none")]`) - i.e. for a
   * non-frame-transaction's receipt.
   */
  payer?: `0x${string}`;
  /** EIP-8141-specific. Omitted entirely (not `null`/`[]`) when absent, same as `payer`. */
  frameReceipts?: EthrexFrameReceipt[];
}
