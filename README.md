# StakeLane

StakeLane is a research prototype for verification-budget accounting in EIP-8141 alternative mempools. This initial version contains a bounded budget probe and evidence from the public devnet. **Per-entity budget accounting has not been implemented yet.**

## Current result

On 6 November 2026 (India time), the tested public sidecar enforced a **100,000-gas combined validation-prefix cap**, including signature-verification costs.

| Declared VERIFY execution allowance | Unstaked wallet | Staked wallet |
| --- | --- | --- |
| 70,000 | Admitted and mined; both frames succeeded | Admitted and mined; both frames succeeded |
| 500,001 | Rejected by the combined budget check | Rejected by the combined budget check |

The high-budget rejection was `500001 + 2800 signature cost = 502801 > MAX_VERIFY_GAS 100000`. Staking successfully relaxed the foreign-storage rule, but did not raise this deployment's budget cap. Each clean baseline actually used **10,081 gas in its VERIFY frame**: these are declared-allowance tests, not expensive-verification benchmarks.

See [the full test record](docs/TEST_RESULTS.md), [machine-readable results](stakelane-probe/live-test-result.json), and [the changelog](CHANGELOG.md).

## What is in this repository

- `stakelane-probe/stakelane_probe.ts`: StakeLane's single-transaction budget probe; estimate-only by default.
- `stakelane-probe/*.json`: public transaction receipts, rejection reports and setup diagnostics from the test run.
- `docs/TEST_RESULTS.md`: methodology, transaction hashes, findings and outstanding work.
- `docs/UPSTREAM.md`: the pinned upstream source and the boundary between upstream work and StakeLane changes.

The upstream workshop is a local dependency in `mempool-workshop/`; it is excluded from Git. Dependencies, compiled adapters, private participant state and ZIP checkpoints are also excluded. The initial commit contains the probe and evidence, not a sidecar implementation.

## Set up a fresh checkout

The workshop requires Node.js 20.12 or newer and Yarn 1. This run used Node.js 26.12.1 and Yarn 1.22.22.

From the StakeLane project root, on a fresh checkout without a `mempool-workshop/` directory:

```sh
git clone https://github.com/forshtat/mempool-workshop.git mempool-workshop
git -C mempool-workshop checkout bcfe02a196ca97b6fb0d1044db9d0b4c673831fc
cd mempool-workshop
yarn install --frozen-lockfile
cp ../stakelane-probe/stakelane_probe.ts src/steps/stakelane_probe.ts
```

Read the upstream `README.md` and `AGENTS.md`. Set `gatewayUrl` in `mempool-workshop/workshop.config.json5` to the endpoint that successfully relayed this run:

```text
https://altmempool.forshtat.com/rpc
```

The recorded test network is chain **1337**. Endpoints and deployments may change when this demonstration network resets. Funding was a separate prerequisite; see the [recorded funding and routing issues](docs/TEST_RESULTS.md#funding-and-routing).

## Reproduce the checks

Run each command individually from `mempool-workshop/` and inspect its result before proceeding. On an existing configured workshop, **do not rerun `step_1_check`**: it resets the recorded deployed addresses and completed steps while retaining the participant key.

For a fresh participant, first complete setup and deploy the workshop's test wallet:

```sh
yarn step_1_check --json
yarn step_6_tx_violating_canonical --json
```

Step 6 intentionally submits a foreign-storage-access transaction that should be rejected while unstaked. The StakeLane probe uses that wallet's clean validation path instead.

Run the unstaked baseline, then the larger allowance only after the baseline is mined successfully:

```sh
yarn tsx src/steps/stakelane_probe.ts --budget 70000
yarn tsx src/steps/stakelane_probe.ts --budget 70000 --submit
yarn tsx src/steps/stakelane_probe.ts --budget 500001 --submit
```

For the staked comparison, use the same wallet:

```sh
yarn step_7_stake --json
yarn step_8_tx_violating_alt --json
yarn tsx src/steps/stakelane_probe.ts --budget 70000 --submit
yarn tsx src/steps/stakelane_probe.ts --budget 500001 --submit
```

`--submit` submits exactly one candidate. A rejected budget probe exits with code 2; inspect the error and run `yarn step_11_debug <transaction-hash> --json` for its admission report. If a transaction remains pending, investigate that hash before submitting another probe. The documented run stopped after reproducing the explicit cap; it did not submit a 1,000,001-gas case or run the workshop's reputation-burn step.

## Validation performed

```sh
yarn typecheck
yarn test
```

TypeScript checking passed with the probe included. **57 upstream tests across 14 files passed.** These are the workshop's tests, not a new StakeLane conformance suite. The live cases are recorded separately in the evidence files.

## Next implementation milestone

Pin the intended specification and budget constants, implement per-entity attribution in a sidecar, and demonstrate correct admission and inclusion. Add cases for distinct entities, repeated roles held by one entity, signature costs, and an unstaked entity alongside a staked one. Actual expensive validation and isolation between entity budgets remain untested.
