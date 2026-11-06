import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function checkPlan(rounds, bursts) {
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 50, "rounds must be 1–50");
  assert.ok(Array.isArray(bursts) && bursts.length && bursts.every(b => Number.isSafeInteger(b) && b >= 1 && b <= 16),
    "burst sizes must be integers from 1 to 16 (an idle control is included automatically)");
  assert.equal(new Set(bursts).size, bursts.length, "duplicate burst size");
  const candidates = (rounds + 1) * bursts.reduce((sum, n) => sum + n, 0);
  assert.ok(candidates <= 1024, "choose at most 1024 heavy submissions per policy including warm-ups");
  return candidates;
}

// This is the comparison's integration contract with a scheduling sidecar.
// A node that ignores unknown config must never produce a FIFO or fair result.
export function schedulerSettings(mode) {
  assert.ok(["off", "fifo", "fair"].includes(mode), "unknown scheduler mode");
  return { mode, slots: 4, maxHeavyPerSender: 2, maxWaiting: 64, heavyThreshold: 100000 };
}

// The node accepts flat network config keys and reports the live instance under admissionScheduler.
export function schedulerConfig(mode) {
  const s = schedulerSettings(mode);
  return { schedulerMode: s.mode, schedulerSlots: s.slots, schedulerMaxHeavyPerSender: s.maxHeavyPerSender,
    schedulerMaxWaiting: s.maxWaiting, schedulerHeavyThreshold: s.heavyThreshold };
}

export function effectiveScheduler(config, requested) {
  const expected = schedulerSettings(requested);
  const actual = config.admissionScheduler;
  if (actual == null && requested === "off") return null; // Baseline on the original sidecar.
  assert.ok(actual && typeof actual === "object", "sidecar did not report its active admission scheduler");
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key], value, `skandha_config.admissionScheduler.${key} mismatch`);
  }
  if (Object.hasOwn(actual, "maxWaitingPerSender")) {
    assert.equal(actual.maxWaitingPerSender, Math.min(16, expected.maxWaiting), "skandha_config.admissionScheduler.maxWaitingPerSender mismatch");
    expected.maxWaitingPerSender = actual.maxWaitingPerSender;
  }
  return expected;
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(sorted.length && sorted.every(v => Number.isFinite(v) && v >= 0), "missing or invalid latency");
  const n = sorted.length;
  const median = (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2;
  return { p50: Number(median.toFixed(3)), p95: sorted[Math.ceil(0.95 * n) - 1] };
}

export function summarize(trials, rounds, bursts, scheduler) {
  assert.equal(trials.length, rounds * (bursts.length + 1), "incomplete sweep");
  const inputs = new Set();
  for (const trial of trials) {
    for (const hash of [trial.honestHash, ...trial.background.map(b => b.hash)]) {
      assert.ok(hash && !inputs.has(hash), "reused or missing signed input");
      inputs.add(hash);
    }
  }
  return [0, ...bursts].map(burst => {
    const group = trials.filter(t => t.burst === burst);
    assert.deepEqual(group.map(t => t.round), Array.from({ length: rounds }, (_, i) => i), "missing or duplicate trial");
    for (const trial of group) {
      assert.equal(trial.background.length, burst);
      assert.ok(trial.honestBlockHash && trial.background.every(b => b.mined?.verifyGas === 993512), "missing verified receipt");
      if (scheduler && scheduler.mode !== "off") {
        assert.ok(trial.peakTraces <= scheduler.slots, "observed more concurrent traces than the scheduler allows");
        if (scheduler.mode === "fair") assert.ok(trial.peakBackgroundTraces <= scheduler.maxHeavyPerSender,
          "one sender exceeded the fair policy's heavy-work limit");
      }
    }
    return { burst, n: rounds, bAdmissionMs: percentiles(group.map(t => t.honestMs)),
      aBatchMs: burst ? percentiles(group.map(t => t.backgroundBatchMs)) : null,
      aMined: burst * rounds, bMined: rounds };
  });
}

export function workloadDigest(benchmark) {
  const hash = createHash("sha256");
  for (const t of [...benchmark.warmup, ...benchmark.trials]) {
    hash.update(JSON.stringify([t.round, t.burst, t.honestHash, t.background.map(b => b.hash)]));
  }
  return hash.digest("hex");
}
