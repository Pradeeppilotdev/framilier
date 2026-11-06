# Devnet Explorer Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record per-rule admission reports and a per-transaction lifecycle log inside a sidecar instance, and expose them through read-only `skandha_explorer_*` RPC methods and a resumable WebSocket stream.

**Architecture:** A new `ExplorerService` (in-memory, bounded) holds `AdmissionRecord`s and a `LifecycleEvent` ring buffer. `FrameTxValidationService` builds a `RuleCheck[]` through a `CheckCollector` while still throwing `RpcError` at the same sites. `Eth.sendFrameTransaction` records every accepted and rejected admission. The event bus feeds lifecycle events. A new `Explorer` module and API layer expose the data, gated by `--explorer.enable`.

**Tech Stack:** TypeScript, Bun workspaces, Vitest (run from `packages/executor`), viem, Fastify JSON-RPC (`packages/api`), `ws`.

**Spec:** `docs/superpowers/specs/2026-09-24-devnet-explorer-design.md` (sub-project 1 of 2; the UI plan follows and consumes the types defined in Task 1).

## Global Constraints

- History is in memory only; ring buffer default capacity is 10,000 events (spec: "default 10,000 events").
- Read API is read-only, behind `--explorer.enable`, and separate from `debug_bundler_*`.
- Method names are exactly: `skandha_explorer_info`, `skandha_explorer_listTransactions`, `skandha_explorer_listAdmissions`, `skandha_explorer_getTransaction`, `skandha_explorer_peers`.
- `skandha_explorer_info` returns a `protocolVersion`.
- The stream is an extra event on `skandha_subscribe`; clients resume with `sinceSeq`.
- `FrameTxValidationService` keeps throwing `RpcError` at its current sites; callers that do not pass a collector see no behavior change.
- Explorer wire types live in `packages/types/src/explorer/index.ts` and have zero imports, so the UI can import that subpath alone.
- Explorer results must NOT pass through the API's `deepHexlify` (it converts every JSON number to a hex string). Numbers stay numbers; only values that can exceed 2^53 are `0x` hex strings.
- Tests run from inside `packages/executor` (`bunx vitest run <file>`), never from the repo root (CLAUDE.md). Intra-workspace imports resolve to built `lib/`, so after changing `packages/types` run `cd packages/types && bun run build` before running executor tests.
- Commit messages end with these two lines:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
  ```

## Review Focus

Failure modes the spec implies but a happy-path test would not catch. Each has a pinning test in the task named.

1. **Duplicate resubmission.** Resubmitting an already-accepted tx (fee too low to replace itself) must not overwrite its `accepted` record with a `rejected` one. A viewer would then see an accepted tx as rejected. (Task 3)
2. **History overflow.** Past 10,000 events the oldest are evicted. A client resuming with a `sinceSeq` older than the oldest retained event must be able to detect the gap, so `info` reports `oldestSeq`. (Tasks 3, 8)
3. **Explorer disabled.** With the flag off, every explorer method answers "method not found" and nothing is recorded, so memory does not grow. (Tasks 7, 8)
4. **Whitelisted entity.** An entity whose violations are waived by the whitelist must show `pass` (with a "waived" note), not `fail`, on a tx that was accepted. (Task 5)
5. **Hostile or sloppy params.** A malformed hash, a non-numeric cursor, an unknown status name, or a `limit` of 0, negative or huge must give a clean `INVALID_REQUEST` or a clamped page, never a crash or an unbounded response. (Task 8)

---

### Task 1: Explorer wire types and spec amendments

**Files:**
- Create: `packages/types/src/explorer/index.ts`
- Modify: `docs/superpowers/specs/2026-09-24-devnet-explorer-design.md`

**Interfaces:**
- Produces (used by every later task and by the UI plan): `EXPLORER_PROTOCOL_VERSION`, `EXPLORER_RULES`, `ExplorerRuleId`, `GLOBAL_RULE_ORDER`, `ENTITY_RULE_ORDER`, `EntityRole`, `CheckVerdict`, `RuleCheck`, `AdmissionSource`, `AdmissionOutcome`, `AdmissionRecord`, `LifecycleKind`, `LifecycleEvent`, `Page<T>`, `ExplorerInfo`, `ExplorerTransactionSummary`, `ExplorerTransactionDetail`, `ExplorerPeer`. Imported as `@skandha/types/lib/explorer/index.js`.

- [ ] **Step 1: Write the types file**

```ts
// packages/types/src/explorer/index.ts
/**
 * Wire types for the explorer RPC surface (`skandha_explorer_*`).
 *
 * This file has NO imports on purpose: a browser bundle can import the
 * subpath `@skandha/types/lib/explorer/index.js` without pulling in the rest
 * of `@skandha/types`.
 *
 * Wire conventions: JSON numbers are plain numbers (`seq`, `at`, `id`,
 * `errorCode`). Quantities that can exceed 2^53 (nonce, fees) are `0x`
 * hex strings. Explorer results bypass the API's `deepHexlify`.
 */

export const EXPLORER_PROTOCOL_VERSION = 1;

/** Stable rule ids used in `RuleCheck.rule`. The UI maps them to labels. */
export const EXPLORER_RULES = {
  GAS_LIMIT: "gas-limit",
  PREFIX: "prefix",
  STRUCTURE: "structure",
  SIGNATURE: "signature",
  SIMULATION: "simulation",
  TRACE_ALIGNMENT: "trace-alignment",
  NESTED_CALL_VALUE: "OP-061",
  EXECUTION: "execution",
  OUT_OF_GAS: "out-of-gas",
  BANNED_OPCODE: "OP-011",
  CREATE: "create",
  STORAGE: "storage",
  CODE_ACCESS: "COD-010",
  ENTRYPOINT_ACCESS: "entrypoint-access",
  MEMPOOL: "mempool",
  /** A failure that no other rule claimed (unexpected error). */
  ADMISSION: "admission",
} as const;

export type ExplorerRuleId =
  (typeof EXPLORER_RULES)[keyof typeof EXPLORER_RULES];

/** Rules evaluated once per transaction, in the order the node runs them. */
export const GLOBAL_RULE_ORDER: readonly ExplorerRuleId[] = [
  EXPLORER_RULES.GAS_LIMIT,
  EXPLORER_RULES.PREFIX,
  EXPLORER_RULES.STRUCTURE,
  EXPLORER_RULES.SIGNATURE,
  EXPLORER_RULES.SIMULATION,
  EXPLORER_RULES.TRACE_ALIGNMENT,
  EXPLORER_RULES.NESTED_CALL_VALUE,
  EXPLORER_RULES.EXECUTION,
  EXPLORER_RULES.MEMPOOL,
];

/** Rules evaluated once per validation-prefix entity (sender/payer/factory). */
export const ENTITY_RULE_ORDER: readonly ExplorerRuleId[] = [
  EXPLORER_RULES.OUT_OF_GAS,
  EXPLORER_RULES.BANNED_OPCODE,
  EXPLORER_RULES.CREATE,
  EXPLORER_RULES.STORAGE,
  EXPLORER_RULES.CODE_ACCESS,
  EXPLORER_RULES.ENTRYPOINT_ACCESS,
];

export type EntityRole = "sender" | "payer" | "factory";
export type CheckVerdict = "pass" | "fail" | "skipped";

export interface RuleCheck {
  rule: ExplorerRuleId;
  frameIndex?: number;
  entity?: EntityRole;
  verdict: CheckVerdict;
  detail?: string;
}

/** Where this node first saw the transaction. */
export type AdmissionSource = "rpc" | `gossip:${string}` | `sync:${string}`;

/**
 * `replaced` is set on the OLD transaction's record when a newer one takes its
 * `sender:nonce` slot. The new transaction's own record is `accepted`.
 */
export type AdmissionOutcome = "accepted" | "rejected" | "replaced";

export interface AdmissionRecord {
  /** Monotonic; used as the pagination cursor. */
  id: number;
  txHash: string;
  sender: string;
  /** 0x hex quantity */
  nonce: string;
  /** Unix ms when this node first saw the transaction */
  at: number;
  source: AdmissionSource;
  outcome: AdmissionOutcome;
  /** JSON-RPC error code, present when `outcome` is `rejected` */
  errorCode?: number;
  checks: RuleCheck[];
}

export type LifecycleKind =
  | "admitted"
  | "rejected"
  | "replaced"
  | "statusChanged"
  | "dropped"
  | "included";

export interface LifecycleEvent {
  /** Monotonic across the node's lifetime; resume streams with `sinceSeq`. */
  seq: number;
  txHash: string;
  at: number;
  kind: LifecycleKind;
  /** Mempool status name after this event, when known */
  status?: string;
  reason?: string;
  blockNumber?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ExplorerInfo {
  protocolVersion: number;
  chainId: number;
  version: string;
  commit: string;
  bundlingMode: string;
  p2pEnabled: boolean;
  /** Highest `seq` recorded so far (0 if none) */
  latestSeq: number;
  /** Lowest `seq` still retained (0 if none). A resume point below this has a gap. */
  oldestSeq: number;
  historyCapacity: number;
}

export interface ExplorerTransactionSummary {
  txHash: string;
  sender: string;
  payer: string;
  factory?: string;
  nonce: string;
  status: string;
  frames: number;
  maxFeePerGas: string;
  submittedTime?: number;
  lastUpdatedTime: number;
}

export interface ExplorerTransactionDetail {
  hash: string;
  entry:
    | (ExplorerTransactionSummary & {
        /** Serialized frame transaction (hex-encoded quantities) */
        tx: Record<string, unknown>;
        revertReason?: string;
        transaction?: string;
      })
    | null;
  admission: AdmissionRecord | null;
  events: LifecycleEvent[];
}

export interface ExplorerPeer {
  peerId: string;
  direction: string;
  connectedAt: number;
  lastReceivedAt: number;
  agentVersion: string | null;
  supportedMempools: string[];
}
```

- [ ] **Step 2: Amend the spec to match**

In `docs/superpowers/specs/2026-09-24-devnet-explorer-design.md`, apply these three edits.

Replace the row
`| \`source\` | \`rpc\` or \`gossip:<peerId>\` |`
with
`| \`source\` | \`rpc\`, \`gossip:<peerId>\` or \`sync:<peerId>\` |`

Replace the row
`| \`outcome\` | \`accepted\`, \`rejected\` or \`replaced\` |`
with
`| \`outcome\` | \`accepted\`, \`rejected\` or \`replaced\`. \`replaced\` is set on the old transaction's record when a newer one takes its \`sender:nonce\` slot. |`

Replace the row
`| \`skandha_explorer_info\` | Node identity, chain ID, bundling mode, \`protocolVersion\` |`
with
`| \`skandha_explorer_info\` | Chain ID, version, bundling mode, \`protocolVersion\`, \`latestSeq\`, \`oldestSeq\` (a resume point below it has a gap) |`

Then add this paragraph at the end of the "Read API" section, before the "UI design" heading:

```
Explorer results are plain JSON: numbers are numbers, and quantities that can exceed 2^53 (nonce,
fees) are `0x` hex strings. They bypass the API's `deepHexlify`.
```

- [ ] **Step 3: Build and check**

Run:
```bash
cd /Users/alexf/skandha/packages/types && bun run build
node -e "import('./lib/explorer/index.js').then(m => console.log(m.EXPLORER_PROTOCOL_VERSION, m.GLOBAL_RULE_ORDER.length, m.ENTITY_RULE_ORDER.length))"
! grep -q "^import" src/explorer/index.ts && echo "no imports"
```
Expected: build succeeds; output `1 9 6`; then `no imports`.

- [ ] **Step 4: Commit**

```bash
cd /Users/alexf/skandha
git add packages/types/src/explorer/index.ts docs/superpowers/specs/2026-09-24-devnet-explorer-design.md
git commit -m "$(cat <<'EOF'
feat(types): explorer wire types and rule ids

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 2: CheckCollector

**Files:**
- Create: `packages/executor/src/services/ExplorerService/checkCollector.ts`
- Test: `packages/executor/test/services/ExplorerService/checkCollector.test.ts`

**Interfaces:**
- Consumes: `RuleCheck`, `ExplorerRuleId`, `EntityRole`, `GLOBAL_RULE_ORDER`, `ENTITY_RULE_ORDER` from Task 1.
- Produces:
  - `interface CheckContext { frameIndex?: number; entity?: EntityRole }`
  - `class CheckCollector` with `pass(rule, ctx?, detail?): void`, `fail(rule, detail, ctx?): void`, `failed<E extends Error>(rule, err: E, ctx?): E` (records a failure and returns the error so callers write `throw collector.failed(...)`), `hasFailure(): boolean`, `waive(ctx, reason): void`, `toChecks(): RuleCheck[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/executor/test/services/ExplorerService/checkCollector.test.ts
import { describe, it, expect } from "vitest";
import { CheckCollector } from "../../../src/services/ExplorerService/checkCollector.js";
import { EXPLORER_RULES } from "@skandha/types/lib/explorer/index.js";

describe("CheckCollector", () => {
  it("records pass and fail checks with their context", () => {
    const c = new CheckCollector();
    c.pass(EXPLORER_RULES.PREFIX);
    c.fail(EXPLORER_RULES.BANNED_OPCODE, "payer uses banned opcode: DIFFICULTY", {
      frameIndex: 0,
      entity: "payer",
    });
    expect(c.toChecks()).toEqual(
      expect.arrayContaining([
        { rule: "prefix", verdict: "pass" },
        {
          rule: "OP-011",
          verdict: "fail",
          detail: "payer uses banned opcode: DIFFICULTY",
          frameIndex: 0,
          entity: "payer",
        },
      ])
    );
  });

  it("failed() records the failure and returns the same error instance", () => {
    const c = new CheckCollector();
    const err = new Error("boom");
    expect(c.failed(EXPLORER_RULES.SIGNATURE, err)).toBe(err);
    expect(c.hasFailure()).toBe(true);
    expect(c.toChecks().find((x) => x.rule === "signature")).toMatchObject({
      verdict: "fail",
      detail: "boom",
    });
  });

  it("marks global rules that never ran as skipped after a fatal failure", () => {
    const c = new CheckCollector();
    c.pass(EXPLORER_RULES.PREFIX);
    c.fail(EXPLORER_RULES.STRUCTURE, "bad structure");
    const checks = c.toChecks();
    expect(checks.find((x) => x.rule === "signature")).toEqual({
      rule: "signature",
      verdict: "skipped",
    });
    expect(checks.find((x) => x.rule === "mempool")).toMatchObject({
      verdict: "skipped",
    });
    // no entity was reached, so each per-entity rule is listed once, unscoped
    expect(
      checks.filter((x) => x.rule === "OP-011" && x.verdict === "skipped")
    ).toHaveLength(1);
  });

  it("adds no skipped checks when nothing failed", () => {
    const c = new CheckCollector();
    c.pass(EXPLORER_RULES.PREFIX);
    expect(c.toChecks()).toEqual([{ rule: "prefix", verdict: "pass" }]);
  });

  it("does not list per-entity rules as skipped when an entity was evaluated", () => {
    const c = new CheckCollector();
    c.pass(EXPLORER_RULES.OUT_OF_GAS, { frameIndex: 0, entity: "payer" });
    c.fail(EXPLORER_RULES.STORAGE, "bad slot", { frameIndex: 0, entity: "payer" });
    const skipped = c.toChecks().filter((x) => x.verdict === "skipped");
    expect(skipped.some((x) => x.rule === "OP-011")).toBe(false);
  });

  it("waive() turns one entity's failures into passes with a note, leaving others alone", () => {
    const c = new CheckCollector();
    c.fail(EXPLORER_RULES.BANNED_OPCODE, "payer uses banned opcode: GAS", {
      frameIndex: 0,
      entity: "payer",
    });
    c.fail(EXPLORER_RULES.STORAGE, "factory bad slot", {
      frameIndex: 1,
      entity: "factory",
    });
    c.waive({ frameIndex: 0, entity: "payer" }, "whitelisted entity");
    const checks = c.toChecks();
    expect(checks.find((x) => x.entity === "payer")).toMatchObject({
      verdict: "pass",
      detail: "waived (whitelisted entity): payer uses banned opcode: GAS",
    });
    expect(checks.find((x) => x.entity === "factory")?.verdict).toBe("fail");
  });

  it("toChecks() returns copies, so later waive() calls do not alter an earlier snapshot", () => {
    const c = new CheckCollector();
    c.fail(EXPLORER_RULES.STORAGE, "x", { frameIndex: 0, entity: "payer" });
    const snapshot = c.toChecks();
    c.waive({ frameIndex: 0, entity: "payer" }, "w");
    expect(snapshot.find((x) => x.rule === "storage")?.verdict).toBe("fail");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/ExplorerService/checkCollector.test.ts`
Expected: FAIL, cannot resolve `checkCollector.js`.

- [ ] **Step 3: Implement**

```ts
// packages/executor/src/services/ExplorerService/checkCollector.ts
import {
  ENTITY_RULE_ORDER,
  EntityRole,
  ExplorerRuleId,
  GLOBAL_RULE_ORDER,
  RuleCheck,
} from "@skandha/types/lib/explorer/index.js";

export interface CheckContext {
  frameIndex?: number;
  entity?: EntityRole;
}

/**
 * Accumulates the per-rule verdicts of one admission attempt. Validation code
 * keeps throwing `RpcError` exactly as before; it also reports each rule here
 * so the explorer can show a rule-by-rule report.
 */
export class CheckCollector {
  private checks: RuleCheck[] = [];

  pass(rule: ExplorerRuleId, ctx: CheckContext = {}, detail?: string): void {
    this.checks.push({
      rule,
      ...ctx,
      verdict: "pass",
      ...(detail ? { detail } : {}),
    });
  }

  fail(rule: ExplorerRuleId, detail: string, ctx: CheckContext = {}): void {
    this.checks.push({ rule, ...ctx, verdict: "fail", detail });
  }

  /** Records `err` as a failure of `rule` and returns it: `throw collector.failed(...)`. */
  failed<E extends Error>(
    rule: ExplorerRuleId,
    err: E,
    ctx: CheckContext = {}
  ): E {
    this.fail(rule, err.message, ctx);
    return err;
  }

  hasFailure(): boolean {
    return this.checks.some((c) => c.verdict === "fail");
  }

  /** Turns one entity's failures into passes, keeping the original message as a note. */
  waive(ctx: CheckContext, reason: string): void {
    for (const c of this.checks) {
      if (
        c.verdict === "fail" &&
        c.frameIndex === ctx.frameIndex &&
        c.entity === ctx.entity
      ) {
        c.verdict = "pass";
        c.detail = `waived (${reason}): ${c.detail ?? ""}`.trim();
      }
    }
  }

  /**
   * Recorded checks, plus `skipped` entries for rules that never ran because
   * an earlier rule failed. Returns copies.
   */
  toChecks(): RuleCheck[] {
    const out = this.checks.map((c) => ({ ...c }));
    if (!this.hasFailure()) return out;

    for (const rule of GLOBAL_RULE_ORDER) {
      const seen = out.some((c) => c.rule === rule && c.entity === undefined);
      if (!seen) out.push({ rule, verdict: "skipped" });
    }
    const anyEntityEvaluated = out.some((c) => c.entity !== undefined);
    if (!anyEntityEvaluated) {
      for (const rule of ENTITY_RULE_ORDER) {
        out.push({ rule, verdict: "skipped" });
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/ExplorerService/checkCollector.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src/services/ExplorerService/checkCollector.ts packages/executor/test/services/ExplorerService/checkCollector.test.ts
git commit -m "$(cat <<'EOF'
feat(executor): CheckCollector for per-rule admission verdicts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 3: ExplorerService (records, ring buffer, event-bus feed)

**Files:**
- Create: `packages/executor/src/services/ExplorerService/service.ts`
- Create: `packages/executor/src/services/ExplorerService/index.ts`
- Modify: `packages/executor/src/services/index.ts` (add one export line, matching the file's existing style)
- Test: `packages/executor/test/services/ExplorerService/explorerService.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `ExecutorEvent`, `ExecutorEventBus` from `services/SubscriptionService.ts`; `FrameTxMempoolEntry`.
- Produces:
  - `const DEFAULT_EXPLORER_CAPACITY = 10_000`
  - `interface RecordAdmissionInput { tx: FrameTransaction; txHash: string; source: AdmissionSource; outcome: AdmissionOutcome; checks: RuleCheck[]; errorCode?: number }`
  - `class ExplorerService` with: `constructor(capacity?: number, clock?: () => number)`; `recordAdmission(input): AdmissionRecord`; `markReplaced(oldTxHash: string, newTxHash: string): void`; `recordLifecycle(input: { txHash: string; kind: LifecycleKind; status?: string; reason?: string; blockNumber?: number }): LifecycleEvent`; `getAdmission(txHash): AdmissionRecord | undefined`; `listAdmissions(query?: { outcome?: AdmissionOutcome; cursor?: string; limit?: number }): Page<AdmissionRecord>`; `getEvents(txHash): LifecycleEvent[]`; `eventsSince(seq: number, limit?: number): LifecycleEvent[]`; `latestSeq(): number`; `oldestSeq(): number`; `get historyCapacity(): number`; `onEvent(listener: (e: LifecycleEvent) => void): () => void`; `attach(bus: ExecutorEventBus): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/executor/test/services/ExplorerService/explorerService.test.ts
import { describe, it, expect, vi } from "vitest";
import { ExplorerService } from "../../../src/services/ExplorerService/service.js";
import {
  ExecutorEvent,
  ExecutorEventBus,
} from "../../../src/services/SubscriptionService.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";

const SENDER = "0x1111111111111111111111111111111111111111";
const tx = (nonce = 0n): FrameTransaction =>
  ({
    chainId: 1n,
    nonce,
    sender: SENDER,
    frames: [],
    signatures: [],
    fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
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
    bus.emit(ExecutorEvent.onChainUserOps, entry(MempoolEntryStatus.OnChain));
    bus.emit(ExecutorEvent.pendingUserOps, { status: MempoolEntryStatus.New } as any); // no txHash: ignored

    expect(
      svc.getEvents(hash(1)).map((e) => [e.kind, e.status, e.reason])
    ).toEqual([
      ["admitted", "New", undefined],
      ["statusChanged", "Submitted", undefined],
      ["dropped", "Cancelled", "nonce too low"],
      ["statusChanged", "Reverted", "out of gas"],
      ["included", "OnChain", undefined],
    ]);
    expect(svc.latestSeq()).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/ExplorerService/explorerService.test.ts`
Expected: FAIL, cannot resolve `service.js`.

- [ ] **Step 3: Implement the service**

```ts
// packages/executor/src/services/ExplorerService/service.ts
import { toHex } from "viem";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import {
  AdmissionOutcome,
  AdmissionRecord,
  AdmissionSource,
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

export interface RecordAdmissionInput {
  tx: FrameTransaction;
  txHash: string;
  source: AdmissionSource;
  outcome: AdmissionOutcome;
  checks: RuleCheck[];
  errorCode?: number;
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
      nonce: toHex(input.tx.nonce),
      at: existing?.at ?? this.clock(),
      source: existing?.source ?? input.source,
      outcome: input.outcome,
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      checks: input.checks,
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
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
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
      // `submittedUserOps` carries Submitted, Cancelled and Reverted transitions.
      if (entry.status === MempoolEntryStatus.Cancelled) {
        this.fromEntry("dropped", entry, entry.revertReason);
      } else {
        this.fromEntry("statusChanged", entry, entry.revertReason);
      }
    });
    bus.on(ExecutorEvent.onChainUserOps, (entry) =>
      this.fromEntry("included", entry)
    );
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
```

```ts
// packages/executor/src/services/ExplorerService/index.ts
export * from "./service.js";
export * from "./checkCollector.js";
```

Open `packages/executor/src/services/index.ts` and add `export * from "./ExplorerService/index.js";` next to the other service exports, using the same quote and extension style the file already uses.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/ExplorerService`
Expected: PASS (checkCollector 7 + explorerService 9 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src/services/ExplorerService packages/executor/src/services/index.ts packages/executor/test/services/ExplorerService/explorerService.test.ts
git commit -m "$(cat <<'EOF'
feat(executor): ExplorerService with bounded admission and lifecycle history

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 4: Validator reports the transaction-level rules

Edits to `packages/executor/src/services/UserOpValidation/validators/frameTx.ts`. `validate()` gains an optional third argument, so existing callers are unchanged.

**Files:**
- Modify: `packages/executor/src/services/UserOpValidation/validators/frameTx.ts`
- Test: `packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `CheckCollector` (Task 2), `EXPLORER_RULES` (Task 1).
- Produces: `FrameTxValidationService.validate(tx, simResult, collector?: CheckCollector)`. After it returns or throws, `collector.toChecks()` holds one check per transaction-level rule that ran.

- [ ] **Step 1: Confirm the baseline is green**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/UserOpValidation/validators/frameTx.test.ts`
Expected: PASS (13 tests). Do not continue on a red baseline.

- [ ] **Step 2: Write the failing tests**

Add these imports at the top of `frameTx.test.ts`:

```ts
import { CheckCollector } from "../../../../src/services/ExplorerService/checkCollector.js";
```

Append at the end of the file (reuses the file's existing helpers `baseTx`, `selfVerifyFrame`, `ethrexFrame`, `fakeEthrexResult`, `fakeStakingRegistry`, `fakeReputationService`, `fakeNetworkConfig`, `fakeLogger`, `SENDER`, `OTHER_CONTRACT`, `ENTRY_POINT`):

```ts
describe("FrameTxValidationService checks[] (transaction-level rules)", () => {
  const service = () =>
    new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );

  it("records a pass for every transaction-level rule on a clean tx", async () => {
    const collector = new CheckCollector();
    const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER });
    await service().validate(
      baseTx([selfVerifyFrame()]),
      fakeEthrexResult([root]),
      collector
    );
    const passed = collector
      .toChecks()
      .filter((c) => c.entity === undefined && c.verdict === "pass")
      .map((c) => c.rule);
    expect(passed).toEqual(
      expect.arrayContaining([
        "prefix",
        "structure",
        "signature",
        "simulation",
        "trace-alignment",
        "OP-061",
        "execution",
      ])
    );
    expect(collector.hasFailure()).toBe(false);
  });

  it("fails 'prefix' and marks later rules skipped when the prefix is not recognized", async () => {
    const collector = new CheckCollector();
    await expect(
      service().validate(baseTx([]), fakeEthrexResult([]), collector)
    ).rejects.toThrow(RpcError);
    const checks = collector.toChecks();
    expect(checks.find((c) => c.rule === "prefix")?.verdict).toBe("fail");
    expect(checks.find((c) => c.rule === "signature")?.verdict).toBe("skipped");
    expect(checks.find((c) => c.rule === "OP-061")?.verdict).toBe("skipped");
  });

  it("fails 'simulation' with ethrex's violation text when the simulation is invalid", async () => {
    const collector = new CheckCollector();
    const sim = fakeEthrexResult([ethrexFrame({ from: ENTRY_POINT, to: SENDER })]);
    sim.valid = false;
    sim.violation = "gas cap exceeded";
    await expect(
      service().validate(baseTx([selfVerifyFrame()]), sim, collector)
    ).rejects.toThrow("gas cap exceeded");
    expect(collector.toChecks().find((c) => c.rule === "simulation")).toMatchObject({
      verdict: "fail",
      detail: "gas cap exceeded",
    });
  });

  it("fails 'OP-061' on a nested CALL with value, and passes the rules before it", async () => {
    const collector = new CheckCollector();
    const inner = ethrexFrame({ from: SENDER, to: OTHER_CONTRACT, value: "0x1" });
    const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER, calls: [inner] });
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([root]),
        collector
      )
    ).rejects.toThrow("nested CALL with value during validation");
    const checks = collector.toChecks();
    expect(checks.find((c) => c.rule === "OP-061")?.verdict).toBe("fail");
    expect(checks.find((c) => c.rule === "trace-alignment")?.verdict).toBe("pass");
    expect(checks.find((c) => c.rule === "execution")?.verdict).toBe("skipped");
  });

  it("fails 'execution' with ethrex's executionError text", async () => {
    const collector = new CheckCollector();
    const sim = fakeEthrexResult([ethrexFrame({ from: ENTRY_POINT, to: SENDER })]);
    sim.executionError = "execution reverted: nope";
    await expect(
      service().validate(baseTx([selfVerifyFrame()]), sim, collector)
    ).rejects.toThrow("execution reverted: nope");
    expect(collector.toChecks().find((c) => c.rule === "execution")).toMatchObject({
      verdict: "fail",
      detail: "execution reverted: nope",
    });
  });

  it("still works when no collector is passed", async () => {
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([ethrexFrame({ from: ENTRY_POINT, to: SENDER })])
      )
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 3: Run to verify the new tests fail**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/UserOpValidation/validators/frameTx.test.ts`
Expected: the six new tests FAIL (no checks recorded); the original 13 still pass.

- [ ] **Step 4: Implement**

In `frameTx.ts`:

**(a)** Add imports after the existing `Frame`/`FrameTransaction`/`ENTRY_POINT` import block:

```ts
import {
  EXPLORER_RULES,
  ExplorerRuleId,
} from "@skandha/types/lib/explorer/index.js";
import { CheckCollector } from "../../ExplorerService/checkCollector.js";
```

**(b)** Change the `validate` signature:

```ts
  async validate(
    tx: FrameTransaction,
    simResult: EthrexSimulateFrameTransactionResult,
    collector: CheckCollector = new CheckCollector()
  ): Promise<FrameTxValidationResult> {
```

**(c)** Prefix check. Replace
```ts
    if (prefix == null) {
      throw new RpcError(
        "frame transaction validation prefix not recognized",
        RpcErrorCodes.INVALID_OPCODE
      );
    }
```
with
```ts
    if (prefix == null) {
      throw collector.failed(
        EXPLORER_RULES.PREFIX,
        new RpcError(
          "frame transaction validation prefix not recognized",
          RpcErrorCodes.INVALID_OPCODE
        )
      );
    }
    collector.pass(EXPLORER_RULES.PREFIX);
```

**(d)** Structural check. Replace
```ts
    if (!structural.valid) {
      throw new RpcError(structural.reason, RpcErrorCodes.INVALID_USEROP);
    }
```
with
```ts
    if (!structural.valid) {
      throw collector.failed(
        EXPLORER_RULES.STRUCTURE,
        new RpcError(structural.reason, RpcErrorCodes.INVALID_USEROP)
      );
    }
    collector.pass(EXPLORER_RULES.STRUCTURE);
```

**(e)** Signature loop. Replace
```ts
      if (!ok) {
        throw new RpcError(
          "Invalid frame transaction signature",
          RpcErrorCodes.INVALID_SIGNATURE
        );
      }
    }
```
with
```ts
      if (!ok) {
        throw collector.failed(
          EXPLORER_RULES.SIGNATURE,
          new RpcError(
            "Invalid frame transaction signature",
            RpcErrorCodes.INVALID_SIGNATURE
          )
        );
      }
    }
    collector.pass(EXPLORER_RULES.SIGNATURE);
```

**(f)** Simulation validity. Replace the block
```ts
    if (!simResult.valid || simResult.erc7562Trace == null) {
      throw new RpcError(
        simResult.violation ??
          simResult.erc7562TraceError ??
          simResult.executionError ??
          "frame transaction simulation failed",
        RpcErrorCodes.VALIDATION_FAILED
      );
    }
```
with
```ts
    if (!simResult.valid || simResult.erc7562Trace == null) {
      throw collector.failed(
        EXPLORER_RULES.SIMULATION,
        new RpcError(
          simResult.violation ??
            simResult.erc7562TraceError ??
            simResult.executionError ??
            "frame transaction simulation failed",
          RpcErrorCodes.VALIDATION_FAILED
        )
      );
    }
    collector.pass(EXPLORER_RULES.SIMULATION);
```

**(g)** Pass the collector on. Replace the `return this.checkEntityCompliance(` call's argument list, adding `collector` as the last argument:

```ts
    return this.checkEntityCompliance(
      epTopLevelCalls,
      simResult.executionError,
      transactionKeccak,
      tx,
      prefix,
      lastPrefixIndex,
      collector
    );
```

and the method signature:

```ts
  private async checkEntityCompliance(
    epTopLevelCalls: FrameCallTraceFrame[],
    executionError: string | null,
    transactionKeccak: `0x${string}`[],
    tx: FrameTransaction,
    prefix: ValidationPrefixMatch,
    lastPrefixIndex: number,
    collector: CheckCollector
  ): Promise<FrameTxValidationResult> {
```

**(h)** Inside `checkEntityCompliance`, three checks. Replace the length-mismatch throw:
```ts
    if (epTopLevelCalls.length !== lastPrefixIndex + 1) {
      throw new RpcError(
        `frame trace has ${epTopLevelCalls.length} top-level call(s), expected exactly ${lastPrefixIndex + 1} (one per tx.frames[0..${lastPrefixIndex}]) - cannot safely correlate frameIndex to trace level`,
        RpcErrorCodes.INTERNAL_ERROR
      );
    }
```
with
```ts
    if (epTopLevelCalls.length !== lastPrefixIndex + 1) {
      throw collector.failed(
        EXPLORER_RULES.TRACE_ALIGNMENT,
        new RpcError(
          `frame trace has ${epTopLevelCalls.length} top-level call(s), expected exactly ${lastPrefixIndex + 1} (one per tx.frames[0..${lastPrefixIndex}]) - cannot safely correlate frameIndex to trace level`,
          RpcErrorCodes.INTERNAL_ERROR
        )
      );
    }
    collector.pass(EXPLORER_RULES.TRACE_ALIGNMENT);
```
Replace the nested-call throw:
```ts
    if (epTopLevelCalls.some((call) => hasNestedCallWithValue(call))) {
      throw new RpcError(
        "nested CALL with value during validation",
        RpcErrorCodes.INVALID_OPCODE
      );
    }
```
with
```ts
    if (epTopLevelCalls.some((call) => hasNestedCallWithValue(call))) {
      throw collector.failed(
        EXPLORER_RULES.NESTED_CALL_VALUE,
        new RpcError(
          "nested CALL with value during validation",
          RpcErrorCodes.INVALID_OPCODE
        )
      );
    }
    collector.pass(EXPLORER_RULES.NESTED_CALL_VALUE);
```
Replace the execution-error throw:
```ts
    if (executionError) {
      throw new RpcError(executionError, RpcErrorCodes.VALIDATION_FAILED);
    }
```
with
```ts
    if (executionError) {
      throw collector.failed(
        EXPLORER_RULES.EXECUTION,
        new RpcError(executionError, RpcErrorCodes.VALIDATION_FAILED)
      );
    }
    collector.pass(EXPLORER_RULES.EXECUTION);
```

The unused `ExplorerRuleId` import is used in Task 5; if the linter flags it now, add it in Task 5 instead.

- [ ] **Step 5: Run to verify all pass**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/UserOpValidation/validators/frameTx.test.ts`
Expected: PASS (13 original + 6 new = 19).

- [ ] **Step 6: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src/services/UserOpValidation/validators/frameTx.ts packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts
git commit -m "$(cat <<'EOF'
feat(executor): validator reports transaction-level rule verdicts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 5: Validator reports per-entity rules, with whitelist waivers

The per-entity block currently throws at its first violation. It becomes: run every sub-rule, record each verdict, then handle the FIRST violation exactly as the old `catch` did (same thrown error, same whitelist logic). Only the report gains information.

**Files:**
- Modify: `packages/executor/src/services/UserOpValidation/validators/frameTx.ts`
- Test: `packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `CheckCollector.pass/fail/failed/waive` (Task 2).
- Produces: per-entity checks with `{ rule, frameIndex, entity }` for `out-of-gas`, `OP-011`, `create`, `storage`, `COD-010`, `entrypoint-access`, plus `trace-alignment` per entity.

- [ ] **Step 1: Write the failing tests**

Append to `frameTx.test.ts`:

```ts
describe("FrameTxValidationService checks[] (per-entity rules)", () => {
  const service = (netConfig = fakeNetworkConfig()) =>
    new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      netConfig,
      fakeLogger()
    );

  it("records every per-entity rule as a pass for a clean Self Relay tx", async () => {
    const collector = new CheckCollector();
    await service().validate(
      baseTx([selfVerifyFrame()]),
      fakeEthrexResult([ethrexFrame({ from: ENTRY_POINT, to: SENDER })]),
      collector
    );
    const entityChecks = collector.toChecks().filter((c) => c.entity === "payer");
    expect(entityChecks.map((c) => [c.rule, c.verdict, c.frameIndex])).toEqual([
      ["trace-alignment", "pass", 0],
      ["out-of-gas", "pass", 0],
      ["OP-011", "pass", 0],
      ["create", "pass", 0],
      ["storage", "pass", 0],
      ["COD-010", "pass", 0],
      ["entrypoint-access", "pass", 0],
    ]);
  });

  it("reports several violations at once but throws the first, unchanged", async () => {
    // "68" = DIFFICULTY (banned). The nested cross-contract read is an unstaked storage access.
    const innerRead = ethrexFrame({
      from: SENDER,
      to: OTHER_CONTRACT,
      accessedSlots: { ...emptyAccessedSlots(), reads: { [SOME_SLOT]: ["0x0"] } },
    });
    const root = ethrexFrame({
      from: ENTRY_POINT,
      to: SENDER,
      usedOpcodes: { "68": 1 },
      calls: [innerRead],
    });
    const collector = new CheckCollector();
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([root]),
        collector
      )
    ).rejects.toThrow("payer uses banned opcode: DIFFICULTY");

    const failed = collector
      .toChecks()
      .filter((c) => c.verdict === "fail")
      .map((c) => [c.rule, c.entity, c.frameIndex]);
    expect(failed).toEqual(
      expect.arrayContaining([
        ["OP-011", "payer", 0],
        ["storage", "payer", 0],
      ])
    );
  });

  it("fails 'out-of-gas' immediately with entity context", async () => {
    const collector = new CheckCollector();
    const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER, outOfGas: true });
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([root]),
        collector
      )
    ).rejects.toThrow("payer internally reverts on oog");
    expect(collector.toChecks().find((c) => c.rule === "out-of-gas")).toMatchObject({
      verdict: "fail",
      entity: "payer",
      frameIndex: 0,
    });
  });

  it("shows a whitelisted entity's waived violations as pass, with a note", async () => {
    // Self Relay: the payer role maps to the "paymaster" whitelist key.
    const netConfig = {
      ...fakeNetworkConfig(),
      whitelistedEntities: { paymaster: [SENDER] },
    } as unknown as NetworkConfig;
    const collector = new CheckCollector();
    const root = ethrexFrame({
      from: ENTRY_POINT,
      to: SENDER,
      usedOpcodes: { "68": 1 },
    });
    const result = await service(netConfig).validate(
      baseTx([selfVerifyFrame()]),
      fakeEthrexResult([root]),
      collector
    );
    expect(result.mempoolMembership[STANDARD_MEMPOOL_ID]).toBe(false);
    const opcodeCheck = collector.toChecks().find((c) => c.rule === "OP-011");
    expect(opcodeCheck?.verdict).toBe("pass");
    expect(opcodeCheck?.detail).toContain("waived (whitelisted entity)");
    expect(collector.hasFailure()).toBe(false);
  });

  it("fails 'trace-alignment' with entity context when the frame's trace targets the wrong address", async () => {
    const collector = new CheckCollector();
    const root = ethrexFrame({ from: ENTRY_POINT, to: OTHER_CONTRACT });
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([root]),
        collector
      )
    ).rejects.toThrow("frame trace/frameIndex misalignment");
    expect(
      collector
        .toChecks()
        .find((c) => c.rule === "trace-alignment" && c.entity === "payer")
    ).toMatchObject({ verdict: "fail", frameIndex: 0 });
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/UserOpValidation/validators/frameTx.test.ts`
Expected: the five new tests FAIL; the earlier 19 pass.

- [ ] **Step 3: Implement**

In `checkEntityCompliance`, replace everything from the line `for (const { frameIndex, role } of prefix.frames) {` through that loop's closing brace (the loop ends right before `const accessedSlots: { [address: string]: Set<string> } = {};`) with the code below. The rule bodies are the existing ones, moved into `check(...)` callbacks unchanged. Keep the long explanatory comments from the old block where they still apply.

```ts
    for (const { frameIndex, role } of prefix.frames) {
      const entStakes = roleStakes[role]!;
      const entityAddr = entStakes.addr.toLowerCase();
      const currentNumLevel = epTopLevelCalls[frameIndex];
      const ctx = { frameIndex, entity: role };

      if (!currentNumLevel) {
        throw collector.failed(
          EXPLORER_RULES.TRACE_ALIGNMENT,
          new RpcError(
            `missing trace into ${role} frame`,
            RpcErrorCodes.EXECUTION_REVERTED
          ),
          ctx
        );
      }

      // (Keep the existing comment block about `to` being typed `Address | null`.)
      if (currentNumLevel.to == null) {
        throw collector.failed(
          EXPLORER_RULES.TRACE_ALIGNMENT,
          new RpcError(
            `frame trace/frameIndex misalignment: frame ${frameIndex} (role ${role}) trace level has no resolvable target address`,
            RpcErrorCodes.INTERNAL_ERROR
          ),
          ctx
        );
      }
      if (currentNumLevel.to.toLowerCase() !== entityAddr) {
        throw collector.failed(
          EXPLORER_RULES.TRACE_ALIGNMENT,
          new RpcError(
            `frame trace/frameIndex misalignment: frame ${frameIndex} (role ${role}) trace level targets ${currentNumLevel.to}, expected ${entityAddr}`,
            RpcErrorCodes.INTERNAL_ERROR
          ),
          ctx
        );
      }
      collector.pass(EXPLORER_RULES.TRACE_ALIGNMENT, ctx);

      const opcodes = getOpcodesInfo(currentNumLevel);

      const access = getAccessInfo(currentNumLevel);
      // Side effect only: mutates `aggregatedAccess` in place. See its
      // declaration above for why this is a second, independent call rather
      // than reusing `access`.
      getAccessInfo(currentNumLevel, aggregatedAccess);

      if (outOfGasExists(currentNumLevel)) {
        throw collector.failed(
          EXPLORER_RULES.OUT_OF_GAS,
          new RpcError(
            `${role} internally reverts on oog`,
            RpcErrorCodes.INVALID_OPCODE
          ),
          ctx
        );
      }
      collector.pass(EXPLORER_RULES.OUT_OF_GAS, ctx);

      // Every rule below runs even after an earlier one fails, so the report
      // can show all violations. Only the FIRST violation (source order) is
      // thrown / whitelist-checked afterwards - identical to the old
      // single-try/catch behavior.
      const violations: any[] = [];
      const check = async (
        rule: ExplorerRuleId,
        fn: () => void | Promise<void>
      ): Promise<void> => {
        try {
          await fn();
          collector.pass(rule, ctx);
        } catch (err: any) {
          collector.fail(rule, err?.message ?? String(err), ctx);
          violations.push(err);
        }
      };

      await check(EXPLORER_RULES.BANNED_OPCODE, () => {
        // `opcodes` keys are ethrex's native decimal opcode-byte strings
        // (e.g. `"241"` for CALL/0xf1) - see FrameCallTraceFrame.usedOpcodes'
        // doc comment (ethrexFrameTx.ts). `EVM_OPCODES` (packages/params) is
        // indexed by hex string, so every lookup here converts first.
        Object.keys(opcodes).forEach((opcode) => {
          const opcodeName = EVM_OPCODES["0x" + Number(opcode).toString(16)];
          if (bannedOpCodes.has(opcodeName)) {
            if (
              (opcodeName === "BALANCE" || opcodeName === "SELFBALANCE") &&
              BigInt(entStakes.stake) > this.networkConfig.minStake
            ) {
              return;
            }
            throw new RpcError(
              `${role} uses banned opcode: ${opcodeName}`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        });
      });

      await check(EXPLORER_RULES.CREATE, () => {
        if (role !== "factory" && opcodes[String(0xf0)] > 0) {
          throw new RpcError(
            `${role} uses banned opcode: CREATE`,
            RpcErrorCodes.INVALID_OPCODE
          );
        }

        // Special case for CREATE2
        if (role === "factory") {
          if (opcodes[String(0xf5)] > 1) {
            throw new RpcError(
              `${role} with too many CREATE2`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        } else {
          if (opcodes[String(0xf5)] > 0) {
            throw new RpcError(
              `${role} uses banned opcode: CREATE2`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        }
      });

      await check(EXPLORER_RULES.STORAGE, async () => {
        for (const [
          addr,
          { reads, writes, transientReads, transientWrites },
        ] of Object.entries(access)) {
          if (addr === sender) {
            continue;
          }

          if (addr === entryPoint) {
            continue;
          }

          let requireStakeSlot: string | undefined;
          for (const slot of [
            ...Object.keys(writes),
            ...Object.keys(reads),
            ...Object.keys(transientReads),
            ...Object.keys(transientWrites),
          ]) {
            if (isSlotAssociatedWith(slot, sender, entitySlots)) {
              if (hasFactory) {
                const stake = await this.checkStakeCached(
                  roleStakes.factory!,
                  stakeCheckCache
                );
                if (!(entityAddr === sender && stake.code === 0)) {
                  requireStakeSlot = slot;
                }
              }
            } else if (isSlotAssociatedWith(slot, entityAddr, entitySlots)) {
              requireStakeSlot = slot;
            } else if (addr === entityAddr) {
              requireStakeSlot = slot;
            } else if (writes[slot] == null) {
              requireStakeSlot = slot;
            } else {
              const readWrite = Object.keys(writes).includes(addr)
                ? "write to"
                : "read from";
              throw new RpcError(
                `${role} has forbidden ${readWrite} ${nameAddr(addr)} slot ${slot}`,
                RpcErrorCodes.INVALID_OPCODE,
                {
                  [role]: entStakes.addr,
                  accessed: addr,
                }
              );
            }
          }

          if (requireStakeSlot != null) {
            const stake = await this.checkStakeCached(
              entStakes,
              stakeCheckCache
            );
            if (stake.code != 0) {
              throw new RpcError(
                `unstaked ${role} accessed ${nameAddr(addr)} slot ${requireStakeSlot}`,
                RpcErrorCodes.INVALID_OPCODE,
                {
                  [role]: entStakes.addr,
                  accessed: addr,
                }
              );
            }
          }
        }
      });

      await check(EXPLORER_RULES.CODE_ACCESS, () => {
        const contractSizes = getContractSizes(currentNumLevel, {});
        for (const addr of Object.keys(contractSizes)) {
          if (
            addr !== sender &&
            contractSizes[addr].contractSize <= 2 &&
            !this.networkConfig.precompiles.includes(addr.toLowerCase())
          ) {
            const { opcode } = contractSizes[addr];
            throw new RpcError(
              `${role} accesses un-deployed contract address ${addr} with opcode ${
                EVM_OPCODES["0x" + Number(opcode).toString(16)]
              }`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        }
      });

      await check(EXPLORER_RULES.ENTRYPOINT_ACCESS, () => {
        const extCodeAccessInfos = getExtCodeAccessInfos(currentNumLevel, []);
        for (const addr of extCodeAccessInfos) {
          if (addr === entryPoint) {
            throw new RpcError(
              `${role} accesses EntryPoint contract address ${addr}`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        }
      });

      if (violations.length === 0) continue;

      // Handle the first violation exactly as the old `catch (err)` did.
      const err = violations[0];
      if (err instanceof RpcError) {
        const accessed = err?.data?.accessed;
        const externalEntities =
          this.networkConfig.whitelistedEntities.external;
        if (
          accessed &&
          externalEntities != null &&
          externalEntities.some(
            (entity: any) => getAddress(entity) === getAddress(accessed)
          )
        ) {
          satisfiesStandardMempool = this.networkConfig
            .relayOpsWithWhitelistedEntities
            ? true
            : false;
          this.logger.debug(
            `${err.message}; ${accessed} is in whitelist. Skipping opcode validation...`
          );
          collector.waive(ctx, "whitelisted external entity");
          continue;
        }
        if (accessed && err?.data && typeof err.data === "object") {
          delete (err.data as any).accessed;
        }
      }
      // check whitelisted senders, payers & factories
      const whitelist =
        this.networkConfig.whitelistedEntities[roleToWhitelistKey[role]];
      if (
        entityAddr &&
        whitelist != null &&
        whitelist.some(
          (addr: any) => getAddress(addr) === getAddress(entityAddr)
        )
      ) {
        satisfiesStandardMempool = this.networkConfig
          .relayOpsWithWhitelistedEntities
          ? true
          : false;
        this.logger.debug(
          `${role} is in whitelist. Skipping opcode validation...`
        );
        collector.waive(ctx, "whitelisted entity");
        continue;
      }

      // if entity is not whitelisted, bubble up the error
      throw err;
    }
```

The rule bodies above are the existing code, moved verbatim into `check(...)` callbacks; only their surroundings changed. Compare against the old block with `git diff` and confirm no rule logic differs. Two details to preserve: the storage loop's `continue` statements still work inside the callback's `for...of`, and `requireStakeSlot` stays local to that loop.

- [ ] **Step 4: Run to verify all pass**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/UserOpValidation`
Expected: PASS (frameTx: 13 original + 6 + 5 = 24; other UserOpValidation tests unchanged). If an ORIGINAL test now fails, the moved code changed behavior; fix the move, do not edit the test.

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src/services/UserOpValidation/validators/frameTx.ts packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts
git commit -m "$(cat <<'EOF'
feat(executor): validator reports per-entity rule verdicts and whitelist waivers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 6: Record admissions in `Eth.sendFrameTransaction`

**Files:**
- Modify: `packages/executor/src/services/FrameTxSimulationService/index.ts` (the file that defines `simulate`; if the class lives in a differently named file in that folder, edit that file)
- Modify: `packages/executor/src/services/MempoolService/service.ts` (`addFrameTx` return value)
- Modify: `packages/executor/src/modules/eth.ts`
- Test: `packages/executor/test/modules/eth.test.ts` (extend `buildEth`, append tests)
- Test: `packages/executor/test/services/MempoolService/addFrameTx.test.ts` (new)

**Interfaces:**
- Consumes: `CheckCollector`, `ExplorerService`, `EXPLORER_RULES`, `AdmissionSource`.
- Produces:
  - `FrameTxSimulationService.simulate(tx, collector?: CheckCollector)`
  - `MempoolService.addFrameTx(...)` now resolves `{ replacedTxHash?: string }`
  - `Eth.sendFrameTransaction(tx: FrameTransaction, source?: AdmissionSource): Promise<Hex>` (default `"rpc"`)
  - `Eth` constructor gains an 11th optional parameter `explorer?: ExplorerService`.

- [ ] **Step 1: Write the failing tests**

`packages/executor/test/services/MempoolService/addFrameTx.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;

function memoryDb() {
  const m = new Map<string, any>();
  return {
    get: async (k: string) => {
      if (!m.has(k)) throw new Error("Not Found");
      return m.get(k);
    },
    put: async (k: string, v: any) => {
      m.set(k, v);
    },
    del: async (k: string) => {
      m.delete(k);
    },
    getMany: async (ks: string[]) => ks.map((k) => m.get(k)).filter(Boolean),
  } as any;
}

const txWithFee = (maxFee: bigint): FrameTransaction => ({
  chainId: 1n,
  nonce: 0n,
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
  fees: { maxPriorityFeePerGas: maxFee, maxFeePerGas: maxFee, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
});

describe("MempoolService.addFrameTx return value", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const build = () =>
    new MempoolService(
      memoryDb(),
      1,
      {} as any,
      new ExecutorEventBus(),
      { useropsTTL: 0, archiveDuration: 1 } as any,
      { debug: vi.fn(), error: vi.fn() } as any
    );

  it("returns no replacedTxHash for a new transaction", async () => {
    const pool = build();
    const res = await pool.addFrameTx(txWithFee(2n), "0xaaa");
    expect(res.replacedTxHash).toBeUndefined();
  });

  it("returns the old transaction's hash when a newer one takes its sender:nonce slot", async () => {
    const pool = build();
    await pool.addFrameTx(txWithFee(2n), "0xaaa");
    vi.advanceTimersByTime(10); // useropsTTL is 0, so any later update may replace
    const res = await pool.addFrameTx(txWithFee(100n), "0xbbb");
    expect(res.replacedTxHash).toBe("0xaaa");
  });
});
```

In `packages/executor/test/modules/eth.test.ts`: add imports

```ts
import { ExplorerService } from "../../src/services/ExplorerService/service.js";
import { keccak256 } from "viem";
import { encodeRawFrameTx } from "../../src/services/FrameTxService/codec.js";
```
(check `encodeRawFrameTx`'s real export path with `grep -rn "export function encodeRawFrameTx" packages/executor/src` and use that path), then in `buildEth` add `explorer: ExplorerService;` to the `overrides` type and pass it as the 11th constructor argument:

```ts
  return new Eth(
    1337,
    {} as any, // publicClient
    frameTxSimulationService,
    receiptService,
    mempoolService,
    skandhaModule,
    config,
    logger,
    null,
    undefined, // getNodeAPI: use the default
    overrides.explorer
  );
```

Append:

```ts
describe("Eth.sendFrameTransaction explorer recording", () => {
  const frameTx = (limit = 1n): FrameTransaction =>
    ({
      chainId: 1337n,
      nonce: 0n,
      sender: "0x1111111111111111111111111111111111111111",
      frames: [
        {
          mode: 1,
          flags: 3,
          target: null,
          limits: { execution: limit, state: 0n },
          value: 0n,
          data: "0x",
        },
      ],
      signatures: [],
      fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
      blobVersionedHashes: [],
    }) as unknown as FrameTransaction;
  const hashOf = (tx: FrameTransaction) => keccak256(encodeRawFrameTx(tx));

  it("records an accepted admission with the given source", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({ explorer });
    const tx = frameTx();
    await eth.sendFrameTransaction(tx, "gossip:peerA");
    expect(explorer.getAdmission(hashOf(tx))).toMatchObject({
      outcome: "accepted",
      source: "gossip:peerA",
    });
  });

  it("defaults the source to rpc", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({ explorer });
    const tx = frameTx();
    await eth.sendFrameTransaction(tx);
    expect(explorer.getAdmission(hashOf(tx))?.source).toBe("rpc");
  });

  it("records a rejected admission with the failing rule when simulation rejects", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({
      explorer,
      frameTxSimulationService: {
        simulate: vi.fn().mockRejectedValue(new RpcError("frame transaction simulation failed", -32502)),
      },
    });
    const tx = frameTx();
    await expect(eth.sendFrameTransaction(tx)).rejects.toThrow("frame transaction simulation failed");
    const rec = explorer.getAdmission(hashOf(tx));
    expect(rec).toMatchObject({ outcome: "rejected", errorCode: -32502 });
    // simulate() was mocked, so no validator rule claimed the failure:
    expect(rec?.checks.find((c) => c.verdict === "fail")).toMatchObject({
      rule: "admission",
      detail: "frame transaction simulation failed",
    });
    expect(explorer.getEvents(hashOf(tx))).toEqual([
      expect.objectContaining({ kind: "rejected", reason: "frame transaction simulation failed" }),
    ]);
  });

  it("records a failed 'gas-limit' check when the transaction's limits are too high", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({ explorer });
    const tx = frameTx(30_000_000n); // config.userOpGasLimit is 25_000_000
    await expect(eth.sendFrameTransaction(tx)).rejects.toThrow("gas limit is too high");
    expect(explorer.getAdmission(hashOf(tx))?.checks).toContainEqual(
      expect.objectContaining({ rule: "gas-limit", verdict: "fail" })
    );
  });

  it("records a failed 'mempool' check when the mempool refuses the transaction", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({
      explorer,
      mempoolService: {
        validateFrameTxReplaceability: vi
          .fn()
          .mockRejectedValue(new RpcError("Frame transaction cannot be replaced: fee too low", -32602)),
      },
    });
    const tx = frameTx();
    await expect(eth.sendFrameTransaction(tx)).rejects.toThrow("fee too low");
    expect(explorer.getAdmission(hashOf(tx))?.checks).toContainEqual(
      expect.objectContaining({ rule: "mempool", verdict: "fail" })
    );
  });

  it("marks the old transaction replaced when addFrameTx reports a replacement", async () => {
    const explorer = new ExplorerService();
    const oldTx = { ...frameTx(), nonce: 7n } as FrameTransaction;
    explorer.recordAdmission({
      tx: oldTx,
      txHash: "0xold",
      source: "rpc",
      outcome: "accepted",
      checks: [],
    });
    const eth = buildEth({
      explorer,
      mempoolService: { addFrameTx: vi.fn().mockResolvedValue({ replacedTxHash: "0xold" }) },
    });
    const tx = frameTx();
    await eth.sendFrameTransaction(tx);
    expect(explorer.getAdmission("0xold")?.outcome).toBe("replaced");
    expect(explorer.getAdmission(hashOf(tx))?.outcome).toBe("accepted");
  });

  it("does not let a duplicate resubmission's rejection overwrite the accepted record", async () => {
    const explorer = new ExplorerService();
    const tx = frameTx();
    await buildEth({ explorer }).sendFrameTransaction(tx); // accepted
    const failing = buildEth({
      explorer,
      mempoolService: {
        validateFrameTxReplaceability: vi
          .fn()
          .mockRejectedValue(new RpcError("Frame transaction cannot be replaced: fee too low", -32602)),
      },
    });
    await expect(failing.sendFrameTransaction(tx)).rejects.toThrow();
    expect(explorer.getAdmission(hashOf(tx))?.outcome).toBe("accepted");
  });

  it("records nothing and behaves as before when no explorer is configured", async () => {
    const eth = buildEth();
    await expect(eth.sendFrameTransaction(frameTx())).resolves.toMatch(/^0x/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/modules/eth.test.ts test/services/MempoolService/addFrameTx.test.ts`
Expected: the new tests FAIL (`replacedTxHash` undefined / nothing recorded); the pre-existing eth tests still pass.

- [ ] **Step 3: Implement `addFrameTx` return value**

In `MempoolService.addFrameTx` (`service.ts`): change the return type to `Promise<{ replacedTxHash?: string }>`, declare `let replacedTxHash: string | undefined;` before `await this.mutex.runExclusive(...)`, set it in the replacement branch, and return after the mutex block:

```ts
    let replacedTxHash: string | undefined;
    await this.mutex.runExclusive(async () => {
      const existingEntry = await this.find(entry);
      if (existingEntry) {
        await this.validateReplaceability(entry, existingEntry);
        // ...existing body unchanged...
        if (existingEntry.txHash) {
          await this.removeFrameTxHash(existingEntry.txHash);
          replacedTxHash = existingEntry.txHash;
        }
        // ...rest unchanged...
      } else {
        // ...unchanged...
      }
      // ...unchanged (updateSeenStatus, eventBus.emit)...
    });
    return { replacedTxHash };
  }
```
Only the four marked edits change: the return type, the `let`, the `replacedTxHash = existingEntry.txHash;` line inside the existing `if (existingEntry.txHash)` block, and the final `return`.

- [ ] **Step 4: Implement `simulate(tx, collector?)`**

In `FrameTxSimulationService`: add imports

```ts
import { EXPLORER_RULES } from "@skandha/types/lib/explorer/index.js";
import { CheckCollector } from "../ExplorerService/checkCollector.js";
```
change the signature to `async simulate(tx: FrameTransaction, collector?: CheckCollector)`, record the ethrex-call failure, and pass the collector to `validate`:

```ts
    const result = await this.gethTracer
      .simulateFrameTransaction(rawTx, true)
      .catch((error) => {
        this.logger.error(error, "ethrex_simulateFrameTransaction failed");
        collector?.fail(
          EXPLORER_RULES.SIMULATION,
          "ethrex_simulateFrameTransaction call failed"
        );
        throw new Error("simulateFrameTransaction_failed");
      });

    const validation = await this.frameTxValidationService.validate(
      tx,
      result,
      collector
    );
```

- [ ] **Step 5: Implement the `Eth` changes**

In `eth.ts`: add imports

```ts
import { AdmissionSource, EXPLORER_RULES } from "@skandha/types/lib/explorer/index.js";
import { CheckCollector } from "../services/ExplorerService/checkCollector.js";
import { ExplorerService } from "../services/ExplorerService/service.js";
```
(`keccak256` and `encodeRawFrameTx` are already imported there.) Add the constructor parameter after `getNodeAPI`:

```ts
    private getNodeAPI: GetNodeAPI = () => null,
    private explorer?: ExplorerService
```

Rename the existing `async sendFrameTransaction(tx: FrameTransaction): Promise<Hex>` to `private async admitFrameTransaction(tx: FrameTransaction, source: AdmissionSource, collector: CheckCollector): Promise<Hex>`, and add these two methods above it (keep the existing JSDoc on the new public method):

```ts
  async sendFrameTransaction(
    tx: FrameTransaction,
    source: AdmissionSource = "rpc"
  ): Promise<Hex> {
    const collector = new CheckCollector();
    try {
      return await this.admitFrameTransaction(tx, source, collector);
    } catch (err) {
      this.recordRejection(tx, source, collector, err);
      throw err;
    }
  }

  private recordRejection(
    tx: FrameTransaction,
    source: AdmissionSource,
    collector: CheckCollector,
    err: unknown
  ): void {
    if (!this.explorer) return;
    let txHash: string;
    try {
      txHash = keccak256(encodeRawFrameTx(tx));
    } catch {
      return; // malformed transaction: nothing to key a record on
    }
    const message = err instanceof Error ? err.message : String(err);
    if (!collector.hasFailure()) {
      collector.fail(EXPLORER_RULES.ADMISSION, message);
    }
    this.explorer.recordAdmission({
      tx,
      txHash,
      source,
      outcome: "rejected",
      checks: collector.toChecks(),
      errorCode: err instanceof RpcError ? err.code : undefined,
    });
    this.explorer.recordLifecycle({ txHash, kind: "rejected", reason: message });
  }
```

Inside `admitFrameTransaction` make these four edits (everything else, including the gossip publish block, is unchanged):

(a) gas limit:
```ts
    if (totalLimitGas > BigInt(this.config.userOpGasLimit)) {
      throw collector.failed(
        EXPLORER_RULES.GAS_LIMIT,
        new RpcError(
          "Frame transaction's gas limit is too high",
          RpcErrorCodes.INVALID_USEROP
        )
      );
    }
    collector.pass(EXPLORER_RULES.GAS_LIMIT);
```
(b) `const { validation } = await this.frameTxSimulationService.simulate(tx, collector);`

(c) replace
```ts
    await this.mempoolService.validateFrameTxReplaceability(tx);

    // `roleStakes` came from ...(keep this comment)
    await this.mempoolService.addFrameTx(
      tx,
      txHash,
      undefined,
      validation.roleStakes.sender,
      validation.roleStakes.factory,
      validation.roleStakes.payer
    );
    this.logger.debug("Saved in mempool");
```
with
```ts
    let replacedTxHash: string | undefined;
    try {
      await this.mempoolService.validateFrameTxReplaceability(tx);

      // `roleStakes` came from ...(keep this comment)
      const added = await this.mempoolService.addFrameTx(
        tx,
        txHash,
        undefined,
        validation.roleStakes.sender,
        validation.roleStakes.factory,
        validation.roleStakes.payer
      );
      replacedTxHash = added?.replacedTxHash;
    } catch (err) {
      throw collector.failed(
        EXPLORER_RULES.MEMPOOL,
        err instanceof Error ? err : new Error(String(err))
      );
    }
    collector.pass(EXPLORER_RULES.MEMPOOL);
    this.logger.debug("Saved in mempool");

    if (this.explorer) {
      this.explorer.recordAdmission({
        tx,
        txHash,
        source,
        outcome: "accepted",
        checks: collector.toChecks(),
      });
      if (replacedTxHash) {
        this.explorer.markReplaced(replacedTxHash, txHash);
      }
    }
```
(d) leave the `return txHash;` at the end as it is.

- [ ] **Step 6: Run to verify they pass**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/modules test/services/MempoolService test/services/FrameTxSimulationService test/services/UserOpValidation`
Expected: all PASS. If the `addFrameTx` replacement test fails on the fee rule, raise the replacement's fees (for example `txWithFee(1000n)`); `useropsTTL: 0` plus the 10 ms advance should already allow replacement by TTL.

- [ ] **Step 7: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src packages/executor/test/modules/eth.test.ts packages/executor/test/services/MempoolService/addFrameTx.test.ts
git commit -m "$(cat <<'EOF'
feat(executor): record admissions and rejections from sendFrameTransaction

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 7: `--explorer.enable` flag, Executor wiring, peer sources

**Files:**
- Modify: `packages/executor/src/interfaces.ts` (`ConfigOptions`)
- Modify: `packages/executor/src/config.ts`
- Modify: `packages/executor/src/executor.ts`
- Modify: `packages/node/src/network/processor/gossipHandlers.ts`
- Modify: `packages/node/src/sync/sync.ts`
- Create: `packages/cli/src/options/bundlerOptions/explorer.ts`
- Modify: `packages/cli/src/options/globalOptions.ts`
- Modify: `packages/cli/src/cmds/standalone/handler.ts`
- Modify: `packages/cli/src/cmds/node/handler.ts`
- Test: `packages/executor/test/config.test.ts` (new)

**Interfaces:**
- Produces: `Config.explorerEnabled: boolean`; `Executor.explorerService: ExplorerService | null` (non-null only when the flag is on; already attached to the event bus); `Eth` receives it; gossip and sync pass `gossip:<peerId>` / `sync:<peerId>` as the source.

- [ ] **Step 1: Write the failing test**

```ts
// packages/executor/test/config.test.ts
import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";

describe("Config.explorerEnabled", () => {
  it("is false unless the explorer option is set", () => {
    const off = new Config({ config: null, unsafeMode: false, redirectRpc: false });
    const on = new Config({
      config: null,
      unsafeMode: false,
      redirectRpc: false,
      explorer: true,
    });
    expect(off.explorerEnabled).toBe(false);
    expect(on.explorerEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/config.test.ts`
Expected: FAIL (type error or `explorerEnabled` undefined).

- [ ] **Step 3: Implement executor side**

`interfaces.ts`: add `explorer?: boolean;` to `ConfigOptions`.

`config.ts`: add the field and set it in the constructor:

```ts
  explorerEnabled: boolean;
  // in constructor:
    this.explorerEnabled = options.explorer ?? false;
```

`executor.ts`: add imports and a field, then create the service right after `this.eventBus = new ExecutorEventBus();` (and BEFORE `this.subscriptionService = ...`):

```ts
import { ExplorerService } from "./services/ExplorerService/service.js";
// field:
  // Present only when started with --explorer.enable; records admissions and lifecycle history.
  public explorerService: ExplorerService | null = null;
// in the constructor, after the eventBus line:
    if (this.config.explorerEnabled) {
      this.explorerService = new ExplorerService();
      this.explorerService.attach(this.eventBus);
      this.logger.info("[x] EXPLORER (skandha_explorer_* RPC and history)");
    }
```
and pass it as the last argument to `new Eth(...)`: after `this.getNodeApi` add `this.explorerService ?? undefined`.

- [ ] **Step 4: Implement peer sources**

`gossipHandlers.ts` (line ~78): `const txHash = await executor.eth.sendFrameTransaction(tx, \`gossip:${peerIdStr}\`);`

`sync.ts` (line ~216): `const txHash = await this.executor.eth.sendFrameTransaction(tx, \`sync:${peerId.toString()}\`);` (`peerId` is the variable already used in the `pooledFrameTxsByHash(peerId, ...)` call a few lines above).

- [ ] **Step 5: Implement the CLI flag**

`bundlerOptions/explorer.ts`:

```ts
import { ICliCommandOptions } from "../../util/index.js";

export interface IExplorerArgs {
  "explorer.enable": boolean;
}

export const options: ICliCommandOptions<IExplorerArgs> = {
  "explorer.enable": {
    type: "boolean",
    description:
      "Record admission/lifecycle history and serve the read-only skandha_explorer_* RPC methods",
    default: false,
    group: "explorer",
    demandOption: false,
  },
};
```

`globalOptions.ts`: import `IExplorerArgs` and `options as explorerOptions` from `./bundlerOptions/explorer.js`; add `& IExplorerArgs` to both `IGlobalArgs` and `IStandaloneGlobalArgs`; spread `...explorerOptions` into both `globalOptions` and `standaloneGlobalOptions`.

`standalone/handler.ts`: add `explorer: args["explorer.enable"],` to BOTH `Config.init({...})` calls.

`node/handler.ts`: add `explorer: args["explorer.enable"],` to BOTH `Config.init({...})` calls (`args` is the handler's parameter, already in scope there).

- [ ] **Step 6: Verify**

```bash
cd /Users/alexf/skandha/packages/executor && bunx vitest run test/config.test.ts
cd /Users/alexf/skandha/packages/executor && bun run build
cd /Users/alexf/skandha/packages/node && bunx tsc -p tsconfig.build.json --noEmit
```
Expected: the config test PASSES; the executor build succeeds; the node type-check succeeds with no errors. (`packages/cli` type-checks in Task 10's full build.)

- [ ] **Step 7: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src packages/executor/test/config.test.ts packages/node/src packages/cli/src
git commit -m "$(cat <<'EOF'
feat: --explorer.enable flag, executor wiring and peer admission sources

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 8: `Explorer` module (read methods)

**Files:**
- Create: `packages/executor/src/modules/explorer.ts`
- Modify: `packages/executor/src/modules/index.ts` (export it, matching the existing export style)
- Modify: `packages/executor/src/services/MempoolService/service.ts` (add `listAll`)
- Modify: `packages/executor/src/services/BundlingService/service.ts` (add `getBundlingMode`)
- Modify: `packages/executor/src/executor.ts` (construct and expose `explorer`)
- Test: `packages/executor/test/modules/explorer.test.ts`

**Interfaces:**
- Consumes: `ExplorerService` (Task 3), Task 1 types, `MempoolService`, `BundlingService.getBundlingMode()`.
- Produces: `MempoolService.listAll(): Promise<FrameTxMempoolEntry[]>`; `BundlingService.getBundlingMode(): BundlingMode`; `class Explorer` with `info(): ExplorerInfo`, `listTransactions(params?: { status?: string; cursor?: string; limit?: number }): Promise<Page<ExplorerTransactionSummary>>`, `listAdmissions(params?: { outcome?: AdmissionOutcome; cursor?: string; limit?: number }): Page<AdmissionRecord>`, `getTransaction(hash: string): Promise<ExplorerTransactionDetail>`, `peers(): ExplorerPeer[]`; `Executor.explorer: Explorer`. Every method throws `RpcError(..., METHOD_NOT_FOUND)` when the service is null.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/executor/test/modules/explorer.test.ts
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
  nonce,
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
});

const entry = (n: number, status = MempoolEntryStatus.New, submittedTime = n * 10) =>
  new FrameTxMempoolEntry(tx(BigInt(n)), { txHash: H(n), status, submittedTime });

function build(opts: {
  service?: ExplorerService | null;
  entries?: FrameTxMempoolEntry[];
  peers?: unknown[] | null;
} = {}) {
  const service = opts.service === undefined ? new ExplorerService() : opts.service;
  const entries = opts.entries ?? [];
  const mempool = {
    listAll: vi.fn().mockResolvedValue(entries),
    getEntryByHash: vi.fn(async (h: string) => entries.find((e) => e.txHash === h) ?? null),
  } as any;
  const module = new Explorer(
    1337,
    { version: "1.2.3", commit: "abc" },
    { getBundlingMode: () => "auto" } as any,
    mempool,
    service,
    () => (opts.peers === null ? null : ({ getConnectedPeers: () => opts.peers ?? [] } as any))
  );
  return { module, service, mempool };
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
      });
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
      expect(detail.entry?.tx).toMatchObject({ nonce: "0x1", sender: SENDER });
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/modules/explorer.test.ts`
Expected: FAIL, cannot resolve `modules/explorer.js`.

- [ ] **Step 3: Implement supporting getters**

`MempoolService`: add next to `dump()`:

```ts
  /** Every stored entry, including archived (`OnChain`+) ones. */
  async listAll(): Promise<MempoolEntry[]> {
    return this.fetchAll();
  }
```

`BundlingService` (`service.ts`, next to `setBundlingMode`):

```ts
  getBundlingMode(): BundlingMode {
    return this.bundlingMode;
  }
```

- [ ] **Step 4: Implement the module**

```ts
// packages/executor/src/modules/explorer.ts
import { isHex, toHex } from "viem";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { BundlingMode } from "@skandha/types/lib/api/interfaces";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { SkandhaVersion } from "@skandha/types/lib/executor/index.js";
import {
  AdmissionOutcome,
  AdmissionRecord,
  EXPLORER_PROTOCOL_VERSION,
  ExplorerInfo,
  ExplorerPeer,
  ExplorerTransactionDetail,
  ExplorerTransactionSummary,
  Page,
} from "@skandha/types/lib/explorer/index.js";
import { FrameTxMempoolEntry } from "../entities/FrameTxMempoolEntry.js";
import { GetNodeAPI } from "../interfaces.js";
import { MempoolService } from "../services/MempoolService/service.js";
import { ExplorerService } from "../services/ExplorerService/service.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const OUTCOMES: AdmissionOutcome[] = ["accepted", "rejected", "replaced"];

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

function invalid(message: string): RpcError {
  return new RpcError(message, RpcErrorCodes.INVALID_REQUEST);
}

/**
 * Read-only explorer RPC surface (`skandha_explorer_*`). Every method is
 * unavailable (METHOD_NOT_FOUND) unless the node was started with
 * `--explorer.enable`, which is what supplies `explorerService`.
 *
 * Results are plain JSON: numbers stay numbers, quantities that can exceed
 * 2^53 are `0x` hex strings. The API layer must not `deepHexlify` them.
 */
export class Explorer {
  constructor(
    private chainId: number,
    private version: SkandhaVersion,
    private bundlingService: { getBundlingMode(): BundlingMode },
    private mempoolService: Pick<MempoolService, "listAll" | "getEntryByHash">,
    private explorerService: ExplorerService | null,
    private getNodeAPI: GetNodeAPI
  ) {}

  private service(): ExplorerService {
    if (!this.explorerService) {
      throw new RpcError(
        "Explorer is disabled: start the node with --explorer.enable",
        RpcErrorCodes.METHOD_NOT_FOUND
      );
    }
    return this.explorerService;
  }

  info(): ExplorerInfo {
    const service = this.service();
    return {
      protocolVersion: EXPLORER_PROTOCOL_VERSION,
      chainId: this.chainId,
      version: this.version.version,
      commit: this.version.commit,
      bundlingMode: this.bundlingService.getBundlingMode(),
      p2pEnabled: this.getNodeAPI() != null,
      latestSeq: service.latestSeq(),
      oldestSeq: service.oldestSeq(),
      historyCapacity: service.historyCapacity,
    };
  }

  async listTransactions(
    params: { status?: string; cursor?: string; limit?: number } = {}
  ): Promise<Page<ExplorerTransactionSummary>> {
    this.service();
    let wanted: MempoolEntryStatus | undefined;
    if (params.status !== undefined) {
      wanted = MempoolEntryStatus[params.status as keyof typeof MempoolEntryStatus];
      if (typeof wanted !== "number") {
        throw invalid(`Unknown status: ${params.status}`);
      }
    }
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    if (!Number.isInteger(offset) || offset < 0) {
      throw invalid(`Invalid cursor: ${params.cursor}`);
    }
    const limit = clampLimit(params.limit);

    const entries = (await this.mempoolService.listAll())
      .filter((e) => wanted === undefined || e.status === wanted)
      .sort(
        (a, b) =>
          (b.submittedTime ?? b.lastUpdatedTime) -
          (a.submittedTime ?? a.lastUpdatedTime)
      );
    const items = entries.slice(offset, offset + limit).map((e) => this.summary(e));
    return offset + limit < entries.length
      ? { items, nextCursor: String(offset + limit) }
      : { items };
  }

  listAdmissions(
    params: { outcome?: AdmissionOutcome; cursor?: string; limit?: number } = {}
  ): Page<AdmissionRecord> {
    const service = this.service();
    if (params.outcome !== undefined && !OUTCOMES.includes(params.outcome)) {
      throw invalid(`Unknown outcome: ${params.outcome}`);
    }
    if (params.cursor !== undefined && !Number.isFinite(Number(params.cursor))) {
      throw invalid(`Invalid cursor: ${params.cursor}`);
    }
    return service.listAdmissions({
      outcome: params.outcome,
      cursor: params.cursor,
      limit: clampLimit(params.limit),
    });
  }

  async getTransaction(hash: string): Promise<ExplorerTransactionDetail> {
    const service = this.service();
    if (typeof hash !== "string" || !isHex(hash, { strict: true }) || hash.length !== 66) {
      throw invalid("Expected a 32-byte hex transaction hash");
    }
    const normalized = hash.toLowerCase();
    const entry = await this.mempoolService.getEntryByHash(normalized);
    const admission = service.getAdmission(normalized) ?? null;
    const events = service.getEvents(normalized);
    if (!entry && !admission && events.length === 0) {
      throw invalid("Frame transaction not found");
    }
    return {
      hash: normalized,
      entry: entry
        ? {
            ...this.summary(entry),
            tx: entry.serialize().tx as unknown as Record<string, unknown>,
            revertReason: entry.revertReason,
            transaction: entry.actualTransaction ?? entry.transaction,
          }
        : null,
      admission,
      events,
    };
  }

  peers(): ExplorerPeer[] {
    this.service();
    const nodeApi = this.getNodeAPI();
    if (!nodeApi) return [];
    return nodeApi.getConnectedPeers().map((raw) => {
      const p = raw as Record<string, any>;
      return {
        peerId: String(p.peerId),
        direction: typeof p.direction === "string" ? p.direction : "unknown",
        connectedAt: Number(p.connectedUnixTsMs ?? 0),
        lastReceivedAt: Number(p.lastReceivedMsgUnixTsMs ?? 0),
        agentVersion: p.agentVersion ?? null,
        supportedMempools: Array.isArray(p.metadata?.supported_mempools)
          ? p.metadata.supported_mempools.map(String)
          : [],
      };
    });
  }

  private summary(entry: FrameTxMempoolEntry): ExplorerTransactionSummary {
    return {
      txHash: entry.txHash ?? "",
      sender: entry.sender,
      payer: entry.payer,
      factory: entry.factory,
      nonce: toHex(entry.tx.nonce),
      status: MempoolEntryStatus[entry.status],
      frames: entry.tx.frames.length,
      maxFeePerGas: toHex(entry.tx.fees.maxFeePerGas),
      submittedTime: entry.submittedTime,
      lastUpdatedTime: entry.lastUpdatedTime,
    };
  }
}
```

`modules/index.ts`: add `export * from "./explorer.js";` (match the file's existing export style).

`executor.ts`: add `import { Explorer } from "./modules/explorer.js";`, a field `public explorer: Explorer;`, and after `this.eth = new Eth(...)`:

```ts
    this.explorer = new Explorer(
      this.chainId,
      this.version,
      this.bundlingService,
      this.mempoolService,
      this.explorerService,
      this.getNodeApi
    );
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/modules/explorer.test.ts`
Expected: PASS. In "accepts an upper-case hash", the mempool fake matches on the lower-cased hash, so it also proves the module lower-cases before lookup. `H(10)` contains only digits and `a`, so `.toUpperCase()` really changes the string.

- [ ] **Step 6: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src packages/executor/test/modules/explorer.test.ts
git commit -m "$(cat <<'EOF'
feat(executor): read-only Explorer module for skandha_explorer_* methods

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 9: API dispatch and the resumable `explorerEvents` stream

**Files:**
- Modify: `packages/executor/src/services/SubscriptionService.ts`
- Modify: `packages/executor/src/executor.ts` (pass `explorerService` to `SubscriptionService`)
- Modify: `packages/api/src/constants.ts`
- Create: `packages/api/src/modules/explorer.ts`
- Modify: `packages/api/src/modules/index.ts`
- Modify: `packages/api/src/modules/subscription.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/executor/test/services/SubscriptionService.test.ts` (new)

**Interfaces:**
- Consumes: `ExplorerService.onEvent/eventsSince` (Task 3), `Executor.explorer` (Task 8).
- Produces:
  - `ExecutorEvent.explorerEvents = "explorerEvents"`
  - `new SubscriptionService(eventBus, logger, explorerService?: ExplorerService | null)`
  - `SubscriptionService.listenExplorerEvents(socket, sinceSeq?: number): string`
  - `SubscriptionApi.subscribe(socket, event, sinceSeq?: number)`
  - RPC methods `skandha_explorer_info`, `skandha_explorer_listTransactions`, `skandha_explorer_listAdmissions`, `skandha_explorer_getTransaction`, `skandha_explorer_peers`, all returned WITHOUT `deepHexlify`.
  - WS: `skandha_subscribe` with params `["explorerEvents", sinceSeq?]`. Messages use the existing envelope `{ jsonrpc, method: "skandha_subscription", params: { subscription, result: LifecycleEvent } }`, with `result` as plain JSON.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/executor/test/services/SubscriptionService.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  ExecutorEventBus,
  SubscriptionService,
} from "../../src/services/SubscriptionService.js";
import { ExplorerService } from "../../src/services/ExplorerService/service.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";

const logger = { debug: vi.fn(), error: vi.fn() } as any;
const socket = () => ({ readyState: 1, send: vi.fn() }) as any;
const nextTick = () => new Promise((r) => setImmediate(r));
const sent = (s: any) => s.send.mock.calls.map(([m]: [string]) => JSON.parse(m));

describe("SubscriptionService explorerEvents", () => {
  it("refuses to subscribe when the explorer is disabled", () => {
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, null);
    let error: any;
    try {
      svc.listenExplorerEvents(socket());
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: RpcErrorCodes.METHOD_NOT_FOUND });
  });

  it("delivers live events as plain JSON (numbers are not hexlified)", async () => {
    const explorer = new ExplorerService(100, () => 1700000000000);
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    const id = svc.listenExplorerEvents(s);
    await nextTick();

    explorer.recordLifecycle({ txHash: "0xaa", kind: "admitted", status: "New" });

    expect(sent(s)).toEqual([
      {
        jsonrpc: "2.0",
        method: "skandha_subscription",
        params: {
          subscription: id,
          result: { seq: 1, txHash: "0xaa", at: 1700000000000, kind: "admitted", status: "New" },
        },
      },
    ]);
  });

  it("replays events after sinceSeq first, then continues live, with no gap or duplicate", async () => {
    const explorer = new ExplorerService();
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" }); // seq 1
    explorer.recordLifecycle({ txHash: "0x2", kind: "admitted" }); // seq 2
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    svc.listenExplorerEvents(s, 1);
    // recorded between subscribe and the replay tick: must arrive exactly once
    explorer.recordLifecycle({ txHash: "0x3", kind: "admitted" }); // seq 3
    await nextTick();
    explorer.recordLifecycle({ txHash: "0x4", kind: "admitted" }); // seq 4

    expect(sent(s).map((m: any) => m.params.result.seq)).toEqual([2, 3, 4]);
  });

  it("sends only live events when no sinceSeq is given", async () => {
    const explorer = new ExplorerService();
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" });
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    svc.listenExplorerEvents(s);
    await nextTick();
    explorer.recordLifecycle({ txHash: "0x2", kind: "admitted" });
    expect(sent(s).map((m: any) => m.params.result.seq)).toEqual([2]);
  });

  it("stops delivering after unsubscribe, including when it happens before the replay tick", async () => {
    const explorer = new ExplorerService();
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" });
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    const id = svc.listenExplorerEvents(s, 0);
    svc.unsubscribe(s, id);
    await nextTick();
    explorer.recordLifecycle({ txHash: "0x2", kind: "admitted" });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("does not deliver to a closed socket", async () => {
    const explorer = new ExplorerService();
    const svc = new SubscriptionService(new ExecutorEventBus(), logger, explorer);
    const s = socket();
    svc.listenExplorerEvents(s);
    await nextTick();
    s.readyState = 3; // CLOSED
    explorer.recordLifecycle({ txHash: "0x1", kind: "admitted" });
    expect(s.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/SubscriptionService.test.ts`
Expected: FAIL (`listenExplorerEvents` is not a function).

- [ ] **Step 3: Implement the stream in `SubscriptionService`**

At the top add `import type { ExplorerService } from "./ExplorerService/service.js";` (`import type` avoids a runtime import cycle, since `ExplorerService` imports `ExecutorEvent` from this file), `import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";`, `import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";` and `import type { LifecycleEvent } from "@skandha/types/lib/explorer/index.js";`.

Add the enum member and the `events` record entry:

```ts
export enum ExecutorEvent {
  // ...existing members...
  ping = "ping",
  explorerEvents = "explorerEvents", // lifecycle events from ExplorerService
}
// in the `events` field initializer:
    [ExecutorEvent.explorerEvents]: new Set(),
```
(Do NOT add it to the `ExecutorEvents` map or the event bus; it is fed by `ExplorerService.onEvent`, not the bus.)

Constructor and methods:

```ts
  constructor(
    private eventBus: ExecutorEventBus,
    private logger: Logger,
    private explorerService: ExplorerService | null = null
  ) {
    // ...existing eventBus.on(...) calls unchanged...
    this.explorerService?.onEvent((event) => this.onExplorerEvent(event));
  }

  /**
   * `sinceSeq` given: replay every retained event with a greater `seq`, then
   * continue live. Omitted: live events only.
   *
   * Registration and replay happen on the next tick because `app.ts` sends the
   * subscribe response synchronously after this returns; the client therefore
   * learns its subscription id before any event carrying it arrives. Anything
   * recorded in between is picked up by the replay, so nothing is lost or
   * duplicated.
   */
  listenExplorerEvents(socket: WebSocket, sinceSeq?: number): string {
    const explorer = this.explorerService;
    if (!explorer) {
      throw new RpcError(
        "Explorer is disabled: start the node with --explorer.enable",
        RpcErrorCodes.METHOD_NOT_FOUND
      );
    }
    const id = this.generateEventId();
    this.listeners[id] = socket;
    setImmediate(() => {
      if (this.listeners[id] !== socket) return; // unsubscribed in the meantime
      if (sinceSeq !== undefined) {
        for (const event of explorer.eventsSince(sinceSeq, Number.MAX_SAFE_INTEGER)) {
          this.sendExplorerEvent(id, event);
        }
      }
      this.events[ExecutorEvent.explorerEvents].add(id);
    });
    this.logger.debug(`${id} subscribed for ${ExecutorEvent.explorerEvents}`);
    return id;
  }

  private onExplorerEvent(event: LifecycleEvent): void {
    for (const id of [...this.events[ExecutorEvent.explorerEvents]]) {
      this.sendExplorerEvent(id, event);
    }
  }

  // Explorer events are plain JSON: deliberately NOT passed through deepHexlify.
  private sendExplorerEvent(id: string, event: LifecycleEvent): void {
    const socket = this.listeners[id];
    if (!socket) return;
    if (
      socket.readyState === WebSocket.CLOSED ||
      socket.readyState === WebSocket.CLOSING
    ) {
      this.unsubscribe(socket, id);
      return;
    }
    try {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "skandha_subscription",
          params: { subscription: id, result: event },
        })
      );
    } catch (err) {
      this.logger.error(err, `Could not send explorer event. Id: ${id}`);
    }
  }
```

`executor.ts`: pass it in: `new SubscriptionService(this.eventBus, this.logger, this.explorerService)`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/alexf/skandha/packages/executor && bunx vitest run test/services/SubscriptionService.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Implement the API layer**

`api/src/constants.ts`: add to `CustomRPCMethods`:

```ts
  skandha_explorer_info: "skandha_explorer_info",
  skandha_explorer_listTransactions: "skandha_explorer_listTransactions",
  skandha_explorer_listAdmissions: "skandha_explorer_listAdmissions",
  skandha_explorer_getTransaction: "skandha_explorer_getTransaction",
  skandha_explorer_peers: "skandha_explorer_peers",
```

`api/src/modules/explorer.ts`:

```ts
import { Explorer } from "@skandha/executor/lib/modules";
import {
  AdmissionOutcome,
  AdmissionRecord,
  ExplorerInfo,
  ExplorerPeer,
  ExplorerTransactionDetail,
  ExplorerTransactionSummary,
  Page,
} from "@skandha/types/lib/explorer/index.js";

/** Thin wrapper over the executor's read-only `Explorer` module. */
export class ExplorerAPI {
  constructor(private explorer: Explorer) {}

  info(): ExplorerInfo {
    return this.explorer.info();
  }

  listTransactions(params?: {
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ExplorerTransactionSummary>> {
    return this.explorer.listTransactions(params ?? {});
  }

  listAdmissions(params?: {
    outcome?: AdmissionOutcome;
    cursor?: string;
    limit?: number;
  }): Page<AdmissionRecord> {
    return this.explorer.listAdmissions(params ?? {});
  }

  getTransaction(hash: string): Promise<ExplorerTransactionDetail> {
    return this.explorer.getTransaction(hash);
  }

  peers(): ExplorerPeer[] {
    return this.explorer.peers();
  }
}
```

`modules/index.ts`: add `export * from "./explorer.js";` (match style).

`modules/subscription.ts`: change the signature and add the case:

```ts
  subscribe(socket: WebSocket, event: ExecutorEvent, sinceSeq?: number): string {
    switch (event) {
      // ...existing cases...
      case ExecutorEvent.explorerEvents: {
        return this.subscriptionService.listenExplorerEvents(
          socket,
          typeof sinceSeq === "number" ? sinceSeq : undefined
        );
      }
```

`app.ts`: import `ExplorerAPI` alongside the other module imports; add `private explorerApi: ExplorerAPI;` and in the constructor `this.explorerApi = new ExplorerAPI(this.executor.explorer);`; in `handleWsRequest` change the subscribe call to `this.subscriptionApi.subscribe(socket, params[0], params[1])`; and in `handleRpcRequest`'s `switch (method)` inside `if (!result)`, next to `skandha_config`, add (each returns before the `deepHexlify` line, like `skandha_config`):

```ts
        case CustomRPCMethods.skandha_explorer_info:
          return { jsonrpc, id, result: this.explorerApi.info() };
        case CustomRPCMethods.skandha_explorer_listTransactions:
          return {
            jsonrpc,
            id,
            result: await this.explorerApi.listTransactions(params?.[0]),
          };
        case CustomRPCMethods.skandha_explorer_listAdmissions:
          return {
            jsonrpc,
            id,
            result: this.explorerApi.listAdmissions(params?.[0]),
          };
        case CustomRPCMethods.skandha_explorer_getTransaction:
          return {
            jsonrpc,
            id,
            result: await this.explorerApi.getTransaction(params?.[0]),
          };
        case CustomRPCMethods.skandha_explorer_peers:
          return { jsonrpc, id, result: this.explorerApi.peers() };
```
Add a one-line comment above the first case: `// Explorer results are plain JSON; deepHexlify would turn every number into a hex string.`

CORS needs no code change: `Server.init` already registers `@fastify/cors` with `api.cors` (default `*`), which covers `/rpc/`. Task 10's smoke test confirms it.

- [ ] **Step 6: Verify the build chain and suites**

```bash
cd /Users/alexf/skandha/packages/executor && bun run build && bunx vitest run test/modules test/services/SubscriptionService.test.ts test/services/ExplorerService
cd /Users/alexf/skandha/packages/api && bun run build
```
Expected: builds succeed; tests PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src packages/executor/test/services/SubscriptionService.test.ts packages/api/src
git commit -m "$(cat <<'EOF'
feat(api): skandha_explorer_* RPC methods and resumable explorerEvents stream

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 10: Docs, full verification and smoke test

**Files:**
- Create: `docs/sidecar_explorer.md`
- Modify: `CLAUDE.md` (two short additions)

- [ ] **Step 1: Write the RPC doc**

Create `docs/sidecar_explorer.md` in the style of the existing `docs/sidecar_subscribe.md`. It must contain:
- one paragraph on purpose, and that everything requires `--explorer.enable` (otherwise `-32601`-style "method not found"), that history is in memory and cleared on restart, and that the methods are read-only and unrelated to `debug_bundler_*`;
- the wire conventions (plain JSON, hex quantities, no hexlify);
- one section per method (`skandha_explorer_info`, `listTransactions`, `listAdmissions`, `getTransaction`, `peers`) with params, result shape (refer to the type names in `packages/types/src/explorer/index.ts`) and one request/response example each, using real output captured in Step 4 (do not invent example values);
- the stream: `skandha_subscribe` with `["explorerEvents", sinceSeq?]`, the notification envelope, resume semantics, and how to detect a gap (`sinceSeq + 1 < info.oldestSeq`);
- the rule-id table from `EXPLORER_RULES`, with one plain-language line per rule.

- [ ] **Step 2: Update CLAUDE.md**

Add to the "Key services" list, after `ReceiptService`:

```
- **`ExplorerService`** (`services/ExplorerService/`) — in-memory admission reports (`AdmissionRecord`,
  built via `CheckCollector` while `FrameTxValidationService` runs) and a bounded lifecycle event log.
  Created only with `--explorer.enable`; served read-only through `skandha_explorer_*`
  (`modules/explorer.ts`) and the `explorerEvents` stream. See `docs/sidecar_explorer.md`.
```
and add `--explorer.enable` to the "Key CLI flags" sentence.

- [ ] **Step 3: Full build and test**

```bash
cd /Users/alexf/skandha && bun run build
cd packages/executor && bunx vitest run
```
Expected: the full build succeeds (types → db → utils → params → monitoring → executor → api → node → cli). The vitest run may report the documented pre-existing failures under `test/unit/` (stale ERC-4337 fixture, see CLAUDE.md) and nothing else. Every file outside `test/unit/` passes. If anything else fails, fix it before continuing.

- [ ] **Step 4: Smoke test against a live instance**

Needs a running EIP-8141 execution client (see `P2P.md`). If no devnet is available, skip this step and say so in the hand-off; do not fake the output.

```bash
cd /Users/alexf/skandha && ./skandha standalone --explorer.enable
# in another terminal:
curl -s localhost:14337/rpc/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"skandha_explorer_info","params":[]}'
curl -si -X OPTIONS localhost:14337/rpc/ -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' | grep -i '^access-control'
# submit one valid and one invalid frame tx (see docs/sidecar_frameTransactionStatus.md for the shape), then:
curl -s localhost:14337/rpc/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"skandha_explorer_listAdmissions","params":[{"outcome":"rejected"}]}'
# and without the flag, the same info call must return a method-not-found error:
```
Expected: `info` returns `protocolVersion: 1` and numeric (not hex-string) `latestSeq`; the OPTIONS response carries `access-control-allow-origin`; the rejected transaction appears with `checks` showing the failing rule and later rules `skipped`; restarting without `--explorer.enable` makes `info` fail with method-not-found. Paste the real outputs into the examples in `docs/sidecar_explorer.md`.

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha
git add docs/sidecar_explorer.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: skandha_explorer RPC reference and CLAUDE.md notes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

## Self-Review

**Spec coverage (sub-project 1):**
- `AdmissionRecord` (identity, `at`, `source`, `outcome`, `checks[]`): Tasks 1, 3, 6.
- `LifecycleEvent` ring buffer, 10,000 default, kinds admitted/rejected/replaced/statusChanged/dropped/included: Tasks 1, 3 (`attach`), 6 (`rejected`, `replaced`).
- Validator builds `checks[]`, keeps throwing, fatal exits give one failure plus skipped rest, multi-violation in the opcode/storage section: Tasks 2, 4, 5.
- Read API with five methods, `protocolVersion`, flag gating, separate from `debug_bundler_*`: Tasks 7, 8, 9.
- Stream event with `sinceSeq`: Task 9.
- CORS: existing global `@fastify/cors` (default `*`); verified in Task 10 Step 4. No code needed.
- In-memory history: Task 3.
- Tests per validator exit path, ring bounds, `seq` ordering, method shapes: Tasks 3-5, 8, 9.
- Spec's "open item" on `@skandha/types` browser-safety: resolved by the zero-import subpath in Task 1, so the UI plan needs no new package.

**Deliberate spec deviations (amended in Task 1):** `source` adds `sync:<peerId>` (the sync path is a distinct peer source); `replaced` is set on the old record; `info` adds `latestSeq`/`oldestSeq`; explorer results skip `deepHexlify`.

**Type consistency:** `CheckCollector` methods (`pass`, `fail`, `failed`, `hasFailure`, `waive`, `toChecks`) are used with the same names in Tasks 4-6. `ExplorerService` methods (`recordAdmission`, `markReplaced`, `recordLifecycle`, `getAdmission`, `listAdmissions`, `getEvents`, `eventsSince`, `latestSeq`, `oldestSeq`, `historyCapacity`, `onEvent`, `attach`) match across Tasks 3, 6, 8, 9. `Explorer` method names match the API wrapper in Task 9. Rule ids come only from `EXPLORER_RULES`.

**Known soft spots to watch during execution:** Task 5's three moved code bodies are the riskiest edit; the 13 original validator tests are the guard. Task 6's `addFrameTx` replacement test depends on `useropsTTL: 0` plus the fake clock. Task 6 Step 1 asks the implementer to confirm the real export path of `encodeRawFrameTx` before using it in the test import.
