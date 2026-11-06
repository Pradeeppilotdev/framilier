# Changelog

## Unreleased — admission hardening

- Share bounded simulation capacity across admission, estimates and maintenance.
- Bound sender backlogs and coalesce duplicate RPC/gossip admissions before simulation.
- Preserve pending entries when revalidation infrastructure fails.
- Correct transient storage write aggregation and validation.
- Recover public submission journals using identical signed bytes after observation.
- Add operator doctor, quick/full presets, output/JSON options and verified offline reports.
- Document the private-chain setup and the operator demo.
- Current verification and experiments: [hardening validation](docs/HARDENING_VALIDATION.md).

## Public 1M admission — 2026-11-06

- Deployed the hash-chain wallet on the replacement devnet, mined its 0.012 test ETH stake and sent one 1M hash-chain workload through the organizers' primary sidecar. Preserved the admission, four relay attempts, final cancellation and successful 993,512-gas execution simulation. [Public test record](docs/SIDECAR.md#updated-public-devnet-on-6-november-2026)
- Added a public runner that can observe the same signed hashes across restarts. Reused the private runner's witness and signing code and reproduced its mined 993,512-gas VERIFY receipt locally.

## Private two-wallet benchmark — 2026-11-06

- Added the matched hash-chain workload control. Across two fresh chains the independent probe's median admission time was about 11 ms idle, 44–48 ms with four late failures and 129 ms with four correct witnesses. All 96 expensive valid submissions mined. The 96 late failures generated no increase in the submitting wallet's normal `seen` counter. [Matched trial results](docs/BUILDER_BENCHMARK.md#matched-hash-chain-workloads)
- Added a bounded admission benchmark with an independent valid wallet, matched early and late rejections, per-transaction simulation RPC timing, and reputation snapshots. The private fixture blocks ethrex's automatic release lookup locally.
- Recorded two runs. Four late failures increased median valid-wallet admission to 46.874 and 47.280 ms. The noisy wallet's seen counter stayed at 2, and all 72 measured valid transactions mined. [Report and reproduction](docs/BUILDER_BENCHMARK.md)

## StakeLane sidecar — 2026-11-06 (India time)

- Mined the exact 1,000,000-gas declaration on a private ethrex chain. The staked wallet used 993,512 execution gas to verify a 9,664-step hash chain in block 5. The run includes on-chain stake registration, an unstaked rejection, the one-gas-over rejection and an incorrect-witness rejection. [Mined receipt](sidecar/evidence/private-inclusion.json)

- Implemented per-address verification budgets. An eligible staked contract gets 1,000,000 gas and an unstaked address gets 100,000. Sender signatures and repeated roles consume the same address’s allowance.
- Integrated the budget check ahead of traced simulation and exposed individual charges through `BUDGET-010` in the admission report.
- Added 30 budget cases. The build, 412 executor tests and 31 explorer logic tests passed.
- Captured live acceptance at exactly 1,000,000 declared gas and rejection at 1,000,001. The ordinary public execution-node route rejected the accepted bytes under its separate canonical cap. [Evidence and reproduction](docs/SIDECAR.md)

## Initial checkpoint — 2026-11-06 (India time)

### Added

- A bounded TypeScript probe for declared VERIFY execution allowances from 70,000 to 1,100,000 gas. It estimates by default and requires `--submit` for one transaction.
- Checks for chain 1337, the recorded participant, deployed wallet code and ownership, plus stake, nonce, balance and receipt reporting.
- Public devnet evidence for the same wallet before and after staking: successful 70,000-gas baselines and rejected 500,001-gas allowances.
- Root project documentation, a detailed test record and upstream provenance.
- Git ignore rules for the downloaded workshop, private state, credentials, dependencies, compiled adapters, local caches and archives.

### Configuration and test setup

- Used workshop revision `bcfe02a196ca97b6fb0d1044db9d0b4c673831fc` with its locked dependencies and committed contract artifacts.
- Funded a separate participant with one documented 0.1-devnet-ETH shared-account transfer after the faucet reported that it was empty. No funding key is included in the repository.
- Switched the local workshop endpoint from `https://altmempoolgateway.forshtat.com/rpc` to `https://altmempool.forshtat.com/rpc`. The original gateway had zero peers; resubmitting the identical baseline transaction through the documented primary sidecar led to inclusion.
- Deployed the upstream `Foreign` and `ViolatingWallet` contracts and staked the wallet with 0.012 devnet ETH and an 86,400-second delay. Its final recorded reputation was `OK` and its stake was recognized.

### Verified

- TypeScript checking, including the probe, passed.
- The upstream suite passed: 57 tests in 14 files.
- Both 70,000-gas declared-allowance cases were admitted and mined with successful frames.
- Both 500,001-gas cases failed the structural combined-budget check: `500001 + 2800 = 502801 > 100000`.
- Foreign-storage access was rejected before staking and accepted and mined after staking.
- The gas estimator returned a signature error for clean transactions that actual admission accepted and the chain later mined. Estimate responses were kept distinct from admission results.

### Open at the initial public checkpoint

- A sidecar patch implementing per-entity budgets and a supported inclusion route for its transactions.
- Real expensive-verification workloads, multi-entity isolation and a StakeLane conformance suite.
- A 1,000,001-gas probe, which was not submitted after the explicit lower cap was established.

The imported workshop's contracts, codec, staking implementation and 57 tests are upstream work. This checkpoint does not modify the deployed sidecar or implement the new accounting rule.
