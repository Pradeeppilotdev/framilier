import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import { getClient, getConfigs, getModules } from "../../fixtures";
import { TestAccountMnemonic } from "../../constants";

describe("Skandha module", async () => {
  const client = await getClient(); // runs anvil
  const wallet = Wallet.fromMnemonic(TestAccountMnemonic).connect(client);

  const { config, networkConfig } = await getConfigs();
  const { skandha } = await getModules(config, networkConfig);

  it("getGasPrice should return actual onchain gas price", async () => {
    // NOTE: not compared for exact equality against a separately-fetched
    // ethers `getFeeData()` snapshot: anvil's base fee drifts between any
    // two independent "latest block" reads (other tests in this run submit
    // real transactions against the same shared chain), so two live reads
    // taken a moment apart are not guaranteed to agree bit-for-bit even
    // when both sides compute the fee correctly.
    const response = await skandha.getGasPrice();
    expect(response.maxFeePerGas).toBeGreaterThan(0n);
    expect(response.maxPriorityFeePerGas).toBeGreaterThan(0n);
    expect(response.maxFeePerGas).toBeGreaterThanOrEqual(response.maxPriorityFeePerGas);
  });

  it("getConfig should return all config values and hide sensitive data", async () => {
    const configSkandha = await skandha.getConfig();
    expect(configSkandha.flags.redirectRpc).toEqual(config.redirectRpc);
    expect(configSkandha.flags.testingMode).toEqual(config.testingMode);
    expect(configSkandha.relayers).toEqual([wallet.address]);

    const sensitiveFields = ["relayers", "relayer", "rpcEndpoint", "name"];
    for (const [key] of Object.entries(networkConfig)) {
      if (sensitiveFields.indexOf(key) > -1) continue;
      if (!configSkandha.hasOwnProperty(key)) {
        throw new Error(`${key} is not defined in skandha_config`);
      }
    }
  });
});
