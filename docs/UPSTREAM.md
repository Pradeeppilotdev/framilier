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

The local archive is not a Git clone, so its directory has no upstream Git HEAD. Its source revision is recorded separately; a fresh reproduction should use the pinned checkout described in the root README.

## Sidecar and specification context

The tested service is the [ERC-8421 Mempool Sidecar](https://github.com/forshtat/mempool-workshop-sidecar). The workshop documents that its implemented rules derive from an earlier EIP-8141 rule proposal and are not identical to later ERC-8421 drafts. The observed 100,000-gas combined cap is a finding about this deployment.

No sidecar source patch is included in this initial checkpoint. A future implementation must pin both its specification revision and configuration instead of treating a larger constant as per-entity accounting.
