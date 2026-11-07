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

test("receipt examples and inclusion totals have explicit scope for both scenarios", async () => {
  const self = await readReport(archive, "replay");
  assert.equal(self.scenario, "self-paid");
  assert.equal(self.evidence.totalMined, 1020);
  assert.equal(self.evidence.paymaster, null);
  assert.equal(self.evidence.sponsorshipChecked, false);
  assert.equal(self.policies.fair.evidence.receipts.length, 9);
  assert.equal(self.policies.fair.evidence.minedCount, 340);
  const sponsorArchive = fileURLToPath(new URL("../sidecar/evidence/compare/shared-paymaster-smoke/", import.meta.url));
  const sponsored = await readReport(sponsorArchive, "replay");
  assert.equal(sponsored.scenario, "shared-paymaster");
  assert.equal(sponsored.burst, 16);
  assert.equal(sponsored.rounds, 1);
  assert.equal(sponsored.evidence.totalMined, 81);
  assert.equal(sponsored.evidence.workload, "hash-chain");
  assert.equal(sponsored.evidence.paymasterStake.amountWei, "12000000000000000");
  assert.equal(sponsored.evidence.paymasterStake.delay, 86400);
  assert.ok(sponsored.evidence.sponsorshipChecked);
  for (const mode of ["off", "fifo", "fair"]) {
    const evidence = sponsored.policies[mode].evidence;
    assert.equal(evidence.minedCount, 27);
    assert.equal(evidence.receipts.length, 17);
    assert.equal(evidence.receipts.filter(receipt => receipt.wallet === "B").length, 1);
    for (const receipt of evidence.receipts) {
      assert.match(receipt.hash, /^0x[0-9a-f]{64}$/i);
      assert.match(receipt.blockHash, /^0x[0-9a-f]{64}$/i);
      assert.equal(receipt.payer.toLowerCase(), sponsored.evidence.paymaster);
      assert.ok(BigInt(receipt.feeWei) > 0n);
    }
  }
  assert.doesNotMatch(JSON.stringify(sponsored), /privateKey|primaryKey|secondKey|jwt|Users\//);
});

test("a tampered sponsor fee cannot be presented as checked evidence", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "framilier-web-sponsor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sponsorArchive = fileURLToPath(new URL("../sidecar/evidence/compare/shared-paymaster-smoke/", import.meta.url));
  await cp(sponsorArchive, dir, { recursive: true });
  const file = path.join(dir, "fair.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  raw.benchmark.trials[0].honestFeeWei = "1";
  await writeFile(file, JSON.stringify(raw));
  await assert.rejects(readReport(dir, "replay"), /fee/);
});
