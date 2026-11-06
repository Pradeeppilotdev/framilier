# Upstream provenance

## Workshop dependency

| Item | Recorded value |
| --- | --- |
| Repository | https://github.com/forshtat/mempool-workshop |
| Revision | `bcfe02a196ca97b6fb0d1044db9d0b4c673831fc` |
| Local directory | `mempool-workshop/` (ignored by Git) |
| Acquisition used for this run | Pinned GitHub source archive |
| Transaction library | `@forshtat/hegota-support` version `0.0.1`, from the upstream lockfile |

The workshop provides the contracts and precompiled artifacts, transaction codec and builders, RPC helpers, state management, staking workflow, explorer helpers and automated tests. These components remain upstream work; they are not claimed as StakeLane implementation.

## StakeLane additions and local changes

- The canonical probe is `stakelane-probe/stakelane_probe.ts`; a copy was placed at `mempool-workshop/src/steps/stakelane_probe.ts` to use the workshop's imports.
- The local `gatewayUrl` was changed to `https://altmempool.forshtat.com/rpc` after diagnosing the workshop gateway's lack of peers.
- Temporary compiled adapters allowed the upstream steps to run in the network-capable JavaScript runtime used for the experiment. They passed arguments explicitly and returned results instead of exiting the process. The source CLI commands remain the reproduction interface. Adapter details are recorded in `stakelane-probe/runtime-adapter-notes.json`; `.runtime/` is excluded from Git.
- StakeLane records public test evidence and explains its limitations in `docs/TEST_RESULTS.md`.

The ignored `mempool-workshop/` dependency came from a source archive. The top-level StakeLane project is a Git repository. Its initial published checkpoint, `7c9594f`, records the original public workshop tests.

## Sidecar and specification context

The tested service is the [ERC-8421 Mempool Sidecar](https://github.com/forshtat/mempool-workshop-sidecar). The workshop documents that its implemented rules derive from an earlier EIP-8141 rule proposal and are not identical to later ERC-8421 drafts. The observed 100,000-gas combined cap is a finding about this deployment.

The current `sidecar/` directory includes the upstream runtime and tests from [sidecar revision 2e22ff0](https://github.com/forshtat/mempool-workshop-sidecar/tree/2e22ff0a2898e69ea4bf5275bce1be8581a8582a). StakeLane implements per-address accounting against [ERC-8421 draft revision 493ba8a](https://github.com/forshtat/ERCs/blob/493ba8ac3be97dc5cf6335eb97d2e8e9f95983c5/ERCS/erc-8421.md). The upstream license is in `sidecar/LICENSE`.

## Fork inventory on 6 November 2026 (checkpoint ddfcfd5)

A byte comparison of the 583 Git-visible files under `sidecar/` with the source archive at `2e22ff0` found 546 identical files, 10 modified upstream files and 27 paths added to the snapshot. Some added paths carry upstream fixtures, including the registry and ethrex genesis. The upstream archive contains 105 additional paths omitted from this source distribution, chiefly deployment and CI files. The upstream MIT license matches byte for byte.

The ten modified upstream files cover README, package scripts and ignore rules, the explorer rule definition, executor wiring, simulation service and its test, validation-prefix rules, the frame validator and explorer types. The budget ledger, its tests, the hash-chain workload and benchmark runners can be reviewed separately. [Ledger](../sidecar/packages/executor/src/services/UserOpValidation/utils/validationBudget.ts) · [Admission benchmark](BUILDER_BENCHMARK.md)

For a baseline import PR, start from the published StakeLane checkpoint and import the selected upstream paths using their original bytes and license. Identify the upstream SHA and exclusions in the commit. Layer the actual budget changes and tests, then the fixture and recorded experiments, in reviewable commits. Each subsequent contributor owns their real feature, test or reproduction PR.

The original sidecar includes two deliberately published fixture private keys in `test/e2e/helpers.ts`. That file matches the pinned upstream bytes. The project's own participant signing key belongs in the ignored workshop state, and the private execution node's credentials belong under the ignored runtime directory.
