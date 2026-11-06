import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReputationEntry } from "../../src/entities/ReputationEntry.js";

describe("ReputationEntry decay rate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not decay at all after 90 real seconds - decay is meant to span 24 real hours", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const entry = new ReputationEntry({ chainId: 1337, address: "0x1", opsSeen: 1000 });

    vi.advanceTimersByTime(90_000); // 90 seconds

    expect(entry.opsSeen).toBe(1000);
  });

  it("decays by 1/24 after exactly one real hour has passed", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const entry = new ReputationEntry({ chainId: 1337, address: "0x1", opsSeen: 1000 });

    vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour

    expect(entry.opsSeen).toBe(Math.floor(1000 * (1 - 1 / 24)));
  });

  it("decays fully to zero only after a full 24 real hours", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const entry = new ReputationEntry({ chainId: 1337, address: "0x1", opsSeen: 1000 });

    vi.advanceTimersByTime(24 * 60 * 60 * 1000); // 24 hours

    expect(entry.opsSeen).toBe(0);
  });
});
