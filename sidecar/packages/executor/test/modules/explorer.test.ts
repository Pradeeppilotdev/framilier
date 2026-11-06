import { describe, it, expect, vi } from "vitest";
import { Explorer } from "../../src/modules/explorer.js";
import { ExplorerService } from "../../src/services/ExplorerService/service.js";
import { FrameTxMempoolEntry } from "../../src/entities/FrameTxMempoolEntry.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import {
  FrameTransaction,
  FRAME_MODE,
  APPROVE_SCOPE,
} from "@skandha/types/lib/contracts/FrameTx.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const tx = (nonce: bigint): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: nonce,
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

const entry = (n: number, status = MempoolEntryStatus.New, submittedTime = n * 10) =>
  new FrameTxMempoolEntry(tx(BigInt(n)), { txHash: H(n), status, submittedTime });

function build(opts: {
  service?: ExplorerService | null;
  entries?: FrameTxMempoolEntry[];
  peers?: unknown[] | null;
  reputationEntries?: { address: string; opsSeen: number; opsIncluded: number; status: number }[];
  deposits?: Record<string, { stake: bigint; unstakeDelaySec: number; withdrawTime: bigint }>;
  minStake?: bigint;
  minUnstakeDelay?: number;
  minInclusionDenominator?: number;
  throttlingSlack?: number;
  banSlack?: number;
} = {}) {
  const service = opts.service === undefined ? new ExplorerService() : opts.service;
  const entries = opts.entries ?? [];
  const mempool = {
    listAll: vi.fn().mockResolvedValue(entries),
    getEntryByHash: vi.fn(async (h: string) => entries.find((e) => e.txHash === h) ?? null),
  } as any;
  const reputationService = {
    dump: vi.fn().mockResolvedValue(opts.reputationEntries ?? []),
    isWhitelisted: vi.fn().mockResolvedValue(false),
    isBlacklisted: vi.fn().mockResolvedValue(false),
  } as any;
  const deposits = opts.deposits ?? {};
  const stakingRegistryService = {
    getDepositInfo: vi.fn(async (addr: string) => deposits[addr.toLowerCase()] ?? { stake: 0n, unstakeDelaySec: 0, withdrawTime: 0n }),
  } as any;
  const module = new Explorer(
    1337,
    { version: "1.2.3", commit: "abc" },
    { getBundlingMode: () => "auto" } as any,
    mempool,
    service,
    () => (opts.peers === null ? null : ({ getConnectedPeers: () => opts.peers ?? [] } as any)),
    reputationService,
    stakingRegistryService,
    opts.minStake ?? 1_000_000_000n,
    opts.minUnstakeDelay ?? 86_400,
    opts.minInclusionDenominator ?? 10,
    opts.throttlingSlack ?? 10,
    opts.banSlack ?? 50
  );
  return { module, service, mempool, reputationService, stakingRegistryService };
}

describe("Explorer module", () => {
  describe("when the explorer is disabled", () => {
    it("answers METHOD_NOT_FOUND for every method", async () => {
      const { module } = build({ service: null });
      const calls = [
        () => module.info(),
        () => module.listTransactions(),
        () => module.listAdmissions(),
        () => module.getTransaction(H(1)),
        () => module.peers(),
        () => module.listReputation(),
      ];
      for (const call of calls) {
        await expect(Promise.resolve().then(call)).rejects.toMatchObject({
          code: RpcErrorCodes.METHOD_NOT_FOUND,
        });
      }
    });
  });

  describe("info", () => {
    it("reports protocol version, node facts and the retained history window", () => {
      const { module, service } = build({ peers: [] });
      service!.recordLifecycle({ txHash: H(1), kind: "admitted" });
      service!.recordLifecycle({ txHash: H(1), kind: "included" });
      expect(module.info()).toEqual({
        protocolVersion: 1,
        chainId: 1337,
        version: "1.2.3",
        commit: "abc",
        bundlingMode: "auto",
        p2pEnabled: true,
        latestSeq: 2,
        oldestSeq: 1,
        historyCapacity: 10000,
        bootId: service!.bootId,
        minInclusionDenominator: 10,
        throttlingSlack: 10,
        banSlack: 50,
      });
      expect(module.info().bootId).toMatch(/^[0-9a-f]{16}$/);
    });

    it("reports p2pEnabled false when there is no node API", () => {
      expect(build({ peers: null }).module.info().p2pEnabled).toBe(false);
    });
  });

  describe("listTransactions", () => {
    it("lists newest first with plain-number times and hex quantities", async () => {
      const { module } = build({ entries: [entry(1), entry(3), entry(2)] });
      const page = await module.listTransactions();
      expect(page.items.map((i) => i.txHash)).toEqual([H(3), H(2), H(1)]);
      expect(page.items[0]).toMatchObject({
        sender: SENDER,
        nonce: "0x3",
        status: "New",
        frames: 1,
        maxFeePerGas: "0x2",
        submittedTime: 30,
      });
    });

    it("carries where this node first saw each transaction, and omits it when no record exists", async () => {
      const { module, service } = build({ entries: [entry(1), entry(2), entry(3)] });
      service!.recordAdmission({ tx: tx(1n), txHash: H(1), source: "rpc", outcome: "accepted", checks: [] });
      service!.recordAdmission({ tx: tx(2n), txHash: H(2), source: "gossip:16Uiu2HAmPeer", outcome: "accepted", checks: [] });
      const page = await module.listTransactions();
      const bySource = Object.fromEntries(page.items.map((i) => [i.txHash, i.source]));
      expect(bySource).toEqual({ [H(1)]: "rpc", [H(2)]: "gossip:16Uiu2HAmPeer", [H(3)]: undefined });
      expect("source" in page.items.find((i) => i.txHash === H(3))!).toBe(false);
      const detail = await module.getTransaction(H(2));
      expect(detail.entry?.source).toBe("gossip:16Uiu2HAmPeer");
    });

    it("filters by status name and pages by offset cursor", async () => {
      const entries = [
        entry(1, MempoolEntryStatus.Submitted),
        entry(2, MempoolEntryStatus.New),
        entry(3, MempoolEntryStatus.Submitted),
        entry(4, MempoolEntryStatus.Submitted),
      ];
      const { module } = build({ entries });
      const first = await module.listTransactions({ status: "Submitted", limit: 2 });
      expect(first.items.map((i) => i.txHash)).toEqual([H(4), H(3)]);
      expect(first.nextCursor).toBe("2");
      const second = await module.listTransactions({ status: "Submitted", limit: 2, cursor: first.nextCursor });
      expect(second.items.map((i) => i.txHash)).toEqual([H(1)]);
      expect(second.nextCursor).toBeUndefined();
    });

    it.each([
      ["an unknown status", { status: "Bogus" }],
      ["a non-numeric cursor", { cursor: "abc" }],
      ["a negative cursor", { cursor: "-1" }],
    ])("rejects %s with INVALID_REQUEST", async (_name, params) => {
      const { module } = build({ entries: [entry(1)] });
      await expect(module.listTransactions(params)).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_REQUEST,
      });
    });

    it.each([[0], [-5], [Number.NaN], [1e9]])(
      "clamps a limit of %s to the page-size bounds",
      async (limit) => {
        const entries = Array.from({ length: 250 }, (_, i) => entry(i + 1));
        const { module } = build({ entries });
        const page = await module.listTransactions({ limit });
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThanOrEqual(200);
      }
    );
  });

  describe("listAdmissions", () => {
    it("delegates filtering and paging, and clamps the limit", () => {
      const { module, service } = build();
      for (let i = 1; i <= 3; i++) {
        service!.recordAdmission({
          tx: tx(BigInt(i)),
          txHash: H(i),
          source: "rpc",
          outcome: i === 2 ? "rejected" : "accepted",
          checks: [],
        });
      }
      expect(module.listAdmissions({ outcome: "rejected" }).items.map((r) => r.txHash)).toEqual([H(2)]);
      expect(module.listAdmissions({ limit: 0 }).items.length).toBeGreaterThan(0);
    });

    it("rejects an unknown outcome and a bad cursor", () => {
      const { module } = build();
      expect(() => module.listAdmissions({ outcome: "nope" as any })).toThrow(RpcError);
      expect(() => module.listAdmissions({ cursor: "x" })).toThrow(RpcError);
    });
  });

  describe("getTransaction", () => {
    it("returns the mempool entry, admission record and events together", async () => {
      const e = entry(1, MempoolEntryStatus.Submitted);
      const { module, service } = build({ entries: [e] });
      service!.recordAdmission({
        tx: tx(1n),
        txHash: H(1),
        source: "rpc",
        outcome: "accepted",
        checks: [{ rule: "prefix", verdict: "pass" }],
      });
      service!.recordLifecycle({ txHash: H(1), kind: "admitted" });
      const detail = await module.getTransaction(H(1));
      expect(detail.hash).toBe(H(1));
      expect(detail.entry).toMatchObject({ txHash: H(1), status: "Submitted" });
      expect(detail.entry?.tx).toMatchObject({ nonceKeys: ["0x0"], nonceSeq: "0x1", sender: SENDER });
      expect(detail.admission?.outcome).toBe("accepted");
      expect(detail.events).toHaveLength(1);
    });

    it("finds a rejected transaction that never entered the mempool", async () => {
      const { module, service } = build();
      service!.recordAdmission({
        tx: tx(9n),
        txHash: H(9),
        source: "rpc",
        outcome: "rejected",
        checks: [{ rule: "prefix", verdict: "fail", detail: "bad" }],
        errorCode: -32502,
      });
      const detail = await module.getTransaction(H(9));
      expect(detail.entry).toBeNull();
      expect(detail.admission?.outcome).toBe("rejected");
    });

    it("accepts an upper-case hash", async () => {
      const { module } = build({ entries: [entry(10)] });
      const detail = await module.getTransaction(H(10).toUpperCase().replace("0X", "0x"));
      expect(detail.entry?.txHash).toBe(H(10));
    });

    it("throws INVALID_REQUEST for an unknown hash and for a malformed one", async () => {
      const { module } = build();
      await expect(module.getTransaction(H(404))).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_REQUEST,
        message: "Frame transaction not found",
      });
      await expect(module.getTransaction("0x1234")).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_REQUEST,
      });
      await expect(module.getTransaction("not a hash" as any)).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_REQUEST,
      });
    });
  });

  describe("peers", () => {
    it("normalises peer info and tolerates missing fields", () => {
      const { module } = build({
        peers: [
          {
            peerId: "16Uiu2HAm",
            direction: "outbound",
            connectedUnixTsMs: 5,
            lastReceivedMsgUnixTsMs: 9,
            agentVersion: "skandha/1",
            metadata: { supported_mempools: ["QmMempool"] },
          },
          { peerId: "16Uiu2HAn" },
        ],
      });
      expect(module.peers()).toEqual([
        {
          peerId: "16Uiu2HAm",
          direction: "outbound",
          connectedAt: 5,
          lastReceivedAt: 9,
          agentVersion: "skandha/1",
          supportedMempools: ["QmMempool"],
        },
        {
          peerId: "16Uiu2HAn",
          direction: "unknown",
          connectedAt: 0,
          lastReceivedAt: 0,
          agentVersion: null,
          supportedMempools: [],
        },
      ]);
    });

    it("is empty in standalone mode", () => {
      expect(build({ peers: null }).module.peers()).toEqual([]);
    });
  });

  describe("listReputation", () => {
    it("maps status, computes isStaked, and sorts by address", async () => {
      const addrA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const addrB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const { module } = build({
        reputationEntries: [
          { address: addrB, opsSeen: 5, opsIncluded: 5, status: 0 }, // OK
          { address: addrA, opsSeen: 20, opsIncluded: 0, status: 2 }, // BANNED
        ],
        deposits: {
          [addrA]: { stake: 2_000_000_000n, unstakeDelaySec: 100_000, withdrawTime: 0n },
          [addrB]: { stake: 0n, unstakeDelaySec: 0, withdrawTime: 0n },
        },
        minStake: 1_000_000_000n,
        minUnstakeDelay: 86_400,
      });

      const page = await module.listReputation();

      expect(page.items.map((i) => i.address)).toEqual([addrA, addrB]); // sorted
      expect(page.items[0]).toMatchObject({
        address: addrA,
        opsSeen: 20,
        opsIncluded: 0,
        status: "banned",
        isStaked: true,
        stake: "0x77359400",
        unstakeDelaySec: 100_000,
      });
      expect(page.items[1]).toMatchObject({
        address: addrB,
        status: "ok",
        isStaked: false,
      });
    });

    it("reports isStaked false once a withdrawal has been initiated, even when stake/delay still clear the threshold", async () => {
      const addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const { module } = build({
        reputationEntries: [{ address: addr, opsSeen: 1, opsIncluded: 1, status: 0 }],
        deposits: {
          [addr]: { stake: 2_000_000_000n, unstakeDelaySec: 100_000, withdrawTime: 123_456n },
        },
        minStake: 1_000_000_000n,
        minUnstakeDelay: 86_400,
      });

      const page = await module.listReputation();

      expect(page.items[0]).toMatchObject({
        address: addr,
        isStaked: false,
        withdrawTime: "0x1e240",
      });
    });

    it("paginates the same way listAdmissions does", async () => {
      const entries = Array.from({ length: 3 }, (_, i) => ({
        address: `0x${(i + 1).toString().padStart(40, "0")}`,
        opsSeen: 1,
        opsIncluded: 1,
        status: 0,
      }));
      const { module } = build({ reputationEntries: entries });

      const page1 = await module.listReputation({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBe("2");

      const page2 = await module.listReputation({ limit: 2, cursor: page1.nextCursor });
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeUndefined();
    });

    it("rejects an invalid cursor", async () => {
      const { module } = build();
      await expect(module.listReputation({ cursor: "not-a-number" })).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_REQUEST,
      });
    });

    it("returns an empty page when nothing is tracked", async () => {
      const { module } = build({ reputationEntries: [] });
      const page = await module.listReputation();
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeUndefined();
    });
  });
});
