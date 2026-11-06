import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ethrexProvenance, verifyReport } from "./operator.mjs";
import { recoverSubmission, saveSubmissionIntent } from "./submission-journal.mjs";
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

test("report rejects missing fingerprints or receipt records and a mislabeled partial run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stakelane-consistency-"));
  const source = new URL("../../evidence/compare/run-2/", import.meta.url);
  const raw = JSON.parse(await readFile(new URL("off.json", source)));
  const report = JSON.parse(await readFile(new URL("comparison.json", source)));
  try {
    await writeFile(path.join(dir, "off.json"), JSON.stringify(raw));
    const mislabeled = { ...report, requestedModes: ["off", "fifo", "fair"] };
    await writeFile(path.join(dir, "comparison.json"), JSON.stringify(mislabeled));
    await assert.rejects(verifyReport(dir), /baseline-only requires/);

    await writeFile(path.join(dir, "comparison.json"), JSON.stringify(report));
    delete raw.benchmark.trials.find(t => t.burst).background[0].mined.blockHash;
    await writeFile(path.join(dir, "off.json"), JSON.stringify(raw));
    await assert.rejects(verifyReport(dir), /missing heavy receipt block/);

    const missingPin = JSON.parse(await readFile(new URL("off.json", source)));
    delete missingPin.ethrexBinarySha256;
    delete report.policies.off.ethrexBinarySha256;
    await writeFile(path.join(dir, "off.json"), JSON.stringify(missingPin));
    await writeFile(path.join(dir, "comparison.json"), JSON.stringify(report));
    await assert.rejects(verifyReport(dir), /ethrexBinarySha256/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("compare checks order and prerequisites before creating output; existing directories are preserved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stakelane-output-"));
  const cli = fileURLToPath(new URL("./operator.mjs", import.meta.url));
  const bun = path.join(dir, "bun");
  const ethrex = path.join(dir, "ethrex");
  const env = { ...process.env, STAKELANE_BUN_BIN: bun, STAKELANE_ETHREX_BIN: ethrex };
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
  try {
    const empty = path.join(dir, "new");
    const invalid = invoke("compare", "--order", "fifo,fifo,fair", "--output", empty);
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /order must contain/);
    assert.equal(invoke("compare", "--output", empty).status, 2);
    await assert.rejects(access(empty), { code: "ENOENT" });
    await writeFile(bun, "#!/bin/sh\n[ \"$1\" = --version ] || exit 1\necho 1.4.4\n", { mode: 0o700 });
    await writeFile(ethrex, "#!/bin/sh\n[ \"$1\" = --version ] || exit 1\necho ethrex/v23-9aa3645\n", { mode: 0o700 });
    const ready = JSON.parse(invoke("doctor", "--json").stdout).checks;
    assert.equal(ready.find(c => c.name === "Bun").ok, true);
    assert.equal(ready.find(c => c.name === "ethrex").ok, true);
    const original = await readdir(dir);
    const existing = invoke("compare", "--output", dir);
    assert.equal(existing.status, 1);
    assert.match(existing.stderr, /EEXIST/);
    assert.deepEqual(await readdir(dir), original);
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

test("an idempotent build uses only its clean pinned source checkout and real Cargo debug path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stakelane-ethrex-source-"));
  const checkout = path.join(dir, "ethrex");
  const binary = path.join(checkout, "target/debug/ethrex");
  const tracked = path.join(checkout, "Cargo.toml");
  const version = "ethrex/v23-VERGEN_IDEMPOTENT_OUTPUT";
  const git = (...args) => {
    const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "disposable build");
    await writeFile(tracked, "pinned source");
    git("init", "--quiet");
    git("add", "Cargo.toml");
    git("-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture");
    const revision = git("rev-parse", "HEAD");
    const link = path.join(dir, "linked-ethrex");
    await symlink(binary, link);
    assert.equal(await ethrexProvenance(link, version, revision), "local build path in clean pinned source checkout");
    assert.equal(await ethrexProvenance(binary, version, "0".repeat(40)), null);
    await writeFile(tracked, "changed tracked source");
    assert.equal(await ethrexProvenance(binary, version, revision), null);
    git("add", "Cargo.toml");
    assert.equal(await ethrexProvenance(binary, version, revision), null);
    git("restore", "--source=HEAD", "--staged", "--worktree", "Cargo.toml");
    const nested = path.join(checkout, "other/target/debug/ethrex");
    await mkdir(path.dirname(nested), { recursive: true });
    await writeFile(nested, "unrelated build under this repo");
    assert.equal(await ethrexProvenance(nested, version, revision), null);
    const outside = path.join(dir, "unrelated-engine");
    await writeFile(outside, "standalone binary");
    await rm(binary);
    await symlink(outside, binary);
    assert.equal(await ethrexProvenance(binary, version, revision), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
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
  await assert.rejects(recoverSubmission(intent, true, async kind => kind === "sidecar" ? false : null), /cannot confirm absence/);
  await assert.rejects(recoverSubmission({ ...intent, hash: `0x${"00".repeat(32)}` }, true, async () => null), /do not match/);
  await assert.rejects(recoverSubmission({ hash: intent.hash }, false, async () => null), /Legacy journal/);
});

test("concurrent writers publish one complete journal intent and preserve the winner", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stakelane-journal-"));
  try {
    const file = path.join(dir, "proof.json");
    const contents = ['{"hash":"first"}', '{"hash":"second"}'];
    const results = await Promise.allSettled(contents.map(value => saveSubmissionIntent(file, value)));
    const winner = results.findIndex(r => r.status === "fulfilled");
    assert.ok(winner >= 0);
    assert.equal(results[1 - winner].reason.code, "EEXIST");
    assert.equal(await readFile(file, "utf8"), contents[winner]);
    assert.deepEqual(await readdir(dir), ["proof.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
