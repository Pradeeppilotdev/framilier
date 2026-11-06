// Offline audit of the published measurements, independent of the CLI's statistics code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const evidence = new URL("../../evidence/compare/", import.meta.url);
const hash32 = /^0x[\da-f]{64}$/i;
const near = (a, b) => assert.ok(Math.abs(a - b) <= 0.0021, `rounded timestamps differ: ${a}, ${b}`);

function auditPercentiles(recorded, times) {
  const ordered = times.slice().sort((a, b) => a - b);
  const n = ordered.length;
  assert.ok(n && ordered.every(ms => Number.isFinite(ms) && ms >= 0));
  const mid = Math.floor(n / 2);
  const median = n % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
  assert.equal(recorded.p50, Number(median.toFixed(3)));
  assert.equal(recorded.p95, ordered[Math.ceil(0.95 * n) - 1]);
}

for (const id of ["run-1", "run-2"]) {
  test(`${id}: verify counts, transaction fingerprint and published latencies`, async () => {
    const load = async name => JSON.parse(await readFile(new URL(`${id}/${name}`, evidence), "utf8"));
    const [comparison, raw] = await Promise.all([load("comparison.json"), load("off.json")]);
    const arm = comparison.policies.off;
    const { trials, warmup } = raw.benchmark;
    assert.equal(comparison.chainId, 8141337);
    assert.equal(raw.chainId, comparison.chainId);
    assert.equal(arm.status, "measured");
    assert.equal(arm.schedulerReadback, null);
    assert.equal(arm.evidenceFile, "off.json");
    for (const field of ["genesisHash", "ethrexBinarySha256", "fixtureArtifactSha256"]) assert.equal(arm[field], raw[field]);
    assert.equal(raw.stake.after.amountWei, "12000000000000000");
    assert.notEqual(raw.benchmark.honestWallet, raw.benchmark.noisyWallet);
    assert.ok(raw.benchmark.blockedExternalHttp.some(e => e.method === "CONNECT" && e.authority === "api.github.com:443"));
    assert.equal(comparison.rounds, 20);
    const sizes = [0, ...comparison.bursts];
    assert.deepEqual(sizes, [0, 1, 4, 8]);
    assert.deepEqual(warmup.map(t => [t.round, t.burst]), sizes.map(n => [-1, n]));
    assert.equal(trials.length, comparison.rounds * sizes.length);
    if (id === "run-1") {
      assert.equal(comparison.status, "incomplete");
      for (const mode of ["fifo", "fair"]) {
        assert.equal(comparison.policies[mode].status, "unavailable");
        assert.equal(comparison.policies[mode].summary, undefined);
      }
    } else {
      assert.equal(comparison.status, "baseline-only");
      assert.deepEqual(Object.keys(comparison.policies), ["off"]);
      assert.equal(raw.benchmark.secondStake.amountWei, raw.stake.after.amountWei);
      assert.equal(raw.benchmark.admissionWindow.verifyFixedHead, true);
      assert.equal(raw.benchmark.admissionWindow.requireSidecarOnChain, true);
      const first = JSON.parse(await readFile(new URL("run-1/comparison.json", evidence), "utf8")).policies.off;
      assert.equal(arm.ethrexBinarySha256, first.ethrexBinarySha256);
      assert.equal(arm.fixtureArtifactSha256, first.fixtureArtifactSha256);
      assert.notEqual(arm.genesisHash, first.genesisHash);
    }

    const seen = new Set();
    const digest = createHash("sha256");
    for (const t of [...warmup, ...trials]) {
      const hashes = t.background.map(a => a.hash);
      digest.update(JSON.stringify([t.round, t.burst, t.honestHash, hashes]));
      for (const hash of [t.honestHash, ...hashes]) {
        assert.match(hash, hash32);
        assert.ok(!seen.has(hash), `reused input ${hash}`);
        seen.add(hash);
      }
      assert.equal(hashes.length, t.burst);
      assert.match(t.honestBlockHash, hash32);
      near(t.beforeHonestTraceMs + t.honestSimulationRpcMs + t.afterHonestTraceMs, t.honestMs);
      for (const a of t.background) {
        assert.equal(a.outcome, "admitted");
        assert.equal(a.mined.verifyGas, 993512);
        assert.match(a.mined.blockHash, hash32);
      }
      if (id === "run-2") {
        assert.match(t.admissionHeadHash, hash32);
        assert.equal(t.honestStakeLookupRpcMs.length, 1);
        assert.ok(t.honestStakeLookupRpcMs[0] >= 0);
        for (const a of t.background) near(a.responseEndRelativeToHonestMs - a.submitStartRelativeToHonestMs, a.admissionMs);
        if (t.burst) {
          const first = Math.min(...t.background.map(a => a.submitStartRelativeToHonestMs));
          const last = Math.max(...t.background.map(a => a.responseEndRelativeToHonestMs));
          near(last - first, t.backgroundBatchMs);
        }
      }
    }
    assert.equal(digest.digest("hex"), arm.signedWorkloadSha256);
    assert.deepEqual(arm.summary.map(row => row.burst), sizes);
    for (const row of arm.summary) {
      const group = trials.filter(t => t.burst === row.burst);
      assert.deepEqual(group.map(t => t.round), Array.from({ length: comparison.rounds }, (_, i) => i));
      assert.equal(row.n, group.length);
      assert.equal(row.bMined, group.length);
      assert.equal(row.aMined, group.reduce((count, t) => count + t.background.length, 0));
      auditPercentiles(row.bAdmissionMs, group.map(t => t.honestMs));
      if (row.burst) auditPercentiles(row.aBatchMs, group.map(t => t.backgroundBatchMs));
      else assert.equal(row.aBatchMs, null);
    }
  });
}

test("separate real baseline processes replayed the same signed inputs", async () => {
  const record = JSON.parse(await readFile(new URL("replay-control.json", evidence), "utf8"));
  assert.equal(record.chainId, 8141337);
  const [first, second] = record.defaultRuns;
  assert.deepEqual(first, second);
  assert.deepEqual(first.inputs.map(([round, burst]) => [round, burst]), [[-1, 0], [-1, 1], [0, 0], [0, 1]]);
  const digest = createHash("sha256");
  for (const input of first.inputs) digest.update(JSON.stringify(input));
  assert.equal(digest.digest("hex"), first.signedWorkloadSha256);
  assert.equal(record.unsupportedMode.wroteTimingFile, false);
  assert.equal(record.interruptedRun.end, "failed");
  assert.equal(record.interruptedRun.hasSummary, false);
});
