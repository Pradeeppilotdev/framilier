# Builder admission benchmark

The original scheduler comparison below ran on Apple Silicon at `7d052e7`. The later hardening experiments used a separate Linux setup and report their own results. [Hardening measurements](HARDENING_VALIDATION.md) · [Operator guide](OPERATOR.md)

## Scheduler comparison on 6 November 2026

When wallet A submitted eight heavy transactions at once, fair scheduling reduced wallet B’s p95 admission time from 678.0 ms under FIFO to 238.2 ms. A’s median time to admit its whole batch rose from 593.2 ms to 622.1 ms. Both policies had four slots. Fair scheduling allowed one sender to occupy at most two slots with heavy work.

`./framilier compare` replayed the same signed transactions under each policy on a fresh private chain (`8141337`) on one Mac, using commit `7d052e7`. Both wallets staked 0.012 test ETH. When A sent a burst, B submitted one cheap transaction as A’s first simulation started. B’s timer ended when the sidecar returned its transaction hash. A’s batch time ran from its first submission to its last admission response. The runner mined the transactions after these timers stopped.

| Heavy transactions from A | Policy | B median (ms) | B p95 (ms) | A batch median (ms) |
| ---: | --- | ---: | ---: | ---: |
| 0 | Off | 20.6 | 25.8 | — |
| 0 | FIFO | 19.8 | 26.1 | — |
| 0 | Fair | 20.4 | 25.3 | — |
| 1 | Off | 134.8 | 142.7 | 134.8 |
| 1 | FIFO | 133.4 | 142.1 | 134.7 |
| 1 | Fair | 134.1 | 142.9 | 134.6 |
| 4 | Off | 234.1 | 256.0 | 277.5 |
| 4 | FIFO | 242.3 | 249.2 | 319.4 |
| 4 | Fair | 133.9 | 142.4 | 338.6 |
| 8 | Off | 301.4 | 400.5 | 367.5 |
| 8 | FIFO | 590.8 | 678.0 | 593.2 |
| 8 | Fair | 133.6 | 238.2 | 622.1 |

Each row covers 20 measured rounds. With one heavy transaction, B’s median ranged from 133.4 to 134.8 ms across the three policies. At eight, the observer saw up to eight overlapping simulation requests from A with scheduling off, four with FIFO and two with fair scheduling.

All 340 measured transactions mined under each policy (260 from A and 80 from B), giving 1,020 inclusions across the three chains. Every heavy receipt recorded 993,512 VERIFY gas. The table uses the completed sweep and excludes warm-ups and an earlier interrupted run. [Comparison summary](../sidecar/evidence/compare/merged-main-7d052e7/comparison.json) · [Off trials](../sidecar/evidence/compare/merged-main-7d052e7/off.json) · [FIFO trials](../sidecar/evidence/compare/merged-main-7d052e7/fifo.json) · [Fair trials](../sidecar/evidence/compare/merged-main-7d052e7/fair.json) · [Verification record and checksums](../sidecar/evidence/compare/merged-main-7d052e7/verification.json)

## Matched hash-chain workloads

This exploratory experiment measures admission wall time on one Mac. On two fresh private chains an independent wallet waited longer when four competing transactions supplied correct witnesses than when four supplied incorrect witnesses. Each candidate ran the same 9,664 Keccak hashes. Both kinds of traffic delayed the wallet relative to idle. Only successful submissions increased the submitting wallet's normal reputation `seen` counter.

| Background traffic from one staked wallet | Run 1 median probe admission | Run 2 median probe admission |
| --- | ---: | ---: |
| Idle (zero submissions) | 11.571 ms | 11.173 ms |
| Four incorrect witnesses, 9,664 hashes each | 47.582 ms | 44.499 ms |
| Four correct witnesses, 9,664 hashes each | 129.083 ms | 129.244 ms |

Valid traffic delayed the probe more than late failures in all 24 paired rounds. The median within-round difference was 85.459 ms in run 1 and 82.413 ms in run 2. Across those runs, all 72 independent probes and all 96 expensive valid transactions mined. Each expensive valid receipt recorded 993,512 VERIFY gas. All 96 incorrect witnesses reached the final digest check and were rejected. Warm-ups are excluded from these counts.

Each accepted or rejected background transaction triggered one observed traced simulation. Its median RPC duration was 208.104 / 204.933 ms for correct witnesses and 61.810 / 62.367 ms for incorrect witnesses. Per run, the submitting wallet's `seen` counter increased by 48 across 48 valid transactions and by zero across 48 late failures. Either outcome can consume simulation time before the counter updates.

Both groups used the same staked wallet, signing key, fee settings and 1,000,000 declared verification budget. Changing one nonzero witness nibble preserved the calldata length and byte cost. The runner initialized 104 separate nonce keys in seven setup transactions. Each warm-up or measured background transaction used one of those keys at sequence 1. This let all four correct submissions coexist from the same wallet.

The independent wallet started when the observer saw the first competing simulation. After all admission timers stopped, the runner relayed one accepted transaction per block and checked canonical block membership and both frame statuses for each hash. An initial setup with multiple transactions in one payload produced a receipt-lookup error from the pinned node. The timings cover concurrent admission, while the receipts establish individual inclusion. Separating queueing, tracing and insertion costs would require additional instrumentation.

[Run 1 raw trials](../sidecar/evidence/matched-valid-benchmark.json) · [Run 2 raw trials](../sidecar/evidence/matched-valid-benchmark-repeat.json)

## Where the second wallet waited

All four competing traced RPCs overlapped in 20 of the original 24 valid bursts. To test whether ethrex also executed work in parallel, we bypassed the sidecar and timed four valid 993,512-gas simulations at a fixed private block. With one execution worker, the median batch took 370 ms sequentially and 368 ms concurrently. With four workers, it took 382 ms sequentially and 103 ms concurrently. The latter batch used 407 ms of ethrex process CPU. Each median covers eight warmed batches on the same Mac.

In a separate 12-round admission measurement with four execution workers, wallet B's median admission rose from 12.8 ms idle to 129.2 ms during a valid burst. Under load, 121.5 ms elapsed before B's traced simulation began. Its stake-registry read took 107.4 ms, up from 0.6 ms idle. B's own traced RPC took 2.9 ms under load. This wait at the RPC boundary motivated the comparison of FIFO and fair scheduling. [Measurements, methods and per-trial data](../sidecar/evidence/admission-concurrency-profile.json)

## Earlier control using early rejections

Two earlier fresh-chain runs compared the late failure with a 31-byte witness that failed before hashing. Four concurrent late failures increased the independent wallet's median admission time to about 47 ms.

| Traffic accompanying the valid probe | Run 1 median admission | Run 2 median admission |
| --- | ---: | ---: |
| Idle | 13.295 ms | 12.456 ms |
| Four early failures | 12.262 ms | 12.365 ms |
| Four late failures | 46.874 ms | 47.280 ms |

The valid probe was slower under late failures than under both controls in all 24 paired rounds across the two runs. The within-round median increase over early failures was 35.014 ms and 34.913 ms respectively. All 72 measured valid transactions mined.

### Work observed in the earlier runs

Each run recorded 48 early and 48 late rejections after warm-up. Every rejected candidate triggered one execution RPC asking for traced simulation. The median duration of that RPC was **4.816 / 4.814 ms** for early rejection and **68.786 / 68.705 ms** for late rejection in runs 1 and 2. These are overlapping wall-clock intervals, including transport, and do not measure CPU time. The successful reference transaction consumed 993,512 VERIFY gas. Failed transactions were classified by their verified revert reasons.

In both runs the submitting wallet's `seen` count stayed at **2** and its reputation stayed **OK**. Its `included` count went from 0 to 2 as the two previously mined setup transactions were accounted for. The failed submissions were rejected before mempool insertion. In this implementation the normal seen-counter update happens on insertion after simulation.

## Method and scope

- The runner starts a private ethrex node and sidecar on loopback, chain `8141337`. It deploys two distinct wallets controlled by separate signing keys, each with a mined stake of 0.012 test ETH.
- Each background transaction is uniquely signed and declares 997,200 VERIFY execution gas plus 2,800 signature gas. The earlier control used a 31-byte witness to fail before hashing. In the matched runs both witnesses were 32 bytes and reached the digest check after all 9,664 hashes.
- A local transparent RPC observer timestamps each matched simulation. Under background traffic the valid probe starts when the first competing simulation request reaches the observer. The valid wallet uses its clean 70,000-gas VERIFY path. The timer covers submission to admission response. Signing, reputation reads, relaying, and block inclusion happen outside that timer.
- One warm-up of each condition is excluded. The runner then executes 12 rounds per fresh chain, cycling through every ordering of the three conditions twice. It verifies the returned hash, exact rejection reasons, one simulation per candidate and a canonical successful receipt for each valid probe.
- The fixture uses the unoptimized native ethrex executable with four Tokio worker threads on the same Mac as the test client. The upstream release lookup was blocked locally by a non-forwarding HTTP proxy before each benchmark. The shared devnet was never a test target.
- These earlier controls used one Mac, one client build and bursts of four from one staked wallet. The scheduler comparison also measures how long A waits for its last admission.

For a broader local sweep, report burst size or concurrency separately from offered requests per second. Publish the sample count with p50 and p95. A CPU-cost claim also requires process CPU measurements for the sidecar and execution client. A node-wide budget should count failed verification work. Sender reputation penalties would require evidence that the sender authorized the failed request.

## Run framilier compare

From the repository root, `./framilier compare` starts fresh private loopback processes. It uses the Bun, Node and pinned ethrex setup described in [the local runbook](SIDECAR.md#reproduce-the-mined-transaction). The default sweep contains an idle control and bursts of 1, 4 and 8 valid transactions. Each condition has one excluded warm-up and 20 measured rounds. The order of the burst sizes rotates between rounds. For a short baseline smoke test run:

```sh
./framilier compare --baseline-only --rounds 2 --bursts 1,4
```

- B submits a cheap valid transaction when the observer sees the first competing trace. Its timer starts at submission and stops when the sidecar returns the admission hash. A’s batch time runs from its first submission until the last hash comes back. Signing, setup and block production take place outside these timers.
- For the current sweep, the fixture waits for the private sidecar to mark the previous batch `OnChain`. It defers the sidecar’s periodic recheck timer while admission is timed, verifies the execution head hash on both sides of the interval, and restores the timer before mining. The observer requires exactly one traced simulation per signed input. This separates initial admission from the work of revalidating entries after a block.
- The report uses the median and the nearest-rank p95, always with a sample count. Every accepted hash must have a successful receipt in its canonical block, two successful frame statuses, and each measured heavy transaction must use 993,512 VERIFY gas. Setup transactions and warm-ups are excluded from the counts.
- Each policy uses the same two disposable signing identities in an isolated chain. The coordinator compares the genesis, execution binary, compiled fixture and digest of all signed inputs across policies before presenting a comparison. Each policy runs as a separate sweep on the same machine, so background load and temperature can affect differences.
- The command prints the path to `comparison.json` under `sidecar/.runtime/compare-*`. In that directory a JSON file for each measured policy contains the underlying transaction hashes, canonical block hashes and samples. Exit 0 means the requested comparison or explicit baseline run completed. Exit 2 means the baseline completed and the scheduling modes were unavailable. A failed fixture or a mismatch exits 1.
- The manifest records an arm as `in-progress` before starting the node. Only `measured` arms with a final summary supply timings. A hard interruption can leave the last progress record on disk.

### Baseline measurements on 6 November 2026

Both sweeps ran on the same Mac with the same ethrex binary and compiled wallet fixture. Each used a fresh private chain and signing keys. Each table cell comes from 20 measured rounds. Per sweep, all 80 transactions from B and all 260 heavy transactions from A mined, with 993,512 VERIFY gas for every heavy transaction. The counts exclude warm-ups.

| Heavy transactions from A | B median, run 1 (ms) | B p95, run 1 (ms) | B median, fixed head (ms) | B p95, fixed head (ms) | A batch median, fixed head (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 14.2 | 18.4 | 17.3 | 26.1 | — |
| 1 | 128.2 | 137.4 | 134.5 | 144.3 | 133.6 |
| 4 | 136.5 | 243.6 | 231.1 | 245.8 | 298.6 |
| 8 | 286.3 | 365.5 | 308.5 | 381.0 | 380.4 |

Run 1 finished with the original maintenance timer and one observed trace per input. The second completed sweep used the fixed-head procedure above and recorded the exact stake-registry read for B. Its median duration rose from 1.0 ms idle to 114.2 ms with a single heavy transaction, while B’s traced simulation took 3.0 ms in that condition. The lookup measurement includes local transport and waiting for the execution node. [Run 1 summary](../sidecar/evidence/compare/run-1/comparison.json) · [Run 1 samples](../sidecar/evidence/compare/run-1/off.json) · [Fixed-head summary](../sidecar/evidence/compare/run-2/comparison.json) · [Fixed-head samples](../sidecar/evidence/compare/run-2/off.json)

Both of these earlier sweeps measured the default sidecar. The two-heavy-per-sender limit first applies when A submits a third concurrent heavy transaction, so the one-heavy case serves as a control in the three-policy comparison.

### Verify the saved measurements

The following offline check covers the two earlier baseline sweeps and their replay controls. It runs from the repository root with Node alone. It recomputes the median and nearest-rank p95 from individual trials, counts the receipt records, checks for reused transaction hashes and verifies the signed-input fingerprint. In the instrumented repeat it also reconstructs A’s batch time from the earliest submission and last admission response.

```sh
node --test sidecar/test/framilier/compare-evidence.test.mjs
```

One interrupted attempt left no final report. A separate attempt recorded two traced simulations for a single hash and stopped before producing a timing row. The sidecar can revalidate pending entries after it observes a new block. The current fixture separates that maintenance from initial admission and retains the exact-one-trace check. [Excluded attempt](../sidecar/evidence/compare/excluded-attempt.json)

A separate replay control started two private nodes with identical disposable signing identities. Both produced the same genesis hash and signed-transaction fingerprint across the idle and one-heavy cases. Requesting FIFO directly on the original sidecar failed before timing. A deliberate interruption of the CLI during setup changed its progress manifest to `failed` and produced no timing summary. [Replay and failure controls](../sidecar/evidence/compare/replay-control.json)

### Scheduler integration

The CLI sets these network configuration keys on each fresh sidecar. It reads `skandha_config.admissionScheduler` and checks the effective `mode`, `slots`, `maxHeavyPerSender`, `maxWaiting` and `heavyThreshold` before reporting enabled-mode measurements. The comparison adapter in `sidecar/test/framilier/compare-metrics.mjs` owns this mapping. The sidecar schedules the work.

```json
{"schedulerMode":"fair","schedulerSlots":4,"schedulerMaxHeavyPerSender":2,"schedulerMaxWaiting":64,"schedulerHeavyThreshold":100000}
```

The enabled modes are `fifo` and `fair`. Both use four total slots. In fair mode, one sender may use two heavy slots. The comparison checks the observed trace overlap against the reported limits. On the original sidecar the config RPC omits scheduling information. The CLI prints that measured row as `default` and leaves enabled-mode timings unreported.

## Reproduce the earlier controls

Run the matched hash-chain workload comparison from `sidecar/`.

```sh
node test/framilier/run.mjs --matched-benchmark
```

To reproduce the earlier early-versus-late comparison, run the following command.

```sh
node test/framilier/run.mjs --builder-benchmark
```

For a fresh checkout, follow the [private node setup](SIDECAR.md#reproduce-the-mined-transaction) first. The runner prints the report path under `.runtime/`. Set `FRAMILIER_EVIDENCE` to a new path to retain an export.

- [Early-failure control, run 1](../sidecar/evidence/builder-benchmark.json)
- [Early-failure control, run 2](../sidecar/evidence/builder-benchmark-repeat.json)
- [Benchmark implementation](../sidecar/test/framilier/failure-benchmark.mjs)

