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

// Verify recorded sponsorship independently of the CLI flag. Legacy archives have no sponsor fields.
export function sponsorshipEvidence(raw, requested = false) {
  assert.equal(typeof requested, "boolean", "invalid shared-paymaster setting");
  const b = raw.benchmark;
  const control = raw.controls?.sponsoredWrongWitness;
  const all = [...b.warmup, ...b.trials];
  if (!requested) {
    assert.equal(b.sharedPaymaster, undefined, "unexpected paymaster in self-paid evidence");
    assert.equal(b.paymasterStake, undefined, "unexpected sponsor stake in self-paid evidence");
    assert.equal(control, undefined, "unexpected sponsored control in self-paid evidence");
    assert.ok(all.every(t => t.honestPayer === undefined && t.honestFeeWei === undefined && t.paymasterFeesWei === undefined &&
      t.paymasterBalanceBeforeWei === undefined && t.paymasterBalanceAfterWei === undefined &&
      t.background.every(a => a.mined?.payer === undefined && a.mined?.feeWei === undefined)), "unexpected sponsorship receipts in self-paid evidence");
    return null;
  }
  const address = value => {
    assert.match(value, /^0x[0-9a-f]{40}$/i, "missing or invalid sponsorship address");
    assert.doesNotMatch(value, /^0x0{40}$/i, "zero sponsorship address");
    return value.toLowerCase();
  };
  const paymaster = address(b.sharedPaymaster);
  const stake = b.paymasterStake;
  assert.equal(address(stake?.address), paymaster, "stake belongs to a different paymaster");
  assert.equal(address(stake.registry), address(raw.registry), "sponsor stake registry mismatch");
  assert.equal(stake.amountWei, "12000000000000000", "expected a 0.012 ETH sponsor stake");
  assert.equal(stake.delay, 86400, "expected a one-day sponsor unstake delay");
  assert.equal(stake.withdrawal, "0", "sponsor stake is unlocking");
  const walletA = address(b.noisyWallet);
  const walletB = address(b.honestWallet);
  assert.equal(new Set([paymaster, walletA, walletB]).size, 3, "expected two distinct wallets and a shared paymaster");

  assert.match(control?.hash, /^0x[0-9a-f]{64}$/i, "missing signed sponsored rejection control");
  assert.notEqual(control.hash, raw.controls.incorrectWitness?.hash, "reused self-paid rejection control");
  assert.equal(control.code, -32500, "expected a validation failure for the sponsored wrong witness");
  assert.match(control.reason, /wrong witness|77726f6e67207769746e657373/i, "unexpected sponsored rejection reason");

  const heavyVerifyGas = all.find(t => t.background.length)?.background[0].mined?.verifyGas;
  assert.ok(Number.isSafeInteger(heavyVerifyGas) && heavyVerifyGas >= 990000 && heavyVerifyGas <= 997200,
    "sponsored sender did not execute the high-gas workload");
  const wei = value => {
    assert.match(value, /^(0|[1-9][0-9]*)$/, "invalid paymaster fee or balance");
    return BigInt(value);
  };
  for (const t of all) {
    assert.equal(address(t.honestPayer), paymaster, "wallet B receipt payer mismatch");
    assert.notEqual(t.honestHash, control.hash, "rejected control also appears as mined");
    let receiptFees = wei(t.honestFeeWei);
    assert.ok(receiptFees > 0n, "expected a positive wallet B receipt fee");
    for (const item of t.background) {
      const fee = wei(item.mined?.feeWei);
      assert.ok(fee > 0n, "expected a positive wallet A receipt fee");
      receiptFees += fee;
      assert.equal(address(item.mined?.payer), paymaster, "wallet A receipt payer mismatch");
      assert.equal(item.mined.verifyGas, heavyVerifyGas, "sponsored sender VERIFY gas changed across transactions");
      assert.notEqual(item.hash, control.hash, "rejected control also appears as mined");
    }
    const fees = wei(t.paymasterFeesWei);
    assert.equal(fees, receiptFees, "sponsor fee total differs from individual receipt fees");
    assert.equal(wei(t.paymasterBalanceBeforeWei) - wei(t.paymasterBalanceAfterWei), fees,
      "paymaster balance decrease differs from receipt fees");
  }
  return { paymaster, walletA, walletB, heavyVerifyGas, rejectedHash: control.hash,
    paymasterStake: { registry: address(stake.registry), amountWei: stake.amountWei, delay: stake.delay } };
}

export function summarize(trials, rounds, bursts, scheduler, heavyVerifyGas = 993512) {
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
      assert.ok(trial.honestBlockHash && trial.background.every(b => b.mined?.verifyGas === heavyVerifyGas), "missing verified receipt");
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
