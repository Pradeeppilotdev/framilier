import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createCompareProgress, runLoggedFixture } from "./compare-progress.mjs";

function capture(columns = 80) {
  const chunks = [];
  return { chunks, columns, write(value) { chunks.push(value); } };
}
const plan = { rounds: 1, bursts: [8, 16], sharedPaymaster: true };
const modes = ["off", "fifo", "fair"];

test("TTY progress explains the scenario and displays observed stage and elapsed time", () => {
  const stream = capture();
  let clock = 100;
  const view = createCompareProgress({ stream, plan, modes, chainId: 8141337, now: () => clock });
  try {
    view.start("fifo", 1);
    clock = 2600;
    view.stage("measure");
    view.complete(18);
    const text = stripVTControlCharacters(stream.chunks.join(""));
    assert.match(text, /Private local chain 8141337/);
    assert.match(text, /bursts of 8, 16 heavy checks/);
    assert.match(text, /Wallet B: one cheap check per trial/);
    assert.match(text, /shared paymaster/);
    assert.match(text, /Smoke run/);
    assert.match(text, /\[2\/3\] FIFO.*Preparing fixture/);
    assert.match(text, /Measuring admission and mining receipts\s+2\.5s/);
    assert.match(text, /FIFO complete · 18 measured transactions mined · 2\.5s/);
    assert.doesNotMatch(text, /\d+%|estimated|remaining/i);
  } finally { view.close(); }
});

test("narrow progress lines fit and failure prints diagnostics without a successful result", () => {
  const stream = capture(40);
  const view = createCompareProgress({ stream, plan: { ...plan, sharedPaymaster: false }, modes, chainId: 8141337 });
  try {
    view.start("fair", 2);
    const count = stream.chunks.length;
    view.stage("unexpected\x1b[2J");
    assert.equal(stream.chunks.length, count);
    view.failed("/tmp/long-comparison-directory/fair.log");
    const text = stripVTControlCharacters(stream.chunks.join(""));
    assert.match(text, /each wallet pays/);
    assert.match(text, /Fair failed/);
    assert.match(text, /Diagnostics:/);
    assert.doesNotMatch(text, /complete|transactions mined/);
    for (const chunk of stream.chunks) {
      const visible = stripVTControlCharacters(chunk).replace(/\r/g, "");
      assert.ok(visible.split("\n").every(line => line.length < 40), JSON.stringify(visible));
    }
  } finally { view.close(); }
});

test("fixture diagnostics stream to a private file and only allowlisted IPC stages reach the view", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "framilier-progress-test-"));
  const logPath = path.join(dir, "off.log");
  const stages = [];
  const listenerCounts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  try {
    const script = `const fs=require('node:fs');
      const input=JSON.parse(fs.readFileSync(0,'utf8'));
      process.send({type:'framilier:stage',stage:'chain'});
      process.send({type:'framilier:stage',stage:'made-up-progress'});
      process.send({type:'other',stage:'measure'});
      console.log('fixture stdout '+input.label);
      console.error('fixture stderr');
      process.send({type:'framilier:stage',stage:'save'});`;
    await runLoggedFixture({ executable: process.execPath, args: ["-e", script], input: JSON.stringify({ label: "sample" }),
      env: process.env, logPath, onStage: stage => stages.push(stage) });
    assert.deepEqual(stages, ["chain", "save"]);
    const log = await readFile(logPath, "utf8");
    assert.match(log, /fixture stdout sample/);
    assert.match(log, /fixture stderr/);
    if (process.platform !== "win32") assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listenerCounts);
    await assert.rejects(runLoggedFixture({ executable: process.execPath, args: [], input: "", env: process.env, logPath }), /EEXIST/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed fixture keeps its diagnostics, names the file and releases signal handlers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "framilier-progress-failure-"));
  const logPath = path.join(dir, "fair.log");
  const listenerCounts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  try {
    await assert.rejects(runLoggedFixture({ executable: process.execPath,
      args: ["-e", "console.error('actual fixture failure'); process.exitCode=7"], input: "{}", env: process.env, logPath }),
    error => { assert.match(error.message, /Fixture exited with 7/); assert.ok(error.message.includes(logPath)); return true; });
    assert.match(await readFile(logPath, "utf8"), /actual fixture failure/);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listenerCounts);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("interrupting a live fixture terminates the child and releases its signal handlers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "framilier-progress-interrupt-"));
  const logPath = path.join(dir, "fifo.log");
  const listenerCounts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  try {
    await assert.rejects(runLoggedFixture({ executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000); process.send({type:'framilier:stage',stage:'chain'})"],
      input: "{}", env: process.env, logPath, onStage: () => process.emit("SIGINT") }), /Fixture exited with SIGTERM/);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listenerCounts);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
