import { randomBytes } from "node:crypto";
import { toHex } from "viem";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { Frame, FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import { FrameSimulationReceipt } from "@skandha/types/lib/executor/validation/frameTxSimulation.js";
import {
  AdmissionOutcome,
  AdmissionRecord,
  AdmissionSource,
  ExplorerFrame,
  FrameRunStatus,
  LifecycleEvent,
  LifecycleKind,
  Page,
  RuleCheck,
} from "@skandha/types/lib/explorer/index.js";
import { now } from "../../utils/index.js";
import { ExecutorEvent, ExecutorEventBus } from "../SubscriptionService.js";
import { FrameTxMempoolEntry } from "../../entities/FrameTxMempoolEntry.js";

export const DEFAULT_EXPLORER_CAPACITY = 10_000;
const DEFAULT_PAGE_SIZE = 50;

/** Upper bound (in characters) for each retained failure `detail` / `reason`. */
export const MAX_STORED_TEXT = 1024;

function truncateText(text: string): string {
  return text.length <= MAX_STORED_TEXT
    ? text
    : `${text.slice(0, MAX_STORED_TEXT - 1)}\u2026`;
}

function serializeExplorerFrame(frame: Frame): ExplorerFrame {
  return {
    mode: frame.mode,
    flags: frame.flags,
    target: frame.target,
    limits: {
      execution: toHex(frame.limits.execution),
      state: toHex(frame.limits.state),
    },
    value: toHex(frame.value),
    data: frame.data,
  };
}

/** Index-aligned with `frames`; any frame beyond `receipts` is `not-run`. */
function frameStatusesOf(
  frames: Frame[],
  receipts?: FrameSimulationReceipt[]
): FrameRunStatus[] {
  return frames.map((_, i) => receipts?.[i]?.status ?? "not-run");
}

export interface RecordAdmissionInput {
  tx: FrameTransaction;
  txHash: string;
  source: AdmissionSource;
  outcome: AdmissionOutcome;
  checks: RuleCheck[];
  errorCode?: number;
  /** When the node received the transaction; defaults to the clock at recording time. */
  at?: number;
  /**
   * The traced simulation's per-frame receipts, index-aligned with `tx.frames`
   * (see `CheckCollector.getFrameReceipts`). Absent when simulation never ran
   * or never produced a trace: every frame is then recorded `not-run`.
   */
  frameReceipts?: FrameSimulationReceipt[];
}

/**
 * In-memory history for the explorer: one `AdmissionRecord` per transaction
 * hash and an append-only `LifecycleEvent` ring buffer. Both are bounded by
 * `capacity`; a restart clears them. Keyed by tx hash, not `sender:nonce`, so
 * replaced and rejected transactions stay visible.
 */
export class ExplorerService {
  private events: LifecycleEvent[] = [];
  private admissions = new Map<string, AdmissionRecord>();
  private nextSeq = 1;
  private nextAdmissionId = 1;
  private listeners = new Set<(event: LifecycleEvent) => void>();

  /** Random per process start, so clients can tell a restart from a gap. */
  readonly bootId: string = randomBytes(8).toString("hex");

  constructor(
    private capacity: number = DEFAULT_EXPLORER_CAPACITY,
    private clock: () => number = now
  ) {}

  get historyCapacity(): number {
    return this.capacity;
  }

  /**
   * A record that is already `accepted`/`replaced` is never overwritten (a
   * duplicate resubmission that fails the replacement fee check must not turn
   * an accepted transaction into a rejected one). A `rejected` record can be
   * upgraded by a later acceptance; it keeps its id, first-seen time and source.
   */
  recordAdmission(input: RecordAdmissionInput): AdmissionRecord {
    const existing = this.admissions.get(input.txHash);
    if (existing && existing.outcome !== "rejected") {
      return existing;
    }
    const record: AdmissionRecord = {
      id: existing?.id ?? this.nextAdmissionId++,
      txHash: input.txHash,
      sender: input.tx.sender,
      nonce: toHex(input.tx.nonceSeq),
      nonceKeys: input.tx.nonceKeys.map((k) => toHex(k)),
      at: existing?.at ?? input.at ?? this.clock(),
      source: existing?.source ?? input.source,
      outcome: input.outcome,
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      checks: input.checks.map((c) =>
        c.detail === undefined ? { ...c } : { ...c, detail: truncateText(c.detail) }
      ),
      frames: input.tx.frames.map(serializeExplorerFrame),
      frameStatuses: frameStatusesOf(input.tx.frames, input.frameReceipts),
    };
    this.admissions.set(input.txHash, record);
    while (this.admissions.size > this.capacity) {
      const oldest = this.admissions.keys().next().value as string;
      this.admissions.delete(oldest);
    }
    return record;
  }

  markReplaced(oldTxHash: string, newTxHash: string): void {
    const old = this.admissions.get(oldTxHash);
    if (old) old.outcome = "replaced";
    this.recordLifecycle({
      txHash: oldTxHash,
      kind: "replaced",
      reason: `replaced by ${newTxHash}`,
    });
  }

  markDropped(txHash: string, reason?: string, status?: string): void {
    const record = this.admissions.get(txHash);
    // `included` is a one-way door - a transaction that's already confirmed
    // on-chain must never be reported dropped again, even if a stale
    // Cancelled transition somehow arrives after the fact.
    if (record && record.outcome !== "included") record.outcome = "dropped";
    this.recordLifecycle({ txHash, kind: "dropped", reason, status });
  }

  /**
   * `includer` is the including block's `miner`. Once a record is `included`,
   * nothing else may overwrite its outcome - a transaction that landed
   * on-chain stays landed, even if this method is somehow called again for
   * the same hash.
   */
  markIncluded(txHash: string, includer?: `0x${string}`, status?: string): void {
    const record = this.admissions.get(txHash);
    if (record && record.outcome !== "included") {
      record.outcome = "included";
    }
    if (record && includer) record.includer = includer;
    this.recordLifecycle({ txHash, kind: "included", status });
  }

  recordLifecycle(input: {
    txHash: string;
    kind: LifecycleKind;
    status?: string;
    reason?: string;
    blockNumber?: number;
  }): LifecycleEvent {
    const event: LifecycleEvent = {
      seq: this.nextSeq++,
      txHash: input.txHash,
      at: this.clock(),
      kind: input.kind,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.reason !== undefined
        ? { reason: truncateText(input.reason) }
        : {}),
      ...(input.blockNumber !== undefined
        ? { blockNumber: input.blockNumber }
        : {}),
    };
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken listener must not stop recording or other listeners
      }
    }
    return event;
  }

  getAdmission(txHash: string): AdmissionRecord | undefined {
    return this.admissions.get(txHash);
  }

  /** Newest first. `cursor` is the `id` of the last record of the previous page. */
  listAdmissions(
    query: { outcome?: AdmissionOutcome; cursor?: string; limit?: number } = {}
  ): Page<AdmissionRecord> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const before =
      query.cursor === undefined ? Infinity : Number(query.cursor);
    const all = [...this.admissions.values()];
    const matching: AdmissionRecord[] = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const record = all[i];
      if (record.id >= before) continue;
      if (query.outcome && record.outcome !== query.outcome) continue;
      matching.push(record);
      if (matching.length > limit) break;
    }
    const items = matching.slice(0, limit);
    return matching.length > limit
      ? { items, nextCursor: String(items[items.length - 1].id) }
      : { items };
  }

  getEvents(txHash: string): LifecycleEvent[] {
    return this.events.filter((e) => e.txHash === txHash);
  }

  /** Events with `seq` greater than `seq`, oldest first. */
  eventsSince(seq: number, limit = 1000): LifecycleEvent[] {
    return this.events.filter((e) => e.seq > seq).slice(0, limit);
  }

  latestSeq(): number {
    return this.nextSeq - 1;
  }

  /** Lowest retained `seq`, or 0 when nothing is recorded. */
  oldestSeq(): number {
    return this.events[0]?.seq ?? 0;
  }

  onEvent(listener: (event: LifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Derives lifecycle events from mempool status changes on the executor event bus. */
  attach(bus: ExecutorEventBus): void {
    bus.on(ExecutorEvent.pendingUserOps, (entry) =>
      this.fromEntry("admitted", entry)
    );
    bus.on(ExecutorEvent.submittedUserOps, (entry) => {
      if (!entry.txHash) return;
      // `submittedUserOps` carries Submitted, Cancelled and Reverted transitions.
      if (entry.status === MempoolEntryStatus.Cancelled) {
        this.markDropped(
          entry.txHash,
          entry.revertReason,
          MempoolEntryStatus[entry.status]
        );
      } else {
        this.fromEntry("statusChanged", entry, entry.revertReason);
      }
    });
    bus.on(ExecutorEvent.onChainUserOps, (entry) => {
      if (!entry.txHash) return;
      this.markIncluded(
        entry.txHash,
        entry.includer,
        MempoolEntryStatus[entry.status]
      );
    });
  }

  private fromEntry(
    kind: LifecycleKind,
    entry: FrameTxMempoolEntry,
    reason?: string
  ): void {
    if (!entry.txHash) return;
    this.recordLifecycle({
      txHash: entry.txHash,
      kind,
      status: MempoolEntryStatus[entry.status],
      reason,
    });
  }
}
