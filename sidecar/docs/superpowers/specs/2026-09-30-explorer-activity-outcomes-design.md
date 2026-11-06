# Explorer Activity Outcomes: included/replaced/dropped + includer

**Status:** design, not yet implemented. Part of explorer feedback #1 ("cancelled vs.
rejected", see `docs/superpowers/specs/2026-09-24-devnet-explorer-design.md` and
`docs/sidecar_explorer.md` for the explorer's existing shape).

## Context & goal

The devnet explorer's Activity list (`skandha_explorer_listAdmissions`, rendered by
`ActivityScreen.tsx`) shows one row per `AdmissionRecord`, whose `outcome` is currently
`"accepted" | "rejected" | "replaced"`. A transaction that gets admitted and then later
dropped from the mempool (banned entity, exceeded `maxSubmitAttempts`, failed
reconciliation) keeps `outcome: "accepted"` forever — the only trace of what actually
happened to it is a `dropped` lifecycle event, visible solely on that transaction's own
`TxScreen`, never in the aggregate list. Separately, a transaction that lands on-chain
also never gets its own outcome — it too just stays `"accepted"`.

Goal: make `AdmissionRecord.outcome` reflect the real terminal state of every accepted
transaction, and record *who* included it when it lands on-chain, so the Activity list
and a per-tx detail view tell the whole story without cross-referencing a second data
source.

## Scope

**In scope:**
- A five-value `AdmissionOutcome` taxonomy: `rejected | accepted | included | replaced |
  dropped`.
- An `includer` field (the including block's `miner`/coinbase address) on
  `AdmissionRecord`, populated whenever outcome becomes `included`.
- A transaction that's cancelled or replaced-away continues to be checked for late
  on-chain inclusion (a different block builder can still include a frame transaction
  this bundler gave up on) — via a new, bounded "late-inclusion watch list" in
  `MempoolService`, reusing the existing reconciliation pattern.
- `ActivityScreen.tsx` outcome filter/list changes to show the new values.
- A devnet demo scenario (new `test/e2e/` script) that deliberately produces a
  `dropped` entry via the banned-payer path, to prove the feature end-to-end.

**Out of scope:**
- Replace-by-fee races / the mutual-exclusion-paymaster demo originally proposed for
  this feedback item — deferred, no stateful paymaster contract exists in devnet
  fixtures today (would need new contract bytecode, a separate piece of work).
- A distinct "resurfaced" outcome value — superseded by the `includer` field, which
  tells the same story (the record simply reflects `included` with who included it,
  regardless of the path it took to get there) without fragmenting the filter dropdown
  for a rare case.
- Changing anything about `rejected`'s meaning or trigger.

## Background: what already exists

(Established via codebase survey; see conversation history for full detail, summarized
here.)

- `MempoolEntryStatus.Cancelled` is a real, reachable terminal status, set by three
  live code paths: `BundlingService.shouldRelay`'s banned-payer/factory path
  (`packages/executor/src/services/BundlingService/service.ts:375-385`),
  `selectEntries`'s `maxSubmitAttempts` path (same file, `:285-303`), and
  `MempoolReconciler.reconcileNew`'s compliance/chain-id checks
  (`packages/executor/src/services/BundlingService/reconciliation.ts:~290-330`).
- `ExplorerService.attach` (`packages/executor/src/services/ExplorerService/service.ts:227-242`)
  already turns a `Cancelled` transition into a `"dropped"` `LifecycleEvent`, and an
  `OnChain` transition into an `"included"` one — but neither touches
  `AdmissionRecord.outcome`. Only `markReplaced` (`service.ts:131-139`) does that today,
  flipping `outcome` to `"replaced"` when a fee-bump resubmission lands.
- Replace-by-fee is fully implemented (`FrameTxMempoolEntry.canReplace`, 10%-bump rule)
  and already visible in the Activity list today, since `"replaced"` is already a valid
  outcome.
- `MempoolReconciler.reconcileMinedElsewhere`/`reconcileSubmitted`
  (`reconciliation.ts:118-235`) are the two places that detect on-chain inclusion for
  actively-tracked (`New`/`Submitted`) entries, via `ReceiptService.getReceipt`. Both
  already have `this.publicClient` (a viem `PublicClient`) in scope.
- Nothing today re-checks a `Cancelled` entry (excluded from
  `MempoolService.fetchPendingUserOps` by its status ordering — `Cancelled=5 >
  OnChain=3`) or a replaced-away entry (its DB record and hash index are destroyed
  synchronously inside `addFrameTx`'s replace branch,
  `service.ts:208-222`) for late inclusion. The information is actively discarded, not
  merely unobserved.
- No prefix-scan exists on `IDbController` — the only "enumerate a collection" pattern
  in this codebase is an array-of-keys stored under one dedicated key
  (`FRAMETX_COLLECTION_KEY`), rewritten in full on every add/remove, guarded by a mutex.
  A new watch-list collection reuses this exact pattern.
- `FrameTxMempoolEntry` round-trips through the DB via plain object-spread on write
  (`bigintJson`'s custom replacer) and a dedicated `rawEntryToMempoolEntry` reconstruction
  function on read (`MempoolService/utils.ts:11-21`) — not free class-instance
  serialization.
- `NetworkConfig.archiveDuration` defaults to 86400s (24h); `deleteOldUserOps` already
  purges terminal entries past that age on a 5-minute timer
  (`MempoolService/constants.ts`, `service.ts:65-67,266-280`).

## Design

### 1. `AdmissionOutcome`: five-value taxonomy

```ts
// packages/types/src/explorer/index.ts
export type AdmissionOutcome =
  | "rejected"   // never entered the mempool
  | "accepted"   // in the mempool, not yet resolved
  | "included"   // accepted, then landed on-chain (see `includer`)
  | "replaced"   // accepted, then superseded by a fee-bump resubmission
  | "dropped";   // accepted, then evicted without being included
```

`rejected` and `accepted` are set exactly as today (`recordAdmission`). `included`,
`replaced`, and `dropped` are all set by dedicated `mark*` methods on `ExplorerService`
that mutate an existing record's `outcome` directly — `markReplaced` already works this
way; `markIncluded`/`markDropped` are new, same shape:

```ts
// ExplorerService
markDropped(txHash: string, reason?: string): void {
  const record = this.admissions.get(txHash);
  if (record) record.outcome = "dropped";
  this.recordLifecycle({ txHash, kind: "dropped", reason });
}

markIncluded(txHash: string, includer?: `0x${string}`): void {
  const record = this.admissions.get(txHash);
  if (record) {
    record.outcome = "included";
    if (includer) record.includer = includer;
  }
  this.recordLifecycle({ txHash, kind: "included" });
}
```

`attach()`'s existing `submittedUserOps`/`onChainUserOps` listeners call these instead
of the current bare `fromEntry(...)` calls — the lifecycle event stream (and hence the
per-tx Timeline and the live `explorerEvents` WebSocket) is unchanged; this is additive.

`AdmissionRecord` gains: `includer?: \`0x${string}\`` (set only when `outcome ===
"included"`).

API surface: `OUTCOMES` in `packages/executor/src/modules/explorer.ts:28` (the
`listAdmissions` param validator) and `ListAdmissionsParams.outcome`'s type in
`packages/devnet-ui/src/rpc/methods.ts:17-21` both gain `"dropped"`.

**Overwrite policy:** once a record reaches a terminal outcome (anything but
`accepted`), a later `mark*` call may still legitimately overwrite it — that is
precisely what "late inclusion" means (a `dropped`/`replaced` record later becomes
`included`). `included` is the one outcome that should never itself be overwritten by
anything else (a transaction that's on-chain stays on-chain). No other ordering
constraint is enforced; the three `mark*` methods are simple last-write-wins, since the
underlying status transitions they mirror are themselves supposed to be mutually
exclusive for a given hash at any moment.

### 2. `includer`: who included it

A receipt has no block-builder field (`miner`/coinbase is block-level, not
receipt-level, in standard `eth_getTransactionReceipt`). Wherever a receipt is
confirmed (success *or* revert — see open item below), fetch the including block and
read `.miner`:

```ts
const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
// block.miner
```

(Matches the one existing `getBlock` convention in this codebase,
`packages/node/src/network/reqresp/handlers/status.ts:10`.)

`FrameTxMempoolEntry` gains a new optional field `includer?: \`0x${string}\``, set by
`setStatus` the same way `revertReason` already is.
`MempoolService.updateStatus`'s `params` gains `includer?: string`, threaded through
from both `reconcileMinedElsewhere` and `reconcileSubmitted` when they detect a receipt.

`ExplorerService.attach`'s `onChainUserOps` listener reads `entry.includer` off the
entry it already receives and forwards it to `markIncluded` — no new event payload
shape needed, since the includer travels on the entry itself.

### 3. Late-inclusion watch list (new `MempoolService` persistence)

A single new DB collection, reusing the existing array-of-keys pattern
(`WATCHLIST_COLLECTION_KEY = \`${chainId}:WATCHLISTKEYS\``, entries stored at
`WATCHLIST:<txHash>`, each entry the same serialized `IFrameTxMempoolEntry` shape
already used elsewhere — no new codec needed).

Two new write sites, both inside `MempoolService`:

- `updateStatus`'s `Cancelled` branch: snapshot the entry into the watch list (in
  addition to its existing behavior).
- `addFrameTx`'s replace branch: snapshot the *old* entry into the watch list *before*
  its `sender:nonce` slot is overwritten (instead of only deleting its hash index).

```ts
private async watchForLateInclusion(entry: MempoolEntry): Promise<void> {
  if (!entry.txHash) return;
  await this.db.put(`${this.WATCHLIST_PREFIX}${entry.txHash}`, entry);
  const keys = await this.fetchWatchlistKeys();
  await this.db.put(this.WATCHLIST_COLLECTION_KEY, [...keys, entry.txHash]);
}
```

A new public pair mirrors `fetchPendingUserOps`/`updateStatus` for this collection:

```ts
async fetchWatchedEntries(): Promise<MempoolEntry[]> { /* same shape as fetchAll(), over WATCHLIST keys */ }

async resolveWatchedEntry(entry: MempoolEntry, includer?: `0x${string}`): Promise<void> {
  // remove from the watch-list collection (db.del + key-array rewrite)
  // then: entry.includer = includer; this.eventBus.emit(ExecutorEvent.onChainUserOps, entry);
}
```

`resolveWatchedEntry` reuses the *existing* `onChainUserOps` event — a watch-list entry,
reconstructed via the same `rawEntryToMempoolEntry` path, is already `MempoolEntry`-shaped,
so `ExplorerService.attach`'s single `onChainUserOps` listener (from §2) handles both the
live-inclusion path and the late-inclusion path identically, with zero new wiring into
`ExplorerService`.

**New reconciliation pass**, in `MempoolReconciler`, same shape as
`reconcileMinedElsewhere` (oldest-first, capped per pass via
`MAX_INCLUSION_LOOKUPS_PER_PASS`, skip-on-transport-error): fetches
`mempoolService.fetchWatchedEntries()`, receipt-checks each, and on success fetches the
including block and calls `mempoolService.resolveWatchedEntry(entry, block.miner)`. Run
from `reconcile()`'s main loop alongside the existing passes. Requires **no new
constructor dependency** on `MempoolReconciler` — it already holds `mempoolService` and
`publicClient`.

**Garbage collection:** watch-list entries age out the same way active entries do —
extend `deleteOldUserOps`'s existing 5-minute timer (or add a sibling call on the same
timer) to also purge watch-list entries past `archiveDuration` (reusing the same config
knob; no new config surface).

**Cost:** the array-of-keys pattern is O(n) full-rewrite per mutation, same
characteristic the existing `FRAMETX_COLLECTION_KEY` already has. Acceptable for a
devnet-scale explorer (confirmed acceptable for this use: "not a busy chain").

### 4. `devnet-ui` changes

- `ActivityScreen.tsx`: add `"included"` and `"dropped"` to the `OUTCOMES` filter array
  (currently `["all", "rejected", "accepted", "replaced"]`) and matching branches in
  `whatHappened()`.
- Show `includer` on a record when present — on the Activity row (e.g. a short
  truncated address) and/or the `TxScreen` detail view.
- No changes needed to `Timeline`/the live-stream highlighting logic — both already
  handle `included`/`dropped` lifecycle kinds correctly.

### 5. Demo scenario (`test/e2e/`)

New script, following `frameTxInclusion.e2e.test.ts`'s existing conventions
(`helpers.ts`'s `spawnNode`/`waitFor`/`rpc`/`deployContract` idioms), using the
banned-payer path (deterministic, ~0s wait in manual bundling mode):

1. Start devnet, spawn a node in manual bundling mode.
2. Deploy `PAYMASTER_INIT_CODE`/`WALLET_INIT_CODE` to get a distinct `payer` entity.
3. Submit a Canonical-Paymaster-shaped (`[only_verify, pay]`) frame tx.
4. `debug_bundler_setReputation([{address: payer, opsSeen: 1000, opsIncluded: 0}],
   "0x0")` — crosses the default ban threshold (`minExpectedIncluded=100 > 0+50`).
5. `debug_bundler_sendBundleNow` — `shouldRelay` runs synchronously, cancels the entry.
6. `waitFor`-poll `skandha_frameTransactionStatus` for `"Cancelled"`, then assert
   `skandha_explorer_listAdmissions({outcome: "dropped"})` contains it.
7. (Optional, proves the watch-list) let the transaction actually land on-chain via a
   second, unbanned relay path or direct submission, then poll until the same record's
   `outcome` flips to `"included"` with a non-empty `includer`.

## Design decision: a reverted-but-mined transaction counts as `included`

A `Reverted` status transition (distinct from `OnChain`) also has a receipt and an
includer — `included` means "has a block" (regardless of the frame-level
success/revert outcome, which stays separately visible via `frameStatuses`), so
`ExecutorEvent.onChainUserOps` is widened to also fire on `Reverted`, not just
`OnChain`. Note for implementation: `SubscriptionService`'s raw
`skandha_subscribe(["onChainUserOps", ...])` WS channel is a second, independent
consumer of this same event (`SubscriptionService.ts:53,64,79`) — widening its trigger
condition means that channel now also delivers `Reverted` entries, not just `OnChain`
ones. This is intended, but should be called out in the PR description since it's an
observable behavior change to an existing public subscription, not purely internal.

## Testing

- Unit: `ExplorerService` — `markIncluded`/`markDropped` outcome-flip + lifecycle-event
  behavior, mirroring existing `markReplaced` tests.
- Unit: `MempoolService` — watch-list write-on-cancel, write-on-replace,
  `resolveWatchedEntry`'s removal + event emission, GC past `archiveDuration`.
- Unit: `MempoolReconciler` — new watch-list reconciliation pass (bounded, oldest-first,
  skip-on-transport-error), mirroring existing `reconcileMinedElsewhere` tests.
- e2e: the new demo scenario script itself (§5), run against a real devnet.
