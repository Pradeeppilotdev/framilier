import { describe, it, expect, vi, beforeEach } from "vitest";
import { keccak256 } from "viem";
import {
  MempoolEntryStatus,
  ReputationStatus,
} from "@skandha/types/lib/executor";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import { BundlingService } from "../../../src/services/BundlingService/service.js";
import { PrivilegedRelayer } from "../../../src/services/BundlingService/relayers/privileged.js";
import { IRelayingMode } from "../../../src/services/BundlingService/interfaces.js";
import { FrameTxMempoolEntry } from "../../../src/entities/FrameTxMempoolEntry.js";
import { encodeRawFrameTx } from "../../../src/services/FrameTxService/codec.js";
import { logger } from "../../mocks/logger.js";

/**
 * ERC-4337's `BundlingService` assembled N mempool entries into a
 * single `handleOps(ops, beneficiary)` calldata blob, wrapped it in a
 * `{to: EntryPoint, data}` transaction request signed by the BUNDLER'S OWN
 * wallet, and handed that to `IRelayingMode.sendBundle(bundle: Bundle)`.
 *
 * None of that survives EIP-8141: a frame transaction arrives already fully
 * signed by its own sender, `ENTRY_POINT` is a protocol constant rather than
 * a contract to call into, and the bundler's job is to BROADCAST the raw
 * signed bytes - not to reconstruct and re-sign a call of its own.
 *
 * These tests pin the two halves of that contract:
 *   1. `BundlingService.submitFrameTransaction` hands exactly ONE entry, plus
 *      its canonical EIP-2718 bytes, to the configured relayer, and returns
 *      the LOCALLY computed `keccak256(encodeRawFrameTx(tx))` (the same hash
 *      `eth.ts`/`debug.ts` compute - never a relayer's own return value).
 *   2. `PrivilegedRelayer` submits those exact bytes verbatim to the
 *      privileged ethrex endpoint - there is no bundler wallet to sign
 *      anything with any more.
 */

const SELF_VERIFY_FRAME = {
  mode: 1,
  flags: 3,
  target: null,
  limits: { execution: 50_000n, state: 50_000n },
  value: 0n,
  data: "0x",
} as const;

function buildTx(nonce = 0n): FrameTransaction {
  return {
    chainId: 1337n,
    nonceKeys: [0n],
    nonceSeq: nonce,
    sender: "0x1111111111111111111111111111111111111111",
    frames: [{ ...SELF_VERIFY_FRAME }],
    signatures: [
      {
        scheme: 1,
        signer: "0x1111111111111111111111111111111111111111",
        msg: "0x",
        signature: `0x${"ab".repeat(65)}`,
      },
    ],
    fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
    recentRootReferences: [],
  } as FrameTransaction;
}

function buildEntry(tx: FrameTransaction = buildTx()): FrameTxMempoolEntry {
  return new FrameTxMempoolEntry(tx, {
    txHash: keccak256(encodeRawFrameTx(tx)),
  });
}

/**
 * `BundlingService` always constructs its own `PrivilegedRelayer` - there is
 * exactly one strategy now, so there is no injection seam, and adding one
 * purely for tests would widen the production API. The relayer is swapped
 * out after construction instead - the constructor's own `PrivilegedRelayer`
 * is exercised separately, directly, in the second describe block below.
 */
function buildService(
  relayer: Partial<IRelayingMode>,
  networkConfigOverrides: Record<string, any> = {},
  publicClient: Record<string, any> = {}
): {
  service: BundlingService;
  mempoolService: any;
  relayer: IRelayingMode;
} {
  const mempoolService = {
    getNewEntriesSorted: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    attemptToBundle: vi.fn().mockResolvedValue(undefined),
    find: vi.fn().mockResolvedValue(null),
  };

  const fullRelayer: IRelayingMode = {
    isLocked: () => false,
    getAvailableRelayersCount: () => 1,
    canSubmit: async () => true,
    sendFrameTransaction: vi.fn().mockResolvedValue(undefined),
    ...relayer,
  };

  const config = {
    testingMode: false,
    getNetworkConfig: () => networkConfig,
    getRelayers: () => [],
    getBeneficiary: () => null,
  } as any;

  const networkConfig = {
    bundleInterval: 10_000,
    bundleSize: 4,
    enforceGasPrice: false,
    enforceGasPriceThreshold: 0,
    eip1559: true,
    gasPriceMarkup: 0,
    etherscanApiKey: "",
    maxConcurrentSubmissions: 1,
    maxSubmitAttempts: 1,
    ...networkConfigOverrides,
  } as any;

  const service = new BundlingService(
    1337,
    publicClient as any,
    mempoolService as any,
    { getStatus: vi.fn().mockResolvedValue(0) } as any, // reputationService
    { emit: vi.fn() } as any, // eventBus
    config,
    logger,
    null, // metrics
    {} as any, // receiptService - only used by MempoolReconciler, not exercised via sendNextBundle
    {} as any // frameTxSimulationService - ditto
  );
  // stop the cron the constructor starts
  service.stop();
  (service as any).relayer = fullRelayer;

  return { service, mempoolService, relayer: fullRelayer };
}

describe("BundlingService.submitFrameTransaction", () => {
  it("submits exactly one already-signed frame transaction to the configured relayer, with no batching", async () => {
    const tx = buildTx();
    const entry = buildEntry(tx);
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service } = buildService({ sendFrameTransaction });

    const hash = await service.submitFrameTransaction(entry);

    expect(sendFrameTransaction).toHaveBeenCalledTimes(1);
    expect(sendFrameTransaction).toHaveBeenCalledWith(
      entry,
      encodeRawFrameTx(tx)
    );
    expect(hash).toBe(keccak256(encodeRawFrameTx(tx)));
  });

  it("returns the locally computed tx hash, not whatever the relayer reports", async () => {
    const tx = buildTx();
    const entry = buildEntry(tx);
    // the mempool must never trust the relay endpoint's own response as the
    // transaction's identity - it's only defined to be a pure function of
    // the signed bytes, computed locally, regardless of what the endpoint returns.
    const sendFrameTransaction = vi
      .fn()
      .mockResolvedValue(`0x${"ee".repeat(32)}`);
    const { service } = buildService({ sendFrameTransaction });

    const hash = await service.submitFrameTransaction(entry);

    expect(hash).toBe(keccak256(encodeRawFrameTx(tx)));
    expect(hash).not.toBe(`0x${"ee".repeat(32)}`);
  });

  it("marks the entry Pending and counts a submit attempt before relaying", async () => {
    const entry = buildEntry();
    const { service, mempoolService } = buildService({});

    await service.submitFrameTransaction(entry);

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.Pending
    );
    expect(mempoolService.attemptToBundle).toHaveBeenCalledWith([entry]);
  });

  it("sendNextBundle submits each new entry individually, one relayer call per transaction", async () => {
    const entries = [buildEntry(buildTx(0n)), buildEntry(buildTx(1n))];
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService({
      sendFrameTransaction,
      // two entries need two free wallet slots; with one slot only one of
      // them may be dispatched (see the back-pressure tests below)
      getAvailableRelayersCount: () => 2,
    });
    mempoolService.getNewEntriesSorted.mockResolvedValue(entries);

    await service.sendNextBundle();

    expect(sendFrameTransaction).toHaveBeenCalledTimes(2);
    expect(sendFrameTransaction.mock.calls.map((c: any[]) => c[1])).toEqual(
      entries.map((e) => encodeRawFrameTx(e.tx))
    );
  });

  it("cancels, rather than relays, a transaction whose payer is banned", async () => {
    const tx = buildTx();
    // the Canonical Paymaster prefix shape ([only_verify, pay]), so `payer`
    // resolves to a third party rather than tx.sender and the self-pay
    // short-circuit does not apply
    tx.frames = [
      {
        mode: 1,
        flags: 2, // APPROVE_EXECUTION -> only_verify
        target: null,
        limits: { execution: 25_000n, state: 25_000n },
        value: 0n,
        data: "0x",
      },
      {
        mode: 1,
        flags: 1, // APPROVE_PAYMENT -> pay
        target: "0x3333333333333333333333333333333333333333",
        limits: { execution: 25_000n, state: 25_000n },
        value: 0n,
        data: "0x",
      },
    ];
    const entry = buildEntry(tx);
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService({ sendFrameTransaction });
    mempoolService.getNewEntriesSorted.mockResolvedValue([entry]);
    (service as any).reputationService.getStatus = vi
      .fn()
      .mockResolvedValue(ReputationStatus.BANNED);

    await service.sendNextBundle();

    expect(sendFrameTransaction).not.toHaveBeenCalled();
    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.Cancelled,
      expect.objectContaining({ revertReason: expect.stringContaining("banned") })
    );
  });

  it("skips a transaction whose signed fees are below the enforced network price", async () => {
    const entry = buildEntry(); // fees: maxFeePerGas 2n, priority 1n
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService(
      { sendFrameTransaction },
      { enforceGasPrice: true },
      { getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n) }
    );
    mempoolService.getNewEntriesSorted.mockResolvedValue([entry]);

    await service.sendNextBundle();

    expect(sendFrameTransaction).not.toHaveBeenCalled();
  });
});

/**
 * A relayer only discovers that no wallet slot is free AFTER
 * `BundlingService` has already marked the entry `Pending` and
 * counted a submit attempt: `sendFrameTransaction` is fired unawaited, and
 * every strategy's own `getAvailableRelayerIndex()` returns `null` and
 * silently no-ops when the pool is exhausted. Nothing ever moves such an entry
 * back to `New` - `getNewEntriesSorted` only ever returns `New` entries - so it
 * is orphaned in the mempool forever, reported `Pending` by
 * `skandha_getFrameTransactionStatus` and never broadcast.
 *
 * The invariant these tests pin: a tick never marks more entries `Pending`
 * than it has relayer slots to actually dispatch them with. Whatever it does
 * not dispatch it leaves untouched at `New`, for the next tick to pick up.
 */
describe("BundlingService.sendNextBundle relayer back-pressure", () => {
  /** Entries handed to the relayer, in call order. */
  function relayed(sendFrameTransaction: ReturnType<typeof vi.fn>): unknown[] {
    return sendFrameTransaction.mock.calls.map((c: any[]) => c[0]);
  }

  /** Entries the service moved to `Pending`, in call order. */
  function markedPending(mempoolService: any): unknown[] {
    return mempoolService.updateStatus.mock.calls
      .filter((c: any[]) => c[1] === MempoolEntryStatus.Pending)
      .flatMap((c: any[]) => c[0]);
  }

  it("dispatches at most one transaction per tick on a single-relayer-wallet deployment", async () => {
    // the plan's default deployment shape: one relayer key, bundleSize > 1
    const entries = [0n, 1n, 2n, 3n].map((n) => buildEntry(buildTx(n)));
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService(
      { sendFrameTransaction, getAvailableRelayersCount: () => 1 },
      { bundleSize: 4 }
    );
    mempoolService.getNewEntriesSorted.mockResolvedValue(entries);

    await service.sendNextBundle();

    expect(sendFrameTransaction).toHaveBeenCalledTimes(1);
  });

  it("never leaves an entry stranded in Pending without a relayer call", async () => {
    const entries = [0n, 1n, 2n, 3n].map((n) => buildEntry(buildTx(n)));
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService(
      { sendFrameTransaction, getAvailableRelayersCount: () => 1 },
      { bundleSize: 4 }
    );
    mempoolService.getNewEntriesSorted.mockResolvedValue(entries);

    await service.sendNextBundle();

    // every entry marked Pending was actually handed to the relayer...
    expect(markedPending(mempoolService)).toEqual(
      relayed(sendFrameTransaction)
    );
    // ...and the rest are untouched, still New, still selectable next tick
    for (const entry of entries.slice(1)) {
      expect(markedPending(mempoolService)).not.toContain(entry);
      expect(mempoolService.attemptToBundle).not.toHaveBeenCalledWith([entry]);
    }
  });

  it("dispatches exactly as many transactions as there are free relayer slots", async () => {
    const entries = [0n, 1n, 2n, 3n].map((n) => buildEntry(buildTx(n)));
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService(
      { sendFrameTransaction, getAvailableRelayersCount: () => 2 },
      { bundleSize: 4 }
    );
    mempoolService.getNewEntriesSorted.mockResolvedValue(entries);

    await service.sendNextBundle();

    expect(relayed(sendFrameTransaction)).toEqual(entries.slice(0, 2));
    expect(markedPending(mempoolService)).toEqual(entries.slice(0, 2));
  });

  it("does not spend a relayer slot on an entry it declines to relay", async () => {
    // a throttled payer's entry is skipped, so the one free slot must still be
    // available for the next eligible entry rather than wasted on it
    const skipped = buildEntry(buildTx(0n));
    const relayable = buildEntry(buildTx(1n));
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService(
      { sendFrameTransaction, getAvailableRelayersCount: () => 1 },
      { bundleSize: 4 }
    );
    mempoolService.getNewEntriesSorted.mockResolvedValue([skipped, relayable]);
    (service as any).shouldRelay = vi
      .fn()
      .mockImplementation(async (entry: FrameTxMempoolEntry) =>
        entry !== skipped
      );

    await service.sendNextBundle();

    expect(relayed(sendFrameTransaction)).toEqual([relayable]);
  });

  it("does not relay an entry whose recent root expires before it could land, and keeps it New", async () => {
    const HEAD = 261_223n;
    const withRef = (slot: bigint, seq: bigint) => ({
      ...buildTx(seq),
      nonceKeys: [7n + seq],
      recentRootReferences: [{ sourceId: `0x${"a".repeat(64)}` as const, slot, root: `0x${"b".repeat(64)}` as const }],
    });
    // usable through HEAD + 1 only: within the 2-slot relay margin
    const expiring = buildEntry(withRef(HEAD + 1n - 8191n, 0n));
    const fine = buildEntry(withRef(HEAD - 100n, 1n));
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ slotNumber: `0x${HEAD.toString(16)}` });
    const { service, mempoolService } = buildService(
      { sendFrameTransaction, getAvailableRelayersCount: () => 2 },
      {},
      { request }
    );
    mempoolService.getNewEntriesSorted.mockResolvedValue([expiring, fine]);

    await service.sendNextBundle();

    expect(sendFrameTransaction).toHaveBeenCalledTimes(1);
    expect(sendFrameTransaction.mock.calls[0][1]).toBe(encodeRawFrameTx(fine.tx));
    expect(mempoolService.updateStatus).not.toHaveBeenCalledWith(
      [expiring],
      expect.anything(),
      expect.anything()
    );
  });

  it("relays nothing when every relayer wallet is busy", async () => {
    const entries = [buildEntry(buildTx(0n))];
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService({
      sendFrameTransaction,
      getAvailableRelayersCount: () => 0,
    });
    mempoolService.getNewEntriesSorted.mockResolvedValue(entries);

    await service.sendNextBundle();

    expect(sendFrameTransaction).not.toHaveBeenCalled();
    expect(markedPending(mempoolService)).toEqual([]);
  });
});

describe("PrivilegedRelayer.sendFrameTransaction", () => {
  let request: ReturnType<typeof vi.fn>;

  function buildRelayer(networkConfigOverrides: Record<string, any> = {}) {
    request = vi.fn().mockResolvedValue(`0x${"cc".repeat(32)}`);

    const networkConfig = {
      rpcEndpointSubmit: "",
      maxConcurrentSubmissions: 1,
      ...networkConfigOverrides,
    } as any;

    const mempoolService = {
      updateStatus: vi.fn().mockResolvedValue(undefined),
      find: vi.fn().mockResolvedValue(null),
    };

    return {
      relayer: new PrivilegedRelayer(
        logger,
        1337,
        { request } as any, // publicClient
        {} as any, // config
        networkConfig,
        mempoolService as any,
        {} as any, // reputationService
        { emit: vi.fn() } as any, // eventBus
        null // metrics
      ),
      mempoolService,
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("submits the already-signed raw bytes verbatim via ethrex_submitPrivilegedFrameTransaction", async () => {
    const { relayer } = buildRelayer();
    const tx = buildTx();
    const entry = buildEntry(tx);
    const rawTx = encodeRawFrameTx(tx);

    await relayer.sendFrameTransaction(entry, rawTx);

    expect(request).toHaveBeenCalledWith({
      method: "ethrex_submitPrivilegedFrameTransaction",
      params: [rawTx],
    });
  });

  it("passes the registered target block as a second param when one was set for this tx hash", async () => {
    const { relayer } = buildRelayer();
    const tx = buildTx();
    const entry = buildEntry(tx);
    const rawTx = encodeRawFrameTx(tx);

    relayer.setTargetBlock(entry.txHash as `0x${string}`, 12345n);
    await relayer.sendFrameTransaction(entry, rawTx);

    expect(request).toHaveBeenCalledWith({
      method: "ethrex_submitPrivilegedFrameTransaction",
      params: [rawTx, "0x3039"],
    });
  });

  it("does not pass a second param for a tx hash with no registered target block", async () => {
    const { relayer } = buildRelayer();
    const tx = buildTx();
    const entry = buildEntry(tx);
    const rawTx = encodeRawFrameTx(tx);

    relayer.setTargetBlock("0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead", 1n);
    await relayer.sendFrameTransaction(entry, rawTx);

    expect(request).toHaveBeenCalledWith({
      method: "ethrex_submitPrivilegedFrameTransaction",
      params: [rawTx],
    });
  });

  it("marks the entry Submitted with the submission's returned transaction hash", async () => {
    const { relayer, mempoolService } = buildRelayer();
    const tx = buildTx();
    const entry = buildEntry(tx);

    await relayer.sendFrameTransaction(entry, encodeRawFrameTx(tx));

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.Submitted,
      { transaction: `0x${"cc".repeat(32)}` }
    );
  });
});

describe("BundlingService.sendNextBundle: giving up on an entry", () => {
  it("cancels an entry that was relayed more than maxSubmitAttempts times, saying how many times", async () => {
    const tx = buildTx();
    const worn = new FrameTxMempoolEntry(tx, { txHash: keccak256(encodeRawFrameTx(tx)), submitAttempts: 4 });
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService({ sendFrameTransaction }, { maxSubmitAttempts: 3 });
    mempoolService.getNewEntriesSorted.mockResolvedValueOnce([worn]).mockResolvedValue([]);

    await service.sendNextBundle();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith([worn], MempoolEntryStatus.Cancelled, {
      revertReason: expect.stringMatching(/relayed 4 times without being included in a block/),
    });
    expect(sendFrameTransaction).not.toHaveBeenCalled();
  });

  it("keeps relaying an entry that has used up fewer attempts than allowed", async () => {
    const tx = buildTx();
    const entry = new FrameTxMempoolEntry(tx, { txHash: keccak256(encodeRawFrameTx(tx)), submitAttempts: 3 });
    const sendFrameTransaction = vi.fn().mockResolvedValue(undefined);
    const { service, mempoolService } = buildService({ sendFrameTransaction }, { maxSubmitAttempts: 3 });
    mempoolService.getNewEntriesSorted.mockResolvedValue([entry]);

    await service.sendNextBundle();

    expect(sendFrameTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("BundlingService cron by bundling mode", () => {
  const withFakeTimers = async (body: () => Promise<void>) => {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  };

  it("reconciles on every tick in every mode, and relays only in auto mode, after reconciling", async () => {
    await withFakeTimers(async () => {
      const { service } = buildService({});
      const calls: string[] = [];
      (service as any).reconciler = { reconcile: vi.fn(async () => void calls.push("reconcile")) };
      vi.spyOn(service, "sendNextBundle").mockImplementation(async () => {
        calls.push("relay");
        return [] as any;
      });

      service.setBundlingMode("manual");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toEqual(["reconcile"]);

      service.setBundlingMode("auto");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toEqual(["reconcile", "reconcile", "relay"]);

      service.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toHaveLength(3);
    });
  });

  it("keeps ticking after a reconcile failure", async () => {
    await withFakeTimers(async () => {
      const { service } = buildService({});
      const reconcile = vi.fn().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue(undefined);
      (service as any).reconciler = { reconcile };
      service.setBundlingMode("manual");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
      service.stop();
    });
  });
});

describe("BundlingService.setPrivilegedRelayTargetBlock", () => {
  it("makes the real PrivilegedRelayer submit with the target block on the next relay of that tx", async () => {
    const request = vi.fn().mockResolvedValue(`0x${"cc".repeat(32)}`);
    const tx = buildTx();
    const entry = buildEntry(tx);
    const rawTx = encodeRawFrameTx(tx);
    const mempoolService = {
      getNewEntriesSorted: vi.fn().mockResolvedValueOnce([entry]).mockResolvedValue([]),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      attemptToBundle: vi.fn().mockResolvedValue(undefined),
      find: vi.fn().mockResolvedValue(null),
    };
    const config = {
      testingMode: false,
      getNetworkConfig: () =>
        ({
          bundleInterval: 10_000,
          bundleSize: 4,
          enforceGasPrice: false,
          enforceGasPriceThreshold: 0,
          eip1559: true,
          gasPriceMarkup: 0,
          etherscanApiKey: "",
          maxConcurrentSubmissions: 1,
          maxSubmitAttempts: 3,
          rpcEndpointSubmit: "",
        }) as any,
      getRelayers: () => [],
      getBeneficiary: () => null,
    } as any;

    const service = new BundlingService(
      1337,
      { request } as any,
      mempoolService as any,
      { getStatus: vi.fn().mockResolvedValue(0) } as any,
      { emit: vi.fn() } as any,
      config,
      logger,
      null,
      {} as any,
      {} as any
    );
    service.stop(); // real PrivilegedRelayer left in place - not swapped

    service.setPrivilegedRelayTargetBlock(entry.txHash as `0x${string}`, 999n);
    await service.sendNextBundle();

    expect(request).toHaveBeenCalledWith({
      method: "ethrex_submitPrivilegedFrameTransaction",
      params: [rawTx, "0x3e7"],
    });
  });
});
