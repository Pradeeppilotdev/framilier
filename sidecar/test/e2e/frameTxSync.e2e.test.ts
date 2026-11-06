import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeRawFrameTx } from "@skandha/executor/lib/services/FrameTxService/codec.js";
import {
  ETHREX_RPC,
  NODE_A,
  NODE_B,
  SEED_PRIVATE_KEYS,
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
 * End-to-end proof that `SyncService.requestBatches`
 * (`packages/node/src/sync/sync.ts`) actually ingests transactions into the
 * mempool on peer connect - not just fetches and discards them, which is
 * what it did before this test was written (see the fix's commit for the
 * TODO it closes).
 *
 * ## Why this can only be sync, not gossip
 *
 * A frame transaction reaches a peer's mempool by exactly one of two paths:
 * gossip pubsub (real-time, requires both nodes already peered and
 * subscribed to the topic at publish time - see `frameTx.e2e.test.ts`) or
 * reqresp/sync (peer-connect catch-up: `pooledFrameTxHashes` +
 * `pooledFrameTxsByHash`, triggered by `SyncService` on
 * `NetworkEvent.peerConnected`).
 *
 * This test seeds node A with every transaction BEFORE node B is even
 * spawned. Node B cannot have been gossiped anything it wasn't alive to
 * receive - there is no gossipsub subscriber to publish to yet. So whatever
 * shows up in B's mempool once B connects to A can only have arrived via
 * sync. This is the same principle `frameTx.e2e.test.ts` uses in reverse
 * (both nodes already peered before the transaction exists, to prove
 * gossip).
 *
 * 25 transactions, not thousands: each `eth_sendFrameTransaction` is a real
 * round-trip against a real ethrex process (full trace/simulate), and this
 * is proving "sync ingests a batch, not just one," not exercising the
 * `MAX_OPS_PER_REQUEST` (4096) pagination boundary - that's impractical to
 * seed in CI and would need a dedicated mocked unit test instead, if wanted.
 *
 * One transaction per sender (`SEED_PRIVATE_KEYS`, 25 distinct funded
 * accounts), each at its own nonce 0 - not one sender queuing nonces
 * 0..24. This devnet never mines blocks (see `ethrex-devnet.sh`'s own
 * comment on why `--dev` isn't used), and frame-tx admission simulates
 * against current latest state rather than modeling a pending-nonce queue,
 * so a second transaction from the same sender at nonce 1 is rejected
 * ("Nonce mismatch: expected 0, got 1") forever, not just until the next
 * block - there's no "wait longer" fix available here.
 *
 * ## Running it
 *
 *   ./test/e2e/ethrex-devnet.sh build   # once; slow
 *   bun run build                       # the sidecar's lib/ output is what runs
 *   npx vitest run test/e2e/frameTxSync.e2e.test.ts
 *
 * The devnet itself is started and stopped by this test.
 */

const TX_COUNT = 25;

describe("frame tx e2e: reqresp/sync ingestion on peer connect", () => {
  let tmpDir: string;
  let dirA: string;
  let dirB: string;
  let nodeA: ChildProcess | undefined;
  let nodeB: ChildProcess | undefined;
  let expectedHashes: string[] = [];

  const seedAccounts = SEED_PRIVATE_KEYS.slice(0, TX_COUNT).map((pk) => ({
    privateKey: pk,
    address: privateKeyToAccount(pk).address,
  }));
  const urlA = `http://127.0.0.1:${NODE_A.api}/rpc/`;
  const urlB = `http://127.0.0.1:${NODE_B.api}/rpc/`;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skandha-e2e-sync-"));
    dirA = path.join(tmpDir, "nodeA");
    dirB = path.join(tmpDir, "nodeB");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    // 1. Real ethrex devnet, Hegota active from genesis.
    await startDevnet();

    // 2. Node A, alone - no bootEnrs, and node B does not exist yet.
    nodeA = spawnNode("nodeA", dirA, NODE_A, []);
    await waitFor("node A's RPC", 90_000, async () => {
      const r = await rpc(urlA, "eth_chainId");
      return Number(r.result) === 9;
    });

    // 3. Seed node A with one transaction per seed account, entirely before
    //    node B is spawned - gossip is physically incapable of having
    //    delivered any of these to a node that doesn't exist yet. Each
    //    account is fresh (nonce 0 expected), but fetched rather than
    //    assumed, since that's what `eth_sendFrameTransaction` actually
    //    needs to match against.
    const gasPriceRes = await rpc(ETHREX_RPC, "eth_gasPrice");
    const gasPrice = BigInt(gasPriceRes.result ?? "0x3b9aca00");
    const maxFeePerGas = gasPrice * BigInt(2) + BigInt(1_000_000_000);

    for (let i = 0; i < seedAccounts.length; i++) {
      const { privateKey, address } = seedAccounts[i];
      const nonceRes = await rpc(ETHREX_RPC, "eth_getTransactionCount", [
        address,
        "latest",
      ]);
      const nonce = BigInt(nonceRes.result);

      const tx = await signFrameTx(
        buildUnsignedFrameTx(
          nonce,
          { maxFeePerGas, maxPriorityFeePerGas: BigInt(1_000_000_000) },
          privateKey
        ),
        privateKey
      );
      const expectedHash = keccak256(encodeRawFrameTx(tx));

      const sent = await rpc(urlA, "eth_sendFrameTransaction", [toWire(tx)]);
      if (sent.error) {
        throw new Error(
          `node A rejected seed transaction ${i} (sender ${address}): ${JSON.stringify(sent.error)}\n` +
            `--- node A log ---\n${tailLog(dirA, "nodeA")}`
        );
      }
      expect(String(sent.result).toLowerCase()).toBe(
        expectedHash.toLowerCase()
      );
      expectedHashes.push(sent.result);
    }
    expect(expectedHashes).toHaveLength(TX_COUNT);

    // Sanity: node A actually has all of them locally before B ever shows
    // up - otherwise a later "B has them too" would prove nothing.
    for (const hash of expectedHashes) {
      const onA = await rpc(urlA, "eth_getFrameTransactionByHash", [hash]);
      expect(onA.result, `node A did not store ${hash}`).toBeTruthy();
    }

    // 4. Only now does node B come into existence, dialing node A's
    //    persisted ENR.
    const enrFile = path.join(dirA, "enr");
    await waitFor("node A's ENR file", 30_000, async () =>
      fs.existsSync(enrFile)
    );
    const bootEnr = fs.readFileSync(enrFile, "utf-8").trim();
    nodeB = spawnNode("nodeB", dirB, NODE_B, [bootEnr]);
    await waitFor("node B's RPC", 90_000, async () => {
      const r = await rpc(urlB, "eth_chainId");
      return Number(r.result) === 9;
    });

    // 5. Real libp2p connection - this is what triggers
    //    SyncService.requestBatches on both ends.
    await waitFor("node A and node B to peer", 120_000, async () => {
      const [a, b] = await Promise.all([
        rpc(urlA, "skandha_connectedPeers"),
        rpc(urlB, "skandha_connectedPeers"),
      ]);
      return (
        Array.isArray(a.result) &&
        a.result.length > 0 &&
        Array.isArray(b.result) &&
        b.result.length > 0
      );
    });
  }, 600_000);

  afterAll(async () => {
    nodeA?.kill("SIGKILL");
    nodeB?.kill("SIGKILL");
    stopDevnet();
  }, 120_000);

  it("ingests a peer's pre-existing mempool via sync, not gossip", async () => {
    // The real assertion: every transaction node A had BEFORE node B
    // existed is now in node B's own mempool, reached only by sync.
    await waitFor(
      "every seeded frame transaction to reach node B's mempool via sync",
      180_000,
      async () => {
        for (const hash of expectedHashes) {
          const onB = await rpc(urlB, "eth_getFrameTransactionByHash", [hash]);
          if (onB.result == null) return false;
        }
        return true;
      }
    ).catch((err) => {
      throw new Error(
        `${err.message}\n--- node A log ---\n${tailLog(dirA, "nodeA")}\n` +
          `--- node B log ---\n${tailLog(dirB, "nodeB")}`
      );
    });

    // Spot-check field-level correctness on a sample, not just presence.
    const sample = await rpc(urlB, "eth_getFrameTransactionByHash", [
      expectedHashes[0],
    ]);
    expect(String(sample.result.sender).toLowerCase()).toBe(
      seedAccounts[0].address.toLowerCase()
    );
  }, 300_000);
});
