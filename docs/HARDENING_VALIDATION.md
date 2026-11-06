# framilier hardening validation

Cresnex supplied these Linux results in PR #4 at `8de92f3`, based on `7d052e7`. The archived runs identify their compiled sidecar by SHA-256. The tests and timing tables below describe that contributor build. Subsequent review changes were tested separately on macOS. [Original Mac scheduler measurements](BUILDER_BENCHMARK.md#scheduler-comparison-on-6-november-2026)

## Changes

- Shared simulation capacity across admission, estimation and block-driven revalidation. Auxiliary work reserves capacity for admission and lanes rotate; queued work is bounded independently per lane.
- Per-sender admission backlog cap (at most 16 by default), preserving existing global capacity and heavy-work rotation.
- Concurrent RPC/gossip duplicate coalescing and early known-hash/replacement checks, with insertion-time replacement rechecks retained.
- Revalidation preserves uncertain entries on transport/registry/internal/busy errors; explicit invalidity verdicts still cancel.
- Both transient-write aggregation and write classification corrected, with regression coverage.
- Restart-safe submission journal recovery from identical signed bytes after explicit observation checks. Legacy journals without raw bytes require manual recovery.
- `doctor`, quick/full compare presets, custom output directory, counterbalanced policy order, JSON output and offline report verification.
- Operator setup, saved-result inspection and a timed demo script.

## Runtime and scope

Node v24.11.1 and Bun 1.3.14 were downloaded to `/tmp` for validation. Dependencies were installed from the frozen Bun lockfile. The native x86_64 Linux ethrex binary was extracted from the pinned image `ghcr.io/forshtat/eip8141-devnet@sha256:c9a7770f892e02255999e1c0ffd596ecee704d9175c2480811ccdcfa1c2224c6`; its version identifies ethrex source `9aa3645d795945c64400f41a70aace0edfa7f383`.

The test runner owns disposable loopback execution nodes and sidecars, blocks the execution client's external release lookup and generates throwaway identities. It validates stake, boundary/invalid-witness controls, canonical block membership and both frame statuses. No saturation traffic is sent to a public endpoint. The container image was downloaded, but the experiments use its extracted native executable rather than a running container.

## Checks

- Workspace build passed after the implementation changes.
- All **448 executor tests across 35 files passed**. Regression cases cover shared capacity, overload, duplicate suppression, transient writes and infrastructure failure handling.
- All **16 Node CLI/evidence tests passed**, including historical evidence verification, tampered-statistic rejection and exact-byte journal recovery.
- The complete quick comparison passed for off/FIFO/fair, with two measured rounds at bursts 1 and 4 plus idle, and all accepted hashes verified in canonical private blocks. Quick results are smoke-only.
- The full 20-round off/FIFO/fair comparison completed and passed offline verification. All **1,020 measured transactions** mined: 780 heavy transactions and 240 independent probes, excluding warm-ups and setup. The reversed-order, 20-round eight-heavy repeat also completed: all **600 measured transactions** mined. Together the experiments verified **1,620 measured transactions**, excluding warm-ups and setup.

## Full comparison results

Each row has 20 measured trials. Same signed inputs, genesis, execution binary, compiled fixture and sidecar build within the comparison. Policy order was off → FIFO → fair.

| Policy | A burst | B p50 ms | B p95 ms | A batch p50 ms | A batch p95 ms |
|---|---:|---:|---:|---:|---:|
| off | 0 | 37.1 | 52.6 | — | — |
| off | 1 | 99.6 | 123.6 | 95.292 | 116.915 |
| off | 4 | 252.6 | 331.0 | 268.082 | 348.213 |
| off | 8 | 420.7 | 558.1 | 480.796 | 656.463 |
| fifo | 0 | 32.9 | 50.7 | — | — |
| fifo | 1 | 97.5 | 124.5 | 93.823 | 118.07 |
| fifo | 4 | 261.0 | 329.4 | 274.648 | 338.352 |
| fifo | 8 | 458.9 | 629.3 | 488.207 | 665.214 |
| fair | 0 | 34.1 | 48.9 | — | — |
| fair | 1 | 98.5 | 121.2 | 96.423 | 112.532 |
| fair | 4 | 177.2 | 236.5 | 275.61 | 355.182 |
| fair | 8 | 175.6 | 219.8 | 545.676 | 683.292 |

At burst 4, fair reduced B p50 by **29.8%** and p95 by **28.6%**, while A batch p50 rose **2.8%** versus off. At burst 8, B p50 fell **58.3%** and p95 **60.6%**, while A batch p50 rose **13.5%**. The one-heavy control was similar across policies; its two-heavy cap does not engage. These are descriptive local results, not confidence bounds or a production SLA.

Evidence: [manifest](../sidecar/evidence/hardening/full-1/comparison.json), [off samples](../sidecar/evidence/hardening/full-1/off.json), [FIFO samples](../sidecar/evidence/hardening/full-1/fifo.json), [fair samples](../sidecar/evidence/hardening/full-1/fair.json), [host metadata](../sidecar/evidence/hardening/environment.json).

```sh
./framilier report sidecar/evidence/hardening/full-1 --verify
```

Collection ran on a shared desktop. One short targeted unit check ran during the first baseline arm; this is a background-load limitation, not an excluded trial. A separate repeat checks the central eight-heavy result in reverse policy order without concurrent builds or unit tests.

## Repeat in reverse policy order

The independent repeat used fresh chains/identities and policy order fair → FIFO → off. Each row has 20 measured trials. The execution binary, fixture and sidecar build hashes match the first experiment.

| Policy | A burst | B p50 ms | B p95 ms | A batch p50 ms | A batch p95 ms |
|---|---:|---:|---:|---:|---:|
| fair | 0 | 29.9 | 39.5 | — | — |
| fair | 8 | 168.9 | 183.2 | 487.385 | 573.8 |
| fifo | 0 | 29.0 | 38.0 | — | — |
| fifo | 8 | 432.7 | 479.8 | 450.043 | 511.067 |
| off | 0 | 28.8 | 36.9 | — | — |
| off | 8 | 378.3 | 434.3 | 401.14 | 475.357 |

At burst 8, fair reduced B p50 **55.4%** and p95 **57.8%**, while A batch p50 increased **21.5%** versus off. This supports the direction of the first result, while showing that the cost to A varies. Do not present the lower first-run cost as universal. No claim of statistical significance is made.

Evidence: [repeat manifest](../sidecar/evidence/hardening/repeat-8/comparison.json).

```sh
./framilier report sidecar/evidence/hardening/repeat-8 --verify
```

## Small-workload regression

A separate fresh private chain with `FRAMILIER_HASH_ROUNDS=1` passed the inclusion runner and all negative controls. The VERIFY frame used **7,886 gas**; both frames succeeded in canonical block 5. This confirms small supported workloads no longer fail the old unconditional 500,000-gas minimum. The runner now bounds custom rounds to 1–9,664 under its fixed execution allowance; the measured benchmark still requires exactly 9,664 rounds and 993,512 VERIFY gas. [Receipt and controls](../sidecar/evidence/hardening/small-workload.json).

## Interpretation limits

The workload is a synthetic Keccak hash chain with 993,512 VERIFY gas, not a real privacy protocol or post-quantum wallet. Admission timings exclude signing, setup, mining and the maintenance window. Maintenance is deliberately deferred during timed initial admission; mixed-path capacity is covered by regression tests, not a production load benchmark. The execution and sidecar binary/build hashes identify what ran; fingerprints and saved receipts improve reproducibility but are not independent attestations.

There is no guarantee of starvation freedom if an underlying task never settles. A node-wide execution budget cannot control direct requests to an independently exposed ethrex API. Per-sender controls can be bypassed with more identities; sender names are not authenticated before validation. No claims of production security, Sybil resistance, measured inclusion-latency improvement or guaranteed prizes are made.

## macOS merge review

The integrated source at `cdb065b` built on Apple Silicon with Node 26.12.1 and Bun 1.4.4. All 521 checks passed (460 executor, 22 operator and evidence, 8 peer, and 31 explorer). The checks include the follow-up replacement race and rejection of mislabeled reports. `doctor` recognized the local execution binary.

A fresh one-round comparison replayed identical signed inputs under fair, FIFO and off on private chain `8141337`. All 18 measured submissions mined across the three chains. This is a functional smoke check. An earlier attempt interrupted during the final policy was excluded from this record. The 20-round tables above describe the contributor’s archived Linux build. [Smoke samples and summary](../sidecar/evidence/compare/pr4-macos-smoke/comparison.json) · [Build and input fingerprints](../sidecar/evidence/compare/pr4-macos-smoke/verification.json)
