/**
 * Extracts what `FrameTxValidationService.checkEntityCompliance` needs
 * out of ethrex's real `ethrex_simulateFrameTransaction({trace: true})`
 * output (`erc7562Trace: FrameEntry[]`) - no synthetic wrapper node, no
 * reshaping: `getOpcodesInfo`/`getAccessInfo`/etc. (utils.ts) walk ethrex's
 * own `FrameCallTraceFrame` tree directly.
 */
import {
  EthrexSimulateFrameTransactionResult,
  FrameCallTraceFrame,
} from "@skandha/types/lib/executor/validation/ethrexFrameTx.js";

export interface PrefixTraceInfo {
  /**
   * One entry per validation-prefix `tx.frames[i]` (`i` in
   * `[0, lastPrefixIndex]`), sorted ascending by `frameIndex` - the root
   * scope of that frame's own trace.
   */
  epTopLevelCalls: FrameCallTraceFrame[];
  /**
   * The transaction-wide keccak preimage set. Lives on the LAST entry of
   * the FULL (unfiltered) trace's root, not any prefix-bounded entry:
   * ethrex accumulates preimages across frames without resetting per frame
   * (see `FrameCallTraceFrame.keccak`'s doc comment), so the last frame
   * traced - regardless of whether it's within the validation prefix -
   * carries the complete, transaction-wide set. Empty when there are no
   * frames at all.
   */
  transactionKeccak: `0x${string}`[];
}

/**
 * `lastPrefixIndex` (the validation prefix's last real frame index -
 * `Math.max(...prefix.frames.map(f => f.frameIndex))`, computed once by
 * `validate()` in `validators/frameTx.ts` and threaded into this function)
 * bounds `epTopLevelCalls` to `FrameEntry`s whose real `frameIndex` is
 * within the validation prefix (`<= lastPrefixIndex`). This matters because
 * `result.erc7562Trace` is ethrex's REAL per-frame trace for the WHOLE
 * transaction, not just the prefix - a post-prefix `DEFAULT`-mode frame (a
 * `post_op`, per EIP-8141 §Behavior: "a transaction may continue with any
 * number of user_ops and/or post_ops") would otherwise be miscounted as an
 * extra validation-prefix top-level call and trip
 * `checkEntityCompliance`'s `epTopLevelCalls.length !==
 * lastPrefixIndex + 1` fail-closed invariant on a perfectly ordinary,
 * spec-sanctioned transaction.
 *
 * Entries are sorted ascending by `frameIndex` before mapping - ethrex is
 * documented to already return them in that order, but this doesn't trust
 * that silently: an out-of-order array would produce an `epTopLevelCalls`
 * array whose position no longer lines up with `frameIndex`.
 *
 * Caller contract: only call this when `result.erc7562Trace != null` (the
 * gas pass succeeded and tracing was requested - independent of
 * `result.canonicalMempoolValid`, ethrex's own canonical-mempool-policy
 * opinion, which does not gate whether a trace is reported) - see
 * `validators/frameTx.ts`'s `validate()`, which fails closed before this is
 * ever invoked.
 */
export function selectPrefixTrace(
  result: EthrexSimulateFrameTransactionResult,
  lastPrefixIndex: number
): PrefixTraceInfo {
  const trace = result.erc7562Trace ?? [];
  const epTopLevelCalls = trace
    .filter((entry) => entry.frameIndex <= lastPrefixIndex)
    .sort((a, b) => a.frameIndex - b.frameIndex)
    .map((entry) => entry.root);
  const transactionKeccak =
    trace.length > 0 ? (trace[trace.length - 1].root.keccak ?? []) : [];
  return { epTopLevelCalls, transactionKeccak };
}
