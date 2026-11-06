import { getAddress, toHex } from "viem";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import { now } from "../utils/index.js";
import { recognizeValidationPrefix } from "../services/UserOpValidation/utils/validationPrefix.js";
import {
  IFrameTxMempoolEntry,
  FrameTxMempoolEntrySerialized,
} from "./interfaces.js";

export interface FrameTxMempoolEntryOptions {
  /** keccak256 of all contracts referenced by the validation prefix */
  hash?: string;
  /** the transaction's own hash, used as the mempool lookup key */
  txHash?: string;
  lastUpdatedTime?: number;
  status?: MempoolEntryStatus;
  transaction?: string;
  submitAttempts?: number;
  submittedTime?: number;
  actualTransaction?: string;
  revertReason?: string;
  includer?: `0x${string}`;
  /** ethrex's maximum cost for this tx (wei), from admission-time simulation */
  maxCost?: bigint;
}

/**
 * Mempool entry wrapping an EIP-8141 `FrameTransaction`. Replaces the
 * ERC-4337 `MempoolEntry`'s `sender`/`factory`/`paymaster`/`aggregator`
 * fields with `sender`/`payer`/`factory`, derived from the transaction's
 * recognized validation prefix (`recognizeValidationPrefix`):
 *
 * - `sender` is always `tx.sender` (the transaction's own top-level field —
 *   never derived from a prefix role, since a `sender`-role frame, when
 *   present, is structurally required to target `tx.sender` anyway).
 * - `payer` is the address resolved from the prefix's `payer`-role frame's
 *   `target` (or `tx.sender` if that frame's target is null, i.e. self-pay —
 *   this is always the case for the `self_verify` shape).
 * - `factory` is the address resolved from the prefix's `factory`-role
 *   (`deploy`) frame's `target`, when a deploy frame is present; otherwise
 *   undefined. There is no `aggregator` concept for a frame transaction.
 */
export class FrameTxMempoolEntry implements IFrameTxMempoolEntry {
  chainId: bigint;
  tx: FrameTransaction;
  sender: `0x${string}`;
  payer: `0x${string}`;
  factory?: `0x${string}`;
  txHash?: string;
  lastUpdatedTime: number;
  status: MempoolEntryStatus;
  hash?: string; // keccak256 of all referenced contracts
  submitAttempts: number;
  submittedTime?: number; // timestamp when entry was first put into the mempool
  transaction?: string; // transaction hash of a submitted bundle
  actualTransaction?: string; // hash of an actual transaction (in case the original tx was front-runned)
  revertReason?: string;
  includer?: `0x${string}`;
  maxCost?: bigint;

  constructor(tx: FrameTransaction, options: FrameTxMempoolEntryOptions = {}) {
    this.tx = tx;
    this.chainId = tx.chainId;
    this.txHash = options.txHash;
    this.hash = options.hash;
    this.lastUpdatedTime = options.lastUpdatedTime ?? now();
    this.submittedTime = options.submittedTime;
    this.status = options.status ?? MempoolEntryStatus.New;
    this.transaction = options.transaction;
    this.submitAttempts = options.submitAttempts ?? 0;
    this.actualTransaction = options.actualTransaction;
    this.revertReason = options.revertReason;
    this.includer = options.includer;
    this.maxCost = options.maxCost;

    this.validateAndNormalizeTx();

    const { sender, payer, factory } = FrameTxMempoolEntry.resolveRoles(this.tx);
    this.sender = sender;
    this.payer = payer;
    this.factory = factory;
  }

  /**
   * Resolves `sender`/`payer`/`factory` from `tx`'s recognized validation
   * prefix. See the class doc comment for the derivation rules.
   */
  private static resolveRoles(
    tx: FrameTransaction
  ): { sender: `0x${string}`; payer: `0x${string}`; factory?: `0x${string}` } {
    const sender = tx.sender;
    let payer: `0x${string}` = tx.sender;
    let factory: `0x${string}` | undefined;

    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
    if (prefix) {
      for (const { frame, role } of prefix.frames) {
        if (role === "sender") continue; // always tx.sender, see class doc comment
        const target = getAddress(frame.target ?? tx.sender) as `0x${string}`;
        if (role === "payer") payer = target;
        if (role === "factory") factory = target;
      }
    }

    return { sender, payer, factory };
  }

  /**
   * Set status of an entry.
   * If status is Pending/Submitted, a transaction hash is required.
   */
  setStatus(
    status: MempoolEntryStatus,
    params?: {
      transaction?: string;
      revertReason?: string;
      includer?: `0x${string}`;
    }
  ): void {
    this.status = status;
    this.lastUpdatedTime = now();
    switch (status) {
      case MempoolEntryStatus.New: {
        // Clears a stale broadcast hash from a previous submission attempt -
        // relevant when `MempoolReconciler` requeues a `Submitted` entry
        // whose privileged-endpoint submission missed its one-shot inclusion
        // window (see that class's doc comment). A `New` entry has nothing
        // in flight, so it should not still report an old `transaction`.
        this.transaction = undefined;
        this.revertReason = undefined;
        break;
      }
      case MempoolEntryStatus.Pending: {
        this.transaction = params?.transaction;
        break;
      }
      case MempoolEntryStatus.Submitted: {
        this.transaction = params?.transaction;
        break;
      }
      case MempoolEntryStatus.OnChain: {
        this.actualTransaction = params?.transaction;
        this.includer = params?.includer;
        break;
      }
      case MempoolEntryStatus.Reverted: {
        // A reverted-but-mined transaction still has a receipt and an
        // includer - see the explorer-activity-outcomes design spec.
        this.revertReason = params?.revertReason;
        this.includer = params?.includer;
        break;
      }
      case MempoolEntryStatus.Cancelled: {
        // Explains why the bundler gave up - there is no includer to set
        // here, since the entry never landed (from this bundler's own
        // submissions - the watch list covers a different builder including
        // it anyway).
        this.revertReason = params?.revertReason;
        break;
      }
      default: {
        // nothing
      }
    }
  }

  /**
   * To replace an entry, a new entry must have at least 10% higher
   * maxPriorityFeePerGas and 10% higher maxFeePerGas than the existingEntry.
   * Returns true if this entry can replace existingEntry.
   */
  canReplace(existingEntry: FrameTxMempoolEntry): boolean {
    if (existingEntry.status > MempoolEntryStatus.OnChain) return true;
    if (!this.isEqual(existingEntry)) return false;
    if (
      this.tx.fees.maxPriorityFeePerGas <
      (existingEntry.tx.fees.maxPriorityFeePerGas * BigInt(11)) / BigInt(10)
    ) {
      return false;
    }
    if (
      this.tx.fees.maxFeePerGas <
      (existingEntry.tx.fees.maxFeePerGas * BigInt(11)) / BigInt(10)
    ) {
      return false;
    }
    return true;
  }

  /**
   * Same as `canReplace`, except an entry may also be replaced unconditionally
   * once `ttl` seconds have elapsed since the existing entry was last updated.
   */
  canReplaceWithTTL(existingEntry: FrameTxMempoolEntry, ttl: number): boolean {
    if (this.lastUpdatedTime - existingEntry.lastUpdatedTime > ttl * 1000) {
      return true;
    }
    return this.canReplace(existingEntry);
  }

  isEqual(entry: FrameTxMempoolEntry): boolean {
    return (
      entry.chainId === this.chainId &&
      entry.tx.nonceSeq === this.tx.nonceSeq &&
      sameNonceKeys(entry.tx.nonceKeys, this.tx.nonceKeys) &&
      entry.tx.sender === this.tx.sender
    );
  }

  // sorts by cost in descending order
  static compareByCost(a: FrameTxMempoolEntry, b: FrameTxMempoolEntry): number {
    return Number(b.tx.fees.maxPriorityFeePerGas - a.tx.fees.maxPriorityFeePerGas);
  }

  static groupBySender(entries: FrameTxMempoolEntry[]): FrameTxMempoolEntry[] {
    const grouped = entries.reduce((acc, entry) => {
      (acc[entry.tx.sender] ||= []).push(entry);
      return acc;
    }, {} as Record<string, FrameTxMempoolEntry[]>);

    return Object.values(grouped).flat();
  }

  validateAndNormalizeTx(): void {
    try {
      this.tx = {
        ...this.tx,
        sender: getAddress(this.tx.sender) as `0x${string}`,
        frames: this.tx.frames.map((frame) => ({
          ...frame,
          target: frame.target != null ? (getAddress(frame.target) as `0x${string}`) : null,
        })),
      };
    } catch (err) {
      throw new RpcError("Invalid FrameTransaction", RpcErrorCodes.INVALID_USEROP, err);
    }
  }

  serialize(): FrameTxMempoolEntrySerialized {
    return {
      chainId: toHex(this.chainId),
      tx: {
        chainId: toHex(this.tx.chainId),
        nonceKeys: this.tx.nonceKeys.map((k) => toHex(k)),
        nonceSeq: toHex(this.tx.nonceSeq),
        sender: getAddress(this.tx.sender) as `0x${string}`,
        frames: this.tx.frames.map((frame) => ({
          mode: frame.mode,
          flags: frame.flags,
          target: frame.target,
          limits: {
            execution: toHex(frame.limits.execution),
            state: toHex(frame.limits.state),
          },
          value: toHex(frame.value),
          data: frame.data,
        })),
        signatures: this.tx.signatures,
        fees: {
          maxPriorityFeePerGas: toHex(this.tx.fees.maxPriorityFeePerGas),
          maxFeePerGas: toHex(this.tx.fees.maxFeePerGas),
          maxFeePerBlobGas: toHex(this.tx.fees.maxFeePerBlobGas),
        },
        blobVersionedHashes: this.tx.blobVersionedHashes,
        recentRootReferences: this.tx.recentRootReferences.map((ref) => ({
          sourceId: ref.sourceId,
          slot: toHex(ref.slot),
          root: ref.root,
        })),
      },
      sender: this.sender,
      payer: this.payer,
      factory: this.factory,
      txHash: this.txHash,
      hash: this.hash,
      lastUpdatedTime: this.lastUpdatedTime,
      transaction: this.transaction,
      submitAttempts: this.submitAttempts,
      status: this.status,
      submittedTime: this.submittedTime,
      actualTransaction: this.actualTransaction,
      revertReason: this.revertReason,
      includer: this.includer,
    };
  }
}

/** EIP-8250: whether two nonce-key sets are identical (both are sorted). */
export function sameNonceKeys(
  a: readonly bigint[],
  b: readonly bigint[]
): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
