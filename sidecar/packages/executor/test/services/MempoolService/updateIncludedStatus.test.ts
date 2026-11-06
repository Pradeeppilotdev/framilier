import { describe, it, expect, vi } from "vitest";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { ExecutorEvent, ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { LocalDbController } from "../../mocks/database.js";
import { FrameTxMempoolEntry } from "../../../src/entities/FrameTxMempoolEntry.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;

const tx = (): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender: SENDER,
  frames: [
    {
      mode: FRAME_MODE.VERIFY,
      flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
      target: null,
      limits: { execution: 1n, state: 0n },
      value: 0n,
      data: "0x",
    },
  ],
  signatures: [],
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

const fakeLogger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn() }) as any;

describe("MempoolService.updateStatus: OnChain transition", () => {
  it("bumps included status for the entry's addresses when it transitions to OnChain", async () => {
    const db = new LocalDbController("test-update-included");
    const reputationService = {
      updateIncludedStatus: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventBus = new ExecutorEventBus();
    const networkConfig = {} as any;
    const service = new MempoolService(db, 1337, reputationService, eventBus, networkConfig, fakeLogger());
    const entry = new FrameTxMempoolEntry(tx(), { txHash: "0xabc", status: MempoolEntryStatus.Submitted });

    await service.updateStatus([entry], MempoolEntryStatus.OnChain);

    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(SENDER);
  });

  it("does not bump included status for a non-OnChain transition", async () => {
    const db = new LocalDbController("test-update-included-2");
    const reputationService = {
      updateIncludedStatus: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventBus = new ExecutorEventBus();
    const networkConfig = {} as any;
    const service = new MempoolService(db, 1337, reputationService, eventBus, networkConfig, fakeLogger());
    const entry = new FrameTxMempoolEntry(tx(), { txHash: "0xabc", status: MempoolEntryStatus.New });

    await service.updateStatus([entry], MempoolEntryStatus.Submitted);

    expect(reputationService.updateIncludedStatus).not.toHaveBeenCalled();
  });

  it("emits onChainUserOps for a Reverted transition, but still does not bump included status", async () => {
    const db = new LocalDbController("test-update-included-3");
    const reputationService = {
      updateIncludedStatus: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventBus = new ExecutorEventBus();
    const networkConfig = {} as any;
    const service = new MempoolService(db, 1337, reputationService, eventBus, networkConfig, fakeLogger());
    const entry = new FrameTxMempoolEntry(tx(), { txHash: "0xabc", status: MempoolEntryStatus.Submitted });
    const seen: any[] = [];
    eventBus.on(ExecutorEvent.onChainUserOps, (e) => seen.push(e));

    await service.updateStatus([entry], MempoolEntryStatus.Reverted, {
      revertReason: "out of gas",
      includer: "0x7777777777777777777777777777777777777777",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].includer).toBe("0x7777777777777777777777777777777777777777");
    expect(reputationService.updateIncludedStatus).not.toHaveBeenCalled();
  });
});
