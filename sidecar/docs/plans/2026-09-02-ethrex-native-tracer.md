# Ethrex Native ERC-7562/EIP-8141 Tracer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port go-ethereum's native `erc7562Tracer` (`eth/tracers/native/erc7562.go`, registered as `"erc7562Tracer"` in geth's `debug_traceCall`/`debug_traceTransaction`) into [ethrex](https://github.com/lambdaclass/ethrex) — the most functional current implementation of [EIP-8141](../../../../EIPs/EIPS/eip-8141.md) — as a new named tracer, extended for the frame-transaction execution model and the combined ERC-4337 + EIP-8141 standard (`erc-7562.md`, per the companion spec plan).

**Architecture:** This is a **data-collection instrument, not a rule enforcer** — exactly like geth's original. It hooks into LEVM's (ethrex's EVM) execution to record, per validation-prefix frame, the same diagnostics geth's tracer records per call depth: used-opcode counts, storage access (including transient), `EXTCODE*` access info, contract sizes at first access, and Keccak preimages (needed to detect the `keccak(A||x)+n` associated-storage pattern). All rule *enforcement* — banned-opcode checks, associated-storage carve-outs for staked entities, validation-prefix recognition — stays client-side in the sidecar (Plan B's `FrameTxValidationService`, Task 13), consuming this tracer's JSON output exactly as the sidecar's `safe.ts` consumes geth's `erc7562Tracer` output today. The one structural addition beyond a straight port: geth's tracer assumes a single top-level call per traced object (it traced one `eth_call` per ERC-4337 validation phase); this port must segment its output **by frame index** within one frame transaction, since a single `debug_traceCall` now covers the whole validation prefix (multiple `VERIFY`/`DEFAULT` frames) in one pass.

**Tech Stack:** Rust, ethrex's LEVM crate (`crates/vm/levm`), ethrex's RPC crate (`crates/networking/rpc`).

**Spec:**
- `/Users/alexf/ERCs/ERCS/erc-7562.md` (once `2026-09-02-erc7562-native-aa-mempool-spec.md` lands) — the rule vocabulary this tracer's *output* must be able to answer: every `[OP-0xx]`/`[STO-0xx]`/`[FRA-0xx]` rule needs a field in this tracer's JSON that a client can check it against.
- `eth/tracers/native/erc7562.go` in `ethereum/go-ethereum` (537 lines, fetched in full during this planning session) — the reference implementation being ported. Re-fetch it fresh at execution time (`gh api repos/ethereum/go-ethereum/contents/eth/tracers/native/erc7562.go`) in case it has changed.
- `docs/eip-8141.md`, `crates/vm/levm/src/tracing.rs` (347 lines), `crates/vm/levm/src/validation_observer.rs` (165 lines), `crates/networking/rpc/tracing.rs` in `lambdaclass/ethrex` (partially read during this planning session — Tasks below mark which parts are confirmed-read vs. need fresh reading at execution time).

## Global Constraints

- This tracer must have **zero runtime cost when inactive**, matching every other tracer/observer already in LEVM (`LevmCallTracer::disabled()`, `ValidationObserver::disabled()` — both gate every hook behind a single `if active` branch). Follow that exact pattern; do not introduce a design that costs more than one branch per hook when tracing is off.
- Do not modify `ValidationObserver`. It implements EIP-8141's own baseline local-mempool policy (no staking, no associated-storage carve-outs) and ethrex's maintainers may have opinions about changing its semantics. This plan adds a **new, separate** tracer.
- Every field this plan's collector adds beyond what `LevmCallTracer` already captures must trace back to a specific rule in `erc-7562.md` that needs it — no speculative data collection "in case it's useful later."
- This is a contribution to an external, actively-developed repository not owned by this project. Before writing any code, confirm (a) whether `lambdaclass/ethrex` accepts external contributions via PR and what its contribution process expects (`CONTRIBUTING.md`), and (b) whether the maintainers would rather this live as a downstream fork/patch than an upstream PR, given it encodes policy (our combined standard) beyond what EIP-8141 itself specifies. Do not assume upstream acceptance; this plan produces a working patch either way.
- Follow ethrex's existing Rust conventions exactly as observed in `tracing.rs`/`validation_observer.rs` (doc comments explaining *why*, not *what*; `#[derive(Debug, Clone)]` on state structs; explicit module-level `//!` docs explaining spec gaps the way `validation_observer.rs`'s `OQ4`/canonical-paymaster-exemption comments do).

---

## File Structure

| Path | Responsibility | Disposition |
|---|---|---|
| `crates/vm/levm/src/erc7562_tracer.rs` | The new collector struct (`Erc7562FrameTracer`), modeled on `LevmCallTracer` | **New** |
| `crates/vm/levm/src/tracing.rs` | Re-export the new tracer alongside `LevmCallTracer`/`LevmOpcodeTracer` | **Modify** |
| `crates/vm/levm/src/vm.rs` | Thread a `erc7562_tracer: Erc7562FrameTracer` field through `execute_frame_tx()`, with per-frame `current_frame_index` updates mirroring `ValidationObserver`'s pattern | **Modify** |
| `crates/networking/rpc/tracing.rs` | New `TracerType::Erc7562FrameTracer` variant + dispatch arm, alongside `CallTracer`/`PrestateTracer`/`OpcodeTracer` | **Modify** |
| `crates/vm/levm/src/opcodes.rs` | Confirm/add opcode byte constants this tracer needs to recognize (`SLOTNUM`; confirm `SETDELEGATE`'s absence per OQ4, see Task 7) | **Read, maybe modify** |
| `test/tests/levm/erc7562_tracer_tests.rs` | New test file, modeled on `test/tests/levm/opcode_tracer_tests.rs`'s existing pattern | **New** |

---

### Task 1: Confirm the contribution path and re-read the current source

**Files:**
- Read: `CONTRIBUTING.md`, `crates/vm/levm/src/tracing.rs`, `crates/vm/levm/src/validation_observer.rs`, `crates/networking/rpc/tracing.rs`, `crates/vm/levm/src/vm.rs` (the `execute_frame_tx()` function specifically), `crates/vm/levm/src/opcodes.rs`, `docs/eip-8141.md` — all from a **fresh clone**, not this plan's cached excerpts, since ethrex is under active development and the file contents this plan quotes may have already changed by execution time.

**Interfaces:**
- Consumes: nothing.
- Produces: a confirmed, current understanding of (a) how to submit this work (fork+PR vs. permanent downstream patch), (b) the exact current signatures of `LevmCallTracer::enter`/`exit`/`exit_context`/`exit_early`/`log`, `ValidationObserver`'s fields and how `simulate_frame_validation_prefix` threads it through the frame loop, and (c) whether `execute_frame_tx()`'s frame loop structure (as documented in `docs/eip-8141.md`'s Execution Flow section: "Set context → Resolve target → Set caller/static → Create CallFrame → Push substate backup → Execute → Handle result → Store result → VERIFY enforcement → Clear transient storage") still matches this plan's assumptions.

- [ ] **Step 1: Clone and read**

```bash
git clone https://github.com/lambdaclass/ethrex.git /tmp/ethrex-tracer-work
cd /tmp/ethrex-tracer-work
cat CONTRIBUTING.md
```

- [ ] **Step 2: Confirm `LevmCallTracer`'s current hook signatures against this plan's Spec-section excerpt**

```bash
sed -n '1,120p' crates/vm/levm/src/tracing.rs
```

Expected: `enter(&mut self, call_type: CallType, from: Address, to: Address, value: U256, gas: u64, input: &Bytes)`, `exit_context(&mut self, ctx_result: &ContextResult, is_top_call: bool)`, `exit_early(&mut self, gas_used: u64, error: Option<String>)`, `log(&mut self, log: &Log)` — matching what this plan read during its own research. If any signature has changed, note the diff and adjust every later task that calls these patterns as a template.

- [ ] **Step 3: Confirm `ValidationObserver`'s current field list and confirm `SETDELEGATE`'s absence (OQ4)**

```bash
cat crates/vm/levm/src/validation_observer.rs
grep -rn "SETDELEGATE" crates/vm/levm/src/opcodes.rs
```

Expected: the OQ4 module comment (module docs, lines 13–21 as read during this planning session) still states there is no `SETDELEGATE` opcode in `opcodes.rs`. If ethrex has since added it, Task 7 of this plan changes materially (SLOTNUM/SETDELEGATE both need real opcode-byte tracking, not a documented-absence note) — confirm before proceeding.

- [ ] **Step 4: Confirm `execute_frame_tx()`'s frame loop structure**

```bash
grep -n "fn execute_frame_tx" crates/vm/levm/src/vm.rs
```

Read the function in full. Confirm it still matches `docs/eip-8141.md`'s documented Execution Flow (§3 Frame loop, 10 numbered steps). Record the exact line range for use as Task 3's insertion point.

- [ ] **Step 5: Record findings**

Write a short findings note (not a formal deliverable, just a working reference for the rest of this plan) to `/tmp/ethrex-tracer-work/PLAN_NOTES.md`, listing any drift found between this plan's assumptions and the current source. Every later task that assumed a specific signature must be checked against this note before its own Step 1.

---

### Task 2: Define the collector struct and its output schema

**Files:**
- Create: `crates/vm/levm/src/erc7562_tracer.rs`
- Test: `test/tests/levm/erc7562_tracer_tests.rs` (created here, extended by later tasks)

**Interfaces:**
- Consumes: `Address`, `H256`, `U256` from `ethrex_common`; `vm::OpCode`/equivalent opcode-byte type from LEVM (confirm the exact type name — geth uses `vm.OpCode`, a `byte`-backed enum with a `.String()` method; ethrex's equivalent, per `validation_observer.rs`'s `BannedOpcode(u8)`, appears to use a raw `u8` rather than a typed enum — confirm which convention this new struct should follow by checking how `LevmOpcodeTracer` in `crates/vm/levm/src/opcode_tracer.rs` represents opcodes, since that's the closest existing precedent for a per-opcode-keyed collector).
- Produces: `Erc7562FrameTracer`, `FrameCallTraceFrame` (the per-call-frame record, analogous to geth's `callFrameWithOpcodes`), `AccessedSlots` (reads/writes/transient reads/writes), `ContractSizeWithOpcode`, and their `serde::Serialize` impls producing the same field names as geth's tracer (`accessedSlots`, `extCodeAccessInfo`, `usedOpcodes`, `contractSize`, `outOfGas`, `keccak`, `calls`) so the sidecar's parsing code needs minimal change from what it already expects for the geth case.

- [ ] **Step 1: Confirm the opcode-byte representation convention**

```bash
cat crates/vm/levm/src/opcode_tracer.rs | head -80
```

Expected: this reveals whether LEVM has a typed opcode enum with useful methods (mirroring geth's `vm.OpCode`) or works in raw `u8` throughout (mirroring `validation_observer.rs`'s `BannedOpcode(u8)`). Use whichever convention `opcode_tracer.rs` already uses — this struct should look native to the codebase, not import a geth-flavored abstraction that doesn't otherwise exist here.

- [ ] **Step 2: Write a failing unit test for the struct's `Default`/construction shape**

```rust
// test/tests/levm/erc7562_tracer_tests.rs
use ethrex_levm::erc7562_tracer::Erc7562FrameTracer;

#[test]
fn a_disabled_tracer_has_no_frames() {
    let tracer = Erc7562FrameTracer::disabled();
    assert!(!tracer.active);
    assert!(tracer.frames.is_empty());
}
```

- [ ] **Step 3: Run to confirm failure**

```bash
cargo test -p ethrex-levm erc7562_tracer_tests 2>&1 | tail -30
```

Expected: compile error, module not found.

- [ ] **Step 4: Implement the struct**, following `LevmCallTracer`'s exact shape (an `active: bool` flag, a `Vec`-backed frame stack, a `disabled()` constructor, a `new(...)` constructor), but keyed by **frame index** at the top level rather than assuming one root call:

```rust
// crates/vm/levm/src/erc7562_tracer.rs
//! Native ERC-7562/EIP-8141 validation-diagnostics tracer, exposed over
//! `debug_traceCall`/`debug_traceTransaction`. Ported from go-ethereum's
//! `eth/tracers/native/erc7562.go`, extended to segment output by frame
//! transaction frame index rather than assuming a single top-level call.
//!
//! This is a **collector, not an enforcer**: like geth's original, it
//! records opcode usage, storage access, EXTCODE access, contract sizes,
//! and Keccak preimages per call frame. Rule enforcement (which opcodes
//! are banned, which storage slots count as "associated" per the
//! `keccak(A||x)+n` pattern) is the caller's responsibility, matching
//! geth's own division of labor between this tracer and a bundler's
//! interpretation of its output.

use ethrex_common::{Address, H256, U256};
use std::collections::HashMap;

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct AccessedSlots {
    pub reads: HashMap<H256, Vec<H256>>,
    pub writes: HashMap<H256, u64>,
    #[serde(rename = "transientReads")]
    pub transient_reads: HashMap<H256, u64>,
    #[serde(rename = "transientWrites")]
    pub transient_writes: HashMap<H256, u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ContractSizeWithOpcode {
    #[serde(rename = "contractSize")]
    pub contract_size: usize,
    pub opcode: u8, // confirm against Task 2 Step 1's finding: may need to be the enum type instead
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct FrameCallTraceFrame {
    pub from: Address,
    pub to: Option<Address>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub calls: Vec<FrameCallTraceFrame>,
    #[serde(rename = "accessedSlots")]
    pub accessed_slots: AccessedSlots,
    #[serde(rename = "extCodeAccessInfo")]
    pub ext_code_access_info: Vec<Address>,
    #[serde(rename = "usedOpcodes")]
    pub used_opcodes: HashMap<u8, u64>,
    #[serde(rename = "contractSize")]
    pub contract_size: HashMap<Address, ContractSizeWithOpcode>,
    #[serde(rename = "outOfGas")]
    pub out_of_gas: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct FrameEntry {
    /// Index into `FrameTransaction.frames`.
    pub frame_index: usize,
    pub root: FrameCallTraceFrame,
}

#[derive(Debug, Default, Clone)]
pub struct Erc7562FrameTracer {
    pub active: bool,
    pub frames: Vec<FrameEntry>,
    /// Call-frame stack for the frame currently executing, mirroring
    /// `LevmCallTracer::callframes`.
    call_stack: Vec<FrameCallTraceFrame>,
    keccak_preimages: std::collections::HashSet<Vec<u8>>,
    last_opcode: Option<u8>,
}

impl Erc7562FrameTracer {
    pub fn disabled() -> Self {
        Self { active: false, ..Default::default() }
    }

    pub fn new() -> Self {
        Self { active: true, ..Default::default() }
    }
}
```

- [ ] **Step 5: Run to confirm pass**

```bash
cargo test -p ethrex-levm erc7562_tracer_tests 2>&1 | tail -30
```

- [ ] **Step 6: Commit**

```bash
git add crates/vm/levm/src/erc7562_tracer.rs test/tests/levm/erc7562_tracer_tests.rs
git commit -m "feat(levm): scaffold Erc7562FrameTracer collector struct"
```

---

### Task 3: Wire per-frame `enter`/`exit`/`log` hooks

**Files:**
- Modify: `crates/vm/levm/src/erc7562_tracer.rs` (add the hook methods)
- Modify: `crates/vm/levm/src/vm.rs` (call the hooks from `execute_frame_tx()`'s frame loop — the exact insertion points Task 1 Step 4 located)
- Test: `test/tests/levm/erc7562_tracer_tests.rs`

**Interfaces:**
- Consumes: `FrameCallTraceFrame`/`Erc7562FrameTracer` from Task 2.
- Produces: `Erc7562FrameTracer::begin_frame(&mut self, frame_index: usize)`, `enter(...)` / `exit(...)` (mirroring `LevmCallTracer`'s signatures confirmed in Task 1), `log(&mut self, log: &Log)`, wired into the VM's frame loop so each of the frame transaction's frames produces its own `FrameEntry` in `self.frames`.

- [ ] **Step 1: Write a failing test asserting two sequential frames produce two separate `FrameEntry` records**

```rust
#[test]
fn two_frames_produce_two_frame_entries() {
    let mut tracer = Erc7562FrameTracer::new();
    tracer.begin_frame(0);
    tracer.enter(Address::zero(), Address::from_low_u64_be(1), &[], 1000);
    tracer.exit(500, vec![], None);
    tracer.begin_frame(1);
    tracer.enter(Address::zero(), Address::from_low_u64_be(2), &[], 2000);
    tracer.exit(1500, vec![], None);
    assert_eq!(tracer.frames.len(), 2);
    assert_eq!(tracer.frames[0].frame_index, 0);
    assert_eq!(tracer.frames[1].frame_index, 1);
}
```

(Exact method signatures for `enter`/`exit` above are illustrative — finalize them to match whatever `LevmCallTracer`'s confirmed-current signatures from Task 1 actually are, adapted minimally for this struct's needs, rather than inventing a divergent convention.)

- [ ] **Step 2: Confirm failure**

```bash
cargo test -p ethrex-levm two_frames_produce_two_frame_entries 2>&1 | tail -20
```

- [ ] **Step 3: Implement `begin_frame`/`enter`/`exit`/`log`**, following `LevmCallTracer::enter`/`exit`/`log`'s exact control flow (push on enter, pop-and-nest-into-parent on exit, push completed root into `self.frames` when the call stack empties after `begin_frame` starts a new frame).

- [ ] **Step 4: Wire into `execute_frame_tx()`'s frame loop**

At the exact insertion points Task 1 Step 4 located (per `docs/eip-8141.md`'s documented 10-step frame loop: "1. Set context... 4. Create CallFrame... 6. Execute... 10. Clear transient storage"), add:
- Before step 4 (Create CallFrame): `vm.erc7562_tracer.begin_frame(current_frame_index)` if `vm.erc7562_tracer.active`.
- At the same point `vm.tracer.enter(...)`/`exit_context(...)` are already called for `LevmCallTracer` (confirm these exact call sites by reading the function, not guessing): add matching `vm.erc7562_tracer.enter(...)`/`exit(...)` calls, gated by `if vm.erc7562_tracer.active`.

This task's riskiest step is finding the *exact* existing `vm.tracer.*` call sites to mirror — do not guess their line numbers from this plan; grep for them fresh:

```bash
grep -n "self.tracer\.\|vm.tracer\." crates/vm/levm/src/vm.rs | grep -i "enter\|exit\|log"
```

- [ ] **Step 5: Run to confirm the unit test passes, then run the existing `execute_frame_tx` test suite to confirm no regression**

```bash
cargo test -p ethrex-levm erc7562_tracer_tests 2>&1 | tail -30
cargo test -p ethrex-levm eip8141 2>&1 | tail -50
```

Expected: new test passes; existing `eip8141_tests.rs` suite (the file this plan's research found at `test/tests/levm/eip8141_tests.rs`) is unaffected, since the new tracer is inactive (`disabled()`) in every code path except when explicitly requested.

- [ ] **Step 6: Commit**

```bash
git add crates/vm/levm/src/erc7562_tracer.rs crates/vm/levm/src/vm.rs test/tests/levm/erc7562_tracer_tests.rs
git commit -m "feat(levm): wire Erc7562FrameTracer into the frame transaction execution loop"
```

---

### Task 4: Opcode usage counting

**Files:**
- Modify: `crates/vm/levm/src/erc7562_tracer.rs`
- Test: `test/tests/levm/erc7562_tracer_tests.rs`

**Interfaces:**
- Consumes: the VM dispatch loop's per-opcode hook (confirm its exact name/signature — `LevmOpcodeTracer`, referenced in `tracing.rs`'s re-export, is the closest existing per-opcode hook; read `crates/vm/levm/src/opcode_tracer.rs` in full, not just its first 80 lines from Task 2, to find the exact per-opcode call site this task attaches to).
- Produces: `Erc7562FrameTracer::on_opcode(&mut self, opcode: u8)`, populating `used_opcodes` on the current call frame, mirroring geth's `storeUsedOpcode` — including the same "ignore PUSHx/DUPx/SWAPx and simple arithmetic/comparison opcodes" default filter geth applies (`defaultIgnoredOpcodes()`), reproduced with ethrex's own opcode byte values (confirm these match geth's — EVM opcode bytes are standardized, so they should, but confirm PUSH0's byte value specifically, since it was a relatively late addition (EIP-3855) and byte-value drift is the kind of thing worth a two-second check rather than an assumption).

- [ ] **Step 1: Write a failing test**

```rust
#[test]
fn on_opcode_counts_non_ignored_opcodes() {
    let mut tracer = Erc7562FrameTracer::new();
    tracer.begin_frame(0);
    tracer.enter(Address::zero(), Address::from_low_u64_be(1), &[], 1000);
    tracer.on_opcode(0x54); // SLOAD
    tracer.on_opcode(0x54); // SLOAD again
    tracer.on_opcode(0x01); // ADD -- should be ignored, per default filter
    tracer.exit(500, vec![], None);
    let used = &tracer.frames[0].root.used_opcodes;
    assert_eq!(used.get(&0x54), Some(&2));
    assert_eq!(used.get(&0x01), None);
}
```

- [ ] **Step 2: Confirm failure**

```bash
cargo test -p ethrex-levm on_opcode_counts_non_ignored_opcodes 2>&1 | tail -20
```

- [ ] **Step 3: Implement `on_opcode`**, reproducing geth's `storeUsedOpcode`/`defaultIgnoredOpcodes` logic with ethrex's own opcode constants (read `crates/vm/levm/src/opcodes.rs` for the authoritative byte values rather than copying geth's numeric literals blind).

- [ ] **Step 4: Wire `on_opcode` into the VM's per-opcode dispatch hook** (the exact hook found in Step 1's `opcode_tracer.rs` read), gated by `if vm.erc7562_tracer.active`.

- [ ] **Step 5: Run to confirm pass**

```bash
cargo test -p ethrex-levm erc7562_tracer_tests 2>&1 | tail -30
```

- [ ] **Step 6: Commit**

```bash
git add crates/vm/levm/src/erc7562_tracer.rs test/tests/levm/erc7562_tracer_tests.rs
git commit -m "feat(levm): add opcode usage counting to Erc7562FrameTracer"
```

---

### Task 5: Storage access tracking (SLOAD/SSTORE/TLOAD/TSTORE)

**Files:**
- Modify: `crates/vm/levm/src/erc7562_tracer.rs`
- Test: `test/tests/levm/erc7562_tracer_tests.rs`

**Interfaces:**
- Consumes: `on_opcode`'s hook point (Task 4) plus stack-top access (confirm how LEVM's dispatch loop exposes the current instruction's stack operands to a hook — geth's `scope.StackData()`/`peepStack` has some LEVM equivalent; find it during this task's Step 1, don't assume its name).
- Produces: `Erc7562FrameTracer::on_storage_access(&mut self, opcode: u8, slot: H256, addr: Address, original_value_fn: impl FnOnce() -> H256)`, populating `accessed_slots` on the current call frame — mirroring geth's `handleStorageAccess`: for `SLOAD`, record the pre-existing value only on the *first* read of a slot not yet read or written (this is what lets a later associated-storage check compare "the value when this validation started" against a computed `keccak(A||x)+n` pattern); for `SSTORE`, increment a write counter; `TLOAD`/`TSTORE` increment their own transient counters.

- [ ] **Step 1: Find LEVM's stack-inspection hook point**

```bash
grep -n "stack\|Stack" crates/vm/levm/src/opcode_tracer.rs | head -30
```

Confirm how a hook reads the top-of-stack operand(s) at the point an opcode is about to execute — this is what supplies the storage slot / EXTCODE target address this task and Task 6 both need.

- [ ] **Step 2: Write a failing test for the "first SLOAD records original value, second doesn't overwrite it" rule**

```rust
#[test]
fn first_sload_records_original_value_second_does_not_overwrite() {
    let mut tracer = Erc7562FrameTracer::new();
    tracer.begin_frame(0);
    tracer.enter(Address::zero(), Address::from_low_u64_be(1), &[], 1000);
    let slot = H256::from_low_u64_be(7);
    tracer.on_storage_access(0x54 /* SLOAD */, slot, Address::from_low_u64_be(1), || H256::from_low_u64_be(100));
    tracer.on_storage_access(0x54 /* SLOAD */, slot, Address::from_low_u64_be(1), || H256::from_low_u64_be(999) /* should be ignored */);
    tracer.exit(500, vec![], None);
    let reads = &tracer.frames[0].root.accessed_slots.reads;
    assert_eq!(reads.get(&slot), Some(&vec![H256::from_low_u64_be(100)]));
}
```

- [ ] **Step 3: Confirm failure**

```bash
cargo test -p ethrex-levm first_sload_records_original_value 2>&1 | tail -20
```

- [ ] **Step 4: Implement `on_storage_access`**, mirroring geth's `handleStorageAccess` logic exactly (the "only record on first touch, whether read or write" rule — geth checks both `reads`/`writes` maps before recording, not just `reads`, so a slot written-then-read doesn't get a stale "original value" recorded from after the write).

- [ ] **Step 5: Wire into the VM's `SLOAD`/`SSTORE`/`TLOAD`/`TSTORE` dispatch points**, gated by `if vm.erc7562_tracer.active`. For the "original value" callback, use whatever LEVM's state-read primitive is (confirm against `ValidationObserver`'s usage pattern, since it also needs to distinguish "value before this transaction" for its own `touched_sender_slots` tracking — the two features likely read from the same underlying state accessor).

- [ ] **Step 6: Run to confirm pass**

```bash
cargo test -p ethrex-levm erc7562_tracer_tests 2>&1 | tail -30
```

- [ ] **Step 7: Commit**

```bash
git add crates/vm/levm/src/erc7562_tracer.rs test/tests/levm/erc7562_tracer_tests.rs
git commit -m "feat(levm): add storage access tracking to Erc7562FrameTracer"
```

---

### Task 6: EXTCODE access info, contract size, and Keccak preimage tracking

**Files:**
- Modify: `crates/vm/levm/src/erc7562_tracer.rs`
- Test: `test/tests/levm/erc7562_tracer_tests.rs`

**Interfaces:**
- Consumes: the stack-inspection hook from Task 5 Step 1.
- Produces: `on_ext_opcode` (mirrors geth's `handleExtOpcodes` — records an address into `ext_code_access_info` unless it's an `EXTCODESIZE` immediately followed by `ISZERO`, the standard "check code exists" idiom that ERC-7562's `[OP-051]` explicitly exempts), `on_contract_size_access` (mirrors `handleAccessedContractSize` — records code size at first `EXT*`/`*CALL` access to an address), `on_keccak` (mirrors `storeKeccak` — records the preimage of every `KECCAK256` call, needed downstream by the sidecar to detect the `keccak(A||x)+n` associated-storage pattern per `erc-7562.md`'s Definitions section).

- [ ] **Step 1: Write failing tests for all three**

```rust
#[test]
fn extcodesize_immediately_followed_by_iszero_is_not_recorded() {
    let mut tracer = Erc7562FrameTracer::new();
    tracer.begin_frame(0);
    tracer.enter(Address::zero(), Address::from_low_u64_be(1), &[], 1000);
    let target = Address::from_low_u64_be(42);
    tracer.on_opcode(0x3b /* EXTCODESIZE */); // sets last_opcode
    tracer.on_ext_opcode(0x3b, target);
    tracer.on_opcode(0x15 /* ISZERO */);
    // no on_ext_opcode call for ISZERO itself -- only EXT*/CALL opcodes call it
    tracer.exit(500, vec![], None);
    assert!(tracer.frames[0].root.ext_code_access_info.is_empty());
}

#[test]
fn extcodehash_is_recorded() {
    let mut tracer = Erc7562FrameTracer::new();
    tracer.begin_frame(0);
    tracer.enter(Address::zero(), Address::from_low_u64_be(1), &[], 1000);
    let target = Address::from_low_u64_be(42);
    tracer.on_ext_opcode(0x3f /* EXTCODEHASH */, target);
    tracer.exit(500, vec![], None);
    assert_eq!(tracer.frames[0].root.ext_code_access_info, vec![target]);
}

#[test]
fn keccak_preimage_is_recorded() {
    let mut tracer = Erc7562FrameTracer::new();
    tracer.begin_frame(0);
    tracer.enter(Address::zero(), Address::from_low_u64_be(1), &[], 1000);
    tracer.on_keccak(b"hello".to_vec());
    tracer.exit(500, vec![], None);
    assert!(tracer.frames[0].root_keccak_preimages().contains(&b"hello".to_vec()));
}
```

(The last test's `root_keccak_preimages()` accessor name is illustrative — geth stores preimages on the *transaction-scoped* tracer, not per call frame, matching `t.keccakPreimages` living on `erc7562Tracer` itself, not `callFrameWithOpcodes`. Follow that same transaction-scope placement here, but transaction-scope now means **frame-transaction-scope**, not per-individual-frame — confirm during Step 3 whether Keccak preimages should be shared across all frames of one frame transaction (matching geth's single-scope behavior) or reset per validation-prefix frame; the former is more consistent with geth's design intent, since `keccak(A||x)+n` pattern-matching needs to work regardless of which frame computed the hash.)

- [ ] **Step 2: Confirm failures**

```bash
cargo test -p ethrex-levm extcodesize_immediately_followed_by_iszero 2>&1 | tail -20
cargo test -p ethrex-levm extcodehash_is_recorded 2>&1 | tail -20
cargo test -p ethrex-levm keccak_preimage_is_recorded 2>&1 | tail -20
```

- [ ] **Step 3: Implement all three methods**, resolving the Keccak-preimage scoping question raised above before writing the implementation, not after.

- [ ] **Step 4: Wire into the VM's `EXTCODESIZE`/`EXTCODEHASH`/`EXTCODECOPY`/`CALL*`/`KECCAK256` dispatch points**, gated by `if vm.erc7562_tracer.active`.

- [ ] **Step 5: Run to confirm all three pass**

```bash
cargo test -p ethrex-levm erc7562_tracer_tests 2>&1 | tail -40
```

- [ ] **Step 6: Commit**

```bash
git add crates/vm/levm/src/erc7562_tracer.rs test/tests/levm/erc7562_tracer_tests.rs
git commit -m "feat(levm): add EXTCODE access, contract size, and Keccak preimage tracking to Erc7562FrameTracer"
```

---

### Task 7: Combined-standard opcode additions — `SLOTNUM`, and the `SETDELEGATE` gap

**Files:**
- Modify: `crates/vm/levm/src/erc7562_tracer.rs` (only if a real change is needed — see Step 1)
- Read: `crates/vm/levm/src/opcodes.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: confirmation (or a fix) that `SLOTNUM` (`0x4B`, [EIP-7843](../../../../EIPs/EIPS/eip-7843.md)) is tracked by this tracer like any other opcode (Task 4's generic `on_opcode` counting already covers it — no special-casing needed, since this tracer doesn't itself enforce bans, it only counts), and an explicit, documented statement of the `SETDELEGATE` gap for this plan's consumers (Plan B, the testing plan) to react to.

- [ ] **Step 1: Confirm `SLOTNUM` needs no special handling**

`erc-7562.md`'s `[OP-011]` (per the companion spec plan) adds `SLOTNUM` to the banned-opcode list. Since this tracer is a pure counter (Task 4), `SLOTNUM` is automatically counted like any other non-ignored opcode the moment `crates/vm/levm/src/opcodes.rs` defines its byte value and the VM dispatches it — no tracer-specific code is needed. Confirm ethrex's opcode set includes `SLOTNUM` (EIP-7843) at all:

```bash
grep -n "SLOTNUM\|0x4[Bb]" crates/vm/levm/src/opcodes.rs
```

Expected: either it's already defined (in which case this task is a no-op confirmation) or it isn't yet implemented (in which case `erc-7562.md`'s `[OP-011]` `SLOTNUM` entry is currently as unexercisable against ethrex as `SETDELEGATE` — record this finding for the testing plan).

- [ ] **Step 2: Document the `SETDELEGATE` gap explicitly for downstream consumers**

Per `validation_observer.rs`'s own module docs (OQ4, already read in full during this planning session): ethrex's opcode set has no `SETDELEGATE` opcode at all, so `erc-7562.md`'s `[FRA-060]` (which permits `CREATE`/`CREATE2`/`SETDELEGATE` inside the first `deploy` frame) has no `SETDELEGATE` byte to count or trace here. This is not a bug in this tracer — there is nothing to add until ethrex implements the opcode. Write a doc comment on `Erc7562FrameTracer` noting this explicitly, cross-referencing `validation_observer.rs`'s own OQ4 comment so a future reader sees both notes together:

```rust
/// **Known gap (mirrors `ValidationObserver`'s OQ4):** ethrex's opcode set
/// (`opcodes.rs`) does not yet define `SETDELEGATE`. This tracer counts
/// whatever opcodes the VM dispatches; it cannot count an opcode ethrex
/// hasn't implemented. `erc-7562.md`'s [FRA-060] deploy-frame delegation
/// rule is therefore only partially exercisable against ethrex today
/// (CREATE/CREATE2/sender-SSTORE paths work; SETDELEGATE does not exist
/// to test). Revisit once ethrex implements EIP-7819.
```

- [ ] **Step 3: Commit (documentation-only, unless Step 1 found `SLOTNUM` missing, in which case flag that as a separate, out-of-scope-for-this-tracer finding rather than implementing the opcode here)**

```bash
git add crates/vm/levm/src/erc7562_tracer.rs
git commit -m "docs(levm): document SLOTNUM/SETDELEGATE opcode-availability gaps in Erc7562FrameTracer"
```

---

### Task 8: RPC exposure via `debug_traceCall`/`debug_traceTransaction`

**Files:**
- Modify: `crates/networking/rpc/tracing.rs`
- Test: `test/tests/rpc/erc7562_tracer_rpc_tests.rs` (new, modeled on `test/tests/rpc/trace_call_tests.rs`'s existing pattern for `debug_traceCall` parameter-parsing tests)

**Interfaces:**
- Consumes: `Erc7562FrameTracer` from Tasks 2–7.
- Produces: a new `TracerType::Erc7562FrameTracer` variant (wire name TBD — Step 1 below decides it), dispatched in `debug_traceCall`/`debug_traceTransaction`'s existing `match` arms alongside `CallTracer`/`PrestateTracer`/`OpcodeTracer`, returning `Erc7562FrameTracer`'s `frames` field as the JSON result.

- [ ] **Step 1: Decide the wire name**

`erc7562Tracer` (matching geth exactly) is the obvious default, but geth's name predates the combined ERC-7562+EIP-8141 standard and this tracer's frame-segmented output shape differs from geth's single-call-tree shape — a bundler client naively pointing at `"erc7562Tracer"` against both geth and ethrex would get incompatibly-shaped JSON back. Prefer a distinct name — `"erc7562FrameTracer"` — that a client must deliberately opt into, making the shape difference visible in the request itself rather than a silent trap. Record this decision; every later plan (the testing plan, and Plan B's `GethTracer.ts`/`FrameTxSimulationService`) must use the same literal string.

- [ ] **Step 2: Write a failing RPC-level test**

```rust
// test/tests/rpc/erc7562_tracer_rpc_tests.rs
#[tokio::test]
async fn debug_trace_call_accepts_erc7562_frame_tracer() {
    // Construct a minimal frame transaction call (mirroring however
    // trace_call_tests.rs already builds its debug_traceCall fixtures --
    // read that file's existing helper functions before writing new ones
    // here, do not duplicate fixture-construction logic).
    // Assert the response parses as a JSON array of {frameIndex, root: {...}}.
}
```

- [ ] **Step 3: Confirm failure**

```bash
cargo test -p ethrex-rpc erc7562_tracer_rpc_tests 2>&1 | tail -30
```

- [ ] **Step 4: Add the `TracerType` variant and dispatch arm**, following `CallTracer`'s/`PrestateTracer`'s existing pattern in `tracing.rs` exactly (config struct if needed, `impl RpcHandler` wiring, response serialization).

- [ ] **Step 5: Run to confirm pass**

```bash
cargo test -p ethrex-rpc erc7562_tracer_rpc_tests 2>&1 | tail -30
```

- [ ] **Step 6: Commit**

```bash
git add crates/networking/rpc/tracing.rs test/tests/rpc/erc7562_tracer_rpc_tests.rs
git commit -m "feat(rpc): expose Erc7562FrameTracer via debug_traceCall as erc7562FrameTracer"
```

---

### Task 9: End-to-end verification against a real frame transaction

**Files:**
- Test: `test/tests/levm/eip8141_tests.rs` (extend the existing file, per this plan's earlier finding that it already contains frame-transaction test infrastructure — read its existing helpers before writing new fixture-construction code)

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: one integration test proving the tracer produces correct, complete output for a realistic multi-frame transaction (a `deploy` + `self_verify` + `user_op` sequence), checked field-by-field against hand-computed expected values.

- [ ] **Step 1: Write a failing test constructing a real multi-frame transaction and tracing it**

Reuse whatever fixture-construction helpers `eip8141_tests.rs` already has (confirmed to exist per this plan's research — the file contains at least `a_floor_bound_frame_transaction_is_charged_the_floor`, implying a working `FrameTransaction` builder already exists in this test module or a shared test-utils crate). Build a transaction with: a `deploy` frame calling `CREATE2`, a `self_verify` frame reading one storage slot, a `SENDER`-mode frame calling an external contract. Trace it with `Erc7562FrameTracer` and assert: three `FrameEntry` records at the correct indices; the deploy frame's `used_opcodes` contains `CREATE2`; the `self_verify` frame's `accessed_slots.reads` contains the expected slot with its pre-read value; the `SENDER` frame's root call's `to` matches the external contract address.

- [ ] **Step 2: Confirm failure**

```bash
cargo test -p ethrex-levm erc7562_frame_tracer_end_to_end 2>&1 | tail -40
```

- [ ] **Step 3: Debug and fix until it passes** — this is the integration point where Tasks 2–8's individual pieces either cohere or reveal a gap; treat any failure here as new information about what earlier tasks got wrong, not something to work around locally.

- [ ] **Step 4: Run the full existing `eip8141` test suite once more to confirm zero regressions from this plan's changes to `vm.rs`**

```bash
cargo test -p ethrex-levm eip8141 2>&1 | tail -60
cargo test 2>&1 | tail -20
```

Expected: full workspace test suite passes; this plan's changes are additive (new field, new gated hooks) and should not alter any existing test's behavior.

- [ ] **Step 5: Commit**

```bash
git add test/tests/levm/eip8141_tests.rs
git commit -m "test(levm): end-to-end Erc7562FrameTracer verification against a multi-frame transaction"
```
