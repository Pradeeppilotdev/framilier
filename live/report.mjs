import assert from "node:assert/strict";
import { verifyReport } from "../sidecar/test/framilier/operator.mjs";

// Trace offsets share the observer clock. Zero is the instant B submitted its frame.
// Older captures can lack trace timing even when their receipts and metrics verify.
function traceTimeline(trial) {
  const start = trial.beforeHonestTraceMs;
  const duration = trial.honestSimulationRpcMs;
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < 0 ||
      start + duration > trial.honestMs + 0.002) return null;

  const events = [];
  for (const [index, job] of trial.background.entries()) {
    const startMs = job.traceStartRelativeToHonestMs;
    const endMs = job.traceEndRelativeToHonestMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
    events.push({ wallet: "A", index: index + 1, startMs, endMs, hash: job.hash });
  }
  events.push({ wallet: "B", index: 1, startMs: start, endMs: Number((start + duration).toFixed(3)), hash: trial.honestHash });
  return events.sort((a, b) => a.startMs - b.startMs);
}

export async function readReport(evidenceDir, source) {
  assert.ok(["live", "replay"].includes(source), "Unknown report source");
  const trials = {};
  const { comparison, status } = await verifyReport(evidenceDir, trials);
  assert.equal(status, "complete", "The comparison must finish before it can be displayed");

  const { chainId, rounds } = comparison;
  const startedAt = new Date(comparison.startedAt).toISOString();
  const completedAt = new Date(comparison.completedAt).toISOString();
  const burst = Math.max(...comparison.bursts);
  const policies = {};
  for (const mode of ["off", "fifo", "fair"]) {
    const sample = trials[mode][0];
    const { bAdmissionMs, aBatchMs } = comparison.policies[mode].summary.find(row => row.burst === burst);
    policies[mode] = { bAdmissionMs, aBatchMs, timeline: traceTimeline(sample) };
  }
  return { source, chainId, rounds, burst, startedAt, completedAt, policies };
}
