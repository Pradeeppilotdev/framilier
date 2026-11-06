import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  NODE_A,
  SENDER_PRIVATE_KEY,
  rpc,
  waitFor,
  spawnNode,
  tailLog,
  startDevnet,
  stopDevnet,
  buildUnsignedFrameTx,
  signFrameTx,
  toWire,
} from "./helpers.js";

/**
 * Regression test for a real bug found in PR review:
 * `MempoolReputationChecks.checkMultipleRolesViolation`
 * (packages/executor/src/services/MempoolService/reputation.ts) used to
 * reject a self-relay sender's own SECOND pending transaction.
 *
 * Self Relay is the shape where `payer === sender` (the transaction pays
 * for itself - see `FrameTxMempoolEntry`'s class doc comment; `helpers.ts`'s
 * `buildUnsignedFrameTx` always builds this shape). The violation check's
 * job is to catch one entity acting as a plain "sender" in one mempool
 * entry while ALSO acting as a "payer" for a DIFFERENT entity's entry - a
 * reputation-gaming vector. It didn't exclude the case where `payer` and
 * `sender` are the SAME entry's own fields: a self-relay sender's first
 * pending transaction put that sender's address into both `accounts`
 * (as a sender) and `otherEntities` (as that entry's own payer), so the
 * sender's own second transaction collided with itself and was rejected.
 *
 * ## Why this goes through `debug_bundler_setMempool`, not `eth_sendFrameTransaction`
 *
 * The obvious way to write this test - sign nonce N and nonce N+1 from the
 * same sender and submit both via `eth_sendFrameTransaction` - does not
 * work against this shared e2e devnet, and it's not a sidecar bug: ethrex
 * simulates every submission against CURRENT LATEST STATE, with no
 * pending-nonce queue concept (see `frameTxSync.e2e.test.ts`'s own comment
 * on the same constraint). This devnet never mines a block at all
 * (`ethrex-devnet.sh` deliberately runs without `--dev` - see its own
 * comment on the Hegota/`engine_forkchoiceUpdatedV4` incompatibility), so
 * an account's on-chain nonce never advances past genesis; a real second
 * transaction at nonce N+1 is rejected by ethrex itself
 * ("Nonce mismatch: expected N, got N+1") before the sidecar's own mempool
 * logic - the thing actually under test here - is ever reached.
 *
 * `debug_bundler_setMempool` is the right tool instead: it calls
 * `MempoolService.addFrameTx` directly, for each transaction in order,
 * WITHOUT going through ethrex simulation at all ("persist to the local
 * mempool without simulation" - `Debug.setMempool`'s own comment). Two
 * self-relay transactions from the same sender, submitted together, drive
 * `checkMultipleRolesViolation` through the exact real sequence that
 * used to fail: the second `addFrameTx` call sees the first entry (same
 * sender) already in the mempool. This is still a real, unmocked
 * The sidecar process and a real RPC call - it just sidesteps a devnet
 * limitation that has nothing to do with the bug being tested.
 *
 * ## Running it
 *
 *   ./test/e2e/ethrex-devnet.sh build   # once; slow
 *   bun run build                       # the sidecar's lib/ output is what runs
 *   npx vitest run test/e2e/frameTxSelfRelayMultiTx.e2e.test.ts
 *
 * The devnet itself is started and stopped by this test.
 */

describe("frame tx e2e: self-relay sender with multiple pending transactions", () => {
  let tmpDir: string;
  let dirA: string;
  let nodeA: ChildProcess | undefined;

  const urlA = `http://127.0.0.1:${NODE_A.api}/rpc/`;
  const account = privateKeyToAccount(SENDER_PRIVATE_KEY);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skandha-e2e-selfrelay-"));
    dirA = path.join(tmpDir, "nodeA");
    fs.mkdirSync(dirA, { recursive: true });

    // 1. Real ethrex devnet, Hegota active from genesis.
    await startDevnet();

    // 2. One node, standalone - no peering needed for this bug.
    nodeA = spawnNode("nodeA", dirA, NODE_A, []);
    await waitFor("node A's RPC", 90_000, async () => {
      const r = await rpc(urlA, "eth_chainId");
      return Number(r.result) === 9;
    });
  }, 300_000);

  afterAll(async () => {
    nodeA?.kill("SIGKILL");
    stopDevnet();
  }, 120_000);

  it("admits a self-relay sender's second pending transaction instead of rejecting it as a role collision", async () => {
    const fees = {
      maxFeePerGas: BigInt(2_000_000_000),
      maxPriorityFeePerGas: BigInt(1_000_000_000),
    };

    // Two self-relay transactions (payer === sender) from the SAME sender,
    // different nonces - never actually admitted through real simulation
    // (see header comment), so the nonces don't need to reflect real
    // on-chain state; they only need to be distinct so the two land as
    // separate mempool entries (keyed by sender:nonce).
    const tx0 = await signFrameTx(buildUnsignedFrameTx(0n, fees));
    const tx1 = await signFrameTx(buildUnsignedFrameTx(1n, fees));

    const setResult = await rpc(urlA, "debug_bundler_setMempool", [
      [toWire(tx0), toWire(tx1)],
    ]);
    if (setResult.error) {
      throw new Error(
        `node A rejected the self-relay sender's second pending transaction: ` +
          `${JSON.stringify(setResult.error)}\n--- node A log ---\n${tailLog(dirA, "nodeA")}`
      );
    }
    expect(setResult.result).toBe("ok");

    // Both genuinely made it into the mempool, not just accepted-then-dropped.
    const dump = await rpc(urlA, "debug_bundler_dumpMempoolRaw");
    if (dump.error) {
      throw new Error(
        `could not dump node A's mempool: ${JSON.stringify(dump.error)}\n` +
          `--- node A log ---\n${tailLog(dirA, "nodeA")}`
      );
    }
    const entries = dump.result as Array<{ sender: string; tx: { nonceSeq: string } }>;
    const selfRelayEntries = entries.filter(
      (e) => e.sender.toLowerCase() === account.address.toLowerCase()
    );
    expect(
      selfRelayEntries,
      `expected 2 pending entries for ${account.address}, got: ${JSON.stringify(entries)}`
    ).toHaveLength(2);
    // Explicit numeric comparator: default Array.prototype.sort() on
    // bigints is lexicographic (string) sort, not numeric - it only
    // happens to agree with numeric order for these single-digit values.
    const nonces = selfRelayEntries
      .map((e) => BigInt(e.tx.nonceSeq))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(nonces).toEqual([0n, 1n]);
  }, 180_000);
});
