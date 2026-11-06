# Naive Staking Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a real, naive implementation of ERC-8421's `IStakingRegistry` to the persistent
devnet, and wire the sidecar to point `StakingRegistryService` at it instead of a hardcoded
`AddressZero` placeholder.

**Architecture:** A minimal Solidity contract (already compiled) implementing
`addStake`/`unlockStake`/`withdrawStake`/`getDepositInfo` exactly as the ERC specifies, deployed
via `deploy/predeploy`'s existing `custom`-step extension point (the same one `permit2.ts`
already uses for a from-scratch CREATE). A new `NetworkConfig.stakingRegistryAddress` field
replaces the hardcoded placeholder in `executor.ts`.

**Tech Stack:** Solidity 0.8.20 (pre-compiled; no solc dependency added to the repo), TypeScript,
viem, vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-naive-staking-registry-design.md`

## Global Constraints

- The contract implements ERC-8421's `IStakingRegistry` exactly — no slashing (the spec has
  none), no access control beyond each function only ever touching `msg.sender`'s own deposit.
- `withdrawTime == 0` means no withdrawal pending (ERC-4337 StakeManager convention); `stake`/
  `unstakeDelaySec`/`withdrawTime` types are `uint256`/`uint32`/`uint64` exactly, matching
  `StakingRegistryService`'s existing `STAKING_REGISTRY_ABI` field-for-field.
- Unconfigured deployments (no `SKANDHA_STAKING_REGISTRY_ADDRESS` env var set) must keep today's
  exact behavior: `stakingRegistryAddress` defaults to the zero address, `StakingRegistryService`
  still short-circuits to zero stake with no chain call.
- No automated e2e test — the target is the persistent devnet (a manual/exploratory testing
  surface), per the spec's explicit Scope section.
- Env var prefix is `SKANDHA_` (confirmed against `config.ts`'s `fromEnvVar`, which prepends it
  automatically) — the real variable name is `SKANDHA_STAKING_REGISTRY_ADDRESS`, not the bare
  `STAKING_REGISTRY_ADDRESS` the spec's prose mentions.

## Review Focus

- **`verify()` must stay read-only.** `deploy/predeploy`'s `VerifyContext` has no `send` (only
  `deployer`/`address`/`read` — confirmed against `types.ts`). Any attempt to make `verify()`
  itself call `addStake` would fail to compile/type-check; the smoke-test call belongs in the
  `deploy` step's own `run`, which does have `send`.
- **A plain `to: null` CREATE, not CREATE2.** Unlike `permit2.ts`'s CREATE2-via-proxy (which
  needs `ctx.record` because the receipt never carries a `contractAddress` for an internally
  triggered creation), this protocol's `to: null` CREATE gets a real `result.contractAddress`
  directly from the receipt (confirmed against both `chain-viem.ts` and `FakeChain`'s
  `sendAndWait`) — the `if (!result.contractAddress) throw` guard exists for genuine safety, not
  because this path is expected to need `ctx.record`'s CREATE2-address-computation workaround.
- **The env var prefix.** A plan or implementer skimming the spec's prose (`STAKING_REGISTRY_ADDRESS`)
  without checking `fromEnvVar` would wire the wrong environment variable name. The real one is
  `SKANDHA_STAKING_REGISTRY_ADDRESS`.
- **`Hex` type consistency.** `StakingRegistryService`'s constructor parameter is `Hex` (viem's
  template-literal type), not a bare `string` — `NetworkConfig.stakingRegistryAddress` must be
  typed `Hex` too, or `executor.ts`'s call site needs an unsound cast instead of a clean pass-through.
- **The deploy-time smoke test really stakes the deployer.** `addStake`'s call inside the
  `deploy` step is a real transaction with real value, not a dry run — a person re-running
  `predeploy run staking-registry --force` gets a second, larger real stake on the deployer
  account each time (stakes accumulate; `addStake` adds to existing stake). This is harmless
  (the deployer isn't used as a meaningful entity elsewhere) but worth a test pinning it, since
  it's exactly the kind of "wait, why does the deployer have ETH locked in this contract"
  surprise a future reader could otherwise waste time on.

---

## Task 1: The contract, its deployment protocol, and its test

**Files:**
- Create: `deploy/predeploy/src/protocols/staking-registry-deployment.ts`
- Create: `deploy/predeploy/src/protocols/staking-registry.ts`
- Modify: `deploy/predeploy/src/protocols/index.ts`
- Test: `deploy/predeploy/test/staking-registry.test.ts`

**Interfaces:**
- Produces: the `"staking-registry"` protocol in the `registry` object (exported from
  `deploy/predeploy/src/protocols/index.ts`), deployable via `bun run predeploy run
  staking-registry` and verifiable via `bun run predeploy verify staking-registry`. Records a
  devnet address under the name `"StakingRegistry"` (readable elsewhere via
  `journal.protocols["staking-registry"].contracts.StakingRegistry`, or `ctx.address("StakingRegistry")`
  from within another protocol that declares a `dependsOn: ["staking-registry"]`, though nothing
  does yet).

- [ ] **Step 1: Write the failing deploy test**

Create `deploy/predeploy/test/staking-registry.test.ts`:

```typescript
import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import { verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal } from "./fakes";

const abi = parseAbi([
  "function addStake(uint32 unstakeDelaySec) payable",
  "function getDepositInfo(address account) view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)",
]);

const SMOKE_TEST_STAKE = 10n ** 15n;
const SMOKE_TEST_UNSTAKE_DELAY = 86_400;

describe("staking-registry deploy", () => {
  it("deploys via a plain CREATE, records the address, and stakes the deployer as a smoke test", async () => {
    const chain = new FakeChain();
    const journal = new MemoryJournal();

    await runProtocols(["staking-registry"], registry, {
      chain,
      artifacts: new MemoryArtifacts(),
      journal,
      log: () => {},
    });

    expect(chain.sent).toHaveLength(2);
    // First send: the plain CREATE.
    expect(chain.sent[0].to).toBeNull();
    expect(chain.sent[0].value).toBe(0n);
    const deployedAddress = journal.file.protocols["staking-registry"].contracts.StakingRegistry;
    expect(deployedAddress).toBeDefined();
    // Second send: the deploy-time addStake smoke test, against the address just deployed.
    expect(chain.sent[1].to).toBe(deployedAddress);
    expect(chain.sent[1].value).toBe(SMOKE_TEST_STAKE);
    expect(chain.sent[1].data).toBe(
      encodeFunctionData({ abi, functionName: "addStake", args: [SMOKE_TEST_UNSTAKE_DELAY] })
    );
  });
});

describe("staking-registry verify", () => {
  it("passes when getDepositInfo reflects the deploy-time smoke stake", async () => {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    const address = "0x0000000000000000000000000000000000000001" as const;
    chain.codes.set(address, "0x6001");
    journal.file.protocols["staking-registry"] = {
      stepsDone: ["deploy"],
      contracts: { StakingRegistry: address },
      mainnetToDevnet: {},
    };
    chain.setRead(address, "getDepositInfo", [SMOKE_TEST_STAKE, SMOKE_TEST_UNSTAKE_DELAY, 0n]);

    const [report] = await verifyProtocols(["staking-registry"], registry, {
      chain,
      artifacts: new MemoryArtifacts(),
      journal,
    });

    expect(report.ok).toBe(true);
  });

  it("fails when the deployer's recorded stake doesn't match the smoke-test amount", async () => {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    const address = "0x0000000000000000000000000000000000000001" as const;
    chain.codes.set(address, "0x6001");
    journal.file.protocols["staking-registry"] = {
      stepsDone: ["deploy"],
      contracts: { StakingRegistry: address },
      mainnetToDevnet: {},
    };
    chain.setRead(address, "getDepositInfo", [0n, 0, 0n]);

    const [report] = await verifyProtocols(["staking-registry"], registry, {
      chain,
      artifacts: new MemoryArtifacts(),
      journal,
    });

    expect(report.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd deploy/predeploy && bunx vitest run test/staking-registry.test.ts`
Expected: FAIL — `registry` has no `"staking-registry"` key yet, so `runProtocols`/`verifyProtocols`
throw `unknown protocol "staking-registry"` (or similar — the protocol doesn't exist).

- [ ] **Step 3: Create the deployment-constant file**

Create `deploy/predeploy/src/protocols/staking-registry-deployment.ts`:

```typescript
/**
 * Naive, faithful implementation of ERC-8421's IStakingRegistry
 * (https://github.com/ethereum/ERCs/pull/2028, ERCS/erc-8421.md -
 * "Frame Transaction Alternative Mempools") - no slashing, since the spec
 * itself has none ("there are no penalization mechanisms in the
 * alternative mempools protocol and the stake is never slashed"). Not a
 * mainnet replay - there is no mainnet equivalent to fetch.
 *
 * Source: docs/superpowers/specs/2026-09-30-naive-staking-registry-design.md's
 * `NaiveStakingRegistry.sol`. Compiled with `solc --bin --optimize`
 * (pragma ^0.8.20, compiled clean against 0.8.37, zero warnings). To
 * recompile after a source change: run the same `solc --bin --optimize`
 * command against the `.sol` file and replace the constant below.
 */
import type { Hex } from "../types";

export const STAKING_REGISTRY_INIT_CODE: Hex = "0x6080604052348015600e575f5ffd5b506104eb8061001c5f395ff3fe60806040526004361061003e575f3560e01c80630396cb60146100425780635287ce1214610057578063bb9fe6bf146100dc578063c23a5cea146100f0575b5f5ffd5b61005561005036600461040c565b61010f565b005b348015610062575f5ffd5b506100ae61007136600461044d565b6001600160a01b03165f9081526020819052604090208054600190910154909163ffffffff821691640100000000900467ffffffffffffffff1690565b6040805193845263ffffffff909216602084015267ffffffffffffffff169082015260600160405180910390f35b3480156100e7575f5ffd5b506100556101bb565b3480156100fb575f5ffd5b5061005561010a36600461044d565b61029c565b335f908152602081905260409020600181015463ffffffff90811690831610156101805760405162461bcd60e51b815260206004820152601d60248201527f63616e6e6f7420646563726561736520756e7374616b652064656c617900000060448201526064015b60405180910390fd5b34815f015f828254610192919061047c565b909155505060010180546bffffffffffffffffffffffff191663ffffffff909216919091179055565b335f90815260208190526040902080546102025760405162461bcd60e51b81526020600482015260086024820152676e6f207374616b6560c01b6044820152606401610177565b6001810154640100000000900467ffffffffffffffff161561025a5760405162461bcd60e51b8152602060048201526011602482015270616c726561647920756e6c6f636b696e6760781b6044820152606401610177565b600181015461026f9063ffffffff1642610495565b8160010160046101000a81548167ffffffffffffffff021916908367ffffffffffffffff16021790555050565b335f9081526020819052604081206001810154909164010000000090910467ffffffffffffffff1690036103015760405162461bcd60e51b815260206004820152600c60248201526b1b9bdd081d5b9b1bd8dad95960a21b6044820152606401610177565b6001810154640100000000900467ffffffffffffffff1642101561035b5760405162461bcd60e51b815260206004820152601160248201527019195b185e481b9bdd08195b185c1cd959607a1b6044820152606401610177565b80545f8083556001830180546bffffffffffffffff00000000191690556040516001600160a01b0385169083908381818185875af1925050503d805f81146103be576040519150601f19603f3d011682016040523d82523d5f602084013e6103c3565b606091505b50509050806104065760405162461bcd60e51b815260206004820152600f60248201526e1dda5d1a191c985dc819985a5b1959608a1b6044820152606401610177565b50505050565b5f6020828403121561041c575f5ffd5b813563ffffffff8116811461042f575f5ffd5b9392505050565b6001600160a01b038116811461044a575f5ffd5b50565b5f6020828403121561045d575f5ffd5b813561042f81610436565b634e487b7160e01b5f52601160045260245ffd5b8082018082111561048f5761048f610468565b92915050565b67ffffffffffffffff818116838216019081111561048f5761048f61046856fea264697066735822122075996d6d66fe08537cf131b2eaf8a9e909a5e61995e516e51e095c258391ac9c64736f6c63430008220033";
```

Also create `deploy/predeploy/src/contracts/NaiveStakingRegistry.sol` (the source, for
readability/auditability - not built at runtime, just checked in alongside the compiled
constant above):

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

- [ ] **Step 4: Create the protocol definition**

Create `deploy/predeploy/src/protocols/staking-registry.ts`:

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
        // `send`), so it can't perform this call itself; it just reads
        // the result.
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
    const [stake, unstakeDelaySec] = (await ctx.read(registry, abi, "getDepositInfo", [ctx.deployer])) as [
      bigint,
      number,
      bigint,
    ];
    return [
      equalCheck("deployer stake after deploy-time addStake", stake, SMOKE_TEST_STAKE),
      equalCheck("deployer unstakeDelaySec after deploy-time addStake", unstakeDelaySec, SMOKE_TEST_UNSTAKE_DELAY),
    ];
  },
});
```

- [ ] **Step 5: Register the protocol**

In `deploy/predeploy/src/protocols/index.ts`, add the import and registry entry:

```typescript
import stakingRegistry from "./staking-registry";
```

(add this import line alongside the existing ones, e.g. after the `railgun` import)

```typescript
  railgun,
  "staking-registry": stakingRegistry,
```

(append as the last entry in the `registry` object — this protocol has no dependents and
depends on nothing, so appending it doesn't disturb the existing, address-sensitive deployment
order of anything already there)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd deploy/predeploy && bunx vitest run test/staking-registry.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 7: Run the whole predeploy test suite**

Run: `cd deploy/predeploy && bunx vitest run`
Expected: PASS, no new failures (confirms adding this protocol to the shared `registry` object
didn't break any other protocol's test).

- [ ] **Step 8: Type-check the package**

Run: `cd deploy/predeploy && bunx tsc --noEmit` (check `package.json` for the exact script name
if this differs)
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add deploy/predeploy/src/contracts/NaiveStakingRegistry.sol deploy/predeploy/src/protocols/staking-registry-deployment.ts deploy/predeploy/src/protocols/staking-registry.ts deploy/predeploy/src/protocols/index.ts deploy/predeploy/test/staking-registry.test.ts
git commit -m "feat(predeploy): add a naive ERC-8421 IStakingRegistry deployment protocol"
```

---

## Task 2: NetworkConfig/executor.ts wiring

**Files:**
- Modify: `packages/executor/src/interfaces.ts`
- Modify: `packages/executor/src/config.ts`
- Modify: `packages/executor/src/executor.ts`
- Modify: `README.md`
- Test: `packages/executor/test/config.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (this task doesn't reference the deployed address by value -
  that's a runtime `config.json`/env-var concern, not a compile-time dependency).
- Produces: `NetworkConfig.stakingRegistryAddress: Hex`, defaulting to `AddressZero`
  (`@skandha/params`'s existing constant), overridable via the `SKANDHA_STAKING_REGISTRY_ADDRESS`
  env var.

- [ ] **Step 1: Write the failing test**

Add to `packages/executor/test/config.test.ts`:

```typescript
describe("Config.getNetworkConfig stakingRegistryAddress", () => {
  it("defaults to the zero address when SKANDHA_STAKING_REGISTRY_ADDRESS is unset", () => {
    const config = new Config({ config: null, unsafeMode: false, redirectRpc: false });
    expect(config.getNetworkConfig().stakingRegistryAddress).toBe(
      "0x0000000000000000000000000000000000000000"
    );
  });

  it("picks up SKANDHA_STAKING_REGISTRY_ADDRESS from the environment", () => {
    const previous = process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
    process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111";
    try {
      const config = new Config({ config: null, unsafeMode: false, redirectRpc: false });
      expect(config.getNetworkConfig().stakingRegistryAddress).toBe(
        "0x1111111111111111111111111111111111111111"
      );
    } finally {
      if (previous === undefined) delete process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
      else process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = previous;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/executor && bunx vitest run test/config.test.ts`
Expected: FAIL — `stakingRegistryAddress` is `undefined` on the returned `NetworkConfig` (the
field doesn't exist yet).

- [ ] **Step 3: Add the field to `NetworkConfig`**

In `packages/executor/src/interfaces.ts`, add after `minUnstakeDelay: number;` (around line 91):

```typescript
  minUnstakeDelay: number;
  // EIP-8421 IStakingRegistry contract address. Zero address (the default)
  // means "unconfigured" - StakingRegistryService then short-circuits to
  // zero stake for every entity without a chain call. See
  // docs/superpowers/specs/2026-09-30-naive-staking-registry-design.md.
  stakingRegistryAddress: Hex;
```

- [ ] **Step 4: Load it in `config.ts`**

In `packages/executor/src/config.ts`, add after the `minUnstakeDelay` loading block (around
line 224):

```typescript
    config.minUnstakeDelay = Number(
      fromEnvVar(
        "MIN_UNSTAKE_DELAY",
        config.minUnstakeDelay || bundlerDefaultConfigs.minUnstakeDelay
      )
    );

    config.stakingRegistryAddress = fromEnvVar(
      "STAKING_REGISTRY_ADDRESS",
      config.stakingRegistryAddress || bundlerDefaultConfigs.stakingRegistryAddress
    ) as Hex;
```

(`fromEnvVar`'s own implementation prepends `SKANDHA_` to the name you give it - passing
`"STAKING_REGISTRY_ADDRESS"` here is what makes the real environment variable
`SKANDHA_STAKING_REGISTRY_ADDRESS`, matching the test in Step 1.)

Add the default, in `bundlerDefaultConfigs` after `minUnstakeDelay: 0,` (around line 578):

```typescript
  minUnstakeDelay: 0,
  stakingRegistryAddress: AddressZero,
```

`Hex` is already imported into `config.ts` from `viem` (line 10) - no change needed there.
`AddressZero` is NOT yet imported; add it after the existing `import { IEntity } from
"@skandha/types/lib/executor/index.js";` line (line 2):

```typescript
import { AddressZero } from "@skandha/params/lib/index.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/executor && bunx vitest run test/config.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Wire `executor.ts` to use the real config value**

In `packages/executor/src/executor.ts`, replace lines 122-131:

```typescript
    // The EIP-8421 IStakingRegistry contract address. Zero (the default,
    // per `NetworkConfig.stakingRegistryAddress`'s own doc comment) means
    // unconfigured - `StakingRegistryService` short-circuits to zero stake
    // for every entity without a chain call. Set
    // `SKANDHA_STAKING_REGISTRY_ADDRESS` (or `stakingRegistryAddress` in
    // config.json) to a real deployment - see
    // `deploy/predeploy/src/protocols/staking-registry.ts` for the naive
    // devnet deployment this points at by convention.
    this.stakingRegistryService = new StakingRegistryService(
      this.publicClient,
      this.networkConfig.stakingRegistryAddress
    );
```

- [ ] **Step 7: Run the whole executor suite and build**

Run: `cd packages/executor && bunx vitest run`
Expected: same baseline as before this task (300+ passing, the 5 pre-existing unrelated
`test/unit/` failures documented in CLAUDE.md - confirm the count matches what you saw before
Step 3's edits, plus the 2 new tests from Step 1).

Run: `cd packages/executor && bun run build`
Expected: exit 0. (This will fail loudly if `AddressZero` wasn't actually importable from
`@skandha/params` in `config.ts`'s context, or if any other `NetworkConfig` construction site in
a test fixture is missing the new required field - if it does, add
`stakingRegistryAddress: "0x0000000000000000000000000000000000000000"` to whichever fixture the
error names.)

- [ ] **Step 8: Document the new field**

In `README.md`, add after the `minUnstakeDelay` line (around line 129):

```
  "minUnstakeDelay": 0, // optional, minimum entity unstake delay
  "stakingRegistryAddress": "0x...", // optional, EIP-8421 IStakingRegistry contract address; unset/zero means every entity reads as unstaked
```

- [ ] **Step 9: Commit**

```bash
git add packages/executor/src/interfaces.ts packages/executor/src/config.ts packages/executor/src/executor.ts packages/executor/test/config.test.ts README.md
git commit -m "feat(executor): read the staking registry address from config instead of AddressZero"
```

---

## Task 3: Devnet runbook

**Files:**
- Modify: `deploy/devnet/devnet-readme.md`

**Interfaces:**
- Consumes: Task 1's deployed contract (referenced by the address `bun run predeploy run
  staking-registry` records - this task documents how to read that address and use it, not a
  fixed value, since the real address depends on deployment order/nonce at the time it's run).

- [ ] **Step 1: Add a tester-table row**

In `deploy/devnet/devnet-readme.md`'s tester table (the one ending around line 481 with the
Uniswap v4 StateView row), add:

```
| NaiveStakingRegistry (ERC-8421 IStakingRegistry) | see `deploy/predeploy/addresses/1337.json` under `staking-registry.contracts.StakingRegistry` | Naive, no-slashing implementation - `addStake(unstakeDelaySec)` with real ETH value, `unlockStake()`, `withdrawStake(to)`. The deployer already has a small smoke-test stake from deployment itself. |
```

- [ ] **Step 2: Add a short usage walkthrough**

After the existing "Getting funds" section (around line 74), add:

```markdown
### Testing a staked entity end-to-end

1. Fund your own key from the shared devnet key (see above).
2. Call `addStake(86400)` (one day, `MIN_UNSTAKE_DELAY` per ERC-8421) on the deployed
   `NaiveStakingRegistry`, sending enough ETH as `value` to clear `MIN_STAKE_VALUE` (check
   `packages/executor/src/config.ts`'s `minStake` default, or your node's actual configured
   value, for the exact threshold).
3. Submit a frame transaction whose `payer`, `sender`, or `factory` role resolves to that
   now-staked address.
4. Check the admission's rule report (`skandha_explorer_getTransaction`, if the node has
   `--explorer.enable`, or the RPC error/success itself) for evidence the staked-entity
   carve-outs applied: wider associated-storage access, `BALANCE`/`SELFBALANCE` allowed, and
   `MAX_VERIFY_GAS_STAKED_ENTITY` (not the tighter unstaked `MAX_VERIFY_GAS_PER_ENTITY`) as the
   effective gas cap for that entity's validation frames.
5. `unlockStake()` then, after the delay, `withdrawStake(yourAddress)` to get the ETH back.

The node's own `config.json` needs `stakingRegistryAddress` (or the
`SKANDHA_STAKING_REGISTRY_ADDRESS` env var) pointing at the deployed address for any of this to
matter - otherwise every entity still reads as unstaked.
```

- [ ] **Step 3: Commit**

```bash
git add deploy/devnet/devnet-readme.md
git commit -m "docs: runbook for testing a staked entity against the naive staking registry"
```
