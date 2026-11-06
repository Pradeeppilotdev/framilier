# Frame Transaction Sidecar Testing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish confidence that the frame-tx sidecar (`2026-09-02-frame-tx-bundler-fork.md`) correctly implements the combined ERC-7562 + EIP-8141 standard (`erc-7562.md`, per `2026-09-02-erc7562-native-aa-mempool-spec.md`), using [ethrex](https://github.com/lambdaclass/ethrex) — the most functional current EIP-8141 implementation — as the execution-client oracle and RLP/gas-accounting ground truth.

**Architecture:** Four layers, cheapest and most isolated first:
1. **Unit tests** — already specified per-task in the fork plan; not duplicated here, only referenced.
2. **Fixture/conformance tests** — the sidecar's pure functions (RLP codec, `compute_sig_hash`, gas accounting) checked against real EIP-8141 conformance test vectors, independent of a live node.
3. **Differential oracle tests** — a live `ethrex --dev` node as the admission/execution oracle. For every `erc-7562.md` rule that is *not* marked "ERC-4337 only" and *not* one of the staking/reputation rules our combined standard restores beyond EIP-8141's own public-mempool policy, the sidecar's admission decision must agree with ethrex's own local `ValidationObserver` policy. For the restored staking rules (which ethrex's conservative policy does *not* implement — see Known Divergences below), the tests instead assert the *documented* divergence, using ethrex purely as an execution/state oracle via the `erc7562FrameTracer` from the companion tracer plan, not as an admission oracle.
4. **End-to-end devnet test** — sidecar + two peered `ethrex --dev` nodes, confirming a submitted frame transaction lands on-chain and propagates over ethrex's standard devp2p transaction gossip to the second node (frame transactions are real transactions — see Known Divergences — so this is *not* a bespoke libp2p gossip test the way the fork plan's original Task 26 assumed).

**Tech Stack:** Vitest (matching the fork plan's existing test tooling), a locally-built or `ghcr.io/lambdaclass/ethrex:main` Docker-imaged `ethrex` binary run in `--dev --datadir memory` mode, the `erc7562FrameTracer` from `2026-09-02-ethrex-native-tracer.md`.

**Spec:**
- `/Users/alexf/ERCs/ERCS/erc-7562.md` — the rule source every differential test's expectation is derived from.
- `/Users/alexf/skandha/docs/plans/2026-09-02-frame-tx-bundler-fork.md` — the sidecar under test.
- `/Users/alexf/skandha/docs/plans/2026-09-02-ethrex-native-tracer.md` — **hard prerequisite for Layer 3 and Layer 4.** Do not start Tasks 6–9 below until that plan's Task 9 (end-to-end tracer verification) is checked off.
- `docs/eip-8141.md` in `lambdaclass/ethrex` (fetched in full during this planning session, 755 lines) — the ground truth for ethrex's actual behavior, including its 12 documented spec-interpretation choices and known limitations, which take precedence over the paper EIP-8141 text for any test run against ethrex specifically.

## Known Divergences (read before writing any test expectation)

These are facts established during this planning session's research, not assumptions. Every test task below that touches one of these areas must encode the divergence explicitly, not treat it as a bug to "fix" in either the sidecar or the test.

1. **Frame transactions propagate over standard devp2p, not a bespoke mempool.** ethrex advertises them via `NewPooledTransactionHashes`/`GetPooledTransactions` like EIP-4844 blobs (`docs/eip-8141.md` §P2P propagation). This means Layer 4's "does it propagate" test is a standard tx-gossip test, not a libp2p/gossipsub integration test.
2. **ethrex's own local mempool policy (`ValidationObserver`) matches EIP-8141's public-mempool baseline, not our combined standard.** It has no staking, no associated-storage carve-outs, and treats every paymaster as non-canonical (`MAX_PENDING_TXS_USING_NON_CANONICAL_PAYMASTER = 1` effectively for everyone, per OQ1). A transaction our sidecar admits under `erc-7562.md`'s restored `[STO-031]`/`[STO-032]`/`[STO-033]` staked-entity carve-outs will be **rejected by a plain ethrex node's own local mempool** — this is expected, not a bug, and such a transaction must reach a block builder some other way (direct submission to a builder/relay that doesn't run `ValidationObserver`, not through `ethrex`'s own `eth_sendRawTransaction` → local mempool → propagate path). Layer 3 tests for these rules must assert this exact shape of divergence, not "both agree."
3. **`debug_traceCall` on ethrex has no custom-JS-tracer support** — only named tracers (`callTracer`, `prestateTracer`, `opcodeTracer`, and after the companion plan lands, `erc7562FrameTracer`). Any test infrastructure here must request `erc7562FrameTracer` by name, never assume a stringified-JS-tracer path works.
4. **`SETDELEGATE` does not exist in ethrex's opcode set (OQ4).** `erc-7562.md`'s `[FRA-060]` deploy-frame-delegation rule is only partially exercisable against ethrex: `CREATE`/`CREATE2`/sender-`SSTORE` paths are testable, `SETDELEGATE` is not. Do not write a test asserting `SETDELEGATE` behavior against ethrex; mark that sub-case as `skip`/`todo` with a comment citing this line.
5. **ethrex's frame `gas_limit` bound is `2**63-1`, stricter than EIP-8141's `2**64-1`** (`docs/eip-8141.md` §12). A gas-limit boundary test written against the paper spec's `2**64-1` ceiling will fail against ethrex specifically for values in `[2**63, 2**64-1)`; boundary tests must target `2**63-1` when running against this client.
6. **No access-list pre-warming for frame targets** (`docs/eip-8141.md` §5) — every frame target's first `SLOAD`/`SSTORE` is a cold access. Gas-estimation conformance tests must account for this or they will systematically under-estimate relative to what ethrex actually charges.
7. **Blob-carrying frame transactions are rejected at ethrex's mempool** (`docs/eip-8141.md` §Known Limitations). Layer 3/4 tests must not construct blob-carrying frame transactions against ethrex; that path is explicitly out of scope until ethrex adds sidecar transport.

## Global Constraints

- Every differential test (Layer 3) MUST cite the specific `erc-7562.md` rule ID it's checking, in the test's own name or a comment — a differential test with no traceable rule ID is not allowed.
- Every test that encodes one of the seven Known Divergences above MUST cite this section by number in a comment, so a future ethrex upgrade that resolves one (e.g., ethrex eventually implementing `SETDELEGATE`, or pinning a canonical paymaster per OQ1) is discoverable by grepping for that citation, not by re-deriving the divergence from scratch.
- Pin the exact `ethrex` version/commit this plan's tests run against (Task 1) and re-run the full suite whenever that pin moves — ethrex is under active development and its own `docs/eip-8141.md` explicitly tracks a moving EIP-8141 spec commit; a silent version drift invalidates every Known Divergence claim above.
- No test in this plan may take longer than necessary to set up a fresh `ethrex --dev` instance per test file (not per test case) — devnet startup cost should be amortized across a file's test suite via a shared `beforeAll`, matching the fork plan's existing e2e test conventions.

---

## File Structure

| Path | Responsibility |
|---|---|
| `test/conformance/fixtures/` | Vendored EIP-8141 conformance test vectors (Task 1) |
| `test/conformance/codec.conformance.test.ts` | RLP/`compute_sig_hash` fixture tests (Task 2) |
| `test/conformance/gasAccounting.conformance.test.ts` | Gas-formula fixture tests (Task 3) |
| `test/differential/ethrexDevnet.ts` | Shared helper: spin up/tear down a local `ethrex --dev` instance (Task 4) |
| `test/differential/generalRules.differential.test.ts` | Layer 3 tests for rules ethrex's own policy also enforces (Task 6) |
| `test/differential/stakingRules.differential.test.ts` | Layer 3 tests for the restored staking rules ethrex does *not* enforce (Task 7) |
| `test/e2e/devnetInclusion.e2e.test.ts` | Layer 4: submission → inclusion → standard devp2p propagation (Task 8) |
| `test/regression/knownDivergences.test.ts` | Task 9: one test per Known Divergence, pinned so an ethrex upgrade that changes one is caught |
| `.github/workflows/frame-tx-tests.yml` (or equivalent CI config) | Task 10 |

---

### Task 1: Locate and vendor EIP-8141 conformance fixtures

**Files:**
- Create: `test/conformance/fixtures/` (populated by this task)
- Create: `test/conformance/VENDORED_FIXTURES.md` (records exact source, version, and vendoring date)

**Interfaces:**
- Consumes: nothing.
- Produces: a pinned, version-recorded set of EIP-8141 conformance test vectors for Tasks 2–3 to run against.

- [ ] **Step 1: Locate the fixture release**

`docs/eip-8141.md` references a `tests-frames-devnet@v0.0.0` release carrying fixture paths like `eip8141_frame_transactions/frame_transactions/atomic_batch_rollback`, `eip8141_frame_transactions/block_access_lists/bal_atomic_batch_write`, `eip8141_frame_transactions/block_access_lists/bal_atomic_batch_skipped_frame_absent` — this session's research did not find this exact tag under `lambdaclass/ethrex` or `ethereum/execution-spec-tests`'s top-level releases; it is likely a pre-release, a fork-specific tag, or hosted under a different org tied to the EIP-8141 devnet effort (the `glamsterdam-devnet@v6.0.0`/`tests-glamsterdam-devnet@v6.0.0` naming convention found in `ethereum/execution-specs` issue tracking during this research is the right pattern to search for — a `tests-<fork-name>-devnet@vX.Y.Z` tag, where `<fork-name>` is whatever the fork after Glamsterdam carrying EIP-8141 is called; `docs/eip-8141.md` refers to it as "Hegota").

```bash
gh api repos/ethereum/execution-spec-tests/releases --jq '.[] | select(.tag_name | contains("hegota") or contains("frames"))'
gh api search/repositories -f q='eip8141 fixtures' --jq '.items[].full_name'
```

If the exact release cannot be located, fall back to generating fixtures locally by running `execution-spec-tests`' own `fill` command against its EIP-8141 test source (search `ethereum/execution-spec-tests` for a `tests/*/eip8141*` directory) — record whichever path actually worked in `VENDORED_FIXTURES.md`, including the exact commit/tag and the command used.

- [ ] **Step 2: Vendor the fixtures**

Download or generate the fixture JSON files into `test/conformance/fixtures/`, preserving their upstream directory structure (`eip8141_frame_transactions/frame_transactions/...`, `eip8141_frame_transactions/block_access_lists/...`) so future re-vendoring is a straightforward diff.

- [ ] **Step 3: Record provenance**

```markdown
# Vendored EIP-8141 Conformance Fixtures

Source: [exact URL/release tag found in Step 1]
Vendored: [date]
Fixture count: [N]
Notably includes: atomic_batch_rollback, bal_atomic_batch_write, bal_atomic_batch_skipped_frame_absent
(these three are the ones docs/eip-8141.md §11 in lambdaclass/ethrex cites as settling the
atomic-batch-unroll gas/status/logs question — see Known Divergences item 5's neighbor
concern, ethrex's own §12 gas_limit bound, for the general pattern of "check ethrex's docs
before trusting the paper spec.")
```

- [ ] **Step 4: Commit**

```bash
git add test/conformance/fixtures test/conformance/VENDORED_FIXTURES.md
git commit -m "test: vendor EIP-8141 conformance fixtures"
```

---

### Task 2: RLP codec fixture conformance

**Files:**
- Create: `test/conformance/codec.conformance.test.ts`

**Interfaces:**
- Consumes: `encodeFrameTx`/`decodeFrameTx`/`computeSigHash` from the fork plan's Task 6; vendored fixtures from Task 1.
- Produces: proof that the sidecar's RLP codec produces byte-identical output to whatever ground truth the fixtures encode (or, if the fixtures are execution-outcome fixtures rather than raw-encoding fixtures, proof that decoding a fixture's raw transaction bytes and re-encoding them round-trips).

- [ ] **Step 1: Survey the vendored fixtures' actual shape**

Read a handful of the fixture JSON files from Task 1. Confirm whether they carry raw RLP-encoded transaction bytes directly (in which case this task decodes them with the sidecar's codec and asserts round-trip equality) or only structured pre-RLP transaction objects plus expected post-execution state (in which case this task instead RLP-encodes the structured object with the sidecar's codec and confirms the resulting bytes decode back to the same object — a weaker but still meaningful check, since there's no independent "correct" RLP byte string to compare against without an oracle encoder).

- [ ] **Step 2: Write the failing conformance test**

```typescript
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { encodeFrameTx, decodeFrameTx } from "../../packages/executor/src/services/FrameTxService/codec.js";

describe("EIP-8141 fixture RLP conformance", () => {
  const fixtureDir = "test/conformance/fixtures/eip8141_frame_transactions";
  const fixtureFiles = readdirSync(fixtureDir, { recursive: true }).filter((f) => f.toString().endsWith(".json"));

  for (const file of fixtureFiles) {
    it(`round-trips ${file}`, () => {
      const fixture = JSON.parse(readFileSync(`${fixtureDir}/${file}`, "utf-8"));
      // Implementer note: the exact extraction of a FrameTransaction shape
      // from `fixture` depends on Step 1's finding -- do not guess the
      // fixture schema here, fill this in against the real, surveyed shape.
    });
  }
});
```

- [ ] **Step 3: Confirm failure (or, if Step 1 revealed the fixtures need a schema-mapping step first, implement that mapping before the round-trip assertion can even run)**

```bash
bun run vitest run test/conformance/codec.conformance.test.ts
```

- [ ] **Step 4: Iterate until every vendored fixture round-trips**

Expected: 100% of the fixtures in `eip8141_frame_transactions/frame_transactions/` round-trip cleanly. Any fixture that doesn't is either a genuine codec bug (fix it) or a fixture that intentionally encodes a malformed/invalid transaction to test rejection (confirm which, and if the latter, assert the codec's `decodeFrameTx` throws rather than silently produces garbage — do not skip these, they're testing the codec's error path).

- [ ] **Step 5: Commit**

```bash
git add test/conformance/codec.conformance.test.ts
git commit -m "test: RLP codec conformance against vendored EIP-8141 fixtures"
```

---

### Task 3: Gas accounting fixture conformance

**Files:**
- Create: `test/conformance/gasAccounting.conformance.test.ts`

**Interfaces:**
- Consumes: the fork plan's gas-accounting logic (wherever it lands — the fork plan's Task 20/`FrameTxSimulationService` and Task 22/`eth.ts`'s markup arithmetic both touch this; confirm the actual location once the fork plan has progressed past those tasks, don't assume it here).
- Produces: proof that the sidecar's `frame_tx_intrinsic_gas`/`calldata_floor_gas`/`max_gas` computation matches ethrex's own (per `docs/eip-8141.md` §Gas Accounting, already fetched in full: `FRAME_TX_INTRINSIC_COST = 15000`, `FRAME_TX_PER_FRAME_COST = 475`, the EIP-7623/7976 floor-per-token values) for every fixture from Task 1 that includes an expected gas-used outcome.

- [ ] **Step 1: Confirm the sidecar's intrinsic-cost constant matches ethrex's, not a stale value from an earlier EIP-8141 draft**

`docs/eip-8141.md`'s §Gas Accounting states `FRAME_TX_INTRINSIC_COST = 15000` — note this **differs from the `eip-8141.md` spec text this session read earlier in the conversation**, which stated `FRAME_TX_INTRINSIC_COST = 12000` (§Constants, line 37 of `/Users/alexf/EIPs/EIPS/eip-8141.md` as read in this conversation's much earlier turns). This is exactly the kind of drift Known Divergence context warns about: ethrex's docs cite spec commit `c55786f42` (2026-07-28); the locally-checked-out `/Users/alexf/EIPs/EIPS/eip-8141.md` may predate or postdate that commit. **Do not resolve this discrepancy by picking one arbitrarily** — diff the two, determine which is current by checking the EIP's actual git history, and use whichever value the *fork plan's target ethrex version* actually implements, since this plan tests against ethrex specifically, not the paper spec in isolation.

```bash
cd /Users/alexf/EIPs && git log --oneline -- EIPS/eip-8141.md | head -20
git show c55786f42:EIPS/eip-8141.md 2>&1 | grep -A2 "FRAME_TX_INTRINSIC_COST" || echo "commit not found in this checkout, fetch upstream"
```

- [ ] **Step 2: Write the failing conformance test**, iterating vendored fixtures that carry an expected `gasUsed` value, computing the sidecar's own gas accounting for the same transaction, and asserting equality.

```typescript
import { describe, it, expect } from "vitest";
// import path TBD once Step 1 of Task 3 in the fork plan's gas-accounting
// location is confirmed
```

- [ ] **Step 3: Confirm failure, then iterate the sidecar's gas-accounting implementation until fixtures match**

```bash
bun run vitest run test/conformance/gasAccounting.conformance.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add test/conformance/gasAccounting.conformance.test.ts
git commit -m "test: gas accounting conformance against vendored EIP-8141 fixtures"
```

---

### Task 4: `ethrex --dev` devnet test harness

**Files:**
- Create: `test/differential/ethrexDevnet.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `startEthrexDevnet(): Promise<{ rpcUrl: string; stop: () => Promise<void> }>`, a shared helper Tasks 6–9 all use to get a fresh, ephemeral, in-memory ethrex node.

- [ ] **Step 1: Confirm the exact invocation and pin a version**

Per this plan's research: `cargo run --release -- --dev --datadir memory` (via ethrex's own `Makefile`'s `dev` target) or `docker run ghcr.io/lambdaclass/ethrex:main --dev --datadir memory` with the RPC port published. Confirm both work locally before writing the harness, and pin a specific image digest or commit (not `:main`, which moves) for reproducibility:

```bash
docker pull ghcr.io/lambdaclass/ethrex:main
docker inspect ghcr.io/lambdaclass/ethrex:main --format '{{.RepoDigests}}'
```

Record the pinned digest in this file's header comment, and set up a scheduled or manual process for bumping it deliberately (out of scope to automate here — a manual `VENDORED_FIXTURES.md`-style provenance note is sufficient for now).

- [ ] **Step 2: Write the harness**

```typescript
// test/differential/ethrexDevnet.ts
import { spawn, ChildProcess } from "node:child_process";

// Pinned per Task 4 Step 1 -- update deliberately, not silently.
const ETHREX_IMAGE = "ghcr.io/lambdaclass/ethrex@sha256:REPLACE_WITH_PINNED_DIGEST";

export async function startEthrexDevnet(): Promise<{ rpcUrl: string; stop: () => Promise<void> }> {
  const port = 18545 + Math.floor(Math.random() * 1000); // avoid collisions across parallel test files
  const proc: ChildProcess = spawn("docker", [
    "run", "--rm", "-p", `${port}:8545`,
    ETHREX_IMAGE,
    "--dev", "--datadir", "memory", "--http.addr", "0.0.0.0",
  ]);
  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitForRpcReady(rpcUrl);
  return {
    rpcUrl,
    stop: async () => { proc.kill(); },
  };
}

async function waitForRpcReady(rpcUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`ethrex devnet did not become ready within ${timeoutMs}ms`);
}
```

- [ ] **Step 3: Write a smoke test for the harness itself**

```typescript
// test/differential/ethrexDevnet.smoke.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { startEthrexDevnet } from "./ethrexDevnet.js";

describe("ethrex devnet harness", () => {
  it("starts and responds to eth_chainId", async () => {
    const { rpcUrl, stop } = await startEthrexDevnet();
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
      });
      const body = await res.json();
      expect(body.result).toBeDefined();
    } finally {
      await stop();
    }
  });
});
```

- [ ] **Step 4: Run to confirm**

```bash
bun run vitest run test/differential/ethrexDevnet.smoke.test.ts
```

Expected: PASS, confirming Docker is available in the test environment and the pinned image starts correctly. If Docker isn't available in CI, this task's Step 1 needs to also produce a native-binary fallback (`cargo run` against a checked-out ethrex source pinned to the same commit) — decide this now, since Task 10 (CI wiring) depends on which path is actually viable in the target CI environment.

- [ ] **Step 5: Commit**

```bash
git add test/differential/ethrexDevnet.ts test/differential/ethrexDevnet.smoke.test.ts
git commit -m "test: add ethrex --dev devnet harness for differential testing"
```

---

### Task 5: `erc7562FrameTracer` client wiring

**Files:**
- Modify: the fork plan's `GethTracer.ts`-equivalent (Task 12 of `2026-09-02-frame-tx-bundler-fork.md` — confirm its final name/location once that plan has progressed; this task assumes it exists)
- Test: `test/differential/tracerClient.test.ts`

**Interfaces:**
- Consumes: the `erc7562FrameTracer` RPC tracer from `2026-09-02-ethrex-native-tracer.md` Task 8.
- Produces: confirmation that the sidecar's tracer-calling code requests `"erc7562FrameTracer"` by name (per that plan's Task 8 Step 1 naming decision) against a live ethrex devnet, and that the returned JSON parses into the shape the sidecar's `FrameTxValidationService` (fork plan Task 13) expects.

- [ ] **Step 1: Write a failing test calling `debug_traceCall` with `erc7562FrameTracer` against a real ethrex devnet**

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { startEthrexDevnet } from "./ethrexDevnet.js";

describe("erc7562FrameTracer client wiring", () => {
  it("returns frame-indexed diagnostics for a two-frame transaction", async () => {
    const { rpcUrl, stop } = await startEthrexDevnet();
    try {
      // Submit a minimal two-frame transaction (deploy + self_verify) via
      // debug_traceCall with tracer: "erc7562FrameTracer", per the naming
      // decision in 2026-09-02-ethrex-native-tracer.md Task 8 Step 1.
      // Assert the response is an array of {frameIndex, root: {...}}
      // matching that plan's Task 2 output schema.
    } finally {
      await stop();
    }
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
bun run vitest run test/differential/tracerClient.test.ts
```

Expected failure mode at this point should be "tracer not found" if the companion tracer plan hasn't shipped to the pinned ethrex image yet — if so, this task blocks on that plan landing and being included in a new pinned image build, not on anything in this repository.

- [ ] **Step 3: Once the tracer plan has shipped and the pinned image updated, iterate the client wiring until this passes**

```bash
bun run vitest run test/differential/tracerClient.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add test/differential/tracerClient.test.ts
git commit -m "test: confirm erc7562FrameTracer client wiring against live ethrex devnet"
```

---

### Task 6: Differential tests — rules ethrex's own policy also enforces

**Files:**
- Create: `test/differential/generalRules.differential.test.ts`

**Interfaces:**
- Consumes: `startEthrexDevnet` (Task 4), the sidecar's `FrameTxValidationService`/admission logic (fork plan Task 13), `erc-7562.md`.
- Produces: one test per general (non-"ERC-4337 only", non-staking-restoring) rule, each submitting a crafted transaction to *both* the sidecar's own admission logic (in-process) and ethrex's `eth_sendRawTransaction` (which runs `ValidationObserver` internally), asserting both admit or both reject.

- [ ] **Step 1: Enumerate the rule set this task covers**

From `erc-7562.md`, list every rule marked neither "ERC-4337 UserOperation only" nor covered by Task 7 below (the staking-specific `[STO-031]`/`[STO-032]`/`[STO-033]`/`[SREP-*]`/staked-branch-of-`[EREP-*]`). This is the bulk of `[OP-0xx]` (except `[OP-051]`–`[OP-055]`), `[STO-010]`/`[STO-021]`/`[STO-022]`/`[STO-040]`/`[STO-041]`, `[COD-010]`, most `[FRA-0xx]`. Write this list into the test file as a comment before the first test, so its completeness is visible and reviewable.

- [ ] **Step 2: Write one failing test per rule in the enumerated list**, e.g.:

```typescript
describe("General validation rules (differential against ethrex ValidationObserver)", () => {
  it("[OP-011] TIMESTAMP outside expiry_verify frame is rejected by both", async () => {
    const { rpcUrl, stop } = await startEthrexDevnet();
    try {
      const tx = buildFrameTxUsingTimestampOutsideExpiryFrame();
      const sidecarResult = await sidecarAdmit(tx); // in-process, no RPC
      const ethrexResult = await submitToEthrex(rpcUrl, tx);
      expect(sidecarResult.admitted).toBe(false);
      expect(ethrexResult.admitted).toBe(false);
    } finally {
      await stop();
    }
  });

  // ... one per rule from Step 1's list
});
```

(`buildFrameTxUsingTimestampOutsideExpiryFrame`, `sidecarAdmit`, `submitToEthrex` are shared helpers this task must also write, in a `test/differential/helpers.ts` file — do not inline transaction construction in every test, since the same builders are needed by Task 7 too.)

- [ ] **Step 3: Confirm failures, then iterate until every test passes**

```bash
bun run vitest run test/differential/generalRules.differential.test.ts
```

Any persistent disagreement between the sidecar and ethrex here is a real bug in one of the two — do not resolve a disagreement by weakening the test; determine which side is wrong against `erc-7562.md`'s actual rule text and fix that side.

- [ ] **Step 4: Commit**

```bash
git add test/differential/generalRules.differential.test.ts test/differential/helpers.ts
git commit -m "test: differential tests for general erc-7562.md rules against ethrex ValidationObserver"
```

---

### Task 7: Staking/reputation rule tests — documented divergence from ethrex

**Files:**
- Create: `test/differential/stakingRules.differential.test.ts`

**Interfaces:**
- Consumes: the same helpers as Task 6, plus `erc7562FrameTracer` (Task 5) for state/execution verification.
- Produces: tests proving the sidecar admits transactions using restored staked-entity associated-storage carve-outs (`[STO-031]`/`[STO-032]`/`[STO-033]`) **and** that ethrex's own local mempool would reject the same transaction — both halves of Known Divergence #2 asserted explicitly, not just one.

- [ ] **Step 1: Write a failing test asserting the divergence itself**

```typescript
describe("Staking rules (documented divergence from ethrex's local policy)", () => {
  it("[STO-032] sidecar admits a staked payer's associated-storage write; ethrex's own mempool rejects it (Known Divergence #2)", async () => {
    const { rpcUrl, stop } = await startEthrexDevnet();
    try {
      const tx = buildFrameTxWithStakedPayerAssociatedStorageWrite();
      const sidecarResult = await sidecarAdmit(tx);
      const ethrexResult = await submitToEthrex(rpcUrl, tx);
      expect(sidecarResult.admitted).toBe(true); // our combined standard restores this
      expect(ethrexResult.admitted).toBe(false); // ethrex's local policy has no staking carve-out
    } finally {
      await stop();
    }
  });

  it("[STO-032] the transaction ethrex's mempool rejects is nonetheless valid on-chain if force-included", async () => {
    // Per Known Divergence #2: ValidationObserver is "never a consensus
    // rule." Confirm this by directly building a block containing the tx
    // (bypassing the mempool's local policy -- ethrex's docs imply this is
    // possible since the rule is explicitly local-peer-policy-only) and
    // confirming the block executes successfully. If ethrex's tooling
    // provides no way to bypass the mempool gate for testing purposes,
    // this sub-test may need to fall back to asserting the *execution*
    // succeeds via a direct debug_traceCall/eth_call simulation instead
    // of an actual block-inclusion test -- resolve which is feasible
    // during implementation, don't assume block-bypass tooling exists.
  });
});
```

- [ ] **Step 2: Confirm failures, then implement `buildFrameTxWithStakedPayerAssociatedStorageWrite`** — this requires a real staked entity, meaning the companion spec plan's Appendix A `IStakingRegistry` contract must be deployed to the ethrex devnet first. Add a devnet setup step (deploy the registry, stake an account) to this test file's `beforeAll`.

- [ ] **Step 3: Run to confirm**

```bash
bun run vitest run test/differential/stakingRules.differential.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add test/differential/stakingRules.differential.test.ts
git commit -m "test: confirm documented staking-rule divergence between sidecar and ethrex's local policy"
```

---

### Task 8: End-to-end devnet inclusion and propagation test

**Files:**
- Create: `test/e2e/devnetInclusion.e2e.test.ts`

**Interfaces:**
- Consumes: `startEthrexDevnet` (Task 4), the sidecar's RPC surface (fork plan Task 22).
- Produces: one test proving a full realistic flow: submit a frame transaction through the sidecar, confirm it lands in an ethrex block, confirm the receipt carries `payer`/`frameReceipts` fields correctly (per `docs/eip-8141.md` §Receipt Format), and confirm a **second**, separately-started ethrex node peered to the first observes the transaction via **standard devp2p propagation** (not any bespoke sidecar-to-sidecar channel — per Known Divergence #1).

- [ ] **Step 1: Extend `ethrexDevnet.ts` to support peering two instances**

Add a `startEthrexDevnet(opts?: { bootnode?: string })` variant or a second helper that starts a node configured to peer with a given bootnode/enode, confirming ethrex exposes whatever CLI flag or `admin_addPeer`-equivalent RPC method is needed (research this during implementation — this session's research did not confirm the exact peering mechanism, only that propagation itself rides standard devp2p once peered).

- [ ] **Step 2: Write the failing test**

```typescript
describe("End-to-end: sidecar submission, ethrex inclusion, standard devp2p propagation", () => {
  it("a frame transaction submitted via the sidecar lands on-chain and propagates to a peered node", async () => {
    const node1 = await startEthrexDevnet();
    const node2 = await startEthrexDevnet();
    await peerNodes(node1, node2);
    try {
      const txHash = await submitViaSidecar(node1.rpcUrl, buildSelfRelaySimpleTransfer());
      await waitForInclusion(node1.rpcUrl, txHash);
      const receipt = await getFrameTxReceipt(node1.rpcUrl, txHash);
      expect(receipt.payer).toBeDefined();
      expect(receipt.frameReceipts.length).toBeGreaterThan(0);
      // Confirm node2 saw it propagate over standard tx gossip, not any
      // sidecar-specific channel.
      await waitForInclusion(node2.rpcUrl, txHash);
    } finally {
      await node1.stop();
      await node2.stop();
    }
  });
});
```

- [ ] **Step 3: Confirm failure, then implement `peerNodes`/`submitViaSidecar`/`waitForInclusion`/`getFrameTxReceipt`**

- [ ] **Step 4: Run to confirm**

```bash
bun run vitest run test/e2e/devnetInclusion.e2e.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add test/e2e/devnetInclusion.e2e.test.ts
git commit -m "test(e2e): sidecar submission through ethrex inclusion and standard devp2p propagation"
```

---

### Task 9: Known Divergences regression suite

**Files:**
- Create: `test/regression/knownDivergences.test.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one test per numbered item in this plan's "Known Divergences" section, each pinned so that if ethrex's actual behavior changes (e.g., `SETDELEGATE` gets implemented, a canonical paymaster gets pinned resolving OQ1), the test fails loudly rather than the plan's assumptions silently going stale.

- [ ] **Step 1: Write one test per Known Divergence**

```typescript
describe("Known Divergences (fail loudly if ethrex's actual behavior changes)", () => {
  it("Divergence #4: SETDELEGATE is still absent from ethrex's opcode set", async () => {
    const { rpcUrl, stop } = await startEthrexDevnet();
    try {
      // Attempt to use SETDELEGATE's opcode byte in a deploy frame; assert
      // it's either an invalid-opcode exceptional halt or simply not
      // dispatched -- whichever ethrex actually does today. If this test
      // starts failing because SETDELEGATE now works, that's good news:
      // update erc-7562.md's [FRA-060] test coverage and this plan's
      // Known Divergence #4 note, don't just delete this test.
    } finally {
      await stop();
    }
  });

  it("Divergence #5: gas_limit at 2**63 is rejected (stricter than the paper spec's 2**64-1)", async () => {
    // ...
  });

  it("Divergence #6: a frame target's first SLOAD is charged the cold-access surcharge", async () => {
    // ...
  });

  // ... one per remaining numbered divergence
});
```

- [ ] **Step 2: Confirm each passes against the current pinned ethrex version**

```bash
bun run vitest run test/regression/knownDivergences.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add test/regression/knownDivergences.test.ts
git commit -m "test: pin Known Divergences from ethrex's actual behavior as a regression suite"
```

---

### Task 10: CI wiring

**Files:**
- Create/modify: whatever CI config format this repository uses (confirm — the fork plan's target repo, `/Users/alexf/skandha`, likely already has `.github/workflows/`; read its existing CI config before adding a new one, to match conventions rather than introduce a second style)

**Interfaces:**
- Consumes: every test file from Tasks 1–9.
- Produces: a CI job matrix running Layer 1 (unit, from the fork plan) on every push, Layer 2 (fixture conformance) on every push, Layer 3/4 (differential/e2e, requiring Docker + the pinned ethrex image) on a slower schedule or PR-gated basis given their cost, and a separate scheduled job re-running Task 9's Known Divergences suite against `ethrex:main` (unpinned) periodically, specifically to get early warning when a divergence resolves upstream.

- [ ] **Step 1: Read the existing CI config**

```bash
cat /Users/alexf/skandha/.github/workflows/*.yml 2>&1 | head -100
```

- [ ] **Step 2: Add the new jobs, matching existing style**

(Concrete YAML content depends entirely on Step 1's findings — do not write speculative CI config before reading what's actually there.)

- [ ] **Step 3: Confirm the new jobs run successfully on a test PR/branch**

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "ci: wire up conformance/differential/e2e frame tx test layers"
```
