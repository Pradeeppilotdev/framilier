import { describe, it, expect, vi } from "vitest";
import { ReceiptService } from "../../../src/services/ReceiptService/index.js";

/**
 * ethrex's real `RpcFrameReceipt` flattens per-frame gas into two sibling
 * fields (`gasUsed`, `stateGasUsed`), not a nested `gasUsed: {execution,
 * state}` shape. The mocked RPC response below matches the real wire shape;
 * ReceiptService re-nests these into `{execution, state}` on its own output
 * type.
 */
describe("ReceiptService.getReceipt", () => {
  it("parses payer and per-frame status/gasUsed from a raw frame-tx receipt", async () => {
    const publicClient = {
      request: vi.fn().mockResolvedValue({
        type: "0x6",
        status: "0x1",
        cumulativeGasUsed: "0x186a0",
        logsBloom: "0x0",
        logs: [],
        transactionHash: "0x" + "aa".repeat(32),
        transactionIndex: "0x0",
        blockHash: "0x" + "bb".repeat(32),
        blockNumber: "0x1",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        gasUsed: "0x186a0",
        effectiveGasPrice: "0x1",
        contractAddress: null,
        payer: "0x8888888888888888888888888888888888888888",
        frameReceipts: [
          { status: "0x1", gasUsed: "0x100", stateGasUsed: "0x0", logs: [] },
          { status: "0x1", gasUsed: "0x200", stateGasUsed: "0x50", logs: [] },
        ],
      }),
    } as any;

    const svc = new ReceiptService(publicClient);
    const receipt = await svc.getReceipt(("0x" + "aa".repeat(32)) as `0x${string}`);

    expect(publicClient.request).toHaveBeenCalledWith({
      method: "eth_getTransactionReceipt",
      params: [("0x" + "aa".repeat(32)) as `0x${string}`],
    });
    expect(receipt.cumulativeGasUsed).toBe(0x186a0n);
    expect(receipt.payer).toBe("0x8888888888888888888888888888888888888888");
    expect(receipt.status).toBe("success");
    expect(receipt.frameReceipts).toHaveLength(2);
    expect(receipt.frameReceipts[0].status).toBe("success");
    expect(receipt.frameReceipts[0].gasUsed.execution).toBe(0x100n);
    expect(receipt.frameReceipts[0].gasUsed.state).toBe(0x0n);
    expect(receipt.frameReceipts[1].gasUsed.execution).toBe(0x200n);
    expect(receipt.frameReceipts[1].gasUsed.state).toBe(0x50n);
  });

  it("decodes a reverted/skipped per-frame status", async () => {
    const publicClient = {
      request: vi.fn().mockResolvedValue({
        status: "0x0",
        cumulativeGasUsed: "0x0",
        blockNumber: "0x2a",
        payer: "0x8888888888888888888888888888888888888888",
        frameReceipts: [
          { status: "0x0", gasUsed: "0x0", stateGasUsed: "0x0", logs: [] },
          { status: "0x2", gasUsed: "0x0", stateGasUsed: "0x0", logs: [] },
        ],
      }),
    } as any;

    const svc = new ReceiptService(publicClient);
    const receipt = await svc.getReceipt(("0x" + "aa".repeat(32)) as `0x${string}`);

    expect(receipt.status).toBe("reverted");
    expect(receipt.frameReceipts[0].status).toBe("reverted");
    expect(receipt.frameReceipts[1].status).toBe("skipped");
  });

  it("decodes the whole-transaction status independently of the 3-value per-frame encoding", async () => {
    const publicClient = {
      request: vi.fn().mockResolvedValue({
        status: "0x1",
        cumulativeGasUsed: "0x0",
        blockNumber: "0x2a",
        payer: "0x8888888888888888888888888888888888888888",
        frameReceipts: [],
      }),
    } as any;

    const svc = new ReceiptService(publicClient);
    const receipt = await svc.getReceipt(("0x" + "aa".repeat(32)) as `0x${string}`);

    expect(receipt.status).toBe("success");
  });

  it("throws on an unknown whole-transaction status value", async () => {
    const publicClient = {
      request: vi.fn().mockResolvedValue({
        status: "0x2", // valid for a per-frame status, not for the whole tx
        cumulativeGasUsed: "0x0",
        blockNumber: "0x2a",
        payer: "0x8888888888888888888888888888888888888888",
        frameReceipts: [],
      }),
    } as any;

    const svc = new ReceiptService(publicClient);
    await expect(
      svc.getReceipt(("0x" + "aa".repeat(32)) as `0x${string}`)
    ).rejects.toThrow(/unknown transaction receipt status/i);
  });

  it("throws when the receipt is not found (null response)", async () => {
    const publicClient = {
      request: vi.fn().mockResolvedValue(null),
    } as any;

    const svc = new ReceiptService(publicClient);
    await expect(
      svc.getReceipt(("0x" + "aa".repeat(32)) as `0x${string}`)
    ).rejects.toThrow(/not found/i);
  });

  it("throws when the receipt exists but is not a frame transaction", async () => {
    const publicClient = {
      request: vi.fn().mockResolvedValue({
        type: "0x2",
        status: "0x1",
        cumulativeGasUsed: "0x186a0",
        logs: [],
        // no `payer`/`frameReceipts` - a standard, non-frame transaction.
      }),
    } as any;

    const svc = new ReceiptService(publicClient);
    await expect(
      svc.getReceipt(("0x" + "aa".repeat(32)) as `0x${string}`)
    ).rejects.toThrow(/not a frame transaction/i);
  });
});
