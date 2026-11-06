import { describe, expect, it, vi } from "vitest";
import { Eth } from "@skandha/executor/lib/modules/eth.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { EthAPI } from "../../../src/modules/eth.js";
import {
  validFrameTransaction,
  validFrameTransactionWire,
} from "../../fixtures.js";

function buildEthAPI(overrides: Partial<Eth> = {}): {
  ethAPI: EthAPI;
  ethModule: Eth;
} {
  const ethModule = {
    sendFrameTransaction: vi.fn().mockResolvedValue("0xhash"),
    estimateFrameTransactionGas: vi.fn().mockResolvedValue({
      frames: [],
      cumulativeGasUsed: 0n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    }),
    getFrameTransactionByHash: vi.fn().mockResolvedValue(null),
    getFrameTransactionReceipt: vi.fn(),
    getChainId: vi.fn().mockResolvedValue(1337),
    ...overrides,
  } as unknown as Eth;

  return { ethAPI: new EthAPI(ethModule), ethModule };
}

describe("EthAPI", () => {
  describe("sendFrameTransaction", () => {
    it("decodes the hex-string wire payload into a real FrameTransaction and forwards it to Eth.sendFrameTransaction", async () => {
      const { ethAPI, ethModule } = buildEthAPI();

      const result = await ethAPI.sendFrameTransaction(
        validFrameTransactionWire as any
      );

      expect(result).toEqual("0xhash");
      expect(ethModule.sendFrameTransaction).toHaveBeenCalledWith(
        validFrameTransaction
      );
    });

    it("rejects a payload missing a required field (sender) before ever calling Eth", async () => {
      const { ethAPI, ethModule } = buildEthAPI();
      const { sender: _sender, ...withoutSender } = validFrameTransactionWire;

      await expect(
        ethAPI.sendFrameTransaction(withoutSender as any)
      ).rejects.toThrow(RpcError);
      expect(ethModule.sendFrameTransaction).not.toHaveBeenCalled();
    });
  });

  describe("sendFrameTransaction - EIP-8250 nonce forms and EIP-8272 references", () => {
    const { nonce: _nonce, ...withoutNonce } = validFrameTransactionWire;
    const SOURCE_ID = `0x${"a".repeat(64)}`;
    const ROOT = `0x${"b".repeat(64)}`;

    it("reads the legacy `nonce` as the linear domain: nonceKeys [0], nonceSeq = nonce", async () => {
      const { ethAPI, ethModule } = buildEthAPI();
      await ethAPI.sendFrameTransaction({ ...validFrameTransactionWire, nonce: "0x2a" } as any);
      expect(ethModule.sendFrameTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ nonceKeys: [0n], nonceSeq: 42n })
      );
    });

    it("decodes keyed nonces and recent-root references", async () => {
      const { ethAPI, ethModule } = buildEthAPI();
      await ethAPI.sendFrameTransaction({
        ...withoutNonce,
        nonceKeys: ["0x1", "0xff"],
        nonceSeq: "0x0",
        recentRootReferences: [{ sourceId: SOURCE_ID, slot: "0x3fc67", root: ROOT }],
      } as any);
      expect(ethModule.sendFrameTransaction).toHaveBeenCalledWith({
        ...validFrameTransaction,
        nonceKeys: [1n, 255n],
        nonceSeq: 0n,
        recentRootReferences: [{ sourceId: SOURCE_ID, slot: 0x3fc67n, root: ROOT }],
      });
    });

    it.each([
      ["both nonce forms", { ...validFrameTransactionWire, nonceKeys: ["0x1"], nonceSeq: "0x0" }, /not both/],
      ["no nonce at all", withoutNonce, /missing nonce/],
      ["nonceKeys without nonceSeq", { ...withoutNonce, nonceKeys: ["0x1"] }, /together/],
      ["key 0 mixed with a keyed nonce", { ...withoutNonce, nonceKeys: ["0x0", "0x1"], nonceSeq: "0x0" }, /sole nonce key/],
      ["unsorted keys", { ...withoutNonce, nonceKeys: ["0x2", "0x1"], nonceSeq: "0x0" }, /strictly increasing/],
    ])("rejects %s with INVALID_PARAMS, before calling Eth", async (_, payload, message) => {
      const { ethAPI, ethModule } = buildEthAPI();
      const err = await ethAPI.sendFrameTransaction(payload as any).catch((e) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect(err.code).toBe(RpcErrorCodes.INVALID_USEROP);
      expect(err.message).toMatch(message);
      expect(ethModule.sendFrameTransaction).not.toHaveBeenCalled();
    });

    it("rejects a malformed reference (short sourceId) at DTO validation", async () => {
      const { ethAPI, ethModule } = buildEthAPI();
      await expect(
        ethAPI.sendFrameTransaction({
          ...validFrameTransactionWire,
          recentRootReferences: [{ sourceId: "0xaa", slot: "0x1", root: ROOT }],
        } as any)
      ).rejects.toThrow(RpcError);
      expect(ethModule.sendFrameTransaction).not.toHaveBeenCalled();
    });
  });

  describe("estimateFrameTransactionGas", () => {
    it("decodes a partial (chainId/nonce/signatures/fees/blobVersionedHashes-omitted) payload", async () => {
      const { ethAPI, ethModule } = buildEthAPI();
      const partial = {
        sender: validFrameTransactionWire.sender,
        frames: validFrameTransactionWire.frames,
      };

      await ethAPI.estimateFrameTransactionGas(partial as any);

      expect(ethModule.estimateFrameTransactionGas).toHaveBeenCalledWith({
        chainId: undefined,
        nonceKeys: undefined,
        nonceSeq: undefined,
        sender: partial.sender,
        frames: validFrameTransaction.frames,
        signatures: undefined,
        fees: undefined,
        blobVersionedHashes: undefined,
        recentRootReferences: undefined,
      });
    });

    it("rejects a payload missing frames", async () => {
      const { ethAPI, ethModule } = buildEthAPI();
      const partial = { sender: validFrameTransactionWire.sender };

      await expect(
        ethAPI.estimateFrameTransactionGas(partial as any)
      ).rejects.toThrow(RpcError);
      expect(ethModule.estimateFrameTransactionGas).not.toHaveBeenCalled();
    });
  });

  it("getFrameTransactionByHash passes the hash straight through", async () => {
    const { ethAPI, ethModule } = buildEthAPI({
      getFrameTransactionByHash: vi.fn().mockResolvedValue(null),
    });

    const result = await ethAPI.getFrameTransactionByHash("0xhash");

    expect(result).toBeNull();
    expect(ethModule.getFrameTransactionByHash).toHaveBeenCalledWith(
      "0xhash"
    );
  });

  describe("getFrameTransactionReceipt", () => {
    it("passes a found receipt straight through", async () => {
      const receipt = {
        cumulativeGasUsed: 100n,
        payer: "0x1111111111111111111111111111111111111111",
        frameReceipts: [],
      };
      const { ethAPI } = buildEthAPI({
        getFrameTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      });

      const result = await ethAPI.getFrameTransactionReceipt("0xhash");

      expect(result).toBe(receipt);
    });

    it("lets a 'not found' RpcError from ReceiptService surface as-is, rather than translating it to null (this task's deliberate design choice - see eth.ts's doc comment)", async () => {
      const notFound = new RpcError(
        "transaction receipt not found for 0xhash",
        RpcErrorCodes.SERVER_ERROR
      );
      const { ethAPI } = buildEthAPI({
        getFrameTransactionReceipt: vi.fn().mockRejectedValue(notFound),
      });

      await expect(
        ethAPI.getFrameTransactionReceipt("0xhash")
      ).rejects.toBe(notFound);
    });
  });

  it("getChainId passes through", async () => {
    const { ethAPI } = buildEthAPI();
    await expect(ethAPI.getChainId()).resolves.toEqual(1337);
  });
});
