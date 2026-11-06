import { UserOperation } from "@skandha/types/lib/contracts/UserOperation";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import {
  MempoolEntryStatus,
  ReputationStatus,
} from "@skandha/types/lib/executor";

type BigNumberish = bigint | number | `0x${string}` | `${number}` | string;

export interface IMempoolEntry {
  chainId: number;
  userOp: UserOperation;
  entryPoint: string;
  prefund: BigNumberish;
  aggregator?: string;
  factory?: string;
  paymaster?: string;
  userOpHash: string;
  lastUpdatedTime: number;
  hash?: string;
  status: MempoolEntryStatus;
  transaction?: string;
  submitAttempts: number;
  submittedTime?: number;
  actualTransaction?: string;
  revertReason?: string;
}

export interface MempoolEntrySerialized {
  chainId: number;
  userOp: UserOperation;
  prefund: string;
  aggregator: string | undefined;
  factory: string | undefined;
  paymaster: string | undefined;
  userOpHash: string;
  hash: string | undefined;
  lastUpdatedTime: number;
  transaction: string | undefined;
  submitAttempts: number;
  status: MempoolEntryStatus;
  submittedTime?: number;
  actualTransaction: string | undefined;
  revertReason: string | undefined;
}

/**
 * EIP-8141 frame-transaction analogue of `IMempoolEntry`. `sender` is always
 * `tx.sender`; `payer`/`factory` are the addresses resolved from the
 * validation prefix's role-tagged frames (see
 * `FrameTxMempoolEntry`/`recognizeValidationPrefix`). There is no
 * `aggregator`/`paymaster`/`entryPoint`/`prefund` concept for a native frame
 * transaction.
 */
export interface IFrameTxMempoolEntry {
  chainId: bigint;
  tx: FrameTransaction;
  sender: `0x${string}`;
  payer: `0x${string}`;
  factory?: `0x${string}`;
  txHash?: string;
  lastUpdatedTime: number;
  hash?: string;
  status: MempoolEntryStatus;
  transaction?: string;
  submitAttempts: number;
  submittedTime?: number;
  actualTransaction?: string;
  revertReason?: string;
  includer?: `0x${string}`;
  maxCost?: bigint;
}

/** Hex-encoded (DB-storable) form of a `FrameTransaction`. */
export interface FrameTransactionSerialized {
  chainId: string;
  nonceKeys: string[];
  nonceSeq: string;
  sender: `0x${string}`;
  frames: {
    mode: number;
    flags: number;
    target: `0x${string}` | null;
    limits: { execution: string; state: string };
    value: string;
    data: `0x${string}`;
  }[];
  signatures: FrameTransaction["signatures"];
  fees: { maxPriorityFeePerGas: string; maxFeePerGas: string; maxFeePerBlobGas: string };
  blobVersionedHashes: `0x${string}`[];
  recentRootReferences: {
    sourceId: `0x${string}`;
    slot: string;
    root: `0x${string}`;
  }[];
}

export interface FrameTxMempoolEntrySerialized {
  chainId: string;
  tx: FrameTransactionSerialized;
  sender: `0x${string}`;
  payer: `0x${string}`;
  factory: `0x${string}` | undefined;
  txHash: string | undefined;
  hash: string | undefined;
  lastUpdatedTime: number;
  transaction: string | undefined;
  submitAttempts: number;
  status: MempoolEntryStatus;
  submittedTime?: number;
  actualTransaction: string | undefined;
  revertReason: string | undefined;
  includer: `0x${string}` | undefined;
}

export interface IReputationEntry {
  chainId: number;
  address: string;
  opsSeen: number;
  opsIncluded: number;
  lastUpdateTime: number;
}

export type ReputationEntryDump = Omit<
  IReputationEntry,
  "chainId" | "lastUpdateTime"
> & { status: ReputationStatus };

export type ReputationEntrySerialized = Omit<
  IReputationEntry,
  "address" | "chainId"
>;
