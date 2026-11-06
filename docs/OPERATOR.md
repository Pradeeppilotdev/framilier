# Run StakeLane

StakeLane is for alternative-mempool node operators measuring the trade-off between another wallet's admission latency and a busy wallet's batch completion time. It does not select block contents or provide Sybil resistance.

## Prerequisites

- Node.js 20.12 or newer; Node 24 LTS is recommended.
- Bun 1.x from 1.3.14 onward. The contributor used 1.3.14 on Linux and the Mac review used 1.4.4.
- The Linux or macOS native ethrex executable from commit `9aa3645d795945c64400f41a70aace0edfa7f383`. See [private setup](SIDECAR.md#reproduce-the-mined-transaction). The Linux executable used for the new comparisons comes from `ghcr.io/forshtat/eip8141-devnet@sha256:c9a7770f892e02255999e1c0ffd596ecee704d9175c2480811ccdcfa1c2224c6`.

From the repository root:

```sh
cd sidecar
bun install --frozen-lockfile
bun run build
cd ..
export STAKELANE_ETHREX_BIN=/absolute/path/to/ethrex
./stakelane doctor
```

For runtime checks, Bun is selected from `STAKELANE_BUN_BIN`, `sidecar/.runtime/bin/bun`, then `PATH`. Use a Bun executable on your shell’s `PATH` for the install and build commands above. `doctor` checks prerequisites locally. It recognizes the pinned ethrex revision in the version output. For a build that omits the revision, it recognizes the archived Apple Silicon binary by SHA-256 or checks that the executable resolves to `target/debug/ethrex` inside a source checkout at the full pinned commit with clean tracked files. The latter check identifies the local source and build path. Each comparison records the actual executable hash.

On Linux amd64 with Docker, the pinned image avoids a Rust source build. These commands extract its executable without starting an execution container:

```sh
mkdir -p sidecar/.runtime/bin
docker create --name stakelane-extract ghcr.io/forshtat/eip8141-devnet@sha256:c9a7770f892e02255999e1c0ffd596ecee704d9175c2480811ccdcfa1c2224c6
docker cp stakelane-extract:/usr/local/bin/ethrex sidecar/.runtime/bin/ethrex
docker rm stakelane-extract
export STAKELANE_ETHREX_BIN="$PWD/sidecar/.runtime/bin/ethrex"
./stakelane doctor
```

Podman supports the same create/cp/rm sequence. The extracted Linux executable is not a macOS binary; use the native build instructions on macOS. The fixed extraction container name must be unused; do not remove someone else's container to make it available.

## Smoke test

```sh
./stakelane compare --preset quick --output ./results/smoke-001
```

This starts fresh disposable loopback execution nodes and sidecars for off, FIFO and fair, using the same signed inputs across policies. It includes an idle control and two measured rounds at bursts 1 and 4. A successful run verifies canonical receipts after timing. Two rounds are a smoke test, not credible evidence about production p95 latency.

## Full comparison

```sh
./stakelane compare --preset full --output ./results/full-001
./stakelane report ./results/full-001 --verify
./stakelane compare --preset full --order fair,fifo,off --output ./results/full-002
./stakelane report ./results/full-002 --verify
```

Full defaults to 20 rounds at bursts 1, 4 and 8, plus idle and excluded warm-ups. Counterbalance policy order on the repeat; never run the two comparisons concurrently on the same machine. The output directory must not already exist, preventing silent replacement or mixing of results. `--rounds` and `--bursts` override the preset within the command's safety bounds. Explicit `--baseline-only` tests only off. `--json` emits a final JSON report on stdout, with progress on stderr.

Read B p50/p95 together with A batch p50/p95. Lower B latency with slower A completion is a scheduling trade-off, not free throughput. A one-heavy burst is a control: the two-heavy-per-sender cap does not engage there. Neither a median nor p95 from twenty observations is a production service-level guarantee.

Exit codes: 0 means the requested complete comparison or explicit baseline completed; 1 means an error or evidence mismatch; 2 means an incomplete comparison or a failed prerequisite check. A completed quick run is still smoke-only. `report` verifies saved statistics, policy settings and input/build fingerprints; it does not independently authenticate historical chain execution.

## Operator policy

The example startup config explicitly enables fair scheduling:

```json
{
  "schedulerMode": "fair",
  "schedulerSlots": 4,
  "schedulerMaxHeavyPerSender": 2,
  "schedulerMaxWaiting": 64,
  "schedulerHeavyThreshold": 100000
}
```

The library default remains off for backward compatibility. Use `skandha_config.admissionScheduler` to check the live instance. It also reports `maxWaitingPerSender`, which is the smaller of 16 and the global waiting limit. With the example settings, one sender can occupy at most 16 of the 64 waiting positions. FIFO retains arrival-order dispatch; fair rotates eligible senders while preserving each sender's arrival order.

When enabled, every `FrameTxSimulationService` invocation also shares a total execution budget equal to `schedulerSlots`. Admission, estimation and maintenance have separately bounded waiting lanes and rotate fairly. Estimates plus maintenance may occupy at most `slots - 1` active positions when there is more than one slot, reserving at least one position for admission rather than auxiliary work. Existing admissions can still occupy that position. Slots count managed requests, not a guaranteed one-to-one mapping to execution CPU threads. With one slot there is no capacity to reserve; rotation provides eventual service when tasks complete. A slot remains occupied until its underlying work settles, including when a caller disconnects.

## Failure and security behavior

- Concurrent identical RPC/gossip transactions share one in-flight admission; already-known non-cancelled hashes return without another simulation. Cancelled transactions can be retried and validated again.
- Underpriced replacements are checked before simulation and replacement conditions are rechecked under the mempool insertion lock.
- Scheduler overflow is retryable overload, not a reputation penalty. Sender identity is untrusted before verification; do not infer sender guilt from a rejected request.
- Revalidation cancels an entry on explicit validation verdicts. Registry failures, transport errors, overload and internal errors preserve it for a later block's retry.
- Persistent and transient foreign writes follow the same storage restriction. Trace aggregation retains transient-write counts.
- Public journals retain signed deployment and frame bytes. A submit rerun observes the saved hash first and only rebroadcasts identical bytes after explicit absence checks. Observation failures prevent rebroadcast. Old deployment journals without signed bytes require manual investigation.
- Open address creation can defeat per-sender fairness; declared gas is a work hint, not a wall-clock measurement. Continuous cheap jobs, queue churn, shared paymasters and third-party RPC load remain threat-model limits.
- Direct access to ethrex bypasses a sidecar-only gate. Keep the execution/Engine/debug APIs private and use endpoint-level ingress controls for any public sidecar. `--redirectRpc` is for a trusted local setup, not a production public gateway configuration.

## Tests

```sh
cd sidecar
bun run build
bun run test:stakelane
bun run test:operator
cd ..
```

The tests cover scheduler capacity/rotation/overflow, shared simulation lanes, duplicate admission, infrastructure-failure retention, transient writes, report tampering and journal recovery. The observer test opens loopback sockets. Historical measurements are retained unchanged; new evidence is stored separately.
