import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import { ReputationStatus } from "@skandha/types/lib/executor";

export class SetReputationArgs {
  reputations!: {
    address: string;
    opsSeen: number;
    opsIncluded: number;
    status?: ReputationStatus;
  }[];

  entryPoint!: string;
}

/**
 * debug_bundler_setMempool payload: `txs: FrameTransaction[]`. No
 * `entryPoint` field - there is exactly one fixed `ENTRY_POINT` sentinel
 * address under EIP-8141, not a configurable per-request EntryPoint.
 */
export class SetMempoolArgs {
  txs!: FrameTransaction[];
}

/**
 * Return shape for `the sidecar.getFrameTransactionStatus`: `tx` plus the
 * entity fields (`sender`/`payer`/`factory`) resolved by
 * `FrameTxMempoolEntry`'s validation-prefix parsing. There is no
 * `entryPoint` concept for an EIP-8141 frame transaction.
 */
export interface FrameTransactionStatus {
  tx: FrameTransaction;
  sender: `0x${string}`;
  payer: `0x${string}`;
  factory?: `0x${string}`;
  status: string;
  reason?: string;
  transaction?: string;
}

/**
 * Return shape for `Eth.estimateFrameTransactionGas`. EIP-8141 frames each
 * carry exactly two gas fields (`limits.execution`/`limits.state`, see
 * `@skandha/types/lib/contracts/FrameTx`'s `FrameLimits`), so the
 * markup-adjusted estimate is naturally per-frame rather than a single flat
 * triple.
 */
export interface FrameGasEstimate {
  /** Suggested, markup-adjusted `limits.execution`/`limits.state` per frame, in `tx.frames` order. */
  frames: { execution: bigint; state: bigint }[];
  /** Markup-adjusted total gas across all frames (the frame-tx analogue of `preVerificationGas`'s overall-cost markup). */
  cumulativeGasUsed: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
