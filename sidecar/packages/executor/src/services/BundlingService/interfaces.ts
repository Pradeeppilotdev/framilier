import { Hex } from "viem";
import { FrameTxMempoolEntry } from "../../entities/FrameTxMempoolEntry.js";

export interface IRelayingMode {
  isLocked(): boolean;

  /**
   * Submits ONE already-signed frame transaction to the privileged ethrex
   * endpoint (see `PrivilegedRelayer`).
   *
   * Replaces `sendBundle(bundle: Bundle)`: there is no batch to assemble and
   * nothing for the bundler to sign - see the note where `Bundle` used to
   * live in `src/interfaces.ts`.
   *
   * @param entry the mempool entry, for status bookkeeping and logging.
   * @param rawTx the transaction's canonical EIP-2718 bytes
   *   (`0x06 || rlp(fields)`, i.e. `encodeRawFrameTx(entry.tx)`).
   *
   * Resolves on successful submission and rejects otherwise; it deliberately
   * does NOT return a transaction hash. The hash is a pure function of the
   * signed bytes, so `BundlingService` computes it locally rather than
   * trusting the relay endpoint's own response to be authoritative over the
   * transaction's identity.
   */
  sendFrameTransaction(entry: FrameTxMempoolEntry, rawTx: Hex): Promise<void>;

  getAvailableRelayersCount(): number;

  /** Renamed from `canSubmitBundle` - there are no bundles any more. */
  canSubmit(): Promise<boolean>;
}
