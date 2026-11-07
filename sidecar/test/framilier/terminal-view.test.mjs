import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { renderTerminalReport, useTerminalView } from "./terminal-view.mjs";

const evidence = new URL("../../evidence/compare/", import.meta.url);
const publishedDirectory = new URL("merged-main-7d052e7/", evidence);
const operator = fileURLToPath(new URL("./operator.mjs", import.meta.url));
const options = { source: "saved", columns: 100, color: false };

async function load(directory) {
  const read = async file => JSON.parse(await readFile(new URL(file, directory), "utf8"));
  const report = await read("comparison.json");
  const samples = {};
  for (const [mode, arm] of Object.entries(report.policies)) {
    if (arm.status !== "measured") continue;
    const { benchmark } = await read(arm.evidenceFile);
    samples[mode] = benchmark.trials.filter(t => t.round === 0 && t.burst === Math.max(...report.bursts));
  }
  return { report, samples };
}

function states(view, mode, finished, running, pending) {
  const sections = view.replace(/\s+/g, " ").split(/\b(off|fifo|fair|default)\b/i);
  const counts = new RegExp(`\\b${finished} finished.*?\\b${running} running.*?\\b${pending} yet to start`, "i");
  const match = sections.some((label, i) => i % 2 === 1 && label.toLowerCase() === mode && counts.test(sections[i + 1]));
  assert.ok(match, `missing ${mode} state counts ${finished}/${running}/${pending}\n${view}`);
}

test("terminal selection keeps redirects, --plain, and dumb terminals readable", () => {
  const old = process.env.TERM;
  try {
    process.env.TERM = "xterm-256color";
    assert.ok(useTerminalView({ isTTY: true }, false));
    assert.ok(!useTerminalView({ isTTY: true }, true));
    assert.ok(!useTerminalView({}, false));
    process.env.TERM = "dumb";
    assert.ok(!useTerminalView({ isTTY: true }, false));
  } finally {
    if (old === undefined) delete process.env.TERM;
    else process.env.TERM = old;
  }
});

test("published FIFO and fair snapshots show what A was doing when B started checking", async () => {
  const { report, samples } = await load(publishedDirectory);
  const view = renderTerminalReport(report, samples, options);
  assert.doesNotMatch(view, /\x1b/);
  assert.match(view, /round\s+1\b/i);
  assert.match(view, /burst\s+8\b/i);
  states(view, "off", 5, 3, 0);
  states(view, "fifo", 8, 0, 0);
  states(view, "fair", 2, 0, 6);
  assert.match(view, /\b678(?:\.0)?\b/);
  assert.match(view, /\b238(?:\.2)?\b/);
  const narrow = renderTerminalReport(report, samples, { ...options, columns: 50 });
  assert.ok(narrow.split("\n").every(line => line.length <= 50), "a narrow terminal should not horizontally wrap the report");
  states(narrow, "fair", 2, 0, 6);
});

test("single-round demos show an observed admission time and mark the sample as smoke", async () => {
  const { report, samples } = await load(new URL("pr4-macos-smoke/", evidence));
  const view = renderTerminalReport(report, samples, { ...options, source: "live" });
  assert.match(view, /live run/i);
  assert.match(view, /smoke run/i);
  assert.match(view, /B time/i);
  assert.doesNotMatch(view, /B p95/i);
  assert.match(view, /18 recorded inclusions/i);
});

test("admission headings align with the B timing value at wide widths and stay inline at narrow widths", async () => {
  for (const [directory, metric] of [[publishedDirectory, "B p95"], [new URL("pr4-macos-smoke/", evidence), "B time"]]) {
    const { report, samples } = await load(directory);
    for (const columns of [70, 96]) {
      const lines = renderTerminalReport(report, samples, { ...options, columns }).split("\n");
      const heading = lines.findIndex(line => line.trimStart().startsWith("Policy "));
      assert.notEqual(heading, -1);
      const value = /[\d.]+ ms/.exec(lines[heading + 1]);
      assert.ok(value);
      assert.equal(lines[heading].indexOf(metric) + metric.length, value.index + value[0].length);
    }
    const narrow = renderTerminalReport(report, samples, { ...options, columns: 50 });
    assert.match(narrow, new RegExp("Off\\s+" + metric + " [\\d.]+ ms"));
  }
});

test("trace boundaries use observed timestamps and incomplete timings never imply a scheduling order", async () => {
  const { report, samples } = await load(publishedDirectory);
  const t = samples.fair[0];
  t.beforeHonestTraceMs = 10;
  const intervals = [[6, 10], [3, 8], [10, 10], [10, 14], [9, 11], [11, 12], [12, 13], [15, 16]];
  for (const [index, [start, end]] of intervals.entries()) {
    t.background[index].traceStartRelativeToHonestMs = start;
    t.background[index].traceEndRelativeToHonestMs = end;
  }
  states(renderTerminalReport(report, samples, options), "fair", 3, 2, 3);
  for (const invalidEnd of [null, 5]) {
    t.background[0].traceEndRelativeToHonestMs = invalidEnd;
    const view = renderTerminalReport(report, samples, options);
    assert.match(view, /fair[^\n]*(?:\n[^\n]*){0,2}trace timing unavailable/i);
    states(view, "fifo", 8, 0, 0);
  }
});

test("legacy default baseline and unavailable policies stay distinguishable without terminal injection", async () => {
  const { report, samples } = await load(new URL("run-1/", evidence));
  report.policies.fifo.reason = "cannot read\x1b]52;c;payload\x07\x1b[2J";
  const view = renderTerminalReport(report, samples, options);
  assert.match(view, /default/i);
  assert.match(view, /incomplete/i);
  assert.match(view, /unavailable/i);
  assert.doesNotMatch(view, /[\x00-\x08\x0b-\x1f\x7f]/);
});

test("report chooses the visual only on a terminal; --plain and --json keep their contracts", () => {
  function invoke(flags, tty) {
    const setup = "Object.defineProperties(process.stdout,{isTTY:{value:true},columns:{value:90}})";
    const preload = tty ? ["--import", `data:text/javascript,${encodeURIComponent(setup)}`] : [];
    const command = [...preload, operator, "report", fileURLToPath(publishedDirectory), "--verify", ...flags];
    const result = spawnSync(process.execPath, command, { encoding: "utf8", env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  const plain = invoke([], false);
  assert.match(plain, /fifo burst=8 n=20/);
  assert.equal(invoke(["--plain"], true), plain);
  states(invoke([], true), "fair", 2, 0, 6);
  const json = invoke(["--json"], true);
  assert.equal(invoke(["--json"], false), json);
  assert.equal(JSON.parse(json).measuredPolicies, 3);
});


test("scenario, sample size and sponsor evidence remain clear across terminal widths", async () => {
  for (const directory of [publishedDirectory, new URL("shared-paymaster-smoke/", evidence)]) {
    const { report, samples } = await load(directory);
    for (const columns of [32, 40, 50, 70, 80, 96]) {
      const view = stripVTControlCharacters(renderTerminalReport(report, samples, { ...options, columns, color: true }));
      assert.ok(view.split("\n").every(line => line.length <= columns), `overflow at ${columns}`);
      const text = view.replace(/\s+/g, " ");
      assert.match(text, /Wallet A: \d+ heavy checks \+ Wallet B: 1 cheap check/);
      assert.match(text, /submission to acceptance; mining is checked afterward/);
      assert.match(text, /Each tile is an A check, grouped by its state/);
      assert.match(text, /all measured loads and policies, including idle/);
      if (report.sharedPaymaster) {
        assert.match(text, /shared paymaster for both wallets/);
        assert.match(text, /Receipt payer, sponsor fees and stake checked/);
        assert.doesNotMatch(text, /each wallet pays/);
      } else {
        assert.match(text, /each wallet pays its own/);
        assert.doesNotMatch(text, /Receipt payer/);
      }
    }
  }
});

test("fair comparison reports the benefit and batch cost without promising a win", async () => {
  const { report, samples } = await load(publishedDirectory);
  const fair = report.policies.fair.summary.find(row => row.burst === 8);
  const fifo = report.policies.fifo.summary.find(row => row.burst === 8);
  const view = () => renderTerminalReport(report, samples, options);
  assert.match(view(), /B p95: 64\.9% lower \(439\.8 ms less\)/);
  assert.match(view(), /A batch median: 4\.9% longer \(28\.9 ms more\)/);
  fair.bAdmissionMs.p95 = fifo.bAdmissionMs.p95 * 2;
  fair.aBatchMs.p50 = fifo.aBatchMs.p50 / 2;
  assert.match(view(), /B p95: 100\.0% higher/);
  assert.match(view(), /A batch median: 50\.0% shorter/);
  fair.bAdmissionMs.p95 = fifo.bAdmissionMs.p95;
  assert.match(view(), /B p95: unchanged/);
  fifo.bAdmissionMs.p95 = 0;
  assert.match(view(), /B p95: higher \(678\.0 ms more\)/);
  assert.doesNotMatch(view(), /Infinity|NaN/);
  fifo.bAdmissionMs.p95 = 100.049;
  fair.bAdmissionMs.p95 = 100.051;
  assert.match(view(), /B p95: difference below 0\.1 ms/);
  report.policies.fifo = { status: "failed" };
  assert.doesNotMatch(view(), /Fair vs FIFO at this load/);
});

test("short multi-round runs use medians and never imply a p95 study", async () => {
  const { report, samples } = await load(publishedDirectory);
  report.rounds = 2;
  const view = renderTerminalReport(report, samples, options);
  assert.match(view, /B median/);
  assert.match(view, /Round 1 of 2/);
  assert.match(view, /2 rounds show medians/);
  assert.doesNotMatch(view, /B p95/);
});
