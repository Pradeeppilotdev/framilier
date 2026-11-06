# StakeLane sidecar

## Current operator workflow

See [the operator guide](OPERATOR.md) for dependency checks, quick/full comparisons, offline reports, shared simulation limits and recovery behavior. See [hardening validation](HARDENING_VALIDATION.md) for the contributor’s Linux run and the Mac review checks. The records below describe the earlier checkpoints.

## Budget accounting

StakeLane implements the per-entity rule `BUDGET-010` from ERC-8421 draft revision `493ba8a`. The ledger charges each validation frame’s declared execution gas to its sender, payer or factory. A pre-verification frame belongs to the entity it prepares. Intrinsic signature cost belongs to the sender. An address appearing in multiple roles shares one allowance. The table uses that pinned draft's constants. The workshop documentation also records a landing-page proposal of 250,000 and 2,500,000. [Pinned draft](https://github.com/forshtat/ERCs/blob/493ba8ac3be97dc5cf6335eb97d2e8e9f95983c5/ERCS/erc-8421.md) · [Workshop budget notes](https://docs.altmempool.wtf/rules/budget/)

| Address | Total validation allowance | Self-paying wallet with one secp256k1 signature |
| --- | ---: | ---: |
| Unstaked or default-code account | 100,000 | 97,200 execution + 2,800 signature |
| Eligible staked contract | 1,000,000 | 997,200 execution + 2,800 signature |

The example requires a locked deposit of at least 0.01 devnet ETH, an 86,400-second unstake delay, deployed code and a successful stake check. A pending withdrawal removes eligibility. The sidecar checks the limits before requesting an execution trace. A leading protocol expiry verifier has a separate local 100,000-gas bound. The whole-transaction gas ceiling and payer solvency checks still apply.

## Admission scheduling

The executor shares one admission scheduler across RPC, peer gossip and peer sync. `schedulerMode` defaults to `off`. Use `fifo` for a bounded first-come-first-served queue or `fair` to rotate between waiting sender addresses. Only fair mode limits simultaneous heavy requests from each sender.

```json
{"schedulerMode":"fair","schedulerSlots":4,"schedulerMaxHeavyPerSender":2,"schedulerMaxWaiting":64,"schedulerHeavyThreshold":100000}
```

A request is heavy when its total declared verification budget exceeds the threshold. The scheduler counts all roles, signature cost and the separate expiry allowance. The existing validator enforces stake eligibility and validity. When the waiting queue fills, a request that needs to wait gets a retryable server error. An eligible sender can still use a free slot. Users of the same sending contract share a turn.

Read `skandha_config.admissionScheduler` to see the active instance’s `mode`, `slots`, `maxHeavyPerSender`, `maxWaiting` and `heavyThreshold`.

## Updated public devnet on 6 November 2026

The organizers' primary sidecar admitted one StakeLane hash-chain workload on replacement chain `1337`. The participant started with 1 test ETH. Its wallet deployed with 0.02 test ETH in block 959. Its 0.012 test ETH stake mined in block 966 with an 86,400-second withdrawal delay. [Exact relay events and diagnostic](PUBLIC_RELAY_REPORT.md)

| Observation | Result |
| --- | --- |
| Hash-chain workload sent to the organizers' sidecar | 997,200 declared VERIFY execution gas + 2,800 signature gas |
| Public admission | All recorded checks passed. The explorer recorded one admission, four submissions by the sidecar and a final drop. |
| Public inclusion | The sidecar reported `Cancelled` after four relay attempts. The execution receipt was null. |
| Public execution simulation of the identical bytes | Both frames succeeded. VERIFY used 993,512 gas. The execution node also reported a canonical mempool limit of 100,000. |
| Local inclusion using the same wallet code and witness | Both frames succeeded in a mined transaction. The receipt recorded 993,512 VERIFY gas. |

The public RPC exposes the simulation result and the relay history. Establishing why the public builder omitted this transaction would require additional relay or builder evidence. The restored devnet provides a public admission record. The local chain provides the mined high-budget receipt and the controlled scheduling experiments.

The transaction Alex shared mined in canonical public block **913**, before our wallet deployment. Its VERIFY frame declared **2,000,000** execution gas and the receipt recorded **100** gas used in that frame. The whole transaction used 26,102 gas. This demonstrates that a high declaration can land on the updated devnet. The 993,512-gas workload above measures the separate cost of actually running expensive verification. [Organizer's example](https://explorer.altmempool.wtf/tx/0x28f5671f4fd42689c70bd8e0850f5b237f7d31416f3eb6a7b39d43a74af558a4)

[Public explorer admission](https://explorer.altmempool.wtf/tx/0x89d35f0f123f0ae0bca2f6775ecb6b0e46a168cc351aa8095be12a319b109e2a?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) · [Public stake transaction](https://explorer.altmempool.wtf/tx/0x93cdd6fe08f4523b84f05a0a07fb7f643d4cdc47cf3d675efca8f59455469651?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) · [Saved receipts, admission, lifecycle and simulation](../sidecar/evidence/public-admission-1337.json) · [Public test runner](../sidecar/test/stakelane/public-inclusion.mjs)

To recheck the recorded run in the prepared checkout, run this from `sidecar/`. Observe mode follows the saved hashes. Exit status 2 indicates the workload reached a terminal sidecar status without a public receipt.

```sh
node test/stakelane/public-inclusion.mjs --observe 0x2ad3f67b059fbde111ad7af27cfb4955d997351579612237ca0318937a5bae7a
```

A fresh run uses `--submit` with a freshly verified public genesis hash and a funded workshop participant. The runner uses a separate per-network transaction journal, the organizers' normal frame submission method and the same signer implementation and witness as the private test.

## Earlier public devnet experiment

The local sidecar used the test wallet's actual deposit of 0.012 devnet ETH. A clean probe received local admission at 1,000,000 total declared gas. The ordinary execution RPC rejected the same signed bytes with code `-32000` and its canonical `MAX_VERIFY_GAS` message. At 1,000,001, StakeLane itself rejected the transaction under `BUDGET-010`. These two signed probes used the wallet's inexpensive clean path.

- [Exact-limit admission and ordinary relay result](../sidecar/evidence/staked-at-limit.json)
- [One-gas-over rejection](../sidecar/evidence/staked-over-limit.json)
- [Historical public-sidecar baseline](TEST_RESULTS.md)

## Run locally

From the project root, start the sidecar with Bun. This command binds to loopback and uses manual bundling.

```sh
cd sidecar
bun install --frozen-lockfile
bun run build
bun run start:stakelane
```

From a second terminal, use a funded workshop participant and a configured staked wallet on chain 1337. See the [setup instructions](../README.md#set-up-a-fresh-checkout).

```sh
cd mempool-workshop
cp ../stakelane-probe/stakelane_probe.ts src/steps/stakelane_probe.ts
node --import tsx src/steps/stakelane_probe.ts --rpc http://127.0.0.1:14337/rpc/ --budget 997201 --submit --admission-only
node --import tsx src/steps/stakelane_probe.ts --rpc http://127.0.0.1:14337/rpc/ --budget 997200 --submit --relay-raw
```

The first command should exit with code 2 and a budget rejection. The second exercises the ordinary raw-transaction relay after successful local admission. Use `--admission-only` for a local admission check. A block receipt is the inclusion criterion.

## Implementation and tests

The builder admission benchmark measures how one staked wallet's submissions delay another wallet. It compares late failures with early failures and with valid transactions that run the same 9,664 hashes. Each comparison ran on two fresh private chains. [Method, results and reproduction](BUILDER_BENCHMARK.md)

- [Budget ledger](../sidecar/packages/executor/src/services/UserOpValidation/utils/validationBudget.ts)
- [Stake checks and admission](../sidecar/packages/executor/src/services/UserOpValidation/validators/frameTx.ts)
- [Boundary and isolation tests](../sidecar/packages/executor/test/services/UserOpValidation/validationBudget.test.ts)

From `sidecar/`, run `bun run test:stakelane`. At the earlier recorded checkpoint, the build and 412 executor tests passed, including 30 budget cases. The explorer logic suite passed 31 tests.

## Private block inclusion

On 6 November 2026, a StakeLane sidecar relayed a signed frame transaction to its own Hegota ethrex producer on isolated chain `8141337`. The wallet hashed the 32-byte witness 9,664 times with Keccak-256, checked the resulting digest against its immutable commitment, and approved the transaction. Its VERIFY frame consumed **993,512 gas**. Both frames succeeded in canonical block 5.

| Case | Result |
| --- | --- |
| Same wallet before staking, 1,000,000 total declared gas | Rejected with a 100,000 limit |
| Same wallet after staking 0.012 ETH, 86,400-second delay, 1,000,001 total declared gas | Rejected with a 1,000,000 limit |
| Eligible staked wallet, 1,000,000 total declared gas, incorrect witness | Validation frame 0 reverted with `wrong witness` |
| Eligible staked wallet, 1,000,000 total declared gas, correct witness | Mined with 993,512 VERIFY gas used |

The producer built a payload with `engine_getPayloadV6`, imported it through `engine_newPayloadV6` with status `VALID`, and selected the head through `engine_forkchoiceUpdatedV5`. The test then read the receipt and the canonical block by number, checked their hashes, verified transaction membership and checked both frame statuses. It used an execution-layer test driver on loopback. The public devnet result above remains a separate experiment.

- [Mined transaction, raw signed bytes, receipt, block and negative controls](../sidecar/evidence/private-inclusion.json)
- [Independent repeat from a clean copy of the Git-visible sources](../sidecar/evidence/private-inclusion-repeat.json)
- [Earlier 8,192-round run using a fixed-round wallet and 843,360 VERIFY gas](../sidecar/evidence/private-inclusion-8192.json)
- [Wallet source](../sidecar/test/stakelane/HashChainWallet.sol)
- [Test driver](../sidecar/test/stakelane/run.mjs)

### Reproduce the mined transaction

In the prepared local checkout, the tested binaries are available under the Git-ignored `sidecar/.runtime/bin/` directory. Run the test again from `sidecar/`.

```sh
node test/stakelane/run.mjs
```

For a fresh checkout, use the upstream execution client at commit `9aa3645d795945c64400f41a70aace0edfa7f383`. This run used Rust 1.93.1 and the unmodified ethrex source. On a machine with the Rust toolchain and native build prerequisites installed, build the binary in a separate directory.

```sh
git clone https://github.com/forshtat/ethrex.git ethrex-stakelane
cd ethrex-stakelane
git checkout --detach 9aa3645d795945c64400f41a70aace0edfa7f383
cargo +1.93.1 build --locked -p ethrex --bin ethrex --no-default-features --features rocksdb,c-kzg,secp256k1
```

From `sidecar/`, with Bun and Node available, run the following commands.

```sh
bun install --frozen-lockfile
bun run build
STAKELANE_ETHREX_BIN=/absolute/path/to/ethrex-stakelane/target/debug/ethrex bun run test:inclusion
```

The fixture creates a fresh signing key, funded genesis, staking registry and wallet on each run. It binds ethrex, its authenticated Engine API and the sidecar to loopback, and stops its own processes on completion. By default the report goes to a fresh directory under `.runtime/`. Set `STAKELANE_EVIDENCE` to a chosen output path to keep a report. A fresh run has new addresses and hashes.

The genesis template is the pinned ethrex `fixtures/genesis/l1-hegota.json` with its MIT license alongside it. The runner verifies the template SHA-256 before assigning a private chain ID and funding its ephemeral participant. The registry fixture comes from the pinned workshop sidecar. The wallet and producer driver are StakeLane additions. The checked-in contract artifacts use solc 0.8.28, optimizer runs 200 and Cancun bytecode. To rebuild them, point `STAKELANE_SOLC` at that compiler's npm module and run `node test/stakelane/compile.cjs` from `sidecar/` with the pinned workshop dependencies installed.
