# Builder admission benchmark

This exploratory experiment measures admission wall time on one Mac. On two fresh private chains an independent wallet waited longer when four competing transactions supplied correct witnesses than when four supplied incorrect witnesses. Each candidate ran the same 9,664 Keccak hashes. Both kinds of traffic delayed the wallet relative to idle. Only successful submissions increased the submitting wallet's normal reputation `seen` counter.

## Matched hash-chain workloads

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

In a separate 12-round admission measurement with four execution workers, wallet B's median admission rose from 12.8 ms idle to 129.2 ms during a valid burst. Under load, 121.5 ms elapsed before B's traced simulation began. Its stake-registry read took 107.4 ms, up from 0.6 ms idle. B's own traced RPC took 2.9 ms under load. These timings locate the wait at the RPC boundary. A scheduler experiment can now test whether limiting A's in-flight simulations leaves execution capacity for B's preflight. [Measurements, methods and per-trial data](../sidecar/evidence/admission-concurrency-profile.json)

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
- The scope is one Mac, one client build and bursts of four from one staked wallet. The next experiment compares the same workload with the scheduler off and on. Report the independent wallet's admission latency and time to admit the last valid transaction in the submitting wallet's burst.

For a broader local sweep, report burst size or concurrency separately from offered requests per second. Publish the sample count with p50 and p95. A CPU-cost claim also requires process CPU measurements for the sidecar and execution client. A node-wide budget should count failed verification work. Sender reputation penalties would require evidence that the sender authorized the failed request.

## Reproduce

Run the matched hash-chain workload comparison from `sidecar/`.

```sh
node test/stakelane/run.mjs --matched-benchmark
```

To reproduce the earlier early-versus-late comparison, run the following command.

```sh
node test/stakelane/run.mjs --builder-benchmark
```

For a fresh checkout, follow the [private node setup](SIDECAR.md#reproduce-the-mined-transaction) first. The runner prints the report path under `.runtime/`. Set `STAKELANE_EVIDENCE` to a new path to retain an export.

- [Early-failure control, run 1](../sidecar/evidence/builder-benchmark.json)
- [Early-failure control, run 2](../sidecar/evidence/builder-benchmark-repeat.json)
- [Benchmark implementation](../sidecar/test/stakelane/failure-benchmark.mjs)

