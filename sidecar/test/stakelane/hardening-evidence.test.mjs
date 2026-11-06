import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyReport } from "./operator.mjs";

const hash32 = /^0x[0-9a-f]{64}$/;

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
      assert.equal(raw.benchmark.relayBundleSize, 1);
      const seen = new Set();
      const blocks = new Set();
      for (const trial of [...raw.benchmark.warmup, ...raw.benchmark.trials]) {
        const inclusions = [{ hash: trial.honestHash, blockNumber: trial.honestBlock, blockHash: trial.honestBlockHash }];
        for (const tx of trial.background) {
          assert.equal(tx.outcome, "admitted");
          assert.equal(tx.mined.verifyGas, 993512);
          inclusions.push({ hash: tx.hash, blockNumber: tx.mined.blockNumber, blockHash: tx.mined.blockHash });
        }
        for (const { hash, blockNumber, blockHash } of inclusions) {
          assert.match(hash, hash32);
          assert.match(blockHash, hash32);
          assert.ok(Number.isSafeInteger(blockNumber) && blockNumber > 0);
          assert.ok(!seen.has(hash), "duplicate archived input");
          assert.ok(!blocks.has(blockNumber), "the one-transaction-per-block fixture reused a block");
          seen.add(hash);
          blocks.add(blockNumber);
        }
      }
    }
    if (name === "repeat-8") {
      const first = JSON.parse(await readFile(new URL("../../evidence/hardening/full-1/comparison.json", import.meta.url)));
      for (const field of ["ethrexBinarySha256", "fixtureArtifactSha256", "sidecarBuildSha256"]) {
        assert.equal(comparison.policies.fair[field], first.policies.off[field]);
      }
      assert.notEqual(comparison.policies.fair.genesisHash, first.policies.off.genesisHash);
      assert.notEqual(comparison.policies.fair.signedWorkloadSha256, first.policies.off.signedWorkloadSha256);
    }
  });
}

test("report also verifies the previously published three-policy Mac measurement", async () => {
  const directory = new URL("../../evidence/compare/merged-main-7d052e7/", import.meta.url);
  const { comparison, measuredPolicies } = await verifyReport(fileURLToPath(directory));
  assert.equal(comparison.status, "complete");
  assert.equal(measuredPolicies, 3);
  const record = JSON.parse(await readFile(new URL("verification.json", directory)));
  assert.equal(record.measuredInclusionsAcrossThreeChains, 1020);
  assert.deepEqual(Object.keys(record.fileSha256).sort(), ["comparison.json", "fair.json", "fifo.json", "off.json"]);
  for (const [file, expected] of Object.entries(record.fileSha256)) {
    const bytes = await readFile(new URL(file, directory));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, file);
  }
});

test("a small supported workload mined without the old 500k minimum", async () => {
  const raw = JSON.parse(await readFile(new URL("../../evidence/hardening/small-workload.json", import.meta.url)));
  assert.equal(raw.workload.rounds, 1);
  assert.equal(raw.accepted.actualVerifyGas, 7886);
  assert.deepEqual(raw.accepted.receipt.frameReceipts.map(f => f.status), ["0x1", "0x1"]);
  assert.ok(raw.accepted.block.transactions.includes(raw.accepted.receipt.transactionHash));
  assert.equal(raw.accepted.receipt.blockHash, raw.accepted.block.hash);
});
