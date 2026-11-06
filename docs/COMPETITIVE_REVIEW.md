# StakeLane competitive and technical review

> Historical assessment before the hardening changes. The scheduler/CLI recommendations below describe that review snapshot. See [current validation](HARDENING_VALIDATION.md) and [operator guide](OPERATOR.md) for implemented fixes and newly measured results.

Reviewed 6 November 2026 (India time). Remote source: `7d052e778fba6a86fb4f70c0d7940b2e62605285`; local working checkout remained at `ddfcfd5`. Remote changes were fetched for inspection, not checked out. This is a source and saved-evidence review, not a completed runtime security audit or a prediction of prizes.

## Decision

Keep StakeLane focused on fair, bounded admission work. The useful distinction is protecting one wallet's admission latency when another submits expensive validation, with an explicit cost to the busy wallet. Raising a gas cap alone is weak differentiation: other supplied projects already implement per-entity budgets, and the supplied organizer conversation reports removal of the hosted cap.

The official EF track explicitly includes developer tools and DoS vectors/new rules. Its criteria are creativity, usefulness, practicality, how well it works and relation to the alternative mempool. Source: https://ethglobal.com/events/mumbai/prizes (EF Frame Transaction Alternative Mempool section).

No defensible method can turn these materials into a 100% win guarantee or a probability of winning. Competitor descriptions are not independent security audits or proof of deployment.

## What exists now

- Per-entity budget attribution and signature charging, with stake eligibility checks.
- Private-chain heavy-work fixtures, public submission records and transparent limitations.
- Native `off`, `fifo` and `fair` scheduling, merged in PR 1.
- Root `./stakelane compare`, native scheduler config/readback and evidence checks, merged in PR 2.
- Fair mode defaults: four global admission slots, two heavy admissions per sender, 64 waiting jobs, heavy threshold strictly above 100,000 declared validation gas.

The current checkout predates these two PRs. Earlier statements that the CLI and scheduler do not exist are superseded by the fetched remote source.

## Evidence that was independently checked

Using Python, recomputed all eight saved baseline median/p95 pairs from the 160 individual measured trials in the two compare runs. Checked background candidate counts and recorded 993,512-gas heavy receipt observations against the summaries. Every checked row matched. This validates saved-data arithmetic, not the authenticity of the original execution or the continued availability of public receipts.

| Heavy burst | Run 1 B p50 / p95 ms | Fixed-head run 2 B p50 / p95 ms |
|---:|---:|---:|
| 0 | 14.156 / 18.372 | 17.264 / 26.074 |
| 1 | 128.152 / 137.372 | 134.536 / 144.255 |
| 4 | 136.454 / 243.580 | 231.105 / 245.783 |
| 8 | 286.303 / 365.548 | 308.539 / 381.019 |

Run 1 is explicitly `incomplete`, with FIFO/fair unavailable; run 2 is explicitly `baseline-only`. Neither proves a scheduler improvement. The latest adapter can now use the native scheduler, but it still needs a completed run.

The earlier 12.8 ms idle / 129.2 ms busy result belongs to the separate concurrency profile. The approximately 11 ms idle / 129 ms busy result belongs to the matched-witness benchmark. Keep these experiments separate in the pitch. Hash-chain verification is a synthetic CPU workload, not a measured privacy withdrawal or PQ signature.

Public heavy submission was admitted and later cancelled after relay attempts. Private receipts establish private inclusion. Do not describe the public heavy workload as mined or imply that admission scheduling controls block order.

## Comparison of the supplied projects

Descriptions below are scoped to supplied README snapshots, except the additional live source reads noted afterward. Test counts and live deployment claims are each project's reports, not tests executed during this review.

| Project | Visible proposition | What StakeLane should learn |
|---|---|---|
| Shepherd wallet | Scoped agent session keys, external policy reads and canonical/unstaked/staked comparison | Clear actor and a short negative/positive demo; do not pivot into another agent wallet |
| FrameGas | Token-paid gas, SDK/MCP, quota functionality, detailed frame costs and saved evidence | Developer ergonomics and cost accounting are a high bar; offer equally usable operator output |
| ClearAudit | Evidence-gated escrow and sponsored settlement | Show a concrete user problem; distinguish an evidence record from proof of semantic correctness |
| Eyrie / Q-Pay | Falcon-authorized token payments and per-entity budget patch | Budget increases are shared work, not a unique moat; real PQ traffic would be a useful optional fixture |
| Popcorn | Frame security modules, simulator, SDK and local stack | Avoid competing on module count; integrate or provide a narrow scheduling component |
| Kabuto | Price-pinned swaps and open intents, with attack/control evidence | Demonstrate the same workload before and after the policy change |
| ERC-8286 playground | Modular frame accounts, deployment and signature validators | Treat it as integration infrastructure; preserve account/nonce semantics |
| FrameCap | Daily quota validation and canonical-versus-alt demo | Simplicity of presentation; do not copy its headline as a differentiator |
| Q-Day Wallet | ML-DSA wallet with ENS/Arkiv evidence and disclosed blocked paths | Honest limitations are valuable; many integrations do not substitute for a finished core path |
| FrameLab | Pinned scenarios, release checks, shrink/export/replay/compare | Closest tooling competitor. Differentiate runtime admission scheduling from conformance testing |
| VEIL x BountyDesk | Private whitehat triage description and deployed static assets | Supplied material is insufficient to establish protocol depth or end-to-end correctness |
| subtx-generator | BSV UDP multicast workload generator | Relevant only as a CLI/load-testing design reference; not an EIP-8141 competitor |
| Lazara ReShade | Graphics shader/preset package | Not a Web3 or alternative-mempool competitor |

Additional current GitHub reads: FrameLab README/spec, FrameGas README, Q-Pay mempool-safety notes and FrameCap QuotaWallet source. These reads are selective, not full audits of those repositories. FrameCap's inspected wallet checks a requested value supplied in VERIFY data, with an empty setup path; the inspected function alone does not establish binding to every execution transfer. Do not infer that its advertised cap is independently proven secure.

Sources:
- https://github.com/batmnnn/batcorp/tree/main/framelab
- https://github.com/amityadav0/framegas
- https://github.com/yashj09/qpay/blob/main/docs/mempool-safety.md
- https://github.com/shubham5080/FrameCap/blob/main/contracts/src/QuotaWallet.sol

## Required improvements, in order

### 1. Finish the central experiment

Run the same invocation with native off/FIFO/fair modes, bursts 1/4/8 and at least 20 measured rounds, then repeat on fresh chains. Record B's p50/p95, A's batch p50/p95, throughput, errors, queue wait and service time. Keep a one-heavy control: the two-heavy cap does not engage there, so it must not be claimed as a fix for that condition.

Verify all admitted hashes and both frame statuses after timing, and check scheduler config plus actual maximum concurrent work. Compare identical signed inputs, genesis, node binary, fixture and sidecar build. Counterbalance policy order across repeated runs; all-off-then-FIFO-then-fair can confound policy with thermal or background-load changes. Twenty observations give a coarse p95, not a production tail-latency guarantee.

Acceptance: a complete manifest with all three measured arms, an explicit latency/throughput trade-off and no omitted failed trials. If fair mode does not improve the intended contention case, report that and investigate before making the benefit the headline.

### 2. Bound the simulation work that bypasses admission scheduling

At reviewed remote source, `Eth.admitFrameTransaction` uses the scheduler, but `Eth.estimateFrameTransactionGas` directly calls `simulate(fullTx)` and `MempoolReconciler.reconcileNew` also directly calls simulation. A flood of estimates can compete with scheduled admission; routine revalidation can do the same. Fixed-head benchmark isolation deliberately defers maintenance, so it cannot establish protection under normal maintenance load.

Use a shared bounded execution-work gate with explicit lanes or reservations for admission, estimation and maintenance. Retain necessary revalidation; do not disable it to obtain production claims. Separately bound cheap RPC work and ingress. Document that direct access to a publicly exposed ethrex simulation RPC lies outside a sidecar-only scheduler's control.

Acceptance: estimate traffic plus revalidation cannot make observed managed simulation concurrency exceed the configured budget; ordinary admission still completes; maintenance cannot starve indefinitely.

### 3. Test overload and identity limits

The global waiting cap permits one sender to fill the backlog. When every execution slot is occupied, another sender is rejected even though sender rotation exists. Add per-sender backlog limits or reserved queue capacity; specify the policy rather than claiming universal fairness.

The sender field is untrusted before verification. Avoid reputation penalties solely from failed requests naming that address. Many addresses can bypass a per-sender cap; this is not Sybil resistance. Heavy classification uses declared limits, not CPU measurement, and repeated cheap jobs can also occupy every slot. Put these limits in the threat model and test them.

Test: A-only saturation; A+B/C/D contention; many senders; 64-job overload; exact threshold and just above it; repeated identical hashes; exceptions; cancellation; stalled upstream; shutdown. Release a slot only when the underlying task has stopped, not merely when the HTTP client disconnects.

### 4. Resolve inherited correctness and replay issues

- Duplicate/replacement checks still follow simulation. Add early known-hash checks and concurrent in-flight deduplication; recheck mutable replacement conditions at insertion.
- Reconciliation cancels entries on infrastructure exceptions. Preserve uncertain entries and retry; distinguish an invalidity verdict from a failed observation.
- Storage checking iterates transient writes but checks only persistent `writes[slot]` in its read-only branch. Test and handle both write classes.
- Public transaction journals need restart-safe identical-payload recovery, with observation before any rebroadcast.

These are source findings requiring regression tests; they are not demonstrated theft exploits. Earlier audit findings were static and should not be advertised as confirmed vulnerabilities with measured impact.

### 5. Make the operator CLI reviewable in minutes

Current CLI strengths: short root command, bounded plans, explicit baseline-only mode, table plus JSON evidence, active-policy readback, incomplete-result handling and input fingerprints.

Current friction: no dependency doctor; Node/Bun/build/ethrex prerequisites are spread across documents; no named quick preset; progress is mostly inherited fixture logs; no user-chosen output option or offline report command; no structured top-level diagnosis. Only `compare` exists. Do not document proposed commands as implemented.

Recommended surface:

```text
./stakelane doctor
./stakelane compare --preset quick
./stakelane compare --preset full --output ./results/run-001
./stakelane report ./results/run-001 --verify
```

`doctor` should check versions, built files, binary architecture, executable permissions and pins without submitting anything. Quick must be labeled smoke-only, not a credible tail-latency study. Report should recompute saved statistics without starting a chain. Human output should show current policy/trial, elapsed time, evidence path and one actionable fix per failure. Machine mode should emit stable JSON with logs on stderr. Preserve existing exit semantics or version a new contract explicitly. Handle missing Node in the shell wrapper with a useful message.

Acceptance: a second developer follows one documented setup path from a clean Linux checkout, runs quick without editing source/config, understands a deliberately missing dependency, and verifies a saved report offline.

### 6. Package the submission

Move the main README pitch to the contention problem, intervention and measured trade-off. Keep historical budget experiments, but mark the devnet build/genesis/time because the supplied organizer discussion reports resets and policy changes. The budget patch is infrastructure context rather than the headline.

Add project-level license clarity without replacing upstream license notices, AI disclosure, reproducible setup pins and a 90-second demo script. Record live, saved and simulated output explicitly. Show a local node/replay if the public network is unreliable; the supplied organizer conversation explicitly permits local submissions, but this is user-supplied conversation evidence rather than an independently authenticated organizer statement.

Do not add a token, DAO, extra chain, PQ wallet, or Anon-RPC integration solely to increase feature count. A second real verifier fixture is useful after the core comparison works. Any public traffic should be a bounded ordinary submission, never the saturation benchmark.

## Suggested pitch

“StakeLane schedules validation work before an alternative-mempool node admits a transaction. In our local hash-chain experiment, one wallet's burst raised another wallet's median admission latency from 12.8 ms to 129.2 ms. Our implemented policy caps concurrent heavy admissions per sender. `stakelane compare` measures whether this lowers the second wallet's latency and what it costs the first wallet's batch. The comparison benefit is not yet established by the committed evidence. Builders still decide inclusion.”

After complete fair-mode measurements exist, replace the final evidence limitation with the actual observed trade-off, including unfavorable results.

## Verification limits

No new public transactions, load test, Node/Bun unit suite or private-chain integration ran during this review. Node/Bun were not available on the current execution PATH and dependencies/binary were not installed here. The new scheduler and CLI tests were inspected, not executed. No competitor was fully audited. Source changes were not made; this report is the only added project file.
