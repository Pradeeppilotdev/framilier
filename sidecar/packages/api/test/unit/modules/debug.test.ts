import { describe, expect, it, vi } from "vitest";
import { Debug } from "@skandha/executor/lib/modules/debug.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import { DebugAPI } from "../../../src/modules/debug.js";
import {
  validFrameTransaction,
  validFrameTransactionWire,
} from "../../fixtures.js";

function buildDebugAPI(overrides: Partial<Debug> = {}): {
  debugAPI: DebugAPI;
  debugModule: Debug;
} {
  const debugModule = {
    setBundlingMode: vi.fn().mockResolvedValue("ok"),
    clearState: vi.fn().mockResolvedValue("ok"),
    clearMempool: vi.fn().mockResolvedValue("ok"),
    dumpMempool: vi.fn().mockResolvedValue([]),
    dumpMempoolRaw: vi.fn().mockResolvedValue([]),
    sendBundleNow: vi.fn().mockResolvedValue("ok"),
    setBundlingInterval: vi.fn().mockResolvedValue("ok"),
    setReputation: vi.fn().mockResolvedValue("ok"),
    dumpReputation: vi.fn().mockResolvedValue([]),
    setMempool: vi.fn().mockResolvedValue("ok"),
    getStakeStatus: vi.fn(),
    clearReputation: vi.fn().mockResolvedValue("ok"),
    setPrivilegedRelayTargetBlock: vi.fn().mockResolvedValue("ok"),
    ...overrides,
  } as unknown as Debug;

  return { debugAPI: new DebugAPI(debugModule), debugModule };
}

describe("DebugAPI", () => {
  it("dumpMempool (frame-transaction shaped) passes through", async () => {
    const { debugAPI, debugModule } = buildDebugAPI();
    await debugAPI.dumpMempool();
    expect(debugModule.dumpMempool).toHaveBeenCalled();
  });

  it("dumpMempoolRaw (frame-transaction shaped) passes through", async () => {
    const { debugAPI, debugModule } = buildDebugAPI();
    await debugAPI.dumpMempoolRaw();
    expect(debugModule.dumpMempoolRaw).toHaveBeenCalled();
  });

  describe("setMempool", () => {
    it("decodes each hex-string wire tx into a real FrameTransaction and drops the old entryPoint field entirely", async () => {
      const { debugAPI, debugModule } = buildDebugAPI();

      await debugAPI.setMempool({
        txs: [validFrameTransactionWire],
      } as any);

      expect(debugModule.setMempool).toHaveBeenCalledWith({
        txs: [validFrameTransaction],
      });
    });

    it("rejects an empty/malformed tx entry", async () => {
      const { debugAPI, debugModule } = buildDebugAPI();

      await expect(
        debugAPI.setMempool({ txs: [{}] } as any)
      ).rejects.toThrow(RpcError);
      expect(debugModule.setMempool).not.toHaveBeenCalled();
    });
  });

  it("setReputation/dumpReputation/setBundlingInterval/getStakeStatus/clearReputation are untouched pass-throughs", async () => {
    const { debugAPI, debugModule } = buildDebugAPI();

    await debugAPI.setReputation({
      reputations: [],
      entryPoint: "0x1111111111111111111111111111111111111111",
    });
    expect(debugModule.setReputation).toHaveBeenCalled();

    await debugAPI.dumpReputation({
      entryPoint: "0x1111111111111111111111111111111111111111",
    });
    expect(debugModule.dumpReputation).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111"
    );

    await debugAPI.setBundlingInterval({ interval: 5 });
    expect(debugModule.setBundlingInterval).toHaveBeenCalledWith(5);

    await debugAPI.getStakeStatus({
      address: "0x1111111111111111111111111111111111111111",
      entryPoint: "0x2222222222222222222222222222222222222222",
    });
    expect(debugModule.getStakeStatus).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222"
    );

    await debugAPI.clearReputation();
    expect(debugModule.clearReputation).toHaveBeenCalled();
  });

  describe("setPrivilegedRelayTargetBlock", () => {
    it("passes through txHash and targetBlock", async () => {
      const { debugAPI, debugModule } = buildDebugAPI();

      await debugAPI.setPrivilegedRelayTargetBlock({
        txHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        targetBlock: "0x3e7",
      });

      expect(debugModule.setPrivilegedRelayTargetBlock).toHaveBeenCalledWith(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0x3e7"
      );
    });

    it("rejects a malformed txHash", async () => {
      const { debugAPI, debugModule } = buildDebugAPI();

      await expect(
        debugAPI.setPrivilegedRelayTargetBlock({
          txHash: "not-a-hash",
          targetBlock: "0x3e7",
        } as any)
      ).rejects.toThrow(RpcError);
      expect(debugModule.setPrivilegedRelayTargetBlock).not.toHaveBeenCalled();
    });
  });
});
