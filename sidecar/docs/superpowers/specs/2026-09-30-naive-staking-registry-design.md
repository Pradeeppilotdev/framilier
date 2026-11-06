# Naive Staking Registry: deploy and configure ERC-8421's IStakingRegistry

**Status:** design, not yet implemented.

## Context & goal

`StakingRegistryService` (`packages/executor/src/services/StakingRegistryService/index.ts`)
is a fully-implemented client for EIP-8141's staking registry — a single
`getDepositInfo(account)` on-chain read — but it has never been pointed at a real contract.
`Executor` constructs it with a hardcoded `AddressZero` placeholder
(`packages/executor/src/executor.ts:122-131`), `NetworkConfig` has no field for a registry
address at all, and no such contract exists anywhere in this repo's devnet fixtures or the
`deploy/predeploy` toolkit. When unconfigured, every entity reads as unstaked — the
reputation-gated storage-access carve-outs and wider gas budgets `FrameTxValidationService`
implements for staked entities have never been exercised against a real chain, only unit-test
mocks.

Goal: deploy a real, naive implementation of ERC-8421's `IStakingRegistry` to the persistent
sidecar devnet (`altmempool.forshtat.com`, the one `deploy/predeploy` already targets), and wire
`NetworkConfig`/`Executor` to point at it, so staking-gated code can be exercised end-to-end by
hand: stake a real entity with real ETH, submit a frame transaction through it, and confirm the
staked-entity carve-outs actually engage.

## The real interface (ERC-8421, formerly referred to by its PR number "2028")

From [ethereum/ERCs#2028](https://github.com/ethereum/ERCs/pull/2028) (`ERCS/erc-8421.md`,
"Frame Transaction Alternative Mempools"):

```solidity
interface IStakingRegistry {
    /// Lock `msg.value` as the caller's stake, with the given unstake delay.
    function addStake(uint32 unstakeDelaySec) external payable;

    /// Begin the withdrawal delay. From this point the caller is not considered to be staked.
    function unlockStake() external;

    /// Withdraw the stake after the delay has passed.
    function withdrawStake(address payable withdrawAddress) external;

    /// Return the stake information.
    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime);
}
```

Relevant constants and rules from the same document:

- `MIN_STAKE_VALUE` (per-chain — "roughly the equivalent of USD 1000 in the native token") and
  `MIN_UNSTAKE_DELAY = 86400` (one day) — the thresholds `[STAKING-010]` checks: "An entity is
  staked if the Staking Registry reports for it a stake of at least `MIN_STAKE_VALUE` and an
  unstake delay of at least `MIN_UNSTAKE_DELAY`, and withdrawal has not been initiated."
- "there are no penalization mechanisms in the alternative mempools protocol and the stake is
  never slashed. It exists only as a configurable mechanism for sybil attack prevention." — a
  faithful implementation of this interface has no slashing to add; "naive" and "complete" are
  nearly the same thing here.
- `withdrawTime == 0` means no withdrawal is pending (mirrors ERC-4337's StakeManager
  convention, which `getDepositInfo`'s exact field names and shape otherwise already match
  precisely).

## Scope

**In scope:**
- A minimal Solidity contract implementing `IStakingRegistry` exactly as specified, with real
  ETH-locking `addStake`/`unlockStake`/`withdrawStake` semantics (no slashing, since the spec has
  none).
- Deploying it once to the persistent devnet via `deploy/predeploy`'s existing `custom`-step
  extension point (the same mechanism `permit2.ts` already uses for a from-scratch CREATE).
- `NetworkConfig`/`config.json`/`executor.ts` wiring so a real deployment address can be
  configured, replacing the hardcoded `AddressZero`.
- A short runbook (in `deploy/devnet/devnet-readme.md`'s existing tester table, matching its
  established style) for manually staking an entity and confirming the carve-outs engage.

**Out of scope:**
- Any change to `StakingRegistryService`, `FrameTxValidationService`, or the staking-gated rules
  themselves — this is purely "give the existing, already-correct client something real to talk
  to."
- An automated e2e test. The target is the persistent devnet (a manual/exploratory testing
  surface, not the ephemeral Docker devnets `test/e2e/*.e2e.test.ts` spin up per run), and a
  meaningful assertion here needs a staked entity actually exercising a carve-out the unstaked
  path would reject — genuinely exploratory, not a fixed scripted scenario. If a scripted e2e
  proof is wanted later, that's its own follow-up.
- Reworking `deploy/predeploy`'s mainnet-replay-only framing/docs beyond adding this one
  from-scratch protocol — the README's "Replays original mainnet deployment transactions..."
  framing stays accurate for every *other* protocol in the registry; this one is simply the
  first exception, following the same escape hatch (`custom` step) `permit2.ts` already uses
  for its own not-quite-a-plain-replay deployment.

## Design

### 1. The contract

`deploy/predeploy/src/contracts/NaiveStakingRegistry.sol` (new file — the toolkit's other
contracts are all fetched mainnet artifacts under `artifacts/`, so this is the first checked-in
Solidity *source* file; it lives in a new `src/contracts/` directory to keep that distinction
visible):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Naive, faithful implementation of ERC-8421's IStakingRegistry -
/// no slashing (the spec itself has none: "there are no penalization
/// mechanisms in the alternative mempools protocol and the stake is never
/// slashed"), no admin, purely per-caller stake bookkeeping. Deployed once
/// to the sidecar devnet so StakingRegistryService/FrameTxValidationService's
/// stake-gated code paths can be exercised against a real on-chain stake
/// instead of the AddressZero placeholder's always-zero short-circuit.
contract NaiveStakingRegistry {
    struct Deposit {
        uint256 stake;
        uint32 unstakeDelaySec;
        uint64 withdrawTime;
    }

    mapping(address => Deposit) private deposits;

    /// Locks msg.value as the caller's stake, adding to any existing stake
    /// (ERC-4337 StakeManager convention). Reverts if unstakeDelaySec would
    /// be lowered - raise it via a later call instead. Clears any pending
    /// withdrawal: adding more stake means you're staked again.
    function addStake(uint32 unstakeDelaySec) external payable {
        Deposit storage d = deposits[msg.sender];
        require(unstakeDelaySec >= d.unstakeDelaySec, "cannot decrease unstake delay");
        d.stake += msg.value;
        d.unstakeDelaySec = unstakeDelaySec;
        d.withdrawTime = 0;
    }

    /// Begins the withdrawal delay. From this point getDepositInfo's
    /// withdrawTime is non-zero, so STAKING-010's "withdrawal has not been
    /// initiated" no longer holds - the caller is not staked anymore.
    function unlockStake() external {
        Deposit storage d = deposits[msg.sender];
        require(d.stake > 0, "no stake");
        require(d.withdrawTime == 0, "already unlocking");
        d.withdrawTime = uint64(block.timestamp) + d.unstakeDelaySec;
    }

    /// Withdraws the full stake once the delay has passed. State is zeroed
    /// before the external call (checks-effects-interactions).
    function withdrawStake(address payable withdrawAddress) external {
        Deposit storage d = deposits[msg.sender];
        require(d.withdrawTime != 0, "not unlocked");
        require(block.timestamp >= d.withdrawTime, "delay not elapsed");
        uint256 amount = d.stake;
        d.stake = 0;
        d.withdrawTime = 0;
        (bool success, ) = withdrawAddress.call{value: amount}("");
        require(success, "withdraw failed");
    }

    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)
    {
        Deposit storage d = deposits[account];
        return (d.stake, d.unstakeDelaySec, d.withdrawTime);
    }
}
```

Design notes:
- `addStake` reverting on a lowered `unstakeDelaySec` (rather than silently keeping the higher
  existing value) mirrors real ERC-4337 StakeManager behavior and is simple to implement either
  way — reverting is more informative for a caller that made a mistake.
- `withdrawStake` pays out via `.call{value}` rather than `.transfer`, so a staked *contract*
  entity (a factory or paymaster — the spec's own examples of staked roles) can withdraw without
  hitting `.transfer`'s 2300-gas stipend limit if its receive logic needs more.
- No access control on any function: each function only ever touches `msg.sender`'s own
  deposit, so there is nothing *to* restrict — this isn't a simplification, it's what the real
  interface already is.

Compiled with the `solc` already present on this machine (`solc --bin --optimize`, pragma
`^0.8.20`, compiled clean with zero warnings against `0.8.37`):

```
6080604052348015600e575f5ffd5b506104eb8061001c5f395ff3fe60806040526004361061003e575f3560e01c80630396cb60146100425780635287ce1214610057578063bb9fe6bf146100dc578063c23a5cea146100f0575b5f5ffd5b61005561005036600461040c565b61010f565b005b348015610062575f5ffd5b506100ae61007136600461044d565b6001600160a01b03165f9081526020819052604090208054600190910154909163ffffffff821691640100000000900467ffffffffffffffff1690565b6040805193845263ffffffff909216602084015267ffffffffffffffff169082015260600160405180910390f35b3480156100e7575f5ffd5b506100556101bb565b3480156100fb575f5ffd5b5061005561010a36600461044d565b61029c565b335f908152602081905260409020600181015463ffffffff90811690831610156101805760405162461bcd60e51b815260206004820152601d60248201527f63616e6e6f7420646563726561736520756e7374616b652064656c617900000060448201526064015b60405180910390fd5b34815f015f828254610192919061047c565b909155505060010180546bffffffffffffffffffffffff191663ffffffff909216919091179055565b335f90815260208190526040902080546102025760405162461bcd60e51b81526020600482015260086024820152676e6f207374616b6560c01b6044820152606401610177565b6001810154640100000000900467ffffffffffffffff161561025a5760405162461bcd60e51b8152602060048201526011602482015270616c726561647920756e6c6f636b696e6760781b6044820152606401610177565b600181015461026f9063ffffffff1642610495565b8160010160046101000a81548167ffffffffffffffff021916908367ffffffffffffffff16021790555050565b335f9081526020819052604081206001810154909164010000000090910467ffffffffffffffff1690036103015760405162461bcd60e51b815260206004820152600c60248201526b1b9bdd081d5b9b1bd8dad95960a21b6044820152606401610177565b6001810154640100000000900467ffffffffffffffff1642101561035b5760405162461bcd60e51b815260206004820152601160248201527019195b185e481b9bdd08195b185c1cd959607a1b6044820152606401610177565b80545f8083556001830180546bffffffffffffffff00000000191690556040516001600160a01b0385169083908381818185875af1925050503d805f81146103be576040519150601f19603f3d011682016040523d82523d5f602084013e6103c3565b606091505b50509050806104065760405162461bcd60e51b815260206004820152600f60248201526e1dda5d1a191c985dc819985a5b1959608a1b6044820152606401610177565b50505050565b5f6020828403121561041c575f5ffd5b813563ffffffff8116811461042f575f5ffd5b9392505050565b6001600160a01b038116811461044a575f5ffd5b50565b5f6020828403121561045d575f5ffd5b813561042f81610436565b634e487b7160e01b5f52601160045260245ffd5b8082018082111561048f5761048f610468565b92915050565b67ffffffffffffffff818116838216019081111561048f5761048f61046856fea264697066735822122075996d6d66fe08537cf131b2eaf8a9e909a5e61995e516e51e095c258391ac9c64736f6c63430008220033
```

ABI:

```json
[{"inputs":[{"internalType":"uint32","name":"unstakeDelaySec","type":"uint32"}],"name":"addStake","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"getDepositInfo","outputs":[{"internalType":"uint256","name":"stake","type":"uint256"},{"internalType":"uint32","name":"unstakeDelaySec","type":"uint32"},{"internalType":"uint64","name":"withdrawTime","type":"uint64"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"unlockStake","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address payable","name":"withdrawAddress","type":"address"}],"name":"withdrawStake","outputs":[],"stateMutability":"nonpayable","type":"function"}]
```

This ABI matches `StakingRegistryService`'s own `STAKING_REGISTRY_ABI` constant exactly for
`getDepositInfo` (the only function the sidecar itself calls) — confirmed field-for-field
(`stake: uint256`, `unstakeDelaySec: uint32`, `withdrawTime: uint64`).

### 2. Deployment

Following `permit2.ts`/`permit2-deployment.ts`'s exact split (a frozen bytecode constant in its
own file, imported by the protocol definition):

`deploy/predeploy/src/protocols/staking-registry-deployment.ts` (new file): a doc comment
explaining this is freshly-compiled bytecode (not a fetched mainnet artifact — there is no
mainnet equivalent), the `solc` version and flags used, and the `STAKING_REGISTRY_INIT_CODE`
constant (the hex above).

`deploy/predeploy/src/protocols/staking-registry.ts` (new file), modeled directly on
`permit2.ts`'s `custom`-step shape:

```typescript
import { encodeFunctionData, parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";
import { STAKING_REGISTRY_INIT_CODE } from "./staking-registry-deployment";

const abi = parseAbi([
  "function getDepositInfo(address account) view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)",
  "function addStake(uint32 unstakeDelaySec) payable",
]);

/** The deploy step's own addStake smoke-test amount/delay - verify() (read-only; see below) checks against these. */
const SMOKE_TEST_STAKE = 10n ** 15n; // 0.001 ETH
const SMOKE_TEST_UNSTAKE_DELAY = 86_400;

/**
 * A naive but faithful implementation of ERC-8421's IStakingRegistry
 * (https://github.com/ethereum/ERCs/pull/2028) - no slashing, since the
 * spec itself has none. Not a mainnet replay (there is no mainnet
 * equivalent): a plain CREATE of freshly-compiled bytecode, the same
 * `custom`-step escape hatch `permit2.ts` already uses for its own
 * not-quite-a-plain-replay deployment.
 */
export default defineProtocol({
  name: "staking-registry",
  dependsOn: [],
  steps: [
    {
      id: "deploy",
      kind: "custom",
      run: async (ctx) => {
        const result = await ctx.send({ to: null, data: STAKING_REGISTRY_INIT_CODE, value: 0n });
        if (!result.contractAddress) throw new Error("staking registry deploy produced no contract address");
        ctx.record("StakingRegistry", result.contractAddress);
        // Smoke-tests the deployed bytecode right here, in the same `run`
        // (the only place this protocol has a write-capable `send`) -
        // `verify()` below only gets a read-only `VerifyContext` (no
        // `send`, confirmed against `types.ts`'s `VerifyContext`/`StepContext`
        // split - every other protocol's `verify` only ever reads too), so
        // it can't perform this call itself; it just reads the result.
        await ctx.send({
          to: result.contractAddress,
          data: encodeFunctionData({ abi, functionName: "addStake", args: [SMOKE_TEST_UNSTAKE_DELAY] }),
          value: SMOKE_TEST_STAKE,
        });
      },
    },
  ],
  async verify(ctx) {
    const registry = ctx.address("StakingRegistry");
    // Proves the deployed bytecode actually implements the interface (not
    // just that something landed at this address) by reading back what the
    // deploy step's own addStake call above should have recorded.
    const [stake, unstakeDelaySec] = (await ctx.read(registry, abi, "getDepositInfo", [ctx.deployer])) as [bigint, number, bigint];
    return [
      equalCheck("deployer stake after deploy-time addStake", stake, SMOKE_TEST_STAKE),
      equalCheck("deployer unstakeDelaySec after deploy-time addStake", unstakeDelaySec, SMOKE_TEST_UNSTAKE_DELAY),
    ];
  },
});
```

One consequence worth knowing: this smoke test leaves the *deployer's own* address genuinely
staked for `SMOKE_TEST_UNSTAKE_DELAY` (86,400 seconds) with `SMOKE_TEST_STAKE` (0.001 ETH) real
stake — harmless (the deployer isn't a meaningful "entity" in any frame transaction unless a
tester deliberately uses it as one), but real, not a mock. A re-run of `predeploy run
staking-registry --force` would redeploy fresh and re-run the smoke test identically; a plain
re-run (no `--force`) skips `stepsDone` steps entirely, per the toolkit's existing idempotency
convention, so it wouldn't restake.

`deploy/predeploy/src/protocols/index.ts`: add `"staking-registry": stakingRegistry` to the
`registry` object (order matters for `run --all`, but this protocol has no dependents and
depends on nothing, so it can go anywhere — appending it last is simplest and avoids disturbing
the existing, address-sensitive order of everything already deployed).

Deployed via the existing `bun run predeploy run staking-registry` (from `deploy/predeploy/`),
recorded automatically into `deploy/predeploy/addresses/1337.json` under a new
`"staking-registry"` key, exactly like every other protocol.

### 3. Config/executor wiring

`packages/executor/src/interfaces.ts`: add `stakingRegistryAddress: Hex` to `NetworkConfig`
(near `minStake`, the other staking-adjacent field).

`packages/executor/src/config.ts`: default it to the zero address (preserving exactly today's
"unconfigured" behavior for anyone who hasn't set it) and load it from an env var, matching
`archiveDuration`'s exact pattern:

```typescript
config.stakingRegistryAddress = (
  fromEnvVar("STAKING_REGISTRY_ADDRESS", config.stakingRegistryAddress || bundlerDefaultConfigs.stakingRegistryAddress)
) as Hex;
```

with `bundlerDefaultConfigs.stakingRegistryAddress = "0x0000000000000000000000000000000000000000"`.

`packages/executor/src/executor.ts:122-131`: replace the hardcoded `AddressZero` argument with
`this.networkConfig.stakingRegistryAddress`, and update the comment (currently explains *why*
it's a placeholder — once real, the comment explains what governs the real address instead).

`config.json.default`/`README.md`: document the new `stakingRegistryAddress` field next to
`minStake`'s existing documentation.

### 4. Manual end-to-end runbook

A new row in `deploy/devnet/devnet-readme.md`'s existing tester table (matching its established
style — contract name, address, a usage note), plus a short paragraph (near the "Getting funds"
section that table already points to) walking through: `addStake` from a funded devnet key with
enough value to clear `MIN_STAKE_VALUE` and `unstakeDelaySec >= 86400`, then submitting a frame
transaction through that now-staked entity (as a `payer`, `sender`, or `factory` role) and
confirming via `skandha_explorer_getTransaction`'s check report that the staked-entity carve-outs
(wider associated-storage access, `BALANCE`/`SELFBALANCE` allowed, the higher
`MAX_VERIFY_GAS_STAKED_ENTITY` budget) actually applied rather than the unstaked path's tighter
rules.

## Testing

- Unit test for the config/executor wiring: `Executor` constructs `StakingRegistryService` with
  `networkConfig.stakingRegistryAddress`, not a hardcoded value (a simple constructor-argument
  assertion, mirroring how other `NetworkConfig`-sourced constructor args are already tested
  elsewhere in this codebase, if at all — check for precedent before deciding whether this needs
  a new test file).
- `deploy/predeploy`'s own `verify staking-registry` command (once the `verify()` open question
  above is resolved) is the closest thing to an automated proof this piece gets — it round-trips
  a real `addStake` call through `getDepositInfo` against the actual deployed devnet contract.
- No new test in `packages/executor/test/services/StakingRegistryService/` — that service's
  existing unit tests (mocked-`readContract` configured case, zero-address unconfigured
  short-circuit) already cover its own logic fully; this piece changes nothing about
  `StakingRegistryService` itself, only what address it's given.
- The manual runbook (§4) is the actual end-to-end proof this whole piece is for — deliberately
  not automated, per the Scope section's reasoning.
