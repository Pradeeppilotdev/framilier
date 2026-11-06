import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { checkPlan, effectiveScheduler, schedulerConfig, schedulerSettings, summarize, workloadDigest } from "./compare-metrics.mjs";
import { startTraceMeter } from "./trace-meter.mjs";

// Synthetic samples exercise report arithmetic and failure paths only.
function sample(round, burst) {
  return { round, burst, honestMs: round + 1, backgroundBatchMs: burst ? 100 + round : null,
    honestHash: `b-${round}-${burst}`, honestBlockHash: "block-b", peakTraces: 1, peakBackgroundTraces: burst ? 1 : 0,
    background: Array.from({ length: burst }, (_, i) => ({ hash: `a-${round}-${burst}-${i}`, mined: { verifyGas: 993512 } })) };
}

test("bounds include warm-ups and avoid duplicate cases", () => {
  assert.equal(checkPlan(20, [1, 4, 8]), 273);
  for (const args of [[0, [4]], [2, [0]], [2, [1, 1]], [1, [17]], [50, [8, 16]]]) {
    assert.throws(() => checkPlan(...args));
  }
});

test("unreported configuration can identify only the legacy default", () => {
  assert.equal(effectiveScheduler({}, "off"), null);
  for (const mode of ["fifo", "fair"]) {
    assert.deepEqual(schedulerConfig(mode), { schedulerMode: mode, schedulerSlots: 4,
      schedulerMaxHeavyPerSender: 2, schedulerMaxWaiting: 64, schedulerHeavyThreshold: 100000 });
    const config = { admissionScheduler: schedulerSettings(mode) };
    assert.deepEqual(effectiveScheduler(config, mode), config.admissionScheduler);
    assert.throws(() => effectiveScheduler({}, mode));
    assert.throws(() => effectiveScheduler({ admissionScheduler: { ...config.admissionScheduler, slots: 8 } }, mode));
    assert.throws(() => effectiveScheduler({ admissionScheduler: schedulerSettings("off") }, mode));
  }
});

test("computes B median/nearest-rank p95 and A batch time, and checks complete samples", () => {
  const trials = Array.from({ length: 20 }, (_, i) => [sample(i, 0), sample(i, 4)]).flat();
  const [idle, four] = summarize(trials, 20, [4], null);
  assert.deepEqual(four.bAdmissionMs, { p50: 10.5, p95: 19 });
  assert.deepEqual(four.aBatchMs, { p50: 109.5, p95: 118 });
  assert.equal(four.aMined, 80);
  assert.equal(idle.bMined, 20);
  assert.equal(idle.aBatchMs, null);
  assert.throws(() => summarize(trials.slice(1), 20, [4], null));
  trials[0].round = 1;
  assert.throws(() => summarize(trials, 20, [4], null));
});

test("refuses mislabeled policies and unverified workloads", () => {
  const trials = [sample(0, 0), sample(0, 4)];
  trials[1].peakBackgroundTraces = 3;
  assert.throws(() => summarize(trials, 1, [4], schedulerSettings("fair")));
  trials[1].peakTraces = 5;
  assert.throws(() => summarize(trials, 1, [4], schedulerSettings("fifo")));
  trials[1].background[0].mined.verifyGas = 0;
  assert.throws(() => summarize(trials, 1, [4], null));
});

test("workload fingerprint includes the exact signed tx hashes and trial order, excluding timings", () => {
  const bench = { warmup: [sample(-1, 1)], trials: [sample(0, 0), sample(0, 1)] };
  const expected = workloadDigest(bench);
  bench.trials[0].honestMs += 900;
  assert.equal(workloadDigest(bench), expected);
  bench.trials.reverse();
  assert.notEqual(workloadDigest(bench), expected);
  bench.trials.reverse();
  bench.trials[1].background[0].hash = "another-input";
  assert.notEqual(workloadDigest(bench), expected);
});

test("the observer times only the probe wallet's exact registry read and keeps it out of trace concurrency", async () => {
  const upstream = createServer((req, res) => { req.resume(); res.end('{"jsonrpc":"2.0","id":1,"result":"0x"}'); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  let meter;
  try {
    meter = await startTraceMeter(`http://127.0.0.1:${upstream.address().port}`);
    const capture = meter.observe("probe", [], { to: "0xab", data: "0xabcd" });
    async function ethCall(to, data) {
      const res = await fetch(meter.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        method: "eth_call", params: [{ to, data }, "latest"] }) });
      assert.equal((await res.json()).result, "0x");
    }
    await ethCall("0xab", "0xffff");
    await ethCall("0xff", "0xabcd");
    await ethCall("0xAB", "0xABCD");
    meter.clear();
    await ethCall("0xab", "0xabcd");
    assert.equal(capture.events.length, 0);
    assert.equal(capture.stakeReads.length, 1);
    assert.ok(capture.stakeReads[0].end >= capture.stakeReads[0].start);
  } finally {
    await meter?.close();
    const closed = once(upstream, "close");
    upstream.close();
    upstream.closeAllConnections();
    await closed;
  }
});
