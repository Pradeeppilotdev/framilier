import type {
  Admission,
  Check,
  Info,
  LifecycleEventData,
  Peer,
  ReputationEntry,
  TransactionDetail,
  TransactionSummary,
} from "../src/protocol/schemas";

/**
 * A fake sidecar explorer node. It keeps state in memory and answers the six
 * `skandha_explorer_*` methods exactly like the real backend (same error codes,
 * cursor rules, page-size clamp and lifecycle-event mapping), so the UI can be
 * developed and tested without a running devnet. The HTTP/WebSocket wrapper is
 * in `server.ts`; everything here is plain TypeScript and unit-tested.
 */

export const STATUSES = ["New", "Pending", "Submitted", "OnChain", "Finalized", "Cancelled", "Reverted"] as const;
export type Status = (typeof STATUSES)[number];

export interface MockFrame {
  mode: number;
  flags: number;
  target: string | null;
  execution: number;
  state?: number;
  value?: number;
  data?: string;
}

export interface MockTx {
  hash: string;
  sender: string;
  payer: string;
  factory?: string;
  nonce: number;
  status: Status;
  frames: MockFrame[];
  maxFeePerGas: bigint;
  submittedTime: number;
  revertReason?: string;
}

export interface MockNodeOptions {
  name: string;
  chainId?: number;
  explorerEnabled?: boolean;
  p2pEnabled?: boolean;
  /** Offers `skandha_explorer_faucet` and reports it in `info`. */
  faucet?: boolean;
  capacity?: number;
  bootId?: string;
  peers?: Peer[];
  now?: () => number;
}

export type RpcOutcome = { result: unknown } | { error: { code: number; message: string } };

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const hex = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;
const fail = (code: number, message: string): RpcOutcome => ({ error: { code, message } });

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE;
  return Math.min(Math.floor(limit), MAX_PAGE);
}

function randomBootId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export class MockNode {
  readonly name: string;
  bootId: string;
  private readonly now: () => number;
  private readonly pool = new Map<string, MockTx>();
  private admissions = new Map<string, Admission>();
  private reputation = new Map<string, ReputationEntry>();
  private events: LifecycleEventData[] = [];
  private nextSeq = 1;
  private nextAdmissionId = 1;
  private readonly listeners = new Set<(event: LifecycleEventData) => void>();

  constructor(readonly options: MockNodeOptions) {
    this.name = options.name;
    this.now = options.now ?? Date.now;
    this.bootId = options.bootId ?? randomBootId();
  }

  get explorerEnabled(): boolean {
    return this.options.explorerEnabled ?? true;
  }

  private get capacity(): number {
    return this.options.capacity ?? 10_000;
  }

  // ---- scenario controls -------------------------------------------------

  /** Puts a transaction in the mempool store and records its admission and `admitted` event. */
  admit(tx: MockTx, source = "rpc", checks: Check[] = passingChecks(tx), at = tx.submittedTime): void {
    this.pool.set(tx.hash, tx);
    this.recordAdmission(tx, "accepted", checks, source, undefined, at);
    this.emit(tx.hash, "admitted", tx.status, undefined, at);
  }

  /** Records a rejection: an admission and a `rejected` event, and nothing in the mempool. */
  reject(tx: MockTx, checks: Check[], source = "rpc", errorCode = -32502, at = tx.submittedTime): void {
    this.recordAdmission(tx, "rejected", checks, source, errorCode, at);
    const first = checks.find((c) => c.verdict === "fail");
    this.emit(tx.hash, "rejected", undefined, first?.detail, at);
  }

  /** Moves a pooled transaction to a new status and emits the matching lifecycle event. */
  setStatus(hash: string, status: Status, reason?: string, at = this.now()): void {
    const tx = this.pool.get(hash);
    if (!tx) return;
    tx.status = status;
    if (reason !== undefined) tx.revertReason = reason;
    const kind = status === "OnChain" ? "included" : status === "Cancelled" ? "dropped" : "statusChanged";
    this.emit(hash, kind, status, reason, at);
  }

  /** A newer transaction takes the old one's slot: the old entry leaves the pool. */
  replace(oldHash: string, next: MockTx, source = "rpc", at = next.submittedTime): void {
    this.pool.delete(oldHash);
    const old = this.admissions.get(oldHash);
    if (old) old.outcome = "replaced";
    this.emit(oldHash, "replaced", undefined, `replaced by ${next.hash}`, at);
    this.admit(next, source, undefined, at);
  }

  /** Simulates a process restart: history and `seq` reset, the mempool store stays, `bootId` changes. */
  restart(): void {
    this.bootId = randomBootId();
    this.admissions = new Map();
    this.events = [];
    this.nextSeq = 1;
    this.nextAdmissionId = 1;
  }

  /** Seeds one reputation/stake entry directly - the mock doesn't derive this from admit()/setStatus() calls (see mock/fixtures.ts's callers for why). */
  setReputationEntry(entry: ReputationEntry): void {
    this.reputation.set(entry.address.toLowerCase(), entry);
  }

  // ---- protocol ----------------------------------------------------------

  private recordAdmission(
    tx: MockTx,
    outcome: Admission["outcome"],
    checks: Check[],
    source: string,
    errorCode: number | undefined,
    at: number,
  ): void {
    // Like the backend: an accepted or replaced record is final; a rejected one is upgraded in place.
    const existing = this.admissions.get(tx.hash);
    if (existing && existing.outcome !== "rejected") return;
    const frames = serializeTx(tx).frames as Admission["frames"];
    // The mock doesn't run a real trace: a frame with a failing check
    // "reverted", one with any check "succeeded" (a rule ran against it), and
    // one with none is "not-run" for a rejected tx (never reached) or
    // "success" for an accepted one (accepted implies its frames ran) -
    // good enough for exercising the UI, not a claim about real semantics.
    const frameStatuses: Admission["frameStatuses"] = frames.map((_, i) => {
      const own = checks.filter((c) => c.frameIndex === i);
      if (own.some((c) => c.verdict === "fail")) return "reverted";
      if (own.length > 0) return "success";
      return outcome === "accepted" ? "success" : "not-run";
    });
    const record: Admission = {
      id: existing?.id ?? this.nextAdmissionId++,
      txHash: tx.hash,
      sender: tx.sender,
      nonce: hex(tx.nonce),
      at: existing?.at ?? at,
      source: existing?.source ?? source,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      checks,
      frames,
      frameStatuses,
    };
    this.admissions.set(tx.hash, record);
    while (this.admissions.size > this.capacity) {
      this.admissions.delete(this.admissions.keys().next().value as string);
    }
  }

  private emit(txHash: string, kind: string, status?: string, reason?: string, at = this.now()): void {
    const event: LifecycleEventData = {
      seq: this.nextSeq++,
      txHash,
      at,
      kind,
      ...(status === undefined ? {} : { status }),
      ...(reason === undefined ? {} : { reason }),
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const listener of this.listeners) listener(event);
  }

  /**
   * The `explorerEvents` stream. With `sinceSeq`, every retained event after it
   * is replayed first; then live events follow. Returns an unsubscribe function.
   */
  subscribe(sinceSeq: number | undefined, send: (event: LifecycleEventData) => void): () => void {
    if (typeof sinceSeq === "number") {
      for (const event of this.events) if (event.seq > sinceSeq) send(event);
    }
    this.listeners.add(send);
    return () => {
      this.listeners.delete(send);
    };
  }

  /** Answers one JSON-RPC call the way the real API does. */
  handle(method: string, params: unknown[] = []): RpcOutcome {
    if (!method.startsWith("skandha_explorer_")) {
      return fail(METHOD_NOT_FOUND, `Method ${method} is not supported`);
    }
    if (!this.explorerEnabled) {
      return fail(METHOD_NOT_FOUND, "Explorer is disabled: start the node with --explorer.enable");
    }
    const arg = params[0];
    const object = typeof arg === "object" && arg !== null ? (arg as Record<string, unknown>) : {};
    switch (method) {
      case "skandha_explorer_info":
        return { result: this.info() };
      case "skandha_explorer_listTransactions":
        return this.listTransactions(object);
      case "skandha_explorer_listAdmissions":
        return this.listAdmissions(object);
      case "skandha_explorer_getTransaction":
        return this.getTransaction(arg);
      case "skandha_explorer_peers":
        return { result: this.options.p2pEnabled === false ? [] : (this.options.peers ?? []) };
      case "skandha_explorer_listReputation":
        return this.listReputation(object);
      case "skandha_explorer_faucet":
        return this.faucet(arg);
      default:
        return fail(METHOD_NOT_FOUND, `Method ${method} is not supported`);
    }
  }

  private faucetRecipients = new Set<string>();

  private faucet(address: unknown): RpcOutcome {
    if (!this.options.faucet) return fail(METHOD_NOT_FOUND, "Faucet is disabled");
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return fail(INVALID_REQUEST, "Expected an address");
    }
    if (this.faucetRecipients.has(address.toLowerCase())) {
      return fail(INVALID_REQUEST, "This address already received funds: try again in 60 min");
    }
    this.faucetRecipients.add(address.toLowerCase());
    return { result: { txHash: `0x${"fa".repeat(32)}`, amount: "1000000000000000000" } };
  }

  private info(): Info {
    return {
      protocolVersion: 1,
      chainId: this.options.chainId ?? 1337,
      version: "4.1.1",
      commit: "a1b2c3d",
      bundlingMode: "auto",
      p2pEnabled: this.options.p2pEnabled ?? true,
      latestSeq: this.nextSeq - 1,
      oldestSeq: this.events[0]?.seq ?? 0,
      historyCapacity: this.capacity,
      bootId: this.bootId,
      minInclusionDenominator: 10,
      throttlingSlack: 10,
      banSlack: 50,
      ...(this.options.faucet ? { faucetEnabled: true } : {}),
    };
  }

  private summary(tx: MockTx): TransactionSummary {
    const source = this.admissions.get(tx.hash)?.source;
    return {
      txHash: tx.hash,
      sender: tx.sender,
      payer: tx.payer,
      ...(tx.factory === undefined ? {} : { factory: tx.factory }),
      nonce: hex(tx.nonce),
      status: tx.status,
      frames: tx.frames.length,
      maxFeePerGas: hex(tx.maxFeePerGas),
      submittedTime: tx.submittedTime,
      lastUpdatedTime: tx.submittedTime,
      ...(source === undefined ? {} : { source }),
    };
  }

  private listTransactions(p: Record<string, unknown>): RpcOutcome {
    let wanted: string | undefined;
    if (p.status !== undefined) {
      if (typeof p.status !== "string" || !(STATUSES as readonly string[]).includes(p.status)) {
        return fail(INVALID_REQUEST, `Unknown status: ${String(p.status)}`);
      }
      wanted = p.status;
    }
    const offset = p.cursor === undefined ? 0 : Number(p.cursor);
    if (!Number.isInteger(offset) || offset < 0) return fail(INVALID_REQUEST, `Invalid cursor: ${String(p.cursor)}`);
    const limit = clampLimit(p.limit);
    const all = [...this.pool.values()]
      .filter((tx) => wanted === undefined || tx.status === wanted)
      .sort((a, b) => b.submittedTime - a.submittedTime);
    const items = all.slice(offset, offset + limit).map((tx) => this.summary(tx));
    return {
      result: offset + limit < all.length ? { items, nextCursor: String(offset + limit) } : { items },
    };
  }

  private listAdmissions(p: Record<string, unknown>): RpcOutcome {
    if (p.outcome !== undefined && !["accepted", "rejected", "replaced"].includes(String(p.outcome))) {
      return fail(INVALID_REQUEST, `Unknown outcome: ${String(p.outcome)}`);
    }
    if (p.cursor !== undefined && !Number.isFinite(Number(p.cursor))) {
      return fail(INVALID_REQUEST, `Invalid cursor: ${String(p.cursor)}`);
    }
    const before = p.cursor === undefined ? Infinity : Number(p.cursor);
    const limit = clampLimit(p.limit);
    const matching = [...this.admissions.values()]
      .reverse()
      .filter((r) => r.id < before && (p.outcome === undefined || r.outcome === p.outcome));
    const items = matching.slice(0, limit);
    const last = items[items.length - 1];
    return {
      result: matching.length > limit && last ? { items, nextCursor: String(last.id) } : { items },
    };
  }

  private listReputation(p: Record<string, unknown>): RpcOutcome {
    if (p.cursor !== undefined && !Number.isFinite(Number(p.cursor))) {
      return fail(INVALID_REQUEST, `Invalid cursor: ${String(p.cursor)}`);
    }
    const offset = p.cursor === undefined ? 0 : Number(p.cursor);
    const limit = clampLimit(p.limit);
    const all = [...this.reputation.values()].sort((a, b) => a.address.localeCompare(b.address));
    const items = all.slice(offset, offset + limit);
    return {
      result: offset + limit < all.length ? { items, nextCursor: String(offset + limit) } : { items },
    };
  }

  private getTransaction(arg: unknown): RpcOutcome {
    if (typeof arg !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(arg)) {
      return fail(INVALID_REQUEST, "Expected a 32-byte hex transaction hash");
    }
    const hash = arg.toLowerCase();
    const tx = this.pool.get(hash);
    const admission = this.admissions.get(hash) ?? null;
    const events = this.events.filter((e) => e.txHash === hash);
    if (!tx && !admission && events.length === 0) return fail(INVALID_REQUEST, "Frame transaction not found");
    const detail: TransactionDetail = {
      hash,
      entry: tx
        ? {
            ...this.summary(tx),
            tx: serializeTx(tx),
            ...(tx.revertReason === undefined ? {} : { revertReason: tx.revertReason }),
          }
        : null,
      admission,
      events,
    };
    return { result: detail };
  }
}

/** The frame transaction as `getTransaction` serializes it: every quantity a `0x` hex string. */
export function serializeTx(tx: MockTx): Record<string, unknown> {
  return {
    chainId: hex(1337),
    nonce: hex(tx.nonce),
    sender: tx.sender,
    frames: tx.frames.map((f) => ({
      mode: f.mode,
      flags: f.flags,
      target: f.target,
      limits: { execution: hex(f.execution), state: hex(f.state ?? 0) },
      value: hex(f.value ?? 0),
      data: f.data ?? "0x",
    })),
    signatures: [],
    fees: { maxPriorityFeePerGas: hex(1_000_000_000), maxFeePerGas: hex(tx.maxFeePerGas), maxFeePerBlobGas: hex(0) },
    blobVersionedHashes: [],
  };
}

/** A clean report for an accepted transaction: every rule passes, per entity for its validation frames. */
export function passingChecks(tx: MockTx): Check[] {
  const globals = [
    "gas-limit", "prefix", "structure", "signature", "simulation", "trace-alignment", "OP-061", "execution",
  ];
  const perFrame = ["trace-alignment", "out-of-gas", "OP-011", "create", "storage", "COD-010", "entrypoint-access"];
  const checks: Check[] = globals.map((rule) => ({ rule, verdict: "pass" }));
  tx.frames.forEach((frame, frameIndex) => {
    // Only validation-prefix frames have an entity: a leading deploy frame is
    // the factory; a verify frame is the payer (payment scope) or the sender.
    let entity: Check["entity"];
    if (frame.mode === 0 && frameIndex === 0 && tx.factory !== undefined) entity = "factory";
    else if (frame.mode === 1) entity = (frame.flags & 1) !== 0 ? "payer" : "sender";
    else return;
    for (const rule of perFrame) checks.push({ rule, frameIndex, entity, verdict: "pass" });
  });
  checks.push({ rule: "mempool", verdict: "pass" });
  return checks;
}
