import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  MINING_NODE_A,
  MINING_SENDER_PRIVATE_KEY,
  rpc,
  waitFor,
  spawnNode,
  tailLog,
  startMiningDevnet,
  stopMiningDevnet,
  buildUnsignedFrameTx,
  signFrameTx,
  toWire,
  deployContract,
  WALLET_INIT_CODE,
  PAYMASTER_INIT_CODE,
} from "./helpers.js";
import { FRAME_MODE, APPROVE_SCOPE, SIG_SCHEME, FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";

/**
 * The one e2e scenario in this suite that exercises a REAL mined block, not
 * just mempool admission/propagation against a devnet that never advances
 * past genesis. Every other `*.e2e.test.ts` file here runs against
 * `ethrex-devnet.sh`'s `--dev`-mode single-node block producer, which is
 * disabled from actually mining (`--dev` can't drive Hegota's staged
 * fork-activation requirements - see `ethrex-mining-devnet.sh`'s own header
 * comment) - so none of them can observe `MempoolReconciler` actually doing
 * its job: detecting real inclusion and setting `MempoolEntryStatus.OnChain`/
 * `Reverted` from a genuine receipt (`reconciliation.ts`'s `reconcileSubmitted`).
 *
 * This test instead drives a real Kurtosis devnet
 * (`ethrex-mining-devnet.sh` / `kurtosis/eip8141-single-node.yaml`): one
 * ethrex node paired with a real Lighthouse consensus client, staging
 * Osaka -> Amsterdam -> Hegota over epochs exactly like ethrex's own public
 * Hegota devnet does. It actually produces blocks, so a submitted frame
 * transaction can actually land - which is the only way to prove
 * `MempoolReconciler`'s inclusion-detection path (not just its unit-tested
 * logic against a mocked receipt) end to end.
 *
 * Runs with `--executor.bundlingMode auto` (unlike every other e2e test
 * here, which uses `manual` + `debug_bundler_sendBundleNow`): reconciliation
 * only runs from the "auto"-mode cron's `tryBundle` -
 * `debug_bundler_sendBundleNow` only calls `BundlingService.sendNextBundle`,
 * never `MempoolReconciler.reconcile` - so "auto" mode is required for this
 * test to observe inclusion at all.
 *
 * ## Running it
 *
 *   npx vitest run test/e2e/frameTxInclusion.e2e.test.ts
 *
 * The devnet itself is started and stopped by this test, via
 * `ethrex-mining-devnet.sh`. Needs Docker + the Kurtosis CLI; not runnable
 * in an environment without both (this repo's own CI is the only place it's
 * been exercised so far - it needs real Docker, unavailable in a plain dev
 * sandbox).
 */
describe("frame tx e2e: real inclusion on a block-producing devnet", () => {
  let tmpDir: string;
  let dirA: string;
  let nodeA: ChildProcess | undefined;
  let chainId: number;
  let devnetRpcUrl: string;

  const urlA = `http://127.0.0.1:${MINING_NODE_A.api}/rpc/`;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skandha-e2e-inclusion-"));
    dirA = path.join(tmpDir, "nodeA");
    fs.mkdirSync(dirA, { recursive: true });

    // 1. Real Kurtosis devnet: ethrex + Lighthouse, staged fork activation.
    // `startMiningDevnet` reads both the RPC URL and the chain id back live
    // rather than assuming either - see its own doc comment for why neither
    // is a fixed, predictable value here.
    const devnet = await startMiningDevnet();
    chainId = devnet.chainId;
    devnetRpcUrl = devnet.rpcUrl;

    // 2. One node, standalone - no peering needed for this scenario. "auto"
    // bundling mode (see header comment) and the mining devnet's own
    // relayer key/RPC endpoint, both distinct from every other e2e test's
    // `--dev`-devnet fixtures.
    nodeA = spawnNode(
      "nodeA",
      dirA,
      MINING_NODE_A,
      [],
      { relayerPrivateKey: MINING_SENDER_PRIVATE_KEY, rpcEndpoint: devnet.rpcUrl },
      "auto"
    );
    await waitFor("node A's RPC", 90_000, async () => {
      const r = await rpc(urlA, "eth_chainId");
      return r.result !== undefined && Number(r.result) === chainId;
    });
  }, 600_000);

  afterAll(async () => {
    nodeA?.kill("SIGKILL");
    stopMiningDevnet();
  }, 180_000);

  /**
   * Plain legacy value transfer to a brand-new (never-before-touched)
   * recipient. This devnet's fork (Amsterdam+, EIP-2780/EIP-8037
   * resource-based intrinsic gas) prices a transfer's base cost at exactly
   * 21_000 (12_000 sender base + 3_000 cold recipient access + 6_000 value
   * charge - see `gas_cost::tx_base_cost`/`recipient_regular_gas`) - but
   * materializing a genuinely new account additionally costs
   * `STATE_BYTES_PER_NEW_ACCOUNT * cost_per_state_byte` = 120 * 1530 =
   * 183_600 state gas, charged in `default_hook.rs`'s prepare region. A
   * transfer to a fresh account therefore needs 204_600 gas minimum, not
   * the classic pre-Amsterdam 21_000 - budget comfortably above that.
   * (Confirmed empirically: an earlier version of this test using
   * `gas: 21_000n` reproduced a real `status: "0x0"` receipt in CI, and
   * ethrex-side debug logging pinned the exact deficit to -183_600,
   * matching this constant precisely.)
   *
   * Runs before the frame-tx test below and claims nonce 0 - ordering
   * matters because a plain transfer needs no Hegota-boundary wait, so
   * running it first fails fast instead of waiting out that test's own
   * up-to-10-minute retry loop first.
   */
  it(
    "a plain legacy value transfer to a fresh account lands",
    async () => {
      const account = privateKeyToAccount(MINING_SENDER_PRIVATE_KEY);
      const recipient = privateKeyToAccount(generatePrivateKey()).address;

      const raw = await account.signTransaction({
        chainId,
        nonce: 0,
        to: recipient,
        value: 1_000_000_000_000_000_000n, // 1 ETH
        gas: 250_000n,
        gasPrice: 2_000_000n,
        type: "legacy",
      });

      const sent = await rpc(devnetRpcUrl, "eth_sendRawTransaction", [raw]);
      expect(sent.error, JSON.stringify(sent.error)).toBeUndefined();
      const hash = sent.result as string;

      // `beforeAll` only confirms RPC connectivity, not that genesis time
      // (GENESIS_DELAY=300s in genesis.values.env) has actually passed -
      // this test runs immediately after beforeAll returns, so the chain
      // may still be pre-genesis. Budget comfortably past that delay
      // rather than assume it's already elapsed.
      let receipt: any;
      await waitFor("legacy transfer to be mined", 6 * 60_000, async () => {
        const r = await rpc(devnetRpcUrl, "eth_getTransactionReceipt", [hash]);
        if (r.error || !r.result) return false;
        receipt = r.result;
        return true;
      });

      const balance = await rpc(devnetRpcUrl, "eth_getBalance", [recipient, "latest"]);
      expect(
        receipt.status,
        `receipt: ${JSON.stringify(receipt)}, recipient balance: ${JSON.stringify(balance)}`
      ).toBe("0x1");
      expect(BigInt(balance.result as string)).toBe(1_000_000_000_000_000_000n);
    },
    7 * 60_000
  );

  it(
    "relays a real frame transaction and observes real on-chain inclusion",
    async () => {
      const fees = {
        maxFeePerGas: BigInt(2_000_000_000),
        maxPriorityFeePerGas: BigInt(1_000_000_000),
      };
      const tx = await signFrameTx(
        buildUnsignedFrameTx(1n, fees, MINING_SENDER_PRIVATE_KEY, chainId),
        MINING_SENDER_PRIVATE_KEY
      );
      const wireTx = toWire(tx);

      // A type-0x06 frame transaction is only a valid tx type from the
      // Hegota fork boundary on (`heze_fork_epoch: 2` in the kurtosis
      // config, 6s slots - so at least ~2 epochs of real wall-clock time
      // after genesis, exact length set by whatever SLOTS_PER_EPOCH preset
      // the pinned `ethereum-package` revision uses, not assumed here).
      // Retrying submission until it's accepted - rather than a fixed sleep
      // before one attempt - adapts to that automatically and to any
      // startup/bootstrap delay, instead of hardcoding a guess at both.
      let hash: string | undefined;
      await waitFor(
        "frame tx admission (devnet must reach the Hegota fork boundary first)",
        10 * 60_000,
        async () => {
          const sent = await rpc(urlA, "eth_sendFrameTransaction", [wireTx]);
          if (sent.error) return false;
          hash = sent.result as string;
          return true;
        }
      );
      expect(
        hash,
        `never got a tx hash back from eth_sendFrameTransaction:\n--- node A log ---\n${tailLog(dirA, "nodeA")}`
      ).toBeDefined();

      // Real inclusion: `MempoolReconciler`'s "auto"-mode cron (10s default
      // `bundleInterval`) must observe the submission actually landing in a
      // mined block and set `MempoolEntryStatus.OnChain` from a genuine
      // receipt - not a mocked one, unlike `reconciliation.test.ts`.
      await waitFor(
        "real on-chain inclusion (MempoolReconciler marking OnChain)",
        5 * 60_000,
        async () => {
          const status = await rpc(urlA, "skandha_frameTransactionStatus", [hash]);
          if (status.error) return false;
          return status.result?.status === "OnChain";
        }
      );

      // Cross-check against ethrex's own receipt directly, not just
      // the sidecar's internal bookkeeping - proves a real block actually
      // included and executed it, matching the whole-transaction `status`
      // bit `decodeTransactionStatus` (`ReceiptService`) surfaces.
      const receipt = await rpc(urlA, "eth_getFrameTransactionReceipt", [hash]);
      expect(receipt.error, JSON.stringify(receipt.error)).toBeUndefined();
      expect(receipt.result.status).toBe("success");
    },
    20 * 60_000
  );

  /**
   * Exercises the "factory or gas paymaster contracts" path directly: real,
   * separately-deployed contracts (not the null-target self-relay shape the
   * test above uses) fill the Canonical Paymaster validation-prefix shape
   * `[only_verify, pay]` (`recognizeValidationPrefix` in
   * `validationPrefix.ts`). Both contracts are primitive - unconditional
   * `APPROVE` calls with no signature checking (see `helpers.ts`'s
   * `WALLET_INIT_CODE`/`PAYMASTER_INIT_CODE` doc comment) - appropriate for
   * this demonstration-only devnet, not a real wallet/paymaster design.
   *
   * Proves real fund movement, not just a "success" status: the paymaster's
   * balance drops (it, not the wallet, paid for gas) and the SENDER frame's
   * value transfer actually lands.
   */
  it(
    "relays a real frame transaction using deployed wallet + paymaster contracts",
    async () => {
      // Funded with a trivial amount via the CREATE's own `value` (see the
      // paymaster's identical rationale below): the SENDER-mode body frame
      // transfers `value: 1n` FROM the wallet (SENDER mode's caller is
      // tx.sender), which needs a non-zero balance to cover it - an
      // unfunded wallet reverted that frame in an earlier round ("frame(s)
      // 2 (reverted) did not succeed").
      const walletAddress = await deployContract(
        devnetRpcUrl,
        chainId,
        MINING_SENDER_PRIVATE_KEY,
        WALLET_INIT_CODE,
        1_000n
      );
      // Funded via the CREATE's own `value` (0.01 ETH - comfortably covers
      // this tx's ~126_525 gas at a 2 gwei max fee, ~0.00025 ETH), NOT a
      // later plain transfer to its address: any external call to this
      // contract - even a pure value transfer with empty calldata -
      // executes its unconditional-APPROVE runtime code, which halts
      // exceptionally outside a frame-tx context (see `deployContract`'s
      // doc comment). A CREATE's value is credited before init code runs
      // and never triggers the deployed runtime code at all.
      const paymasterAddress = await deployContract(
        devnetRpcUrl,
        chainId,
        MINING_SENDER_PRIVATE_KEY,
        PAYMASTER_INIT_CODE,
        10_000_000_000_000_000n // 0.01 ETH
      );

      const funder = privateKeyToAccount(MINING_SENDER_PRIVATE_KEY);
      const paymasterBalanceBefore = await rpc(devnetRpcUrl, "eth_getBalance", [paymasterAddress, "latest"]);
      const funderBalanceBefore = await rpc(devnetRpcUrl, "eth_getBalance", [funder.address, "latest"]);

      // only_verify (target=null -> resolves to tx.sender=walletAddress)
      // approves execution, pay (target=paymaster) approves payment, then a
      // SENDER-mode frame does the real work - a trivial value transfer back
      // to the funder's already-existing (non-empty) EOA, avoiding the
      // NEW_ACCOUNT state-gas charge a fresh recipient would need (this
      // frame's `limits.state: 0` would otherwise silently fail the frame
      // and drag the whole tx's derived `succeeded` to false - see
      // `docs/eip-8141.md`'s "top-level succeeded" and the legacy-transfer
      // fix above for the same charge on the plain-tx path).
      const tx: FrameTransaction = {
        chainId: BigInt(chainId),
        // Wallet's own nonce. Not 0: a freshly CREATE'd contract account
        // starts at nonce 1, not 0 (EIP-161/Spurious Dragon - distinct from
        // an EOA, which starts at 0). ethrex rejected the first attempt at
        // this with "Nonce mismatch: expected 1, got 0", confirming it.
        nonceKeys: [0n],
        nonceSeq: 1n,
        sender: walletAddress,
        frames: [
          {
            mode: FRAME_MODE.VERIFY,
            flags: APPROVE_SCOPE.EXECUTION,
            target: null,
            limits: { execution: 30_000n, state: 0n },
            value: 0n,
            data: "0x",
          },
          {
            mode: FRAME_MODE.VERIFY,
            flags: APPROVE_SCOPE.PAYMENT,
            target: paymasterAddress,
            limits: { execution: 30_000n, state: 0n },
            value: 0n,
            data: "0x",
          },
          {
            mode: FRAME_MODE.SENDER,
            flags: APPROVE_SCOPE.NONE,
            target: funder.address,
            limits: { execution: 50_000n, state: 0n },
            value: 1n,
            data: "0x",
          },
        ],
        signatures: [
          {
            // The wallet contract never reads SIGPARAM - it approves
            // unconditionally - so ARBITRARY (no recoverable signer, no
            // crypto check) is both sufficient and the cheapest scheme.
            scheme: SIG_SCHEME.ARBITRARY,
            signer: "0x",
            msg: "0x",
            signature: "0x",
          },
        ],
        fees: {
          maxPriorityFeePerGas: 1_000_000_000n,
          maxFeePerGas: 2_000_000_000n,
          maxFeePerBlobGas: 0n,
        },
        blobVersionedHashes: [],
        recentRootReferences: [],
      };
      const wireTx = toWire(tx);

      let hash: string | undefined;
      let lastAdmissionError: unknown;
      try {
        await waitFor(
          "contract-backed frame tx admission (devnet must reach the Hegota fork boundary first)",
          10 * 60_000,
          async () => {
            const sent = await rpc(urlA, "eth_sendFrameTransaction", [wireTx]);
            if (sent.error) {
              lastAdmissionError = sent.error;
              return false;
            }
            hash = sent.result as string;
            return true;
          }
        );
      } catch (err) {
        throw new Error(`${String(err)} - last admission error: ${JSON.stringify(lastAdmissionError)}`);
      }
      expect(
        hash,
        `never got a tx hash back from eth_sendFrameTransaction:\n--- node A log ---\n${tailLog(dirA, "nodeA")}`
      ).toBeDefined();

      let lastStatus: unknown;
      try {
        await waitFor(
          "real on-chain inclusion (MempoolReconciler marking OnChain)",
          5 * 60_000,
          async () => {
            const status = await rpc(urlA, "skandha_frameTransactionStatus", [hash]);
            lastStatus = status.error ?? status.result;
            if (status.error) return false;
            return status.result?.status === "OnChain";
          }
        );
      } catch (err) {
        throw new Error(
          `${String(err)} - last status: ${JSON.stringify(lastStatus)}\n--- node A log (tail) ---\n${tailLog(dirA, "nodeA", 150)}`
        );
      }

      const receipt = await rpc(urlA, "eth_getFrameTransactionReceipt", [hash]);
      expect(receipt.error, JSON.stringify(receipt.error)).toBeUndefined();
      expect(receipt.result.status, JSON.stringify(receipt.result)).toBe("success");
      expect((receipt.result.payer as string).toLowerCase()).toBe(paymasterAddress.toLowerCase());

      // Real fund movement, not just a "success" label: the paymaster (not
      // the wallet) paid for gas, and the SENDER frame's 1 wei landed.
      const paymasterBalanceAfter = await rpc(devnetRpcUrl, "eth_getBalance", [paymasterAddress, "latest"]);
      const funderBalanceAfter = await rpc(devnetRpcUrl, "eth_getBalance", [funder.address, "latest"]);
      expect(BigInt(paymasterBalanceAfter.result as string)).toBeLessThan(
        BigInt(paymasterBalanceBefore.result as string)
      );
      expect(BigInt(funderBalanceAfter.result as string)).toBe(BigInt(funderBalanceBefore.result as string) + 1n);
    },
    25 * 60_000
  );
});
