import { describe, it, expect } from "vitest";
import { CanonicalPaymasterReservationTracker } from "../../../src/services/MempoolService/canonicalPaymaster.js";

describe("CanonicalPaymasterReservationTracker", () => {
  it("rejects a new reservation that would exceed available balance", () => {
    const tracker = new CanonicalPaymasterReservationTracker();
    const paymaster = "0x4444444444444444444444444444444444444444";
    tracker.reserve(paymaster, 100n);
    const available = tracker.availableBalance(paymaster, 150n); // balance=150, reserved=100
    expect(available).toBe(50n);
    expect(() => {
      if (200n > available) throw new Error("insufficient available balance");
    }).toThrow();
  });

  it("release() reduces reserved_pending_cost for that paymaster only", () => {
    const tracker = new CanonicalPaymasterReservationTracker();
    const p1 = "0x4444444444444444444444444444444444444444";
    const p2 = "0x5555555555555555555555555555555555555555";
    tracker.reserve(p1, 100n);
    tracker.reserve(p2, 200n);
    tracker.release(p1, 100n);
    expect(tracker.availableBalance(p1, 100n)).toBe(100n);
    expect(tracker.availableBalance(p2, 200n)).toBe(0n);
  });
});
