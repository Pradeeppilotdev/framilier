import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlan, summarize, workloadDigest, effectiveScheduler } from "./compare-metrics.mjs";
import { renderTerminalReport, useTerminalView } from "./terminal-view.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const help = `framilier — measure admission latency and its throughput trade-off

  ./framilier live                            Serve the browser demo on localhost
  ./framilier doctor [--json]                  Check local dependencies; sends nothing
  ./framilier compare --preset quick           Smoke test (2 rounds; not a p95 study)
  ./framilier compare --preset full --output ./results/run-001
  ./framilier report ./results/run-001 --verify [--json|--plain]

In a terminal, compare and report show when wallet B got a turn. Use --plain for all rows.
Compare uses disposable loopback chains, never the public devnet.
Full comparison: 20 rounds at bursts 1,4,8; run --help for all options.
Setup and binary pins: docs/SIDECAR.md`;

// Source builds produced with VERGEN_IDEMPOTENT may omit the revision in --version.
// This is the pinned Apple Silicon executable fingerprint in private-inclusion.json.
const macEthrexSha256 = "0d52c5f2c241e20a68040d0a88006299bfca89a414be18a0ea26ca4ec869f692";
const ethrexRevision = "9aa3645d795945c64400f41a70aace0edfa7f383";

export async function ethrexProvenance(command, version, source = ethrexRevision) {
  const revisions = version.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  if (revisions.some(revision => source.startsWith(revision))) return "reported revision";
  if (!version.includes("VERGEN_IDEMPOTENT_OUTPUT")) return null;
  const hash = createHash("sha256");
  let binary;
  try {
    binary = await realpath(command);
    for await (const chunk of createReadStream(binary)) hash.update(chunk);
  } catch {
    return null;
  }
  if (hash.digest("hex") === macEthrexSha256) return "recorded binary SHA-256";

  // A fresh debug build can embed local paths. Its source checkout supplies
  // local provenance only; compare separately records the actual binary hash.
  const checkout = path.resolve(path.dirname(binary), "../..");
  if (binary !== path.join(checkout, "target", "debug", "ethrex")) return null;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (...args) => spawnSync("git", ["--no-optional-locks", "-C", checkout, ...args],
    { encoding: "utf8", timeout: 10000, env });
  const revision = git("rev-parse", "--show-toplevel", "HEAD");
  if (revision.status !== 0 || revision.stdout.trimEnd() !== `${checkout}\n${source}`) return null;
  const tracked = git("status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=none");
  return tracked.status === 0 && tracked.stdout === "" ? "local build path in clean pinned source checkout" : null;
}

export async function doctor() {
  const checks = [];
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node", ok: nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 12), detail: process.version, fix: "Install Node.js 20.12+ (24 LTS recommended)." });
  const localBun = path.join(root, ".runtime/bin/bun");
  const bun = process.env.FRAMILIER_BUN_BIN || (existsSync(localBun) ? localBun : "bun");
  const ethrex = process.env.FRAMILIER_ETHREX_BIN || path.join(root, ".runtime/bin/ethrex");
  for (const [name, command, fix] of [
    ["Bun", bun, "Install Bun 1.3.14 or newer in the 1.x series, or set FRAMILIER_BUN_BIN."],
    ["ethrex", ethrex, "Set FRAMILIER_ETHREX_BIN to ethrex commit 9aa3645d795945c64400f41a70aace0edfa7f383."],
  ]) {
    const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10000 });
    const detail = (result.stdout || result.stderr || result.error?.message || "unavailable").trim();
    const bunVersion = /^1\.(\d+)\.(\d+)$/.exec(detail);
    const provenance = name === "ethrex" && result.status === 0 ? await ethrexProvenance(command, detail) : null;
    const valid = name === "ethrex" ? provenance
      : bunVersion && (Number(bunVersion[1]) > 3 || (Number(bunVersion[1]) === 3 && Number(bunVersion[2]) >= 14));
    checks.push({ name, ok: result.status === 0 && Boolean(valid), detail: provenance ? `${detail} (${provenance})` : detail, fix });
  }
  for (const [name, file, fix] of [
    ["Dependencies", "node_modules/viem/package.json", "cd sidecar && bun install --frozen-lockfile"],
    ["Built sidecar", "packages/executor/lib/services/FrameTxSimulationService/index.js", "cd sidecar && bun run build"],
    ["Built CLI", "packages/cli/lib/cli.js", "cd sidecar && bun run build"],
  ]) {
    let ok = true;
    try { await access(path.join(root, file), constants.R_OK); } catch { ok = false; }
    checks.push({ name, ok, detail: file, fix });
  }
  return { status: checks.every(c => c.ok) ? "ready" : "not-ready", checks };
}

function verifyTrialRecords(benchmark, bursts) {
  assert.deepEqual(benchmark.warmup.map(t => [t.round, t.burst]), [0, ...bursts].map(n => [-1, n]), "missing or unexpected warm-up");
  const hash32 = /^0x[0-9a-f]{64}$/i;
  const seen = new Set();
  for (const trial of [...benchmark.warmup, ...benchmark.trials]) {
    assert.equal(trial.background.length, trial.burst);
    assert.match(trial.honestBlockHash, hash32, "missing probe receipt block");
    assert.ok(Number.isSafeInteger(trial.honestBlock) && trial.honestBlock >= 0, "missing probe receipt height");
    assert.ok(Number.isInteger(trial.peakTraces) && trial.peakTraces >= 1 && trial.peakTraces <= trial.burst + 1, "invalid trace count");
    assert.ok(Number.isInteger(trial.peakBackgroundTraces) && trial.peakBackgroundTraces >= 0 &&
      trial.peakBackgroundTraces <= Math.min(trial.peakTraces, trial.burst), "invalid background trace count");
    for (const hash of [trial.honestHash, ...trial.background.map(a => a.hash)]) {
      assert.match(hash, hash32, "invalid signed hash");
      assert.ok(!seen.has(hash.toLowerCase()), "reused signed input");
      seen.add(hash.toLowerCase());
    }
    for (const a of trial.background) {
      assert.equal(a.outcome, "admitted");
      assert.equal(a.mined?.verifyGas, 993512);
      assert.match(a.mined.blockHash, hash32, "missing heavy receipt block");
      assert.ok(Number.isSafeInteger(a.mined.blockNumber) && a.mined.blockNumber >= 0, "missing heavy receipt height");
    }
    if (benchmark.admissionWindow?.verifyFixedHead) {
      assert.match(trial.admissionHeadHash, hash32, "missing fixed admission head");
      if (trial.burst) {
        const first = Math.min(...trial.background.map(a => a.submitStartRelativeToHonestMs));
        const last = Math.max(...trial.background.map(a => a.responseEndRelativeToHonestMs));
        assert.ok(Math.abs(last - first - trial.backgroundBatchMs) < 0.0021, "batch time differs from recorded admission timestamps");
      }
    }
  }
}

export function selectDisplayTrials(trials, bursts) {
  const largest = Math.max(...bursts);
  return trials.filter(trial => trial.round === 0 && trial.burst === largest);
}

export function printTerminalReport(report, trialsByMode, source) {
  console.log(renderTerminalReport(report, trialsByMode, {
    source,
    columns: process.stdout.columns,
    color: !Object.hasOwn(process.env, "NO_COLOR") && Boolean(process.stdout.hasColors?.()),
  }));
}

export async function verifyReport(directory, trialsByMode) {
  const dir = path.resolve(directory);
  const comparison = JSON.parse(await readFile(path.join(dir, "comparison.json"), "utf8"));
  assert.equal(comparison.format, 1, "unsupported report format");
  assert.equal(comparison.chainId, 8141337, "unexpected evidence chain");
  checkPlan(comparison.rounds, comparison.bursts);
  const requested = comparison.requestedModes;
  assert.ok(Array.isArray(requested), "invalid requested modes");
  assert.ok(comparison.policies && typeof comparison.policies === "object" && !Array.isArray(comparison.policies), "invalid policies");
  const fullOrder = ["fair", "fifo", "off"];
  const onlyBaseline = requested?.length === 1 && requested[0] === "off";
  if (!onlyBaseline) assert.deepEqual([...requested].sort(), fullOrder, "invalid requested policies");
  assert.ok(["running", "failed", "incomplete", "baseline-only", "complete"].includes(comparison.status), "unknown report status");
  let reference;
  let measured = 0;
  for (const [mode, arm] of Object.entries(comparison.policies)) {
    assert.ok(requested.includes(mode), "unrequested policy");
    assert.ok(["in-progress", "unavailable", "failed", "measured"].includes(arm.status), "unknown policy status");
    if (arm.status !== "measured") {
      assert.equal(arm.summary, undefined, "unmeasured policy has a summary");
      continue;
    }
    assert.equal(arm.evidenceFile, `${mode}.json`, "unexpected evidence file");
    const raw = JSON.parse(await readFile(path.join(dir, arm.evidenceFile), "utf8"));
    assert.equal(raw.chainId, comparison.chainId);
    const benchmark = raw.benchmark;
    verifyTrialRecords(benchmark, comparison.bursts);
    const scheduler = effectiveScheduler({ admissionScheduler: benchmark.schedulerReadback }, mode);
    assert.deepEqual(arm.schedulerReadback, scheduler);
    assert.match(arm.genesisHash, /^0x[0-9a-f]{64}$/i, "missing genesis fingerprint");
    assert.equal(raw.genesisHash, arm.genesisHash, "genesis mismatch");
    const buildPins = ["ethrexBinarySha256", "fixtureArtifactSha256"];
    if (comparison.preset || Object.hasOwn(raw, "sidecarBuildSha256") || Object.hasOwn(arm, "sidecarBuildSha256")) buildPins.push("sidecarBuildSha256");
    for (const field of buildPins) {
      assert.match(arm[field], /^[0-9a-f]{64}$/i, field);
      assert.equal(raw[field], arm[field], field);
    }
    assert.equal(workloadDigest(benchmark), arm.signedWorkloadSha256, "signed input fingerprint mismatch");
    assert.deepEqual(summarize(benchmark.trials, comparison.rounds, comparison.bursts, scheduler), arm.summary, "summary differs from samples");
    const pins = [arm.genesisHash, arm.ethrexBinarySha256, arm.fixtureArtifactSha256, arm.signedWorkloadSha256, arm.sidecarBuildSha256 ?? null];
    if (reference) assert.deepEqual(pins, reference, "policies used different inputs");
    else reference = pins;
    if (trialsByMode) trialsByMode[mode] = selectDisplayTrials(benchmark.trials, comparison.bursts);
    measured++;
  }
  if (comparison.status === "complete") assert.ok(!onlyBaseline && measured === 3, "complete comparison requires three measured policies");
  if (comparison.status === "baseline-only") assert.ok(onlyBaseline && measured === 1, "baseline-only requires exactly one requested and measured off policy");
  return { status: comparison.status, verified: comparison.status === "complete" || comparison.status === "baseline-only", measuredPolicies: measured,
    limitation: "Verifies saved arithmetic and input consistency; does not independently prove historical chain execution.", comparison };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") return console.log(help);
  if (command === "compare") return import("./compare.mjs");
  if (command === "doctor") {
    assert.ok(args.every(a => a === "--json"), "doctor accepts only --json");
    const result = await doctor();
    if (args.includes("--json")) console.log(JSON.stringify(result));
    else for (const check of result.checks) console.log(`${check.ok ? "OK" : "MISSING"} ${check.name}: ${check.detail}${check.ok ? "" : `\n  Fix: ${check.fix}`}`);
    if (result.status !== "ready") process.exitCode = 2;
    return;
  }
  if (command === "report") {
    const [directory, ...flags] = args;
    assert.ok(directory && !directory.startsWith("-") && flags.every(f => ["--verify", "--json", "--plain"].includes(f)), "Usage: ./framilier report <directory> --verify [--json|--plain]");
    const json = flags.includes("--json");
    const trialsByMode = !json && useTerminalView(process.stdout, flags.includes("--plain")) ? {} : null;
    const result = await verifyReport(directory, trialsByMode);
    if (json) console.log(JSON.stringify(result));
    else if (trialsByMode && result.verified) printTerminalReport(result.comparison, trialsByMode, "saved");
    else {
      console.log(`Verified ${result.measuredPolicies} measured policies. Status: ${result.status}`);
      for (const [mode, arm] of Object.entries(result.comparison.policies)) {
        for (const row of arm.summary ?? []) {
          const batch = row.aBatchMs ? `p50=${row.aBatchMs.p50}ms p95=${row.aBatchMs.p95}ms` : "n/a";
          console.log(`${mode} burst=${row.burst} n=${row.n} B p50=${row.bAdmissionMs.p50}ms p95=${row.bAdmissionMs.p95}ms A batch ${batch}`);
        }
      }
      console.log(result.limitation);
    }
    if (!["complete", "baseline-only"].includes(result.status)) process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown command: ${command}\n${help}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
