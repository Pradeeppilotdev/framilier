import { type Hex, concat, encodePacked, keccak256, pad, toHex } from "viem";

/**
 * A minimal shared-sender "privacy pool" stand-in for the EIP-8250/8272 e2e
 * test: the pool contract is the sender (and payer) of every withdrawal, the
 * nullifier is the withdrawal's nonce key, and the Merkle root is an EIP-8272
 * recent root the pool itself published. No ZK - the point is the mempool
 * and protocol mechanics, not the proof.
 *
 * Runtime behaviour, by caller:
 *
 * - ENTRY_POINT (`0xaa`, i.e. a VERIFY frame): approve execution and payment
 *   (`APPROVE` scope 3, Self Relay) iff
 *     - `nonce_keys[0]` (`TXPARAM 0x10`) is non-zero - a withdrawal must use a
 *       nullifier-derived key, never the linear domain; and
 *     - reference 0's `source_id` (`RECENTROOTREFLOAD 0, 0`) is this pool's own
 *       namespace, `keccak256(address(this) ‖ bytes32(0))` - a withdrawal can
 *       only prove against roots this pool published.
 *   Reads no storage, so concurrent withdrawals cannot invalidate each other;
 *   a reused nullifier fails the protocol's nonce check instead.
 * - anyone else (a "deposit"): publish `calldata[0:32]` as a recent root by
 *   calling `RECENT_ROOT_ADDRESS` with `salt (0) ‖ root`. Any value sent stays
 *   in the pool and backs later withdrawals.
 *
 * Withdrawals themselves are a SENDER frame: its `value` is debited from the
 * pool (EIP-8141 debits frame value from `tx.sender`).
 */

type Op = string | number | { label: string } | { push: string };

const OPS: Record<string, number> = {
  STOP: 0x00, EQ: 0x14, ISZERO: 0x15, SHL: 0x1b, SHA3: 0x20, ADDRESS: 0x30,
  CALLER: 0x33, CALLDATALOAD: 0x35, CODECOPY: 0x39, MSTORE: 0x52, JUMPI: 0x57,
  GAS: 0x5a, JUMPDEST: 0x5b, CALL: 0xf1, RETURN: 0xf3, REVERT: 0xfd, DUP1: 0x80,
  APPROVE: 0xaa, TXPARAM: 0xb0, RECENTROOTREFLOAD: 0xb6,
};

/** Two-pass assembler: `{ label }` marks a JUMPDEST, `{ push: label }` pushes its offset (PUSH1). */
function assemble(program: Op[]): Hex {
  const offsets = new Map<string, number>();
  const encode = (resolve: boolean): number[] => {
    const out: number[] = [];
    for (const op of program) {
      if (typeof op === "number") {
        if (op > 0xff) throw new Error("PUSH1 only");
        out.push(0x60, op);
      } else if (typeof op === "string") {
        if (op === "PUSH2_8272") out.push(0x61, 0x82, 0x72);
        else if (OPS[op] === undefined) throw new Error(`unknown op ${op}`);
        else out.push(OPS[op]);
      } else if ("label" in op) {
        offsets.set(op.label, out.length);
        out.push(OPS.JUMPDEST);
      } else {
        const target = resolve ? offsets.get(op.push) : 0;
        if (target === undefined) throw new Error(`unknown label ${op.push}`);
        out.push(0x60, target);
      }
    }
    return out;
  };
  encode(false);
  return toHex(new Uint8Array(encode(true)));
}

const RUNTIME = assemble([
  // VERIFY frames are called by ENTRY_POINT (0xaa)
  "CALLER", 0xaa, "EQ", { push: "verify" }, "JUMPI",

  // deposit: mem[0:32] = salt 0 (fresh memory), mem[32:64] = root
  0, "CALLDATALOAD", 0x20, "MSTORE",
  // CALL(gas, 0x8272, value 0, in 0, insize 64, out 0, outsize 0)
  0, 0, 0x40, 0, 0, "PUSH2_8272", "GAS", "CALL",
  "ISZERO", { push: "fail" }, "JUMPI",
  "STOP",

  { label: "verify" },
  // nonce_keys[0] != 0
  0x10, "TXPARAM", "ISZERO", { push: "fail" }, "JUMPI",
  // keccak256(address(this) ‖ bytes32(0)): mem[0:20] = address, mem[20:52] = 0
  "ADDRESS", 0x60, "SHL", 0, "MSTORE", 0x34, 0, "SHA3",
  // RECENTROOTREFLOAD(index 0, field 0 = source_id)
  0, 0, "RECENTROOTREFLOAD",
  "EQ", "ISZERO", { push: "fail" }, "JUMPI",
  // APPROVE(offset 0, length 0, scope 3 = execution and payment)
  3, 0, 0, "APPROVE",

  { label: "fail" },
  0, "DUP1", "REVERT",
]);

/** Init code: copy RUNTIME to memory and return it. */
export const SHARED_SENDER_POOL_INIT_CODE: Hex = (() => {
  const size = (RUNTIME.length - 2) / 2;
  if (size > 0xff) throw new Error("runtime too large for PUSH1 sizes");
  const prologueSize = 12; // PUSH1 size, PUSH1 offset, PUSH1 0, CODECOPY, PUSH1 size, PUSH1 0, RETURN
  const prologue = toHex(
    new Uint8Array([0x60, size, 0x60, prologueSize, 0x60, 0x00, 0x39, 0x60, size, 0x60, 0x00, 0xf3])
  );
  return concat([prologue, RUNTIME]);
})();

export const POOL_RUNTIME: Hex = RUNTIME;
export const NONCE_MANAGER = "0x0000000000000000000000000000000000008250" as const;
export const RECENT_ROOT_ADDRESS = "0x0000000000000000000000000000000000008272" as const;
const RECENT_ROOT_LENGTH = 8192n;

/** EIP-8272 `source_id = keccak256(address ‖ salt)`, 20-byte address unpadded. */
export function recentRootSourceId(address: Hex, salt: Hex = pad("0x0")): Hex {
  return keccak256(encodePacked(["address", "bytes32"], [address, salt]));
}

/** EIP-8272 entry hash committed in `RECENT_ROOT_ADDRESS` storage. */
export function recentRootEntryHash(sourceId: Hex, slot: bigint, root: Hex): Hex {
  return keccak256(
    encodePacked(
      ["bytes32", "bytes32", "uint64", "bytes32"],
      [keccak256(toHex("RECENT_ROOT_ENTRY")), sourceId, slot, root]
    )
  );
}

/** EIP-8272 storage key of `(sourceId, slot)` in `RECENT_ROOT_ADDRESS`. */
export function recentRootStorageKey(sourceId: Hex, slot: bigint): Hex {
  return keccak256(
    encodePacked(
      ["bytes32", "bytes32", "uint64"],
      [keccak256(toHex("RECENT_ROOT_STORAGE")), sourceId, slot % RECENT_ROOT_LENGTH]
    )
  );
}

/** EIP-8250 NONCE_MANAGER slot holding `(sender, key)`'s sequence. */
export function nonceManagerSlot(sender: Hex, key: bigint): Hex {
  return keccak256(concat([pad(sender), pad(toHex(key))]));
}
