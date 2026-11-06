# ERC-7562 Combined Standard (ERC-4337 + EIP-8141) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Note on task shape:** this plan produces a specification document, not code. "Tests" below mean *verification steps* — cross-checking a drafted section's claims against the two source documents (ERC-7562, EIP-8141) at specific line numbers — rather than executable test suites. Treat each verification step with the same rigor as a failing/passing test: do not check the box until the cross-reference actually holds.
>
> **Supersedes:** an earlier version of this plan proposed writing a separate standalone document (`erc-7562-frame-tx-mempool.md`). That approach is abandoned. This plan now edits `/Users/alexf/ERCs/ERCS/erc-7562.md` **in place**, turning the existing ERC-7562 into a single combined standard that governs both ERC-4337 UserOperations and EIP-8141 frame transactions. `/Users/alexf/skandha/docs/plans/2026-09-02-frame-tx-bundler-fork.md` (the fork implementation plan) has already been updated to point at `erc-7562.md` directly rather than the abandoned filename.

**Goal:** Turn `/Users/alexf/ERCs/ERCS/erc-7562.md` into a combined standard covering both ERC-4337 `UserOperation`s and [EIP-8141](../../../../EIPs/EIPS/eip-8141.md) frame transactions, by (1) defining a terminology mapping from ERC-4337/ERC-7562 entity names to EIP-8141 frame-transaction concepts, (2) marking every existing rule that only applies to the `UserOperation`/`handleOps`/`EntryPoint`-contract model as such, in place, and (3) adding a new `FRA-*` rule family for concepts that exist only for frame transactions (validation-prefix shape, `APPROVE` semantics, atomic batching, two-dimensional gas, etc.), while leaving every rule that genuinely generalizes across both transaction types untouched except for a resolved-via-terminology-mapping note where needed.

**Architecture:** The terminology mapping does most of the work. Because ERC-7562's rule families are already written in terms of abstract "entities" (`account`, `factory`, `paymaster`, `aggregator`) rather than concrete ERC-4337 struct fields, most rules — the Opcode Rules, Storage Rules, Local Rules, and the bulk of the Reputation Rules — need **no prose change at all** once the Terminology Mapping section tells the reader how to resolve "paymaster" or "account" for a frame transaction. Only rules that reference a mechanism with no frame-tx analogue (the `EntryPoint` contract's deposit API, `handleOps` bundle assembly, the paymaster `context` return channel, EIP-7702 authorization tuples, cross-op bundle interactions) need an inline "ERC-4337 only" marker. Only mechanisms with no ERC-4337 analogue (validation-prefix recognition, `APPROVE` scope enforcement, atomic batches, two-dimensional execution/state gas, the expiry verifier frame, deploy-frame determinism) get new `FRA-*` rules.

**Tech Stack:** Markdown, ERC/EIP front-matter conventions (the document's own existing front matter, extended).

**Spec:** This plan is self-contained — the "spec" it implements is the rule-by-rule disposition already established in conversation, re-grounded here in the *in-place-editing* mechanism instead of a new-document mechanism. Three source files:
- `/Users/alexf/ERCs/ERCS/erc-7562.md` (426 lines as of this plan's writing) — the document being edited. Every task below references this file's **original** line numbers as anchors; if an earlier task in this plan has already inserted content above a given anchor, use the anchor's *content* (a quoted line, not just a number) to relocate it, since line numbers shift as the document grows.
- `/Users/alexf/ERCs/ERCS/erc-4337.md` (647 lines) — background/rationale context for what a given rule was originally protecting against.
- `/Users/alexf/EIPs/EIPS/eip-8141.md` (1470 lines) — the frame transaction protocol whose concepts populate the Terminology Mapping section and the new `FRA-*` rules.

## Global Constraints

- **NO GIT COMMITS. NO GIT PUSHES. Ever, for any task in this plan.** Every task below ends with a step that used to say "Commit" — those steps now say "Stop — do not commit" and must be followed literally: make the edit, run the verification, leave the result sitting in the working tree (staged or unstaged, doesn't matter), and move on to the next task's Step 1. Do not run `git add`, `git commit`, `git push`, or any other command that changes git history or remote state, at any point while executing this plan, regardless of what any individual step's leftover wording might otherwise suggest. The user reviews every changed character in `erc-7562.md` themselves before anything is committed. If a later revision of this plan is ever edited and a "Commit" step reappears by mistake, that is a bug in the plan, not an instruction to follow — treat this constraint as overriding any conflicting step text.
- **Backward compatibility is load-bearing.** `erc-7562.md` is a live, Draft-status ERC with existing tooling built against it (this plan's companion fork, and presumably others). A reader who only cares about ERC-4337 must be able to read the document exactly as before: every rule ID keeps its number, every rule's operative text for the `UserOperation` case is unchanged, and "ERC-4337 only" markers must not alter what the rule requires for `UserOperation`s — they only scope it. Never renumber or delete an existing rule ID; a rule that no longer generally applies gets marked, not removed (matching the document's own existing convention for `GREP-030`/`SREP-020`/etc., which use `REMOVED`/`MOVED TO` rather than deletion).
- Every new rule MUST carry a `[FRA-###]` tag, numbered sequentially starting at `[FRA-010]`, incrementing by 10 (matching the existing document's numbering convention within a family).
- Every "ERC-4337 only" marker MUST be a short parenthetical immediately after the rule's `[XXX-###]` tag, in the form: `*(ERC-4337 UserOperation only — <one-clause reason>; see Terminology Mapping)*`. Do not bury the marker in a separate table — it must be visible at the point of reading, since that's what makes the document usable by a 4337-only reader skimming rule by rule.
- Every entity-name resolution (`account`, `factory`, `paymaster`, `aggregator`, `EntryPoint`, `context`, `deposit`, `stake`, `bundle`) needed anywhere in the document must be resolvable by looking up the Terminology Mapping section — no rule may introduce a second, competing definition of what "paymaster" means for a frame transaction.
- No task may silently drop an existing `erc-7562.md` rule ID. The self-review task (Task 13) checks this exhaustively, exactly as the prior version of this plan did, adapted for in-place editing.

---

## File Structure

| File | Responsibility |
|---|---|
| `/Users/alexf/ERCs/ERCS/erc-7562.md` | The document being edited in place — every task below modifies this single file. |
| `/Users/alexf/skandha/docs/plans/native-aa-mempool-crosscheck.md` | A scratch cross-check table (rule ID → marking/addition → source line refs), built alongside the edits and used by Task 13's self-review. Not part of the final deliverable. |

---

### Task 1: Terminology Mapping section

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — insert a new subsection immediately after the existing `### Definitions` section (which currently ends at original line 106, item 8 "Spammer") and before `### Reputation Definitions` (which currently begins at original line 108).

**Interfaces:**
- Consumes: EIP-8141's `Frame`/`FRAME_MODE`/`APPROVE_SCOPE` model (EIP-8141 §Frame object, §APPROVE Instruction) as the source of truth for how each term resolves.
- Produces: the `### Terminology Mapping` subsection every later task's "ERC-4337 only" markers and general-rule read of "entity" depend on.

- [ ] **Step 1: Write the mapping table**

```markdown
### Terminology Mapping

This document's rules are written in terms of abstract entities and
mechanisms — `account`, `factory`, `paymaster`, `aggregator`,
`EntryPoint`, `context`, `deposit`, `stake`, `bundle` — that originate
from [ERC-4337](./eip-4337.md)'s `UserOperation` model. Since this
document also governs [EIP-8141](./eip-8141.md) frame transactions, this
section defines how each term resolves for a frame transaction. A rule
below that does not carry an explicit *(ERC-4337 UserOperation only)*
marker applies to both transaction types, with entity names resolved per
this table.

| Term (as used throughout this document) | ERC-4337 `UserOperation` meaning | EIP-8141 frame transaction meaning |
|---|---|---|
| **account** / **sender** | The `sender` field's Smart Contract Account. | `tx.sender` — specifically, the `resolved_target` of the `VERIFY`-mode frame that successfully calls `APPROVE(APPROVE_EXECUTION)` or `APPROVE(APPROVE_EXECUTION_AND_PAYMENT)` (EIP-8141 §APPROVE Instruction requires `resolved_target == tx.sender` for either). |
| **paymaster** | The `paymaster` field's contract, if present. | The `resolved_target` of the `VERIFY`-mode frame that successfully calls `APPROVE(APPROVE_PAYMENT)` or `APPROVE(APPROVE_EXECUTION_AND_PAYMENT)` — i.e. the `pay` or `self_verify` mode subclass (EIP-8141 §Mode Subclassifications). When a single `self_verify` frame handles both scopes, **account and paymaster coincide**, exactly matching the ERC-4337 case of an empty `paymaster` field ("sender pays for gas by itself"). |
| **factory** | The `factory`/`factoryData` fields' contract, if present. | The `resolved_target` of the first `deploy`-mode frame (`DEFAULT` mode, first frame in the validation prefix) — see EIP-8141 §Mode Subclassifications and §Public Mempool-recognized Validation Prefixes. |
| **aggregator** | An authorizer contract enabling shared validation across multiple `UserOperation`s (ERC-4337 §Definitions). | **Not defined.** A frame transaction carries exactly one `sender` field (EIP-8141 §Payload Encoding); there is no substrate for cross-sender signature aggregation. Every rule below referencing an aggregator is marked *(ERC-4337 UserOperation only)*. |
| **EntryPoint** (as a contract) | A singleton, externally deployed contract exposing `handleOps`, a deposit ledger (`balanceOf`/`depositTo`/`withdrawTo`), and a stake ledger (`addStake`/`unlockStake`/`withdrawStake`). | **Not defined as a contract.** `ENTRY_POINT` (`address(0xaa)`, EIP-8141 §Constants) is a protocol constant, observed only as a frame's `caller`, returned by `ORIGIN` in `DEFAULT`/`VERIFY`-mode frames. It holds no ledger. Rules that depend on calling the `EntryPoint` contract are marked *(ERC-4337 UserOperation only)*. |
| **`UserOperation`** | The pseudo-transaction struct itself. | A frame transaction (`FRAME_TX_TYPE = 0x06`), when this document's rules are being applied to that transaction type. |
| **`validateUserOp` call** | A named interface method on the account. | Not a named call — the code a `VERIFY`-mode frame executes before calling `APPROVE(APPROVE_EXECUTION[...])`. |
| **`validatePaymasterUserOp` call** | A named interface method on the paymaster. | Not a named call — the code a `VERIFY`-mode frame executes before calling `APPROVE(APPROVE_PAYMENT)`. |
| **context** (paymaster-returned bytes) | An ABI `bytes` value returned by `validatePaymasterUserOp`, later passed to `postOp`. | **Not defined.** Data that would flow through `context` instead flows through `FRAMEDATALOAD`/`FRAMEDATACOPY` introspection of other frames' already-signed `data` fields (EIP-8141 §Introspection). Rules referencing `context` are marked *(ERC-4337 UserOperation only)*. |
| **deposit** | A balance held by the `EntryPoint` contract, debited by `handleOps`. | The payer's own account balance, debited directly by `APPROVE` (EIP-8141 §APPROVE Instruction) — there is no separate ledger to hold a deposit in. |
| **stake** | Tracked by the `EntryPoint` contract's `addStake`/`unlockStake`/`withdrawStake`, subject to `MIN_STAKE_VALUE`/`MIN_UNSTAKE_DELAY`. | Tracked by a separate **Staking Registry** contract (not part of the EIP-8141 protocol surface — see [Appendix A](#appendix-a-staking-registry-contract)), since `ENTRY_POINT` holds no ledger. The same `MIN_STAKE_VALUE`/`MIN_UNSTAKE_DELAY` thresholds apply. |
| **bundle** / **`handleOps` call** | The batched transaction a bundler submits, containing multiple `UserOperation`s. | **Not defined.** A frame transaction is itself the L1 transaction (EIP-8141 §Payload Encoding); there is no outer call batching several senders' operations together. Rules referencing bundle assembly are marked *(ERC-4337 UserOperation only)*; where a rule's *intent* still applies with "bundle creation" reread as "this node's own attempt to get the transaction included in a block," that reading is noted inline rather than forking the rule. |
```

- [ ] **Step 2: Verify against source — cross-check step**

Confirm each frame-transaction-column claim against `eip-8141.md`: the `APPROVE_EXECUTION`/`APPROVE_PAYMENT`/`resolved_target == tx.sender` requirement (§APPROVE Instruction, `Behavior`), the `deploy` mode subclass definition (§Mode Subclassifications), the single `sender` field (§Payload Encoding line 69), `ENTRY_POINT` as a protocol constant (§Constants line 39), and the `FRAMEDATALOAD`/`FRAMEDATACOPY` introspection mechanism (§Introspection). Record each confirmed line range in `/Users/alexf/skandha/docs/plans/native-aa-mempool-crosscheck.md`.

Expected: every claim resolves to an actual line in `eip-8141.md`, not a paraphrase drifted from the source.

- [ ] **Step 3: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 2: Front matter, Abstract, Motivation — extend scope

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — front matter (original lines 1–11) and Abstract/Motivation (original lines 13–39).

**Interfaces:**
- Consumes: nothing.
- Produces: front matter and framing text that describe the document as covering both transaction types, without altering any operative rule.

- [ ] **Step 1: Extend the front matter's `requires` and `description` fields**

Current (original lines 1–11) reads, in relevant part, `description: A set of limitations on validation EVM code to protect Account Abstraction nodes from denial-of-service attacks through unpaid computation.` with no `requires` field referencing EIP-8141. Edit to:

```markdown
description: A set of limitations on validation EVM code to protect Account Abstraction nodes from denial-of-service attacks through unpaid computation, covering both ERC-4337 UserOperations and EIP-8141 frame transactions.
```

Add `8141` to the `requires` line if one exists, or add a `requires: 4337, 8141` line if the front matter doesn't currently declare one (confirm current state by reading the live front matter before editing — do not assume it matches this plan's memory of the file verbatim, since the user may have edited it since this plan was written).

- [ ] **Step 2: Add one sentence to the Abstract noting dual scope**

Append to the existing Abstract paragraph (original lines 13–15):

```markdown
This document also defines the equivalent validation rules for
[EIP-8141](./eip-8141.md) frame transactions, which achieve native
account abstraction without a `UserOperation` mempool or `EntryPoint`
contract. See [Terminology Mapping](#terminology-mapping) for how this
document's entity vocabulary resolves for a frame transaction.
```

- [ ] **Step 3: Add one paragraph to the Motivation noting the shared DoS-safety goal across both models**

Append after the existing Motivation's final paragraph (original lines 33–39, ending "we propose a set of transaction validation rules..."):

```markdown
[EIP-8141](./eip-8141.md)'s frame transactions replace the `EntryPoint`-
contract-and-bundler architecture with a native transaction type, but
face the identical DoS-safety problem: validation logic is arbitrary EVM
code, so a node accepting a transaction into its mempool before it pays
must still bound what state that validation logic can depend on. The
rules in this document apply to both models; where a rule's mechanism is
specific to one, it is marked accordingly (see [Terminology
Mapping](#terminology-mapping)).
```

- [ ] **Step 4: Cross-check step**

Re-read the edited front matter/Abstract/Motivation as one continuous block and confirm no existing sentence describing ERC-4337-specific behavior was altered — only additions, no rewrites of prior text.

Expected: a diff against the pre-edit version shows pure insertions, zero deletions or rewordings of existing sentences.

- [ ] **Step 5: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 3: Constants — add frame-tx-specific constants, annotate nonce-parallelism limit

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — `### Constants` table (original lines 55–77).

**Interfaces:**
- Consumes: nothing.
- Produces: the Constants table extended with `MAX_VERIFY_STATE_GAS` and an inline note on `SAME_SENDER_MEMPOOL_COUNT`'s frame-tx applicability.

- [ ] **Step 1: Add a new table row for the two-dimensional gas model's state-gas cap**

Insert after the existing `VALIDATION_GAS_SLACK` row (the table's last row, original line 77):

```markdown
| `MAX_VERIFY_STATE_GAS`               | 500000                      | *(EIP-8141 frame transactions only — see [FRA-050](#frame-transaction-rules))* Maximum state gas ([EIP-8037](./eip-8037.md)) budgeted across a frame transaction's validation prefix. ERC-4337's single-dimensional gas model has no equivalent to meter. |
```

- [ ] **Step 2: Add an inline note to the existing `SAME_SENDER_MEMPOOL_COUNT` row**

Edit the existing row (original line 61) from:

```markdown
| `SAME_SENDER_MEMPOOL_COUNT`          | 4                           | Maximum number of UserOperations allowed in the mempool from a single sender                                            |
```

to:

```markdown
| `SAME_SENDER_MEMPOOL_COUNT`          | 4                           | Maximum number of UserOperations allowed in the mempool from a single sender. *(For an EIP-8141 frame transaction, this value cannot be reached: EIP-8141's `nonce` field is checked as `tx.nonce == state[tx.sender].nonce`, a strictly sequential value with no ERC-4337-style 192-bit-key/64-bit-sequence parallelism, so only one valid pending nonce per sender can exist regardless of this constant.)* |
```

- [ ] **Step 3: Cross-check step**

Confirm `MAX_VERIFY_STATE_GAS`'s default value and rationale against `eip-8141.md`'s Mempool §Constants table (search for `MAX_VERIFY_STATE_GAS`). Confirm the nonce claim against `eip-8141.md` §Behavior (`Ensure tx.nonce == state[tx.sender].nonce`).

Expected: both resolve; note that this document's own `MAX_VERIFY_STATE_GAS` default MAY differ from EIP-8141's public-mempool value if this document's operators choose to run a private mempool with different policy — record that as an open parameter, not a hard requirement to match EIP-8141 exactly, consistent with this document's general posture of defining validation-safety rules rather than mandating a specific mempool's admission policy.

- [ ] **Step 4: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 4: "Running the Validation Rules" — mark the third pass ERC-4337-only

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — `### Running the Validation Rules` (original lines 136–144).

**Interfaces:**
- Consumes: the `bundle` mapping from Task 1.
- Produces: item 4 of this section (the third-validation-pass requirement) marked ERC-4337-only, with a one-sentence frame-tx equivalent noted.

- [ ] **Step 1: Edit item 4**

Current (original lines 141–142):

```markdown
4. The validation rules prevent an unstaked entity from altering its behavior between simulation and execution of the `UserOperation`.
   However, a malicious staked entity can detect that it is running as part of a bundle validation and cause a revert. Thus, a third tracing simulation of the entire bundle should be performed before submission.
```

Edit to:

```markdown
4. The validation rules prevent an unstaked entity from altering its behavior between simulation and execution of the `UserOperation`.
   However, a malicious staked entity can detect that it is running as part of a bundle validation and cause a revert. Thus, a third tracing simulation of the entire bundle should be performed before submission. *(This entire item is ERC-4337 UserOperation only — see Terminology Mapping, "bundle." A frame transaction has no bundle-assembly step for a staked entity to detect and game between its second validation and inclusion, so the two passes above are sufficient; no third pass is required.)*
```

- [ ] **Step 2: Cross-check step**

Confirm the reasoning matches this plan's earlier-established finding (already verified against `eip-8141.md` in this conversation's prior turns: no `handleOps`-equivalent outer-call assembly step exists).

Expected: consistent with prior analysis; no new claim introduced that hasn't already been checked.

- [ ] **Step 3: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 5: Opcode Rules — mark `ORIGIN`, `BLOBHASH`, and `EntryPoint`-access rules

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — `### Opcode Rules` (original lines 161–208), specifically `[OP-011]` and `[OP-051]`–`[OP-055]`.

**Interfaces:**
- Consumes: the `EntryPoint` mapping from Task 1.
- Produces: `[OP-011]`'s `ORIGIN`/`BLOBHASH` entries and `[OP-051]`–`[OP-055]` each marked ERC-4337-only, with `SLOTNUM`/`SETDELEGATE` added to the blocked-opcode list generally (both transaction types should treat them identically once encountered — no marker needed on those two additions).

- [ ] **Step 1: Edit `[OP-011]`'s blocked-opcode list**

Current (original lines 163–177) lists `ORIGIN` and `BLOBHASH` among the unconditionally blocked opcodes. Edit those two list entries:

```markdown
        * `ORIGIN` (`0x32`) *(ERC-4337 UserOperation only — for an EIP-8141 frame transaction, `ORIGIN` returns the current frame's `caller` (`ENTRY_POINT` in `DEFAULT`/`VERIFY` frames, `tx.sender` in `SENDER` frames per EIP-8141 §Behavior), a value fixed by the transaction's own fields, not external environment state; it is not blocked for frame transactions)*
        * `GASPRICE` (`0x3A`)
        * `BLOCKHASH` (`0x40`)
        * `COINBASE` (`0x41`)
        * `TIMESTAMP` (`0x42`)
        * `NUMBER` (`0x43`)
        * `PREVRANDAO`/`DIFFICULTY` (`0x44`)
        * `GASLIMIT` (`0x45`)
        * `BASEFEE` (`0x48`)
        * `BLOBHASH` (`0x49`) *(ERC-4337 UserOperation only — for an EIP-8141 frame transaction, `BLOBHASH` returns `tx.blob_versioned_hashes[index]` in every frame per EIP-8141 §Blob handling, a transaction field, not external environment state; it is not blocked for frame transactions)*
        * `BLOBBASEFEE` (`0x4A`)
        * `SLOTNUM` (`0x4B`, [EIP-7843](./eip-7843.md)) *(new: added for EIP-8141 frame transactions, which require EIP-7843; blocked for both transaction types)*
        * `CREATE` (`0xF0`), except as allowed by the [Contract Creation](#contract-creation) and [Staked Factory Creation Rules](#staked-factory-creation-rules) rules below
        * `SETDELEGATE` (`0xF6`, [EIP-7819](./eip-7819.md)) *(new: added for EIP-8141 frame transactions — see [FRA-060](#frame-transaction-rules), which supersedes [AUTH-010]–[AUTH-040] for frame transactions; blocked for both transaction types except inside a frame transaction's `deploy` frame)*
        * `INVALID` (`0xFE`)
        * `SELFDESTRUCT` (`0xFF`)
```

- [ ] **Step 2: Edit `[OP-051]`–`[OP-055]`**

Current (original lines 193–199) reads:

```markdown
* Allowed access to the `EntryPoint` address:
    * **[OP-051]** May call `EXTCODESIZE ISZERO`.
      This pattern is used to check that the destination has code before the `depositTo` function is called.
    * **[OP-052]** May call `depositTo(sender)` with any value from either the `sender` or the `factory`.
    * **[OP-053]** May call the fallback function from the `sender` with any value.
    * **[OP-054]** Any other access to the `EntryPoint`, whether via `*CALL` or `EXT*` opcodes, is forbidden.
    * **[OP-055]** May call `incrementNonce()` from the `sender`.
```

Edit to prepend an italic marker to the section header and each item:

```markdown
* Allowed access to the `EntryPoint` address *(ERC-4337 UserOperation only — see Terminology Mapping, "EntryPoint"; an EIP-8141 frame transaction has no `EntryPoint` contract to allow-list calls against. A frame transaction's payment and nonce-increment are native `APPROVE` opcode side effects (EIP-8141 §APPROVE Instruction, `Behavior`), not contract calls, so no analogous rule is needed)*:
    * **[OP-051]** May call `EXTCODESIZE ISZERO`.
      This pattern is used to check that the destination has code before the `depositTo` function is called.
    * **[OP-052]** May call `depositTo(sender)` with any value from either the `sender` or the `factory`.
    * **[OP-053]** May call the fallback function from the `sender` with any value.
    * **[OP-054]** Any other access to the `EntryPoint`, whether via `*CALL` or `EXT*` opcodes, is forbidden.
    * **[OP-055]** May call `incrementNonce()` from the `sender`.
```

- [ ] **Step 3: Cross-check step**

Confirm the `ORIGIN`/`BLOBHASH` redefinition claims against `eip-8141.md` §Behavior (line ~413, `The ORIGIN opcode returns frame's caller throughout all call depths`) and §Blob handling (line ~658). Confirm the `APPROVE` native-side-effect claim against §APPROVE Instruction (lines 699–723).

Expected: all four citations resolve.

- [ ] **Step 4: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 6: Storage Rules and Local Rules — confirm general applicability, no content change expected

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — `### Storage Rules` (original lines 217–228), `### Local Rules` (original lines 230–235). Likely a **no-op edit task** — see Step 1.

**Interfaces:**
- Consumes: the `account`/`factory`/`paymaster` mapping from Task 1.
- Produces: confirmation (recorded in the crosscheck file) that these two sections require no rule-text change, only reliance on Task 1's Terminology Mapping — or, if Step 1 finds a genuine gap, the specific fix for it.

- [ ] **Step 1: Re-read both sections and check whether "entity"/"account"/"paymaster"/"factory" as used in `[STO-010]`–`[STO-041]` already resolve correctly via Task 1's table with zero rewording**

Read `erc-7562.md`'s current Storage Rules and Local Rules text. For each rule (`[STO-010]`, `[STO-021]`, `[STO-022]`, `[STO-031]`, `[STO-032]`, `[STO-033]`, `[STO-040]`, `[STO-041]`), confirm that substituting the Terminology Mapping's frame-tx column for every entity name produces a sensible, correct rule with no dangling ERC-4337-specific assumption (e.g., confirm `[STO-022]`'s "There is an `initCode` and the `factory` contract is staked" reads correctly as "There is a `deploy` frame and its factory is staked" purely by substitution, with no other change needed).

Expected: this should hold for all eight rules, since ERC-7562's Storage/Local Rules were already written generically. If any rule is found not to hold by substitution alone (e.g., a rule assumes a `UserOperation`-specific field name in its own text, not just an entity name), record the specific rule and fix it in Step 2; otherwise skip to Step 3.

- [ ] **Step 2: If Step 1 found a genuine gap, fix it with the minimal edit that makes substitution work**

(Content of this step depends entirely on Step 1's finding — do not write a speculative fix before running Step 1 for real.)

- [ ] **Step 3: Record the finding in the crosscheck file regardless of outcome**

```markdown
## Task 6 finding
Storage Rules / Local Rules: [confirmed clean by substitution / required N fixes, listed below]
```

- [ ] **Step 4: Stop — do not commit (even if Step 1 found nothing to change — the crosscheck record is still a deliverable to leave in the working tree)**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 7: Reputation rule families — mark aggregator/context/bundle-specific rules

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — `### General Reputation Rules` (original lines 237–249), `### Entity-specific Rules` (original lines 261–277), `#### Staked Factory Creation Rules` (original lines 279–285).

**Interfaces:**
- Consumes: the `aggregator`/`context`/`bundle` mappings from Task 1.
- Produces: `[GREP-040]` given a dual-phrasing note, `[EREP-040]`, `[EREP-050]`, `[EREP-055]`, `[EREP-070]` marked ERC-4337-only.

- [ ] **Step 1: Edit `[GREP-040]` with a dual-phrasing note**

Current (original line 248):

```markdown
* **[GREP-040]** If an entity fails bundle creation after passing the second validation, its `opsSeen` is set to `BAN_OPS_SEEN_PENALTY` and its `opsIncluded` to zero, causing it to become `BANNED`.
```

Edit to:

```markdown
* **[GREP-040]** If an entity fails bundle creation after passing the second validation, its `opsSeen` is set to `BAN_OPS_SEEN_PENALTY` and its `opsIncluded` to zero, causing it to become `BANNED`. *(For an EIP-8141 frame transaction, read "fails bundle creation" as "fails this node's own attempt to get the transaction included in a block" — see Terminology Mapping, "bundle." No rewording of the penalty mechanism itself is needed.)*
```

- [ ] **Step 2: Mark `[EREP-040]` ERC-4337-only**

Current (original line 273):

```markdown
* **[EREP-040]** An `aggregator` must be staked, regardless of storage usage.
```

Edit to:

```markdown
* **[EREP-040]** An `aggregator` must be staked, regardless of storage usage. *(ERC-4337 UserOperation only — see Terminology Mapping, "aggregator": no aggregator role exists for an EIP-8141 frame transaction.)*
```

- [ ] **Step 3: Mark `[EREP-050]`/`[EREP-055]` ERC-4337-only**

Current (original lines 274–277):

```markdown
* **[EREP-050]** An unstaked `paymaster` may not return a `context`.
* **[EREP-055]** A `context`'s size may not change between validation and bundle creation.
    If bundle creation reverts and a paymaster's context size was modified, that paymaster
    is `BANNED`, regardless of whether the `UserOperation` that reverted used that paymaster or not.
```

Edit to:

```markdown
* **[EREP-050]** An unstaked `paymaster` may not return a `context`. *(ERC-4337 UserOperation only — see Terminology Mapping, "context": no ABI context-return channel exists for an EIP-8141 frame transaction; data flows via `FRAMEDATALOAD`/`FRAMEDATACOPY` instead.)*
* **[EREP-055]** A `context`'s size may not change between validation and bundle creation. *(ERC-4337 UserOperation only, for the same reason as [EREP-050].)*
    If bundle creation reverts and a paymaster's context size was modified, that paymaster
    is `BANNED`, regardless of whether the `UserOperation` that reverted used that paymaster or not.
```

- [ ] **Step 4: Mark `[EREP-070]` ERC-4337-only**

Current (original lines 284–285):

```markdown
* **[EREP-070]** During bundle creation, if a staked entity reduces its validation gas by more than 10%
    compared to the second validation, that entity is throttled, even if the UserOperation itself did not revert, since this might affect the gas calculation defined by [EIP-7623](./eip-7623.md).
```

Edit to:

```markdown
* **[EREP-070]** During bundle creation, if a staked entity reduces its validation gas by more than 10%
    compared to the second validation, that entity is throttled, even if the UserOperation itself did not revert, since this might affect the gas calculation defined by [EIP-7623](./eip-7623.md). *(ERC-4337 UserOperation only — see Terminology Mapping, "bundle": an EIP-8141 frame transaction has no bundle-assembly step for a staked entity to game between its second validation and inclusion, matching the reasoning already given for the third validation pass in [Running the Validation Rules](#running-the-validation-rules).)*
```

- [ ] **Step 5: Cross-check step**

Confirm all four markers are consistent with Task 1's Terminology Mapping table entries (`aggregator`, `context`, `bundle`) and do not introduce a new claim not already established there.

Expected: consistent; no new fact asserted beyond what Task 1 already verified.

- [ ] **Step 6: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 8: Alt-mempool sections — confirm general applicability

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — `### Alt-mempools Rules` (original lines 300–311), `### Alt-mempool Reputation` (original lines 313–320). Likely another no-op-edit confirmation task.

**Interfaces:**
- Consumes: nothing new.
- Produces: confirmation recorded in the crosscheck file that `[ALT-010]`–`[ALT-040]` and `[AREP-010]`/`[AREP-020]` require no marking, since the alt-mempool mechanism (a P2P topic identifying a different rule set) is transaction-type-agnostic by construction — it governs *which rule set* applies, not the content of any specific rule.

- [ ] **Step 1: Re-read both sections and confirm no ERC-4337-specific assumption is embedded in the alt-mempool mechanism itself**

Expected: confirmed clean — these rules describe a P2P coordination mechanism (topic subscription, propagate-once, per-alt-mempool reputation counters) that applies identically regardless of what transaction type the underlying rule set governs.

- [ ] **Step 2: Record the finding**

```markdown
## Task 8 finding
Alt-mempools Rules / Alt-mempool Reputation: confirmed transaction-type-agnostic, no markers needed.
```

- [ ] **Step 3: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 9: Authorizations — mark ERC-4337-only, cross-reference the new deploy-frame rule

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — `### Authorizations` (original lines 322–328).

**Interfaces:**
- Consumes: nothing yet (forward-references `[FRA-060]`, written in Task 11 — acceptable since this is a documentation cross-reference, not a code dependency; if Task 11 ends up numbering the deploy-frame rule differently than `FRA-060`, this task's cross-reference must be updated to match, and Task 13's self-review must catch it if it isn't).
- Produces: `[AUTH-010]`–`[AUTH-040]` marked ERC-4337-only as a section-level marker (not per-rule, since all four are uniformly EIP-7702-authorization-tuple-specific), pointing to the new frame-tx equivalent.

- [ ] **Step 1: Add a section-level marker immediately under the `### Authorizations` heading**

Current section (original lines 322–328) begins directly with `* **[AUTH-010]** A UserOperation may...`. Insert one sentence immediately after the `### Authorizations` heading, before `[AUTH-010]`:

```markdown
### Authorizations

*(This entire section is ERC-4337 UserOperation only. EIP-8141 frame transactions carry no [EIP-7702](./eip-7702.md) authorization list at all — see Terminology Mapping and EIP-8141 §No authorization list. Native delegation for a frame transaction instead goes through the `deploy` frame's `SETDELEGATE` opcode; see [FRA-060](#frame-transaction-rules).)*

* **[AUTH-010]** A UserOperation may only contain a single [EIP-7702](./eip-7702.md) authorization tuple.
* **[AUTH-020]** An account with EIP-7702 delegation can only be used as the Sender of the UserOperation.
  Using the authorized account as any other kind of UserOperation entity is not allowed.
* **[AUTH-030]** An account with EIP-7702 delegation can only be **accessed** using `*CALL` or `EXTCODE*` opcodes, and only if it is the Sender of the current UserOperation.
* **[AUTH-040]** If there are multiple UserOperations by the same sender with an authorization tuple in the mempool, they all MUST have the same delegate address.
```

(The four rule bodies are unchanged — only the section-level marker sentence is new.)

- [ ] **Step 2: Cross-check step**

Confirm the "No authorization list" claim against `eip-8141.md`'s Rationale section (search for "No authorization list"). Flag this task as needing a revisit once Task 11 is complete, to confirm the `[FRA-060]` cross-reference number is correct.

Expected: quote resolves; cross-reference flagged for later confirmation.

- [ ] **Step 3: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 10: Limitations — mark bundle/context/slack-specific rules, keep LIM-060 general with a caveat

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — `### Limitations` (original lines 330–341).

**Interfaces:**
- Consumes: the `bundle`/`context` mappings from Task 1.
- Produces: `[LIM-010]`, `[LIM-020]`, `[LIM-030]`, `[LIM-040]`, `[LIM-050]`, `[LIM-070]` marked ERC-4337-only; `[LIM-060]` kept general with a field-naming caveat and a forward-reference to `[FRA-050]`.

- [ ] **Step 1: Edit each affected rule**

Current (original lines 335–341):

```markdown
* **[LIM-010]** Maximum size of a single packed and ABI-encoded `UserOperation` in bytes MUST not exceed `MAX_USEROP_SIZE`.
* **[LIM-020]** Maximum size of a `context` byte array returned by a paymaster in a single `UserOperation` in bytes MUST not exceed `MAX_CONTEXT_SIZE`.
* **[LIM-030]** The `verificationGasLimit` and `paymasterVerificationGasLimit` parameters MUST exceed the actual usage during validation of the `UserOperation` by `VALIDATION_GAS_SLACK`.
* **[LIM-040]** Maximum size of an ABI-encoded bundle call to the `handleOps` function in bytes SHOULD not exceed `MAX_BUNDLE_SIZE`.
* **[LIM-050]** Maximum total size of all `context` byte arrays returned by all paymasters in all `UserOperations` in a bundle in bytes SHOULD not exceed `MAX_BUNDLE_CONTEXT_SIZE`.
* **[LIM-060]** The `verificationGasLimit` and `paymasterVerificationGasLimit` parameters MUST each be lower than `MAX_VERIFICATION_GAS`.
* **[LIM-070]** The `preVerificationGas` parameter MUST be high enough to cover the calldata gas cost of serializing the `UserOperation`, plus `PRE_VERIFICATION_OVERHEAD_GAS`.
```

Edit to:

```markdown
* **[LIM-010]** Maximum size of a single packed and ABI-encoded `UserOperation` in bytes MUST not exceed `MAX_USEROP_SIZE`. *(ERC-4337 UserOperation only — bounds memory expansion when packing multiple UserOperations into one `handleOps` call; an EIP-8141 frame transaction has no such packing step, see Terminology Mapping, "bundle.")*
* **[LIM-020]** Maximum size of a `context` byte array returned by a paymaster in a single `UserOperation` in bytes MUST not exceed `MAX_CONTEXT_SIZE`. *(ERC-4337 UserOperation only — see Terminology Mapping, "context.")*
* **[LIM-030]** The `verificationGasLimit` and `paymasterVerificationGasLimit` parameters MUST exceed the actual usage during validation of the `UserOperation` by `VALIDATION_GAS_SLACK`. *(ERC-4337 UserOperation only — this slack compensates for gas-usage drift caused by a UserOperation's position within a bundle changing between simulation and inclusion; an EIP-8141 frame transaction's `frame.limits.execution`/`frame.limits.state` are fixed transaction fields, identical at simulation and inclusion time, so no slack is needed.)*
* **[LIM-040]** Maximum size of an ABI-encoded bundle call to the `handleOps` function in bytes SHOULD not exceed `MAX_BUNDLE_SIZE`. *(ERC-4337 UserOperation only — no bundle exists for an EIP-8141 frame transaction.)*
* **[LIM-050]** Maximum total size of all `context` byte arrays returned by all paymasters in all `UserOperations` in a bundle in bytes SHOULD not exceed `MAX_BUNDLE_CONTEXT_SIZE`. *(ERC-4337 UserOperation only, for the same two reasons as [LIM-020] and [LIM-040].)*
* **[LIM-060]** The `verificationGasLimit` and `paymasterVerificationGasLimit` parameters MUST each be lower than `MAX_VERIFICATION_GAS`. *(ERC-4337 field names. For an EIP-8141 frame transaction, the equivalent bound is stated in terms of `frame.limits.execution`/`frame.limits.state` and `MAX_VERIFY_GAS`/`MAX_VERIFY_STATE_GAS` — see [FRA-050](#frame-transaction-rules).)*
* **[LIM-070]** The `preVerificationGas` parameter MUST be high enough to cover the calldata gas cost of serializing the `UserOperation`, plus `PRE_VERIFICATION_OVERHEAD_GAS`. *(ERC-4337 UserOperation only — a frame transaction's intrinsic cost, `frame_tx_intrinsic_gas`, is computed deterministically by the protocol from the transaction's own fields (EIP-8141 §Gas Accounting), not self-declared and validated against a heuristic minimum.)*
```

- [ ] **Step 2: Cross-check step**

Confirm the `frame_tx_intrinsic_gas` claim against `eip-8141.md` §Gas Accounting (lines 487–518, already cited in this conversation's earlier analysis). Flag `[FRA-050]`'s cross-reference for confirmation once Task 11 lands, same as Task 9's flag.

Expected: quote resolves; cross-reference flagged.

- [ ] **Step 3: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 11: New `### Frame Transaction Rules` section (`[FRA-010]`–`[FRA-080]`)

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — insert a new top-level `### Frame Transaction Rules` subsection. Placement: immediately after `### Limitations` (original lines 330–341, now extended by Task 10) and before `## Rationale` (original line 343), so it reads as the final rule-family section of the Specification, after every existing family has been covered and annotated.

**Interfaces:**
- Consumes: `[FRA-050]`/`[FRA-060]` forward-references from Tasks 9 and 10 — this task must land those exact numbers, or Tasks 9/10 must be revisited to match whatever numbers this task actually assigns.
- Produces: eight new rules (`[FRA-010]`–`[FRA-080]`), each addressing a mechanism with no ERC-4337 analogue.

- [ ] **Step 1: Write the section**

```markdown
### Frame Transaction Rules

The following rules address [EIP-8141](./eip-8141.md) frame transaction
mechanisms with no [ERC-4337](./eip-4337.md) analogue. They apply only to
frame transactions; there is nothing for a `UserOperation` to violate
here; where applicable, cross-referenced from an ERC-4337-only marked
rule elsewhere in this document.

* **[FRA-010]** A frame transaction's validation prefix (the shortest
  prefix of frames whose successful execution sets `payer`, per EIP-8141
  §Validation Prefix) MUST match one of the recognized shapes: `[self_verify]`,
  `[deploy, self_verify]`, `[only_verify, pay]`, or `[deploy, only_verify, pay]`
  (EIP-8141 §Public Mempool-recognized Validation Prefixes), optionally
  preceded by a single `expiry_verify` frame. A frame transaction whose
  validation prefix matches none of these shapes MUST be rejected.
* **[FRA-020]** `self_verify` and `only_verify` frames MUST execute in
  `VERIFY` mode, target `tx.sender` (explicitly or via a null target),
  and successfully call `APPROVE` with a scope matching `frame.flags`:
  `self_verify` MUST call `APPROVE(APPROVE_EXECUTION_AND_PAYMENT)`;
  `only_verify` MUST call `APPROVE(APPROVE_EXECUTION)`. A `pay` frame
  MUST execute in `VERIFY` mode with `flags == APPROVE_PAYMENT` and
  successfully call `APPROVE(APPROVE_PAYMENT)`. (EIP-8141 §Structural Rules.)
* **[FRA-030]** No frame in the validation prefix may carry
  `ATOMIC_BATCH_FLAG`. Atomic batches ([EIP-8141](./eip-8141.md)
  §Atomic batching) are permitted only among `SENDER`/`DEFAULT`-mode
  frames after the validation prefix, where they are outside this
  document's DoS-safety scope (the payer is already committed by the
  time a batch can execute).
* **[FRA-040]** An `expiry_verify` frame (a `VERIFY`-mode frame targeting
  `EXPIRY_VERIFIER`) may appear only as the first frame in the
  transaction. `TIMESTAMP` is otherwise banned during validation-prefix
  execution (see [OP-011]); the sole exception is execution of the
  canonical runtime code at `EXPIRY_VERIFIER` (EIP-8141 §Expiry Verifier
  Frame). A node MUST drop a frame transaction whose `expiry_verify`
  deadline has already passed.
* **[FRA-050]** The sum of `limits.execution` across the validation
  prefix, plus the intrinsic cost of validating `tx.signatures`, MUST NOT
  exceed `MAX_VERIFY_GAS`. The sum of `limits.state` across the
  validation prefix MUST NOT exceed `MAX_VERIFY_STATE_GAS` (see
  [Constants](#constants)). This is the frame transaction equivalent of
  [LIM-060], expressed in EIP-8141's two-dimensional gas terms rather
  than ERC-4337's `verificationGasLimit`/`paymasterVerificationGasLimit`
  fields.
* **[FRA-060]** `CREATE`, `CREATE2`, and `SETDELEGATE` are permitted only
  inside the first `deploy` frame of the validation prefix, and only when
  installing code or an EIP-7702-style delegation indicator at
  `tx.sender` (EIP-8141 §Validation Trace Rules). This is the frame
  transaction equivalent of [AUTH-010]–[AUTH-040]: native delegation for
  a frame transaction has no authorization-tuple envelope to validate,
  since delegation is installed by the `deploy` frame's own execution,
  governed by the same opcode/storage rules as any other validation-
  prefix frame.
* **[FRA-070]** Every entry in `tx.signatures` MUST validate successfully
  against `compute_sig_hash(tx)` (for an empty `msg`) or its explicit
  32-byte `msg` digest (EIP-8141 §Signature Validation) before any frame
  executes. An `ARBITRARY`-scheme signature's raw bytes are witness data
  validated by EVM code inside a frame, not by the protocol; treat such a
  signature's authenticity as no stronger than the validation-prefix
  frame that inspects it.
* **[FRA-080]** Validation code that grants `APPROVE_EXECUTION` (or
  `APPROVE_EXECUTION_AND_PAYMENT`) MUST bind its approval to the entire
  frame list — either by verifying a signature over the canonical
  signature hash (`compute_sig_hash(tx)`, which commits to every frame),
  or by otherwise constraining every subsequent `SENDER`-mode frame
  individually. `sender_approved` is a single transaction-scoped flag
  (EIP-8141 §APPROVE Instruction): once set, every subsequent `SENDER`
  frame executes with `caller = tx.sender`, not only the frame the
  approving code inspected. Validation code that approves on the basis of
  an explicit-digest signature or a check that does not commit to the
  full frame list authorizes an open-ended list of subsequent `SENDER`
  frames, which a node MUST treat as invalid for this document's
  DoS-safety purposes even where EIP-8141 itself states this only as
  wallet-implementer guidance (EIP-8141 §Execution Approval Authorizes
  All Subsequent Sender Frames).
```

- [ ] **Step 2: Fix the forward-references in Tasks 9 and 10 to point at the actual numbers landed here**

Confirm `[FRA-060]` (Task 9's Authorizations marker) and `[FRA-050]` (Task 10's `[LIM-060]` caveat) match what Step 1 above actually assigned. They do, by construction of this task's own numbering — but re-open the two files' relevant lines and confirm the rendered cross-reference text reads correctly (not literally `[FRA-0XX]` placeholder text) before proceeding.

- [ ] **Step 3: Cross-check step**

For each `[FRA-0XX]` rule, confirm its claim against the specific `eip-8141.md` section cited: `[FRA-010]`/`[FRA-020]` against §Public Mempool-recognized Validation Prefixes and §Structural Rules (lines 910–966); `[FRA-030]` against §Atomic batching Rationale (lines 1168–1174); `[FRA-040]` against §Expiry Verifier Frame (lines 321–384, 967–973); `[FRA-050]` against §Constants under Mempool and §Structural Rules item 6; `[FRA-060]` against §Validation Trace Rules (lines 987–999); `[FRA-070]` against §Signature Validation (lines 259–317); `[FRA-080]` against §Execution Approval Authorizes All Subsequent Sender Frames (lines 1460–1466).

Expected: all eight resolve to real, correctly-characterized source text.

- [ ] **Step 4: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 12: Rationale and Security Considerations — combined-standard framing and residual risks

**Files:**
- Modify: `/Users/alexf/ERCs/ERCS/erc-7562.md` — `## Rationale` (original lines 343–416), `## Security Considerations` (original lines 418–421).

**Interfaces:**
- Consumes: every marker/addition from Tasks 1–11.
- Produces: a short new Rationale subsection explaining the combined-standard design choice, and Security Considerations extended with frame-tx-specific residual risks.

- [ ] **Step 1: Add a new Rationale subsection, placed after the existing "What is not considered a mass invalidation attack" subsection (original lines 408–416) and before `## Security Considerations`**

```markdown
### Rationale for a combined standard

This document governs both ERC-4337 UserOperations and EIP-8141 frame
transactions rather than splitting into two documents, because the two
transaction types share the same DoS-safety problem and, for the large
majority of rules, the same solution: bound what mutable state a
transaction's validation logic can depend on before it is admitted to a
mempool. Only the concrete mechanism for expressing "an entity" and "a
bundle" differs between the two — see [Terminology
Mapping](#terminology-mapping). Splitting the document would have
required either duplicating every rule that generalizes cleanly (the
large majority — see [Storage Rules](#storage-rules), [Opcode
Rules](#opcode-rules), and most of the reputation rule families) or
introducing a third, cross-referencing document, neither of which is
simpler than annotating the existing rules in place and adding a small
number of transaction-type-specific rules ([Frame Transaction
Rules](#frame-transaction-rules)) where no shared mechanism exists.
```

- [ ] **Step 2: Extend Security Considerations**

Current (original lines 418–421) is two sentences. Append:

```markdown
For EIP-8141 frame transactions specifically, this document's staking
provisions ([Staked Entity](#definitions), [SREP-010]) depend on a
Staking Registry contract external to the EIP-8141 protocol surface (see
[Appendix A](#appendix-a-staking-registry-contract)), since `ENTRY_POINT`
holds no ledger under EIP-8141 — its correctness is this document's own
responsibility, not something the Ethereum protocol layer guarantees.
Node operators should also note that neither ERC-7562's original P2P
rules nor this document's frame-transaction extensions have seen
adversarial production traffic at meaningful scale; most historical
ERC-4337 bundler traffic bypassed the public P2P mempool entirely via
private relay submission.
```

- [ ] **Step 3: Add Appendix A (Staking Registry contract), placed after Security Considerations and before Copyright**

```markdown
## Appendix A: Staking Registry Contract

For EIP-8141 frame transactions, since `ENTRY_POINT` (`address(0xaa)`)
holds no deposit or stake ledger (see [Terminology
Mapping](#terminology-mapping)), this document's staking provisions
depend on a separate contract implementing:

```solidity
interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime);
}
```

This is deliberately not a deposit ledger — EIP-8141 payment is a direct
balance debit via `APPROVE` (see Terminology Mapping, "deposit") — only a
staking registry, giving `MIN_STAKE_VALUE`/`MIN_UNSTAKE_DELAY` something
to check against a locked balance with an enforced withdrawal delay, a
property a plain account balance does not have. A deployment governed by
this document MUST specify which `IStakingRegistry` address it trusts;
unlike `ENTRY_POINT`, this is not a protocol constant.
```

- [ ] **Step 4: Cross-check step**

Read the fully-assembled document top to bottom once. Confirm every internal markdown link introduced across Tasks 1–12 (`#terminology-mapping`, `#frame-transaction-rules`, `#appendix-a-staking-registry-contract`, etc.) resolves to an actual heading.

Expected: zero broken internal links.

- [ ] **Step 5: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```

---

### Task 13: Self-review — full rule-ID inventory, marker consistency, backward-compatibility check

**Files:**
- Create/finalize: `/Users/alexf/skandha/docs/plans/native-aa-mempool-crosscheck.md`
- Read: `/Users/alexf/ERCs/ERCS/erc-7562.md`'s current, fully-edited working-tree state, diffed against `git HEAD` (see Step 4) — since no task in this plan commits (per Global Constraints), `HEAD` is still the last real commit from before this plan started, so a plain working-tree diff against it covers every task's changes in one pass without needing per-task commit boundaries.

**Interfaces:**
- Consumes: every task's output.
- Produces: proof of (a) zero silently-dropped rule IDs, (b) every "ERC-4337 only" marker traceable to a Terminology Mapping entry, (c) every `[FRA-0XX]` cross-reference resolved to its actual number, (d) backward compatibility — a 4337-only reading of the document is unchanged in substance from before this plan's edits.

- [ ] **Step 1: Rule-ID inventory diff**

```bash
cd /Users/alexf/ERCs
grep -oE '\[(OP|COD|STO|GREP|SREP|EREP|UREP|ALT|AREP|AUTH|LIM|FRA)-[0-9]+\]' ERCS/erc-7562.md | sort -u
```

Expected: every original ID still present (none deleted or renumbered — confirm against the family list established earlier in this planning process: `OP-011` through `OP-080`, `COD-010`, `STO-010` through `STO-041`, `GREP-010` through `GREP-050`, `SREP-010` through `SREP-050`, `EREP-010` through `EREP-070`, `UREP-010` through `UREP-030`, `ALT-010` through `ALT-040`, `AREP-010` through `AREP-030`, `AUTH-010` through `AUTH-040`, `LIM-010` through `LIM-070`), plus `FRA-010` through `FRA-080` newly present.

- [ ] **Step 2: "ERC-4337 UserOperation only" marker inventory**

```bash
grep -c "ERC-4337 UserOperation only" ERCS/erc-7562.md
```

Cross-check the count against this plan's own list of markers added: `[OP-011]`'s `ORIGIN`/`BLOBHASH` entries (2), `[OP-051]`–`[OP-055]` section-level (1), `[EREP-040]`/`[EREP-050]`/`[EREP-055]`/`[EREP-070]` (4), the Authorizations section-level marker (1), `[LIM-010]`/`[LIM-020]`/`[LIM-030]`/`[LIM-040]`/`[LIM-050]`/`[LIM-070]` (6) — 15 total, plus any added by Task 6/8 if their substitution check found a genuine gap.

Expected: count matches (adjust the expected number if Tasks 6/8 added any).

- [ ] **Step 3: `[FRA-0XX]` cross-reference resolution check**

```bash
grep -n "FRA-0[0-9][0-9]" ERCS/erc-7562.md
```

Confirm every occurrence of `[FRA-050]` and `[FRA-060]` outside the Frame Transaction Rules section itself (i.e., the forward-references added in Tasks 9 and 10) points at a rule that actually exists with that number in the section Task 11 wrote, and that the referenced rule's *content* matches what the referencing text claims (e.g., `[LIM-060]`'s pointer to `[FRA-050]` should land on the gas-sum rule, not accidentally on the deploy-frame rule).

Expected: both forward-references resolve correctly.

- [ ] **Step 4: Backward-compatibility check — diff against the pre-plan baseline**

```bash
git diff -- ERCS/erc-7562.md
```

Since no task in this plan commits (per Global Constraints), `HEAD` is still whatever was committed before this plan started, so this single working-tree diff covers every task's cumulative changes — there is no per-task commit history to walk. This command is read-only (a diff, not a commit); running it does not violate the no-commit constraint. Read the full diff. Confirm every change is either (a) a pure insertion (new section, new rule, new table row) or (b) an in-place addition of an italicized marker/clause to an existing rule's text, with the rule's own original operative sentence(s) byte-for-byte unchanged. Any diff hunk that *rewords* rather than *appends to* an existing ERC-4337-relevant sentence is a backward-compatibility violation and must be fixed before this step passes.

Expected: zero rewording hunks; every hunk is additive.

- [ ] **Step 5: Placeholder scan**

```bash
grep -inE "TBD|TODO|to be determined|placeholder|fill in|implement later" ERCS/erc-7562.md
```

Expected: zero matches (this document, unlike a from-scratch new ERC, has no legitimate front-matter `TBD` fields to exempt — its front matter already has real values).

- [ ] **Step 6: Record final coverage confirmation**

Append to `/Users/alexf/skandha/docs/plans/native-aa-mempool-crosscheck.md`:

```markdown
# Final Coverage Confirmation (combined-standard in-place edit)

Generated: [date of this step]
Rule-ID inventory (Step 1): all original IDs present, FRA-010..FRA-080 added
Marker count (Step 2): [N] markers, matches expected list
FRA cross-reference resolution (Step 3): both forward-references confirmed correct
Backward-compatibility diff (Step 4): clean, additive-only
Placeholder scan (Step 5): clean
```

- [ ] **Step 7: Stop — do not commit**

```
Leave the change staged or unstaged in the working tree. Do NOT run `git add`,
`git commit`, or `git push` at any point in this plan — the user reviews every
changed character before anything is committed. Move to the next task's Step 1
with the working tree left exactly as this step's edits produced it.
```
