/**
 * Wire types for ethrex's `ethrex_simulateFrameTransaction` RPC, mirroring
 * `crates/networking/rpc/ethrex.rs` (`SimulateFrameTransactionResult`,
 * `FrameExecResult`) and `crates/vm/levm/src/erc7562_tracer.rs`
 * (`FrameEntry`, `FrameCallTraceFrame`, `AccessedSlots`,
 * `ContractSizeWithOpcode`) on ethrex's `eip8141-tracer` branch.
 *
 * `UserOpValidation/utils.ts` and `validators/frameTx.ts` consume these
 * types directly - no adapter/synthetic wrapper reshapes them. Two wire-shape
 * details that don't match the obvious guess, and that those consumers
 * account for themselves:
 *
 * 1. `transientReads`/`transientWrites` are both counter-shaped
 *    (`HashMap<H256, u64>`, i.e. `{ [slot]: number }`) - only `reads` is
 *    value-list-shaped (`HashMap<H256, Vec<H256>>`, i.e.
 *    `{ [slot]: string[] }`). `getAccessInfo` (utils.ts) accumulates
 *    `transientReads`/`transientWrites` numerically and `reads` by
 *    concatenation accordingly.
 * 2. `usedOpcodes` keys are the opcode byte as a plain decimal string
 *    (`HashMap<u8, u64>` under serde_json, e.g. `{"241": 3}` for CALL/0xf1),
 *    not the `"0xf1"`-style hex string this codebase's own `EVM_OPCODES`
 *    table (packages/params) is indexed by - `validators/frameTx.ts`
 *    converts at each `EVM_OPCODES[...]` lookup site.
 *
 * `FrameCallTraceFrame.type` (`EthrexCallType`, below) mirrors ethrex's
 * `CallType` enum (`crates/common/tracing.rs`) and is what `getAccessInfo`
 * (utils.ts) uses to attribute DELEGATECALL/CALLCODE storage access to the
 * caller rather than the callee.
 */

export interface EthrexAccessedSlots {
  reads: { [slot: string]: string[] };
  writes: { [slot: string]: number };
  transientReads: { [slot: string]: number };
  transientWrites: { [slot: string]: number };
}

export interface EthrexContractSizeInfo {
  contractSize: number;
  /** Raw opcode byte value (a number, e.g. `241`), not a hex string. */
  opcode: number;
}

/**
 * Mirrors ethrex's `CallType` enum (`crates/common/tracing.rs`): a bare
 * `#[derive(Serialize)]` with no `rename_all`, so each variant serializes as
 * its own Rust name verbatim.
 */
export type EthrexCallType =
  | "CALL"
  | "CALLCODE"
  | "STATICCALL"
  | "DELEGATECALL"
  | "CREATE"
  | "CREATE2"
  | "SELFDESTRUCT";

export interface FrameCallTraceFrame {
  from: `0x${string}`;
  /**
   * Optional only because ethrex's Rust struct derives `Default` (which
   * needs *some* value for every field, including this one) - every frame
   * that actually reaches `erc7562Trace` was built by
   * `Erc7562FrameTracer::enter()`, whose every call site (all 7
   * `EthrexCallType` variants, plus every frame-root dispatch site) always
   * passes a concrete, non-optional `Address`. `null` here for a
   * well-formed response is a wire-format-mismatch bug, not a legitimate
   * "unresolved target" case - consumers (`getAccessInfo`,
   * `validators/frameTx.ts`'s target cross-check) fail closed on it rather
   * than silently falling back to a placeholder address.
   */
  to: `0x${string}` | null;
  /**
   * Lets a consumer distinguish a `DELEGATECALL`/`CALLCODE` scope (storage
   * access happens at `from`, the caller - both opcodes execute against the
   * caller's own storage, differing from each other only in
   * msg.sender/msg.value propagation) from every other call type (storage
   * access happens at `to`) - see `FrameCallTraceFrame::call_type`'s doc
   * comment in ethrex's `erc7562_tracer.rs`. Always present: ethrex's
   * `call_type` field has no `skip_serializing_if`.
   */
  type: EthrexCallType;
  /**
   * Value transferred by the `CALL`-family opcode that opened this scope.
   * Zero for a scope that is not a real EVM `CALL`-family opcode invocation
   * - `STATICCALL` (which cannot carry value), and every frame-transaction
   * frame's own root scope (a frame's own declared `value` is a structural
   * part of the frame transaction itself, not something a nested `CALL`
   * opcode transferred - see ERC-7562's `[OP-061]`, which this field exists
   * to let a consumer enforce).
   */
  value: `0x${string}`;
  /** Omitted entirely (not even `[]`) by ethrex when there are no nested calls. */
  calls?: FrameCallTraceFrame[];
  accessedSlots: EthrexAccessedSlots;
  extCodeAccessInfo: `0x${string}`[];
  /** Decimal-string opcode-byte keys - see the module-level comment. */
  usedOpcodes: { [opcodeByteAsDecimalString: string]: number };
  contractSize: { [address: string]: EthrexContractSizeInfo };
  outOfGas: boolean;
  /**
   * Keccak preimages observed up to (and including) this frame's root scope
   * closing. NOT reset per frame - accumulates across the whole transaction,
   * so the LAST `FrameEntry` in a result's `erc7562Trace` array carries the
   * transaction-wide set; earlier entries carry prefixes of it. Omitted
   * entirely (not `[]`) by ethrex when empty.
   */
  keccak?: `0x${string}`[];
}

export interface FrameEntry {
  /** Index into `FrameTransaction.frames`. */
  frameIndex: number;
  root: FrameCallTraceFrame;
}

export interface EthrexFrameExecResult {
  gasUsed: `0x${string}`;
  succeeded: boolean;
}

/** Result of `ethrex_simulateFrameTransaction(rawTxHex, block?, { trace? })`. */
export interface EthrexSimulateFrameTransactionResult {
  /**
   * ethrex's own canonical-mempool-policy verdict (ERC-7562-derived
   * banned-opcode/associated-storage rules it applies itself). Decoupled
   * from whether execution results are reported below - `false` here does
   * NOT imply `gasUsed`/`frames`/`erc7562Trace` are absent, so a consumer
   * must not treat this field as a fail-closed gate on its own; the real
   * "no data" signal is `erc7562Trace == null` (or `gasUsed`/`frames ==
   * null`). The sidecar runs its own ERC-7562/pre_verify-aware validation
   * against the trace regardless of this field's value.
   */
  canonicalMempoolValid: boolean;
  prefixShape: string | null;
  payer: `0x${string}` | null;
  maxCost: `0x${string}`;
  canonicalMempoolViolation: string | null;
  gasUsed: `0x${string}` | null;
  frames: EthrexFrameExecResult[] | null;
  executionStatus: "success" | "reverted" | null;
  executionError: string | null;
  /** Present only when `{trace: true}` was passed AND the gas pass succeeded (`frames != null`) - independent of `canonicalMempoolValid`. */
  erc7562Trace: FrameEntry[] | null;
  /** Present only when trace was requested, the gas pass succeeded, but the trace pass itself failed. */
  erc7562TraceError: string | null;
  /**
   * Failure detail, present (on an ethrex that has it) only when a validation-prefix
   * frame reverted or halted; `canonicalMempoolViolation` still carries the coarse
   * text. Absent on older ethrex and whenever the prefix passed or was rejected
   * before a frame ran.
   */
  /** Index into `FrameTransaction.frames` of the frame that failed. */
  failedFrameIndex?: number;
  /**
   * Machine-readable cause: `out_of_gas`, `revert`, `insufficient_funds`,
   * `value_exceeds_balance`, `payment_before_execution_approval`,
   * `approve_target_is_not_sender`, `approve_in_atomic_batch`, `invalid_opcode`,
   * `stack_error`, `invalid_jump`, `static_violation`, `halt`, `default_code_failed`
   * or `vm_error`. New values may appear; treat unknown ones via `haltDetail`.
   */
  haltReason?: string;
  /** Human-readable description of the cause. */
  haltDetail?: string;
  /** `REVERT` return data, for `revert`. */
  revertData?: `0x${string}`;
  /** The account whose funds fell short (`insufficient_funds`, `value_exceeds_balance`). */
  account?: `0x${string}`;
  /** That account's balance in wei, `0x`-hex. */
  balance?: `0x${string}`;
  /** What it needed in wei, `0x`-hex: the maximum cost, or the frame's value. */
  required?: `0x${string}`;
}
