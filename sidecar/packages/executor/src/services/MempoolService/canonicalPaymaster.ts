import { Hex, keccak256 } from "viem";

/** Runtime bytecode hash of the canonical paymaster implementation this
 * mempool trusts. Implementer note: this must be pinned to a specific,
 * audited deployment's runtime code — do not leave it as a placeholder
 * hash in any commit that reaches a shared branch; obtain the real value
 * from the canonical paymaster reference implementation once published
 * alongside EIP-8141, and treat a mismatch here as "not canonical" (the
 * non-canonical, MAX_PENDING_TXS_USING_NON_CANONICAL_PAYMASTER-capped
 * path), never as an error. */
const CANONICAL_PAYMASTER_CODE_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

export function isCanonicalPaymaster(runtimeCode: Hex): boolean {
  return keccak256(runtimeCode) === CANONICAL_PAYMASTER_CODE_HASH;
}

export class CanonicalPaymasterReservationTracker {
  private reservedPendingCost = new Map<Hex, bigint>();

  reserve(paymaster: Hex, maxCost: bigint): void {
    const current = this.reservedPendingCost.get(paymaster) ?? BigInt(0);
    this.reservedPendingCost.set(paymaster, current + maxCost);
  }

  release(paymaster: Hex, maxCost: bigint): void {
    const current = this.reservedPendingCost.get(paymaster) ?? BigInt(0);
    const next = current - maxCost;
    this.reservedPendingCost.set(paymaster, next < BigInt(0) ? BigInt(0) : next);
  }

  /** Per EIP-8141 §Canonical paymaster:
   * available_paymaster_balance = balance - reserved_pending_cost - pending_withdrawal_amount
   * pending_withdrawal_amount is omitted here (0n) — wire it once the
   * canonical paymaster's delayed-withdrawal read path is implemented in
   * the simulation service. */
  availableBalance(paymaster: Hex, currentBalance: bigint, pendingWithdrawalAmount: bigint = BigInt(0)): bigint {
    const reserved = this.reservedPendingCost.get(paymaster) ?? BigInt(0);
    const available = currentBalance - reserved - pendingWithdrawalAmount;
    return available < BigInt(0) ? BigInt(0) : available;
  }
}
