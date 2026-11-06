import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";

describe("Config.explorerEnabled", () => {
  it("is false unless the explorer option is set", () => {
    const off = new Config({ config: null, unsafeMode: false, redirectRpc: false });
    const on = new Config({
      config: null,
      unsafeMode: false,
      redirectRpc: false,
      explorer: true,
    });
    expect(off.explorerEnabled).toBe(false);
    expect(on.explorerEnabled).toBe(true);
  });
});

describe("Config.getNetworkConfig stakingRegistryAddress", () => {
  it("defaults to the zero address when SKANDHA_STAKING_REGISTRY_ADDRESS is unset", () => {
    const config = new Config({ config: null, unsafeMode: false, redirectRpc: false });
    expect(config.getNetworkConfig().stakingRegistryAddress).toBe(
      "0x0000000000000000000000000000000000000000"
    );
  });

  it("picks up SKANDHA_STAKING_REGISTRY_ADDRESS from the environment", () => {
    const previous = process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
    process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111";
    try {
      const config = new Config({ config: null, unsafeMode: false, redirectRpc: false });
      expect(config.getNetworkConfig().stakingRegistryAddress).toBe(
        "0x1111111111111111111111111111111111111111"
      );
    } finally {
      if (previous === undefined) delete process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
      else process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = previous;
    }
  });

  it("throws immediately on a malformed SKANDHA_STAKING_REGISTRY_ADDRESS, instead of silently failing every admission later", () => {
    const previous = process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
    process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = "0xnotanaddress";
    try {
      expect(() => new Config({ config: null, unsafeMode: false, redirectRpc: false })).toThrow();
    } finally {
      if (previous === undefined) delete process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
      else process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = previous;
    }
  });
});
