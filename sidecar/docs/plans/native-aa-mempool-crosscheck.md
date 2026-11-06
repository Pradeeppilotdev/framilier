# ERC-7562 Combined Standard — Self-Review Crosscheck

Scratch working file for `2026-09-02-erc7562-native-aa-mempool-spec.md`'s execution. Not part of the final deliverable.

## Task 6 finding

Storage Rules / Local Rules: substitution-check ran against all eight rules (`[STO-010]`, `[STO-021]`, `[STO-022]`, `[STO-031]`, `[STO-032]`, `[STO-033]`, `[STO-040]`, `[STO-041]`).

Seven resolve cleanly by pure substitution via the Terminology Mapping table (entity names only).

One genuine gap found: `[STO-022]` reads "There is an `initCode` and the `factory` contract is staked" — `initCode` is an ERC-4337 struct field name, not an entity name, so it isn't covered by the Terminology Mapping table's entity-only vocabulary. Fixed with a minimal inline parenthetical on the rule itself: *(For an EIP-8141 frame transaction, read `initCode` as "a `deploy` frame is present" — EIP-8141 has no `initCode` field; see Terminology Mapping, "factory.")*

Note for later: the same "ERC-4337 field name not covered by the Terminology Mapping table" pattern likely recurs at `[OP-031]`/`[OP-042]`'s "deployment frame" wording, but those are in Task 5's scope (already executed) and were not revisited here since Task 6 is scoped to Storage/Local Rules only. Flagging in case a future pass wants to sweep the whole document for this pattern rather than fixing it rule-by-rule as found.

## Task 8 finding

Alt-mempools Rules / Alt-mempool Reputation: confirmed transaction-type-agnostic, no markers needed. The alt-mempool mechanism (topic subscription, propagate-once, per-alt-mempool `opsSeen`/`opsIncluded` counters) governs *which rule set* a P2P peer applies, not the content of any rule — it carries no ERC-4337-specific assumption to mark. No edit made to this section.

# Final Coverage Confirmation (combined-standard in-place edit)

Generated: 2026-09-03
Rule-ID inventory (Task 13 Step 1): all original rule IDs present and unchanged in number — `OP-011..080`, `COD-010`, `STO-010..041`, `GREP-010..050`, `SREP-010..050`, `EREP-010..070`, `UREP-010..030`, `ALT-010..040`, `AREP-010..030`, `AUTH-010..040`, `LIM-010..070` — plus `FRA-010` through `FRA-080` newly added (8 new rules). Zero dropped, zero renumbered.
Marker count (Task 13 Step 2): 20 occurrences of "ERC-4337 UserOperation only" — plan estimated 15 (rule-level markers only); the extra 5 are the Terminology Mapping table's own explanatory prose (intro sentence + 4 table rows: aggregator, EntryPoint, context, bundle), which the original estimate didn't account for. Not a defect — verified by listing all 20 occurrences line-by-line.
FRA cross-reference resolution (Task 13 Step 3): both forward-references confirmed correct — `[LIM-060]`'s pointer lands on `[FRA-050]` (the gas-sum rule, line 426) and both the `[OP-011]` SETDELEGATE note and the Authorizations section marker point to `[FRA-060]` (the deploy-frame rule, line 434).
Backward-compatibility diff (Task 13 Step 4): clean, additive-only. Inspected all 19 diff hunks directly (`git diff -- ERCS/erc-7562.md`, not committed) — every "removed" line is matched by an "added" line containing the identical original text plus an appended marker/clause. Zero rewording of any existing ERC-4337-relevant sentence.
Placeholder scan (Task 13 Step 5): clean, zero matches for TBD/TODO/placeholder/etc.
Internal link check (carried over from Task 12 Step 4): all 16 unique internal markdown links resolve to real headers, zero broken links.

Working tree state: `ERCS/erc-7562.md` has uncommitted changes (199 insertions, 19 deletions per `git diff --stat`). Per the plan's Global Constraints, **nothing has been committed or pushed** — the user reviews every changed character before committing.
