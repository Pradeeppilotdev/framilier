import { recoverSubmission, saveSubmissionIntent } from "./submission-journal.mjs";
// One funded, staked witness transaction on the workshop public devnet.
// Each step saves its hash before broadcast. Reruns follow the same hashes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { decodeFunctionResult, encodeDeployData, encodeFunctionData, getContractAddress, keccak256, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeRawFrameTx } from "../../packages/executor/lib/services/FrameTxService/codec.js";
import { rpc, RpcError } from "./producer.mjs";
import { hashChain, signedWalletFrame } from "./wallet-frame.mjs";

const [mode, genesis] = process.argv.slice(2);
if (!["--submit", "--observe"].includes(mode) || !/^0x[0-9a-f]{64}$/.test(genesis ?? "") || process.argv.length !== 4) {
  console.log("Usage: node test/stakelane/public-inclusion.mjs (--submit | --observe) <verified-public-genesis-hash>");
  process.exit(mode === "--help" ? 0 : 1);
}
const el = "https://altmempool.forshtat.com";
const sidecar = el + "/rpc";
const chainId = 1337;
const registry = "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f";
const walletValue = parseEther("0.02");
const stakeValue = parseEther("0.012");
const rounds = 9664;
const { witness, commitment } = hashChain(rounds);
const { contracts } = JSON.parse(await readFile(new URL("./fixtures.json", import.meta.url)));
const state = JSON.parse(await readFile(new URL("../../../mempool-workshop/.workshop-state.json", import.meta.url)));
const owner = privateKeyToAccount(state.participantKey);
assert.equal(owner.address.toLowerCase(), state.account.toLowerCase(), "workshop signing account mismatch");
const work = fileURLToPath(new URL("../../.runtime/public-" + genesis.slice(2) + "-" + owner.address.toLowerCase(), import.meta.url));
await mkdir(work, { recursive: true, mode: 0o700 });
const encode = value => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";
async function read(url, method, params = []) {
  try { return await rpc(url, method, params); }
  catch (e) {
    if (e instanceof RpcError) throw e;
    return rpc(url, method, params);
  }
}
async function checkNetwork() {
  const [a, b, id, info] = await Promise.all([
    read(el, "eth_getBlockByNumber", ["0x0", false]), read(sidecar, "eth_getBlockByNumber", ["0x0", false]),
    read(el, "eth_chainId"), read(sidecar, "skandha_explorer_info"),
  ]);
  assert.equal(a.hash, genesis); assert.equal(b.hash, genesis);
  assert.equal(Number(BigInt(id)), chainId); assert.equal(info.chainId, chainId);
  assert.equal(info.bundlingMode, "auto");
  return { bootId: info.bootId, sidecarVersion: info.version };
}
async function contractRead(to, abi, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args });
  const result = await read(el, "eth_call", [{ to, data }, "latest"]);
  return decodeFunctionResult({ abi, functionName, data: result });
}
async function runStep(label, build, isFrame) {
  const file = work + "/" + label + ".json";
  let intent;
  let broadcastParams;
  try { intent = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (mode === "--observe") throw new Error("No saved transaction to observe for " + label);
    const { hash, params, ...details } = await build();
    await checkNetwork();
    intent = { hash, at: new Date().toISOString(), ...details };
    await saveSubmissionIntent(file, encode(intent));
    broadcastParams = params;
  }
  if (!broadcastParams && mode === "--submit") {
    broadcastParams = await recoverSubmission(intent, isFrame, async (kind, hash) => {
      if (kind === "receipt") return read(el, "eth_getTransactionReceipt", [hash]);
      if (kind === "transaction") return read(el, "eth_getTransactionByHash", [hash]);
      try { return await read(sidecar, "skandha_frameTransactionStatus", [hash]); }
      catch (error) {
        // Only the explicit not-found verdict establishes absence.
        if (error instanceof RpcError && error.code === -32600 && error.rpcMessage === "Frame transaction not found") return null;
        throw error;
      }
    });
  }
  if (broadcastParams) {
    await checkNetwork();
    const hash = intent.hash;
    console.log(label, "submitting original signed hash", hash);
    let returned;
    try {
      returned = await rpc(isFrame ? sidecar : el, isFrame ? "eth_sendFrameTransaction" : "eth_sendRawTransaction", broadcastParams);
    } catch (e) {
      if (e instanceof RpcError) {
        await writeFile(work + "/" + label + "-rejection.json", encode({ hash, code: e.code, reason: e.rpcMessage }));
        throw e;
      }
      console.log(label, "transport interrupted; following the signed hash", hash);
    }
    if (returned !== undefined) assert.equal(returned, hash);
  }
  console.log(label, "checking receipt", intent.hash);
  const deadline = Date.now() + 150000;
  let lastError;
  while (Date.now() < deadline) {
    let receipt;
    try { receipt = await rpc(el, "eth_getTransactionReceipt", [intent.hash]); }
    catch (error) { lastError = error; }
    if (receipt) {
      const block = await read(el, "eth_getBlockByNumber", [receipt.blockNumber, false]);
      assert.equal(block.hash, receipt.blockHash);
      assert.ok(block.transactions.includes(intent.hash));
      assert.equal(receipt.transactionHash, intent.hash);
      const record = { ...intent, receipt, block: { number: block.number, hash: block.hash } };
      await writeFile(work + "/" + label + "-receipt.json", encode(record));
      assert.equal(Number(receipt.status), 1, label + " reverted");
      if (isFrame) assert.deepEqual(receipt.frameReceipts.map(f => Number(f.status)), [1, 1]);
      console.log(label, "mined in block", Number(block.number));
      return record;
    }
    if (receipt === null && isFrame) {
      const status = await rpc(sidecar, "skandha_frameTransactionStatus", [intent.hash]).catch(() => null);
      if (status?.status === "Cancelled" || status?.status === "Reverted") {
        const terminal = { ...intent, receipt: null, sidecarStatus: status.status, reason: status.reason };
        await writeFile(work + "/" + label + "-terminal.json", encode(terminal));
        if (label !== "proof") throw new Error(label + " ended with " + status.status + ": " + status.reason);
        console.log(label, status.status, status.reason);
        return terminal;
      }
    }
    await delay(4000);
  }
  throw new Error("No verified receipt for " + intent.hash + (lastError ? " (" + lastError.message + ")" : ""));
}
const node = await checkNetwork();
const config = await read(sidecar, "skandha_config");
assert.equal(config.stakingRegistryAddress.toLowerCase(), registry);
assert.ok(BigInt(config.minStake) <= stakeValue && Number(config.minUnstakeDelay) <= 86400);
assert.notEqual(await read(el, "eth_getCode", [registry, "latest"]), "0x");
const abi = contracts.HashChainWallet.abi;
const registryAbi = contracts.NaiveStakingRegistry.abi;
const deploy = await runStep("deploy", async () => {
  const [pending, latest, balance, head] = await Promise.all([
    read(el, "eth_getTransactionCount", [owner.address, "pending"]), read(el, "eth_getTransactionCount", [owner.address, "latest"]),
    read(el, "eth_getBalance", [owner.address, "latest"]), read(el, "eth_getBlockByNumber", ["latest", false]),
  ]);
  assert.equal(BigInt(pending), BigInt(latest), "participant has a pending nonce");
  const gas = 6000000n;
  const gasPrice = 2000000n;
  assert.ok(BigInt(head.baseFeePerGas) < gasPrice && BigInt(balance) >= walletValue + gas * gasPrice);
  const nonce = Number(BigInt(pending));
  const address = getContractAddress({ from: owner.address, nonce: BigInt(nonce) });
  assert.equal(await read(el, "eth_getCode", [address, "latest"]), "0x");
  const data = encodeDeployData({ ...contracts.HashChainWallet, args: [owner.address, commitment, BigInt(rounds)] });
  const raw = await owner.signTransaction({ type: "legacy", chainId, nonce, gas, gasPrice, value: walletValue, data });
  return { hash: keccak256(raw), params: [raw], signedTransaction: raw, address, valueWei: walletValue, initialParticipantBalanceWei: BigInt(balance) };
}, false);
const wallet = deploy.address;
assert.equal(deploy.receipt.contractAddress.toLowerCase(), wallet.toLowerCase());
const [onChainOwner, onChainCommitment, onChainRounds] = await Promise.all([
  contractRead(wallet, abi, "owner"), contractRead(wallet, abi, "commitment"), contractRead(wallet, abi, "rounds"),
]);
assert.equal(onChainOwner.toLowerCase(), owner.address.toLowerCase());
assert.equal(onChainCommitment, commitment); assert.equal(Number(onChainRounds), rounds);
const deposit = () => contractRead(registry, registryAbi, "getDepositInfo", [wallet]);
async function frame(gas, verifyData, target, value = 0n, bodyData = "0x") {
  const nonceSeq = BigInt(await read(el, "eth_getTransactionCount", [wallet, "latest"]));
  const tx = await signedWalletFrame({ chainId, wallet, owner: owner.address, key: state.participantKey,
    nonceSeq, gas, verifyData, target, value, bodyData });
  const signedTransaction = encodeRawFrameTx(tx);
  return { hash: keccak256(signedTransaction), params: [tx], signedTransaction, nonceSeq };
}
const stake = await runStep("stake", async () => {
  assert.equal((await deposit())[0], 0n, "wallet already has a stake");
  const data = encodeFunctionData({ abi: registryAbi, functionName: "addStake", args: [86400] });
  return frame(70000n, "0x", registry, stakeValue, data);
}, true);
const [amount, unstakeDelay, withdrawal] = await deposit();
assert.deepEqual([amount, Number(unstakeDelay), withdrawal], [stakeValue, 86400, 0n]);
const proof = await runStep("proof", () => frame(997200n, witness, owner.address), true);
let verifyUsed = null;
let diagnostics;
if (proof.receipt) {
  verifyUsed = Number(BigInt(proof.receipt.frameReceipts[0].gasUsed));
  assert.ok(verifyUsed >= 990000 && verifyUsed <= 997200, "unexpected measured VERIFY gas: " + verifyUsed);
} else {
  // Retain the first observation even if the explorer later prunes its history.
  // A dry-run on the identical bytes is recorded separately from chain receipts.
  const snapshot = work + "/public-observation.json";
  try { diagnostics = JSON.parse(await readFile(snapshot)); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const [explorer, executionSimulation, head] = await Promise.all([
      read(sidecar, "skandha_explorer_getTransaction", [proof.hash]),
      rpc(el, "ethrex_simulateFrameTransaction", [proof.signedTransaction, "latest", { trace: false }]),
      read(el, "eth_getBlockByNumber", ["latest", false]),
    ]);
    diagnostics = { at: new Date().toISOString(), hash: proof.hash, explorer, executionSimulation,
      executionHead: { number: Number(head.number), hash: head.hash } };
    await writeFile(snapshot, encode(diagnostics));
  }
  assert.equal(diagnostics.hash, proof.hash);
  assert.equal(diagnostics.explorer.admission.txHash, proof.hash);
}
const explorer = "https://explorer.altmempool.wtf/tx/" + proof.hash + "?node=" + encodeURIComponent(sidecar);
const report = { verifiedAt: new Date().toISOString(), chainId, genesis, execution: el, sidecar, ...node,
  owner: owner.address, wallet, registry, workload: { rounds, witness, commitment }, deploy, stake,
  deposit: { amountWei: amount, unstakeDelaySeconds: Number(unstakeDelay), withdrawalTime: withdrawal },
  proof, declaredVerifyGas: 997200, signatureGas: 2800, totalDeclaredValidationGas: 1000000,
  outcome: proof.receipt ? "MINED" : proof.sidecarStatus, actualVerifyGas: verifyUsed, diagnostics, explorer };
const output = process.env.STAKELANE_EVIDENCE || work + "/result.json";
await writeFile(output, encode(report));
console.log("Public outcome", report.outcome, "\nExplorer", explorer, "\nEvidence", output);
if (!proof.receipt) process.exitCode = 2;
