# `pre_verify` Frame Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognize the `pre_verify` validation-prefix frame subclass (ERC-2028 `PREFIX-010`–`PREFIX-120`) so the sidecar can admit a transaction whose validation prefix writes state before it approves.

**Architecture:** `recognizeValidationPrefix` (`packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts`) changes from matching four fixed frame-mode sequences to classifying the unambiguous `VERIFY`-mode approving frames first, then resolving each remaining `DEFAULT`-mode frame as `pre_verify` (adjacent to and target-matching an approving frame) or `deploy` (the leading, non-matching fallback) by exclusion. Every downstream rule (opcode, storage, CREATE, budget) already iterates per role across however many frames that role owns, so once a `pre_verify` frame is correctly attributed a role, it needs no further code changes — verified by an end-to-end test, not just claimed.

**Tech Stack:** TypeScript, Bun, Vitest (single-threaded — see root `CLAUDE.md`).

**Spec:** `docs/superpowers/specs/2026-09-28-prevalidate-frame-design.md`

## Global Constraints

- Scope is only `PREFIX-010`–`PREFIX-110`'s frame-shape recognition — not the rest of ERC-2028 (staking registry, reputation, propagation, solvency reservation).
- Do not implement `BUDGET-010`'s per-entity staked gas budget bump. The existing combined-sum check over the whole prefix stays unchanged.
- Do not implement `CALLING-030`'s CALL-with-value exemption for `pre_verify` frames.
- Do not implement `PREFIX-110`'s "target must have deployed code" check — deliberately deferred (see spec §3), not verifiable from this repo alone.
- No new `FRAME_SUBCLASS` constant. `pre_verify` is resolved entirely inside `validationPrefix.ts`, reusing `FRAME_SUBCLASS.DEPLOY_OR_POST_OP` for "this is a `DEFAULT`-mode frame."
- `packages/executor` tests must be run from inside `packages/executor` (`cd packages/executor && bunx vitest run ...`), not from the repo root, so `test/vitestSetup.ts`'s `GethTracer` mock applies (see root `CLAUDE.md`).

## Review Focus

- A leading `DEFAULT`-mode frame whose target happens to equal an approving frame's resolved target in a transaction that was never meant to have a `pre_verify` frame (e.g. a legitimate `deploy` frame that coincidentally targets `tx.sender`) — confirm the new exclusion logic doesn't misclassify a real `deploy` as `pre_verify` in any case beyond the one deliberately tested.
- `resolveRoleStakes` (`frameTx.ts:434`) and `FrameTxMempoolEntry.resolveRoles` (`FrameTxMempoolEntry.ts:84`) both iterate `prefix.frames` and assign into a per-role map (`roleStakes[role] = ...`, `if (role === "payer") payer = ...`) — when a role now has two frames (`pre_verify` + its approving frame), the second iteration silently overwrites the first. This is safe only because `pre_verify`'s target is enforced equal to its approving frame's target at recognition time; confirm no code path can reach either loop with a mismatched pair.
- The `matchApprovingSkeleton(allFrames, offset, txSender)` / `matchApprovingSkeleton(allFrames, offset + 1, txSender)` two-pass structure in `recognizeValidationPrefix` — confirm the "try without deploy first" pass can never silently accept a shape that should have required a `deploy` frame (e.g. `tx.sender` has no code and no `deploy` frame is present, but a `pre_verify`-shaped match still succeeds structurally — code-existence isn't checked here, by design, so this needs runtime checks elsewhere to actually reject it, not a hole in the matcher itself).
- `logic/frames.ts`'s `frameRole()` (UI task) reads `entity` from a `Check[]` array — confirm it falls back to today's `"deploy or post-operation"` label, not a crash or a wrong label, when `checks` is empty (a mempool entry with no admission record retained, e.g. after eviction).
- Every one of `recognizeValidationPrefix`'s ~18 call sites (4 production, ~14 test) got the new second argument — a missed one is a TypeScript compile error, not a silent bug, but confirm the full-workspace build (`bun run build` from the repo root) is clean, not just `packages/executor`'s own build.

---

## Task 1: Recognize `pre_verify` frames in `recognizeValidationPrefix`

**Files:**
- Modify: `packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts`
- Modify: `packages/executor/src/modules/eth.ts:375`
- Modify: `packages/executor/src/entities/FrameTxMempoolEntry.ts:91`
- Modify: `packages/executor/src/services/UserOpValidation/validators/frameTx.ts:253,292`
- Test: `packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts`
- Modify: `packages/executor/test/modules/eth.test.ts:241`

**Interfaces:**
- Produces: `recognizeValidationPrefix(allFrames: Frame[], txSender: \`0x${string}\`): ValidationPrefixMatch | null` — signature change (was `(allFrames: Frame[])`), used by Task 2 and Task 3 unchanged from today's existing call pattern otherwise. `ValidationPrefixMatch`'s shape is unchanged.

- [ ] **Step 1: Thread `txSender` through every call site (no behavior change yet)**

Edit `packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts` — change only the signature line, keep the body identical for now:

```ts
export function recognizeValidationPrefix(allFrames: Frame[], txSender: `0x${string}`): ValidationPrefixMatch | null {
```

(`txSender` is unused in the body until Step 4 — that's fine, it's consumed within the same task, not left dangling across a commit.)

Update the four production call sites:

`packages/executor/src/modules/eth.ts:375` — change:
```ts
    const prefix = recognizeValidationPrefix(tx.frames);
```
to:
```ts
    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
```

`packages/executor/src/entities/FrameTxMempoolEntry.ts:91` — change:
```ts
    const prefix = recognizeValidationPrefix(tx.frames);
```
to:
```ts
    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
```

`packages/executor/src/services/UserOpValidation/validators/frameTx.ts:253` (inside `explainFailure`) and `:292` (inside `validate`) — both currently read:
```ts
    const prefix = recognizeValidationPrefix(tx.frames);
```
change both to:
```ts
    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
```

Update the one test call site outside `validationPrefix.test.ts`, `packages/executor/test/modules/eth.test.ts:241`:
```ts
        const prefix = recognizeValidationPrefix(tx.frames);
```
to:
```ts
        const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
```

Update every call site in `packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts`. First add a module-level `SENDER` constant matching `baseTx`'s hardcoded sender, and use it in `baseTx` instead of the inline string:

```ts
const SENDER = "0x1111111111111111111111111111111111111111" as const;

const baseTx = (frames: Frame[]): FrameTransaction => ({
  chainId: 1n,
  nonce: 0n,
  sender: SENDER,
  frames,
  signatures: [],
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
});
```

Then, from `packages/executor`, run this to add `, SENDER` to every one of the file's ~14 `recognizeValidationPrefix(...)` calls that don't already have a second argument:

```bash
cd packages/executor
sed -i '' \
  -e 's/recognizeValidationPrefix(frames)/recognizeValidationPrefix(frames, SENDER)/g' \
  -e 's/recognizeValidationPrefix(\[verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)\])/recognizeValidationPrefix([verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)], SENDER)/' \
  -e 's/recognizeValidationPrefix(\[deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)\])/recognizeValidationPrefix([deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)], SENDER)/' \
  -e 's/recognizeValidationPrefix(\[verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)\])/recognizeValidationPrefix([verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)], SENDER)/' \
  -e 's/recognizeValidationPrefix(\[deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)\])/recognizeValidationPrefix([deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)], SENDER)/' \
  -e 's/recognizeValidationPrefix(\[verifyFrame(APPROVE_SCOPE.PAYMENT), verifyFrame(APPROVE_SCOPE.EXECUTION)\])/recognizeValidationPrefix([verifyFrame(APPROVE_SCOPE.PAYMENT), verifyFrame(APPROVE_SCOPE.EXECUTION)], SENDER)/' \
  -e 's/recognizeValidationPrefix(\[expiryFrame, verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)\])/recognizeValidationPrefix([expiryFrame, verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)], SENDER)/' \
  test/services/UserOpValidation/utils/validationPrefix.test.ts
```

Then visually diff the file (`git diff test/services/UserOpValidation/utils/validationPrefix.test.ts`) and confirm every `recognizeValidationPrefix(` call now has exactly two arguments — there should be no remaining single-argument call.

- [ ] **Step 2: Run the full test suite, confirm everything still passes (behavior unchanged)**

Run: `cd packages/executor && bunx vitest run`
Expected: PASS — same test counts as before this step (the pre-existing 5 broken `test/unit/` suites still fail for their unrelated, documented reason; every other suite, including `validationPrefix.test.ts` and `eth.test.ts`, passes exactly as before).

Also run the full workspace build to catch any missed call site:
Run: `cd /Users/alexf/skandha && bun run build`
Expected: exit code 0, no TypeScript errors.

- [ ] **Step 3: Commit the mechanical signature change**

```bash
cd /Users/alexf/skandha
git add packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts \
  packages/executor/src/modules/eth.ts \
  packages/executor/src/entities/FrameTxMempoolEntry.ts \
  packages/executor/src/services/UserOpValidation/validators/frameTx.ts \
  packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts \
  packages/executor/test/modules/eth.test.ts
git commit -m "refactor(executor): thread tx.sender through recognizeValidationPrefix

No behavior change — pre_verify frame recognition (next commit) needs
tx.sender to resolve a pre_verify frame's target against its approving
frame's, which the matcher didn't previously have in scope."
```

- [ ] **Step 4: Write the failing tests for `pre_verify` recognition**

Add to `packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts`, after the existing `describe("recognizeValidationPrefix", ...)` block (keep that block's existing tests as-is — they're the regression guard that the four original shapes still work with no `pre_verify` frame present). First add a `PAYER` constant and a `preVerifyFrame` helper near the top of the file, alongside the existing `verifyFrame`/`deployFrame`/`userOpFrame` helpers:

```ts
const PAYER = "0x5555555555555555555555555555555555555555" as const;

const preVerifyFrame = (target: `0x${string}` | null): Frame => ({
  mode: FRAME_MODE.DEFAULT,
  flags: 0,
  target,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x" as const,
});
```

Then add:

```ts
describe("recognizeValidationPrefix: pre_verify frames (ERC-2028 PREFIX-010/PREFIX-110)", () => {
  it("recognizes [pre_verify, self_verify], attributing both frames role 'payer'", () => {
    const frames = [preVerifyFrame(null), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(1);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "payer"],
      [1, "payer"],
    ]);
  });

  it("recognizes [deploy, pre_verify, self_verify]", () => {
    const frames = [deployFrame(), preVerifyFrame(null), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(2);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "factory"],
      [1, "payer"],
      [2, "payer"],
    ]);
  });

  it("recognizes [pre_verify, only_verify, pay], attributing the pre_verify frame role 'sender'", () => {
    const frames = [preVerifyFrame(null), verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(2);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "sender"],
      [1, "sender"],
      [2, "payer"],
    ]);
  });

  it("recognizes [only_verify, pre_verify, pay], with the pre_verify frame targeting pay's target and role 'payer'", () => {
    const pay: Frame = { ...verifyFrame(APPROVE_SCOPE.PAYMENT), target: PAYER };
    const frames = [verifyFrame(APPROVE_SCOPE.EXECUTION), preVerifyFrame(PAYER), pay];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(2);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "sender"],
      [1, "payer"],
      [2, "payer"],
    ]);
  });

  it("recognizes [pre_verify, only_verify, pre_verify, pay] with both optional pre_verify frames present", () => {
    const pay: Frame = { ...verifyFrame(APPROVE_SCOPE.PAYMENT), target: PAYER };
    const frames = [preVerifyFrame(null), verifyFrame(APPROVE_SCOPE.EXECUTION), preVerifyFrame(PAYER), pay];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(3);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "sender"],
      [1, "sender"],
      [2, "payer"],
      [3, "payer"],
    ]);
  });

  it("still falls back to deploy when the leading DEFAULT-mode frame's target matches neither sender nor payer", () => {
    // Regression guard for the new two-pass matcher: introducing pre_verify
    // must not turn this pre-existing [deploy, self_verify] shape into a
    // rejected pre_verify-target-mismatch case.
    const frames = [deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    const factory = match!.frames.find((f) => f.role === "factory");
    expect(factory).toBeDefined();
    expect(factory!.frameIndex).toBe(0);
  });

  it("rejects a DEFAULT-mode frame between only_verify and pay whose target matches neither", () => {
    const otherAddr = "0x6666666666666666666666666666666666666666" as const;
    const pay: Frame = { ...verifyFrame(APPROVE_SCOPE.PAYMENT), target: PAYER };
    const frames = [verifyFrame(APPROVE_SCOPE.EXECUTION), preVerifyFrame(otherAddr), pay];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).toBeNull();
  });
});
```

- [ ] **Step 5: Run the new tests, verify they fail for the right reason**

Run: `cd packages/executor && bunx vitest run test/services/UserOpValidation/utils/validationPrefix.test.ts -t "pre_verify frames"`
Expected: FAIL. The first five tests should fail with `match` being `null` (today's matcher has no notion of `pre_verify` at all, so any frame list containing one fails every one of the four fixed shape checks). The sixth and seventh tests may already pass by accident (today's matcher already handles `[deploy, self_verify]`, and already returns `null` for anything it doesn't recognize) — that's fine, they exist to pin behavior across the rewrite in Step 6, not to prove new behavior on their own.

- [ ] **Step 6: Implement `pre_verify` recognition**

Replace the whole body of `packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts` from the `recognizeValidationPrefix` function's doc comment through its closing brace (do not touch `MAX_VERIFY_GAS`, `MAX_VERIFY_STATE_GAS`, `signatureVerificationCost`, `ValidationPrefixMatch`, `validateStructuralRules`, or `StructuralRulesResult` above/below it) with:

```ts
/**
 * Resolves a frame's target for comparison: an explicit target, or
 * `txSender` when the target is null (EIP-8141 §Structural Rules item 3 /
 * ERC-2028 PREFIX-030/PREFIX-110: "or null" always means "tx.sender", never
 * an untargeted call). Checksums both sides so a case-only difference can't
 * defeat the match.
 */
function resolvedTarget(target: `0x${string}` | null, txSender: `0x${string}`): `0x${string}` {
  return getAddress(target ?? txSender) as `0x${string}`;
}

/**
 * A `pre_verify` frame immediately before `approving` at `approvingIndex`
 * (ERC-2028 PREFIX-110): the frame at `approvingIndex - 1`, if it exists, is
 * `DEFAULT`-mode, and its resolved target equals `approving`'s. Returns null
 * when there's no such frame — `pre_verify` is always optional (PREFIX-010).
 */
function matchPreVerify(
  allFrames: Frame[],
  approvingIndex: number,
  approving: Frame,
  role: "sender" | "payer",
  txSender: `0x${string}`
): ValidationPrefixMatch["frames"][number] | null {
  const candidateIndex = approvingIndex - 1;
  if (candidateIndex < 0) return null;
  const candidate = allFrames[candidateIndex];
  if (classifyFrame(candidate) !== FRAME_SUBCLASS.DEPLOY_OR_POST_OP) return null;
  if (resolvedTarget(candidate.target, txSender) !== resolvedTarget(approving.target, txSender)) {
    return null;
  }
  return { frame: candidate, frameIndex: candidateIndex, role };
}

/**
 * Matches one of the two approving-frame skeletons — Self Relay
 * `[pre_verify?, self_verify]` or Canonical Paymaster `[pre_verify?,
 * only_verify, pre_verify?, pay]` — starting at `start` in `allFrames`. Each
 * `pre_verify?` is independently optional (ERC-2028 PREFIX-010/PREFIX-110).
 * `frameIndex` values in the result are absolute indices into `allFrames`.
 */
function matchApprovingSkeleton(
  allFrames: Frame[],
  start: number,
  txSender: `0x${string}`
): ValidationPrefixMatch | null {
  // Self Relay: [pre_verify?, self_verify]
  for (const selfVerifyIndex of [start, start + 1]) {
    if (selfVerifyIndex >= allFrames.length) continue;
    const candidate = allFrames[selfVerifyIndex];
    if (classifyFrame(candidate) !== FRAME_SUBCLASS.SELF_VERIFY) continue;
    const frames: ValidationPrefixMatch["frames"] = [];
    if (selfVerifyIndex === start + 1) {
      const pv = matchPreVerify(allFrames, selfVerifyIndex, candidate, "payer", txSender);
      if (!pv) continue;
      frames.push(pv);
    }
    frames.push({ frame: candidate, frameIndex: selfVerifyIndex, role: "payer" });
    return { payerFrameIndex: selfVerifyIndex, frames };
  }

  // Canonical Paymaster: [pre_verify?, only_verify, pre_verify?, pay]
  for (const onlyVerifyIndex of [start, start + 1]) {
    if (onlyVerifyIndex >= allFrames.length) continue;
    const onlyVerify = allFrames[onlyVerifyIndex];
    if (classifyFrame(onlyVerify) !== FRAME_SUBCLASS.ONLY_VERIFY) continue;

    const frames: ValidationPrefixMatch["frames"] = [];
    if (onlyVerifyIndex === start + 1) {
      const pv = matchPreVerify(allFrames, onlyVerifyIndex, onlyVerify, "sender", txSender);
      if (!pv) continue;
      frames.push(pv);
    }
    frames.push({ frame: onlyVerify, frameIndex: onlyVerifyIndex, role: "sender" });

    for (const payIndex of [onlyVerifyIndex + 1, onlyVerifyIndex + 2]) {
      if (payIndex >= allFrames.length) continue;
      const pay = allFrames[payIndex];
      if (classifyFrame(pay) !== FRAME_SUBCLASS.PAY) continue;
      const withPay = [...frames];
      if (payIndex === onlyVerifyIndex + 2) {
        const pv = matchPreVerify(allFrames, payIndex, pay, "payer", txSender);
        if (!pv) continue;
        withPay.push(pv);
      }
      withPay.push({ frame: pay, frameIndex: payIndex, role: "payer" });
      return { payerFrameIndex: payIndex, frames: withPay };
    }
  }

  return null;
}

/**
 * Recognizes one of the EIP-8141 §Public Mempool-recognized Validation
 * Prefixes shapes, each optionally augmented with a `pre_verify` frame
 * (ERC-2028 PREFIX-010/PREFIX-110) immediately before any approving frame
 * (`self_verify`, `only_verify` or `pay`):
 *   - Self Relay, Basic Transaction:     [pre_verify?, self_verify]
 *   - Self Relay, Deploy New Account:    [deploy, pre_verify?, self_verify]
 *   - Canonical Paymaster, Basic Tx:     [pre_verify?, only_verify, pre_verify?, pay]
 *   - Canonical Paymaster, Deploy:       [deploy, pre_verify?, only_verify, pre_verify?, pay]
 *
 * Per §Expiry Verifier Frame, a leading `expiry_verify` frame is skipped for
 * the purposes of shape matching (e.g. `[expiry_verify, self_verify]` is
 * recognized as `[self_verify]`), but its index is preserved in the returned
 * frameIndex values.
 *
 * `self_verify`/`only_verify`/`pay` are classified unambiguously by
 * `classifyFrame()` alone (`VERIFY`-mode, disambiguated by `flags`). A
 * `DEFAULT`-mode frame is not: it's ambiguous between `deploy` and
 * `pre_verify` by mode/flags alone, so this function tries the
 * approving-frame skeleton (which resolves `pre_verify` via adjacency and
 * target-matching, PREFIX-110) starting at the prefix's first real frame
 * first; only if that fails does it retry one frame later, treating the
 * skipped leading frame as `deploy` (PREFIX-020: `deploy` must be the
 * prefix's first frame). This means a leading `DEFAULT`-mode frame whose
 * target doesn't match the following approving frame's target is `deploy`;
 * one whose target does match is `pre_verify` instead — `deploy` calls a
 * distinct factory contract that `CREATE2`s `tx.sender`'s code, so it cannot
 * sensibly target `tx.sender` (or a payer) itself.
 *
 * Returns null if `allFrames` does not match any of the resulting twelve
 * concrete shapes (§Structural Rules item 1). §Structural Rules items 5, 6
 * and 8 are NOT checked here — see `validateStructuralRules` below, which
 * needs the whole transaction rather than just the recognized prefix slice.
 */
export function recognizeValidationPrefix(
  allFrames: Frame[],
  txSender: `0x${string}`
): ValidationPrefixMatch | null {
  let offset = 0;
  if (allFrames.length > 0 && classifyFrame(allFrames[0]) === FRAME_SUBCLASS.EXPIRY_VERIFY) {
    offset = 1;
  }

  const withoutDeploy = matchApprovingSkeleton(allFrames, offset, txSender);
  if (withoutDeploy) return withoutDeploy;

  if (allFrames.length > offset && classifyFrame(allFrames[offset]) === FRAME_SUBCLASS.DEPLOY_OR_POST_OP) {
    const withDeploy = matchApprovingSkeleton(allFrames, offset + 1, txSender);
    if (withDeploy) {
      return {
        payerFrameIndex: withDeploy.payerFrameIndex,
        frames: [
          { frame: allFrames[offset], frameIndex: offset, role: "factory" },
          ...withDeploy.frames,
        ],
      };
    }
  }

  return null;
}
```

Add `getAddress` to the file's existing viem-less import list — it currently has none from `"viem"`, so add a new import line at the top of the file (after the existing `@skandha/types` imports):

```ts
import { getAddress } from "viem";
```

- [ ] **Step 7: Run the tests, verify everything passes**

Run: `cd packages/executor && bunx vitest run test/services/UserOpValidation/utils/validationPrefix.test.ts`
Expected: PASS — every test in the file, both the original four-shape tests and the seven new `pre_verify` tests.

Run: `cd packages/executor && bunx vitest run`
Expected: PASS — same overall counts as Step 2 (the mechanical-refactor checkpoint), now with 7 more passing tests. The 5 pre-existing broken `test/unit/` suites are unaffected.

Run: `cd /Users/alexf/skandha && bun run build`
Expected: exit code 0.

- [ ] **Step 8: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts \
  packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts
git commit -m "feat(executor): recognize ERC-2028 pre_verify validation-prefix frames

A DEFAULT-mode frame immediately before an approving frame (self_verify,
only_verify or pay), whose resolved target matches that frame's, is now
recognized as pre_verify and attributed its role — enabling a
state-writing validation prefix (e.g. a paymaster pulling an ERC-20
payment during validation) that the four previously-fixed shapes could
not express. Scoped to PREFIX-010/PREFIX-110's frame-shape recognition
only; see docs/superpowers/specs/2026-09-28-prevalidate-frame-design.md
for what's deliberately deferred."
```

---

## Task 2: Prove the existing per-role rules apply to `pre_verify` frames end-to-end

**Files:**
- Test: `packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts` (test-only task — no production code changes)

**Interfaces:**
- Consumes: `recognizeValidationPrefix` from Task 1 (via `FrameTxValidationService.validate()`, which calls it internally — this task never calls it directly).
- Produces: nothing new — this task adds no production code. It exists to verify, not to build.

- [ ] **Step 1: Add the end-to-end test**

Add to `packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts`, inside the existing `describe("FrameTxValidationService checks[] (per-entity rules)", ...)` block (after the `"reports several violations at once but throws the first, unchanged"` test at line 769). First add a `preVerifyFrame` helper near the file's other frame-builder helpers (after `payFrame`, around line 47):

```ts
const preVerifyFrame = (target: `0x${string}`): Frame => ({
  mode: FRAME_MODE.DEFAULT,
  flags: 0,
  target,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x",
});
```

Then add the test:

```ts
  it("catches a banned opcode inside a pre_verify frame under the right role, with no code changes beyond recognition", async () => {
    // [pre_verify, only_verify, pay]: pre_verify precedes only_verify, so it
    // must target the same address only_verify resolves to — tx.sender
    // (SENDER), since only_verify's own target is null.
    const tx = baseTx([preVerifyFrame(SENDER), onlyVerifyFrame(), payFrame(PAYER)]);
    // "68" = DIFFICULTY (banned) — same fixture convention as the existing
    // "reports several violations at once" test above.
    const preVerifyRoot = ethrexFrame({ from: ENTRY_POINT, to: SENDER, usedOpcodes: { "68": 1 } });
    const onlyVerifyRoot = ethrexFrame({ from: ENTRY_POINT, to: SENDER });
    const payRoot = ethrexFrame({ from: ENTRY_POINT, to: PAYER });
    const collector = new CheckCollector();

    await expect(
      service().validate(tx, fakeEthrexResult([preVerifyRoot, onlyVerifyRoot, payRoot]), collector)
    ).rejects.toThrow("sender uses banned opcode: DIFFICULTY");

    // checkEntityCompliance's per-frame loop (frameTx.ts:570) throws as soon
    // as one frame's checks find a violation, so only_verify's own frameIndex
    // 1 is never reached in this run — this asserts what IS observable: the
    // violation is tagged with the pre_verify frame's own frameIndex (0), not
    // conflated with its approving frame's (1), proving prefix.frames treats
    // it as its own distinct entry.
    expect(collector.toChecks()).toContainEqual(
      expect.objectContaining({ rule: "OP-011", entity: "sender", frameIndex: 0, verdict: "fail" })
    );
  });

  it("passes a clean pre_verify frame's checks before reaching its approving frame", async () => {
    // Same shape, no violation this time — proves frameIndex 0 (pre_verify)
    // is checked and recorded independently of frameIndex 1 (only_verify),
    // both under role "sender", without the early-throw from the test above
    // masking it.
    const tx = baseTx([preVerifyFrame(SENDER), onlyVerifyFrame(), payFrame(PAYER)]);
    const collector = new CheckCollector();
    await service().validate(
      tx,
      fakeEthrexResult([
        ethrexFrame({ from: ENTRY_POINT, to: SENDER }),
        ethrexFrame({ from: ENTRY_POINT, to: SENDER }),
        ethrexFrame({ from: ENTRY_POINT, to: PAYER }),
      ]),
      collector
    );
    const senderChecks = collector.toChecks().filter((c) => c.entity === "sender");
    expect(senderChecks.map((c) => [c.rule, c.frameIndex, c.verdict])).toEqual(
      expect.arrayContaining([
        ["OP-011", 0, "pass"],
        ["OP-011", 1, "pass"],
      ])
    );
  });
```

- [ ] **Step 2: Run it**

Run: `cd packages/executor && bunx vitest run test/services/UserOpValidation/validators/frameTx.test.ts -t "pre_verify frame"`
Expected: PASS on the first run, both new tests. This is the deliberate proof-of-design step: no production code changes in this task, because Task 1 alone is already sufficient — `checkEntityCompliance`'s existing per-`prefix.frames`-entry loop (`frameTx.ts:570`) needs no knowledge of `pre_verify` as a concept to check it correctly, since it only ever looks at `role` and `frameIndex`, both of which `recognizeValidationPrefix` already produces correctly for a `pre_verify` frame. If either test fails, that disproves the plan's "downstream rules need no change" claim — stop and re-examine before proceeding, don't patch around it.

Run: `cd packages/executor && bunx vitest run`
Expected: PASS, two more tests than Task 1's final count.

- [ ] **Step 3: Commit**

```bash
cd /Users/alexf/skandha
git add packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts
git commit -m "test(executor): prove pre_verify frames get per-role opcode checks for free

No production code change — confirms recognizeValidationPrefix's role
attribution alone is sufficient for the existing per-entity rule loop in
checkEntityCompliance to catch a violation inside a pre_verify frame."
```

---

## Task 3: UI — label `pre_verify` frames instead of "deploy or post-operation"

**Files:**
- Modify: `packages/devnet-ui/src/logic/frames.ts`
- Test: `packages/devnet-ui/src/logic/logic.test.ts`

**Interfaces:**
- Consumes: `Check[]` (`packages/devnet-ui/src/protocol/schemas.ts`), specifically each check's `entity` field — already present on every `RuleCheck`/`Check` the backend produces for a `pre_verify` frame (Task 1/2 need no explorer-side change for this to exist; `entity`/`frameIndex` attribution flows through automatically once `recognizeValidationPrefix` attributes the role correctly).
- Produces: `frameRole(mode: number, flags: number, entity?: Entity): string` — signature change (was `(mode: number, flags: number)`); `describeFrames` passes each frame's already-resolved `entity` through.

- [ ] **Step 1: Write the failing test**

Add to `packages/devnet-ui/src/logic/logic.test.ts`, inside the existing `describe("frames", ...)` block (after the `"names a frame by its mode and scope"` test):

```ts
  it("labels a DEFAULT-mode frame by entity: factory is deploy, sender/payer is a pre-validation write, neither is ambiguous", () => {
    expect(frameRole(0, 0, "factory")).toBe("deploy");
    expect(frameRole(0, 0, "sender")).toBe("pre-validation write");
    expect(frameRole(0, 0, "payer")).toBe("pre-validation write");
    expect(frameRole(0, 0, undefined)).toBe("deploy or post-operation");
  });
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" src/logic/logic.test.ts -t "labels a DEFAULT-mode frame by entity"`
Expected: FAIL with a TypeScript error (`frameRole` doesn't accept a third argument) or, if TS is lenient about the extra argument at the test boundary, a runtime assertion failure — either way, confirm it's failing because the disambiguation doesn't exist yet, not a typo in the test.

- [ ] **Step 3: Implement**

In `packages/devnet-ui/src/logic/frames.ts`, change `frameRole`:

```ts
/** What a frame is for, from its mode, approval scope and (for a DEFAULT-mode frame) entity. */
export function frameRole(mode: number, flags: number, entity?: Entity): string {
  if (mode === MODE_VERIFY) {
    switch (flags & SCOPE_MASK) {
      case 1:
        return "payment approval";
      case 2:
        return "execution approval";
      case 3:
        return "self-verification";
      default:
        return "expiry check";
    }
  }
  if (mode === MODE_SENDER) return "user operation";
  if (mode === MODE_DEFAULT) {
    if (entity === "factory") return "deploy";
    if (entity === "sender" || entity === "payer") return "pre-validation write";
    return "deploy or post-operation";
  }
  return "unknown frame";
}
```

Update `describeFrames` (same file) to pass each frame's resolved entity through — it already computes `entities` and looks up `entity: entities.get(index)` per frame, so only the `frameRole` call site needs the third argument:

```ts
export function describeFrames(frames: WireFrame[], checks: Check[], statuses?: FrameRunStatus[]): FrameView[] {
  const entities = entitiesByFrame(checks);
  return frames.map((frame, index) => ({
    index,
    mode: frame.mode,
    modeName: modeName(frame.mode),
    role: frameRole(frame.mode, frame.flags, entities.get(index)),
```

(Only the `role:` line changes — every other field in the returned object stays as it is today.)

- [ ] **Step 4: Run it, verify it passes**

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)" src/logic/logic.test.ts`
Expected: PASS — every test in the file, including the new one and the pre-existing `"describes each frame with role, scope, gas, value and data size"` test (which exercises `describeFrames` end-to-end and must still pass unchanged, since its fixture frames are `VERIFY`/`SENDER`-mode, not `DEFAULT`-mode, so `frameRole`'s new branch never triggers for it).

Run: `cd packages/devnet-ui && bunx vitest run --root "$(pwd)"`
Expected: PASS — full suite, same count as before plus one.

Run: `cd packages/devnet-ui && bunx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha
git add packages/devnet-ui/src/logic/frames.ts packages/devnet-ui/src/logic/logic.test.ts
git commit -m "feat(devnet-ui): label a pre_verify frame distinctly from deploy/post-op

frameRole() now takes the frame's already-resolved entity (from the
admission report's checks, already present with no backend change) to
tell deploy (factory), a pre_verify write (sender/payer) and an
unattributed DEFAULT-mode frame (today's fallback label) apart."
```
