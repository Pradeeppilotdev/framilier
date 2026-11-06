import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize, workloadDigest, effectiveScheduler } from "./compare-metrics.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const help = `StakeLane — measure admission latency and its throughput trade-off

  ./stakelane doctor [--json]                  Check local dependencies; sends nothing
  ./stakelane compare --preset quick           Smoke test (2 rounds; not a p95 study)
  ./stakelane compare --preset full --output ./results/run-001
  ./stakelane report ./results/run-001 --verify [--json]

Compare uses disposable loopback chains, never the public devnet.
Full comparison: 20 rounds at bursts 1,4,8; run --help for all options.
Setup and binary pins: docs/SIDECAR.md`;

export async function doctor() {
  const checks = [];
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node", ok: nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 12), detail: process.version, fix: "Install Node.js 20.12+ (24 LTS recommended)." });
  const binaries = [
    ["Bun", process.env.STAKELANE_BUN_BIN || "bun", ["--version"], "Install Bun 1.3.14 or set STAKELANE_BUN_BIN."],
    ["ethrex", process.env.STAKELANE_ETHREX_BIN || path.join(root, ".runtime/bin/ethrex"), ["--version"], "Set STAKELANE_ETHREX_BIN to ethrex commit 9aa3645d795945c64400f41a70aace0edfa7f383."],
  ];
  for (const [name, command, args, fix] of binaries) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000 });
    const detail = (result.stdout || result.stderr || result.error?.message || "unavailable").trim();
    const pinOK = name === "ethrex" ? detail.includes("9aa3645") : /^1\.3\.14\b/.test(detail);
    checks.push({ name, ok: result.status === 0 && pinOK, detail, fix });
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

export async function verifyReport(directory) {
  const dir = path.resolve(directory);
  const comparison = JSON.parse(await readFile(path.join(dir, "comparison.json"), "utf8"));
  assert.equal(comparison.format, 1, "unsupported report format");
  assert.equal(comparison.chainId, 8141337, "unexpected evidence chain");
  const modes = ["off", "fifo", "fair"];
  assert.ok(["complete", "baseline-only", "incomplete", "failed", "running"].includes(comparison.status), "unknown report status");
  assert.ok(Array.isArray(comparison.requestedModes) && comparison.requestedModes.length > 0 &&
    comparison.requestedModes.every(mode => modes.includes(mode)) &&
    new Set(comparison.requestedModes).size === comparison.requestedModes.length, "invalid requested modes");
  assert.ok(comparison.policies && typeof comparison.policies === "object" && !Array.isArray(comparison.policies), "invalid policies");
  for (const [mode, arm] of Object.entries(comparison.policies)) {
    assert.ok(comparison.requestedModes.includes(mode), "unrequested policy");
    assert.ok(arm && ["measured", "failed", "unavailable", "in-progress"].includes(arm.status), "unknown policy status");
  }
  if (comparison.status === "baseline-only") {
    assert.deepEqual(comparison.requestedModes, ["off"], "baseline-only must request only off");
    assert.deepEqual(Object.keys(comparison.policies), ["off"], "baseline-only must contain only off");
    assert.equal(comparison.policies.off.status, "measured", "baseline-only requires measured off policy");
  }
  let reference;
  let measured = 0;
  for (const [mode, arm] of Object.entries(comparison.policies)) {
    if (arm.status !== "measured") continue;
    assert.ok(["off", "fifo", "fair"].includes(mode), "unknown policy");
    assert.equal(arm.evidenceFile, `${mode}.json`, "unexpected evidence file");
    const raw = JSON.parse(await readFile(path.join(dir, arm.evidenceFile), "utf8"));
    assert.equal(raw.chainId, comparison.chainId);
    const benchmark = raw.benchmark;
    const scheduler = effectiveScheduler({ admissionScheduler: benchmark.schedulerReadback }, mode);
    assert.deepEqual(arm.schedulerReadback, scheduler);
    for (const field of ["genesisHash", "ethrexBinarySha256", "fixtureArtifactSha256"]) assert.equal(raw[field], arm[field], field);
    if (arm.sidecarBuildSha256) assert.equal(raw.sidecarBuildSha256, arm.sidecarBuildSha256, "sidecar build mismatch");
    assert.equal(workloadDigest(benchmark), arm.signedWorkloadSha256, "signed input fingerprint mismatch");
    assert.deepEqual(summarize(benchmark.trials, comparison.rounds, comparison.bursts, scheduler), arm.summary, "summary differs from samples");
    const pins = [arm.genesisHash, arm.ethrexBinarySha256, arm.fixtureArtifactSha256, arm.signedWorkloadSha256, arm.sidecarBuildSha256 ?? null];
    if (reference) assert.deepEqual(pins, reference, "policies used different inputs");
    else reference = pins;
    measured++;
  }
  assert.ok(measured, "no measured policies");
  if (comparison.status === "complete") {
    assert.deepEqual([...comparison.requestedModes].sort(), ["fair", "fifo", "off"]);
    assert.equal(measured, 3, "complete comparison requires three measured policies");
  }
  return { status: comparison.status, verified: true, measuredPolicies: measured,
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
    assert.ok(directory && !directory.startsWith("-") && flags.every(f => ["--verify", "--json"].includes(f)), "Usage: ./stakelane report <directory> --verify [--json]");
    const result = await verifyReport(directory);
    if (flags.includes("--json")) console.log(JSON.stringify(result));
    else {
      console.log(`Verified ${result.measuredPolicies} measured policies. Status: ${result.status}`);
      for (const [mode, arm] of Object.entries(result.comparison.policies)) {
        for (const row of arm.summary ?? []) console.log(`${mode} burst=${row.burst} n=${row.n} B p50=${row.bAdmissionMs.p50}ms p95=${row.bAdmissionMs.p95}ms A batch p50=${row.aBatchMs?.p50 ?? "n/a"}ms p95=${row.aBatchMs?.p95 ?? "n/a"}ms`);
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
