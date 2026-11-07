import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readReport } from "./report.mjs";

const archive = fileURLToPath(new URL("../sidecar/evidence/compare/merged-main-7d052e7/", import.meta.url));

test("reports verified metrics and observed trace order for the first eight-transaction round", async () => {
  const report = await readReport(archive, "replay");
  assert.equal(report.source, "replay");
  assert.equal(report.chainId, 8141337);
  assert.equal(report.rounds, 20);
  assert.equal(report.burst, 8);
  const { fifo, fair } = report.policies;
  assert.equal(fifo.bAdmissionMs.p95, 678.001);
  assert.equal(fair.bAdmissionMs.p95, 238.178);
  for (const [policy, expectedFinished] of [[fifo, 8], [fair, 2]]) {
    const b = policy.timeline.find(e => e.wallet === "B");
    const a = policy.timeline.filter(e => e.wallet === "A");
    assert.equal(a.length, 8);
    assert.equal(a.filter(e => e.endMs <= b.startMs).length, expectedFinished);
    assert.deepEqual(policy.timeline.map(e => e.startMs), policy.timeline.map(e => e.startMs).sort((x, y) => x - y));
  }
});

test("keeps unavailable trace timing distinct from a failed evidence check", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "framilier-live-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(archive, dir, { recursive: true });
  const rawFile = path.join(dir, "fair.json");
  const raw = JSON.parse(await readFile(rawFile, "utf8"));
  const trial = raw.benchmark.trials.find(row => row.round === 0 && row.burst === 8);
  delete trial.background[0].traceStartRelativeToHonestMs;
  await writeFile(rawFile, JSON.stringify(raw));
  const report = await readReport(dir, "live");
  assert.equal(report.policies.fair.timeline, null);
  assert.equal(report.policies.fair.bAdmissionMs.p95, 238.178);
  delete trial.background[0].mined.blockHash;
  await writeFile(rawFile, JSON.stringify(raw));
  await assert.rejects(readReport(dir, "live"));
});
