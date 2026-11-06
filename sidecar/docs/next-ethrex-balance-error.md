# RESOLVED: the `BALANCE`/non-sender-`SLOAD` "ethrex bug" was a test-contract bug, not ethrex's

**Not an ethrex issue.** The investigation below originally concluded that
`ethrex_simulateFrameTransaction` killed the whole trace for a `BALANCE`/non-sender `SLOAD`
violation while surviving a plain banned opcode like `TIMESTAMP`. That conclusion was wrong - it
was never isolated against ethrex directly, only inferred from what the sidecar's RPC error surfaced.
Properly isolated (first against a clean in-repo `ethrex-levm` unit test, then by calling
`ethrex_simulateFrameTransaction` directly against the live node, bypassing the sidecar entirely),
the real cause was a bug in the hand-assembled test contract used for the original "dropped"
outcome demo: its `APPROVE` tail used scope `2` (`EXECUTION` only - copied verbatim from
`WALLET_INIT_CODE`'s Canonical-Paymaster-wallet-role pattern in `test/e2e/helpers.ts`), but the
frame itself declared `flags: EXECUTION_AND_PAYMENT` (`3`) for a Self-Relay shape, which needs
the *same* frame to approve both. With payment never approved, `payer` never got established, and
ethrex correctly, honestly reported the transaction as broken: `"Invalid frame transaction: no
frame approved payment (payer is unset)"`.

## How this was actually isolated

1. **Unit-tested the `BALANCE`/non-sender-`SLOAD` violation in isolation first**, reusing
   `eip8141-tracer`'s own proven test harness (`test/tests/rpc/simulate_frame_transaction_tests.rs`'s
   `simulate_reports_execution_even_when_canonical_mempool_policy_rejects`, which already proves
   this property for `TIMESTAMP`). Four incremental variants - two frames instead of one, real
   fees/balance instead of zero, the exact `CALLDATASIZE`/`JUMPI` dispatcher shape from the
   original demo contract, and a real `{"trace": true}` request instead of the default - **all
   passed**: `canonicalMempoolValid: false`, `canonicalMempoolViolation: "BannedOpcode(49)"`, but
   `erc7562Trace`/`frames`/`gasUsed` fully populated every time. This directly contradicted the
   original conclusion and should have been done before writing it up.
2. **Called `ethrex_simulateFrameTransaction` directly against the live node** (SSH'd into the
   miner, `curl localhost:8545` - the sidecar's own public RPC gateway doesn't proxy arbitrary
   `ethrex_*` methods, only whitelisted `eth_*` ones, which is why this wasn't tried first)
   reusing the exact already-deployed contract from the original repro
   (`0x1e4bc194dffe3fd8119332b93616278faebca8cd`). The real response:
   ```json
   {
     "canonicalMempoolValid": false,
     "canonicalMempoolViolation": "BannedOpcode(49)",
     "erc7562Trace": null,
     "executionError": "Invalid Transaction: Invalid frame transaction: no frame approved payment (payer is unset)",
     "executionStatus": null,
     "frames": null,
     "payer": null
   }
   ```
   The bare `"banned opcode: BALANCE (0x31)"` the sidecar previously reported was never the real
   failure - it was the earlier-recorded, genuinely non-fatal `canonicalMempoolViolation` that
   the sidecar's fail-closed fallback picked as the best available explanation once `erc7562Trace`
   came back `null` for the real reason above.
3. **Confirmed the fix**: redeployed the same contract with its `APPROVE` tail corrected to scope
   `3` (`PUSH1 0x03 PUSH1 0x00 PUSH1 0x00 APPROVE` instead of `PUSH1 0x02 ...`). Simulating it
   (unfunded, deliberately, as a second check) now returns a clean, fully-informative
   `insufficient_funds` halt - `haltReason`, `account`, `balance`, `required` all present, the
   exact shape `docs/ethrex-requests.md`'s original (already-resolved) request asked ethrex for -
   proving the trace pipeline was never broken for this violation class at all.

`BANNED_OPCODE_WALLET_INIT_CODE` in the sidecar's own `test/e2e/helpers.ts` already gets this right
(`...600360006000aa`, scope `3`) for exactly this reason - its own doc comment calls out the
Self-Relay shape needing `APPROVE_EXECUTION_AND_PAYMENT`. The original demo contract should have
been built from that reference instead of from `WALLET_INIT_CODE`.

## Lesson

Don't conclude a dependency is misbehaving from one layer's surfaced error string alone,
especially through a fail-closed fallback path that was *designed* to show the best-available
explanation rather than the real one. Isolate at the lowest layer that can show the literal
response before writing anything up as "ethrex does X" - here, two steps (an in-repo unit test, a
direct RPC call bypassing the bundler) took under an hour and completely overturned the original
conclusion.

## Status of the companion ethrex PR

[forshtat/ethrex#5](https://github.com/forshtat/ethrex/pull/5) (optional target-block param for
`ethrex_submitPrivilegedFrameTransaction`) stands on its own regardless of this resolution - it's
a genuinely useful test lever for demonstrating `dropped`-via-non-inclusion that has nothing to
do with the `BALANCE`/payer bug above. Not affected by this correction.
