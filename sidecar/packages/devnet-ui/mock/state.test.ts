import { describe, expect, it } from "vitest";
import {
  AdmissionPageSchema,
  ExplorerInfoSchema,
  PeerListSchema,
  ReputationPageSchema,
  SerializedFrameTxSchema,
  TransactionDetailSchema,
  TransactionPageSchema,
  type LifecycleEventData,
} from "../src/protocol/schemas";
import { PEERS, TX, disabledNode, primaryNode, secondaryNode } from "./fixtures";
import { MockNode, type RpcOutcome } from "./state";

const ok = (outcome: RpcOutcome): unknown => {
  if (!("result" in outcome)) throw new Error(`expected a result, got ${JSON.stringify(outcome)}`);
  return outcome.result;
};
const failure = (outcome: RpcOutcome) => {
  if (!("error" in outcome)) throw new Error("expected an error");
  return outcome.error;
};

describe("MockNode protocol parity", () => {
  const node = primaryNode();

  it("answers every method with a result the UI's schemas accept", () => {
    expect(ExplorerInfoSchema.safeParse(ok(node.handle("skandha_explorer_info"))).success).toBe(true);
    expect(TransactionPageSchema.safeParse(ok(node.handle("skandha_explorer_listTransactions", [{}]))).success).toBe(true);
    expect(AdmissionPageSchema.safeParse(ok(node.handle("skandha_explorer_listAdmissions", [{}]))).success).toBe(true);
    expect(PeerListSchema.safeParse(ok(node.handle("skandha_explorer_peers"))).success).toBe(true);
    for (const tx of Object.values(TX).filter((t) => t.hash !== TX.onlySecondary.hash)) {
      const outcome = node.handle("skandha_explorer_getTransaction", [tx.hash]);
      expect(TransactionDetailSchema.safeParse(ok(outcome)).success).toBe(true);
    }
  });

  it("reports the retained history window and a 16-character bootId in info", () => {
    const info = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info")));
    expect(info).toMatchObject({ protocolVersion: 1, chainId: 1337, oldestSeq: 1, p2pEnabled: true });
    expect(info.latestSeq).toBeGreaterThan(10);
    expect(info.bootId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("lists only what is in the mempool store, newest first", () => {
    const page = TransactionPageSchema.parse(ok(node.handle("skandha_explorer_listTransactions", [{}])));
    const hashes = page.items.map((i) => i.txHash);
    expect(hashes).toContain(TX.onChain.hash);
    expect(hashes).toContain(TX.replacedNew.hash);
    expect(hashes).not.toContain(TX.bannedOpcode.hash); // rejected: never pooled
    expect(hashes).not.toContain(TX.replacedOld.hash); // replaced: left the pool
    const times = page.items.map((i) => i.submittedTime ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("filters by status and pages with an offset cursor", () => {
    const filtered = TransactionPageSchema.parse(
      ok(node.handle("skandha_explorer_listTransactions", [{ status: "New" }])),
    );
    expect(filtered.items.every((i) => i.status === "New")).toBe(true);
    const first = TransactionPageSchema.parse(ok(node.handle("skandha_explorer_listTransactions", [{ limit: 2 }])));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const second = TransactionPageSchema.parse(
      ok(node.handle("skandha_explorer_listTransactions", [{ limit: 2, cursor: first.nextCursor }])),
    );
    expect(second.items.map((i) => i.txHash)).not.toContain(first.items[0]?.txHash);
  });

  it("rejects bad list parameters with INVALID_REQUEST and clamps the limit", () => {
    expect(failure(node.handle("skandha_explorer_listTransactions", [{ status: "Bogus" }])).code).toBe(-32600);
    expect(failure(node.handle("skandha_explorer_listTransactions", [{ cursor: "-1" }])).code).toBe(-32600);
    expect(failure(node.handle("skandha_explorer_listAdmissions", [{ outcome: "nope" }])).code).toBe(-32600);
    expect(failure(node.handle("skandha_explorer_listAdmissions", [{ cursor: "x" }])).code).toBe(-32600);
    const page = TransactionPageSchema.parse(ok(node.handle("skandha_explorer_listTransactions", [{ limit: 0 }])));
    expect(page.items.length).toBeGreaterThan(0);
  });

  it("lists admissions newest first, including rejected and replaced ones", () => {
    const page = AdmissionPageSchema.parse(ok(node.handle("skandha_explorer_listAdmissions", [{}])));
    const outcomes = new Set(page.items.map((a) => a.outcome));
    expect(outcomes).toEqual(new Set(["accepted", "rejected", "replaced"]));
    const ids = page.items.map((a) => a.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const rejected = AdmissionPageSchema.parse(
      ok(node.handle("skandha_explorer_listAdmissions", [{ outcome: "rejected" }])),
    );
    expect(rejected.items.map((a) => a.txHash).sort()).toEqual([TX.bannedOpcode.hash, TX.noPrefix.hash].sort());
  });

  it("pages admissions with an id cursor", () => {
    const first = AdmissionPageSchema.parse(ok(node.handle("skandha_explorer_listAdmissions", [{ limit: 3 }])));
    expect(first.items).toHaveLength(3);
    const second = AdmissionPageSchema.parse(
      ok(node.handle("skandha_explorer_listAdmissions", [{ limit: 3, cursor: first.nextCursor }])),
    );
    expect(Math.max(...second.items.map((a) => a.id))).toBeLessThan(Math.min(...first.items.map((a) => a.id)));
  });

  it("returns a pooled transaction with its serialized frames, report and timeline", () => {
    const detail = TransactionDetailSchema.parse(ok(node.handle("skandha_explorer_getTransaction", [TX.onChain.hash])));
    expect(detail.entry?.status).toBe("OnChain");
    expect(SerializedFrameTxSchema.safeParse(detail.entry?.tx).success).toBe(true);
    expect(detail.admission?.outcome).toBe("accepted");
    expect(detail.events.map((e) => e.kind)).toEqual(["admitted", "statusChanged", "included"]);
  });

  it("returns a rejected transaction with no entry and a failing report", () => {
    const detail = TransactionDetailSchema.parse(
      ok(node.handle("skandha_explorer_getTransaction", [TX.bannedOpcode.hash])),
    );
    expect(detail.entry).toBeNull();
    expect(detail.admission?.outcome).toBe("rejected");
    expect(detail.admission?.errorCode).toBe(-32502);
    expect(detail.admission?.checks.filter((c) => c.verdict === "fail").map((c) => c.rule)).toEqual([
      "OP-011",
      "storage",
    ]);
    expect(detail.events.map((e) => e.kind)).toEqual(["rejected"]);
  });

  it("returns a replaced transaction with no entry, outcome replaced and a replaced event", () => {
    const detail = TransactionDetailSchema.parse(
      ok(node.handle("skandha_explorer_getTransaction", [TX.replacedOld.hash])),
    );
    expect(detail.entry).toBeNull();
    expect(detail.admission?.outcome).toBe("replaced");
    expect(detail.events.at(-1)).toMatchObject({ kind: "replaced", reason: `replaced by ${TX.replacedNew.hash}` });
  });

  it("carries a revert reason on a reverted entry", () => {
    const detail = TransactionDetailSchema.parse(ok(node.handle("skandha_explorer_getTransaction", [TX.reverted.hash])));
    expect(detail.entry).toMatchObject({ status: "Reverted", revertReason: "execution reverted: insufficient allowance" });
  });

  it("accepts an upper-case hash and rejects unknown or malformed hashes", () => {
    const upper = `0x${TX.onChain.hash.slice(2).toUpperCase()}`;
    expect(TransactionDetailSchema.parse(ok(node.handle("skandha_explorer_getTransaction", [upper]))).hash).toBe(
      TX.onChain.hash,
    );
    expect(failure(node.handle("skandha_explorer_getTransaction", [`0x${"1".repeat(64)}`]))).toEqual({
      code: -32600,
      message: "Frame transaction not found",
    });
    expect(failure(node.handle("skandha_explorer_getTransaction", ["0x12"])).code).toBe(-32600);
    expect(failure(node.handle("skandha_explorer_getTransaction", [])).code).toBe(-32600);
  });

  it("returns peers, or none when p2p is off", () => {
    expect(PeerListSchema.parse(ok(node.handle("skandha_explorer_peers")))).toEqual(PEERS);
    expect(ok(secondaryNode().handle("skandha_explorer_peers"))).toEqual([]);
  });

  it("answers METHOD_NOT_FOUND for every explorer method when the explorer is off, and for unknown methods", () => {
    const off = disabledNode();
    for (const method of [
      "skandha_explorer_info",
      "skandha_explorer_listTransactions",
      "skandha_explorer_listAdmissions",
      "skandha_explorer_getTransaction",
      "skandha_explorer_peers",
      "skandha_explorer_listReputation",
    ]) {
      expect(failure(off.handle(method, [])).code).toBe(-32601);
    }
    expect(failure(node.handle("eth_chainId")).code).toBe(-32601);
  });

  it("answers skandha_explorer_listReputation with parity to the real schema", () => {
    const n = new MockNode({ name: "n" });
    n.setReputationEntry({
      address: "0x1111111111111111111111111111111111111111",
      opsSeen: 10,
      opsIncluded: 8,
      status: "ok",
      isWhitelisted: false,
      isBlacklisted: false,
      stake: "0x77359400",
      unstakeDelaySec: 86_400,
      withdrawTime: "0x0",
      isStaked: true,
    });
    const result = n.handle("skandha_explorer_listReputation", [{}]);
    expect(ReputationPageSchema.safeParse(ok(result)).success).toBe(true);
    expect(ReputationPageSchema.parse(ok(result)).items).toHaveLength(1);
  });

  it("rejects an invalid cursor for skandha_explorer_listReputation", () => {
    const n = new MockNode({ name: "n" });
    expect(failure(n.handle("skandha_explorer_listReputation", [{ cursor: "x" }])).code).toBe(-32600);
  });
});

describe("MockNode events and stream", () => {
  const collect = (node: MockNode, since?: number) => {
    const seen: LifecycleEventData[] = [];
    const off = node.subscribe(since, (e) => seen.push(e));
    return { seen, off };
  };

  it("replays events after sinceSeq, then delivers live ones, until unsubscribed", () => {
    const node = primaryNode();
    const latest = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info"))).latestSeq;
    const replay = collect(node, latest - 2);
    expect(replay.seen.map((e) => e.seq)).toEqual([latest - 1, latest]);

    node.admit({ ...TX.fresh, hash: `0x${"9".repeat(64)}`, frames: TX.fresh.frames.map((f) => ({ ...f })) });
    expect(replay.seen.at(-1)?.seq).toBe(latest + 1);
    replay.off();
    node.admit({ ...TX.fresh, hash: `0x${"8".repeat(64)}`, frames: TX.fresh.frames.map((f) => ({ ...f })) });
    expect(replay.seen.at(-1)?.seq).toBe(latest + 1);
  });

  it("sends only live events when no sinceSeq is given", () => {
    const node = primaryNode();
    const live = collect(node);
    expect(live.seen).toEqual([]);
  });

  it("maps status changes to lifecycle kinds like the backend", () => {
    const node = primaryNode();
    const live = collect(node);
    node.setStatus(TX.fresh.hash, "Submitted");
    node.setStatus(TX.fresh.hash, "OnChain");
    node.setStatus(TX.waived.hash, "Cancelled", "nonce too low");
    expect(live.seen.map((e) => [e.kind, e.status, e.reason])).toEqual([
      ["statusChanged", "Submitted", undefined],
      ["included", "OnChain", undefined],
      ["dropped", "Cancelled", "nonce too low"],
    ]);
  });

  it("restart() changes bootId and clears history but keeps the pool", () => {
    const node = primaryNode();
    const before = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info")));
    node.restart();
    const after = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info")));
    expect(after.bootId).not.toBe(before.bootId);
    expect(after).toMatchObject({ latestSeq: 0, oldestSeq: 0 });
    expect(AdmissionPageSchema.parse(ok(node.handle("skandha_explorer_listAdmissions", [{}]))).items).toEqual([]);
    expect(TransactionPageSchema.parse(ok(node.handle("skandha_explorer_listTransactions", [{}]))).items.length).toBeGreaterThan(0);
  });

  it("evicts the oldest history beyond its capacity and reports the new oldestSeq", () => {
    const node = new MockNode({ name: "tiny", capacity: 3 });
    for (let i = 1; i <= 5; i++) {
      node.admit({
        ...TX.fresh,
        hash: `0x${String(i).repeat(64)}`,
        nonce: i,
        frames: TX.fresh.frames.map((f) => ({ ...f })),
      });
    }
    const info = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info")));
    expect(info).toMatchObject({ latestSeq: 5, oldestSeq: 3, historyCapacity: 3 });
  });
});

describe("page-size clamp", () => {
  const filled = (count: number): MockNode => {
    const node = new MockNode({ name: "many" });
    for (let i = 1; i <= count; i++) {
      node.admit({
        ...TX.fresh,
        hash: `0x${i.toString(16).padStart(64, "0")}`,
        nonce: i,
        submittedTime: i,
        frames: TX.fresh.frames.map((f) => ({ ...f })),
      });
    }
    return node;
  };
  const sizes = (node: MockNode, limit?: unknown) => {
    const params = limit === undefined ? [{}] : [{ limit }];
    return [
      TransactionPageSchema.parse(ok(node.handle("skandha_explorer_listTransactions", params))).items.length,
      AdmissionPageSchema.parse(ok(node.handle("skandha_explorer_listAdmissions", params))).items.length,
    ];
  };

  it("defaults to 50 items when no limit is given", () => {
    expect(sizes(filled(260))).toEqual([50, 50]);
  });

  it("treats a limit of 0 like no limit", () => {
    expect(sizes(filled(260), 0)).toEqual([50, 50]);
  });

  it("caps a limit above 200 at 200", () => {
    expect(sizes(filled(260), 1000)).toEqual([200, 200]);
    expect(sizes(filled(260), 200)).toEqual([200, 200]);
  });

  it("honours a limit in range", () => {
    expect(sizes(filled(260), 7)).toEqual([7, 7]);
  });
});

describe("re-admission follows the backend", () => {
  const rejectedChecks = [{ rule: "prefix", verdict: "fail" as const, detail: "no" }];
  const admissionOf = (node: MockNode, hash: string) =>
    TransactionDetailSchema.parse(ok(node.handle("skandha_explorer_getTransaction", [hash]))).admission;

  it("never overwrites an accepted record", () => {
    const node = new MockNode({ name: "n" });
    node.admit({ ...TX.fresh, frames: TX.fresh.frames.map((f) => ({ ...f })) }, "rpc", undefined, 100);
    const first = admissionOf(node, TX.fresh.hash);
    node.admit({ ...TX.fresh, frames: TX.fresh.frames.map((f) => ({ ...f })) }, "gossip:peer", undefined, 900);
    expect(admissionOf(node, TX.fresh.hash)).toEqual(first);
    node.reject({ ...TX.fresh, frames: TX.fresh.frames.map((f) => ({ ...f })) }, rejectedChecks, "rpc", -32502, 950);
    expect(admissionOf(node, TX.fresh.hash)).toEqual(first);
  });

  it("never overwrites a replaced record", () => {
    const node = new MockNode({ name: "n" });
    const old = { ...TX.fresh, frames: TX.fresh.frames.map((f) => ({ ...f })) };
    node.admit(old, "rpc", undefined, 100);
    node.replace(old.hash, { ...TX.fresh, hash: `0x${"9".repeat(64)}`, nonce: 1, frames: [] }, "rpc", 200);
    const replaced = admissionOf(node, old.hash);
    expect(replaced?.outcome).toBe("replaced");
    node.admit({ ...old, frames: old.frames.map((f) => ({ ...f })) }, "gossip:peer", undefined, 900);
    expect(admissionOf(node, old.hash)).toEqual(replaced);
  });

  it("upgrades a rejected record in place, keeping its id, time and source", () => {
    const node = new MockNode({ name: "n" });
    const tx = { ...TX.fresh, frames: TX.fresh.frames.map((f) => ({ ...f })) };
    node.reject(tx, rejectedChecks, "rpc", -32502, 100);
    node.admit({ ...tx, frames: tx.frames.map((f) => ({ ...f })) }, "gossip:peer", undefined, 900);
    const other = { ...TX.fresh, hash: `0x${"8".repeat(64)}`, nonce: 5, frames: TX.fresh.frames.map((f) => ({ ...f })) };
    node.admit(other, "rpc", undefined, 950);
    const record = admissionOf(node, tx.hash);
    expect(record).toMatchObject({ id: 1, at: 100, source: "rpc", outcome: "accepted" });
    expect(record?.errorCode).toBeUndefined();
    expect(record?.checks.every((c) => c.verdict === "pass")).toBe(true);
    // The upgrade did not allocate an id: the next new record continues from 2.
    expect(admissionOf(node, other.hash)?.id).toBe(2);
  });
});

describe("secondary fixture node", () => {
  it("saw the shared traffic later and has a transaction the primary never saw", () => {
    const primary = primaryNode();
    const secondary = secondaryNode();
    const at = (node: MockNode, hash: string) =>
      TransactionDetailSchema.parse(ok(node.handle("skandha_explorer_getTransaction", [hash]))).admission?.at;
    expect((at(secondary, TX.onChain.hash) ?? 0) - (at(primary, TX.onChain.hash) ?? 0)).toBe(240);
    expect(failure(primary.handle("skandha_explorer_getTransaction", [TX.onlySecondary.hash])).code).toBe(-32600);
    expect(at(secondary, TX.onlySecondary.hash)).toBeDefined();
  });
});
