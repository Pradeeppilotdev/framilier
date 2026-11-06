import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { Hex, getAddress } from "viem";
import { signatureVerificationCost, ValidationPrefixMatch, recognizeValidationPrefix } from "./validationPrefix.js";

// ERC-8421 PR #2028, revision 493ba8ac3be97dc5cf6335eb97d2e8e9f95983c5.
export const MAX_VERIFY_GAS_PER_ENTITY = BigInt(100_000);
export const MAX_VERIFY_GAS_STAKED_ENTITY = BigInt(1_000_000);
// The draft attributes protocol-defined expiry verification to no entity.
// Keep a separate conservative local bound; never let it escape accounting.
export const MAX_EXPIRY_VERIFY_GAS = BigInt(100_000);

export interface EntityValidationBudget {
  address: Hex;
  roles: Array<"sender" | "payer" | "factory">;
  frameIndices: number[];
  executionGas: bigint;
  signatureGas: bigint;
  totalGas: bigint;
}

export function entityAddress(address: Hex): Hex {
  return getAddress(address).toLowerCase() as Hex;
}

/** Declared limits, not measured usage. Each address gets one budget across roles. */
export function collectValidationBudgets(tx: FrameTransaction, prefix: ValidationPrefixMatch): {
  entities: EntityValidationBudget[];
  expiryGas: bigint;
} {
  const byAddress = new Map<Hex, EntityValidationBudget>();
  function entity(address: Hex, role: "sender" | "payer" | "factory"): EntityValidationBudget {
    const key = entityAddress(address);
    let entry = byAddress.get(key);
    if (!entry) {
      entry = { address: key, roles: [], frameIndices: [], executionGas: BigInt(0), signatureGas: BigInt(0), totalGas: BigInt(0) };
      byAddress.set(key, entry);
    }
    if (!entry.roles.includes(role)) entry.roles.push(role);
    return entry;
  }
  const sender = entity(tx.sender, "sender");
  sender.signatureGas = signatureVerificationCost(tx);
  sender.totalGas = sender.signatureGas;
  const assigned = new Set<number>();
  for (const { frameIndex, role } of prefix.frames) {
    if (assigned.has(frameIndex)) throw new Error(`Duplicate prefix frame ${frameIndex}`);
    assigned.add(frameIndex);
    const frame = tx.frames[frameIndex];
    if (!frame || frame.limits.execution < BigInt(0) || frame.limits.state < BigInt(0)) {
      throw new Error(`Invalid limits for prefix frame ${frameIndex}`);
    }
    // recognizeValidationPrefix already assigns pre_verify to its approving role.
    const address = role === "sender" ? tx.sender : frame.target ?? tx.sender;
    const entry = entity(address, role);
    entry.frameIndices.push(frameIndex);
    entry.executionGas += frame.limits.execution;
    entry.totalGas += frame.limits.execution;
  }
  let expiryGas = BigInt(0);
  for (let index = 0; index <= prefix.payerFrameIndex; index++) {
    if (assigned.has(index)) continue;
    const frame = tx.frames[index];
    if (index !== 0 || frame.mode !== FRAME_MODE.VERIFY || frame.flags !== APPROVE_SCOPE.NONE ||
        frame.limits.execution < BigInt(0) || frame.limits.state < BigInt(0)) {
      throw new Error(`Unattributed validation frame ${index}`);
    }
    expiryGas += frame.limits.execution;
  }
  return { entities: [...byAddress.values()], expiryGas };
}

export function budgetDetail(entry: EntityValidationBudget, limit: bigint): string {
  return `entity ${entry.address} (${entry.roles.join("+")}), frames [${entry.frameIndices.join(",")}]: ` +
    `${entry.executionGas} execution + ${entry.signatureGas} signature = ${entry.totalGas}; limit ${limit}`;
}

/**
 * framilier PR 1: default threshold for classifying a frame transaction
 * as a heavy admission job.
 * Total declared VERIFY budget > 100,000 is heavy.
 */
export const DEFAULT_HEAVY_VERIFY_GAS_THRESHOLD = BigInt(100_000);

/**
 * Calculates the total declared verification gas for a frame transaction.
 *
 * Reuses pure prefix/budget helpers to count each entity's declared budget
 * once, including signature cost, plus the separate expiry budget.
 *
 * Keep classification free of RPC calls. Malformed inputs retain the ordinary
 * validation error downstream by returning 0n here.
 */
export function calculateDeclaredVerifyGas(tx: FrameTransaction): bigint {
  if (!tx || !Array.isArray(tx.frames) || !tx.sender) {
    return BigInt(0);
  }

  try {
    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
    if (!prefix) {
      return BigInt(0);
    }

    const { entities, expiryGas } = collectValidationBudgets(tx, prefix);
    let total = expiryGas;
    for (const entity of entities) {
      total += entity.totalGas;
    }
    return total;
  } catch {
    return BigInt(0);
  }
}

/**
 * Inexpensive hint indicating whether a frame transaction is heavy.
 * A transaction is heavy if its total declared VERIFY budget strictly exceeds
 * the threshold (default 100,000).
 */
export function isHeavyFrameTx(
  tx: FrameTransaction,
  threshold: bigint | number = DEFAULT_HEAVY_VERIFY_GAS_THRESHOLD
): boolean {
  return calculateDeclaredVerifyGas(tx) > BigInt(threshold);
}
