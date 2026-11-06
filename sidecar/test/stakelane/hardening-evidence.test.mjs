import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyReport } from "./operator.mjs";

for (const [name, bursts, heavyPerPolicy, probesPerPolicy] of [
  ["full-1", [1, 4, 8], 260, 80],
  ["repeat-8", [8], 160, 40],
]) {
  test(`${name}: archived native policy comparison remains complete and internally consistent`, async () => {
    const directory = new URL(`../../evidence/hardening/${name}/`, import.meta.url);
    const { comparison } = await verifyReport(fileURLToPath(directory));
    assert.equal(comparison.status, "complete");
    assert.equal(comparison.rounds, 20);
    assert.deepEqual(comparison.bursts, bursts);
    assert.deepEqual(comparison.requestedModes, name === "full-1" ? ["off", "fifo", "fair"] : ["fair", "fifo", "off"]);
    for (const mode of comparison.requestedModes) {
      const arm = comparison.policies[mode];
      assert.equal(arm.summary.reduce((n, r) => n + r.aMined, 0), heavyPerPolicy);
      assert.equal(arm.summary.reduce((n, r) => n + r.bMined, 0), probesPerPolicy);
      assert.match(arm.sidecarBuildSha256, /^[0-9a-f]{64}$/);
      const raw = JSON.parse(await readFile(new URL(`${mode}.json`, directory)));
      assert.equal(raw.ethrexSource, "9aa3645d795945c64400f41a70aace0edfa7f383");
      const seen = new Set();
      for (const trial of [...raw.benchmark.warmup, ...raw.benchmark.trials]) {
        for (const hash of [trial.honestHash, ...trial.background.map(b => b.hash)]) {
          assert.match(hash, /^0x[0-9a-f]{64}$/);
          assert.ok(!seen.has(hash), "duplicate archived input"); seen.add(hash);
        }
      }
    }
    if (name === "repeat-8") {
      const first = JSON.parse(await readFile(new URL("../../evidence/hardening/full-1/comparison.json", import.meta.url)));
      for (const field of ["ethrexBinarySha256", "fixtureArtifactSha256", "sidecarBuildSha256"]) {
        assert.equal(comparison.policies.fair[field], first.policies.off[field]);
      }
    }
  });
}

test("a small supported workload mined without the old 500k minimum", async () => {
  const raw = JSON.parse(await readFile(new URL("../../evidence/hardening/small-workload.json", import.meta.url)));
  assert.equal(raw.workload.rounds, 1);
  assert.equal(raw.accepted.actualVerifyGas, 7886);
  assert.deepEqual(raw.accepted.receipt.frameReceipts.map(f => f.status), ["0x1", "0x1"]);
  assert.ok(raw.accepted.block.transactions.includes(raw.accepted.receipt.transactionHash));
  assert.equal(raw.accepted.receipt.blockHash, raw.accepted.block.hash);
});
