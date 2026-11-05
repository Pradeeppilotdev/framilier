# Public devnet test record

Recorded on **6 November 2026, India time**. Evidence timestamps use UTC and therefore show 5 November for this run. This is a historical observation of a resettable devnet.

## Finding

The tested primary sidecar enforced:

```text
declared validation-prefix execution gas + signature-verification costs <= 100000
```

The same wallet succeeded at a 70,000-gas declared VERIFY allowance and was rejected at 500,001, both before and after staking. The high-budget error was:

```text
validation prefix execution gas sum 500001 + signature-verification cost 2800 = 502801 exceeds MAX_VERIFY_GAS 100000
```

The admission report identifies the failed check as `structure`, with RPC code `-32602`. The larger cases were rejected before the later simulation and execution checks. These results do not establish the behavior of every EIP-8141 implementation.

## Environment

| Component | Recorded value |
| --- | --- |
| Chain ID | `1337` |
| Successful sidecar endpoint | `https://altmempool.forshtat.com/rpc` |
| Initial workshop gateway | `https://altmempoolgateway.forshtat.com/rpc` |
| Sidecar version response | `skandha/v4.1.1-` (no precise source revision exposed) |
| Execution client | `ethrex/v23.0.0-eip8141-tracer-9aa3645d795945c64400f41a70aace0edfa7f383/x86_64-unknown-linux-gnu/rustc-v1.93.1` |
| Workshop revision | `bcfe02a196ca97b6fb0d1044db9d0b4c673831fc` |
| Participant | `0x82C805924fbf9Ba95c5Eb0F15Cbaa40912eBCb4F` |
| Test wallet | `0x259bb3f281da40f23a54d0e1d76883caff89b568` |
| Staking registry | `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` |
| Wallet stake / delay | `0.012` devnet ETH / `86400` seconds |
| Node minimum stake | `0.01` devnet ETH |
| Final reputation | `OK`; `isStaked: true`; 4 seen / 4 included |

## Method

1. Set up a participant and deploy the upstream workshop's `Foreign` and `ViolatingWallet` contracts.
2. Confirm that the wallet's foreign-storage path is rejected while unstaked.
3. Use the wallet's clean signature-check-and-approve path, with empty VERIFY calldata and a zero-value body call to its existing owner account. Change only the declared VERIFY execution allowance between budget cases and sign the transaction again.
4. Confirm the 70,000 baseline is admitted and mined before submitting a 500,001 candidate.
5. Stake the same wallet, demonstrate that its foreign-storage path now succeeds, and repeat the clean baseline and high-budget comparison.
6. Read the rule-by-rule admission report for each rejected case and preserve receipts for successful transactions.

No public-node administrative methods were used to override reputation or other shared state. The workshop's reputation-burn step was not run.

## Budget cases

| Wallet state | Declared VERIFY gas | Prefix plus signature charge | Admission | Inclusion |
| --- | ---: | ---: | --- | --- |
| Unstaked | 70,000 | 72,800 | Accepted | Mined; both frames succeeded |
| Unstaked | 500,001 | 502,801 | Rejected: combined cap | Not admitted |
| Staked | 70,000 | 72,800 | Accepted | Mined; both frames succeeded |
| Staked | 500,001 | 502,801 | Rejected: combined cap | Not admitted |

The clean VERIFY frame consumed **10,081 gas** in both mined baselines. A large declared allowance does not create a large verification workload. The 1,000,001 case was not submitted because the explicit lower cap was already reproduced.

| Case | Transaction hash |
| --- | --- |
| Unstaked 70,000 baseline | `0xa4d0e092219006ae1ce2f18c700484d24d01eda8aefe7e058110fdc13a1da087` |
| Unstaked 500,001 rejection | `0xb20e67f46be173033532aec0103fb41e56ecd1160904f6852aa6ccd5c24bdc6e` |
| Staked 70,000 baseline | `0x7fdd1fa5027c3505086173565442ff9b18e539f6cdb4c25b35afee333b81b589` |
| Staked 500,001 rejection | `0x05e6c89a3da54e7bc1e58f44704c5ec2953d9e57452bf565196d5c288c6ca8b0` |
| Stake transaction | `0xb79c2ad27ee4e4a194c10136a95293a938ec9912a7099dc36440fb9f7b95b2c8` |
| Staked foreign-storage demonstration | `0x8ac90c1927cbd0c91d20537630fb440eaaa949ba56f3105921f7a89527e2d1c5` |

Use the [devnet explorer](https://explorer.altmempool.wtf/) with the primary sidecar selected. Explorer admission history is held in memory and may disappear; the JSON evidence in this repository preserves the captured results.

## Funding and routing

The workshop's faucet call returned `The faucet is empty`. The public devnet guide described a different, shared-genesis-account funding route. Following the user's direction to use that documented route, one **0.1-devnet-ETH** transfer funded the separate participant. No private key is included in the evidence.

Funding transaction: `0x7b8d87824391915c7b5d5686d5c8d581d66cfbf386cf30c4b5de0ea0f796cd1d`.

The initial gateway admitted the unstaked baseline but returned **zero connected peers**. After 120 seconds there was no receipt, and the primary sidecar had no record of the hash. Submitting the **identical signed transaction** to `https://altmempool.forshtat.com/rpc` led to successful inclusion. Subsequent tests used that endpoint. This was a routing diagnosis, not a gas-budget failure.

For a fresh reproduction, obtain test funds using the currently supported devnet procedure before proceeding. The pinned workshop's faucet flow and the public funding guide differed during this run; the test account is already funded locally and does not need setup repeated.

## Estimation discrepancy

`eth_estimateFrameTransactionGas` returned `Invalid frame transaction signature` for clean candidates that actual admission subsequently accepted and the chain mined. The captured behavior establishes a discrepancy between the estimate and submission paths; its implementation cause was not investigated. Estimate results were not counted as admission evidence.

## Validation and evidence

- TypeScript checking passed with `stakelane_probe.ts` included.
- The upstream workshop suite passed **57 tests in 14 files**. These tests were not newly written for StakeLane.
- The live run used temporary ESM entry-point adapters to pass arguments and collect results without exiting the JavaScript runtime. Signing, transaction encoding, contracts and receipt checks were unchanged.
- The Solidity test suite was not run during this session; the workshop's committed contract artifacts were used for the deployments.

| Evidence file | Contents |
| --- | --- |
| `stakelane-probe/live-test-result.json` | Consolidated result, versions, four budget cases and limitations |
| `stakelane-probe/budget-results.json` | Probe outputs, including the initial gateway wait and eventual primary inclusion |
| `stakelane-probe/workshop-live-results.json` | Storage controls, staking and admission-debug results |
| `stakelane-probe/baseline-reroute.json` | Identical baseline resubmission and receipt |
| `stakelane-probe/routing-diagnostics.json` | Gateway peers and primary-sidecar checks |
| `stakelane-probe/funding-result.json` | The single participant-funding transfer and receipt |
| `stakelane-probe/final-checks.json` | Final stake/reputation context, balances, nonce and client version |
| `stakelane-probe/runtime-adapter-notes.json` | Runtime adapter and endpoint changes |

## Outstanding work

Per-entity accounting, repeated-entity attribution, cross-entity isolation, genuine expensive verification and a compatible inclusion route for a modified sidecar are future work. This initial version proves the observed combined cap and provides a baseline for that implementation.
