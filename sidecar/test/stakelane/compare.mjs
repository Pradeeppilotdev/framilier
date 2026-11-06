import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkPlan, summarize, workloadDigest } from "./compare-metrics.mjs";
import { useTerminalView } from "./terminal-view.mjs";

const help = `Usage: ./stakelane compare [--bursts 1,4,8] [--rounds 20] [--baseline-only]

Options: --preset quick|full, --output <new-directory>, --json, --plain,
         --order off,fifo,fair (counterbalance order across repeated runs).
In a terminal, see what A’s checks were doing when B started. Use --plain for all rows.
Quick is a smoke check only; full defaults to 20 rounds and bursts 1,4,8.

Start a private loopback chain for each scheduling policy and measure two wallets.
An idle control and one excluded warm-up per burst size are included. Each heavy
transaction must mine with 993,512 VERIFY gas. The output includes B's admission
p50/p95, A's batch completion time, and the path to the JSON evidence.

Use --baseline-only on the original sidecar. The default comparison exits 2 if
FIFO/fair are unavailable, preserving all completed baseline measurements.
Setup: docs/SIDECAR.md (Node, built sidecar, Bun and the pinned ethrex binary).`;

const here = path.dirname(fileURLToPath(import.meta.url));
const usageError = message => { throw new Error(`${message}\n${help}`); };

async function runPolicy(mode, plan, keys, dir, jsonOutput) {
  const output = path.join(dir, `${mode}.json`);
  const child = spawn(process.execPath, [path.join(here, "run.mjs"), "--compare-arm"], {
    env: { ...process.env, STAKELANE_EVIDENCE: output }, stdio: ["pipe", jsonOutput ? 2 : "inherit", "inherit"],
  });
  const interrupt = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const closed = once(child, "close");
    // Node startup can fail before reading stdin. Its exit still decides the result.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ ...plan, ...keys, mode }));
    const [code, signal] = await closed;
    assert.equal(code, 0, `${mode} fixture failed (${signal || code}); see its diagnostic above`);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  return JSON.parse(await readFile(output, "utf8"));
}

async function save(report, dir) {
  const dest = path.join(dir, "comparison.json");
  await writeFile(dest + ".partial", JSON.stringify(report, null, 2) + "\n");
  await rename(dest + ".partial", dest);
}

function table(report) {
  const columns = ["Policy", "A burst", "Rounds", "B p50 ms", "B p95 ms", "A batch p50 ms", "A batch p95 ms", "A mined", "B mined"];
  const rows = [columns];
  for (const result of Object.values(report.policies)) {
    if (result.status !== "measured") continue;
    for (const r of result.summary) {
      rows.push([result.schedulerReadback?.mode ?? "default", String(r.burst), String(r.n), r.bAdmissionMs.p50.toFixed(1), r.bAdmissionMs.p95.toFixed(1),
        r.aBatchMs ? r.aBatchMs.p50.toFixed(1) : "—", r.aBatchMs ? r.aBatchMs.p95.toFixed(1) : "—", String(r.aMined), String(r.bMined)]);
    }
  }
  const widths = columns.map((_, i) => Math.max(...rows.map(row => row[i].length)));
  for (const row of rows) console.log(row.map((cell, i) => i ? cell.padStart(widths[i]) : cell.padEnd(widths[i])).join("  "));
  for (const [mode, result] of Object.entries(report.policies)) {
    if (result.status === "unavailable") console.log(`${mode}: unavailable — ${result.reason}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") return console.log(help);
  if (command !== "compare") usageError("Expected the compare command.");
  const { values } = parseArgs({ args, options: {
    help: { type: "boolean", short: "h" }, "baseline-only": { type: "boolean" },
    bursts: { type: "string" }, rounds: { type: "string" },
    preset: { type: "string", default: "full" }, output: { type: "string" }, json: { type: "boolean" }, plain: { type: "boolean" },
    order: { type: "string", default: "off,fifo,fair" },
  } });
  if (values.help) return console.log(help);
  assert.ok(["quick", "full"].includes(values.preset), "preset must be quick or full");
  const plan = { rounds: Number(values.rounds ?? (values.preset === "quick" ? 2 : 20)),
    bursts: (values.bursts ?? (values.preset === "quick" ? "1,4" : "1,4,8")).split(",").map(Number) };
  checkPlan(plan.rounds, plan.bursts);
  const order = values.order.split(",");
  assert.deepEqual([...order].sort(), ["fair", "fifo", "off"], "order must contain off,fifo,fair exactly once");
  const { doctor, printTerminalReport, selectDisplayTrials } = await import("./operator.mjs");
  const prerequisites = await doctor();
  const missing = prerequisites.checks.filter(check => !check.ok);
  if (missing.length) {
    console.error("Cannot start comparison:\n" + missing.map(check => `${check.name}: ${check.detail}\n  Fix: ${check.fix}`).join("\n"));
    process.exitCode = 2;
    return;
  }
  const runtime = path.resolve(here, "../../.runtime");
  await mkdir(runtime, { recursive: true });
  let dir;
  if (values.output) {
    dir = path.resolve(values.output);
    await mkdir(path.dirname(dir), { recursive: true });
    await mkdir(dir); // Refuse to overwrite or combine prior measurements.
  } else dir = await mkdtemp(path.join(runtime, "compare-"));
  const log = (...args) => (values.json ? console.error : console.log)(...args);
  if (plan.rounds < 20) log("SMOKE ONLY: fewer than 20 rounds; tail percentiles are descriptive, not a latency study.");
  const { generatePrivateKey } = await import("viem/accounts");
  const keys = { primaryKey: generatePrivateKey(), secondKey: generatePrivateKey() };
  const modes = values["baseline-only"] ? ["off"] : order;
  const report = { format: 1, status: "running", startedAt: new Date().toISOString(), chainId: 8141337,
    preset: values.preset, interpretation: plan.rounds < 20 ? "smoke-only" : "exploratory-local",
    host: { os: platform(), arch: arch(), node: process.version, ethrexWorkers: 4 }, ...plan, requestedModes: modes, policies: {} };
  let reference;
  const trialsByMode = !values.json && useTerminalView(process.stdout, values.plain) ? {} : null;
  log("Comparison evidence:", path.join(dir, "comparison.json"));
  for (const [index, mode] of modes.entries()) {
    if (mode !== "off" && report.policies.off?.schedulerReadback === null) {
      report.policies[mode] = { status: "unavailable", reason: "skandha_config did not report an active admission scheduler" };
      continue;
    }
    const phase = trialsByMode ? `[${index + 1}/${modes.length}] ` : "";
    log(`${phase}Starting ${mode === "off" ? "baseline" : mode} on a fresh private chain (${plan.rounds} rounds per burst).`);
    // A disconnected or killed process can leave this manifest, without a final summary.
    report.policies[mode] = { status: "in-progress" };
    await save(report, dir);
    try {
      const run = await runPolicy(mode, plan, keys, dir, values.json);
      const b = run.benchmark;
      assert.equal(run.chainId, report.chainId);
      assert.ok(b.blockedExternalHttp.some(e => e.authority === "api.github.com:443"), "missing loopback isolation check");
      const inputs = { genesisHash: run.genesisHash, sidecarBuildSha256: run.sidecarBuildSha256, ethrexBinarySha256: run.ethrexBinarySha256,
        fixtureArtifactSha256: run.fixtureArtifactSha256, signedWorkloadSha256: workloadDigest(b) };
      if (reference) assert.deepEqual(inputs, reference, "mode ran different transactions, genesis, binary or fixtures");
      else reference = inputs;
      report.policies[mode] = { status: "measured", schedulerReadback: b.schedulerReadback, ...inputs,
        evidenceFile: `${mode}.json`, summary: summarize(b.trials, plan.rounds, plan.bursts, b.schedulerReadback) };
      await save(report, dir);
      if (trialsByMode) {
        trialsByMode[mode] = selectDisplayTrials(b.trials, plan.bursts);
        const mined = report.policies[mode].summary.reduce((total, row) => total + row.aMined + row.bMined, 0);
        log(`${phase}${mode} complete · ${mined} measured transactions mined`);
      }
    } catch (err) {
      report.policies[mode] = { status: "failed", reason: err.message };
      report.status = "failed";
      await save(report, dir);
      throw err;
    }
  }
  const partial = modes.some(mode => report.policies[mode].status !== "measured");
  report.status = partial ? "incomplete" : values["baseline-only"] ? "baseline-only" : "complete";
  report.completedAt = new Date().toISOString();
  await save(report, dir);
  if (values.json) console.log(JSON.stringify(report));
  else {
    if (trialsByMode && !partial) printTerminalReport(report, trialsByMode, "live");
    else table(report);
    log("Evidence:", path.join(dir, "comparison.json"));
  }
  if (partial) process.exitCode = 2;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
