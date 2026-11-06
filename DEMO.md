# StakeLane: 90-second operator demo

Before presenting: run `./stakelane doctor`, run a full comparison, and verify its saved report. Use the actual results, including regressions. Keep a saved run available if the local runtime is unavailable; label replay as replay.

1. **Problem (0–15 seconds).** “Alternative-mempool nodes execute verification before collecting transaction fees. One wallet's expensive burst can delay another wallet's simple transaction. StakeLane controls admission work; the builder still chooses inclusion.”
2. **Policy (15–30 seconds).** Show off/FIFO/fair config. “Four total admission slots, at most two heavy jobs per sender, bounded queues, plus a shared execution budget covering estimates and maintenance.” State that per-sender fairness is not Sybil resistance.
3. **Evidence (30–60 seconds).** Run `./stakelane report <completed-run-directory> --verify`. Show B's p50/p95 and A's batch time at bursts 1,4,8. Compare identical signed workloads and show the actual numerical trade-off. If fair does not help a row, say so. Do not substitute old idle-versus-busy results for new policy comparisons.
4. **Correctness (60–80 seconds).** Show one canonical receipt and the input/build fingerprints. Explain that all accepted hashes are mined after admission timing, one per private block; these receipts do not measure inclusion latency under scheduling.
5. **Limits (80–90 seconds).** “Local synthetic hash-chain workload, one machine and one node build. The next deployment test uses realistic verifier traffic and maintenance load. No claim of production security or universal DoS prevention.”

Use `./stakelane compare --preset quick` only as a setup demonstration. It takes longer than a live presentation segment and its two samples per condition are not performance evidence. Show a saved full report during the short demo.
