# Explorer Activity Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `AdmissionRecord.outcome` reflect every accepted transaction's real terminal
state (`included`/`replaced`/`dropped`, not just stuck at `accepted`), record who included
it, and keep checking cancelled/replaced-away transactions for late inclusion by a
different block builder.

**Architecture:** Five-value `AdmissionOutcome` taxonomy plus an `includer` field on
`AdmissionRecord`, populated via new `ExplorerService.markIncluded`/`markDropped` methods
that mirror the existing `markReplaced`. A new unified "late-inclusion watch list" in
`MempoolService` (same array-of-keys collection pattern the codebase already uses) keeps
cancelled/replaced-away entries checkable; a new bounded `MempoolReconciler` pass
(mirroring the existing `reconcileMinedElsewhere`) resolves them. `devnet-ui` picks up the
new outcomes and the `includer` field; a new e2e test proves the core `dropped` path
end-to-end against the real `--dev` devnet.

**Tech Stack:** TypeScript, Bun/Vitest, viem, the existing `IDbController` key-value store.

**Spec:** `docs/superpowers/specs/2026-09-30-explorer-activity-outcomes-design.md`

## Global Constraints

- `AdmissionOutcome` becomes exactly `"rejected" | "accepted" | "included" | "replaced" |
  "dropped"` — no other values.
- Once a record's outcome is `"included"`, nothing may overwrite it again (a transaction
  that's on-chain stays on-chain).
- The watch list covers both cancelled AND replaced-away entries via one mechanism, not two.
- A `Reverted` status transition counts as `included` (it has a receipt and an includer);
  `ExecutorEvent.onChainUserOps` widens to fire on `Reverted` too. `ReputationService`'s
  `updateIncludedStatus` bookkeeping stays `OnChain`-only — do NOT widen it.
- No native prefix-scan exists on `IDbController` (`packages/types/src/db/IDbController.ts`)
  — any new "enumerate a collection" logic must reuse the existing array-of-keys-under-one-key
  pattern (`MempoolService.FRAMETX_COLLECTION_KEY`'s shape).
- Watch-list GC reuses `NetworkConfig.archiveDuration` (default 86400s) and the existing
  5-minute `ARCHIVE_PURGE_INTERVAL` timer — no new config surface.
- `packages/executor` tests must be run from inside `packages/executor` (not the repo root)
  so `test/vitestSetup.ts`'s `GethTracer` mock applies: `cd packages/executor && bunx vitest run <path>`.

## Review Focus

- **Mutex reentrancy:** `addFrameTx`'s replace branch already runs inside
  `this.mutex.runExclusive(...)` (`MempoolService/service.ts:207-254`). The watch-list write
  from there MUST use an unlocked internal variant, not the mutex-wrapped public one, or it
  deadlocks. `updateStatus`'s Cancelled branch is NOT already locked, so it uses the
  mutex-wrapped variant. Getting this backwards either deadlocks or races.
- **Existing reconciliation tests break silently:** three existing tests in
  `reconciliation.test.ts` mock `getReceipt` to resolve objects with no `blockNumber` field.
  Once Task 2 makes the reconciler unconditionally fetch the including block on a
  success/reverted receipt, those mocks produce `BigInt(undefined)` (a thrown TypeError) —
  ALL of them need a `blockNumber` added, not just the new tests.
- **`updateIncludedStatus` must not widen to `Reverted`:** only the `onChainUserOps` EVENT
  emission widens to cover `Reverted`; the reputation-bookkeeping call inside the same
  `if (status === OnChain)` block must stay `OnChain`-only. Conflating the two silently
  changes reputation scoring for every reverted-but-mined transaction — a real behavior
  change nobody asked for.
- **`MAX_VERIFY_GAS` in the e2e demo:** the Canonical Paymaster prefix's two frames' combined
  `limits.execution` must stay under EIP-8141's 100,000-gas mempool-policy cap, or the
  transaction is rejected at admission and the whole scenario never reaches the cancellation
  path it's meant to demonstrate.
- **`resolveWatchedEntry` and the active store never collide:** a replaced-away entry's old
  `sender:nonce` key already holds the NEW entry by the time the watch list resolves it —
  `resolveWatchedEntry` must only ever touch the watch-list collection (keyed by txHash), never
  call `getKey`/`update` against the active store.

---

## Task 1: `AdmissionOutcome` taxonomy + `ExplorerService.markDropped`/`markIncluded`

**Files:**
- Modify: `packages/types/src/explorer/index.ts:100-124`
- Modify: `packages/executor/src/services/ExplorerService/service.ts:131-139,227-242`
- Modify: `packages/executor/src/modules/explorer.ts:28`
- Test: `packages/executor/test/services/ExplorerService/explorerService.test.ts`

**Interfaces:**
- Produces: `AdmissionOutcome = "rejected" | "accepted" | "included" | "replaced" |
  "dropped"`; `AdmissionRecord.includer?: \`0x${string}\``;
  `ExplorerService.markDropped(txHash: string, reason?: string): void`;
  `ExplorerService.markIncluded(txHash: string, includer?: \`0x${string}\`): void`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/executor/test/services/ExplorerService/explorerService.test.ts`, right
after the existing `"markReplaced() flips the old record..."` test (inside the
`describe("ExplorerService admissions", ...)` block):

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/executor && bunx vitest run test/services/ExplorerService/explorerService.test.ts`
Expected: FAIL — `svc.markDropped is not a function` / `svc.markIncluded is not a function`.

- [ ] **Step 3: Add `"included"`/`"dropped"` to `AdmissionOutcome` and `includer` to `AdmissionRecord`**

In `packages/types/src/explorer/index.ts`, replace lines 100-104:

```typescript
/**
 * `replaced` is set on the OLD transaction's record when a newer one takes its
 * `sender:nonce` slot. The new transaction's own record is `accepted`.
 * `included`/`dropped` are set once an accepted transaction resolves: `included`
 * when it lands on-chain (see `includer`), `dropped` when this bundler gave up on
 * it without it being included - which does not preclude a different block
 * builder including it later, at which point the record flips to `included`
 * after all (see `includer`'s own doc comment).
 */
export type AdmissionOutcome =
  | "rejected"
  | "accepted"
  | "included"
  | "replaced"
  | "dropped";
```

Then add `includer` to `AdmissionRecord` (after `outcome: AdmissionOutcome;` at line 116):

```typescript
  outcome: AdmissionOutcome;
  /**
   * The including block's `miner`/coinbase address, present only when
   * `outcome === "included"`. Populated even for a transaction this bundler
   * itself gave up on (`dropped`/`replaced`) if a different block builder
   * included it anyway - see the explorer-activity-outcomes design spec.
   */
  includer?: `0x${string}`;
```

- [ ] **Step 4: Add `markDropped`/`markIncluded` to `ExplorerService`**

In `packages/executor/src/services/ExplorerService/service.ts`, right after the existing
`markReplaced` method (lines 131-139), add:

```typescript
  markDropped(txHash: string, reason?: string): void {
    const record = this.admissions.get(txHash);
    // `included` is a one-way door - a transaction that's already confirmed
    // on-chain must never be reported dropped again, even if a stale
    // Cancelled transition somehow arrives after the fact.
    if (record && record.outcome !== "included") record.outcome = "dropped";
    this.recordLifecycle({ txHash, kind: "dropped", reason });
  }

  /**
   * `includer` is the including block's `miner`. Once a record is `included`,
   * nothing else may overwrite its outcome - a transaction that landed
   * on-chain stays landed, even if this method is somehow called again for
   * the same hash.
   */
  markIncluded(txHash: string, includer?: `0x${string}`): void {
    const record = this.admissions.get(txHash);
    if (record && record.outcome !== "included") {
      record.outcome = "included";
    }
    if (record && includer) record.includer = includer;
    this.recordLifecycle({ txHash, kind: "included" });
  }
```

- [ ] **Step 5: Wire `attach()`'s listeners to the new methods**

In the same file, replace the `attach()` method's body (lines 227-242):

```typescript
  attach(bus: ExecutorEventBus): void {
    bus.on(ExecutorEvent.pendingUserOps, (entry) =>
      this.fromEntry("admitted", entry)
    );
    bus.on(ExecutorEvent.submittedUserOps, (entry) => {
      if (!entry.txHash) return;
      // `submittedUserOps` carries Submitted, Cancelled and Reverted transitions.
      if (entry.status === MempoolEntryStatus.Cancelled) {
        this.markDropped(entry.txHash, entry.revertReason);
      } else {
        this.fromEntry("statusChanged", entry, entry.revertReason);
      }
    });
    bus.on(ExecutorEvent.onChainUserOps, (entry) => {
      if (!entry.txHash) return;
      this.markIncluded(entry.txHash);
    });
  }
```

(The `onChainUserOps` listener does not yet read `entry.includer` — that field does not
exist until Task 2, which changes this one line to
`this.markIncluded(entry.txHash, entry.includer);`.)

- [ ] **Step 6: Add `"included"`/`"dropped"` to the RPC outcome validator**

In `packages/executor/src/modules/explorer.ts`, replace line 28:

```typescript
const OUTCOMES: AdmissionOutcome[] = [
  "accepted",
  "rejected",
  "replaced",
  "included",
  "dropped",
];
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/executor && bunx vitest run test/services/ExplorerService/explorerService.test.ts`
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 8: Run the whole executor suite to confirm nothing else broke**

Run: `cd packages/executor && bunx vitest run`
Expected: same pass/fail counts as the pre-existing baseline (300 passing, 5 pre-existing
unrelated `test/unit/` failures from the stale `EntryPoint__factory` fixture — see
CLAUDE.md). No new failures.

- [ ] **Step 9: Build `types` and `executor` to confirm the type changes compile**

Run: `cd packages/types && bun run build && cd ../executor && bun run build`
Expected: both exit 0, no TypeScript errors.

- [ ] **Step 10: Commit**

```bash
git add packages/types/src/explorer/index.ts packages/executor/src/services/ExplorerService/service.ts packages/executor/src/modules/explorer.ts packages/executor/test/services/ExplorerService/explorerService.test.ts
git commit -m "feat(executor,types): add included/dropped AdmissionOutcome values and includer field"
```

---

## Task 2: `includer` field — live on-chain-inclusion path

**Files:**
- Modify: `packages/types/src/executor/validation/frameTxReceipt.ts`
- Modify: `packages/executor/src/services/ReceiptService/index.ts`
- Modify: `packages/executor/src/entities/FrameTxMempoolEntry.ts`
- Modify: `packages/executor/src/entities/interfaces.ts`
- Modify: `packages/executor/src/services/MempoolService/utils.ts`
- Modify: `packages/executor/src/services/MempoolService/service.ts:126-157`
- Modify: `packages/executor/src/services/BundlingService/reconciliation.ts`
- Modify: `packages/executor/src/services/ExplorerService/service.ts` (the one line from Task 1 Step 5)
- Test: `packages/executor/test/services/BundlingService/reconciliation.test.ts`
- Test: `packages/executor/test/services/ExplorerService/explorerService.test.ts`
- Test: `packages/executor/test/services/MempoolService/updateIncludedStatus.test.ts`

**Interfaces:**
- Consumes: Task 1's `ExplorerService.markIncluded(txHash, includer?)`.
- Produces: `FrameTxReceipt.blockNumber: bigint`; `FrameTxMempoolEntry.includer?:
  \`0x${string}\``; `MempoolService.updateStatus`'s `params.includer?: string`;
  `MempoolReconciler.includerOf(blockNumber: bigint): Promise<\`0x${string}\` | undefined>`
  (private, but its behavior — "block-lookup failure never blocks the status transition" —
  is relied on by Task 4).

- [ ] **Step 1: Write the failing test for `includer` flowing through the event bus**

Replace the existing `"derives lifecycle events from the executor event bus"` test in
`packages/executor/test/services/ExplorerService/explorerService.test.ts` (lines 278-308)
with:

```typescript
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
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/executor && bunx vitest run test/services/ExplorerService/explorerService.test.ts -t "derives lifecycle events"`
Expected: FAIL — the two new `onChainUserOps` emissions aren't in the old test's list yet
(this is the pre-edit test failing against the new expectations you just wrote); after
editing the assertions themselves there is nothing further to change here until Step 8
rewires `attach()` to read `entry.includer` — run again after that step.

- [ ] **Step 3: Add `blockNumber` to `FrameTxReceipt` and decode it in `ReceiptService`**

In `packages/types/src/executor/validation/frameTxReceipt.ts`, add to the `FrameTxReceipt`
interface (after `payer`, before `status`, around line 45):

```typescript
  payer: `0x${string}`;
  /** The block this transaction was mined in, decoded from the wire's `blockNumber`. */
  blockNumber: bigint;
```

In `packages/executor/src/services/ReceiptService/index.ts`, add `blockNumber` to the
returned object (in the `return { ... }` block around line 115):

```typescript
    return {
      cumulativeGasUsed: BigInt(raw.cumulativeGasUsed),
      payer: raw.payer,
      blockNumber: BigInt(raw.blockNumber),
      status: decodeTransactionStatus(raw.status),
```

- [ ] **Step 4: Add `includer` to `FrameTxMempoolEntry`**

In `packages/executor/src/entities/FrameTxMempoolEntry.ts`:

Add to `FrameTxMempoolEntryOptions` (after `revertReason?: string;`, line 24):

```typescript
  revertReason?: string;
  includer?: `0x${string}`;
```

Add a class field (after `revertReason?: string;`, line 57):

```typescript
  revertReason?: string;
  includer?: `0x${string}`;
```

In the constructor, after `this.revertReason = options.revertReason;` (line 70):

```typescript
    this.revertReason = options.revertReason;
    this.includer = options.includer;
```

Replace `setStatus`'s `OnChain`/`Reverted`/`Cancelled` cases (lines 136-147) with:

```typescript
      case MempoolEntryStatus.OnChain: {
        this.actualTransaction = params?.transaction;
        this.includer = params?.includer;
        break;
      }
      case MempoolEntryStatus.Reverted: {
        // A reverted-but-mined transaction still has a receipt and an
        // includer - see the explorer-activity-outcomes design spec.
        this.revertReason = params?.revertReason;
        this.includer = params?.includer;
        break;
      }
      case MempoolEntryStatus.Cancelled: {
        // Explains why the bundler gave up - there is no includer to set
        // here, since the entry never landed (from this bundler's own
        // submissions - the watch list, Task 3, covers a different builder
        // including it anyway).
        this.revertReason = params?.revertReason;
        break;
      }
```

And add `includer?: string;` to `setStatus`'s `params` type (line 108-113):

```typescript
  setStatus(
    status: MempoolEntryStatus,
    params?: {
      transaction?: string;
      revertReason?: string;
      includer?: `0x${string}`;
    }
  ): void {
```

Finally, add `includer: this.includer,` to `serialize()`'s returned object (after
`revertReason: this.revertReason,`, line 262).

- [ ] **Step 5: Add `includer` to the DB-facing interfaces and deserializer**

In `packages/executor/src/entities/interfaces.ts`, add `includer?: \`0x${string}\`;` to both
`IFrameTxMempoolEntry` (after `revertReason?: string;`, line 69) and
`FrameTxMempoolEntrySerialized` (after `revertReason: string | undefined;`, line 104 — use
`includer: \`0x${string}\` | undefined;` to match that interface's style).

In `packages/executor/src/services/MempoolService/utils.ts`, add `includer: raw.includer,`
to `rawEntryToMempoolEntry`'s constructed options (after `revertReason: raw.revertReason,`,
line 21).

- [ ] **Step 6: Write a failing test pinning that `Reverted` widens the event but NOT the reputation bookkeeping**

Add to `updateIncludedStatus.test.ts`, inside `describe("MempoolService.updateStatus: OnChain transition", ...)`:

```typescript
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
```

This requires adding `ExecutorEvent` to the existing `import { ExecutorEventBus } from
"../../../src/services/SubscriptionService.js";` line at the top of the file:

```typescript
import { ExecutorEvent, ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
```

Run: `cd packages/executor && bunx vitest run test/services/MempoolService/updateIncludedStatus.test.ts`
Expected: FAIL — `seen` stays empty, since nothing emits `onChainUserOps` for a `Reverted`
transition yet. The existing two tests in this file still pass unchanged (they test
`Submitted`, which this task does not touch).

- [ ] **Step 7: Widen `MempoolService.updateStatus`'s event emission and thread `includer`**

In `packages/executor/src/services/MempoolService/service.ts`, replace `updateStatus`
(lines 126-157):

```typescript
  async updateStatus(
    entries: MempoolEntry[],
    status: MempoolEntryStatus,
    params?: {
      transaction?: string;
      revertReason?: string;
      includer?: `0x${string}`;
    }
  ): Promise<void> {
    for (const entry of entries) {
      entry.setStatus(status, params);
      await this.update(entry);

      // event bus logic
      if (
        [
          MempoolEntryStatus.Cancelled,
          MempoolEntryStatus.Submitted,
          MempoolEntryStatus.Reverted,
        ].findIndex((st) => st === status) > -1
      ) {
        this.eventBus.emit(ExecutorEvent.submittedUserOps, entry);
      }
      // `onChainUserOps`/`onOnChainUserOps` (SubscriptionService.ts) already
      // existed but nothing ever emitted this event, because nothing ever
      // set `OnChain` - see this class's header comment. `MempoolReconciler`
      // is the first caller. Widened to also fire on `Reverted`: a
      // reverted-but-mined transaction still has a receipt and an includer -
      // `included` means "has a block", independent of the frame-level
      // outcome (see the explorer-activity-outcomes design spec). Note this
      // reaches TWO independent consumers: `ExplorerService.attach` (the
      // explorer) and `SubscriptionService`'s own raw
      // `skandha_subscribe(["onChainUserOps"])` WS channel - both now
      // receive `Reverted` entries too, not just `OnChain` ones.
      if (
        status === MempoolEntryStatus.OnChain ||
        status === MempoolEntryStatus.Reverted
      ) {
        this.eventBus.emit(ExecutorEvent.onChainUserOps, entry);
      }
      if (status === MempoolEntryStatus.OnChain) {
        await this.reputationCheck.updateIncludedStatus(entry);
      }
    }
  }
```

Run: `cd packages/executor && bunx vitest run test/services/MempoolService/updateIncludedStatus.test.ts`
Expected: PASS, all three tests (the two pre-existing plus the new one from Step 6).

- [ ] **Step 8: Wire `ExplorerService.attach`'s `onChainUserOps` listener to read `entry.includer`**

In `packages/executor/src/services/ExplorerService/service.ts`, change the one line from
Task 1 Step 5:

```typescript
    bus.on(ExecutorEvent.onChainUserOps, (entry) => {
      if (!entry.txHash) return;
      this.markIncluded(entry.txHash, entry.includer);
    });
```

- [ ] **Step 9: Run the ExplorerService test to verify it now passes**

Run: `cd packages/executor && bunx vitest run test/services/ExplorerService/explorerService.test.ts -t "derives lifecycle events"`
Expected: PASS.

- [ ] **Step 10: Add `includerOf` and wire it into the reconciler's two existing passes**

In `packages/executor/src/services/BundlingService/reconciliation.ts`, add a private helper
(after `describeRevert`, around line 268):

```typescript
  /**
   * The including block's `miner`, for a receipt that's confirmed to exist.
   * A failed lookup is non-fatal - it's pure observability, so it must never
   * block the status transition itself (the same tolerance-for-partial-RPC-
   * failure style as `getChainId`).
   */
  private async includerOf(blockNumber: bigint): Promise<`0x${string}` | undefined> {
    try {
      const block = await this.publicClient.getBlock({ blockNumber });
      return block.miner;
    } catch (err) {
      this.logger.error(err, `Could not fetch includer for block ${blockNumber}`);
      return undefined;
    }
  }
```

Replace `reconcileMinedElsewhere`'s receipt-handling block (lines 135-148):

```typescript
        landed.add(entry);
        if (receipt.status === "success") {
          await this.mempoolService.updateStatus(
            [entry],
            MempoolEntryStatus.OnChain,
            {
              transaction: entry.txHash,
              includer: await this.includerOf(receipt.blockNumber),
            }
          );
        } else {
          await this.mempoolService.updateStatus(
            [entry],
            MempoolEntryStatus.Reverted,
            {
              revertReason: this.describeRevert(receipt),
              includer: await this.includerOf(receipt.blockNumber),
            }
          );
        }
```

Replace `reconcileSubmitted`'s landed-branch block (lines 213-224):

```typescript
      if (receipt) {
        const landed =
          receipt.status === "success"
            ? MempoolEntryStatus.OnChain
            : MempoolEntryStatus.Reverted;
        const includer = await this.includerOf(receipt.blockNumber);
        await this.mempoolService.updateStatus(
          [entry],
          landed,
          landed === MempoolEntryStatus.OnChain
            ? { transaction: entry.transaction, includer }
            : { revertReason: this.describeRevert(receipt), includer }
        );
```

- [ ] **Step 11: Fix the three existing reconciliation tests whose receipt mocks now need `blockNumber`**

In `packages/executor/test/services/BundlingService/reconciliation.test.ts`:

Add `getBlock: vi.fn().mockResolvedValue({ miner: "0x7777777777777777777777777777777777777777" })`
to `buildReconciler`'s `publicClient` object (after `getChainId`, around line 88):

```typescript
  const publicClient = {
    getBlockNumber: vi.fn().mockResolvedValue(opts.blockNumber ?? 1n),
    getChainId: vi.fn().mockResolvedValue(1337),
    getBlock: vi.fn().mockResolvedValue({ miner: "0x7777777777777777777777777777777777777777" }),
  };
```

Add `blockNumber: 42n,` to each of the three existing `getReceipt` mock resolutions that
reach the success/reverted branch:
- The default `buildReconciler` fallback (line 76): `vi.fn().mockResolvedValue({ status: "success", frameReceipts: [], blockNumber: 42n })`.
- `"marks a Submitted entry OnChain once its receipt is found"` (line 136): add `blockNumber: 42n,` alongside `cumulativeGasUsed: 1n, status: "success", frameReceipts: []`.
- `"marks a Submitted entry Reverted, naming the failing frame..."` (line 154-161): add `blockNumber: 42n,` alongside the existing fields.

- [ ] **Step 12: Write a new test proving `includer` reaches `updateStatus`**

Add to `reconciliation.test.ts`, inside `describe("MempoolReconciler.reconcile - Submitted entries (inclusion detection)", ...)`:

```typescript
  it("passes the including block's miner as includer when a Submitted entry lands", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Submitted, {
      transaction: "0xaaaa",
    });
    const { reconciler, mempoolService, publicClient } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        cumulativeGasUsed: 1n,
        status: "success",
        frameReceipts: [],
        blockNumber: 42n,
      }),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);
    publicClient.getBlock.mockResolvedValue({
      miner: "0x7777777777777777777777777777777777777777",
    });

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.OnChain,
      {
        transaction: "0xaaaa",
        includer: "0x7777777777777777777777777777777777777777",
      }
    );
    expect(publicClient.getBlock).toHaveBeenCalledWith({ blockNumber: 42n });
  });

  it("still marks the entry OnChain when the includer lookup itself fails", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Submitted, {
      transaction: "0xaaaa",
    });
    const { reconciler, mempoolService, publicClient } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        cumulativeGasUsed: 1n,
        status: "success",
        frameReceipts: [],
        blockNumber: 42n,
      }),
    });
    mempoolService.fetchPendingUserOps.mockResolvedValue([entry]);
    publicClient.getBlock.mockRejectedValue(new Error("ECONNREFUSED"));

    await reconciler.reconcile();

    expect(mempoolService.updateStatus).toHaveBeenCalledWith(
      [entry],
      MempoolEntryStatus.OnChain,
      { transaction: "0xaaaa", includer: undefined }
    );
  });
```

- [ ] **Step 13: Run the full reconciliation test file**

Run: `cd packages/executor && bunx vitest run test/services/BundlingService/reconciliation.test.ts`
Expected: PASS, all tests (existing + 2 new).

- [ ] **Step 14: Run the whole executor suite and build both packages**

Run: `cd packages/executor && bunx vitest run`
Expected: same baseline as Task 1 Step 8 (300 passing, 5 pre-existing unrelated failures).

Run: `cd packages/types && bun run build && cd ../executor && bun run build`
Expected: both exit 0.

- [ ] **Step 15: Commit**

```bash
git add packages/types/src/executor/validation/frameTxReceipt.ts packages/executor/src/services/ReceiptService/index.ts packages/executor/src/entities/FrameTxMempoolEntry.ts packages/executor/src/entities/interfaces.ts packages/executor/src/services/MempoolService/utils.ts packages/executor/src/services/MempoolService/service.ts packages/executor/src/services/BundlingService/reconciliation.ts packages/executor/src/services/ExplorerService/service.ts packages/executor/test/services/BundlingService/reconciliation.test.ts packages/executor/test/services/ExplorerService/explorerService.test.ts
git commit -m "feat(executor,types): record who included a transaction, including reverted-but-mined ones"
```

---

## Task 3: Late-inclusion watch list (MempoolService persistence)

**Files:**
- Modify: `packages/executor/src/services/MempoolService/service.ts`
- Test: `packages/executor/test/services/MempoolService/` (new file: `watchList.test.ts`)

**Interfaces:**
- Consumes: nothing new from Tasks 1-2 directly.
- Produces: `MempoolService.fetchWatchedEntries(): Promise<MempoolEntry[]>`;
  `MempoolService.resolveWatchedEntry(entry: MempoolEntry, includer?: \`0x${string}\`):
  Promise<void>` (emits `ExecutorEvent.onChainUserOps` with `entry.includer` set — Task 4
  consumes this).

- [ ] **Step 1: Write the failing tests**

Create `packages/executor/test/services/MempoolService/watchList.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { ExecutorEvent, ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const NEW_PAYER = "0x2222222222222222222222222222222222222222" as const;

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

const tx = (maxFee = 2n): FrameTransaction => ({
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

const fakeLogger = () => ({ debug: vi.fn(), error: vi.fn() }) as any;

const build = (archiveDuration = 1) =>
  new MempoolService(
    memoryDb(),
    1,
    { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any,
    new ExecutorEventBus(),
    { useropsTTL: 0, archiveDuration } as any,
    fakeLogger()
  );

describe("MempoolService late-inclusion watch list", () => {
  it("adds a cancelled entry to the watch list, findable via fetchWatchedEntries", async () => {
    const pool = build();
    await pool.addFrameTx(tx(), "0xaaa");
    const entry = await pool.getEntryByHash("0xaaa");
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "banned" });

    const watched = await pool.fetchWatchedEntries();
    expect(watched.map((e) => e.txHash)).toEqual(["0xaaa"]);
  });

  it("adds the OLD entry to the watch list when a replacement lands, keeping its own hash", async () => {
    const pool = build();
    await pool.addFrameTx(tx(2n), "0xaaa");
    const res = await pool.addFrameTx(tx(100n), "0xbbb");
    expect(res.replacedTxHash).toBe("0xaaa");

    const watched = await pool.fetchWatchedEntries();
    expect(watched.map((e) => e.txHash)).toEqual(["0xaaa"]);
    // The active slot now holds the new entry, untouched by the watch list.
    const active = await pool.getEntryByHash("0xbbb");
    expect(active?.txHash).toBe("0xbbb");
  });

  it("resolveWatchedEntry removes the entry from the watch list and emits onChainUserOps with the includer", async () => {
    const pool = build();
    await pool.addFrameTx(tx(), "0xaaa");
    const entry = await pool.getEntryByHash("0xaaa");
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "banned" });
    const watched = await pool.fetchWatchedEntries();

    const seen: any[] = [];
    (pool as any).eventBus.on(ExecutorEvent.onChainUserOps, (e: any) => seen.push(e));

    await pool.resolveWatchedEntry(watched[0], "0x9999999999999999999999999999999999999999");

    expect(await pool.fetchWatchedEntries()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].txHash).toBe("0xaaa");
    expect(seen[0].includer).toBe("0x9999999999999999999999999999999999999999");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/executor && bunx vitest run test/services/MempoolService/watchList.test.ts`
Expected: FAIL — `pool.fetchWatchedEntries is not a function` (and the Cancelled/replace
tests find nothing, since nothing writes to a watch list yet).

- [ ] **Step 3: Add the watch-list collection constants and constructor wiring**

In `packages/executor/src/services/MempoolService/service.ts`, add two private fields
(after `FRAMETX_HASHES_COLLECTION_PREFIX`, line 45):

```typescript
  private FRAMETX_HASHES_COLLECTION_PREFIX: string;
  private WATCHLIST_COLLECTION_KEY: string;
  private WATCHLIST_PREFIX: string;
```

And initialize them in the constructor (after line 58):

```typescript
    this.FRAMETX_HASHES_COLLECTION_PREFIX = "FRAMETXHASH:";
    this.WATCHLIST_COLLECTION_KEY = `${chainId}:WATCHLISTKEYS`;
    this.WATCHLIST_PREFIX = "WATCHLIST:";
```

- [ ] **Step 4: Add the watch-list read/write/GC methods**

Add these methods to the "Internal" section (after `removeFrameTxHash`, end of class, before
the closing `}` on line 378):

```typescript
  /**
   * Entries no longer actively tracked (cancelled, or replaced-away) but
   * still worth checking for late on-chain inclusion by a different block
   * builder - see the explorer-activity-outcomes design spec. Same
   * array-of-keys collection pattern as the active store
   * (`FRAMETX_COLLECTION_KEY`) - `IDbController` has no native prefix scan.
   */
  async fetchWatchedEntries(): Promise<MempoolEntry[]> {
    const hashes = await this.fetchWatchlistHashes();
    const rawEntries = await this.db
      .getMany<IFrameTxMempoolEntry>(hashes.map((h) => `${this.WATCHLIST_PREFIX}${h}`))
      .catch(() => []);
    return rawEntries.map(rawEntryToMempoolEntry);
  }

  /**
   * A watch-list entry turned out to be included after all - by a different
   * block builder than the one this bundler itself submits to, since this
   * bundler already gave up on it (that's how it ended up on the watch list).
   * Removes it from the watch list and emits the same `onChainUserOps` event
   * the live-inclusion path emits (`updateStatus`), so
   * `ExplorerService.attach`'s single listener handles both paths identically
   * - no separate wiring needed downstream.
   */
  async resolveWatchedEntry(
    entry: MempoolEntry,
    includer?: `0x${string}`
  ): Promise<void> {
    if (!entry.txHash) return;
    await this.mutex.runExclusive(async () => {
      await this.removeFromWatchlistUnlocked(entry.txHash!);
    });
    entry.includer = includer;
    this.eventBus.emit(ExecutorEvent.onChainUserOps, entry);
  }

  async deleteOldWatchedEntries(): Promise<void> {
    const removable = (await this.fetchWatchedEntries()).filter(
      (entry) =>
        entry.lastUpdatedTime + this.networkConfig.archiveDuration * 1000 <= now()
    );
    await this.mutex.runExclusive(async () => {
      for (const entry of removable) {
        if (entry.txHash) await this.removeFromWatchlistUnlocked(entry.txHash);
      }
    });
  }

  /** Caller must already hold `this.mutex` - see `addFrameTx`'s replace branch for why a second, unlocked variant exists alongside `watchForLateInclusion`. */
  private async watchForLateInclusionUnlocked(entry: MempoolEntry): Promise<void> {
    if (!entry.txHash) return;
    await this.db.put(`${this.WATCHLIST_PREFIX}${entry.txHash}`, entry);
    const hashes = await this.fetchWatchlistHashes();
    await this.db.put(this.WATCHLIST_COLLECTION_KEY, [...hashes, entry.txHash]);
  }

  private async watchForLateInclusion(entry: MempoolEntry): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.watchForLateInclusionUnlocked(entry);
    });
  }

  private async fetchWatchlistHashes(): Promise<string[]> {
    return this.db.get<string[]>(this.WATCHLIST_COLLECTION_KEY).catch(() => []);
  }

  /** Caller must already hold `this.mutex`. */
  private async removeFromWatchlistUnlocked(txHash: string): Promise<void> {
    await this.db.del(`${this.WATCHLIST_PREFIX}${txHash}`);
    const hashes = (await this.fetchWatchlistHashes()).filter((h) => h !== txHash);
    await this.db.put(this.WATCHLIST_COLLECTION_KEY, hashes);
  }
```

- [ ] **Step 5: Write to the watch list from `updateStatus`'s Cancelled branch**

In `updateStatus` (the version from Task 2 Step 6), add a watch-list write right after
`await this.update(entry);`:

```typescript
      entry.setStatus(status, params);
      await this.update(entry);

      if (status === MempoolEntryStatus.Cancelled) {
        await this.watchForLateInclusion(entry);
      }

      // event bus logic
```

- [ ] **Step 6: Write to the watch list from `addFrameTx`'s replace branch**

In `addFrameTx` (lines 207-222), the replace branch is already inside
`this.mutex.runExclusive(...)` — use the UNLOCKED variant to avoid deadlocking:

```typescript
      const existingEntry = await this.find(entry);
      if (existingEntry) {
        await this.validateReplaceability(entry, existingEntry);
        await this.db.put(this.getKey(entry), {
          ...entry,
          lastUpdatedTime: now(),
        });
        if (existingEntry.txHash) {
          await this.removeFrameTxHash(existingEntry.txHash);
          await this.watchForLateInclusionUnlocked(existingEntry);
          replacedTxHash = existingEntry.txHash;
        }
```

- [ ] **Step 7: Wire the watch-list GC into the existing purge timer**

In the constructor (lines 65-67):

```typescript
    setInterval(() => {
      void this.deleteOldUserOps();
      void this.deleteOldWatchedEntries();
    }, ARCHIVE_PURGE_INTERVAL); // 5 minutes
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd packages/executor && bunx vitest run test/services/MempoolService/watchList.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 9: Run the full MempoolService test suite and the whole executor suite**

Run: `cd packages/executor && bunx vitest run test/services/MempoolService/ test/unit/services/MempoolService.test.ts`
Expected: PASS (the `test/unit/` file is expected to fail to LOAD for the pre-existing,
unrelated `EntryPoint__factory` reason — confirm it's the same failure as baseline, not a
new one).

Run: `cd packages/executor && bunx vitest run`
Expected: same baseline as Task 2 Step 14, plus the 3 new watch-list tests passing.

- [ ] **Step 10: Build to confirm the type changes compile**

Run: `cd packages/executor && bun run build`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/executor/src/services/MempoolService/service.ts packages/executor/test/services/MempoolService/watchList.test.ts
git commit -m "feat(executor): keep cancelled/replaced-away entries checkable for late inclusion"
```

---

## Task 4: Watch-list reconciliation pass

**Files:**
- Modify: `packages/executor/src/services/BundlingService/reconciliation.ts`
- Test: `packages/executor/test/services/BundlingService/reconciliation.test.ts`

**Interfaces:**
- Consumes: Task 3's `MempoolService.fetchWatchedEntries()`/`resolveWatchedEntry(entry,
  includer?)`; Task 2's `ReceiptService.getReceipt(...).blockNumber` and
  `MempoolReconciler.includerOf(blockNumber)`.
- Produces: `MempoolReconciler.reconcileWatchList()` (private), called from `reconcile()`.

- [ ] **Step 1: Write the failing test**

Add to `reconciliation.test.ts`, first extend `buildReconciler`'s `mempoolService` mock
(around line 69-72) to include the two new methods:

```typescript
  const mempoolService = {
    fetchPendingUserOps: vi.fn().mockResolvedValue([]),
    fetchWatchedEntries: vi.fn().mockResolvedValue([]),
    resolveWatchedEntry: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };
```

Then add a new describe block at the end of the file:

```typescript
describe("MempoolReconciler.reconcile - watch list (late inclusion)", () => {
  it("resolves a watched entry that's found on chain, passing the includer", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Cancelled, {
      transaction: undefined,
    });
    const { reconciler, mempoolService, publicClient } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        status: "success",
        frameReceipts: [],
        blockNumber: 42n,
      }),
    });
    mempoolService.fetchWatchedEntries.mockResolvedValue([entry]);
    publicClient.getBlock.mockResolvedValue({
      miner: "0x7777777777777777777777777777777777777777",
    });

    await reconciler.reconcile();

    expect(mempoolService.resolveWatchedEntry).toHaveBeenCalledWith(
      entry,
      "0x7777777777777777777777777777777777777777"
    );
  });

  it("leaves a watched entry alone (does not resolve it) when it still has no receipt", async () => {
    const entry = buildEntry(buildTx(), MempoolEntryStatus.Cancelled);
    const { reconciler, mempoolService } = buildReconciler({ getReceipt: noReceipt() });
    mempoolService.fetchWatchedEntries.mockResolvedValue([entry]);

    await reconciler.reconcile();

    expect(mempoolService.resolveWatchedEntry).not.toHaveBeenCalled();
  });

  it("caps watch-list checks at MAX_INCLUSION_LOOKUPS_PER_PASS, oldest first", async () => {
    const entries = Array.from({ length: 55 }, (_, i) =>
      buildEntry(buildTx(BigInt(i)), MempoolEntryStatus.Cancelled, {})
    );
    entries.forEach((e, i) => (e.lastUpdatedTime = i)); // ascending: entries[0] is oldest
    const { reconciler, mempoolService } = buildReconciler({
      getReceipt: vi.fn().mockResolvedValue({
        status: "success",
        frameReceipts: [],
        blockNumber: 42n,
      }),
    });
    mempoolService.fetchWatchedEntries.mockResolvedValue(entries);

    await reconciler.reconcile();

    expect(mempoolService.resolveWatchedEntry).toHaveBeenCalledTimes(50);
    expect(mempoolService.resolveWatchedEntry).toHaveBeenCalledWith(
      entries[0],
      expect.anything()
    );
    expect(mempoolService.resolveWatchedEntry).not.toHaveBeenCalledWith(
      entries[54],
      expect.anything()
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/executor && bunx vitest run test/services/BundlingService/reconciliation.test.ts -t "watch list"`
Expected: FAIL — `resolveWatchedEntry` is never called, since nothing checks the watch list yet.

- [ ] **Step 3: Implement `reconcileWatchList` and call it from `reconcile()`**

In `packages/executor/src/services/BundlingService/reconciliation.ts`, add a new private
method (after `reconcileMinedElsewhere`, around line 159):

```typescript
  /**
   * Checks entries this bundler gave up on (cancelled, or replaced away) for
   * late on-chain inclusion by a different block builder - see the
   * explorer-activity-outcomes design spec. Same bounded/oldest-first/
   * skip-on-transport-error shape as `reconcileMinedElsewhere`; unlike that
   * method there is no "still revalidate" return value - an entry not found
   * on chain this pass simply stays on the watch list for the next one (or
   * ages out via `MempoolService`'s own `archiveDuration` GC).
   */
  private async reconcileWatchList(): Promise<void> {
    const watched = await this.mempoolService.fetchWatchedEntries();
    const oldestFirst = [...watched].sort(
      (a, b) => a.lastUpdatedTime - b.lastUpdatedTime
    );
    const checked = oldestFirst.slice(0, MAX_INCLUSION_LOOKUPS_PER_PASS);
    for (const entry of checked) {
      if (!entry.txHash) continue;
      try {
        const receipt = await this.receiptService.getReceipt(entry.txHash as Hex);
        const includer = await this.includerOf(receipt.blockNumber);
        await this.mempoolService.resolveWatchedEntry(entry, includer);
      } catch (err) {
        if (err instanceof RpcError) continue; // no receipt: still not included
        this.logger.error(
          err,
          `Could not check receipt for watched entry ${entry.txHash}; leaving it for the next pass`
        );
      }
    }
  }
```

Then call it from `reconcile()` (lines 80-100), after the existing three passes:

```typescript
    await this.reconcileSubmitted(submitted);
    const notOnChain = await this.reconcileMinedElsewhere(newEntries);
    await this.reconcileNew(
      this.selectCandidatesForRevalidation(notOnChain)
    );
    await this.reconcileWatchList();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/executor && bunx vitest run test/services/BundlingService/reconciliation.test.ts`
Expected: PASS, all tests (existing + 3 new watch-list ones).

- [ ] **Step 5: Run the whole executor suite and build**

Run: `cd packages/executor && bunx vitest run`
Expected: same baseline as Task 3 Step 9, plus the 3 new tests passing.

Run: `cd packages/executor && bun run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/executor/src/services/BundlingService/reconciliation.ts packages/executor/test/services/BundlingService/reconciliation.test.ts
git commit -m "feat(executor): reconcile the late-inclusion watch list each block"
```

---

## Task 5: `devnet-ui` — surface the new outcomes and `includer`

**Files:**
- Modify: `packages/devnet-ui/src/protocol/schemas.ts:40-52`
- Modify: `packages/devnet-ui/src/rpc/methods.ts:17-21`
- Modify: `packages/devnet-ui/src/ui/screens/ActivityScreen.tsx:15-22`
- Modify: `packages/devnet-ui/src/ui/StatusBadge.tsx`
- Test: `packages/devnet-ui/src/ui/screens/ActivityScreen.test.tsx` (create if none exists for this screen — check first)

**Interfaces:**
- Consumes: Task 1's `AdmissionOutcome` values (`"included"`, `"dropped"`) and `includer`
  field over the wire (as plain strings/JSON, per the explorer RPC's existing convention).

- [ ] **Step 1: Check for an existing ActivityScreen test file**

Run: `ls packages/devnet-ui/src/ui/screens/ | grep -i activity`

If `ActivityScreen.test.tsx` (or similar) already exists, add the new test there instead of
creating a new file; otherwise follow Step 2 to create one. Either way, match the existing
test file's setup/rendering conventions for this package (check one sibling screen test for
the pattern — e.g. how `instance`/`activity` query data is mocked) before writing the test.

- [ ] **Step 2: Write a failing test for the outcome filter and `whatHappened()` text**

If no test scaffold exists for this file, keep the new test minimal and focused on the pure
`whatHappened()` function (exported or not — export it if it isn't already, so it's testable
without rendering the full component):

In `ActivityScreen.tsx`, change `function whatHappened(...)` to
`export function whatHappened(...)` so it's directly testable.

Create `packages/devnet-ui/src/ui/screens/ActivityScreen.test.tsx`:

```typescript
import { describe, it, expect } from "vitest";
import { whatHappened } from "./ActivityScreen";
import type { Admission } from "../../protocol/schemas";

const base: Admission = {
  id: 1,
  txHash: "0x1",
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x0",
  at: 0,
  source: "rpc",
  outcome: "accepted",
  checks: [],
  frames: [],
  frameStatuses: [],
};

describe("ActivityScreen whatHappened", () => {
  it("describes a dropped transaction with its detail, falling back to a generic label", () => {
    expect(whatHappened({ ...base, outcome: "dropped" })).toBe("Dropped from the mempool");
  });

  it("describes an included transaction, naming the includer when present", () => {
    expect(
      whatHappened({
        ...base,
        outcome: "included",
        includer: "0x9999999999999999999999999999999999999999",
      })
    ).toMatch(/Included.*0x9999/);
  });

  it("describes an included transaction with no includer", () => {
    expect(whatHappened({ ...base, outcome: "included" })).toBe("Included");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" src/ui/screens/ActivityScreen.test.tsx`
Expected: FAIL — `whatHappened` isn't exported yet / doesn't handle `"dropped"`/`"included"`.

- [ ] **Step 4: Add `"included"`/`"dropped"` and `includer` to the schema**

In `packages/devnet-ui/src/protocol/schemas.ts`, replace line 47:

```typescript
  outcome: z.enum(["accepted", "rejected", "replaced", "included", "dropped"]),
```

Add `includer` to `AdmissionRecordSchema` (after `errorCode: z.number().optional(),`, line 48):

```typescript
  errorCode: z.number().optional(),
  includer: z.string().optional(),
```

- [ ] **Step 5: Add the new outcome values to `ListAdmissionsParams`**

In `packages/devnet-ui/src/rpc/methods.ts`, replace line 18:

```typescript
  outcome?: "accepted" | "rejected" | "replaced" | "included" | "dropped";
```

- [ ] **Step 6: Update `ActivityScreen.tsx`'s outcome filter and `whatHappened()`**

Replace lines 15-22:

```typescript
type Outcome = "all" | "accepted" | "rejected" | "included" | "replaced" | "dropped";
const OUTCOMES: Outcome[] = ["all", "rejected", "accepted", "included", "replaced", "dropped"];

export function whatHappened(admission: Admission): string {
  if (admission.outcome === "rejected") return failureDetail(admission.checks) ?? "Rejected";
  if (admission.outcome === "replaced") return "Replaced by a newer transaction";
  if (admission.outcome === "dropped") return "Dropped from the mempool";
  if (admission.outcome === "included") {
    return admission.includer ? `Included by ${shortAddress(admission.includer)}` : "Included";
  }
  return describeSource(admission.source);
}
```

(`shortAddress` is already imported at the top of the file, line 7.)

- [ ] **Step 7: Add `included`/`dropped` tones and labels to `StatusBadge`**

In `packages/devnet-ui/src/ui/StatusBadge.tsx`, add to `TONE` (after `replaced: "mute",`):

```typescript
  replaced: "mute",
  included: "pass",
  dropped: "mute",
```

And to `LABEL` (after `replaced: "Replaced",`):

```typescript
  replaced: "Replaced",
  included: "Included",
  dropped: "Dropped",
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" src/ui/screens/ActivityScreen.test.tsx`
Expected: PASS.

- [ ] **Step 9: Run the whole devnet-ui test suite**

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)"`
Expected: PASS, no new failures (check whether any existing test hardcodes the old 4-value
`OUTCOMES` list or the old `Outcome` union and needs a matching update — if you find one,
update it the same way as Step 6).

- [ ] **Step 10: Type-check the package**

Run: `cd packages/devnet-ui && bun run build` (or the package's typecheck script — check
`package.json` for the exact script name if `build` doesn't exist)
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/devnet-ui/src/protocol/schemas.ts packages/devnet-ui/src/rpc/methods.ts packages/devnet-ui/src/ui/screens/ActivityScreen.tsx packages/devnet-ui/src/ui/StatusBadge.tsx packages/devnet-ui/src/ui/screens/ActivityScreen.test.tsx
git commit -m "feat(devnet-ui): show included/dropped outcomes and who included a transaction"
```

---

## Task 6: Demo scenario — devnet e2e proof of the `dropped` outcome

**Files:**
- Create: `test/e2e/frameTxCancellation.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1's `"dropped"` outcome exposed via `skandha_explorer_listAdmissions`; the
  existing `debug_bundler_setReputation`/`debug_bundler_sendBundleNow`/
  `skandha_frameTransactionStatus` RPC methods; `test/e2e/helpers.ts`'s existing
  `startDevnet`/`stopDevnet`/`spawnNode`/`rpc`/`waitFor`/`tailLog`/`toWire` and
  `DEV_GENESIS_WALLET_ADDRESS`/`DEV_GENESIS_PAYMASTER_ADDRESS` constants.

This scenario deliberately does NOT attempt to prove the watch-list/`includer` path (Tasks
3-4) end-to-end: that needs a real mined block, which only the separate, Docker/Kurtosis-only
mining devnet (`frameTxInclusion.e2e.test.ts`'s devnet) can produce, and this feature's
core ask (explorer feedback #1) is the `dropped` visibility, not that. A mining-devnet
late-inclusion proof is a reasonable follow-up, not required here.

- [ ] **Step 1: Write the test file**

Create `test/e2e/frameTxCancellation.e2e.test.ts`:

```typescript
import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  NODE_A,
  CHAIN_ID,
  rpc,
  waitFor,
  spawnNode,
  tailLog,
  startDevnet,
  stopDevnet,
  toWire,
  DEV_GENESIS_WALLET_ADDRESS,
  DEV_GENESIS_PAYMASTER_ADDRESS,
} from "./helpers.js";
import { FRAME_MODE, APPROVE_SCOPE, SIG_SCHEME, FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";

/**
 * Proves the explorer's `dropped` outcome (explorer feedback #1 - see
 * docs/superpowers/specs/2026-09-30-explorer-activity-outcomes-design.md)
 * end to end: a transaction is admitted, its payer is then banned via
 * reputation, and the bundler cancels it on its next (manually triggered)
 * bundling pass - all against the fast `--dev` devnet, no real mining
 * needed, matching `frameTxRejection.e2e.test.ts`'s pattern.
 *
 * Uses the Canonical Paymaster shape [only_verify, pay] (not the Self Relay
 * shape) because `BundlingService.shouldRelay`'s banned-entity check only
 * ever looks at the `payer`/`factory` roles, not `sender` - a self-paying
 * sender is explicitly exempt (see that method's own comment).
 */
describe("frame tx e2e: mempool cancellation surfaces as a dropped outcome", () => {
  let tmpDir: string;
  let dirA: string;
  let nodeA: ChildProcess | undefined;

  const urlA = `http://127.0.0.1:${NODE_A.api}/rpc/`;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skandha-e2e-cancellation-"));
    dirA = path.join(tmpDir, "nodeA");
    fs.mkdirSync(dirA, { recursive: true });

    await startDevnet();

    nodeA = spawnNode("nodeA", dirA, NODE_A, []); // manual bundling mode (default)
    await waitFor("node A's RPC", 90_000, async () => {
      const r = await rpc(urlA, "eth_chainId");
      return Number(r.result) === CHAIN_ID;
    });
  }, 300_000);

  afterAll(async () => {
    nodeA?.kill("SIGKILL");
    stopDevnet();
  }, 120_000);

  it(
    "cancels an admitted transaction once its payer is banned, and the Activity list shows it dropped",
    async () => {
      // Canonical Paymaster shape, well under MAX_VERIFY_GAS (100_000) so it
      // is admitted cleanly - see frameTxRejection.e2e.test.ts's identical
      // shape for the rejected (over-limit) counterexample.
      const tx: FrameTransaction = {
        chainId: BigInt(CHAIN_ID),
        nonce: 1n, // contract account - starts at nonce 1, not 0
        sender: DEV_GENESIS_WALLET_ADDRESS,
        frames: [
          {
            mode: FRAME_MODE.VERIFY,
            flags: APPROVE_SCOPE.EXECUTION,
            target: null,
            limits: { execution: 30_000n, state: 0n },
            value: 0n,
            data: "0x",
          },
          {
            mode: FRAME_MODE.VERIFY,
            flags: APPROVE_SCOPE.PAYMENT,
            target: DEV_GENESIS_PAYMASTER_ADDRESS,
            limits: { execution: 30_000n, state: 0n },
            value: 0n,
            data: "0x",
          },
        ],
        signatures: [{ scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: "0x" }],
        fees: {
          maxPriorityFeePerGas: 1_000_000_000n,
          maxFeePerGas: 2_000_000_000n,
          maxFeePerBlobGas: 0n,
        },
        blobVersionedHashes: [],
      };

      const sent = await rpc(urlA, "eth_sendFrameTransaction", [toWire(tx)]);
      expect(
        sent.error,
        `expected admission, got an error: ${JSON.stringify(sent)}\n--- node A log ---\n${tailLog(dirA, "nodeA")}`
      ).toBeUndefined();
      const txHash = sent.result as string;

      // Ban the payer: opsSeen=1000, opsIncluded=0 crosses the default ban
      // threshold (minExpectedIncluded = 1000/10 = 100 > 0 + banSlack(50)).
      const banned = await rpc(urlA, "debug_bundler_setReputation", [
        [{ address: DEV_GENESIS_PAYMASTER_ADDRESS, opsSeen: 1000, opsIncluded: 0 }],
        "0x0",
      ]);
      expect(banned.error, `setReputation failed: ${JSON.stringify(banned)}`).toBeUndefined();

      // Manual bundling mode: nothing runs until explicitly told to.
      const bundled = await rpc(urlA, "debug_bundler_sendBundleNow");
      expect(bundled.error, `sendBundleNow failed: ${JSON.stringify(bundled)}`).toBeUndefined();

      await waitFor("the transaction to be cancelled", 30_000, async () => {
        const status = await rpc(urlA, "skandha_frameTransactionStatus", [txHash]);
        return status.result?.status === "Cancelled";
      });

      const activity = await rpc(urlA, "skandha_explorer_listAdmissions", [
        { outcome: "dropped" },
      ]);
      expect(
        activity.result?.items?.some((r: any) => r.txHash === txHash),
        `expected ${txHash} in the dropped outcome list, got: ${JSON.stringify(activity)}`
      ).toBe(true);
    },
    120_000
  );
});
```

- [ ] **Step 2: Note that this requires a real devnet and is not run by `bunx vitest run` at the repo root**

This test needs Docker and the devnet script's dependencies (see `P2P.md`'s devnet
walkthrough and `test/e2e/ethrex-devnet.sh`) — it is not expected to run in a plain dev
sandbox without them. Verify it at least type-checks:

Run: `cd packages/executor && bun run build` (the e2e test imports from
`@skandha/executor/lib/...` via `helpers.ts`, so a stale build would hide a real type error)

If Docker and the devnet script's prerequisites are available in this environment, also run:

Run: `npx vitest run test/e2e/frameTxCancellation.e2e.test.ts`
Expected: PASS. If Docker/the devnet is unavailable, state so explicitly rather than
claiming success — this mirrors how `frameTxRejection.e2e.test.ts`/`frameTxInclusion.e2e.test.ts`
are already documented as CI-only in this repo.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/frameTxCancellation.e2e.test.ts
git commit -m "test(e2e): prove a banned payer's transaction surfaces as a dropped Activity outcome"
```
