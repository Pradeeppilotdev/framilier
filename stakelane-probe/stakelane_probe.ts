// Copy into mempool-workshop/src/steps/stakelane_probe.ts.
// Reviewed against workshop bcfe02a196ca97b6fb0d1044db9d0b4c673831fc.
// A bounded declared-budget probe, not an expensive-validation or load test.
import { execFileSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { loadConfig } from "../lib/config.js";
import { readState } from "../lib/state.js";
import { buildWalletTx, signFrameTx, toWire, txHash } from "../lib/frameTx/build.js";

class RpcFailure extends Error {
  constructor(public code: number, message: string, public data: unknown) { super(message); }
}
const report: Record<string, unknown> = {
  probe: "declared-VERIFY-budget", timestamp: new Date().toISOString(),
  limitation: "Increasing the declared VERIFY limit does not increase the wallet's validation work. Estimates do not prove admission; admission does not prove inclusion. This single-entity probe does not establish per-entity isolation.",
};
let privateKeyForRedaction = "";
function errorDetails(e: unknown) {
  return e instanceof RpcFailure ? { code: e.code, message: e.message, data: e.data }
    : { message: e instanceof Error ? e.message : String(e) };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("yarn tsx src/steps/stakelane_probe.ts --budget 70000 [--submit]\nDefault: estimate only. --submit: submit exactly one zero-value transaction, then wait up to 120 seconds for a receipt. Uses the participant-owned violating wallet on its clean validation path.");
    return;
  }
  let budget = 70000n;
  let submit = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--submit") submit = true;
    else if (args[i] === "--budget" && /^\d+$/.test(args[i + 1] ?? "")) budget = BigInt(args[++i]);
    else throw new Error(`Unknown or invalid argument: ${args[i]}`);
  }
  if (budget < 70000n || budget > 1100000n) throw new Error("This bounded probe accepts VERIFY budgets from 70000 to 1100000 only.");
  const cfg = loadConfig();
  if (cfg.chainId !== 1337) throw new Error("This probe is restricted to the throwaway workshop chain 1337.");
  const state = readState();
  if (!state.participantKey || !state.violating || !state.account || !state.completedSteps?.includes("step_6_tx_violating_canonical")) {
    throw new Error("Complete workshop step_1_check and step_6_tx_violating_canonical in a fresh workshop checkout first. This probe never creates a key or funds/deploys an account.");
  }
  privateKeyForRedaction = state.participantKey;
  const owner = privateKeyToAccount(state.participantKey).address;
  if (owner.toLowerCase() !== state.account.toLowerCase()) throw new Error("Workshop participant key no longer matches its recorded account.");
  const wallet = state.violating;
  let requestId = 0;
  async function rpc(method: string, params: unknown[] = []): Promise<any> {
    const response = await fetch(cfg.gatewayUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from gateway during ${method}`);
    const body: any = await response.json();
    if (body.error) throw new RpcFailure(body.error.code, body.error.message, body.error.data);
    if (!("result" in body)) throw new Error(`Malformed JSON-RPC response for ${method}`);
    return body.result;
  }
  // Sequential, bounded calls. No debug/admin RPCs and no retry loops for submission.
  const chainId = await rpc("eth_chainId");
  if (BigInt(chainId) !== 1337n) throw new Error("Connected RPC is not chain 1337.");
  report.gateway = cfg.gatewayUrl;
  report.chainId = 1337;
  report.sidecarVersion = await rpc("web3_clientVersion");
  report.noteOnVersion = "web3_clientVersion at the gateway identifies the sidecar, not necessarily the underlying execution client revision.";
  try { report.workshopCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { report.workshopCommit = "unknown"; }
  report.blockBefore = await rpc("eth_blockNumber");
  if (await rpc("eth_getCode", [wallet, "latest"]) === "0x") throw new Error("Wallet has no deployed code; the devnet may have reset.");
  const ownerResult = await rpc("eth_call", [{ to: wallet, data: "0x8da5cb5b" }, "latest"]);
  if (typeof ownerResult !== "string" || ownerResult.slice(-40).toLowerCase() !== owner.slice(2).toLowerCase()) {
    throw new Error("On-chain wallet owner does not match the workshop participant.");
  }
  const stakeAbi = [{ type: "function", name: "getDepositInfo", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }, { type: "uint32" }, { type: "uint64" }] }] as const;
  const stakeResult = await rpc("eth_call", [{ to: cfg.stakingRegistry, data: encodeFunctionData({ abi: stakeAbi, functionName: "getDepositInfo", args: [wallet] }) }, "latest"]);
  const [stake, unstakeDelaySec, withdrawTime] = decodeFunctionResult({ abi: stakeAbi, functionName: "getDepositInfo", data: stakeResult });
  report.wallet = wallet;
  report.stakeRegistry = cfg.stakingRegistry;
  report.stake = { amountWei: stake, unstakeDelaySec, withdrawTime, note: "Registry evidence only: effective staked eligibility also depends on this node's configured minimums and reputation." };
  const balance = BigInt(await rpc("eth_getBalance", [wallet, "latest"]));
  const nonce = BigInt(await rpc("eth_getTransactionCount", [wallet, "latest"]));
  const unsigned = buildWalletTx({ wallet, owner, to: owner, value: 0n, nonce, chainId: cfg.chainId, maxFeePerGas: cfg.maxFeePerGasWei, verifyData: "0x" });
  unsigned.frames[0].limits.execution = budget;
  // Known existing EOA, empty calldata, no transferred value; no state creation required.
  unsigned.frames[1].limits.state = 0n;
  const signed = await signFrameTx(unsigned, state.participantKey);
  const wire = toWire(signed);
  const predictedHash = txHash(signed);
  report.verifyFrameDeclaredGas = budget;
  report.signatureAccounting = "Protocol signature-validation costs may be added to the VERIFY frame budget. These probe values are not exact total-prefix thresholds.";
  report.actualValidationWork = "Unchanged: the workshop wallet's clean signature-check-and-approve path. No loops, cryptographic workload amplification, or storage violation.";
  report.nonce = nonce;
  report.balanceWei = balance;
  report.candidateHash = predictedHash;
  report.submissionRequested = submit;
  try {
    report.estimate = { ok: true, result: await rpc("eth_estimateFrameTransactionGas", [wire]) };
  } catch (e) {
    report.estimate = { ok: false, error: errorDetails(e) };
    // A transport failure must not trigger a transaction submission.
    if (!(e instanceof RpcFailure)) throw e;
  }
  if (!submit) {
    report.outcome = "ESTIMATE_ONLY_NOT_ADMISSION";
    return;
  }
  // Submit one candidate even if the estimator returned a policy error:
  // the estimator and admission may follow different validation paths.
  let hash: string;
  try {
    hash = await rpc("eth_sendFrameTransaction", [wire]);
    report.admission = { accepted: true, hash };
    report.explorer = `${cfg.explorerUrl.replace(/\/$/, "")}/tx/${hash}?node=${encodeURIComponent(cfg.gatewayUrl)}`;
  } catch (e) {
    report.admission = { accepted: false, error: errorDetails(e) };
    report.outcome = e instanceof RpcFailure ? "RPC_REJECTION_INSPECT_ERROR" : "SUBMISSION_OUTCOME_UNKNOWN_TRANSPORT_FAILURE";
    report.nextStep = `Run yarn step_11_debug ${predictedHash}. A failed RPC reply is not automatically a budget-limit finding. Do not resubmit after a transport failure until the hash is checked.`;
    process.exitCode = 2;
    return;
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      report.receipt = receipt;
      const frameReceipts = receipt.frameReceipts;
      report.outcome = receipt.status !== "0x1" ? "MINED_REVERTED"
        : !Array.isArray(frameReceipts) || !frameReceipts.length ? "MINED_SUCCESS_NEEDS_FRAME_DETAILS"
        : frameReceipts.some((f: any) => f.status !== "0x1") ? "MINED_WITH_FAILED_FRAME"
        : "MINED_ALL_FRAMES_SUCCEEDED";
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  report.outcome = "ADMITTED_NO_RECEIPT_WITHIN_120_SECONDS";
  try { report.sidecarStatus = await rpc("skandha_frameTransactionStatus", [hash]); }
  catch (e) { report.sidecarStatus = { error: errorDetails(e) }; }
  report.nextStep = "Stop here and debug this hash with step_11_debug. Do not queue more budget probes while this account's transaction remains pending.";
  process.exitCode = 2;
}

main().catch(e => {
  report.outcome = "PROBE_FAILED";
  report.error = errorDetails(e);
  process.exitCode = 1;
}).finally(() => {
  if (process.argv.includes("--help")) return;
  let output = JSON.stringify(report, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2);
  if (privateKeyForRedaction) output = output.replaceAll(privateKeyForRedaction, "[REDACTED]");
  console.log(output);
});
