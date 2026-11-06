import { describe, it, expect, vi } from "vitest";
import { StakingRegistryService } from "../../../src/services/StakingRegistryService/index.js";

describe("StakingRegistryService", () => {
  it("getDepositInfo reads stake/unstakeDelaySec/withdrawTime off a configured registry contract", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue([2_000_000_000_000_000_000n, 172800, 0n]), // stake, unstakeDelaySec, withdrawTime
    } as any;
    const svc = new StakingRegistryService(publicClient, "0x6666666666666666666666666666666666666666");
    const result = await svc.getDepositInfo("0x7777777777777777777777777777777777777777");
    expect(result).toEqual({
      stake: 2_000_000_000_000_000_000n,
      unstakeDelaySec: 172800,
      withdrawTime: 0n,
    });
  });

  it("getDepositInfo reports zero stake without touching the chain when no registry is configured (zero address)", async () => {
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(new Error("should not be called")),
    } as any;
    const svc = new StakingRegistryService(
      publicClient,
      "0x0000000000000000000000000000000000000000"
    );
    const result = await svc.getDepositInfo("0x7777777777777777777777777777777777777777");
    expect(result).toEqual({ stake: 0n, unstakeDelaySec: 0, withdrawTime: 0n });
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });
});
