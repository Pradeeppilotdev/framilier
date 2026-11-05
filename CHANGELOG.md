# Changelog

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

### Still outstanding

- A sidecar patch implementing per-entity budgets and a supported inclusion route for its transactions.
- Real expensive-verification workloads, multi-entity isolation and a StakeLane conformance suite.
- A 1,000,001-gas probe, which was not submitted after the explicit lower cap was established.

The imported workshop's contracts, codec, staking implementation and 57 tests are upstream work. This checkpoint does not modify the deployed sidecar or implement the new accounting rule.
