import {
  FrameTransaction,
  isKeyedNonce,
} from "@skandha/types/lib/contracts/FrameTx.js";
import { toHex } from "viem";
import { IFrameTxMempoolEntry } from "../../entities/interfaces.js";
import { FrameTxMempoolEntry as MempoolEntry } from "../../entities/FrameTxMempoolEntry.js";

/**
 * Reconstructs a `FrameTxMempoolEntry` from its raw DB-stored shape (a
 * spread of the entry's own public fields - see
 * `MempoolService.addFrameTx`/`.update`). `FrameTxMempoolEntry`'s
 * constructor takes `(tx, options)`, not a single flat object - see its own
 * class doc comment.
 */
export function rawEntryToMempoolEntry(raw: IFrameTxMempoolEntry): MempoolEntry {
  return new MempoolEntry(migrateLegacyTx(raw.tx), {
    txHash: raw.txHash,
    hash: raw.hash,
    lastUpdatedTime: raw.lastUpdatedTime,
    status: raw.status,
    transaction: raw.transaction,
    submitAttempts: raw.submitAttempts,
    submittedTime: raw.submittedTime,
    actualTransaction: raw.actualTransaction,
    revertReason: raw.revertReason,
    includer: raw.includer,
    maxCost: raw.maxCost,
  });
}

/**
 * Entries persisted before EIP-8250/8272 support carry a scalar `nonce` and
 * no `recentRootReferences`. That scalar was always the linear key-0 domain,
 * so it maps to `nonceKeys: [0], nonceSeq: nonce`.
 */
function migrateLegacyTx(tx: FrameTransaction): FrameTransaction {
  const legacy = tx as FrameTransaction & { nonce?: bigint };
  if (
    legacy.nonceKeys !== undefined &&
    legacy.recentRootReferences !== undefined
  ) {
    return tx;
  }
  const { nonce, ...rest } = legacy;
  return {
    ...rest,
    nonceKeys: rest.nonceKeys ?? [BigInt(0)],
    nonceSeq: rest.nonceSeq ?? nonce ?? BigInt(0),
    recentRootReferences: rest.recentRootReferences ?? [],
  };
}

/**
 * The mempool slot a transaction occupies; a transaction in the same slot is
 * a candidate replacement (fee bump). Linear (`[0]`) txs keep the original
 * `chainId:sender:nonce` shape, so entries stored before EIP-8250 support
 * still resolve. Keyed txs are slotted by their exact key set and sequence;
 * overlapping key sets are caught separately (`MempoolService`'s nonce-key
 * conflict check), since they live in different slots.
 */
export function frameTxSlotKey(
  chainId: number | bigint,
  tx: Pick<FrameTransaction, "sender" | "nonceKeys" | "nonceSeq">
): string {
  const sender = tx.sender.toLowerCase();
  if (!isKeyedNonce(tx)) return `${chainId}:${sender}:${tx.nonceSeq}`;
  const keys = tx.nonceKeys.map((k) => toHex(k)).join(",");
  return `${chainId}:${sender}:k[${keys}]:${tx.nonceSeq}`;
}
