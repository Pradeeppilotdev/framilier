# Explorer Reputation/Staking Tab

Date: 2026-09-29
Status: Draft, awaiting review

## Goal

Give the devnet explorer a read-only view of every entity's reputation (seen/included counts,
OK/THROTTLED/BANNED status, whitelist/blacklist membership) and stake (amount, unstake delay,
whether it clears the minimum). This is item #2 of Alex's first-round explorer feedback: "We do not
surface the entire staking/reputation details anywhere in the explorer... this is basically the
most important part of the explorer."

## Scope

1. A backend fix: `ReputationService.updateIncludedStatus()` exists and is fully implemented but is
   never called anywhere, so `opsIncluded` is permanently `0` for every entity. Wire it up.
2. One new read-only `skandha_explorer_*` RPC method combining reputation and stake data per
   address, paginated like the existing list methods.
3. One new UI tab in the top nav, alongside Overview/Activity/Peers.

## Non-goals

- Whitelist/blacklist mutation from the UI. Read-only, matching the whole explorer's philosophy —
  `debug_bundler_*` (admin-gated, already supports mutation) stays the only way to change either
  list.
- Per-address drill-down or filtering Activity by an address from this tab.
- Any change to `ReputationService`'s decay math (the hourly `* 23/24` falloff) or the
  ban/throttle threshold formulas themselves (`isBanned`/`isThrottled` in `ReputationEntry.ts`).
- A registry-wide "list every staked entity" capability. `StakingRegistryService.getDepositInfo`
  only supports looking up one address at a time (see [Background](#background)) — this spec starts
  from addresses the reputation system already tracks, not from the chain itself.

## Background

**Reputation** (`packages/executor/src/services/ReputationService.ts`) tracks `opsSeen`/
`opsIncluded` per address in RocksDB, fully enumerable via `dump()` (already exposed as the
admin-gated `debug_bundler_dumpReputation`). `getStatus()` derives OK/THROTTLED/BANNED from the
ratio of `seen` to `included`, with slack constants (`minInclusionDenominator`/`throttlingSlack`/
`banSlack`) from `NetworkConfig`. Whitelist/blacklist membership (`isWhitelisted`/`isBlacklisted`)
is a separate concern, also tracked here.

**`updateSeenStatus`** is called from `MempoolReputationChecks.updateSeenStatus`
(`packages/executor/src/services/MempoolService/reputation.ts`), itself called from
`MempoolService.addFrameTx` on every admission: bumps `payer`/`factory` unconditionally, and
`sender` only when a fresh stake lookup at admission time shows it's staked (the sender/unstaked
case is rate-limited by a flat mempool-count cap elsewhere, not by reputation ratio — an existing
design choice, not something this spec touches).

**`updateIncludedStatus`** is fully implemented on `ReputationService` but has **zero callers**
anywhere in the codebase. Nothing ever increments `opsIncluded`. Since `getStatus()`'s ban/throttle
math is `floor(seen / minInclusionDenominator) > included + slack`, any actively-used entity
organically drifts toward THROTTLED and then BANNED over time purely because "included" never
increments — a live bug in a gate that's actually consulted today (`FrameTxValidationService`'s
`checkStakeCached` → `ReputationService.checkStake` → `getStatus`), not dead code.

**Staking** (`packages/executor/src/services/StakingRegistryService/index.ts`) wraps a single
on-chain read, `getDepositInfo(address) -> {stake, unstakeDelaySec, withdrawTime}`. There is no
registry-wide enumeration method — the contract interface itself only supports a per-address
lookup, and `StakingRegistryService` doesn't add caching or an index on top of it.

## Design

### 1. Wire up `updateIncludedStatus`

`MempoolService.updateStatus()` (`packages/executor/src/services/MempoolService/service.ts`) is the
single place a mempool entry transitions to `MempoolEntryStatus.OnChain` — it already emits
`ExecutorEvent.onChainUserOps` there. Add, in the same `if (status === MempoolEntryStatus.OnChain)`
block:

```ts
await this.reputationCheck.updateIncludedStatus(entry);
```

New method on `MempoolReputationChecks` (`packages/executor/src/services/MempoolService/reputation.ts`),
next to the existing `updateSeenStatus`:

```ts
async updateIncludedStatus(entry: MempoolEntry): Promise<void> {
  const { sender, payer, factory } = entry;
  const addresses = new Set<string>([sender]);
  if (payer) addresses.add(payer);
  if (factory) addresses.add(factory);
  for (const address of addresses) {
    await this.reputationService.updateIncludedStatus(address);
  }
}
```

(A `Set`, not three unconditional calls: for a Self Relay entry `payer === sender` — see
`FrameTxMempoolEntry`'s class doc comment — so bumping both unconditionally would double-count the
same address's `opsIncluded` for a single included transaction.)

**Deliberate asymmetry with `updateSeenStatus`:** that method only bumps `sender`'s *seen* count
when a fresh stake lookup shows it's staked. Replicating that here would require a
`StakingRegistryService` dependency in `MempoolService`, which isn't available without reordering
`executor.ts`'s documented construction sequence (`StakingRegistryService` is currently constructed
*after* `MempoolService` — see root `CLAUDE.md`'s build-order list) — a real architectural change out
of proportion to this fix. It's unnecessary: since an unstaked sender's `opsSeen` never leaves `0`,
`isBanned`/`isThrottled`'s `floor(seen / denominator) > included + slack` reduces to `0 > included +
slack`, which is never true regardless of what `included` is. Bumping `included` unconditionally for
every sender therefore cannot change the ban/throttle outcome for an unstaked one — it can only make
`opsIncluded` a real, if occasionally cosmetic (`seen: 0, included: 3`), number instead of a
permanently-wrong `0`.

### 2. New RPC: `skandha_explorer_listReputation`

New wire types in `packages/types/src/explorer/index.ts` (the browser-safe, import-free file):

```ts
export type ExplorerReputationStatus = "ok" | "throttled" | "banned";

export interface ExplorerReputationEntry {
  address: string;
  opsSeen: number;
  opsIncluded: number;
  status: ExplorerReputationStatus;
  isWhitelisted: boolean;
  isBlacklisted: boolean;
  /** 0x hex quantity (wei) */
  stake: string;
  unstakeDelaySec: number;
  /** 0x hex quantity; 0 while no withdrawal has been initiated */
  withdrawTime: string;
  /** stake >= NetworkConfig.minStake && unstakeDelaySec >= NetworkConfig.minUnstakeDelay */
  isStaked: boolean;
}
```

New method on `Explorer` (`packages/executor/src/modules/explorer.ts`), paginated exactly like the
existing `listTransactions` (offset-as-cursor, `clampLimit`):

```ts
async listReputation(
  params: { cursor?: string; limit?: number } = {}
): Promise<Page<ExplorerReputationEntry>>
```

Sourced from `ReputationService.dump()` (the enumerable address list — same data
`debug_bundler_dumpReputation` already returns), enriched per address in the returned page (not the
whole dump) with one `StakingRegistryService.getDepositInfo()` on-chain read each — bounded by page
size (default 50, capped 200, same as every other list method), so this is a bounded number of RPC
calls per page at devnet scale, not a scan of the whole address space.

`Explorer`'s constructor gains three new parameters: `reputationService: ReputationService`,
`stakingRegistryService: StakingRegistryService`, and the two threshold primitives
`minStake: bigint`/`minUnstakeDelay: number` (from `NetworkConfig`, passed narrowly rather than the
whole config object, matching the existing `Pick<MempoolService, ...>` narrow-typing convention
already used there) — so `isStaked` is computed once, server-side, with the same threshold logic
`ReputationService.checkStake` already applies, instead of being duplicated in the UI. All three are
already constructed before `Explorer` is (`executor.ts`'s `new Explorer(...)` call is already the
last in the composition order), so no reordering is needed here, unlike the `updateIncludedStatus`
fix above.

Sort order: newest-`lastUpdateTime`-first is meaningless here (unlike admissions/transactions,
which have a natural recency); sort by `address` for a stable, deterministic page order instead.

### 3. UI: Reputation tab

A new screen (`packages/devnet-ui/src/ui/screens/ReputationScreen.tsx`) and route, alongside
Overview/Activity/Peers in the top nav (`packages/devnet-ui/src/ui/shell`, wherever the existing tab
list lives). A single table: address, status badge (OK/THROTTLED/BANNED, reusing the explorer's
existing badge component style), seen, included, stake (formatted from wei), unstake delay,
whitelisted/blacklisted badges. Paginated the same way Activity already is ("Load more").

New protocol schema entries in `packages/devnet-ui/src/protocol/schemas.ts`
(`ExplorerReputationEntrySchema`, extending the existing `pageSchema` helper) and a new
`useReputation` data hook (`packages/devnet-ui/src/data/hooks.ts`) matching the existing
`useActivity`/`useTransactions` pattern (`TanStack Query`, keyed by `[instanceUrl, "listReputation",
cursor]`).

## Testing

- **Backend**: `MempoolReputationChecks.updateIncludedStatus` tests: bumps each distinct
  sender/payer/factory address once; a Self Relay entry (`payer === sender`) bumps that one shared
  address exactly once, not twice. A `MempoolService` test for the `OnChain` transition actually
  calling it. `Explorer.listReputation` test: pagination, `isStaked` computed correctly against the
  threshold, status mapped correctly from the numeric `ReputationStatus` enum to the wire string
  union.
- **UI**: Vitest for the new schema/hook and the status-badge mapping; a Playwright/mock-server smoke
  test for the tab rendering a page of entries, matching the existing `mock/state.ts` fixture-driven
  pattern (needs a `MockNode` method to seed reputation/stake fixture data — check what exists there
  before adding a new one).

## Open items

- Exact placement of the new nav tab and its route path — check `packages/devnet-ui/src/ui/shell`'s
  existing structure during implementation; not decided here since it's a mechanical detail, not a
  design decision.
- Whether `mock/state.ts` (the devnet-ui dev/test fixture server) already has any reputation/staking
  simulation to build on, or needs one from scratch — check during implementation.
