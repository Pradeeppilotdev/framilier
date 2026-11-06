import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReputationService } from "../../src/services/ReputationService.js";
import { LocalDbController } from "../mocks/database.js";

const ADDR = "0x1111111111111111111111111111111111111111";

describe("ReputationService.dump: decay consistency with fetchOne/getStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the same decayed opsSeen and status as getStatus, after time has passed", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const db = new LocalDbController("test-dump-decay");
    const service = new ReputationService(db, 1337, 10, 10, 50, 1_000_000_000n, 0);
    await service.setReputation(ADDR, 1000, 0);

    // Advance time so the decay getters actually decay something - the exact
    // amount doesn't matter, only that dump() and fetchOne() agree on it.
    // Decay is on a 24-REAL-HOUR scale (ReputationEntry.opsSeen/opsIncluded),
    // so this must be at least a full hour - a 60-second advance (as this
    // test used before) is beneath the 1-hour granularity and decays
    // nothing, which is exactly the regression this test exists to catch.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    const viaFetchOne = await service.fetchOne(ADDR);
    const viaGetStatus = await service.getStatus(ADDR);
    const dumped = await service.dump();
    const dumpedEntry = dumped.find((e) => e.address === ADDR)!;

    expect(dumpedEntry).toBeDefined();
    expect(dumpedEntry.opsSeen).toBe(viaFetchOne.opsSeen);
    expect(dumpedEntry.opsIncluded).toBe(viaFetchOne.opsIncluded);
    expect(dumpedEntry.status).toBe(viaGetStatus);
    // Pin that decay genuinely happened (not just "both are 1000 because
    // neither decayed") - otherwise this test wouldn't catch the bug.
    expect(dumpedEntry.opsSeen).toBeLessThan(1000);
  });
});

describe("ReputationService.checkStake: withdrawTime", () => {
  it("rejects a stake whose withdrawal has already been initiated, even when stake and delay both clear the threshold", async () => {
    const db = new LocalDbController("test-checkstake-withdrawtime");
    const minStake = 1_000_000_000n;
    const minUnstakeDelay = 10;
    const service = new ReputationService(db, 1337, 10, 10, 50, minStake, minUnstakeDelay);

    const result = await service.checkStake({
      addr: ADDR,
      stake: minStake,
      unstakeDelaySec: minUnstakeDelay,
      withdrawTime: 123456n,
    });

    expect(result.code).not.toBe(0);
    expect(result.msg).toContain(ADDR);
  });

  it("accepts a stake that clears every threshold when no withdrawal has been initiated", async () => {
    const db = new LocalDbController("test-checkstake-withdrawtime-ok");
    const minStake = 1_000_000_000n;
    const minUnstakeDelay = 10;
    const service = new ReputationService(db, 1337, 10, 10, 50, minStake, minUnstakeDelay);

    const result = await service.checkStake({
      addr: ADDR,
      stake: minStake,
      unstakeDelaySec: minUnstakeDelay,
      withdrawTime: 0n,
    });

    expect(result).toEqual({ msg: "", code: 0 });
  });
});
