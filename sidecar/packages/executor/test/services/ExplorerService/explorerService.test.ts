import { describe, it, expect, vi } from "vitest";
import {
  ExplorerService,
  MAX_STORED_TEXT,
} from "../../../src/services/ExplorerService/service.js";
import {
  ExecutorEvent,
  ExecutorEventBus,
} from "../../../src/services/SubscriptionService.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";

const SENDER = "0x1111111111111111111111111111111111111111";
const FRAME = {
  mode: 1,
  flags: 0,
  target: null,
  limits: { execution: 100n, state: 0n },
  value: 0n,
  data: "0x",
};
const tx = (nonce = 0n, frames: FrameTransaction["frames"] = []): FrameTransaction =>
  ({
    chainId: 1n,
    nonceKeys: [0n],
    nonceSeq: nonce,
    sender: SENDER,
    frames,
    signatures: [],
    fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
    recentRootReferences: [],
  }) as unknown as FrameTransaction;

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function record(
  svc: ExplorerService,
  n: number,
  outcome: "accepted" | "rejected" = "accepted",
  source: "rpc" | `gossip:${string}` = "rpc"
) {
  return svc.recordAdmission({
    tx: tx(BigInt(n)),
    txHash: hash(n),
    source,
    outcome,
    checks: [{ rule: "prefix", verdict: "pass" }],
    errorCode: outcome === "rejected" ? -32502 : undefined,
  });
}

describe("ExplorerService admissions", () => {
  it("records first-seen time, source and a hex nonce", () => {
    const svc = new ExplorerService(100, () => 1234);
    const rec = record(svc, 5, "accepted", "gossip:peerA");
    expect(rec).toMatchObject({
      txHash: hash(5),
      sender: SENDER,
      nonce: "0x5",
      at: 1234,
      source: "gossip:peerA",
      outcome: "accepted",
    });
    expect(svc.getAdmission(hash(5))).toEqual(rec);
  });

  it("does not overwrite an accepted record with a later rejection of the same hash", () => {
    const svc = new ExplorerService();
    record(svc, 1, "accepted");
    const again = record(svc, 1, "rejected");
    expect(again.outcome).toBe("accepted");
    expect(svc.getAdmission(hash(1))?.outcome).toBe("accepted");
  });

  it("lets a later acceptance replace an earlier rejection, keeping id, first-seen time and source", () => {
    let t = 100;
    const svc = new ExplorerService(100, () => t);
    const first = record(svc, 1, "rejected", "rpc");
    t = 200;
    const second = record(svc, 1, "accepted", "gossip:peerB");
    expect(second).toMatchObject({
      id: first.id,
      at: 100,
      source: "rpc",
      outcome: "accepted",
    });
  });

  it("evicts the oldest admissions and events beyond capacity", () => {
    const svc = new ExplorerService(3);
    for (let i = 1; i <= 5; i++) {
      record(svc, i);
      svc.recordLifecycle({ txHash: hash(i), kind: "admitted" });
    }
    expect(svc.getAdmission(hash(1))).toBeUndefined();
    expect(svc.getAdmission(hash(2))).toBeUndefined();
    expect(svc.getAdmission(hash(3))).toBeDefined();
    expect(svc.latestSeq()).toBe(5);
    expect(svc.oldestSeq()).toBe(3);
    expect(svc.eventsSince(0).map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("lists newest first, filters by outcome and pages with a cursor", () => {
    const svc = new ExplorerService();
    record(svc, 1, "accepted");
    record(svc, 2, "rejected");
    record(svc, 3, "accepted");
    record(svc, 4, "accepted");

    const page1 = svc.listAdmissions({ limit: 2 });
    expect(page1.items.map((r) => r.txHash)).toEqual([hash(4), hash(3)]);
    expect(page1.nextCursor).toBeDefined();

    const page2 = svc.listAdmissions({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.txHash)).toEqual([hash(2), hash(1)]);
    expect(page2.nextCursor).toBeUndefined();

    const rejected = svc.listAdmissions({ outcome: "rejected" });
    expect(rejected.items.map((r) => r.txHash)).toEqual([hash(2)]);
  });

  it("markReplaced() flips the old record and emits a replaced event naming the new hash", () => {
    const svc = new ExplorerService();
    record(svc, 1);
    svc.markReplaced(hash(1), hash(9));
    expect(svc.getAdmission(hash(1))?.outcome).toBe("replaced");
    expect(svc.getEvents(hash(1))).toEqual([
      expect.objectContaining({
        kind: "replaced",
        reason: `replaced by ${hash(9)}`,
      }),
    ]);
  });

  it("markDropped() flips the record's outcome and emits a dropped event with the reason", () => {
    const svc = new ExplorerService();
    record(svc, 1);
    svc.markDropped(hash(1), "banned payer");
    expect(svc.getAdmission(hash(1))?.outcome).toBe("dropped");
    expect(svc.getEvents(hash(1))).toEqual([
      expect.objectContaining({ kind: "dropped", reason: "banned payer" }),
    ]);
  });

  it("markIncluded() flips the record's outcome and records the includer", () => {
    const svc = new ExplorerService();
    record(svc, 1);
    svc.markIncluded(hash(1), "0x9999999999999999999999999999999999999999");
    expect(svc.getAdmission(hash(1))).toMatchObject({
      outcome: "included",
      includer: "0x9999999999999999999999999999999999999999",
    });
    expect(svc.getEvents(hash(1))).toEqual([
      expect.objectContaining({ kind: "included" }),
    ]);
  });

  it("markDropped() never overwrites an already-included record's outcome", () => {
    const svc = new ExplorerService();
    record(svc, 1);
    svc.markIncluded(hash(1), "0x9999999999999999999999999999999999999999");
    svc.markDropped(hash(1), "stale cancellation");
    expect(svc.getAdmission(hash(1))?.outcome).toBe("included");
    // The lifecycle event still records the raw signal - only the outcome
    // itself is protected, not the Timeline's history of what happened.
    expect(svc.getEvents(hash(1)).map((e) => e.kind)).toEqual([
      "included",
      "dropped",
    ]);
  });
});

describe("ExplorerService admission frames", () => {
  it("serializes the transaction's real frames to hex, marking every frame not-run when no receipts are given", () => {
    const svc = new ExplorerService();
    const rec = svc.recordAdmission({
      tx: tx(1n, [FRAME, { ...FRAME, mode: 0, value: 5n }]),
      txHash: hash(1),
      source: "rpc",
      outcome: "rejected",
      checks: [],
    });
    expect(rec.frames).toEqual([
      { mode: 1, flags: 0, target: null, limits: { execution: "0x64", state: "0x0" }, value: "0x0", data: "0x" },
      { mode: 0, flags: 0, target: null, limits: { execution: "0x64", state: "0x0" }, value: "0x5", data: "0x" },
    ]);
    expect(rec.frameStatuses).toEqual(["not-run", "not-run"]);
  });

  it("aligns frame statuses with the given receipts, and marks any frame beyond them not-run", () => {
    const svc = new ExplorerService();
    const rec = svc.recordAdmission({
      tx: tx(1n, [FRAME, FRAME, FRAME]),
      txHash: hash(1),
      source: "rpc",
      outcome: "accepted",
      checks: [],
      frameReceipts: [
        { status: "success", gasUsed: { execution: "0x64", state: "0x0" }, logs: [] },
        { status: "reverted", gasUsed: { execution: "0x64", state: "0x0" }, logs: [] },
      ],
    });
    expect(rec.frameStatuses).toEqual(["success", "reverted", "not-run"]);
  });
});

describe("ExplorerService admission time", () => {
  it("stores the supplied receive time instead of the clock", () => {
    const svc = new ExplorerService(100, () => 1234);
    const rec = svc.recordAdmission({
      tx: tx(1n),
      txHash: hash(1),
      source: "rpc",
      outcome: "accepted",
      checks: [],
      at: 50,
    });
    expect(rec.at).toBe(50);
  });

  it("uses the clock when no time is supplied", () => {
    const svc = new ExplorerService(100, () => 1234);
    expect(record(svc, 1).at).toBe(1234);
  });

  it("keeps the first record's time when a rejected record is upgraded", () => {
    const svc = new ExplorerService(100, () => 1234);
    svc.recordAdmission({
      tx: tx(1n), txHash: hash(1), source: "rpc", outcome: "rejected", checks: [], at: 50,
    });
    const upgraded = svc.recordAdmission({
      tx: tx(1n), txHash: hash(1), source: "rpc", outcome: "accepted", checks: [], at: 90,
    });
    expect(upgraded.at).toBe(50);
  });
});

describe("ExplorerService stored text limit", () => {
  const big = "x".repeat(5000);

  it("truncates a huge check detail without mutating the caller's checks", () => {
    const svc = new ExplorerService();
    const checks = [
      { rule: "prefix", verdict: "pass" as const },
      { rule: "admission", verdict: "fail" as const, detail: big },
    ];
    const rec = svc.recordAdmission({
      tx: tx(1n), txHash: hash(1), source: "rpc", outcome: "rejected", checks: checks as any,
    });
    const stored = rec.checks[1].detail as string;
    expect(stored.length).toBeLessThanOrEqual(MAX_STORED_TEXT);
    expect(stored.endsWith("\u2026")).toBe(true);
    expect(checks[1].detail).toBe(big);
    expect(rec.checks[0]).toEqual({ rule: "prefix", verdict: "pass" });
  });

  it("truncates a huge lifecycle reason in the returned and retained event", () => {
    const svc = new ExplorerService();
    const event = svc.recordLifecycle({ txHash: hash(1), kind: "rejected", reason: big });
    expect(event.reason!.length).toBeLessThanOrEqual(MAX_STORED_TEXT);
    expect(event.reason!.endsWith("\u2026")).toBe(true);
    expect(svc.getEvents(hash(1))[0].reason).toBe(event.reason);
  });

  it("stores short text unchanged, including text of exactly the limit", () => {
    const svc = new ExplorerService();
    const exact = "y".repeat(MAX_STORED_TEXT);
    const rec = svc.recordAdmission({
      tx: tx(1n), txHash: hash(1), source: "rpc", outcome: "rejected",
      checks: [{ rule: "admission", verdict: "fail", detail: "short" }] as any,
    });
    expect(rec.checks[0].detail).toBe("short");
    expect(svc.recordLifecycle({ txHash: hash(1), kind: "rejected", reason: exact }).reason).toBe(exact);
  });
});

describe("ExplorerService bootId", () => {
  it("is 16 hex characters, stable per instance and different across instances", () => {
    const a = new ExplorerService();
    const b = new ExplorerService();
    expect(a.bootId).toMatch(/^[0-9a-f]{16}$/);
    expect(b.bootId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.bootId).toBe(a.bootId);
    expect(a.bootId).not.toBe(b.bootId);
  });
});

describe("ExplorerService lifecycle", () => {
  it("assigns increasing seq numbers and supports resuming with eventsSince", () => {
    const svc = new ExplorerService();
    svc.recordLifecycle({ txHash: hash(1), kind: "admitted" });
    svc.recordLifecycle({ txHash: hash(2), kind: "admitted" });
    svc.recordLifecycle({ txHash: hash(1), kind: "included" });
    expect(svc.eventsSince(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(svc.eventsSince(1, 1).map((e) => e.seq)).toEqual([2]);
    expect(svc.getEvents(hash(1)).map((e) => e.kind)).toEqual([
      "admitted",
      "included",
    ]);
  });

  it("notifies listeners, stops after unsubscribe, and survives a throwing listener", () => {
    const svc = new ExplorerService();
    const seen: number[] = [];
    svc.onEvent(() => {
      throw new Error("bad listener");
    });
    const off = svc.onEvent((e) => seen.push(e.seq));
    svc.recordLifecycle({ txHash: hash(1), kind: "admitted" });
    off();
    svc.recordLifecycle({ txHash: hash(1), kind: "included" });
    expect(seen).toEqual([1]);
    expect(svc.latestSeq()).toBe(2);
  });

  it("derives lifecycle events from the executor event bus", () => {
    const svc = new ExplorerService();
    record(svc, 1); // so markDropped/markIncluded have a real record to flip
    const bus = new ExecutorEventBus();
    svc.attach(bus);
    const entry = (status: MempoolEntryStatus, extra = {}) =>
      ({ txHash: hash(1), status, ...extra }) as any;

    bus.emit(ExecutorEvent.pendingUserOps, entry(MempoolEntryStatus.New));
    bus.emit(ExecutorEvent.submittedUserOps, entry(MempoolEntryStatus.Submitted));
    bus.emit(
      ExecutorEvent.submittedUserOps,
      entry(MempoolEntryStatus.Cancelled, { revertReason: "nonce too low" })
    );
    bus.emit(
      ExecutorEvent.submittedUserOps,
      entry(MempoolEntryStatus.Reverted, { revertReason: "out of gas" })
    );
    // A Reverted transition also fires onChainUserOps now (it has a receipt
    // and an includer, just like a successful one - see the design spec).
    bus.emit(
      ExecutorEvent.onChainUserOps,
      entry(MempoolEntryStatus.Reverted, { includer: "0x8888888888888888888888888888888888888888" })
    );
    bus.emit(
      ExecutorEvent.onChainUserOps,
      entry(MempoolEntryStatus.OnChain, { includer: "0x9999999999999999999999999999999999999999" })
    );
    bus.emit(ExecutorEvent.pendingUserOps, { status: MempoolEntryStatus.New } as any); // no txHash: ignored

    expect(
      svc.getEvents(hash(1)).map((e) => [e.kind, e.status, e.reason])
    ).toEqual([
      ["admitted", "New", undefined],
      ["statusChanged", "Submitted", undefined],
      ["dropped", "Cancelled", "nonce too low"],
      ["statusChanged", "Reverted", "out of gas"],
      ["included", "Reverted", undefined],
      ["included", "OnChain", undefined],
    ]);
    expect(svc.latestSeq()).toBe(6);
    // The record's outcome ends at "included", with the LAST includer given
    // (the final OnChain emission's) - proving `attach()` actually threads
    // `entry.includer` through to `markIncluded`, not just a hardcoded value.
    expect(svc.getAdmission(hash(1))).toMatchObject({
      outcome: "included",
      includer: "0x9999999999999999999999999999999999999999",
    });
  });
});
