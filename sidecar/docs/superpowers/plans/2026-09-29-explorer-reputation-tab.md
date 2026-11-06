# Explorer Reputation/Staking Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the devnet explorer a read-only Reputation tab showing every tracked entity's
seen/included counts, OK/THROTTLED/BANNED status, whitelist/blacklist membership and on-chain
stake — and fix the underlying bug (`updateIncludedStatus()` never called) that makes `included`
data meaningless today.

**Architecture:** Three independent layers, built bottom-up: (1) a backend correctness fix wiring
`ReputationService.updateIncludedStatus()` into the mempool's existing `OnChain` transition point;
(2) a new read-only `skandha_explorer_listReputation` RPC combining the already-enumerable
reputation dump with a per-address on-chain stake lookup; (3) a new UI tab consuming it, following
the explorer's established list-screen pattern (Activity/Peers) exactly.

**Tech Stack:** TypeScript, Bun, Vitest (single-threaded), React 19, TanStack Query/Router, viem.

**Spec:** `docs/superpowers/specs/2026-09-29-explorer-reputation-tab-design.md`

## Global Constraints

- No whitelist/blacklist mutation from the UI — read-only, matching the whole explorer.
- No per-address drill-down/filtering Activity by address from this tab.
- No change to `ReputationService`'s decay math or ban/throttle threshold formulas.
- No registry-wide stake enumeration — `StakingRegistryService.getDepositInfo` stays a per-address
  lookup; the reputation dump (already enumerable) is what drives which addresses get looked up.
- `updateIncludedStatus` bumps sender/payer/factory via a `Set`, not three unconditional calls — a
  Self Relay entry has `payer === sender` and must be counted once, not twice.
- `packages/executor` tests must be run from inside `packages/executor`
  (`cd packages/executor && bunx vitest run ...`), not the repo root, so `test/vitestSetup.ts`'s
  `GethTracer` mock applies (root `CLAUDE.md`).
- `packages/devnet-ui` tests must be run with `--root` set to the package
  (`cd packages/devnet-ui && bunx vitest run --root "$(pwd)" ...`), not from the repo root.
- Do not use `packages/executor/test/fixtures/services.ts` for any new test — it's part of the
  documented stale ERC-4337 fixture chain (constructs a 7-arg `MempoolService` with a deleted
  `EntryPointService` dependency; today's real `MempoolService` takes 6 args, no
  `EntryPointService`). Construct services directly in new test files instead, matching
  `frameTx.test.ts`'s/`explorerService.test.ts`'s direct-instantiation style.

## Review Focus

- `MempoolReputationChecks.updateIncludedStatus`'s `Set`-based dedup — confirm a Self Relay entry
  (`payer === sender`) really does call `reputationService.updateIncludedStatus` exactly once, not
  the entry's `sender`/`payer` fields being distinct string instances of the same address that a
  plain `Set` wouldn't actually dedupe (e.g. differing checksum case).
- `Explorer.listReputation`'s pagination cursor arithmetic (`offset`/`limit`/`nextCursor`) — confirm
  it matches `listTransactions`'/`listAdmissions`' existing behavior exactly (same off-by-one risk
  class), including the case where `dump().length` is an exact multiple of `limit`.
- `isStaked`'s threshold comparison (`stake >= minStake && unstakeDelaySec >= minUnstakeDelay`) —
  confirm it matches `ReputationService.checkStake`'s existing threshold logic exactly (same
  `>=`/`<` direction on both fields), so the tab's "staked" badge never disagrees with what the
  admission-gate itself would decide for the same address.
- The `Explorer` constructor's three new dependencies (`reputationService`, `stakingRegistryService`,
  plus `minStake`/`minUnstakeDelay`) — confirm every existing call site (production `executor.ts`,
  and the `build()` helper in `explorer.test.ts`) was updated, not just the ones this plan's tests
  exercise directly.
- The mock server's `listReputation` — confirm it's gated behind `explorerEnabled` and returns
  `METHOD_NOT_FOUND` when disabled, exactly like every other `skandha_explorer_*` mock method
  (`MockNode.handle`'s existing gate at the top of the switch, before the per-method dispatch).

---

## Task 1: Wire up `updateIncludedStatus`

**Files:**
- Modify: `packages/executor/src/services/MempoolService/reputation.ts`
- Modify: `packages/executor/src/services/MempoolService/service.ts`
- Test: `packages/executor/test/services/MempoolService/reputation.test.ts`
- Test (new file): `packages/executor/test/services/MempoolService/updateIncludedStatus.test.ts`

**Interfaces:**
- Produces: `MempoolReputationChecks.updateIncludedStatus(entry: MempoolEntry): Promise<void>` — new
  method, called internally by `MempoolService.updateStatus`. No other task consumes this directly.

- [ ] **Step 1: Write the failing tests for `MempoolReputationChecks.updateIncludedStatus`**

Add to `packages/executor/test/services/MempoolService/reputation.test.ts`, after the existing
`describe("MempoolReputationChecks.updateSeenStatus - Self Relay (senderInfo undefined)", ...)`
block at the end of the file:

```ts
describe("MempoolReputationChecks.updateIncludedStatus", () => {
  it("bumps each of sender, payer and factory once, when all three are distinct addresses", async () => {
    const sender = "0x1111111111111111111111111111111111111111";
    const payer = "0x2222222222222222222222222222222222222222";
    const factory = "0x3333333333333333333333333333333333333333";
    const reputationService = { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any;
    const checks = new MempoolReputationChecks({} as any, reputationService, {} as any);
    const entry = { sender, payer, factory } as any;

    await checks.updateIncludedStatus(entry);

    expect(reputationService.updateIncludedStatus).toHaveBeenCalledTimes(3);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(sender);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(payer);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(factory);
  });

  it("bumps a Self Relay entry's shared sender/payer address exactly once, not twice", async () => {
    const selfRelayAddr = "0x4444444444444444444444444444444444444444";
    const reputationService = { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any;
    const checks = new MempoolReputationChecks({} as any, reputationService, {} as any);
    const entry = { sender: selfRelayAddr, payer: selfRelayAddr, factory: undefined } as any;

    await checks.updateIncludedStatus(entry);

    expect(reputationService.updateIncludedStatus).toHaveBeenCalledTimes(1);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(selfRelayAddr);
  });

  it("bumps only sender when payer and factory are absent", async () => {
    const sender = "0x5555555555555555555555555555555555555555";
    const reputationService = { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any;
    const checks = new MempoolReputationChecks({} as any, reputationService, {} as any);
    const entry = { sender, payer: undefined, factory: undefined } as any;

    await checks.updateIncludedStatus(entry);

    expect(reputationService.updateIncludedStatus).toHaveBeenCalledTimes(1);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(sender);
  });
});
```

- [ ] **Step 2: Run the new tests, verify they fail**

Run: `cd packages/executor && bunx vitest run test/services/MempoolService/reputation.test.ts -t "updateIncludedStatus"`
Expected: FAIL — `checks.updateIncludedStatus is not a function` (the method doesn't exist yet).

- [ ] **Step 3: Implement `MempoolReputationChecks.updateIncludedStatus`**

Add to `packages/executor/src/services/MempoolService/reputation.ts`, immediately after the existing
`updateSeenStatus` method (before the class's closing brace):

```ts
  /**
   * Bumps `included` for every distinct entity address this entry names,
   * once each - unlike `updateSeenStatus`, unconditionally (no fresh stake
   * lookup gates the sender here; see this file's header comment for why
   * that's harmless). A `Set` avoids double-counting a Self Relay entry,
   * whose `payer` always equals its `sender`.
   */
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

Add this note to the top of the file, right after the existing `import` block, as a small header
comment (there isn't one on this file today beyond the class's own doc comment — add it just above
the `MempoolReputationChecks` class doc comment that already exists, or inline above the new method
if the class has no file-level comment slot; match whichever the file actually has once you open
it):

```ts
// `updateIncludedStatus` (below) deliberately does NOT mirror `updateSeenStatus`'s
// stake-gated sender bump: since an unstaked sender's `opsSeen` never leaves 0,
// `ReputationEntry.isBanned`/`isThrottled`'s `floor(seen / denominator) > included + slack`
// reduces to `0 > included + slack`, which is never true regardless of `included` -
// bumping it unconditionally cannot change that entity's ban/throttle outcome.
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd packages/executor && bunx vitest run test/services/MempoolService/reputation.test.ts`
Expected: PASS — every test in the file, old and new.

- [ ] **Step 5: Write the failing test for the `OnChain` wiring**

Create `packages/executor/test/services/MempoolService/updateIncludedStatus.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { LocalDbController } from "../../mocks/database.js";
import { FrameTxMempoolEntry } from "../../../src/entities/FrameTxMempoolEntry.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;

const tx = (): FrameTransaction => ({
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
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
});

const fakeLogger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn() }) as any;

describe("MempoolService.updateStatus: OnChain transition", () => {
  it("bumps included status for the entry's addresses when it transitions to OnChain", async () => {
    const db = new LocalDbController("test-update-included");
    const reputationService = {
      updateIncludedStatus: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventBus = new ExecutorEventBus();
    const networkConfig = {} as any;
    const service = new MempoolService(db, 1337, reputationService, eventBus, networkConfig, fakeLogger());
    const entry = new FrameTxMempoolEntry(tx(), { txHash: "0xabc", status: MempoolEntryStatus.Submitted });

    await service.updateStatus([entry], MempoolEntryStatus.OnChain);

    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(SENDER);
  });

  it("does not bump included status for a non-OnChain transition", async () => {
    const db = new LocalDbController("test-update-included-2");
    const reputationService = {
      updateIncludedStatus: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventBus = new ExecutorEventBus();
    const networkConfig = {} as any;
    const service = new MempoolService(db, 1337, reputationService, eventBus, networkConfig, fakeLogger());
    const entry = new FrameTxMempoolEntry(tx(), { txHash: "0xabc", status: MempoolEntryStatus.New });

    await service.updateStatus([entry], MempoolEntryStatus.Submitted);

    expect(reputationService.updateIncludedStatus).not.toHaveBeenCalled();
  });
});
```

Before writing this, confirm `packages/executor/test/mocks/database.ts` exports `LocalDbController`
and that `FrameTxMempoolEntry`'s constructor accepts `(tx, { txHash, status, submittedTime? })` as
its second argument (check `packages/executor/src/entities/FrameTxMempoolEntry.ts`'s constructor
signature directly — `explorer.test.ts`'s `entry()` helper, read during planning, uses exactly this
shape, but confirm the exact parameter name/optionality before relying on it verbatim).

- [ ] **Step 6: Run it, verify it fails**

Run: `cd packages/executor && bunx vitest run test/services/MempoolService/updateIncludedStatus.test.ts`
Expected: FAIL on the first test — `reputationService.updateIncludedStatus` was never called (the
`OnChain` branch in `MempoolService.updateStatus` doesn't call it yet). The second test may already
pass (nothing calls it for other transitions either, today) — that's fine, it exists to pin the
negative case across this change, not to prove new behavior on its own.

- [ ] **Step 7: Wire it into `MempoolService.updateStatus`**

In `packages/executor/src/services/MempoolService/service.ts`, inside `updateStatus`, find:

```ts
      if (status === MempoolEntryStatus.OnChain) {
        this.eventBus.emit(ExecutorEvent.onChainUserOps, entry);
      }
```

Change to:

```ts
      if (status === MempoolEntryStatus.OnChain) {
        this.eventBus.emit(ExecutorEvent.onChainUserOps, entry);
        await this.reputationCheck.updateIncludedStatus(entry);
      }
```

- [ ] **Step 8: Run the tests, verify they pass**

Run: `cd packages/executor && bunx vitest run test/services/MempoolService/updateIncludedStatus.test.ts test/services/MempoolService/reputation.test.ts`
Expected: PASS — all tests in both files.

Run: `cd packages/executor && bunx vitest run`
Expected: PASS — same baseline as documented in root `CLAUDE.md` (5 pre-existing broken
`test/unit/` suites, unrelated), plus these 5 new tests passing.

- [ ] **Step 9: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src/services/MempoolService/reputation.ts \
  packages/executor/src/services/MempoolService/service.ts \
  packages/executor/test/services/MempoolService/reputation.test.ts \
  packages/executor/test/services/MempoolService/updateIncludedStatus.test.ts
git commit -m "fix(executor): wire up ReputationService.updateIncludedStatus

It existed fully implemented but was never called, so opsIncluded was
permanently 0 for every entity - meaning the live ban/throttle gate
(checkStake -> getStatus) could only ever see seen counts drift upward
with no offsetting inclusion. Called now from MempoolService.updateStatus
at the existing OnChain transition point, alongside the lifecycle event
it already emits there."
```

---

## Task 2: New RPC — `skandha_explorer_listReputation`

**Files:**
- Modify: `packages/types/src/explorer/index.ts`
- Modify: `packages/executor/src/modules/explorer.ts`
- Modify: `packages/executor/src/executor.ts`
- Modify: `packages/api/src/constants.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/executor/test/modules/explorer.test.ts`

**Interfaces:**
- Consumes: `ReputationService.dump()/isWhitelisted()/isBlacklisted()` (existing, unchanged),
  `StakingRegistryService.getDepositInfo()` (existing, unchanged).
- Produces: `ExplorerReputationEntry`/`ExplorerReputationStatus` (new wire types, consumed by Task
  3's UI schema). `Explorer.listReputation(params): Promise<Page<ExplorerReputationEntry>>`
  (consumed by Task 3's `rpc/methods.ts` wrapper). `CustomRPCMethods.skandha_explorer_listReputation`
  (the wire method name, consumed by Task 3's `rpc/methods.ts` wrapper as the literal string
  `"skandha_explorer_listReputation"` — the constant itself is not exported to `devnet-ui`, which
  has no dependency on `packages/api`).

- [ ] **Step 1: Add the new wire types**

Add to `packages/types/src/explorer/index.ts`, after the existing `ExplorerPeer` interface at the
end of the file:

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
  /** `stake >= NetworkConfig.minStake && unstakeDelaySec >= NetworkConfig.minUnstakeDelay` */
  isStaked: boolean;
}
```

This file has no imports by design (see its header comment) - these two new exports don't need any.

- [ ] **Step 2: Rebuild `types` so the executor picks up the new exports**

Run: `cd packages/types && bun run build`
Expected: exit code 0.

- [ ] **Step 3: Write the failing tests for `Explorer.listReputation`**

First, update the `build()` helper in `packages/executor/test/modules/explorer.test.ts` to accept
and wire the three new dependencies. Change:

```ts
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
```

to:

```ts
function build(opts: {
  service?: ExplorerService | null;
  entries?: FrameTxMempoolEntry[];
  peers?: unknown[] | null;
  reputationEntries?: { address: string; opsSeen: number; opsIncluded: number; status: number }[];
  deposits?: Record<string, { stake: bigint; unstakeDelaySec: number; withdrawTime: bigint }>;
  minStake?: bigint;
  minUnstakeDelay?: number;
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
    opts.minUnstakeDelay ?? 86_400
  );
  return { module, service, mempool, reputationService, stakingRegistryService };
}
```

Then update the "when the explorer is disabled" test's `calls` array to also cover the new method:

```ts
      const calls = [
        () => module.info(),
        () => module.listTransactions(),
        () => module.listAdmissions(),
        () => module.getTransaction(H(1)),
        () => module.peers(),
        () => module.listReputation(),
      ];
```

Then add a new describe block at the end of the file:

```ts
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
```

- [ ] **Step 4: Run the new tests, verify they fail**

Run: `cd packages/executor && bunx vitest run test/modules/explorer.test.ts`
Expected: FAIL — a TypeScript/runtime error on `new Explorer(...)` (too many arguments passed to
the current 6-param constructor) and `module.listReputation is not a function`.

- [ ] **Step 5: Implement `Explorer.listReputation`**

In `packages/executor/src/modules/explorer.ts`, update the imports:

```ts
import { isHex, toHex } from "viem";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { BundlingMode } from "@skandha/types/lib/api/interfaces";
import { MempoolEntryStatus, ReputationStatus } from "@skandha/types/lib/executor";
import { SkandhaVersion } from "@skandha/types/lib/executor/index.js";
import {
  AdmissionOutcome,
  AdmissionRecord,
  EXPLORER_PROTOCOL_VERSION,
  ExplorerInfo,
  ExplorerPeer,
  ExplorerReputationEntry,
  ExplorerReputationStatus,
  ExplorerTransactionDetail,
  ExplorerTransactionSummary,
  Page,
} from "@skandha/types/lib/explorer/index.js";
import { FrameTxMempoolEntry } from "../entities/FrameTxMempoolEntry.js";
import { GetNodeAPI } from "../interfaces.js";
import { MempoolService } from "../services/MempoolService/service.js";
import { ExplorerService } from "../services/ExplorerService/service.js";
import { ReputationService } from "../services/ReputationService.js";
import { StakingRegistryService } from "../services/StakingRegistryService/index.js";
```

Add, right after the `OUTCOMES` constant:

```ts
const REPUTATION_STATUS: Record<ReputationStatus, ExplorerReputationStatus> = {
  [ReputationStatus.OK]: "ok",
  [ReputationStatus.THROTTLED]: "throttled",
  [ReputationStatus.BANNED]: "banned",
};
```

Change the constructor:

```ts
export class Explorer {
  constructor(
    private chainId: number,
    private version: SkandhaVersion,
    private bundlingService: { getBundlingMode(): BundlingMode },
    private mempoolService: Pick<MempoolService, "listAll" | "getEntryByHash">,
    private explorerService: ExplorerService | null,
    private getNodeAPI: GetNodeAPI,
    private reputationService: Pick<ReputationService, "dump" | "isWhitelisted" | "isBlacklisted">,
    private stakingRegistryService: Pick<StakingRegistryService, "getDepositInfo">,
    private minStake: bigint,
    private minUnstakeDelay: number
  ) {}
```

Add the new method, after `listAdmissions` and before `getTransaction`:

```ts
  async listReputation(
    params: { cursor?: string; limit?: number } = {}
  ): Promise<Page<ExplorerReputationEntry>> {
    this.service();
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    if (!Number.isInteger(offset) || offset < 0) {
      throw invalid(`Invalid cursor: ${params.cursor}`);
    }
    const limit = clampLimit(params.limit);

    const dump = (await this.reputationService.dump()).sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );
    const page = dump.slice(offset, offset + limit);
    const items = await Promise.all(
      page.map(async (entry): Promise<ExplorerReputationEntry> => {
        const deposit = await this.stakingRegistryService.getDepositInfo(
          entry.address as `0x${string}`
        );
        const isStaked =
          deposit.stake >= this.minStake && deposit.unstakeDelaySec >= this.minUnstakeDelay;
        return {
          address: entry.address,
          opsSeen: entry.opsSeen,
          opsIncluded: entry.opsIncluded,
          status: REPUTATION_STATUS[entry.status],
          isWhitelisted: await this.reputationService.isWhitelisted(entry.address),
          isBlacklisted: await this.reputationService.isBlacklisted(entry.address),
          stake: toHex(deposit.stake),
          unstakeDelaySec: deposit.unstakeDelaySec,
          withdrawTime: toHex(deposit.withdrawTime),
          isStaked,
        };
      })
    );
    return offset + limit < dump.length
      ? { items, nextCursor: String(offset + limit) }
      : { items };
  }
```

- [ ] **Step 6: Wire the three new dependencies into `executor.ts`**

In `packages/executor/src/executor.ts`, change:

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

to:

```ts
    this.explorer = new Explorer(
      this.chainId,
      this.version,
      this.bundlingService,
      this.mempoolService,
      this.explorerService,
      this.getNodeApi,
      this.reputationService,
      this.stakingRegistryService,
      this.networkConfig.minStake,
      this.networkConfig.minUnstakeDelay
    );
```

`this.reputationService` and `this.stakingRegistryService` are both already constructed earlier in
this same constructor (lines 94 and 128 respectively, both before line 191 where `this.explorer` is
built) - confirm this by reading the surrounding lines before editing, since a stale line-number
assumption here would silently reference an uninitialized field.

- [ ] **Step 7: Run the executor tests, verify they pass**

Run: `cd packages/executor && bunx vitest run test/modules/explorer.test.ts`
Expected: PASS — every test in the file.

Run: `cd /Users/alexf/skandha && bun run build`
Expected: exit code 0 (this catches any missed call site across the whole workspace, including
`packages/api`, which is edited in the next step and must compile against the type change too).

- [ ] **Step 8: Register the method in the API layer**

In `packages/api/src/constants.ts`, add to `CustomRPCMethods`:

```ts
  skandha_explorer_peers: "skandha_explorer_peers",
  skandha_explorer_listReputation: "skandha_explorer_listReputation",
```

(insert the new line right after the existing `skandha_explorer_peers` line)

In `packages/api/src/app.ts`, add a new case right after the existing
`CustomRPCMethods.skandha_explorer_peers` case:

```ts
        case CustomRPCMethods.skandha_explorer_peers:
          return { jsonrpc, id, result: this.explorerApi.peers() };
        case CustomRPCMethods.skandha_explorer_listReputation:
          return {
            jsonrpc,
            id,
            result: await this.explorerApi.listReputation(params?.[0]),
          };
```

- [ ] **Step 9: Full workspace build and test run**

Run: `cd /Users/alexf/skandha && bun run build`
Expected: exit code 0.

Run: `cd packages/executor && bunx vitest run`
Expected: PASS — same baseline as Task 1's final count, unchanged (this task added no new executor
tests beyond `explorer.test.ts`'s, already covered in Step 7).

- [ ] **Step 10: Commit**

```bash
cd /Users/alexf/skandha
git add packages/types/src/explorer/index.ts \
  packages/executor/src/modules/explorer.ts \
  packages/executor/src/executor.ts \
  packages/executor/test/modules/explorer.test.ts \
  packages/api/src/constants.ts \
  packages/api/src/app.ts
git commit -m "feat(executor,api): add skandha_explorer_listReputation

Combines the already-enumerable reputation dump (seen/included/status/
whitelist/blacklist) with a per-address on-chain stake lookup, paginated
like every other explorer list method. isStaked is computed server-side
against NetworkConfig's real thresholds, matching ReputationService.
checkStake's own logic rather than duplicating it in the UI."
```

---

## Task 3: Reputation tab UI

**Files:**
- Modify: `packages/devnet-ui/mock/state.ts`
- Modify: `packages/devnet-ui/mock/fixtures.ts`
- Modify: `packages/devnet-ui/src/protocol/schemas.ts`
- Modify: `packages/devnet-ui/src/rpc/methods.ts`
- Modify: `packages/devnet-ui/src/data/keys.ts`
- Modify: `packages/devnet-ui/src/data/hooks.ts`
- Modify: `packages/devnet-ui/src/logic/format.ts`
- Modify: `packages/devnet-ui/src/ui/StatusBadge.tsx`
- Create: `packages/devnet-ui/src/ui/screens/ReputationScreen.tsx`
- Modify: `packages/devnet-ui/src/app.tsx`
- Test: `packages/devnet-ui/src/logic/logic.test.ts`
- Test: `packages/devnet-ui/mock/state.test.ts`
- Test: `packages/devnet-ui/src/app.test.tsx`

**Interfaces:**
- Consumes: `skandha_explorer_listReputation` (Task 2), the exact wire shape of
  `ExplorerReputationEntry` (Task 2, mirrored here as a zod schema since `devnet-ui` cannot import
  backend types across the browser boundary - matching every other explorer type's existing
  duplication in `protocol/schemas.ts`).
- Produces: nothing consumed by another task - this is the leaf of the plan.

- [ ] **Step 1: Add `formatEther`, with a failing test first**

Add to `packages/devnet-ui/src/logic/logic.test.ts`, inside the existing `describe("format", ...)`
block (after the `formatGwei` test):

```ts
  it("formats wei as ether with up to four decimals", () => {
    expect(formatEther("0x0")).toBe("0 ETH");
    expect(formatEther("0xde0b6b3a7640000")).toBe("1 ETH"); // 1e18 wei
    expect(formatEther("0x6f05b59d3b20000")).toBe("0.5 ETH"); // 5e17 wei
    expect(formatEther("0x1")).toBe("<0.0001 ETH");
  });
```

Add `formatEther` to the `import` list at the top of `logic.test.ts` (alongside the existing
`formatGwei` import).

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" src/logic/logic.test.ts -t "formats wei as ether"`
Expected: FAIL — `formatEther is not defined` (or a TS error; either confirms it doesn't exist yet).

Implement in `packages/devnet-ui/src/logic/format.ts`, right after `formatGwei`:

```ts
/** A wei amount, given as a `0x` quantity, shown in ETH with up to four decimals. */
export function formatEther(hexWei: string): string {
  const wei = hexToBigInt(hexWei);
  if (wei === 0n) return "0 ETH";
  const ether = 1_000_000_000_000_000_000n;
  const whole = wei / ether;
  const rest = wei % ether;
  if (whole === 0n && rest < 100_000_000_000_000n) return "<0.0001 ETH";
  const tenThousandths = rest / 100_000_000_000_000n;
  const decimals =
    tenThousandths === 0n ? "" : `.${tenThousandths.toString().padStart(4, "0").replace(/0+$/, "")}`;
  return `${whole.toLocaleString("en-US")}${decimals} ETH`;
}
```

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" src/logic/logic.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 2: Add the reputation schema, with a failing compile-time guard check first**

`protocolGuards` (the bottom of `packages/devnet-ui/src/protocol/schemas.ts`) is a compile-time-only
check with no runtime assertion to watch fail - for this step, "RED" means adding the schema entry
to `protocolGuards` before the schema exists causes a TypeScript error, which you confirm by running
`tsc`, not `vitest`.

Add to `packages/devnet-ui/src/protocol/schemas.ts`, after the existing `PeerSchema`:

```ts
export const ReputationEntrySchema = z.object({
  address: z.string(),
  opsSeen: z.number(),
  opsIncluded: z.number(),
  status: z.enum(["ok", "throttled", "banned"]),
  isWhitelisted: z.boolean(),
  isBlacklisted: z.boolean(),
  stake: z.string(),
  unstakeDelaySec: z.number(),
  withdrawTime: z.string(),
  isStaked: z.boolean(),
});
```

Add `ReputationEntrySchema` to the `pageSchema` block, next to `PeerListSchema`:

```ts
export const ReputationPageSchema = pageSchema(ReputationEntrySchema);
```

Add to the type-export block, next to `Peer`:

```ts
export type ReputationEntry = z.infer<typeof ReputationEntrySchema>;
```

Add the import of the backend type at the top of the file, in the same `import type { ... } from
"@skandha/types/lib/explorer/index.js"` block that already imports `RuleCheck`/`AdmissionRecord`/
etc.:

```ts
  ExplorerReputationEntry,
```

Add to the `protocolGuards` array:

```ts
    Accepts<ReputationEntry, ExplorerReputationEntry>,
```

Run: `cd packages/devnet-ui && bunx tsc --noEmit`
Expected: clean (no output, exit 0) - confirming the new schema's inferred type really does accept
the backend's `ExplorerReputationEntry` shape byte-for-byte. If this fails, the schema has a
mismatched field name or type - fix the schema, not the guard.

- [ ] **Step 3: Add the typed RPC wrapper**

In `packages/devnet-ui/src/rpc/methods.ts`, add the import:

```ts
  ReputationPageSchema,
```

(into the existing `import { ... } from "../protocol/schemas"` block, alongside `PeerListSchema`)

Add the params interface, next to `ListAdmissionsParams`:

```ts
export interface ListReputationParams {
  cursor?: string;
  limit?: number;
}
```

Add to the `explorerApi` object, after `peers`:

```ts
  listReputation: (url: string, params: ListReputationParams = {}, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_listReputation", [params], ReputationPageSchema, opts),
```

Update the file's header comment (`/** Typed wrappers for the five read-only... */`) to say "six",
since this is now the sixth.

- [ ] **Step 4: Add the query key and data hook**

In `packages/devnet-ui/src/data/keys.ts`, add:

```ts
  reputation: (url: string) => ["x", url, "reputation"] as const,
```

In `packages/devnet-ui/src/data/hooks.ts`, add after `usePeers`:

```ts
export function useReputation(url: string) {
  const refetchInterval = usePollInterval(url);
  return useInfiniteQuery({
    queryKey: keys.reputation(url),
    queryFn: ({ pageParam, signal }) =>
      explorerApi.listReputation(url, { cursor: pageParam, limit: 50 }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval,
    retry: false,
  });
}
```

- [ ] **Step 5: Extend `StatusBadge` for reputation statuses**

In `packages/devnet-ui/src/ui/StatusBadge.tsx`, add to the `TONE` map:

```ts
  ok: "pass",
  throttled: "warn",
  banned: "fail",
```

Add to the `LABEL` map:

```ts
  ok: "OK",
  throttled: "Throttled",
  banned: "Banned",
```

- [ ] **Step 6: Write the failing test for the mock server's new method**

Add to `packages/devnet-ui/mock/state.test.ts`, inside the existing
`describe("MockNode protocol parity", ...)` block (find its exact boundaries by reading the file -
add before its closing `});`):

```ts
  it("answers skandha_explorer_listReputation with parity to the real schema", () => {
    const node = new MockNode({ name: "n" });
    node.setReputationEntry({
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
    const result = node.handle("skandha_explorer_listReputation", [{}]);
    expect(ReputationPageSchema.safeParse(ok(result)).success).toBe(true);
    expect(ok(result).items).toHaveLength(1);
  });

  it("rejects an invalid cursor for skandha_explorer_listReputation", () => {
    const node = new MockNode({ name: "n" });
    expect(failure(node.handle("skandha_explorer_listReputation", [{ cursor: "x" }])).code).toBe(-32600);
  });
```

Add `ReputationPageSchema` to whatever import already brings in `AdmissionPageSchema` at the top of
`state.test.ts` (check the exact existing import path - it's a relative import into `../src/protocol/schemas`,
matching the pattern every other schema import in that file already uses). This will not compile yet
(`node.setReputationEntry` doesn't exist) - that's expected; the next step confirms it fails for that
reason, not a typo.

- [ ] **Step 7: Run it, verify it fails**

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" mock/state.test.ts -t "listReputation"`
Expected: FAIL — `node.setReputationEntry is not a function` (or a TypeScript error to the same
effect). Confirm it's this, not an unrelated failure, before proceeding.

- [ ] **Step 8: Add mock server support**

In `packages/devnet-ui/mock/state.ts`, add the import of the new schema-adjacent type at the top:

```ts
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
```

Add a new private field to `MockNode`, alongside the existing `private admissions = new Map...`:

```ts
  private reputation = new Map<string, ReputationEntry>();
```

Add a new scenario-control method, in the "scenario controls" section, after `restart()`:

```ts
  /** Seeds one reputation/stake entry directly - the mock doesn't derive this from admit()/setStatus() calls (see mock/fixtures.ts's callers for why). */
  setReputationEntry(entry: ReputationEntry): void {
    this.reputation.set(entry.address.toLowerCase(), entry);
  }
```

Add a new private handler method, after `private listAdmissions(...)`:

```ts
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
```

Add a case to the `handle()` dispatcher's `switch`, after the `"skandha_explorer_listAdmissions"`
case:

```ts
      case "skandha_explorer_listReputation":
        return this.listReputation(object);
```

- [ ] **Step 9: Run it, verify it passes**

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" mock/state.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 10: Seed example fixture data**

In `packages/devnet-ui/mock/fixtures.ts`, add to `seedPrimary` (or wherever the main seeding
function is - read the file to find its exact name and the point right before its `return node;`),
three example entries covering each status:

```ts
  node.setReputationEntry({
    address: addrOf(1),
    opsSeen: 12,
    opsIncluded: 11,
    status: "ok",
    isWhitelisted: false,
    isBlacklisted: false,
    stake: "0x6f05b59d3b20000", // 0.5 ETH
    unstakeDelaySec: 86_400,
    withdrawTime: "0x0",
    isStaked: true,
  });
  node.setReputationEntry({
    address: addrOf(4),
    opsSeen: 30,
    opsIncluded: 20,
    status: "throttled",
    isWhitelisted: false,
    isBlacklisted: false,
    stake: "0x0",
    unstakeDelaySec: 0,
    withdrawTime: "0x0",
    isStaked: false,
  });
  node.setReputationEntry({
    address: addrOf(5),
    opsSeen: 50,
    opsIncluded: 5,
    status: "banned",
    isWhitelisted: false,
    isBlacklisted: false,
    stake: "0x0",
    unstakeDelaySec: 0,
    withdrawTime: "0x0",
    isStaked: false,
  });
```

`addrOf` is the existing deterministic-address helper already used throughout this file - reuse it
rather than hardcoding new literal addresses, so these entries plausibly correlate with the
transaction fixtures that already use the same senders.

- [ ] **Step 11: Write the failing UI integration test**

Add to `packages/devnet-ui/src/app.test.tsx`, in a new `describe` block (place it near the existing
`describe("peers screen", ...)` or `describe("activity screen", ...)` block - read the file to match
its existing structure and imports):

```ts
describe("reputation screen", () => {
  it("shows seeded reputation entries with status badges", async () => {
    renderApp({ path: "/reputation", instances: [A] });
    expect(await screen.findByText("OK")).toBeTruthy();
    expect(screen.getByText("Throttled")).toBeTruthy();
    expect(screen.getByText("Banned")).toBeTruthy();
  });

  it("has a nav link to the reputation tab", async () => {
    renderApp({ instances: [A] });
    const link = await screen.findByRole("link", { name: "Reputation" });
    expect(link).toBeTruthy();
  });
});
```

- [ ] **Step 12: Run it, verify it fails**

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" src/app.test.tsx -t "reputation screen"`
Expected: FAIL — no route `/reputation` exists yet, and no "Reputation" nav link exists yet.

- [ ] **Step 13: Build `ReputationScreen`**

Create `packages/devnet-ui/src/ui/screens/ReputationScreen.tsx`:

```tsx
import { useReputation } from "../../data/hooks";
import type { Instance } from "../../instances/store";
import { formatEther, shortAddress } from "../../logic/format";
import { QueryErrorBanner } from "../QueryErrorBanner";
import { StatusBadge } from "../StatusBadge";

/** Every entity this node tracks reputation and stake for. */
export function ReputationScreen({ instance }: { instance: Instance }) {
  const reputation = useReputation(instance.url);
  const items = reputation.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="reputation-title">
      <h2 id="reputation-title" className="mb-4 text-2xl">
        Reputation
      </h2>

      {reputation.isError && (
        <div className="mb-4">
          <QueryErrorBanner error={reputation.error} url={instance.url} onRetry={() => void reputation.refetch()} />
        </div>
      )}
      {reputation.data === undefined ? (
        reputation.isPending ? (
          <p role="status" className="py-8 text-ink-soft">
            Loading reputation…
          </p>
        ) : null
      ) : items.length === 0 ? (
        <div className="py-8">
          <p className="font-medium">Nothing tracked yet.</p>
          <p className="max-w-[60ch] text-ink-soft">
            An entity appears here once this node has seen a transaction that names it.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-left">
            <thead>
              <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-normal">Address</th>
                <th scope="col" className="py-2 pr-4 font-normal">Status</th>
                <th scope="col" className="py-2 pr-4 font-normal">Seen</th>
                <th scope="col" className="py-2 pr-4 font-normal">Included</th>
                <th scope="col" className="py-2 pr-4 font-normal">Stake</th>
                <th scope="col" className="py-2 font-normal">Unstake delay</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.address} className="border-b border-line align-middle">
                  <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={item.address}>
                    {shortAddress(item.address)}
                    {item.isWhitelisted && <span className="ml-2 text-ink-soft">whitelisted</span>}
                    {item.isBlacklisted && <span className="ml-2 text-fail">blacklisted</span>}
                  </td>
                  <td className="py-2.5 pr-4">
                    <StatusBadge status={item.status} />
                  </td>
                  <td className="tabular py-2.5 pr-4">{item.opsSeen}</td>
                  <td className="tabular py-2.5 pr-4">{item.opsIncluded}</td>
                  <td className="tabular py-2.5 pr-4">
                    {formatEther(item.stake)}
                    {item.isStaked && <span className="ml-2 text-ink-soft">staked</span>}
                  </td>
                  <td className="tabular py-2.5">{item.unstakeDelaySec.toLocaleString("en-US")}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reputation.hasNextPage && (
        <button
          type="button"
          onClick={() => void reputation.fetchNextPage()}
          disabled={reputation.isFetchingNextPage}
          className="mt-4 underline underline-offset-4"
        >
          {reputation.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
```

- [ ] **Step 14: Wire the route and nav link into `app.tsx`**

Add the import, alongside the other screen imports:

```ts
import { ReputationScreen } from "./ui/screens/ReputationScreen";
```

Change `TabLink`'s `to` prop type:

```ts
function TabLink({ to, children }: { to: "/" | "/activity" | "/peers" | "/reputation"; children: ReactNode }) {
```

Add the nav link, in `Header`'s `<nav>`, after the `Peers` link:

```tsx
        <TabLink to="/peers">Peers</TabLink>
        <TabLink to="/reputation">Reputation</TabLink>
```

Add a page wrapper function, after `PeersPage`:

```tsx
function ReputationPage() {
  const { selected } = useInstances();
  if (!selected) return null;
  return <NodeGate instance={selected}>{() => <ReputationScreen instance={selected} />}</NodeGate>;
}
```

Add the route, after `peersRoute`:

```ts
const reputationRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reputation", component: ReputationPage });
```

Add it to the route tree:

```ts
const routeTree = rootRoute.addChildren([poolRoute, activityRoute, peersRoute, reputationRoute, txRoute]);
```

- [ ] **Step 15: Run the tests, verify they pass**

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" src/app.test.tsx -t "reputation screen"`
Expected: PASS — both new tests.

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)"`
Expected: PASS — full suite, same baseline as before this task plus the new tests from Steps 1, 7
and 10.

Run: `cd packages/devnet-ui && bunx tsc --noEmit`
Expected: no output, exit code 0.

Run: `cd /Users/alexf/skandha && bun run build`
Expected: exit code 0.

- [ ] **Step 16: Commit**

```bash
cd /Users/alexf/skandha
git add packages/devnet-ui/mock/state.ts \
  packages/devnet-ui/mock/fixtures.ts \
  packages/devnet-ui/src/protocol/schemas.ts \
  packages/devnet-ui/src/rpc/methods.ts \
  packages/devnet-ui/src/data/keys.ts \
  packages/devnet-ui/src/data/hooks.ts \
  packages/devnet-ui/src/logic/format.ts \
  packages/devnet-ui/src/ui/StatusBadge.tsx \
  packages/devnet-ui/src/ui/screens/ReputationScreen.tsx \
  packages/devnet-ui/src/app.tsx \
  packages/devnet-ui/src/logic/logic.test.ts \
  packages/devnet-ui/mock/state.test.ts \
  packages/devnet-ui/src/app.test.tsx
git commit -m "feat(devnet-ui): add the Reputation tab

A new screen and nav tab listing every tracked entity's seen/included
counts, OK/THROTTLED/BANNED status, whitelist/blacklist membership and
on-chain stake, backed by skandha_explorer_listReputation. Follows the
existing Activity/Peers list-screen pattern exactly."
```
