import { PublicClient, Hex } from "viem";

const STAKING_REGISTRY_ABI = [
  {
    type: "function", name: "getDepositInfo", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "stake", type: "uint256" },
      { name: "unstakeDelaySec", type: "uint32" },
      { name: "withdrawTime", type: "uint64" },
    ],
  },
] as const;

/**
 * The registry address the executor passes when no staking registry is
 * configured. `NetworkConfig` has no registry-address field yet (no task in
 * this plan added one), so `Executor` supplies the zero address as an
 * explicit "unconfigured" marker - see its comment at the construction site.
 */
const UNCONFIGURED_REGISTRY = "0x0000000000000000000000000000000000000000";

/** What an unconfigured registry reports: no stake, no delay. */
const NO_DEPOSIT = {
  stake: BigInt(0),
  unstakeDelaySec: 0,
  withdrawTime: BigInt(0),
};

export class StakingRegistryService {
  constructor(
    private publicClient: PublicClient,
    private registryAddress: Hex
  ) {}

  /** True when no real registry contract address was supplied. */
  private get isUnconfigured(): boolean {
    return (
      this.registryAddress.toLowerCase() === UNCONFIGURED_REGISTRY
    );
  }

  async getDepositInfo(entity: Hex): Promise<{ stake: bigint; unstakeDelaySec: number; withdrawTime: bigint }> {
    // Against a real chain the zero address has no code, so `readContract`
    // gets back "0x" and viem raises ContractFunctionZeroDataError. That
    // propagated out of `FrameTxValidationService.resolveRoleStakes` and
    // failed EVERY `eth_sendFrameTransaction` with a bare "Unexpected
    // behaviour" - the placeholder address turned an absent optional feature
    // into a hard outage. It only stayed hidden because the unit suites mock
    // this service.
    //
    // "No registry configured" means "no stake information available", which
    // is exactly zero stake - the conservative answer, and the one the
    // reputation gate already handles (entities simply count as unstaked).
    // Short-circuited on the address rather than by catching the error, so a
    // genuinely configured registry still surfaces its failures.
    if (this.isUnconfigured) {
      return { ...NO_DEPOSIT };
    }
    const [stake, unstakeDelaySec, withdrawTime] = (await this.publicClient.readContract({
      address: this.registryAddress,
      abi: STAKING_REGISTRY_ABI,
      functionName: "getDepositInfo",
      args: [entity],
    })) as unknown as [bigint, number, bigint];
    return { stake, unstakeDelaySec, withdrawTime };
  }
}
