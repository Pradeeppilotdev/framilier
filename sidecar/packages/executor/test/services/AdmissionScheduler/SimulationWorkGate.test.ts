import { describe, it, expect } from "vitest";
import { SimulationWorkGate } from "../../../src/services/AdmissionScheduler/SimulationWorkGate.js";

function held() {
  let release!: () => void;
  const done = new Promise<void>(r => { release = r; });
  let started = false;
  return { run: async () => { started = true; await done; }, release, started: () => started };
}
const tick = () => new Promise(r => setTimeout(r, 0));

describe("shared simulation budget", () => {
  it("reserves execution capacity for admission and rotates auxiliary lanes", async () => {
    const gate = new SimulationWorkGate(2, 8);
    const estimate = held(), queuedEstimate = held(), maintenance = held(), admission = held();
    const jobs = [gate.submit("estimate", estimate.run), gate.submit("estimate", queuedEstimate.run),
      gate.submit("maintenance", maintenance.run), gate.submit("admission", admission.run)];
    expect(estimate.started()).toBe(true);
    expect(admission.started()).toBe(true);
    expect(queuedEstimate.started()).toBe(false);
    expect(maintenance.started()).toBe(false);
    estimate.release(); await tick();
    expect(queuedEstimate.started()).toBe(true);
    queuedEstimate.release(); await tick();
    expect(maintenance.started()).toBe(true);
    admission.release(); maintenance.release(); await Promise.all(jobs);
  });

  it("bounds queued work per lane and releases a slot after failure", async () => {
    const gate = new SimulationWorkGate(1, 1);
    const first = held(), second = held();
    const a = gate.submit("estimate", first.run);
    const b = gate.submit("estimate", second.run);
    await expect(gate.submit("estimate", async () => {})).rejects.toThrow("queue is full");
    first.release(); await tick(); expect(second.started()).toBe(true);
    second.release(); await Promise.all([a, b]);
    await expect(gate.submit("maintenance", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(gate.submit("admission", async () => 42)).resolves.toBe(42);
  });

  it("never exceeds total capacity across all lanes", async () => {
    const gate = new SimulationWorkGate(4, 64);
    let active = 0, peak = 0, completed = 0;
    const jobs = Array.from({ length: 30 }, (_, i) => gate.submit(
      (["admission", "estimate", "maintenance"] as const)[i % 3], async () => {
        active++; peak = Math.max(active, peak); await tick(); active--; completed++;
      }));
    await Promise.all(jobs); expect(peak).toBeLessThanOrEqual(4); expect(completed).toBe(30);
  });
});
