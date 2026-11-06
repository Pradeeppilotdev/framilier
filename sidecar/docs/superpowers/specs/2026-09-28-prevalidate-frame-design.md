# `pre_verify` Frame Support (ERC-2028 Prefix Shapes)

Date: 2026-09-28
Status: Draft, awaiting review

## Goal

Recognize the `pre_verify` validation-prefix frame subclass defined by [ERC-2028, "Frame Transaction
Alternative Mempools"](https://github.com/ethereum/ERCs/pull/2028) (`PREFIX-010` to `PREFIX-120`), so
The sidecar can admit a transaction whose validation prefix writes state before it approves — the
paymaster-pulls-an-ERC-20-payment case ERC-7562 supported under ERC-4337 and EIP-8141's canonical
mempool alone cannot express. Alex needs to demonstrate a state-writing validation prefix soon,
ahead of full ERC-2028 support.

## Scope

Only the frame-shape and structural-recognition pieces of ERC-2028: the `pre_verify` frame
subclass, its place in the four validation-prefix shapes, and the one new structural check it
needs. Everything else downstream (opcode, storage, CREATE, budget) already applies per-role
across however many frames that role owns, so it needs no change to cover `pre_verify` frames —
see [Downstream rules](#downstream-rules-unchanged).

## Non-goals

- `BUDGET-010`'s per-entity, staked-vs-unstaked gas budget (`MAX_VERIFY_GAS_STAKED_ENTITY`). The
  existing combined-sum check over the whole prefix stays, and will include `pre_verify` frames'
  gas automatically (see [Downstream rules](#downstream-rules-unchanged)).
- `CALLING-030`'s CALL-with-value exemption for `pre_verify` frames. Not needed for an ERC-20
  `transferFrom`-shaped pull (value 0); a `pre_verify` frame that sends ETH value is out of scope
  and will be rejected by the existing nested-call-value rule (OP-061) as before.
- `PREFIX-110`'s "target must have deployed code" requirement — see [§3](#3-prefix-110s-deployed-code-half-deferred-not-implemented).
- Everything else in ERC-2028: the Staking Registry contract, reputation/banning, payer-solvency
  reservation, propagation/peer-scoring rules, replacement/eviction/revalidation lifecycle. Those
  define a distinct alternative mempool ruleset; the sidecar's canonical mempool stays on the current
  ERC-7562-derived ruleset for all of that. Picking this back up is a separate, later piece of work
  (see `[[project-erc2028-prefix-shapes]]` memory).
- `PREFIX-120` (an approving frame's code must check its preceding `pre_verify` frame's status
  before calling `APPROVE`) is a requirement on the *validated contract's* code, not on the sidecar.
  The ERC itself says a node cannot verify it in general; nothing to implement here.

## Background: current prefix recognition

`recognizeValidationPrefix` (`packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts`)
matches exactly four fixed frame-mode sequences:

- `[self_verify]`
- `[deploy, self_verify]`
- `[only_verify, pay]`
- `[deploy, only_verify, pay]`

Frame subclass (`self_verify`/`only_verify`/`pay`/`deploy`/`expiry_verify`) comes from
`classifyFrame()` (`packages/types/src/contracts/frameModes.ts`) for `VERIFY`-mode frames, which
`flags` alone distinguish unambiguously. A `DEFAULT`-mode frame is ambiguous by mode/flags alone
(`deploy` vs. a post-prefix `post_op` body frame) and is disambiguated positionally: only the
matcher, not `classifyFrame()`, currently decides "first frame of the prefix" means `deploy`.

`validateStructuralRules` then re-scans `tx.frames[0..lastPrefixIndex]` (the full prefix range,
including a leading `expiry_verify` frame the matcher's shape-matching skips) for the
ATOMIC_BATCH_FLAG check, the combined execution/state gas budget sum, and the
no-`VERIFY`-frame-after-the-prefix check.

Each recognized frame in `ValidationPrefixMatch.frames` carries `{frame, frameIndex, role}`, where
`role` is `"sender" | "payer" | "factory"`. Every rule downstream of recognition (`OP-011` banned
opcodes, `storage`, `CREATE`, `entrypoint-access`) is keyed off that `role`, iterated across
whichever frames that role owns — not off frame mode directly.

## Design

### 1. No new frame subclass needed

`classifyFrame()` (`packages/types/src/contracts/frameModes.ts`) is unchanged — a `DEFAULT`-mode
frame still classifies as `DEPLOY_OR_POST_OP` from mode/flags alone, exactly as today.
`pre_verify` needs the *next* frame's subclass and `tx.sender` to identify (§2), which a
single-frame, context-free function structurally cannot provide — the same reason `classifyFrame()`
already can't tell `deploy` from a post-prefix `post_op` frame by itself. `pre_verify` is a second
positional/contextual reinterpretation of that same `DEFAULT`-mode bucket, made entirely inside
`recognizeValidationPrefix`, alongside the existing `deploy` reinterpretation — no new exported
constant, since nothing outside `validationPrefix.ts` needs to name it.

### 2. Prefix recognition: classify approving frames first, `DEFAULT` frames by exclusion

**The ambiguity this resolves:** today, `recognizeValidationPrefix` decides "this prefix has a
`deploy` frame" purely by position — `hasDeploy = classifyFrame(frames[0]) === DEPLOY_OR_POST_OP`
(`validationPrefix.ts:79`). That works only because `deploy` is currently the *only* `DEFAULT`-mode
subclass the prefix can contain. Once `pre_verify` exists, a leading `DEFAULT`-mode frame is
ambiguous by position alone: it could be `deploy`, or a `pre_verify` attached to the `self_verify`/
`only_verify` frame that follows it.

**The resolving algorithm** (confirmed with Alex 2026-09-28): `self_verify`/`only_verify`/`pay` are
unambiguous from `classifyFrame()` alone (`VERIFY`-mode, disambiguated by `flags`). Recognition
finds those approving frames first — which simultaneously fixes the shape skeleton (Self Relay vs.
Canonical Paymaster) and resolves `sender`'s (`tx.sender`, always known) and `payer`'s (the
`self_verify`/`pay` frame's target) addresses. Every remaining `DEFAULT`-mode frame in the prefix is
then classified by exclusion, checked against those two resolved targets, not by position first:

- Immediately precedes an approving frame **and** its own resolved target equals that frame's
  resolved target → `pre_verify`, attributed that frame's role (`sender` for one before
  `self_verify`/`only_verify`, `payer` for one before `pay`).
- Otherwise, at the prefix's leading position (not counting a skipped `expiry_verify`) → `deploy`,
  role `factory`. Its target is guaranteed to be neither `sender`'s nor `payer`'s resolved address —
  exactly the "target matches neither known role" exclusion that makes it not a valid `pre_verify`
  candidate. (`deploy` calls a distinct factory contract that `CREATE2`s `tx.sender`'s code; it
  cannot sensibly target `tx.sender` itself, which has no code yet, or the payer.) This preserves
  today's fully positional `deploy` detection unchanged for every transaction that doesn't use
  `pre_verify` at all — deploy classification only actually depends on the new "did this frame first
  qualify as pre_verify" check, which fails identically to today's (nonexistent) check whenever no
  `pre_verify` frame is present.
- Anywhere else (adjacent to an approving frame but a target mismatch, or not adjacent to any
  approving frame at all) → the prefix does not match this shape attempt; `recognizeValidationPrefix`
  returns `null` for it (same fail-closed behavior `PREFIX-110`'s blanket "neither deploy nor
  pre_verify MUST cause rejection" describes).

This makes each of the 4 canonical shapes have up to 2 independently-optional `pre_verify`
insertion points (one per approving frame): up to 4 concrete variants of `[only_verify, pay]`/
`[deploy, only_verify, pay]` each, 2 of `[self_verify]`/`[deploy, self_verify]` each — 12 total
recognized shapes, produced by one algorithm, not 12 hardcoded patterns.

`ValidationPrefixMatch.frames` already supports more than one frame per role as a plain array; no
type change needed, only population logic in the matcher. `payerFrameIndex` continues to point at
the approving `pay`/`self_verify` frame specifically (the one that actually calls `APPROVE` and sets
`payer`), never at a preceding `pre_verify` frame.

### 3. `PREFIX-110`'s deployed-code half: deferred, not implemented

The target-match half of `PREFIX-110` is absorbed into recognition itself (§2) — a target mismatch
there means the frame doesn't qualify as `pre_verify` at all. The other half — a `pre_verify`
frame's target must have deployed code — is **not** implemented in this pass. `EXPLORER_RULES.CODE_ACCESS`
(COD-010, `frameTx.ts:779-796`) only inspects addresses that already appear as keys in the trace's
`contractSize` map, and every existing test fixture (`ethrexFrame()` in `frameTx.test.ts`) leaves
that map empty by default — whether ethrex's tracer reliably populates an entry for a frame's own
plain `CALL` target (as opposed to only when the frame's own code explicitly runs an
`EXTCODESIZE`/`EXTCODECOPY`/`EXTCODEHASH`-family opcode) isn't something this codebase's existing
tests establish either way, and isn't verifiable from this repo alone (ethrex's tracer is a
separate codebase). Getting this wrong in either direction is a real correctness question, not
something to guess into the plan. A `pre_verify` frame targeting genuinely undeployed code will
most likely still fail in practice regardless (the approving frame's own logic depends on the
`pre_verify` frame's write having happened, e.g. an ERC-20 balance actually moving), so this gap is
acceptable for a first pass. Revisit if it turns out to matter.

A `pre_verify` frame that fails to structurally match still causes `recognizeValidationPrefix` to
return `null` for that shape attempt (same fail-closed behavior as today: an unrecognized prefix is
rejected at the `prefix` rule, not silently reinterpreted as a different shape).

### 4. Downstream rules: unchanged {#downstream-rules-unchanged}

No changes needed to:

- **Budget** (`BUDGET-010`/`020`, currently `FRA-040`): the combined-sum loop already scans
  `tx.frames[0..lastPrefixIndex]`. Once `pre_verify` frames are part of the recognized prefix range,
  their `limits.execution`/`limits.state` are included automatically.
- **ATOMIC_BATCH_FLAG scan** and **no-`VERIFY`-after-prefix scan**: same reasoning — both already
  scan the full `[0..lastPrefixIndex]` range structurally, independent of role or subclass.
- **Opcode/storage/CREATE rules** (`OP-011`, `storage`, `COD-010`, `entrypoint-access`): already
  iterate per role across all of that role's frames' trace data (`packages/executor/src/services/
  UserOpValidation/validators/frameTx.ts`). A `pre_verify` frame's accesses get checked exactly like
  its approving frame's, once it's attributed the right role — no special-casing by frame subclass
  needed here, unlike `CREATE`, which stays keyed to `role === "factory"` specifically and is
  correctly unaffected (`pre_verify` frames never get `factory`'s `CREATE` exemption).

### 5. UI

`logic/frames.ts`'s `frameRole()` (`packages/devnet-ui/src`) returns `"deploy or post-operation"`
for any `DEFAULT`-mode frame today, since the UI has no positional context to disambiguate. Once the
explorer's admission record carries per-frame subclass/role data richer than raw mode (already
partly true via `RuleCheck.entity`/`frameIndex`), a `pre_verify` frame should get its own label
instead of the generic deploy-or-post-op one. Exact wiring (does the explorer already have enough
information per-frame to tell `pre_verify` apart from `deploy`/`post_op`, or does this need a new
field) needs a look during implementation; flagged here so it isn't dropped silently.

## Testing

- `packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts`: shape matching
  with and without a `pre_verify` frame at each of the two insertion points, per canonical shape;
  target-mismatch rejection (§2's exclusion algorithm correctly falls through to `deploy` or to no
  match, per case).
- `packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts`: end-to-end
  admission of a shape containing `pre_verify`, confirming role attribution flows through to the
  opcode/storage checks — a banned opcode inside a `pre_verify` frame is caught under the right
  role, exactly like today's approving-frame case.

## Open items

- ~~The UI `frameRole()` gap~~ — done; `frameRole()` now takes each frame's resolved entity and
  labels `pre_verify` distinctly (`packages/devnet-ui/src/logic/frames.ts`).
- **ethrex itself does not yet recognize `pre_verify` shapes.** Found during final review of the
  implementation (2026-09-28): ethrex's `ethrex_simulateFrameTransaction` runs its own four-shape
  `validation_prefix()` recognizer first (`crates/common/types/transaction.rs`, the
  `eip8141-tracer`/`forshtat/eip8141-tracer` branches) — anything outside the original four shapes
  is `UnrecognizedPrefix`, so `FrameTxValidationService.validate` rejects it on `!simResult.valid`
  before the sidecar's own recognition logic is ever exercised against a real node. Even the two shapes
  ethrex would accept by misreading a `pre_verify` frame as `deploy` (`[pre_verify, self_verify]`,
  `[pre_verify, only_verify, pay]`) get blocked downstream by ethrex's mempool validation observer
  (`crates/vm/levm/src/vm.rs`/`validation_observer.rs`), which currently allows `SSTORE` only inside
  the `deploy` frame and only on the sender's own storage — an ERC-20 `transferFrom` pull writes the
  token contract's storage, so it still fails. **The sidecar-side code in this plan is fail-closed
  and correct regardless** (it makes the recognition correct so it's *ready* for an ethrex-side
  fix), but the demo this work was meant to unblock needs a matching ethrex change before it can
  actually run against a real node — verify against the real devnet ethrex (`test/e2e/ethrex-devnet.sh`)
  before relying on this. See `[[project-erc2028-prefix-shapes]]` memory for tracking.
