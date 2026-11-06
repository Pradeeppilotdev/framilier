import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyReport } from "./operator.mjs";
import { recoverSubmission } from "./submission-journal.mjs";
import { signedWalletFrame } from "./wallet-frame.mjs";
import { privateKeyToAccount } from "viem/accounts";
import { encodeRawFrameTx } from "../../packages/executor/lib/services/FrameTxService/codec.js";
import { keccak256 } from "viem";

test("offline report verifies the saved baseline without disguising incomplete status", async () => {
  const result = await verifyReport(fileURLToPath(new URL("../../evidence/compare/run-1", import.meta.url)));
  assert.equal(result.status, "incomplete");
  assert.equal(result.measuredPolicies, 1);
});

test("offline report rejects modified statistics", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stakelane-report-test-"));
  try {
    const base = new URL("../../evidence/compare/run-2/", import.meta.url);
    const report = JSON.parse(await readFile(new URL("comparison.json", base)));
    report.policies.off.summary[0].bAdmissionMs.p50++;
    await writeFile(path.join(dir, "comparison.json"), JSON.stringify(report));
    await writeFile(path.join(dir, "off.json"), await readFile(new URL("off.json", base)));
    await assert.rejects(verifyReport(dir), /summary differs/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("baseline-only verification accepts only a measured off-only request", async () => {
  const directory = fileURLToPath(new URL("../../evidence/compare/run-2/", import.meta.url));
  const valid = await verifyReport(directory);
  assert.equal(valid.status, "baseline-only");
  assert.equal(valid.measuredPolicies, 1);
  const original = JSON.parse(await readFile(path.join(directory, "comparison.json")));
  const mutations = [
    r => { r.requestedModes = ["off", "fifo", "fair"]; r.policies.fifo = { status: "failed" }; r.policies.fair = { status: "failed" }; },
    r => { r.policies.fair = { status: "failed" }; },
    r => { r.policies.off.status = "failed"; },
    r => { r.status = "success"; },
    r => { r.requestedModes = ["off", "off"]; },
    r => { r.policies.off.status = "success"; },
  ];
  const dir = await mkdtemp(path.join(tmpdir(), "stakelane-status-test-"));
  try {
    await writeFile(path.join(dir, "off.json"), await readFile(path.join(directory, "off.json")));
    for (const mutate of mutations) {
      const report = structuredClone(original);
      mutate(report);
      await writeFile(path.join(dir, "comparison.json"), JSON.stringify(report));
      await assert.rejects(verifyReport(dir));
    }
    const cli = fileURLToPath(new URL("./operator.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "report", dir, "--verify", "--json"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /"verified":true/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI help and doctor provide actionable output without starting a chain", () => {
  const cli = fileURLToPath(new URL("./operator.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /doctor/);
  const doctor = spawnSync(process.execPath, [cli, "doctor", "--json"], {
    encoding: "utf8", env: { ...process.env, STAKELANE_ETHREX_BIN: "/nonexistent/ethrex" },
  });
  assert.equal(doctor.status, 2);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.status, "not-ready");
  assert.match(report.checks.find(c => c.name === "ethrex").fix, /STAKELANE_ETHREX_BIN/);
});

test("recovery reconstructs identical signed frames only after confirmed absence", async () => {
  const key = `0x${"12".repeat(32)}`;
  const owner = privateKeyToAccount(key);
  const tx = await signedWalletFrame({ chainId: 1337, wallet: owner.address, owner: owner.address,
    key, nonceSeq: 0n, gas: 70000n, verifyData: "0x", target: owner.address });
  const signedTransaction = encodeRawFrameTx(tx);
  const intent = { signedTransaction, hash: keccak256(signedTransaction) };
  const observed = [];
  const params = await recoverSubmission(intent, true, async kind => { observed.push(kind); return null; });
  assert.deepEqual(observed, ["receipt", "transaction", "sidecar"]);
  assert.equal(encodeRawFrameTx(params[0]), signedTransaction);
  assert.equal(await recoverSubmission(intent, true, async () => ({ status: "New" })), null);
  await assert.rejects(recoverSubmission(intent, true, async () => { throw new Error("offline"); }), /offline/);
  await assert.rejects(recoverSubmission({ ...intent, hash: `0x${"00".repeat(32)}` }, true, async () => null), /do not match/);
  await assert.rejects(recoverSubmission({ hash: intent.hash }, false, async () => null), /Legacy journal/);
});
