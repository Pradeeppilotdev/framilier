export const FRAME_MODE = {
  DEFAULT: 0,
  VERIFY: 1,
  SENDER: 2,
} as const;
export type FrameMode = (typeof FRAME_MODE)[keyof typeof FRAME_MODE];

export const APPROVE_SCOPE = {
  NONE: 0x0,
  PAYMENT: 0x1,
  EXECUTION: 0x2,
  EXECUTION_AND_PAYMENT: 0x3,
} as const;
export type ApproveScope = (typeof APPROVE_SCOPE)[keyof typeof APPROVE_SCOPE];

export const ATOMIC_BATCH_FLAG = 0x4;

export interface FrameLimits {
  execution: bigint;
  state: bigint;
}

export interface Frame {
  mode: FrameMode;
  /** bits 0-1: approval scope (see APPROVE_SCOPE); bit 2: ATOMIC_BATCH_FLAG */
  flags: number;
  target: `0x${string}` | null;
  limits: FrameLimits;
  value: bigint;
  data: `0x${string}`;
}

export const SIG_SCHEME = {
  ARBITRARY: 0x0,
  SECP256K1: 0x1,
  P256: 0x2,
} as const;
export type SigScheme = (typeof SIG_SCHEME)[keyof typeof SIG_SCHEME];

export interface SignatureEntry {
  scheme: SigScheme;
  /** empty for ARBITRARY; 20-byte address for SECP256K1/P256 */
  signer: `0x${string}` | "0x";
  /** empty (canonical sig hash) or an explicit 32-byte digest */
  msg: `0x${string}` | "0x";
  signature: `0x${string}`;
}

export interface FeeParams {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  maxFeePerBlobGas: bigint;
}

/**
 * EIP-8272 recent-root reference: a declared `(source_id, slot, root)` tuple.
 * Valid iff `1 <= head_slot - slot <= RECENT_ROOT_USABLE_WINDOW` and the entry
 * is committed in the `RECENT_ROOT_ADDRESS` predeploy, where a contract writes
 * it under `source_id = keccak256(caller ‖ salt)`. `root` is opaque to consensus.
 */
export interface RecentRootReference {
  sourceId: `0x${string}`;
  /** beacon slot (EIP-7843), `< 2**64` */
  slot: bigint;
  root: `0x${string}`;
}

export interface FrameTransaction {
  chainId: bigint;
  /**
   * EIP-8250 keyed nonces: 1..16 strictly increasing keys. `[0]` is the
   * sender's linear account nonce; non-zero keys live in the NONCE_MANAGER
   * predeploy. Key 0 is only valid as the sole key.
   */
  nonceKeys: bigint[];
  /** EIP-8250: must equal the current sequence of every key in `nonceKeys`. */
  nonceSeq: bigint;
  sender: `0x${string}`;
  frames: Frame[];
  signatures: SignatureEntry[];
  fees: FeeParams;
  blobVersionedHashes: `0x${string}`[];
  /** EIP-8272: 0..16 declared recent-root references. */
  recentRootReferences: RecentRootReference[];
}

export const MAX_FRAMES = 64;
// EIP-8250 / EIP-8272 static limits, matching ethrex's
// FRAME_TX_MAX_NONCE_KEYS / FRAME_TX_MAX_RECENT_ROOT_REFERENCES.
export const MAX_NONCE_KEYS = 16;
export const MAX_RECENT_ROOT_REFERENCES = 16;
export const MAX_NONCE_SEQ = (BigInt(1) << BigInt(64)) - BigInt(2);
export const NONCE_MANAGER =
  "0x0000000000000000000000000000000000008250" as const;
export const RECENT_ROOT_ADDRESS =
  "0x0000000000000000000000000000000000008272" as const;
export const RECENT_ROOT_USABLE_WINDOW = BigInt(8191);

/**
 * EIP-8272 slot window, checked the way ethrex's mempool does at head: a
 * transaction lands at the earliest in slot `headSlot + 1`, and a reference
 * is usable there iff `1 <= headSlot + 1 - slot <= RECENT_ROOT_USABLE_WINDOW`.
 * Returns the first violation, or `null`. Whether the root is actually
 * committed is left to the execution client's simulation.
 */
export function recentRootWindowViolation(
  refs: readonly RecentRootReference[],
  headSlot: bigint
): string | null {
  const nextSlot = headSlot + BigInt(1);
  for (const { slot } of refs) {
    const head = `(head slot ${headSlot})`;
    if (slot > headSlot) {
      const from = slot + BigInt(1);
      return `recent-root reference slot ${slot} is not referenceable before slot ${from} ${head}`;
    }
    if (nextSlot - slot > RECENT_ROOT_USABLE_WINDOW) {
      const last = slot + RECENT_ROOT_USABLE_WINDOW;
      return `recent-root reference slot ${slot} expired: usable through slot ${last} ${head}`;
    }
  }
  return null;
}

/**
 * Whether the tx uses EIP-8250 keyed nonces rather than the linear `[0]`
 * domain. Static validity guarantees key 0 only ever appears alone.
 */
export function isKeyedNonce(tx: Pick<FrameTransaction, "nonceKeys">): boolean {
  return !(tx.nonceKeys.length === 1 && tx.nonceKeys[0] === BigInt(0));
}

/**
 * EIP-8250/8272 static validity rules (consensus, not mempool policy): the
 * same checks ethrex's `validate_static_constraints` applies. Returns the first
 * violation, or `null` when the fields are well-formed.
 */
export function frameTxNonceAndRootsViolation(
  tx: Pick<FrameTransaction, "nonceKeys" | "nonceSeq" | "recentRootReferences">
): string | null {
  const keys = tx.nonceKeys;
  if (keys.length === 0 || keys.length > MAX_NONCE_KEYS) {
    return `nonceKeys count must be between 1 and ${MAX_NONCE_KEYS}`;
  }
  const maxU256 = (BigInt(1) << BigInt(256)) - BigInt(1);
  if (keys.some((k) => k < BigInt(0) || k > maxU256)) {
    return "nonceKeys must be uint256 values";
  }
  for (let i = 1; i < keys.length; i++) {
    if (keys[i - 1] >= keys[i]) return "nonceKeys must be strictly increasing";
  }
  if (keys.length > 1 && keys[0] === BigInt(0)) {
    return "nonce key 0 is only valid as the sole nonce key";
  }
  if (tx.nonceSeq < BigInt(0) || tx.nonceSeq > MAX_NONCE_SEQ) {
    return "nonceSeq must be < 2**64 - 1";
  }
  if (tx.recentRootReferences.length > MAX_RECENT_ROOT_REFERENCES) {
    return `recentRootReferences count must be <= ${MAX_RECENT_ROOT_REFERENCES}`;
  }
  const maxU64 = (BigInt(1) << BigInt(64)) - BigInt(1);
  for (const ref of tx.recentRootReferences) {
    if (ref.slot < BigInt(0) || ref.slot > maxU64) {
      return "recentRootReferences slot must be < 2**64";
    }
  }
  return null;
}
export const FRAME_TX_TYPE = 0x06;
// Matches ethrex's frame_tx_entry_point() (crates/common/types/
// transaction.rs, eip8141-tracer branch): address(0xaa), used as the
// caller/`from` for DEFAULT/VERIFY-mode frames' root scope. Not a
// placeholder.
export const ENTRY_POINT = "0x00000000000000000000000000000000000000aa" as const;
export const EXPIRY_VERIFIER = "0x0000000000000000000000000000000000008141" as const; // placeholder — verify exact EIP-8141 §Constants value at implementation time
