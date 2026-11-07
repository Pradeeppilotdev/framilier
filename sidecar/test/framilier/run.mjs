// Run after "bun run build". This fixture starts and stops its own execution
// client and sidecar. All submissions target loopback on a fresh private chain.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { closeSync, createReadStream, existsSync, openSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { decodeFunctionResult, encodeDeployData, encodeFunctionData, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeRawFrameTx } from "../../packages/executor/lib/services/FrameTxService/codec.js";
import { hashChain, signedWalletFrame } from "./wallet-frame.mjs";
import { privateProducer, rpc, RpcError } from "./producer.mjs";
import { backgroundCandidateCount, measureAdmission } from "./failure-benchmark.mjs";
import { startTraceMeter } from "./trace-meter.mjs";
import { denyExternalHttp } from "./private-network.mjs";
import { checkPlan, effectiveScheduler, schedulerConfig } from "./compare-metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const comparing = process.argv[2] === "--compare-arm";
// Only the compare coordinator supplies the private, per-run signing keys, over stdin.
const sweep = comparing ? JSON.parse(readFileSync(0, "utf8")) : null;
const nonceKeyCount = comparing ? checkPlan(sweep.rounds, sweep.bursts) : backgroundCandidateCount;
const matched = comparing || process.argv[2] === "--matched-benchmark";
const benchmark = matched || process.argv[2] === "--builder-benchmark";
assert.ok(process.argv.length === 2 || (benchmark && process.argv.length === 3), "unexpected fixture arguments");
// Optional coordinator IPC is outside every timed admission window.
function progressStage(stage) {
  if (!comparing || !process.connected || typeof process.send !== "function") return;
  try { process.send({ type: "framilier:stage", stage }, () => {}); } catch {}
}
const chainId = 8141337;
const sha256 = value => createHash("sha256").update(value).digest("hex");
async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function buildDigest() {
  const hash = createHash("sha256");
  for (const pkg of ["types", "utils", "params", "monitoring", "db", "executor", "api", "node", "cli"]) {
    const base = path.join(root, "packages", pkg, "lib");
    for (const file of (await readdir(base, { recursive: true })).filter(f => f.endsWith(".js")).sort()) {
      hash.update(pkg + "/" + file + "\n");
      hash.update(await readFile(path.join(base, file)));
    }
  }
  return hash.digest("hex");
}
const localTools = path.join(root, ".runtime", "bin");
const localEthrex = path.join(localTools, "ethrex");
const localBun = path.join(localTools, "bun");
const binary = process.env.FRAMILIER_ETHREX_BIN || (existsSync(localEthrex) ? localEthrex : undefined);
if (!binary) throw new Error("Set FRAMILIER_ETHREX_BIN to the pinned Hegota ethrex executable; see docs/SIDECAR.md");
const genesisBytes = await readFile(path.join(here, "hegota-genesis.json"));
assert.equal(sha256(genesisBytes), "5fe93acb7674db5d809aae4d66bff742121ed718bcddd327efcb8c1a9e631fb4");
const { contracts, compiler } = JSON.parse(await readFile(path.join(here, "fixtures.json"), "utf8"));
const key = comparing ? sweep.primaryKey : generatePrivateKey();
const owner = privateKeyToAccount(key);
const genesis = JSON.parse(genesisBytes);
genesis.config.chainId = chainId;
genesis.alloc[owner.address.toLowerCase()] = { balance: toHex(100n * 10n ** 18n) };
await mkdir(path.join(root, ".runtime"), { recursive: true });
const work = await mkdtemp(path.join(root, ".runtime", "private-inclusion-"));
await chmod(work, 0o700);
const genesisPath = path.join(work, "genesis.json");
const jwtPath = path.join(work, "engine.jwt");
const jwt = randomBytes(32);
await writeFile(genesisPath, JSON.stringify(genesis));
await writeFile(jwtPath, jwt.toString("hex"), { mode: 0o600 });
const children = [];
let meter;
let network;
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith("SKANDHA_") && !k.startsWith("ETHREX_")));
async function port() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const allocated = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return allocated;
}
function worker(name, executable, args) {
  const logfile = path.join(work, name + ".log");
  const fd = openSync(logfile, "a", 0o600);
  let child;
  // Unoptimized ethrex builds need room for the Hegota payload future.
  const env = name === "ethrex" ? { ...childEnv, RUST_MIN_STACK: "67108864", TOKIO_WORKER_THREADS: "4" } : childEnv;
  try { child = spawn(executable, args, { cwd: work, env, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  child.on("error", e => { child.startError = e; });
  children.push(child);
  return { child, logfile };
}
async function waitForRpc(instance, url) {
  let last;
  for (let i = 0; i < 100; i++) {
    if (instance.child.startError) throw instance.child.startError;
    if (instance.child.exitCode != null || instance.child.signalCode) break;
    try {
      if (BigInt(await rpc(url, "eth_chainId")) === BigInt(chainId)) return;
      throw new Error("Unexpected chain on " + url);
    } catch (e) { last = e; }
    await pause(250);
  }
  const log = await readFile(instance.logfile, "utf8");
  throw new Error("Private RPC did not start: " + (last?.message ?? "") + "\n" + log.slice(-1600));
}
async function stop() {
  for (const child of [...children].reverse()) {
    if (child.exitCode != null || child.signalCode || !child.pid) continue;
    const exited = once(child, "exit").catch(() => {});
    child.kill("SIGTERM");
    await Promise.race([exited, pause(1500)]);
    if (child.exitCode == null && !child.signalCode) child.kill("SIGKILL");
  }
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => { void stop().finally(() => process.exit(code)); });
}

try {
  progressStage("chain");
  network = await denyExternalHttp();
  Object.assign(childEnv, network.env);
  const [elPort, enginePort, sidecarPort, peerPort] = await Promise.all([port(), port(), port(), port()]);
  assert.equal(new Set([elPort, enginePort, sidecarPort, peerPort]).size, 4);
  const el = "http://127.0.0.1:" + elPort;
  const local = "http://127.0.0.1:" + sidecarPort + "/rpc/";
  const engine = "http://127.0.0.1:" + enginePort;
  const node = worker("ethrex", binary, [
    "--network", genesisPath, "--datadir", "memory", "--syncmode", "full",
    "--http.addr", "127.0.0.1", "--http.port", String(elPort), "--http.api", "eth,net,web3,ethrex",
    "--authrpc.addr", "127.0.0.1", "--authrpc.port", String(enginePort), "--authrpc.jwtsecret", jwtPath,
    "--p2p.addr", "127.0.0.1", "--p2p.port", String(peerPort), "--discovery.port", String(peerPort),
    "--p2p.discv4", "false", "--p2p.discv5", "false",
  ]);
  await waitForRpc(node, el);
  if (benchmark) await network.confirmReleaseCheckBlocked();
  const producer = privateProducer(el, engine, jwt, owner.address);
  const genesisBlock = await rpc(el, "eth_getBlockByNumber", ["0x0", false]);
  await producer.produce();
  console.log("Private ethrex imported its first canonical block.");

  async function deploy(name, args = [], value = 0n) {
    const artifact = contracts[name];
    const nonce = Number(await rpc(el, "eth_getTransactionCount", [owner.address, "latest"]));
    const data = encodeDeployData({ ...artifact, args });
    const raw = await owner.signTransaction({ chainId, nonce, type: "legacy", gas: 8000000n,
      gasPrice: 2000000000n, data, value });
    const hash = await rpc(el, "eth_sendRawTransaction", [raw]);
    const { receipt } = await producer.receipt(hash);
    assert.ok(receipt.contractAddress);
    return receipt.contractAddress;
  }
  progressStage("deploy");
  const rounds = Number(process.env.FRAMILIER_HASH_ROUNDS || 9664);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 9664, "rounds must be 1–9664 under the fixed 997200 execution-gas allowance");
  if (benchmark) assert.equal(rounds, 9664, "benchmark uses the recorded workload");
  const { witness, commitment } = hashChain(rounds);
  const registry = await deploy("NaiveStakingRegistry");
  const initialWalletBalance = comparing ? 10n ** 19n : matched ? 10n ** 18n : 10n ** 17n;
  const walletContract = sweep?.sharedPaymaster ? "SponsoredHashChainWallet" : "HashChainWallet";
  const wallet = await deploy(walletContract, [owner.address, commitment, BigInt(rounds)], initialWalletBalance);
  const settings = JSON.parse(await readFile(path.join(root, "config.framilier.example.json"), "utf8"));
  if (benchmark) meter = await startTraceMeter(el);
  Object.assign(settings, { rpcEndpoint: meter?.url ?? el, rpcEndpointSubmit: el, stakingRegistryAddress: registry });
  // The pinned node can fail individual receipt lookup for multi-tx private
  // payloads. Relay one per block after the concurrent admission timers finish.
  if (matched) settings.bundleSize = 1;
  const reconciliationSeconds = 2;
  const deferredSeconds = 3600;
  if (comparing) {
    Object.assign(settings, schedulerConfig(sweep.mode));
    settings.bundleInterval = reconciliationSeconds * 1000;
  }
  const configFile = path.join(work, "sidecar.json");
  await writeFile(configFile, JSON.stringify(settings));
  const bun = process.env.FRAMILIER_BUN_BIN || (existsSync(localBun) ? localBun : "bun");
  const api = worker("sidecar", bun, [
    "--bun", path.join(root, "packages/cli/bin/skandha.js"), "standalone",
    "--configFile", configFile, "--dataDir", path.join(work, "db"), "--api.address", "127.0.0.1",
    "--api.port", String(sidecarPort), "--api.ws", "false", "--executor.bundlingMode", "manual",
    "--explorer.enable", "--redirectRpc",
  ]);
  await waitForRpc(api, local);
  const activeScheduler = comparing ? effectiveScheduler(await rpc(local, "skandha_config"), sweep.mode) : null;
  const deposit = async (account = wallet) => {
    const abi = contracts.NaiveStakingRegistry.abi;
    const data = encodeFunctionData({ abi, functionName: "getDepositInfo", args: [account] });
    const encoded = await rpc(el, "eth_call", [{ to: registry, data }, "latest"]);
    const [amount, delay, withdrawal] = decodeFunctionResult({ abi, functionName: "getDepositInfo", data: encoded });
    return { amountWei: amount.toString(), delay: Number(delay), withdrawal: withdrawal.toString() };
  };
  const primary = { wallet, owner, key };
  async function makeFrameTx(gas, verifyData, target = owner.address, value = 0n, bodyData = "0x", identity = primary, nonce, paymaster) {
    return signedWalletFrame({
      paymaster,
      chainId, wallet: identity.wallet, owner: identity.owner.address, key: identity.key,
      nonceSeq: nonce?.seq ?? BigInt(await rpc(el, "eth_getTransactionCount", [identity.wallet, "latest"])),
      nonceKeys: nonce?.keys, verifyState: nonce?.stateGas, gas, verifyData, target, value, bodyData,
    });
  }
  async function reject(tx, expected) {
    try { await rpc(local, "eth_sendFrameTransaction", [tx]); }
    catch (e) {
      assert.ok(e instanceof RpcError, "transport failure does not establish rejection");
      assert.match(e.rpcMessage, expected);
      return { hash: keccak256(encodeRawFrameTx(tx)), code: e.code, reason: e.rpcMessage };
    }
    throw new Error("Sidecar admitted a negative control");
  }
  async function admitAndMine(tx) {
    const expectedHash = keccak256(encodeRawFrameTx(tx));
    assert.equal(await rpc(local, "eth_sendFrameTransaction", [tx]), expectedHash);
    // Only our spawned loopback sidecar can relay to our spawned execution node.
    const results = await producer.receipts([expectedHash], () => rpc(local, "debug_bundler_sendBundleNow"));
    if (comparing) await waitForOnChain(expectedHash);
    return results.get(expectedHash);
  }
  async function waitForOnChain(hash) {
    for (let i = 0; i < 120; i++) {
      if ((await rpc(local, "skandha_frameTransactionStatus", [hash]))?.status === "OnChain") return;
      await pause(250);
    }
    throw new Error("Sidecar did not observe the mined setup transaction: " + hash);
  }
  progressStage("controls");
  const unstakedDeposit = await deposit();
  assert.equal(unstakedDeposit.amountWei, "0");
  const unstaked = await reject(await makeFrameTx(997200n, witness), /BUDGET-010.*limit 100000$/);
  const stakeWei = 12000000000000000n;
  const stakeData = encodeFunctionData({ abi: contracts.NaiveStakingRegistry.abi, functionName: "addStake", args: [86400] });
  const stake = await admitAndMine(await makeFrameTx(70000n, "0x", registry, stakeWei, stakeData));
  const stakedDeposit = await deposit();
  assert.deepEqual(stakedDeposit, { amountWei: stakeWei.toString(), delay: 86400, withdrawal: "0" });
  console.log("The registry records a mined stake from the test wallet.");
  const over = await reject(await makeFrameTx(997201n, witness), /BUDGET-010.*1000001.*limit 1000000/);
  // Accept the literal revert reason or its ABI-encoded UTF-8 bytes.
  const badWitness = await reject(await makeFrameTx(997200n, toHex(0, { size: 32 })), /wrong witness|77726f6e67207769746e657373/i);
  const accepted = await makeFrameTx(997200n, witness);
  const mined = await admitAndMine(accepted);
  const frames = mined.receipt.frameReceipts;
  assert.equal(frames.length, 2);
  for (const frame of frames) assert.equal(frame.status, "0x1");
  const verifyUsed = BigInt(frames[0].gasUsed);
  assert.ok(verifyUsed > 0n && verifyUsed <= 997200n, "unexpected observed VERIFY gas " + verifyUsed);
  if (rounds === 9664) assert.ok(verifyUsed >= 990000n, "default workload should exercise the last one percent of the budget");
  const report = {
    timestamp: new Date().toISOString(), network: "isolated single-node Hegota execution chain",
    chainId, genesisHash: genesisBlock.hash, ethrexSource: "9aa3645d795945c64400f41a70aace0edfa7f383",
    sidecarBuildSha256: await buildDigest(), ethrexBinarySha256: await fileDigest(binary), fixtureArtifactSha256: await fileDigest(path.join(here, "fixtures.json")),
    clientVersion: await rpc(el, "web3_clientVersion"), compiler, owner: owner.address, wallet, registry,
    walletCodeHash: keccak256(await rpc(el, "eth_getCode", [wallet, "latest"])),
    workload: { algorithm: "Keccak-256 hash chain", rounds, witness, commitment },
    stake: { before: unstakedDeposit, after: stakedDeposit, transactionHash: stake.receipt.transactionHash },
    controls: { unstaked, stakedOneOver: over, incorrectWitness: badWitness },
    accepted: { declaredVerifyGas: 997200, signatureGas: 2800, totalDeclaredGas: 1000000,
      actualVerifyGas: Number(verifyUsed), signedTransaction: encodeRawFrameTx(accepted), ...mined },
    producer: { forkchoice: "engine_forkchoiceUpdatedV5", build: "engine_getPayloadV6", import: "engine_newPayloadV6", importStatus: "VALID" },
  };
  if (benchmark) {
    const secondKey = comparing ? sweep.secondKey : generatePrivateKey();
    const secondOwner = privateKeyToAccount(secondKey);
    const secondWallet = await deploy(walletContract, [secondOwner.address, commitment, BigInt(rounds)], 200000000000000000n);
    const second = { wallet: secondWallet, owner: secondOwner, key: secondKey };
    // Give the independent wallet the same stake eligibility. Its timed
    // transactions use only the clean owner-signature verification path.
    const secondStake = await admitAndMine(await makeFrameTx(70000n, "0x", registry, stakeWei, stakeData, second));
    const secondDeposit = await deposit(secondWallet);
    assert.deepEqual(secondDeposit, stakedDeposit, "the two benchmark wallets must have equal locked stake");
    const initialized = [];
    if (matched) {
      // Pay the higher first-write cost before timing. Each competing proof
      // uses a different initialized key, so it cannot replace a sibling.
      for (let first = 1; first <= nonceKeyCount; first += 16) {
        const length = Math.min(16, nonceKeyCount - first + 1);
        const keys = Array.from({ length }, (_, i) => BigInt(first + i));
        const tx = await makeFrameTx(700000n, "0x", owner.address, 0n, "0x", primary,
          { keys, seq: 0n, stateGas: 200000n });
        const { receipt } = await admitAndMine(tx);
        initialized.push(receipt.transactionHash);
      }
      // A mined slot stays reserved locally until the sidecar observes its receipt.
      if (!comparing) {
        for (const hash of initialized) await waitForOnChain(hash);
      }
    }
    // Change one nonzero nibble to another. Correct and incorrect witnesses
    // have the same length and calldata gas cost in the matched experiment.
    const incorrectWitness = "0x" + witness.slice(2).replace(/[1-9a-f]/, c => c === "1" ? "2" : "1");
    assert.notEqual(incorrectWitness, witness);

    const paymaster = sweep?.sharedPaymaster
      ? await deploy("SimplePaymaster", [wallet, secondWallet, registry, stakeWei, 86400], 10n ** 19n)
      : undefined;
    const paymasterStake = paymaster && await deposit(paymaster);
    if (paymaster) {
      assert.deepEqual(paymasterStake, stakedDeposit, "expected the paymaster to have its own locked registry stake");
      const badSponsored = await makeFrameTx(997200n, incorrectWitness, owner.address, 0n, "0x", primary, undefined, paymaster);
      report.controls.sponsoredWrongWitness = await reject(badSponsored, /wrong witness|77726f6e67207769746e657373/i);
    }

    function makeNoisy(kind, serial) {
      if (!matched) return makeFrameTx(997200n, toHex(serial, { size: kind === "early" ? 31 : 32 }));
      return makeFrameTx(997200n, kind === "valid" ? witness : incorrectWitness, owner.address, 0n, "0x", primary,
        { keys: [BigInt(serial)], seq: 1n, stateGas: 200000n }, paymaster);
    }
    const headHash = async () => (await rpc(el, "eth_getBlockByNumber", ["latest", false])).hash;
    const setIntervalSeconds = async seconds => {
      assert.equal(await rpc(local, "debug_bundler_setBundleInterval", [seconds]), "ok");
    };
    progressStage("measure");
    report.benchmark = await measureAdmission({
      local, meter, noisyWallet: wallet, honestWallet: secondWallet,
      sponsorship: paymaster && {
        address: paymaster,
        balance: async () => BigInt(await rpc(el, "eth_getBalance", [paymaster, "latest"])),
      },
      control: matched ? "valid" : "early", makeNoisy,
      sweep: sweep && { rounds: sweep.rounds, bursts: sweep.bursts,
        async beginAdmission() {
          // Our own loopback sidecar also revalidates on its timer in manual mode.
          // Its previous receipts have been observed; measure only fresh admissions.
          await setIntervalSeconds(deferredSeconds);
          return headHash();
        },
        async endAdmission(startHead) {
          try { assert.equal(await headHash(), startHead, "chain head advanced during admission"); }
          finally { await setIntervalSeconds(reconciliationSeconds); }
        },
      },
      stakeCall: comparing ? { to: registry.toLowerCase(), data: encodeFunctionData({ abi: contracts.NaiveStakingRegistry.abi,
        functionName: "getDepositInfo", args: [secondWallet] }).toLowerCase() } : undefined,
      makeHonest: () => makeFrameTx(70000n, "0x", owner.address, 0n, "0x", second, undefined, paymaster),
      async mine(hashes) {
        const mined = await producer.receipts(hashes, () => rpc(local, "debug_bundler_sendBundleNow"));
        if (comparing) await Promise.all(hashes.map(waitForOnChain));
        return mined;
      },
    });
    if (matched) {
      report.benchmark.backgroundWitnesses = { valid: witness, late: incorrectWitness };
      report.benchmark.nonceSetup = { initializedKeys: nonceKeyCount, transactions: initialized };
      report.benchmark.relayBundleSize = settings.bundleSize;
    }
    report.benchmark.completedAt = new Date().toISOString();
    report.benchmark.secondStake = { ...secondDeposit, transactionHash: secondStake.receipt.transactionHash };
    report.benchmark.blockedExternalHttp = network.denied;
    if (paymaster) {
      report.benchmark.sharedPaymaster = paymaster;
      report.benchmark.paymasterStake = { address: paymaster, registry, ...paymasterStake };
    }
    if (comparing) {
      report.benchmark.schedulerReadback = activeScheduler;
      report.benchmark.admissionWindow = { verifyFixedHead: true, requireSidecarOnChain: true,
        deferredIntervalSeconds: deferredSeconds, reconciliationIntervalSeconds: reconciliationSeconds };
    } else console.log("Benchmark summary:", JSON.stringify(report.benchmark.observed));
  }
  progressStage("save");
  const defaultOutput = matched ? "matched-valid-benchmark.json" : benchmark ? "builder-benchmark.json" : "result.json";
  const output = path.resolve(process.env.FRAMILIER_EVIDENCE || path.join(work, defaultOutput));
  await writeFile(output + ".partial", JSON.stringify(report, null, 2) + "\n");
  await rename(output + ".partial", output);
  console.log("Mined", mined.receipt.transactionHash, "in block", mined.block.number, "with VERIFY gas", Number(verifyUsed));
  console.log("Evidence:", output);
} catch (e) {
  console.error("Fixture logs:", work);
  throw e;
} finally {
  await stop();
  await meter?.close();
  await network?.close();
}

