# Design: replaying mainnet deployments onto the EIP-8141 devnet

## Purpose

Give testers of the public devnet (`https://altmempool.forshtat.com`) a library of real,
widely used contracts: USDT, USDC, LINK, Bored Ape Yacht Club, Tornado Cash, Railgun and
Uniswap v4. The contracts must be the real ones, not imitations, and they must be easy to
put back after every devnet restart.

The tool replays the original mainnet deployment transactions onto the devnet, from a
deployer key we control. It does not compile anything.

## Non-goals

- **Genesis preloading.** Considered and deferred. Contracts with complex constructors are
  painful to express as genesis state. This design uses ordinary transactions after genesis.
- **Proof tooling** for Tornado Cash and Railgun. The contracts are deployed and verified.
  Making deposits and withdrawals with real zk proofs is separate work.
- ERC-4337 EntryPoints, Chainlink oracles, and any protocol not listed above.
- Reproducing mainnet addresses. Replays run from our own deployer key, so `CREATE`
  addresses differ from mainnet. Contracts deployed through Arachnid's CREATE2 proxy
  (already in genesis at `0x4e59b44847b379578588920cA78FbF26c0B4956C`) keep their mainnet
  addresses.

## Decisions

| Question | Decision | Reason |
|---|---|---|
| Where does bytecode come from? | Replay the original mainnet deployment transactions. | Compiling old contracts (solc 0.4.16, 0.4.18, 0.7.0, exact optimizer settings) is fragile. Replay is byte-exact. |
| Which transactions per protocol? | Creations plus the minimum setup transactions needed to make the protocol usable. Owner, admin and minter rights go to the devnet deployer key. | Testers can mint USDT and USDC and configure protocols without mainnet multisigs. |
| Language and location | TypeScript with `viem`, run by Bun, in `deploy/predeploy/`. | Matches the repo. No new toolchain. |
| Architecture | One generic replay engine plus a small declarative manifest per protocol. | Adding a protocol is a manifest, and every protocol behaves the same. |

## Layout

```
deploy/predeploy/
  src/                    engine, CLI, Etherscan client, address map, journal
  protocols/<name>.ts     one manifest per protocol (plus weth9.ts, permit2.ts)
  artifacts/<name>/       fetched mainnet transactions, committed
  addresses/<chainId>.json  output: name -> devnet address, plus the step journal
  README.md               operator usage
```

Root `package.json` gains `"predeploy": "bun run deploy/predeploy/src/cli.ts"`.

### Commands

| Command | Needs | Does |
|---|---|---|
| `predeploy fetch <protocol…>` | `ETHERSCAN_API_KEY` | Downloads each manifest transaction from Etherscan into `artifacts/`. |
| `predeploy fund` | RPC, funded key | Sends ETH from the shared devnet key to the deployer. |
| `predeploy run <protocol…\|--all>` | RPC, deployer key | Replays artifacts onto the devnet, resolves dependencies first. |
| `predeploy verify <protocol…\|--all>` | RPC | Runs each protocol's read-only checks. |
| `predeploy list` | none | Prints protocols, dependencies and recorded addresses. |

Environment: `PREDEPLOY_RPC_URL` (default `https://altmempool.forshtat.com`),
`PREDEPLOY_DEPLOYER_KEY` (default: the published throwaway key below),
`ETHERSCAN_API_KEY` (only `fetch`).

`fetch` and `run` are separate on purpose. Artifacts are public chain data and get
committed, so the Etherscan key is needed only when adding or refreshing a protocol.
Deploying needs no key and no network access beyond the devnet.

The Etherscan key is read from the environment only. It is never written to a repo file.
`.env` is already git-ignored.

## Manifest

A manifest lists steps in order.

```ts
export default defineProtocol({
  name: "usdt",
  dependsOn: [],
  steps: [
    { id: "token", kind: "create", tx: "0x2f1c5c2b…", as: "USDT",
      args: { /* override constructor args by position, e.g. initial supply */ } },
  ],
  verify: async (ctx) => { /* read-only checks, see Verification */ },
});
```

Step kinds:

- `create`: replay a mainnet creation transaction. Records the new address under `as`.
- `call`: replay a mainnet call transaction (for example `initialize`), or send a call
  described in the manifest. Optional `to` names an address from the address map.
- `custom`: a TypeScript function using `viem`, for setup with no mainnet counterpart, such
  as transferring ownership to the deployer.

`dependsOn` names other protocols. `run` deploys them first, in dependency order.
Uniswap v4 and Railgun depend on `weth9`. Uniswap v4 also depends on `permit2`.

## Replay engine

### Artifacts

`fetch` stores one JSON file per transaction: hash, sender, target, input, value, block,
created address (for creations), constructor arguments, compiler version, and the mainnet
runtime code hash. Sources: Etherscan V2 API (`api.etherscan.io/v2/api?chainid=1`), actions
`getcontractcreation` (returns creation bytecode; at most 5 addresses per call),
`getsourcecode` (constructor arguments, compiler settings) and the `proxy` module for
transaction lookup. The client rate-limits itself to stay under the free tier's 5 requests
per second.

### Address rewriting

Contracts refer to each other by address, and replays produce new addresses. The engine
keeps an address map (mainnet address to devnet address) that grows as `create` steps
complete.

- For a `create` step, the engine splits the creation bytecode into init code and
  constructor arguments, using the argument length reported by Etherscan.
- In constructor arguments and in call data after the 4-byte selector, every 32-byte ABI
  word that holds a known mainnet address (12 zero bytes, then the address) is replaced
  with the devnet address.
- Init code bytes are never rewritten automatically. Some contracts embed mainnet
  addresses as constants. A manifest step can declare a `patch` (byte string to replace,
  with an assertion on how many times it must occur), so any change to code is explicit
  and checked.
- An unmapped mainnet address in arguments is passed through and logged as a warning.

### Gas and fees

- Gas limit: `eth_estimateGas` on the devnet plus a 20% margin, capped at the block gas
  limit (60M on the live devnet). If estimation fails, the step stops with the revert
  reason. The engine never sends a transaction blind.
- Gas price: `2 × eth_gasPrice`.
- Transactions are legacy type, sent one at a time with the nonce read from the chain.

Measured on the live devnet on 2026-09-21 with `eth_estimateGas`, nothing sent:

| Contract | Creation code | Estimated deploy gas |
|---|---|---|
| LINK | 3.2 KB | 5.4M |
| USDT | 11.9 KB | 18.6M |
| BAYC | 18.4 KB | 28.2M |
| Uniswap v4 PoolManager | 24.2 KB | 38.9M |

Storing contract code is expensive here because of EIP-8037 state gas.

### Deployer key

A dedicated throwaway key, published in the devnet docs like the shared key. It is not the
shared key: other people send from the shared key, and each extra transaction would shift
the nonce, and with it every `CREATE` address. A fresh key starts at nonce 0.

`predeploy fund` sends ETH from the shared key to the deployer (default 10 ETH, far more
than the roughly 0.5 ETH the deployments need at the current gas price).

The deployer owns everything: it becomes owner, admin, master minter and pauser wherever
the replayed setup would have set mainnet's equivalents. Anyone holding the published key
can administer the deployed protocols. That is the intent for a demonstration devnet.

## State, idempotency and restarts

`addresses/<chainId>.json` holds two things per protocol: the name-to-address map and a
journal of completed step ids.

- A protocol counts as deployed only if every recorded contract has code on the connected
  chain. After a devnet restart the chain is empty, so every entry is stale and the
  protocol redeploys.
- An interrupted run resumes at the first incomplete step. The engine checks that the last
  created contract still has code before trusting the journal.
- The deployer starts at nonce 0 on a fresh chain, so a full run in fixed order produces
  the same addresses every time. `predeploy run --all` is the canonical run. Its output
  is committed and listed in the tester doc.
- Partial or out-of-order runs still work but may assign different addresses. The tool
  prints a diff against the committed file.
- `--force` deploys a fresh copy of a protocol next to the old one.

## Verification

`predeploy verify` runs read-only calls per protocol and reports pass or fail:

| Protocol | Checks |
|---|---|
| USDT | name, symbol, decimals, total supply, owner is the deployer |
| USDC | proxy implementation, master minter and owner are the deployer, name and decimals |
| LINK | name, symbol, decimals, total supply |
| BAYC | name, symbol, owner is the deployer |
| Tornado | denomination, tree levels, verifier and hasher addresses point at the deployed contracts |
| Uniswap v4 | PoolManager code present, owner is the deployer, dependencies wired |
| Railgun | proxy points at the implementation, verification keys registered |

It also compares each deployed runtime code hash with mainnet's and reports the result as
information. A difference is normal for contracts with immutables or baked-in arguments,
so it never fails a run.

## Protocol plan and order

Each protocol is a separate increment after the engine. Each protocol's exact
transaction list is settled in its own increment, from the deployer's history on
Etherscan. The lists below are expectations.

| # | Protocol | Expected replay | Notes |
|---|---|---|---|
| 1 | Engine, `fetch`, `fund`, gas-cap test | proven with LINK | LINK is the smallest contract. |
| 2 | USDT | one creation | First real test of the per-transaction gas cap (18.6M gas). |
| 3 | BAYC | one creation | Constructor takes name, symbol, max supply and sale start. Override for a usable sale. |
| 4 | WETH9, Permit2 | one creation each | Dependencies. If Permit2's original deployment went through Arachnid's CREATE2 proxy, replaying the same salt and init code reproduces its mainnet address. Confirm with Etherscan's `contractFactory` field in this increment. Otherwise it is a plain creation with a new address. |
| 5 | USDC | implementation, proxy, `initialize`, `initializeV2`, `initializeV2_1`, `initializeV2_2` | Initialisation runs on this chain, so the EIP-712 domain separator uses chain ID 1337. |
| 6 | Tornado Cash | Hasher, Verifier, 0.1 ETH pool | The pool constructor calls the mainnet Hasher and Verifier addresses. Address rewriting supplies the devnet ones. Confirmed on 2026-09-21: replaying the pool creation without them reverts. |
| 7 | Uniswap v4 | PoolManager, PositionManager, StateView, Quoter, Universal Router | Depends on WETH9 and Permit2. On mainnet, PoolManager was created through a CREATE2 factory (not Arachnid's proxy) at a mined vanity address. The replay is a plain creation from the deployer and gets a different address. |
| 8 | Railgun | implementation, proxy, verifier and helper contracts, verification keys | Upgradeable. Registers many circuit keys. It may register only a subset. |

## Testing

- **Unit tests** (Vitest) for the pure parts: address rewriting (padded words, unmapped
  addresses, `patch` assertions), gas margin and cap, manifest and dependency ordering,
  journal resume and staleness detection.
- **Integration**: each protocol's `verify`, run against the live devnet. This is the
  acceptance test for every increment.
- No CI end-to-end test for now. The `--dev` devnet does not mine, so real deployments need
  the slow Kurtosis mining devnet. A canary test (LINK and USDT) can be added to that suite
  later.

## Documentation

- `devnet-readme.md` gets a "Predeployed contracts" table of the canonical addresses and
  the published deployer key.
- `deploy/devnet/README.md` gets a "Predeploying the library after a restart" section.
- `deploy/predeploy/README.md` documents commands, environment variables and how to add a
  protocol.

## Risks and open questions

1. **Per-transaction gas cap.** USDT, BAYC and PoolManager estimate above 16.7M gas, the
   usual EIP-7825 cap. `eth_estimateGas` does not enforce the cap, so this is untested.
   The first real send (USDT) answers it. If the devnet rejects it, the fallback is a
   devnet-only cap override in the ethrex fork.
2. **Mainnet constants in code.** Any contract that embeds a mainnet address in its
   bytecode needs a `patch` or a dependency deployed at that address. Found per protocol.
3. **Constructors that read mainnet state** (for example ENS lookups) fail on this chain.
   Handled per protocol with argument overrides or a skipped step.
4. **Railgun scale.** The number of verification-key transactions is unknown until its
   history is fetched. The scope may shrink to a subset of circuits.
5. **Vanity addresses.** Uniswap v4's factory-created contracts get ordinary `CREATE`
   addresses on the devnet instead of mainnet's mined vanity addresses. Nothing in v4's core
   depends on the vanity prefix. Hooks do depend on their own address bits, so hook
   examples deployed later must mine salts for the devnet.
6. **Etherscan availability.** `fetch` depends on Etherscan. Because artifacts are
   committed, deployment does not.
7. **Published deployer key.** Anyone can administer the deployed contracts. Accepted for
   a demonstration devnet.

## Published throwaway deployer key

Generated when the engine is built and committed in `deploy/predeploy/`, next to the
shared devnet key's existing documentation. Never use it on a real network.
