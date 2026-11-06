import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { Hex, keccak256, toHex } from "viem";
import {
  MINING_NODE_A,
  MINING_SENDER_PRIVATE_KEY,
  rpc,
  waitFor,
  spawnNode,
  tailLog,
  startMiningDevnet,
  stopMiningDevnet,
  toWire,
  deployContract,
} from "./helpers.js";
import {
  SHARED_SENDER_POOL_INIT_CODE,
  NONCE_MANAGER,
  RECENT_ROOT_ADDRESS,
  nonceManagerSlot,
  recentRootEntryHash,
  recentRootSourceId,
  recentRootStorageKey,
} from "./sharedSenderPool.js";
import {
  FRAME_MODE,
  APPROVE_SCOPE,
  SIG_SCHEME,
  FrameTransaction,
  RecentRootReference,
} from "@skandha/types/lib/contracts/FrameTx.js";

/**
 * Acceptance test for EIP-8250 keyed nonces + EIP-8272 recent roots
 * (`mo.md`, Phase 4): a shared-sender "privacy pool" - one contract that is
 * the sender and payer of every withdrawal - gets two withdrawals admitted
 * concurrently and both included on a real block-producing devnet.
 *
 * Each withdrawal's nonce key stands in for its nullifier and its declared
 * recent root for the Merkle root its proof is against; the pool contract
 * (`sharedSenderPool.ts`) checks only that the key is non-zero and the root
 * is its own, which is all the mempool and protocol mechanics need.
 *
 * Runs against the mining devnet (`vitest.mining.config.ts`); set
 * `MINING_DEVNET_RPC_URL` to reuse one that is already running.
 */
describe("frame tx e2e: shared-sender pool with keyed nonces and recent roots", () => {
  let tmpDir: string;
  let dir: string;
  let node: ChildProcess | undefined;
  let chainId: number;
  let ethrex: string;
  const url = `http://127.0.0.1:${MINING_NODE_A.api}/rpc/`;
  const funder = privateKeyToAccount(MINING_SENDER_PRIVATE_KEY);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skandha-e2e-shared-sender-"));
    dir = path.join(tmpDir, "node");
    fs.mkdirSync(dir, { recursive: true });

    const devnet = await startMiningDevnet();
    chainId = devnet.chainId;
    ethrex = devnet.rpcUrl;

    node = spawnNode(
      "node",
      dir,
      MINING_NODE_A,
      [],
      { relayerPrivateKey: MINING_SENDER_PRIVATE_KEY, rpcEndpoint: ethrex },
      "auto"
    );
    await waitFor("the node's RPC", 90_000, async () => {
      const r = await rpc(url, "eth_chainId");
      return r.result !== undefined && Number(r.result) === chainId;
    });

    // Frame transactions and the predeploys exist only from Hegota on.
    await waitFor("Hegota (RECENT_ROOT_ADDRESS installed)", 15 * 60_000, async () => {
      const code = await rpc(ethrex, "eth_getCode", [RECENT_ROOT_ADDRESS, "latest"]);
      return typeof code.result === "string" && code.result.length > 2;
    });
  }, 20 * 60_000);

  afterAll(async () => {
    node?.kill("SIGKILL");
    stopMiningDevnet();
  }, 180_000);

  const fees = {
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 2_000_000_000n,
    maxFeePerBlobGas: 0n,
  };

  const withdrawal = (
    pool: Hex,
    nullifierKey: bigint,
    ref: RecentRootReference,
    amount: bigint
  ): FrameTransaction => ({
    chainId: BigInt(chainId),
    nonceKeys: [nullifierKey],
    nonceSeq: 0n,
    sender: pool,
    frames: [
      {
        // Self Relay: the pool verifies and pays for itself.
        mode: FRAME_MODE.VERIFY,
        flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
        target: null,
        limits: { execution: 50_000n, state: 0n },
        value: 0n,
        data: "0x",
      },
      {
        // The payout: frame value is debited from tx.sender, the pool.
        // To an existing account, so no new-account state gas is needed.
        mode: FRAME_MODE.SENDER,
        flags: APPROVE_SCOPE.NONE,
        target: funder.address,
        limits: { execution: 50_000n, state: 0n },
        value: amount,
        data: "0x",
      },
    ],
    signatures: [{ scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: "0x" }],
    fees,
    blobVersionedHashes: [],
    recentRootReferences: [ref],
  });

  const send = (tx: FrameTransaction) => rpc(url, "eth_sendFrameTransaction", [toWire(tx)]);

  it(
    "admits two concurrent withdrawals from one sender on distinct keys, and includes both",
    async () => {
      // 1. Deploy the pool, funded through the CREATE (deposits back withdrawals).
      const pool = (await deployContract(
        ethrex,
        chainId,
        MINING_SENDER_PRIVATE_KEY,
        SHARED_SENDER_POOL_INIT_CODE,
        50_000_000_000_000_000n // 0.05 ETH
      )) as Hex;

      // 2. "Deposit": the pool publishes a root as an EIP-8272 recent root.
      const root = keccak256(toHex("e2e merkle root"));
      const nonce = Number((await rpc(ethrex, "eth_getTransactionCount", [funder.address, "pending"])).result);
      const raw = await funder.signTransaction({
        chainId,
        nonce,
        to: pool,
        data: root,
        gas: 500_000n,
        gasPrice: 2_000_000_000n,
        type: "legacy",
      });
      const sent = await rpc(ethrex, "eth_sendRawTransaction", [raw]);
      expect(sent.error, JSON.stringify(sent.error)).toBeUndefined();
      let depositReceipt: any;
      await waitFor("the root-publishing deposit to be mined", 3 * 60_000, async () => {
        const r = await rpc(ethrex, "eth_getTransactionReceipt", [sent.result]);
        depositReceipt = r.result;
        return !!depositReceipt;
      });
      expect(depositReceipt.status).toBe("0x1");
      const depositBlock = (await rpc(ethrex, "eth_getBlockByNumber", [depositReceipt.blockNumber, false])).result;
      const slot = BigInt(depositBlock.slotNumber);

      // The root is committed exactly where EIP-8272 says it is - this also
      // pins the test's own hash derivation to ethrex's.
      const sourceId = recentRootSourceId(pool);
      const stored = await rpc(ethrex, "eth_getStorageAt", [
        RECENT_ROOT_ADDRESS,
        recentRootStorageKey(sourceId, slot),
        "latest",
      ]);
      expect(stored.result).toBe(recentRootEntryHash(sourceId, slot, root));

      // A root becomes referenceable from the slot after it was written.
      await waitFor("one more slot", 60_000, async () => {
        const head = (await rpc(ethrex, "eth_getBlockByNumber", ["latest", false])).result;
        return BigInt(head.slotNumber) > slot;
      });

      // 3. Two withdrawals: same sender, same nonceSeq (0), distinct nullifier keys.
      const ref: RecentRootReference = { sourceId, slot, root };
      const keyA = BigInt(keccak256(toHex("nullifier A")));
      const keyB = BigInt(keccak256(toHex("nullifier B")));
      const balanceBefore = BigInt((await rpc(ethrex, "eth_getBalance", [funder.address, "latest"])).result);

      const a = await send(withdrawal(pool, keyA, ref, 1_000n));
      expect(a.error, `${JSON.stringify(a.error)}\n${tailLog(dir, "node", 60)}`).toBeUndefined();
      const b = await send(withdrawal(pool, keyB, ref, 2_000n));
      expect(b.error, `${JSON.stringify(b.error)}\n${tailLog(dir, "node", 60)}`).toBeUndefined();
      expect(a.result).not.toBe(b.result);

      // Reusing nullifier A while A is in flight never gets in. The same key
      // set and sequence is A's own slot, so it could only replace A with a
      // 10% fee bump; an overlapping key set is a different slot holding key
      // A, refused outright. (If A already landed, the protocol's nonce
      // check refuses both instead.)
      const sameSlot = await send(withdrawal(pool, keyA, ref, 3_000n));
      expect(sameSlot.error?.message).toMatch(/cannot be replaced: fee too low|Nonce mismatch/);
      const keyC = BigInt(keccak256(toHex("nullifier C")));
      const [lo, hi] = keyA < keyC ? [keyA, keyC] : [keyC, keyA];
      const overlapping = await send({ ...withdrawal(pool, keyA, ref, 3_000n), nonceKeys: [lo, hi] });
      expect(overlapping.error?.message).toMatch(/already held by pending transaction|Nonce mismatch/);

      // 4. Both land.
      for (const hash of [a.result, b.result]) {
        let last: unknown;
        try {
          await waitFor(`withdrawal ${hash} to be included`, 5 * 60_000, async () => {
            const s = await rpc(url, "skandha_frameTransactionStatus", [hash]);
            last = s.error ?? s.result;
            return s.result?.status === "OnChain";
          });
        } catch (err) {
          throw new Error(`${String(err)} - last status: ${JSON.stringify(last)}\n${tailLog(dir, "node", 150)}`);
        }
        const receipt = await rpc(url, "eth_getFrameTransactionReceipt", [hash]);
        expect(receipt.result.status, JSON.stringify(receipt.result)).toBe("success");
        expect((receipt.result.payer as string).toLowerCase()).toBe(pool.toLowerCase());
      }

      // Each nullifier key was consumed in NONCE_MANAGER (sequence 0 -> 1),
      // and both payouts reached the recipient.
      for (const key of [keyA, keyB]) {
        const seq = await rpc(ethrex, "eth_getStorageAt", [NONCE_MANAGER, nonceManagerSlot(pool, key), "latest"]);
        expect(BigInt(seq.result)).toBe(1n);
      }
      const balanceAfter = BigInt((await rpc(ethrex, "eth_getBalance", [funder.address, "latest"])).result);
      expect(balanceAfter - balanceBefore).toBe(3_000n);

      // 5. After inclusion, a replay of nullifier A fails at the protocol level.
      const replay = await send(withdrawal(pool, keyA, ref, 4_000n));
      expect(replay.error?.message).toMatch(/Nonce mismatch/);
    },
    25 * 60_000
  );
});
