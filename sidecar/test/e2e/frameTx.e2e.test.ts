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
 * End-to-end proof that a frame transaction submitted over JSON-RPC to one
 * real `skandha node` process reaches a second real `skandha node` process's
 * mempool, by real libp2p gossip pubsub, validated at both ends against a
 * real ethrex execution client.
 *
 * Nothing here is mocked: a real ethrex devnet in EIP-8141 (Hegota) dev mode,
 * two real sidecar node processes speaking real gossipsub over real sockets,
 * and a real secp256k1-signed frame transaction from a genesis-funded account.
 *
 * ## Which propagation path this exercises, and why
 *
 * Gossip pubsub, deliberately: both nodes are already peered on the
 * mempool's gossip topic *before* the transaction is submitted, so a live
 * gossipsub subscriber on node B is what delivers it. Reqresp/sync (the
 * *other* path a transaction can reach a peer by) is deliberately NOT what
 * this test exercises - see `frameTxSync.e2e.test.ts` for that, which
 * seeds node A with transactions before node B even exists, so gossip is
 * physically incapable of being the explanation for what shows up in B's
 * mempool.
 *
 * `eth_getFrameTransactionByHash` against node B reads B's own mempool, so a
 * hit there is proof B ingested the transaction rather than merely
 * observing it.
 *
 * ## Running it
 *
 *   ./test/e2e/ethrex-devnet.sh build   # once; slow
 *   bun run build                       # the sidecar's lib/ output is what runs
 *   npx vitest run test/e2e/frameTx.e2e.test.ts
 *
 * The devnet itself is started and stopped by this test.
 */

describe("frame tx e2e: two-node gossip round trip", () => {
  let tmpDir: string;
  let dirA: string;
  let dirB: string;
  let nodeA: ChildProcess | undefined;
  let nodeB: ChildProcess | undefined;

  const urlA = `http://127.0.0.1:${NODE_A.api}/rpc/`;
  const urlB = `http://127.0.0.1:${NODE_B.api}/rpc/`;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skandha-e2e-"));
    dirA = path.join(tmpDir, "nodeA");
    dirB = path.join(tmpDir, "nodeB");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    // 1. Real ethrex devnet, Hegota active from genesis.
    await startDevnet();

    // 2. Bootnode.
    nodeA = spawnNode("nodeA", dirA, NODE_A, []);
    await waitFor("node A's RPC", 90_000, async () => {
      const r = await rpc(urlA, "eth_chainId");
      return Number(r.result) === 9;
    });

    // 3. Node B, dialing node A's persisted ENR.
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

    // 4. Real libp2p connection between them, before anything is published -
    //    gossipsub drops publishes with no peers on the topic.
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

  it("propagates a frame transaction from node A's RPC to node B's mempool", async () => {
    const account = privateKeyToAccount(SENDER_PRIVATE_KEY);

    const nonceRes = await rpc(ETHREX_RPC, "eth_getTransactionCount", [
      account.address,
      "latest",
    ]);
    const nonce = BigInt(nonceRes.result);

    const gasPriceRes = await rpc(ETHREX_RPC, "eth_gasPrice");
    const gasPrice = BigInt(gasPriceRes.result ?? "0x3b9aca00");
    const maxFeePerGas = gasPrice * BigInt(2) + BigInt(1_000_000_000);

    const tx = await signFrameTx(
      buildUnsignedFrameTx(nonce, {
        maxFeePerGas,
        maxPriorityFeePerGas: BigInt(1_000_000_000),
      })
    );
    const expectedHash = keccak256(encodeRawFrameTx(tx));

    const sent = await rpc(urlA, "eth_sendFrameTransaction", [toWire(tx)]);
    if (sent.error) {
      throw new Error(
        `node A rejected the frame transaction: ${JSON.stringify(sent.error)}\n` +
          `--- node A log ---\n${tailLog(dirA, "nodeA")}`
      );
    }
    expect(String(sent.result).toLowerCase()).toBe(expectedHash.toLowerCase());

    // Node A stored it locally.
    const onA = await rpc(urlA, "eth_getFrameTransactionByHash", [sent.result]);
    expect(onA.result, `node A did not store it: ${JSON.stringify(onA)}`).toBeTruthy();

    // The real assertion: node B's own mempool, reached only by gossip.
    let onB: any;
    await waitFor(
      "the frame transaction to reach node B's mempool",
      120_000,
      async () => {
        onB = await rpc(urlB, "eth_getFrameTransactionByHash", [sent.result]);
        return onB.result != null;
      }
    ).catch((err) => {
      throw new Error(
        `${err.message}\n--- node A log ---\n${tailLog(dirA, "nodeA")}\n` +
          `--- node B log ---\n${tailLog(dirB, "nodeB")}`
      );
    });

    expect(onB.result).toBeTruthy();
    expect(String(onB.result.sender).toLowerCase()).toBe(
      account.address.toLowerCase()
    );
  }, 300_000);
});
