# Devnet Findings Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the defects and rough edges found on 2026-09-25 when about 60 frame transactions of many shapes were sent to the public devnet's gateway and miner.

**Architecture:** Mostly small, independent fixes in `packages/executor` (admission, mempool, reconciliation), one in `packages/api` (error handling), one in `packages/cli` (build metadata), one in `packages/devnet-ui`, plus docs and a committed copy of the playground script. Two items need investigation before a fix (T5) or an upstream ethrex change (T8b). Everything else is test-first.

**Tech Stack:** TypeScript, Bun, Vitest (executor tests run from `packages/executor`), viem, Fastify, React (`packages/devnet-ui`).

**Spec:** none. The findings below come from a live run; the playground that produced them is `scratch-play.ts` (T11 commits it). Code locations were read on `develop` at `06d4bbe`.

## Findings and where they are fixed

| # | Finding (what was observed) | Root cause (read in code) | Task |
| --- | --- | --- | --- |
| F1 | A transaction with `chainId: 9` was **accepted** by both nodes, later `Cancelled` | No chain id check anywhere in admission (`Eth.admitFrameTransaction` only checks total gas limit) | T1 |
| F2 | Max fee 1 wei, 10^22 wei, or priority > max: HTTP 500 `{"error":"Unexpected behaviour"}` (not JSON-RPC, no id, no code) | `FrameTxSimulationService.simulate` turns every ethrex RPC error into `new Error("simulateFrameTransaction_failed")`; `api/src/server.ts` maps any non-`RpcError` to a bare 500 | T2 |
| F3 | Resending the same transaction: "Frame transaction cannot be replaced: fee too low" | `MempoolService.validateReplaceability` treats an identical transaction as a replacement with an equal fee | T3 |
| F4 | `Cancelled` transactions have no reason in the explorer | `FrameTxMempoolEntry.setStatus` keeps `revertReason` only for `Reverted`; the three call sites that pass one for `Cancelled` are ignored | T4 |
| F5 | 3 of a 6-transaction burst were `Cancelled` after two submissions (chain id one aside) | Not yet known. `maxSubmitAttempts: 1` plus the privileged endpoint's one-shot inclusion window are the suspects | T5 |
| F6 | The gateway's pool shows every transaction `New` forever | In `manual` mode the cron never runs, so nothing reconciles; and inclusion is only detected for `Submitted` entries | T7 |
| F7 | Many causes all read "validation prefix frame reverted" (no funds, out of gas, loop, revert) | That string is ethrex's `executionError`; the sidecar adds nothing | T8 |
| F8 | A validation frame that calls out with value shows "frame reverted", never OP-061 | Probably VERIFY frames are read-only (static), so the call reverts before any rule can fire. Unconfirmed | T8, T10 |
| F9 | Explorer header reads `the sidecar v4.1.1 ()` | The VM's tarball has no `.git`, so `write-git-data` records an empty commit; the UI prints it unconditionally | T6 |
| F10 | Malformed frames (mode 7, no signatures): "Invalid Request" with no field named | `validationFactory` throws `RpcError("Invalid Request")`; the field errors are only in `data` and the message hides them | T9 |
| F11 | Only a sender's current on-chain nonce is accepted (no queueing, no gaps) | ethrex simulation: `Nonce mismatch: expected N, got M`. Deliberate or not is an open design question | T10 (document), decision noted |
| F12 | The playground is an untracked scratch file | | T11 |
| | Redeploy both VMs and re-run the playground | | T12 |

## Global Constraints

- No ERC-4337 concepts. `ENTRY_POINT` is the fixed sentinel `0x00000000000000000000000000000000000000aa`.
- Executor tests run from inside `packages/executor` (`bunx vitest run <path>`), never from the repo root. Five files under `test/unit/` fail to load on `develop` (stale ERC-4337 fixtures, see `CLAUDE.md`); they are not part of this plan and must not be "fixed" here. Baseline before any task: 23 files pass, 5 fail, 224 tests pass.
- UI tests run from `packages/devnet-ui` with `--root` set to that directory (`bunx vitest run --root "$(pwd)"`); 228 tests pass on `develop`. Its typecheck is `bun run typecheck`; browser tests are `bun run test:e2e` (12 pass, needs Chrome).
- `@skandha/types` changes need `cd packages/types && bun run build` before dependent packages see them (imports resolve to built `lib/`).
- Commit trailers: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ`. The push target is `framepool`, never `origin` (the etherspot upstream).
- Small, self-contained fixes may be pushed straight to `develop` (the owner allowed it). T7 changes reconciliation behaviour and should go through a PR.
- The public devnet is deployed by hand (no CI): the procedure is in `deploy/devnet/README.md` ("Updating the sidecar"). T12 is the only task that touches the VMs, and each restart is a few seconds of downtime, so get the owner's go-ahead first.

## Review Focus

Inputs and conditions the fixes must keep working, most likely first. Each has a test in its owning task.

1. **Chain id:** a missing or zero `chainId`, a huge one (2^64), and a transaction that arrived over p2p (`source` `gossip:…`) must all be refused the same way as over RPC; entries already in the pool with a wrong chain id must be cancelled with a reason by revalidation, not crash it (T1).
2. **ethrex unreachable or slow:** a network error from `ethrex_simulateFrameTransaction` must still reach the client as a JSON-RPC error with the request `id`, never a bare 500 (T2).
3. **Duplicates from gossip:** receiving a transaction the node already holds must stay a silent `Ignore` for the peer, not a penalty (T3, and confirm in `packages/node`).
4. **Reasons must never be empty strings or contain secrets:** cancellation reasons are shown to anyone with the explorer URL (T4, T8).
5. **Receipt lookups are bounded:** T7 adds one lookup per `New` entry per block; with a full pool that must not become an unbounded loop of RPC calls.

---

### Task 1: Reject a wrong chain id at admission (F1)

**Files:**
- Modify: `packages/executor/src/modules/eth.ts` (`admitFrameTransaction`, before the gas limit check)
- Test: `packages/executor/test/modules/eth.test.ts`

**Interfaces:**
- Consumes: `Eth`'s private `chainId: number` (constructor argument), `CheckCollector.failed(rule, err)`, `EXPLORER_RULES.STRUCTURE`, `RpcErrorCodes.INVALID_USEROP`.
- Produces: a rejection `RpcError("frame transaction chain id X does not match this node's chain id Y", INVALID_USEROP)` recorded under the existing `structure` rule (no new rule id, so the UI's rule list and the explorer wire protocol are unchanged).

- [ ] **Step 1: Write the failing tests** in `eth.test.ts`, inside `describe("Eth.sendFrameTransaction", ...)`. `buildEth` uses chain id 1337; the file's accepted-transaction test already builds a valid tx with `chainId: 1337n` (line ~123) to copy its shape.

```ts
  it("rejects a transaction for another chain before simulating it", async () => {
    const simulate = vi.fn();
    const eth = buildEth({ frameTxSimulationService: { simulate } });
    const tx = { ...validTx(), chainId: 9n }; // validTx: the same object the accepted-transaction test builds
    await expect(eth.sendFrameTransaction(tx)).rejects.toMatchObject({
      code: RpcErrorCodes.INVALID_USEROP,
      message: expect.stringMatching(/chain id 9 does not match .* 1337/),
    });
    expect(simulate).not.toHaveBeenCalled();
  });

  it.each([0n, 2n ** 64n])("rejects chain id %s", async (chainId) => {
    const eth = buildEth();
    await expect(eth.sendFrameTransaction({ ...validTx(), chainId })).rejects.toBeInstanceOf(RpcError);
  });

  it("records the rejection under the structure rule", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({ explorer });
    await expect(eth.sendFrameTransaction({ ...validTx(), chainId: 9n })).rejects.toThrow();
    const record = explorer.listAdmissions({}).items[0]!;
    expect(record.outcome).toBe("rejected");
    expect(record.checks.find((c) => c.rule === "structure")).toMatchObject({ verdict: "fail" });
  });
```

Extract `validTx()` from the existing accepted-transaction test if it is inline (a small refactor inside the test file only).

- [ ] **Step 2: Run and watch them fail.** `cd packages/executor && bunx vitest run test/modules/eth.test.ts` → the three new tests fail (the wrong-chain transaction is accepted).
- [ ] **Step 3: Implement.** At the top of `admitFrameTransaction`:

```ts
    if (tx.chainId !== BigInt(this.chainId)) {
      throw collector.failed(
        EXPLORER_RULES.STRUCTURE,
        new RpcError(
          `frame transaction chain id ${tx.chainId} does not match this node's chain id ${this.chainId}`,
          RpcErrorCodes.INVALID_USEROP
        )
      );
    }
```

- [ ] **Step 4: Revalidation of already-pooled entries.** Read `MempoolReconciler.reconcileNew` (`services/BundlingService/reconciliation.ts`): it re-simulates each `New` entry, which does not go through `admitFrameTransaction`. Add a test in `test/services/BundlingService/reconciliation.test.ts` that a `New` entry whose `tx.chainId` differs from the reconciler's network chain id is cancelled (reason: the chain id message) instead of submitted, and implement it with the same check. The reconciler already holds a `publicClient`, so compare `entry.tx.chainId` with `await this.publicClient.getChainId()`, read once and cached in a field (`NetworkConfig` has no chain id of its own to reuse); the reason text is the same message as at admission.
- [ ] **Step 5: Run everything.** `bunx vitest run` in `packages/executor`: same 5 failing legacy files, everything else green, plus the new tests.
- [ ] **Step 6: Commit** `fix(executor): reject frame transactions for another chain id`.

---

### Task 2: Map ethrex simulation errors and unexpected errors to JSON-RPC errors (F2)

**Files:**
- Modify: `packages/executor/src/services/FrameTxSimulationService/index.ts` (the `.catch` around `simulateFrameTransaction`)
- Modify: `packages/api/src/server.ts` (the error handler)
- Create: `packages/api/src/utils/errorResponse.ts` (pure helper) and `packages/api/test/errorResponse.test.ts`; add a `test` script and Vitest config to `packages/api` (copy `packages/executor/vitest.config.js` minus the setup file; the root `vitest.base.config.ts` is shared)
- Test: `packages/executor/test/services/FrameTxSimulationService/index.test.ts`

**Interfaces:**
- Produces: `simulate()` throws `RpcError(<ethrex's detail text>, RpcErrorCodes.VALIDATION_FAILED)` when ethrex answers with a JSON-RPC error, and records it under the `simulation` rule with that same text. Any other failure (connection refused, timeout) stays an `Error` but is reported as JSON-RPC `-32603` with HTTP 200 and the request id.
- Produces (api): `toErrorResponse(err, body): { status: number; payload: object }` used by the Fastify handler.

- [ ] **Step 1: Failing tests, executor.** In `index.test.ts` (it already has `fakePublicClient`), add a client whose `request` rejects with an object shaped like viem's `RpcRequestError`: `Object.assign(new Error("RPC request failed."), { name: "RpcRequestError", details: "Vm execution error: Invalid Transaction: Insufficient max fee per gas", code: -32000 })`. Expect `simulate(tx, collector)` to reject with `RpcError` whose message is that `details` text and code `VALIDATION_FAILED`, and `collector.toChecks()` to contain `{ rule: "simulation", verdict: "fail", detail: <same text> }`. A second test: `request` rejects with `new Error("fetch failed")` → still rejects with a plain `Error` whose message contains `fetch failed` (not the old opaque string).
- [ ] **Step 2: Failing tests, api.** `errorResponse.test.ts`: `RpcError("boom", -32602)` → status 200, payload `{ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "boom" } }`; a plain `Error("x")` → status 200, `error.code === -32603`, message "Internal error", `id` echoed; a Fastify validation error with `statusCode: 400` keeps 400. The request `body` may be missing or an array: fall back to `id: null`.
- [ ] **Step 3: Run and watch both fail.**
- [ ] **Step 4: Implement the executor side.**

```ts
      .catch((error) => {
        this.logger.error(error, "ethrex_simulateFrameTransaction failed");
        const detail =
          typeof error?.details === "string" && error.details.length > 0
            ? error.details
            : undefined;
        collector?.fail(
          EXPLORER_RULES.SIMULATION,
          detail ?? `ethrex_simulateFrameTransaction call failed: ${error?.message ?? error}`
        );
        if (detail) throw new RpcError(detail, RpcErrorCodes.VALIDATION_FAILED);
        throw new Error(`ethrex_simulateFrameTransaction call failed: ${error?.message ?? error}`);
      });
```

- [ ] **Step 5: Implement the api side.** Move the mapping out of the inline handler into `toErrorResponse`, and have `server.ts` call it: `RpcError` → 200 with `{jsonrpc, id, error:{message,data,code}}` (as today), everything else → 200 with `error.code -32603, message "Internal error"` (log the real error server-side; never echo internals to the client), except errors that carry a `statusCode` of 4xx (Fastify body-parse errors), which keep their status.
- [ ] **Step 6: Run both suites; rebuild** (`bun run build`) and smoke-test the three fee inputs from the playground (`scratch-play.ts`, scenarios "fee below the base fee", "absurd fee", plus priority > max) against a local devnet or the redeployed gateway: each now returns a JSON-RPC error whose message is ethrex's text.
- [ ] **Step 7: Commit** `fix(executor,api): report ethrex simulation errors and unexpected errors as JSON-RPC errors`.

---

### Task 3: "Already known" for a duplicate transaction (F3)

**Files:**
- Modify: `packages/executor/src/services/MempoolService/service.ts` (`validateReplaceability` / `validateFrameTxReplaceability`)
- Test: `packages/executor/test/services/MempoolService/addFrameTx.test.ts` (or a new `replaceability.test.ts` beside it; follow how that file builds a `MempoolService`)

**Interfaces:**
- Produces: `RpcError("Frame transaction already known", RpcErrorCodes.INVALID_USEROP)` when the incoming transaction's hash (`keccak256(encodeRawFrameTx(tx))`, the same value `Eth` uses as `txHash`) equals the existing entry's `txHash`. The explorer already leaves the original record untouched for a refused resubmission (see `Eth.recordRejection`).

- [ ] **Step 1: Failing test:** add an entry, then call `validateFrameTxReplaceability` with the identical transaction: expect rejection with message `/already known/`; with the same `sender:nonce` but a different transaction and a fee below the 10% bump: still `/cannot be replaced/`; with a sufficient bump: resolves `true`.
- [ ] **Step 2: Implement.** `validateFrameTxReplaceability(tx)` builds `new MempoolEntry(tx)` with no `txHash`, so compute the hash there and compare with `oldEntry.txHash` before calling `canReplaceWithTTL`. Keep `validateReplaceability`'s existing signature for its other callers.
- [ ] **Step 3: Gossip path.** Read `packages/node/src/network/processor/gossipValidatorFn.ts`: any thrown error becomes `TopicValidatorResult.Ignore` (no peer penalty). Add a one-line comment there naming duplicates as the common case, or a test if a gossip test harness exists; do not change behaviour.
- [ ] **Step 4: Run the executor suite; commit** `fix(executor): say "already known" for a resubmitted transaction`.

---

### Task 4: Keep the reason a transaction was cancelled (F4)

**Files:**
- Modify: `packages/executor/src/entities/FrameTxMempoolEntry.ts` (`setStatus`)
- Modify: `packages/devnet-ui/src/ui/screens/TxScreen.tsx` (the "Revert reason" fact)
- Test: `packages/executor/test/entities/` (find or create the entry test file), `packages/executor/test/services/ExplorerService/`, `packages/devnet-ui/src/app.test.tsx`

**Interfaces:**
- Produces: `entry.revertReason` is set for `Cancelled` as well as `Reverted`; the explorer's `dropped` event then carries it (`ExplorerService.attach` already passes `entry.revertReason` for `Cancelled`), and `getTransaction.entry.revertReason` shows it.

- [ ] **Step 1: Failing tests.** Entry: `setStatus(Cancelled, { revertReason: "banned" })` then `revertReason === "banned"`; a later `setStatus(New)` clears it (add a `New` case that resets `revertReason`, otherwise a requeued entry keeps a stale reason). ExplorerService: emitting `submittedUserOps` for a `Cancelled` entry with a reason yields a `dropped` event with `reason`.
- [ ] **Step 2: Implement** `case MempoolEntryStatus.Cancelled: this.revertReason = params?.revertReason; break;` and clear it in `New`.
- [ ] **Step 3: UI.** The fact is labelled "Revert reason" for every status. Label it "Why it was dropped" when `entry.status === "Cancelled"` (test through the mock: add a Cancelled fixture with a reason to `mock/fixtures.ts` and assert the text). The Timeline already prints an event's `reason`.
- [ ] **Step 4: Run both suites; commit** `fix(executor,devnet-ui): keep and show why a transaction was cancelled`.

---

### Task 5: Find out why a burst of transactions was cancelled (F5)

Investigation first; the fix depends on the result. Do not change behaviour before Step 4.

**Files:**
- Create (scratch, not committed): a burst script based on `scratch-play.ts` (T11) that sends N transactions from N distinct funded keys straight to the miner within one second.
- Later modify: `packages/executor/src/config.ts` defaults (`maxSubmitAttempts`, `bundleSize`, `bundleInterval`) or the relayer, depending on the finding.

- [ ] **Step 1: Reproduce.** With T4 deployed (so the reason is visible), send bursts of 2, 4, 6 and 10 transactions to the miner, then read each transaction's events (`skandha_explorer_getTransaction`) and its final status after 60 s. Record which of the burst were `OnChain` and which `Cancelled`, and the reason.
- [ ] **Step 2: Read the miner's log around one cancelled transaction** (`journalctl -u skandha-miner`) and ethrex's (`docker compose logs ethrex` in `~/devnet`) for the privileged submission (`ethrex_submitPrivilegedFrameTransaction`): was it accepted, and did the next payload include it? Also read `PrivilegedRelayer` and `BundlingService.sendNextBundle` for how many entries are relayed per tick (`bundleSize: 4`, `maxConcurrentSubmissions: 10`, `bundleInterval: 10000`).
- [ ] **Step 3: Write the finding** in this plan (append a "T5 finding" paragraph) with the cause and evidence. Candidate causes, to be confirmed or discarded: (a) `maxSubmitAttempts: 1` cancels an entry the second time it misses the one-shot window; (b) the privileged endpoint takes only some submissions per payload; (c) a requeued `New` entry is not resubmitted until the next tick and the block is missed again.
- [ ] **Step 4: Fix per finding**, test-first: for (a) raise the devnet's `maxSubmitAttempts` (a config value, no code) and make the cancel reason state the attempt count (`"relayed N times without being included"`); for (b)/(c) file a task in this plan. Whatever the cause, the cancellation reason must name it (T4 makes it visible).
- [ ] **Step 5: Commit** the finding and any config/code change.

---

#### T5 finding (recorded 2026-09-25)

- **What happened.** In the first playground run, transactions "burst 4/6" to "6/6" (plus the wrong-chain one, which is a different case) ended `Cancelled`. Their events: `admitted`, `Submitted`, `Submitted`, `dropped`, with no reason (T4 now records one). Two submissions to the privileged endpoint each missed their payload; `BundlingService.selectEntries` cancels an entry once `submitAttempts > maxSubmitAttempts`, and the default was `1`.
- **Reproduction.** Not reproduced. After the fixes were deployed, the same burst ran twice more with every transaction landing (some needed a second submission: events `Submitted`, `Submitted`, `included`, admitted about 35 s before the first submission because the cron relays on a 10 s tick). The first run also sent a 20 KB-calldata and a 40-frame transaction moments earlier, which likely crowded the next payloads. That is a hypothesis, not a measurement.
- **A false lead, recorded so nobody repeats it.** Re-running the burst with `--only burst --keys-from 22` made every transaction fail with "validation prefix frame reverted". That was the playground's own bug: skipped scenarios still consumed keys, so the burst landed on `s31+`, which are unfunded. Comparing ethrex's direct `ethrex_simulateFrameTransaction` with the sidecar's answer for 40 transactions over 100 seconds showed them always agreeing. Fixed in the tool (`--keys-from` now rotates `s1`..`s30`).
- **Fix.** The default `maxSubmitAttempts` is now 3 (a missed one-shot payload is retried twice more before giving up), and the cancellation reason says how many times it was relayed ("relayed N times without being included in a block"). If cancellations still appear under load, the next step is measuring the privileged endpoint's per-payload capacity in ethrex (open question for the ethrex side).

### Task 6: Show a commit only when there is one, and record it in tarball deploys (F9)

**Files:**
- Modify: `packages/devnet-ui/src/app.tsx` (header text), `packages/devnet-ui/src/app.test.tsx`
- Modify: `packages/cli/src/util/git.ts` (`getCommit`, `getBranch`)
- Modify: `deploy/devnet/README.md` ("Updating the sidecar")

**Interfaces:**
- Produces (cli): `getCommit()` returns `process.env.SKANDHA_GIT_COMMIT` when set and non-empty, before trying `git`; likewise `SKANDHA_GIT_BRANCH`. The tarball procedure builds with `SKANDHA_GIT_COMMIT=$(git rev-parse --short HEAD) bun run build`. (`bun run build` runs `write-git-data`, which today writes an empty commit when there is no `.git`.)

- [ ] **Step 1: UI test:** with `info.commit === ""` the header line is `Chain 1337, auto bundling, the sidecar 4.1.1, p2p on` (no parentheses); with a commit it keeps `(a1b2c3d)`. The mock's `info` has a commit, so add a `MockNode` option to blank it, or a component-level test of the string builder (extract `describeNode(info)` into `src/logic/format.ts` and test it there).
- [ ] **Step 2: Implement** the UI change. Step 3: cli test if `packages/cli` has a test setup, otherwise verify by hand: `SKANDHA_GIT_COMMIT=abc1234 bun packages/cli/lib/util/writeGitData.js && cat packages/cli/.git-data.json`.
- [ ] **Step 4: Docs.** In "Updating the sidecar", pass the variable when building on the VM and mention that the gateway's tree is copied from the miner's build.
- [ ] **Step 5: Commit** `fix(devnet-ui,cli): hide an empty commit and let deploys record one`.

---

### Task 7: Track inclusion without relaying, for the gateway (F6)

The largest change; put it in a PR.

**Files:**
- Modify: `packages/executor/src/services/BundlingService/service.ts` (`restartCron`, `tryBundle`)
- Modify: `packages/executor/src/services/BundlingService/reconciliation.ts` (inclusion detection for `New` entries)
- Test: `packages/executor/test/services/BundlingService/reconciliation.test.ts`, `service.test.ts`
- Docs: `docs/sidecar_explorer.md` (bundling modes), `deploy/devnet/README.md` ("Gateway node")

**Interfaces:**
- Consumes: `ReceiptService.getReceipt(txHash)`; the frame transaction's own hash **is** the on-chain hash (`txHash = keccak256(encodeRawFrameTx(tx))`, "used as the standard `eth_getTransactionReceipt` key" in `Eth.sendFrameTransaction`'s doc), so a `New` entry can be looked up directly.
- Produces: in every bundling mode the cron runs `reconciler.reconcile()`; only in `auto` mode does it also call `sendNextBundle()`. For a `New` entry the reconciler first asks for a receipt: found → `OnChain` (success) or `Reverted` (with `describeRevert`), not found → the existing revalidation.

- [ ] **Step 1: Failing tests (reconciliation).** A `New` entry with a successful receipt becomes `OnChain`; with a failed receipt `Reverted` and a reason; with `getReceipt` rejecting `RpcError` (no receipt) it is revalidated as today; with `getReceipt` rejecting a transport error it is left untouched and not cancelled.
- [ ] **Step 2: Failing tests (service).** In `manual` mode `restartCron` still schedules the interval and `tryBundle` calls `reconcile()` but never `sendNextBundle()`; `auto` calls both, in that order.
- [ ] **Step 3: Implement.** Bound the work: at most `receiptLookupRange`-limited lookups already exist in `ReceiptService`; additionally cap `New` entries checked per pass (a constant, e.g. 50, oldest first) so a large pool cannot turn each block into hundreds of RPC calls. Log, do not throw, on transport errors.
- [ ] **Step 4: Check the explorer path.** `MempoolService.updateStatus(OnChain)` emits `onChainUserOps`, which the explorer records as `included`; add a test that a `New` entry reconciled to `OnChain` produces that event (`test/services/ExplorerService`).
- [ ] **Step 5: Docs.** Document that `manual` mode still follows the chain (so a gateway's pool empties as the miner includes its transactions) and describe the gateway/miner split.
- [ ] **Step 6: Run the suite, open a PR** `feat(executor): follow inclusion in manual bundling mode`.

---

### Task 8: Say more than "validation prefix frame reverted" (F7, F8)

**Files:**
- Modify: `packages/executor/src/services/UserOpValidation/validators/frameTx.ts` (the `!simResult.valid` branch) or `FrameTxSimulationService/index.ts`
- Test: `packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts`

Two parts: **8a** (the sidecar, in this repo) and **8b** (upstream ethrex, a written request).

**Interfaces:**
- Consumes: `EthrexSimulateFrameTransactionResult` (`types/src/executor/validation/ethrexFrameTx.ts`): `maxCost` is always present, `payer` is null on failure, `executionError` is ethrex's text, `frames` is null on failure.
- Produces: when `executionError` is the prefix-revert text, the rejection message becomes more specific whenever the sidecar can tell: `payer 0x… has 12 wei, the transaction's maximum cost is 3400000 wei` (balance check via `publicClient.getBalance(payer)` where the payer is the sender for a self-relay prefix or the pay frame's target for a paymaster prefix), else `validation prefix frame reverted (frame limits: 30000, 50000; a frame may also have run out of gas)`. The rule stays `simulation`.

- [ ] **Step 1: Failing tests.** (a) prefix revert + payer balance below `maxCost` → message names the balance and the cost; (b) prefix revert + enough balance → message keeps ethrex's text and lists the prefix frame gas limits; (c) `getBalance` rejecting → falls back to (b), never throws.
- [ ] **Step 2: Implement 8a.** The validator has no public client today: pass a `getBalance` function into `FrameTxValidationService`'s constructor from `Executor` (which owns the client) so tests can fake it.
- [ ] **Step 3: 8b, the request for ethrex** (write it as `docs/ethrex-requests.md`, no code here): return, with a failed simulation, the index of the frame that failed and the halt reason (`revert` with data, `out of gas`, `stack`/`invalid opcode`, `static call violation`), so the sidecar can name the rule (`out-of-gas`, `execution`) instead of one generic simulation failure. Include the six scenarios from the playground that all produce "validation prefix frame reverted".
- [ ] **Step 4: Confirm F8.** With a local ethrex (or the devnet), call `ethrex_simulateFrameTransaction` on the playground's `VALCALL` wallet and on a variant that only reads storage; if the value call reverts because VERIFY frames are static, record that in `docs/sidecar_explorer.md`'s rule table under OP-061 ("in a VERIFY frame a value call reverts before this rule can fire") rather than changing code.
- [ ] **Step 5: Run; commit** `feat(executor): explain validation-prefix failures when the cause is known`.

---

### Task 9: Name the invalid field in "Invalid Request" (F10)

**Files:**
- Modify: `packages/api/src/utils/RpcMethodValidator.ts`
- Test: `packages/api/test/rpcMethodValidator.test.ts` (uses the Vitest setup T2 adds to `packages/api`)

**Interfaces:**
- Produces: `RpcError("Invalid Request: <path>: <first constraint message>", INVALID_REQUEST, { data: { errors } })`, e.g. `Invalid Request: frames.0.mode: mode must be one of the following values: 0, 1, 2`. Nested errors use a dotted path (walk `ValidationError.children`).

- [ ] **Step 1: Failing test** with the real DTO (`SendFrameTransactionDto`): a body whose `frames[0].mode` is 7 and one with no `signatures` each yield a message that names the field.
- [ ] **Step 2: Implement** `describeValidationErrors(errors: ValidationError[]): string` (first three leaf errors, `; `-joined) next to `validationFactory` and use it for the message; keep `data.errors` unchanged for clients that read it.
- [ ] **Step 3: Run; commit** `fix(api): name the invalid field in Invalid Request`.

---

### Task 10: Document what the playground showed (F8, F11, F6)

**Files:**
- Modify: `deploy/devnet/devnet-readme.md` (section "Known limitations" / 5. The sidecar APIs), `docs/sidecar_explorer.md`

- [ ] **Step 1: One in flight per sender.** State that the node accepts only a sender's current on-chain nonce (`Nonce mismatch: expected N, got M` for anything else): no queueing, no gaps, so a sender sends its next transaction after the previous one lands. **Decision for the owner, recorded here, not implemented:** whether the alt mempool should queue future nonces like a normal mempool. It changes admission, replacement and reconciliation, so it needs its own design.
- [ ] **Step 2: Gateway/miner behaviour**: what `manual` bundling means (T7 makes its status follow the chain), and that transaction status is per node.
- [ ] **Step 3: Playground findings table** (the Outcomes summary from the run) and the rule of thumb that VERIFY frames are read-only (T8 step 4 confirms it).
- [ ] **Step 4: Commit** `docs(devnet): document nonce handling, gateway status and what the playground exercises`.

---

### Task 11: Commit the playground as a tool (F12)

**Files:**
- Create: `deploy/devnet/playground/play.ts`, `deploy/devnet/playground/README.md`
- Source: the untracked `scratch-play.ts` from the run of 2026-09-25 (it lives in the worktree `.worktrees/devnet-explorer-ui`; recover it from there or rewrite from the scenario table below)

- [ ] **Step 1: Make it configurable.** Read the two node URLs, the ethrex URL, the chain id and the funder key from environment variables with the devnet values as defaults (the funder key is the documented throwaway devnet key, and must never be used elsewhere: say so in the README); take the state file path from `PLAYGROUND_STATE` (default `./.playground-state.json`, git-ignored).
- [ ] **Step 2: Add `--only <substring>`** to run a subset of scenarios, and `--pause <ms>` between sends (default 400) so a person can watch the explorer.
- [ ] **Step 3: Print a results table** at the end (already does: name, node, miner status, gateway status).
- [ ] **Step 4: README**: `setup` then `play`, what each group of scenarios demonstrates, that it spends a little devnet ETH from the shared account, that each sender can only have one transaction in flight (T10), and the expected outcomes after T1 to T4 (wrong chain id rejected; fee errors readable; duplicate "already known"; cancellations with a reason).
- [ ] **Step 5: Commit** `feat(devnet): add a traffic playground for the explorer`.

The scenarios (from the run): accepted, ordinary (EOA transfer, three transfers, atomic batch plus tail, 20 KB calldata, 40 frames, contract wallet self-pay, paymaster-sponsored); accepted but the execution fails (reverting frame, out of gas, reverting atomic batch, calling the approving wallet, value above the balance); low or absurd fees; replacement and duplicates on one key; a burst from six keys; rejected for prefix or structure (no verify frame, verify targets a stranger, atomic flag on a verify or last frame, verify after the prefix, 65 frames, no frames, wrong chain id, verify gas above the cap, unknown mode, no signature entry); rejected for signature or simulation (wrong key, no funds, nonce used, nonce in the future, out of gas, loop, no approve, revert); ERC-7562 (five banned opcodes, foreign storage, value call, code of an empty address).

---

### Task 12: Redeploy and re-run (all)

Requires the owner's go-ahead: two short restarts on the public devnet.

- [ ] **Step 1: Deploy the miner, then the gateway**, following `deploy/devnet/README.md` "Updating the sidecar" (tarball of `framepool/develop`, build beside the live copy, stop, swap, start), with `SKANDHA_GIT_COMMIT` set (T6). Keep `~/skandha-old` for rollback.
- [ ] **Step 2: Verify the basics** as before: `skandha_explorer_info` on both, each lists the other as a peer, one transaction sent to the gateway reaches `OnChain` on the miner.
- [ ] **Step 3: Re-run the playground** and check each finding against the table above: F1 the wrong-chain transaction is rejected with the chain id message; F2 the three fee inputs return JSON-RPC errors with ethrex's text; F3 resends say "already known"; F4 a cancelled transaction shows why; F5 per T5's result; F6 the gateway's pool shows `OnChain` for what the miner included; F7 the no-funds case names the balance; F9 the header has a commit; F10 `unknown frame mode` names the field.
- [ ] **Step 3: Update the results** in `deploy/devnet/playground/README.md` and close the plan: delete nothing from the repo; note in the PR/commit which findings are fixed and which remain open (T5's follow-ups, T8b upstream, the nonce-queueing decision).

## Order and risk

1. T1, T2, T3, T4, T6, T9: independent, small, can run in parallel branches; push to `develop` directly.
2. T5 after T4 (needs the reason visible).
3. T7 by itself, as a PR: it changes reconciliation.
4. T8a after T2 (both touch the simulation failure path); T8b is a written request.
5. T10 and T11 any time after T1 to T4 (they describe the fixed behaviour).
6. T12 last.

Risk notes: T1 changes admission for every transaction (existing tests that build transactions with `chainId: 1n` for a chain-1337 `Eth` will fail and need their fixtures updated; `explorer.test.ts` builds a chain-1 transaction but does not go through admission); T7 adds RPC calls per block (bounded above); T2 changes the HTTP status of unexpected errors from 500 to 200 with a JSON-RPC error body, which is what JSON-RPC clients expect but is a behaviour change worth a line in the changelog.
