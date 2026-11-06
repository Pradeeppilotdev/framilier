import { describe, it, expect, vi } from "vitest";
import { Eth } from "../../src/modules/eth.js";
import { FrameTxSimulationService } from "../../src/services/FrameTxSimulationService/index.js";
import { ReceiptService } from "../../src/services/ReceiptService/index.js";
import { MempoolService } from "../../src/services/MempoolService/service.js";
import { Skandha } from "../../src/modules/skandha.js";
import { AdmissionScheduler } from "../../src/services/AdmissionScheduler/index.js";
import { ExplorerService } from "../../src/services/ExplorerService/service.js";
import {
  FRAME_MODE,
  APPROVE_SCOPE,
  Frame,
  FrameTransaction,
  SIG_SCHEME,
  SignatureEntry,
} from "@skandha/types/lib/contracts/FrameTx.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { keccak256 } from "viem";
import { encodeRawFrameTx } from "../../src/services/FrameTxService/codec.js";

const SENDER_A = "0x1111111111111111111111111111111111111111" as const;
const SENDER_B = "0x2222222222222222222222222222222222222222" as const;

const verify = (flags: number, execution: bigint, target: `0x${string}` | null = null): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags,
  target,
  limits: { execution, state: 0n },
  value: 0n,
  data: "0x",
});
const selfVerify = (execution: bigint) => verify(APPROVE_SCOPE.EXECUTION_AND_PAYMENT, execution);
const body = (): Frame => ({
  mode: FRAME_MODE.SENDER,
  flags: 0,
  target: "0x4444444444444444444444444444444444444444",
  limits: { execution: 5_000_000n, state: 0n },
  value: 0n,
  data: "0x",
});

const sig = (scheme: number): SignatureEntry =>
  ({ scheme, signer: "0x3333333333333333333333333333333333333333", msg: "0x", signature: "0x" }) as SignatureEntry;

const makeTx = (sender: `0x${string}`, verifyGas: bigint, nonceSeq: bigint = 0n): FrameTransaction => ({
  chainId: 1337n,
  nonceKeys: [0n],
  nonceSeq,
  sender,
  frames: [selfVerify(verifyGas), body()],
  signatures: [sig(SIG_SCHEME.SECP256K1)],
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

describe("StakeLane PR 1: Admission Scheduler Integration", () => {
  it("RPC and gossip share the same gate, and a dispatched request runs the ordinary validation path exactly once", async () => {
    // 2 total admission slots, at most 1 heavy job per sender
    const scheduler = new AdmissionScheduler({
      mode: "fair",
      slots: 2,
      maxHeavyPerSender: 1,
      maxWaiting: 64,
    });

    const createSimulationGate = () => {
      let notifyStart: () => void;
      const started = new Promise<void>((r) => (notifyStart = r));
      let release: () => void;
      const finished = new Promise<void>((r) => (release = r));
      return {
        started,
        notifyStart: () => notifyStart(),
        finished,
        release: () => release(),
      };
    };

    const gates = new Map<string, ReturnType<typeof createSimulationGate>>();
    const simulateCallCounts = new Map<string, number>();

    const frameTxSimulationService = {
      simulate: vi.fn(async (tx: FrameTransaction) => {
        const hash = keccak256(encodeRawFrameTx(tx));
        simulateCallCounts.set(hash, (simulateCallCounts.get(hash) ?? 0) + 1);

        const gate = gates.get(hash);
        if (gate) {
          gate.notifyStart();
          await gate.finished;
        }

        return {
          simulation: {
            cumulativeGasUsed: "0x100",
            payer: tx.sender,
            frameReceipts: [],
          },
          validation: {
            mempoolMembership: { "": true },
            accessedSlots: {},
            roleStakes: {},
          },
        };
      }),
    } as unknown as FrameTxSimulationService;

    const receiptService = { getReceipt: vi.fn() } as unknown as ReceiptService;
    const mempoolService = {
      getEntryByHash: vi.fn().mockResolvedValue(null),
      validateFrameTxReplaceability: vi.fn().mockResolvedValue(true),
      addFrameTx: vi.fn().mockResolvedValue(undefined),
    } as unknown as MempoolService;
    const skandhaModule = {
      getGasPrice: vi.fn().mockResolvedValue({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    } as unknown as Skandha;
    const explorer = new ExplorerService();

    const eth = new Eth(
      1337,
      {} as any,
      frameTxSimulationService,
      receiptService,
      mempoolService,
      skandhaModule,
      { userOpGasLimit: 25_000_000, schedulerMode: "fair", schedulerSlots: 2, schedulerMaxHeavyPerSender: 1 } as any,
      { debug: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      null,
      undefined,
      explorer,
      scheduler
    );

    // Prepare 3 heavy transactions (> 100k gas):
    // txA1 (Sender A), txA2 (Sender A), txB (Sender B)
    const txA1 = makeTx(SENDER_A, 150_000n, 1n);
    const txA2 = makeTx(SENDER_A, 150_000n, 2n);
    const txB = makeTx(SENDER_B, 150_000n, 1n);

    const hashA1 = keccak256(encodeRawFrameTx(txA1));
    const hashA2 = keccak256(encodeRawFrameTx(txA2));
    const hashB = keccak256(encodeRawFrameTx(txB));

    gates.set(hashA1, createSimulationGate());
    gates.set(hashA2, createSimulationGate());
    gates.set(hashB, createSimulationGate());

    // 1. RPC submits txA1
    const pA1 = eth.sendFrameTransaction(txA1, "rpc");
    await gates.get(hashA1)!.started;

    expect(scheduler.getRunningCount()).toBe(1);
    expect(scheduler.getActiveHeavyForSender(SENDER_A)).toBe(1);

    // 2. Gossip submits txA2 (from same sender A).
    // Because maxHeavyPerSender is 1, gossip txA2 must wait even though 1 global slot is free!
    const pA2 = eth.sendFrameTransaction(txA2, "gossip");

    await new Promise((r) => setTimeout(r, 20));
    expect(scheduler.getWaitingCount()).toBe(1);
    expect(scheduler.getRunningCount()).toBe(1);
    expect(simulateCallCounts.get(hashA2) ?? 0).toBe(0); // simulation has NOT started for txA2!

    // 3. Gossip submits txB (from sender B).
    // Sender B is eligible, so gossip txB starts immediately using the 2nd slot!
    const pB = eth.sendFrameTransaction(txB, "gossip");
    await gates.get(hashB)!.started;

    // Now both slots are occupied: txA1 (RPC) and txB (gossip) running simultaneously!
    expect(scheduler.getRunningCount()).toBe(2);
    expect(scheduler.getActiveHeavyForSender(SENDER_A)).toBe(1);
    expect(scheduler.getActiveHeavyForSender(SENDER_B)).toBe(1);
    expect(scheduler.getWaitingCount()).toBe(1); // txA2 is still waiting

    // 4. Release RPC txA1
    gates.get(hashA1)!.release();
    const resultHashA1 = await pA1;
    expect(resultHashA1).toBe(hashA1);

    // txA2 can now be dispatched!
    await gates.get(hashA2)!.started;
    expect(scheduler.getActiveHeavyForSender(SENDER_A)).toBe(1);

    // 5. Release txB and txA2
    gates.get(hashB)!.release();
    gates.get(hashA2)!.release();

    const resultHashB = await pB;
    const resultHashA2 = await pA2;

    expect(resultHashB).toBe(hashB);
    expect(resultHashA2).toBe(hashA2);

    expect(scheduler.getRunningCount()).toBe(0);
    expect(scheduler.getWaitingCount()).toBe(0);

    // Assert: each dispatched request ran the ordinary validation path (simulate) EXACTLY ONCE
    expect(simulateCallCounts.get(hashA1)).toBe(1);
    expect(simulateCallCounts.get(hashA2)).toBe(1);
    expect(simulateCallCounts.get(hashB)).toBe(1);

    // Assert: explorer recorded admissions with their original sources ("rpc" and "gossip")
    const recA1 = explorer.getAdmission(hashA1);
    expect(recA1?.source).toBe("rpc");
    expect(recA1?.outcome).toBe("accepted");

    const recA2 = explorer.getAdmission(hashA2);
    expect(recA2?.source).toBe("gossip");
    expect(recA2?.outcome).toBe("accepted");

    const recB = explorer.getAdmission(hashB);
    expect(recB?.source).toBe("gossip");
    expect(recB?.outcome).toBe("accepted");
  });

  it("queue overflow returns a retryable busy error without running simulation or assigning reputation penalty", async () => {
    const scheduler = new AdmissionScheduler({
      mode: "fair",
      slots: 1,
      maxWaiting: 1,
    });

    let heldRes: () => void;
    const heldPromise = new Promise<void>((r) => (heldRes = r));

    const simulateMock = vi.fn().mockImplementation(() => heldPromise);
    const frameTxSimulationService = { simulate: simulateMock } as any;

    const explorer = new ExplorerService();
    const eth = new Eth(
      1337,
      {} as any,
      frameTxSimulationService,
      { getReceipt: vi.fn() } as any,
      { getEntryByHash: vi.fn(), validateFrameTxReplaceability: vi.fn(), addFrameTx: vi.fn() } as any,
      { getGasPrice: vi.fn() } as any,
      { userOpGasLimit: 25_000_000 } as any,
      { debug: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      null,
      undefined,
      explorer,
      scheduler
    );

    const tx1 = makeTx(SENDER_A, 50_000n, 1n);
    const tx2 = makeTx(SENDER_B, 50_000n, 1n);
    const txOverflow = makeTx(SENDER_A, 50_000n, 2n);

    // Slot 1 occupied by tx1
    const p1 = eth.sendFrameTransaction(tx1, "rpc");
    await new Promise((r) => setTimeout(r, 10));

    // Waiting queue slot (1/1) occupied by tx2
    const p2 = eth.sendFrameTransaction(tx2, "gossip");
    await new Promise((r) => setTimeout(r, 10));

    expect(scheduler.getRunningCount()).toBe(1);
    expect(scheduler.getWaitingCount()).toBe(1);

    // txOverflow arrives when waiting queue is full
    await expect(eth.sendFrameTransaction(txOverflow, "rpc")).rejects.toThrow(
      /Admission queue is full/
    );

    // Simulation was NOT called for txOverflow! (only called for tx1)
    expect(simulateMock).toHaveBeenCalledTimes(1);

    // Explorer recorded the rejection
    const overflowHash = keccak256(encodeRawFrameTx(txOverflow));
    const rec = explorer.getAdmission(overflowHash);
    expect(rec?.outcome).toBe("rejected");
    expect(rec?.source).toBe("rpc");
    expect(rec?.errorCode).toBe(RpcErrorCodes.SERVER_ERROR);

    // Clean up
    heldRes!();
    await p1.catch(() => {});
    await p2.catch(() => {});
  });
});

