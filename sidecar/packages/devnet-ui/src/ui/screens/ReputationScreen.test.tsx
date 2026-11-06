import { describe, it, expect } from "vitest";
import { stakeLabel } from "./ReputationScreen";
import type { ReputationEntry } from "../../protocol/schemas";

const base: ReputationEntry = {
  address: "0x1111111111111111111111111111111111111111",
  opsSeen: 0,
  opsIncluded: 0,
  status: "ok",
  isWhitelisted: false,
  isBlacklisted: false,
  stake: "0x0",
  unstakeDelaySec: 0,
  withdrawTime: "0x0",
  isStaked: false,
};

describe("ReputationScreen stakeLabel", () => {
  it("labels a staked entity with no pending withdrawal as staked", () => {
    expect(stakeLabel({ ...base, isStaked: true, withdrawTime: "0x0" })).toBe("staked");
  });

  it("labels an entity that has initiated a withdrawal as unlocking, even though isStaked is now false", () => {
    expect(stakeLabel({ ...base, isStaked: false, withdrawTime: "0x1e240" })).toBe("unlocking");
  });

  it("labels a plain unstaked entity (no deposit at all) as neither", () => {
    expect(stakeLabel({ ...base, isStaked: false, withdrawTime: "0x0" })).toBeNull();
  });
});
