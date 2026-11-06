import { describe, expect, it, vi } from "vitest";
import { Skandha } from "@skandha/executor/lib/modules/skandha.js";
import { SkandhaAPI } from "../../../src/modules/skandha.js";

function buildSkandhaAPI(overrides: Partial<Skandha> = {}): {
  skandhaAPI: SkandhaAPI;
  skandhaModule: Skandha;
} {
  const skandhaModule = {
    getFrameTransactionStatus: vi.fn(),
    getGasPrice: vi.fn(),
    getConfig: vi.fn(),
    connectedPeers: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as Skandha;

  return { skandhaAPI: new SkandhaAPI(skandhaModule), skandhaModule };
}

/**
 * `SkandhaAPI`'s constructor takes only the sidecar module now (Task
 * 25b) - the old `Eth` dependency existed solely for `getFeeHistory`'s
 * `validateEntryPoint` check, and `getFeeHistory` has no EIP-8141 analogue
 * (see `skandha.ts`'s header comment).
 */
describe("SkandhaAPI", () => {
  it("getFrameTransactionStatus (replaces getUserOperationStatus) passes the hash straight through", async () => {
    const status = {
      tx: {},
      sender: "0x1111111111111111111111111111111111111111",
      payer: "0x1111111111111111111111111111111111111111",
      status: "New",
    };
    const { skandhaAPI, skandhaModule } = buildSkandhaAPI({
      getFrameTransactionStatus: vi.fn().mockResolvedValue(status),
    });

    const result = await skandhaAPI.getFrameTransactionStatus("0xhash");

    expect(result).toBe(status);
    expect(skandhaModule.getFrameTransactionStatus).toHaveBeenCalledWith(
      "0xhash"
    );
  });

  it("getGasPrice passes through", async () => {
    const gasPrice = { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    const { skandhaAPI } = buildSkandhaAPI({
      getGasPrice: vi.fn().mockResolvedValue(gasPrice),
    });
    await expect(skandhaAPI.getGasPrice()).resolves.toBe(gasPrice);
  });

  it("getConfig passes through", async () => {
    const config = { chainId: 1337 };
    const { skandhaAPI } = buildSkandhaAPI({
      getConfig: vi.fn().mockResolvedValue(config),
    });
    await expect(skandhaAPI.getConfig()).resolves.toBe(config);
  });

  it("connectedPeers passes through", () => {
    const { skandhaAPI } = buildSkandhaAPI({
      connectedPeers: vi.fn().mockReturnValue(["peer1"]),
    });
    expect(skandhaAPI.connectedPeers()).toEqual(["peer1"]);
  });
});
