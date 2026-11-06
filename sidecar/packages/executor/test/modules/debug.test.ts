import { describe, it, expect, vi } from "vitest";
import { Debug } from "../../src/modules/debug.js";
import { MempoolService } from "../../src/services/MempoolService/service.js";
import { BundlingService } from "../../src/services/BundlingService/service.js";
import { ReputationService } from "../../src/services/ReputationService.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";

/**
 * `Debug`'s constructor: (publicClient, bundlingService, mempoolService,
 * reputationService, networkConfig). There is no `entryPointService` -
 * ERC-4337's `initCode`/`paymasterAndData` fields have no `FrameTransaction`
 * analogue.
 */
function buildDebug(overrides: Partial<{
  mempoolService: Partial<MempoolService>;
  bundlingService: Partial<BundlingService>;
  reputationService: Partial<ReputationService>;
}> = {}): Debug {
  const mempoolService = {
    dump: vi.fn().mockResolvedValue([]),
    clearState: vi.fn().mockResolvedValue(undefined),
    addFrameTx: vi.fn().mockResolvedValue(undefined),
    ...overrides.mempoolService,
  } as unknown as MempoolService;

  const bundlingService = {
    setBundlingMode: vi.fn(),
    sendNextBundle: vi.fn().mockResolvedValue(undefined),
    setBundlingInverval: vi.fn(),
    ...overrides.bundlingService,
  } as unknown as BundlingService;

  const reputationService = {
    clearState: vi.fn().mockResolvedValue(undefined),
    setReputation: vi.fn().mockResolvedValue(undefined),
    dump: vi.fn().mockResolvedValue([]),
    ...overrides.reputationService,
  } as unknown as ReputationService;

  const networkConfig = {} as any;

  return new Debug(
    {} as any, // publicClient
    bundlingService,
    mempoolService,
    reputationService,
    networkConfig
  );
}

const SELF_VERIFY_FRAME = {
  mode: 1,
  flags: 3,
  target: null,
  limits: { execution: 50_000n, state: 50_000n },
  value: 0n,
  data: "0x",
} as const;

function buildTx() {
  return {
    chainId: 1337n,
    nonceKeys: [0n],
    nonceSeq: 0n,
    sender: "0x1111111111111111111111111111111111111111",
    frames: [{ ...SELF_VERIFY_FRAME }],
    signatures: [],
    fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
    recentRootReferences: [],
  } as any;
}

describe("Debug.dumpMempool", () => {
  it("returns serialized frame transactions for entries with status New", async () => {
    const entries = [
      { status: MempoolEntryStatus.New, tx: { sender: "0x1111111111111111111111111111111111111111" } },
      { status: MempoolEntryStatus.Submitted, tx: { sender: "0x2222222222222222222222222222222222222222" } },
    ];
    const dump = vi.fn().mockResolvedValue(entries);
    const debug = buildDebug({ mempoolService: { dump } });

    const result = await debug.dumpMempool();

    expect(result).toEqual([entries[0].tx]);
  });
});

describe("Debug.dumpMempoolRaw", () => {
  it("returns every serialized mempool entry regardless of status", async () => {
    const entries = [
      { status: MempoolEntryStatus.New },
      { status: MempoolEntryStatus.Submitted },
    ];
    const dump = vi.fn().mockResolvedValue(entries);
    const debug = buildDebug({ mempoolService: { dump } });

    const result = await debug.dumpMempoolRaw();

    expect(result).toEqual(entries);
  });
});

describe("Debug.setMempool", () => {
  it(
    "persists each FrameTransaction directly via addFrameTx, keyed by its " +
      "real EIP-2718 envelope hash (not computeSigHash, which elides " +
      "signature bytes)",
    async () => {
      const addFrameTx = vi.fn().mockResolvedValue(undefined);
      const clearState = vi.fn().mockResolvedValue(undefined);
      const debug = buildDebug({ mempoolService: { addFrameTx, clearState } });

      const tx = buildTx();
      await debug.setMempool({ txs: [tx] } as any);

      expect(clearState).toHaveBeenCalledTimes(1);
      expect(addFrameTx).toHaveBeenCalledTimes(1);
      const [calledTx, calledHash] = addFrameTx.mock.calls[0];
      expect(calledTx).toBe(tx);
      expect(calledHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  );

  it("clears the mempool even when given an empty transaction list", async () => {
    const clearState = vi.fn().mockResolvedValue(undefined);
    const addFrameTx = vi.fn();
    const debug = buildDebug({ mempoolService: { clearState, addFrameTx } });

    await debug.setMempool({ txs: [] } as any);

    expect(clearState).toHaveBeenCalledTimes(1);
    expect(addFrameTx).not.toHaveBeenCalled();
  });
});

describe("Debug (entryPointService dependency removed)", () => {
  it("no longer accepts/exposes an entryPointService", () => {
    const debug = buildDebug();
    expect((debug as any).entryPointService).toBeUndefined();
  });
});

describe("Debug.getStakeStatus", () => {
  function buildDebugForStakeStatus(readContractResult: [bigint, number, bigint]) {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(readContractResult),
    } as any;
    const networkConfig = { minStake: 1_000_000_000n, minUnstakeDelay: 100 } as any;
    return new Debug(
      publicClient,
      {} as unknown as BundlingService,
      {} as unknown as MempoolService,
      {} as unknown as ReputationService,
      networkConfig
    );
  }

  it("reports isStaked true for a deposit that clears stake/delay with no withdrawal initiated", async () => {
    const debug = buildDebugForStakeStatus([2_000_000_000n, 200, 0n]);

    const result = await debug.getStakeStatus(
      "0x7777777777777777777777777777777777777777",
      "0x00000000000000000000000000000000000000aa"
    );

    expect(result.isStaked).toBe(true);
    expect(result.stakeInfo.withdrawTime).toBe("0");
  });

  it("reports isStaked false once a withdrawal has been initiated, even though stake/delay still clear the threshold", async () => {
    const debug = buildDebugForStakeStatus([2_000_000_000n, 200, 999_999_999n]);

    const result = await debug.getStakeStatus(
      "0x7777777777777777777777777777777777777777",
      "0x00000000000000000000000000000000000000aa"
    );

    expect(result.isStaked).toBe(false);
    expect(result.stakeInfo.withdrawTime).toBe("999999999");
  });
});

describe("Debug.setPrivilegedRelayTargetBlock", () => {
  it("delegates to BundlingService with the tx hash and target block", async () => {
    const setPrivilegedRelayTargetBlock = vi.fn();
    const debug = buildDebug({ bundlingService: { setPrivilegedRelayTargetBlock } });

    const result = await debug.setPrivilegedRelayTargetBlock(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0x3e7"
    );

    expect(setPrivilegedRelayTargetBlock).toHaveBeenCalledWith(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      999n
    );
    expect(result).toBe("ok");
  });
});
