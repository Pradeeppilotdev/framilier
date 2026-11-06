import { getAddress } from "viem";
import { FrameTxMempoolEntry as MempoolEntry } from "../../entities/FrameTxMempoolEntry.js";
import { estimateMaxCost } from "../UserOpValidation/validators/frameTx.js";

/**
 * What a pending frame transaction can take out of each account, in wei:
 *
 * - its payer: the transaction's maximum gas cost, which EIP-8141 escrows in
 *   full at payment approval (unused gas is refunded afterwards). ethrex's
 *   own figure from simulation when the entry recorded it, else the local,
 *   lower `estimateMaxCost` (frame gas limits only);
 * - its sender: the `value` of every top-level frame, which EIP-8141 debits
 *   from `tx.sender`. Value moved by nested calls is not visible statically.
 *
 * For self-pay (Self Relay) both land on the same account and add up.
 */
export function frameTxObligations(entry: MempoolEntry): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const owe = (address: string, amount: bigint): void => {
    if (amount <= BigInt(0)) return;
    const key = getAddress(address);
    out.set(key, (out.get(key) ?? BigInt(0)) + amount);
  };
  owe(
    entry.payer ?? entry.tx.sender,
    entry.maxCost ?? estimateMaxCost(entry.tx)
  );
  owe(
    entry.tx.sender,
    entry.tx.frames.reduce((sum, frame) => sum + frame.value, BigInt(0))
  );
  return out;
}

/** Per-account totals of `frameTxObligations` over `entries`. */
export function totalObligations(entries: MempoolEntry[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const entry of entries) {
    for (const [address, amount] of frameTxObligations(entry)) {
      totals.set(address, (totals.get(address) ?? BigInt(0)) + amount);
    }
  }
  return totals;
}
