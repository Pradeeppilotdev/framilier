# Native scheduler hardening evidence

These are new private-chain experiments, separate from the historical Mac measurements under `../compare/`. `small-workload.json` separately verifies the one-hash inclusion regression (7,886 VERIFY gas).

`full-1/` contains 20 measured rounds per condition at idle and bursts 1,4,8 for off, FIFO and fair. `comparison.json` records input/build fingerprints and summaries; each policy file contains the individual observations and fixture receipts. All 1,020 measured transactions mined with both frames successful. Every measured heavy transaction consumed 993,512 VERIFY gas.

The workload, actors, genesis, ethrex binary, compiled fixtures and sidecar build must match **within** a comparison. Fresh comparisons generate new throwaway identities, so different runs need not have the same genesis or signed-input fingerprint. Policy settings are read back from the running sidecar. This is a local scheduling experiment, not a deployed privacy wallet.

`repeat-8/` repeats idle and burst 8 for 20 rounds, with order fair → FIFO → off, on fresh chains/identities but the same binaries/build. All 600 measured transactions mined. Together the runs record 1,620 measured transactions, excluding warm-ups and setup.

Verify saved runs from the repository root:

```sh
./stakelane report sidecar/evidence/hardening/full-1 --verify
./stakelane report sidecar/evidence/hardening/repeat-8 --verify
```

Verify file checksums from this directory :

```sh
sha256sum -c SHA256SUMS
```

Hashes detect accidental changes relative to this manifest; they are not third-party attestations. The report verifier independently recomputes summaries from saved trials and checks input/build consistency; it cannot authenticate historical execution without replaying or otherwise validating chain evidence.

See `environment.json` for host metadata collected after the first run, [method and results](../../../docs/HARDENING_VALIDATION.md), and [operator instructions](../../../docs/OPERATOR.md). Timing excludes setup, signatures and mining. Periodic revalidation is deferred during initial admission timing and restored before mining. Shared-path bounds are separately regression-tested; these experiments do not benchmark continuous mixed estimate/maintenance traffic.

Runtime logs, Engine JWTs and participant private keys are deliberately excluded. Only fixture/public transaction observations and metadata are retained. Do not fund test identities on another network.
