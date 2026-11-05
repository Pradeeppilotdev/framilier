StakeLane: first devnet budget check

LIVE TEST UPDATE — 6 November 2026 (India time)
The pinned workshop dependencies are installed in ../mempool-workshop. TypeScript
checking passed with this probe included; all 57 upstream tests in 14 files passed.
Live testing now confirms a combined 100,000 validation-gas cap on the primary
public sidecar. Both unstaked and staked 70,000 declared-VERIFY transactions were
mined with successful frames. Both 500,001 cases were rejected before simulation:
500001 execution + 2800 signature cost = 502801 exceeds MAX_VERIFY_GAS 100000.
The wallet had 0.012 ETH stake, an 86400-second delay and OK reputation. The
workshop's staked foreign-storage transaction also mined successfully.
The 1,000,001 case was not submitted because the explicit lower cap was established.
Actual VERIFY work was only 10,081 gas in each clean baseline. These results do not
establish expensive-verification performance or per-entity budget isolation.

The faucet was empty. Following the public devnet funding guide supplied by the
user, one 0.1-devnet-ETH transfer funded our participant from the published shared
account. The initial workshop gateway had zero connected peers; it admitted the
baseline but did not deliver it to the primary sidecar. Sending that exact same
transaction to https://altmempool.forshtat.com/rpc led to inclusion. Both local
configuration copies now use that documented primary endpoint.
The estimator returned a signature error even for clean transactions that actual
admission accepted and the chain mined; estimates were not treated as verdicts.
See live-test-result.json and the evidence JSON files for hashes and receipts.

The funded participant and deployed-wallet state are preserved privately in the
workshop folder. Do NOT rerun step_1_check: it resets recorded deployed addresses.
Never share .workshop-state.json. Fresh-checkout instructions below are historical
setup instructions; existing-state work resumes with the current wallet.
The source was downloaded as a pinned archive, so it has no git HEAD; the pinned
revision is recorded in ../mempool-workshop/.stakelane-source.json.

ORIGINAL ARCHIVE PREPARATION RECORD
Prepared 6 November 2026 (India time). The live RPC connection from the research
environment timed out at proxy CONNECT, before any node response. No transaction,
simulation, deployment, funding or staking was completed from this environment.
The probe passed a TypeScript transformation/syntax check and six control-flow
checks with RPC, signing and workshop dependencies mocked: estimate-only mode,
single submission with receipt, rejected submission, transport failure before
submission, wrong-chain refusal, and excessive-budget refusal. It was NOT run
against installed workshop dependencies or the devnet. It is a research helper,
not a tested product.

PURPOSE
Check the easiest existing-devnet path before modifying the sidecar or running a
private devnet. This changes the DECLARED VERIFY-frame allowance of the official
workshop wallet, signs again, and optionally submits exactly ONE transaction.
Actual validation work stays small and constant. Acceptance of a large declared
allowance is not proof that equally expensive validation can run successfully.
No stress testing, debug/admin mutations, or repeated submission loops are used.

SETUP (fresh checkout; Node >=20.12 and Yarn 1)
git clone https://github.com/forshtat/mempool-workshop.git
cd mempool-workshop
git checkout bcfe02a196ca97b6fb0d1044db9d0b4c673831fc
yarn install --frozen-lockfile

Copy stakelane_probe.ts from this archive to src/steps/stakelane_probe.ts.
Read the workshop README.md and AGENTS.md. If the mentors provide a newer tested
revision, use it instead and check compatibility. The script records git HEAD.

Create your own throwaway devnet participant and the workshop wallet:
yarn step_1_check
yarn step_6_tx_violating_canonical

Step 6 deploys the participant's ViolatingWallet and intentionally gets a
storage-violating transaction rejected by the canonical mempool. Our probe uses
that same wallet's CLEAN path (empty verification calldata), which does not make
the foreign-storage read. This isolates gas-budget behaviour from storage rules.
Do not rerun step_1_check in an existing workshop checkout casually: it resets
recorded addresses and step completion state. Never publish .workshop-state.json.

FIRST CONTROL: UNSTAKED, SMALL ALLOWANCE
yarn tsx src/steps/stakelane_probe.ts --budget 70000
This estimates only. It neither submits nor proves admission.
Then submit one low-cost baseline and confirm its receipt:
yarn tsx src/steps/stakelane_probe.ts --budget 70000 --submit

ONLY IF THAT BASELINE WORKS, test a larger declared allowance:
yarn tsx src/steps/stakelane_probe.ts --budget 500001 --submit
Read the result before another invocation. If it is admitted but stays pending,
STOP and use step_11_debug; do not accumulate pending transactions.

STAKED COMPARISON: SAME WALLET
Use the official commands to stake and establish the expected clean baseline:
yarn step_7_stake
yarn step_8_tx_violating_alt
yarn tsx src/steps/stakelane_probe.ts --budget 70000 --submit
yarn tsx src/steps/stakelane_probe.ts --budget 500001 --submit

Run those commands individually, examining each result. Step 8 checks the
workshop's original staked storage-access demonstration; it is not a high-gas
verification test. Do not run the workshop's reputation-burn step for this work.

OPTIONAL FOLLOW-UP BUDGETS, ONE AT A TIME
100001, 499999, 999999, 1000001
Use only values relevant to the observed rejection/acceptance and the mentor's
target revision. The script bounds its input at 1100000. A signature's intrinsic
validation cost can be added to the displayed VERIFY budget, so these numbers
are not exact total-prefix thresholds. Stop escalating once a clear cap or a
non-budget error is found. Increasing a limit is not an implementation fix.

RESULT INTERPRETATION
ESTIMATE_ONLY_NOT_ADMISSION: only an estimate; no sidecar admission decision.
RPC_REJECTION_INSPECT_ERROR: inspect code/message; it might be budget, nonce,
solvency, stake, reputation, trace availability or a different rule.
SUBMISSION_OUTCOME_UNKNOWN_TRANSPORT_FAILURE: check candidate hash before retry.
ADMITTED_NO_RECEIPT_WITHIN_120_SECONDS: admitted, not confirmed mined. Investigate
propagation/mining before sending another probe.
MINED_ALL_FRAMES_SUCCEEDED: one low-cost transaction with that declared allowance
made it through admission and inclusion; it still does not prove real 500k/1M
verification work, nor separate budgets for multiple entities.

Save output to a file using shell redirection if desired. The script does not
print the participant key or the signed transaction. Registry stake is reported
but node minimums and reputation must also be checked before declaring an entity
eligible for a staked allowance. web3_clientVersion at the gateway identifies the
sidecar; ask the mentors for the execution-client revision too.

NEXT DECISION
If large allowances already work: test meaningful expensive verification and
separate-entity isolation before claiming an implementation gap.
If an appropriate staked transaction is rejected by an old combined budget:
implement the pinned per-entity rule and establish a supported mining route.
If actual simulation/execution is unsupported: ask for the right event endpoint
or a mentor-supported local setup. A sidecar cannot override consensus validity.

PRIMARY SOURCES
https://github.com/forshtat/mempool-workshop
https://docs.altmempool.wtf/reference/rpc-methods/
https://docs.altmempool.wtf/rules/budget/
https://docs.altmempool.wtf/concepts/entities-and-stake/
