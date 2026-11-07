import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sponsorshipEvidence } from "./compare-metrics.mjs";
import { verifyReport } from "./operator.mjs";

const sponsor = "0x" + "cc".repeat(20);
const walletA = "0x" + "aa".repeat(20);
const walletB = "0x" + "bb".repeat(20);
const registry = "0x" + "dd".repeat(20);
const paymasterStake = { registry, amountWei: "12000000000000000", delay: 86400 };
const rejected = "0x" + "11".repeat(32);

function example() {
  return {
    registry,
    controls: { sponsoredWrongWitness: { hash: rejected, code: -32500, reason: "wrong witness" } },
    benchmark: {
      paymasterStake: { ...paymasterStake, address: sponsor, withdrawal: "0" },
      sharedPaymaster: sponsor, noisyWallet: walletA, honestWallet: walletB, warmup: [],
      trials: [{
        honestPayer: sponsor, honestFeeWei: "3", honestHash: "0x" + "22".repeat(32),
        paymasterBalanceBeforeWei: "1000", paymasterBalanceAfterWei: "985", paymasterFeesWei: "15",
        background: [{ hash: "0x" + "33".repeat(32), mined: { payer: sponsor, feeWei: "12", verifyGas: 993512 } }],
      }],
    },
  };
}

test("verifies both wallets, the fee debit and the separate signed rejection", () => {
  const raw = example();
  assert.deepEqual(sponsorshipEvidence(raw, true), {
    paymaster: sponsor, walletA, walletB, heavyVerifyGas: 993512, rejectedHash: rejected, paymasterStake,
  });
  const changes = [
    r => { r.benchmark.paymasterStake.address = walletA; },
    r => { r.benchmark.paymasterStake.registry = walletB; },
    r => { r.benchmark.paymasterStake.amountWei = "0"; },
    r => { r.benchmark.paymasterStake.delay = 0; },
    r => { r.benchmark.paymasterStake.withdrawal = "42"; },
    r => { r.benchmark.trials[0].honestPayer = walletB; },
    r => { r.benchmark.trials[0].background[0].mined.payer = walletA; },
    r => { r.benchmark.trials[0].paymasterFeesWei = "0"; },
    r => { r.benchmark.trials[0].honestFeeWei = "0"; },
    r => { r.benchmark.trials[0].background[0].mined.feeWei = "13"; },
    r => { r.benchmark.trials[0].paymasterBalanceAfterWei = "986"; },
    r => { r.benchmark.honestWallet = walletA; },
    r => { r.controls.sponsoredWrongWitness.code = -32602; },
    r => { r.controls.sponsoredWrongWitness.reason = "insufficient funds"; },
    r => { r.controls.sponsoredWrongWitness.hash = r.benchmark.trials[0].honestHash; },
    r => { r.benchmark.trials[0].background[0].mined.verifyGas = 21000; },
  ];
  for (const change of changes) {
    const modified = structuredClone(raw);
    change(modified);
    assert.throws(() => sponsorshipEvidence(modified, true));
  }
  assert.throws(() => sponsorshipEvidence(raw, false), /unexpected paymaster/);
  delete raw.benchmark.sharedPaymaster;
  delete raw.benchmark.paymasterStake;
  delete raw.controls.sponsoredWrongWitness;
  assert.throws(() => sponsorshipEvidence(raw, false), /unexpected sponsorship receipts/);
});

test("historical self-paid report verifies and cannot be relabeled as shared-paymaster", async () => {
  const source = new URL("../../evidence/compare/run-2/", import.meta.url);
  const directory = await mkdtemp(path.join(tmpdir(), "framilier-sponsor-report-"));
  try {
    const manifest = JSON.parse(await readFile(new URL("comparison.json", source), "utf8"));
    await writeFile(path.join(directory, "off.json"), await readFile(new URL("off.json", source)));
    const file = path.join(directory, "comparison.json");
    await writeFile(file, JSON.stringify(manifest));
    assert.ok((await verifyReport(directory)).verified);
    manifest.sharedPaymaster = true;
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(verifyReport(directory), /sponsorship address|string/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
