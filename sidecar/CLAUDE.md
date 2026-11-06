# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The sidecar is a modular, TypeScript bundler/relayer sidecar for **EIP-8141 frame transactions** — a
proposed native Ethereum transaction type (`FRAME_TX_TYPE = 0x06`) that replaces ERC-4337's
contract-level `UserOperation`/`EntryPoint` model with protocol-native validation and execution.
This repo is a fork of sidecar's original ERC-4337 bundler onto that EIP; it no longer implements
ERC-4337 (no `EntryPoint` contract calls, no `eth_sendUserOperation`) — see `README.md` and
`P2P.md` for the full picture, including why it needs an EIP-8141-aware execution client
([ethrex](https://github.com/lambdaclass/ethrex)'s `eip8141-tracer` branch; plain geth has no
frame-tx support) rather than a standard Ethereum node.

It exposes an `eth_sendFrameTransaction`-style JSON-RPC API, validates and simulates frame
transactions against that execution client (via `ethrex_simulateFrameTransaction` and/or a
`debug_traceCall`-based opcode/storage tracer), relays them as real on-chain transactions, and
(optionally) gossips them over a libp2p P2P mempool network.

This is a Bun/Yarn workspace monorepo managed with Lerna + Nx, containing nine `@skandha/*`
bundler packages and the `devnet-ui` web explorer under `packages/`.

## Common commands

Package manager is **Bun** (see `bun.lock`); scripts are orchestrated with Lerna/Nx across
workspaces.

```sh
bun install                 # install all workspace deps

bun run build                # full build (prebuild -> db -> all packages, in dependency order)
bun run build:packages       # same, invoked as a chained cd/bun run sequence
bun run clean                # remove lib/ and *.tsbuildinfo from every package

bun run lint                 # eslint across all packages' src/
bun run fix-lint             # eslint --fix across all packages' src/
```

`packages/executor` defines `test`/`test:unit` scripts (Vitest), and `packages/devnet-ui` defines
`test` (Vitest, jsdom) and `test:e2e` (Playwright); root `bun run test` (lerna) now runs both. Run
devnet-ui tests from inside the package with `--root` set to it, never from the repo root:
`cd packages/devnet-ui && bunx vitest run --root "$(pwd)"`. For the executor, the scripts are
presently broken at the repo root: `test:unit` is `vitest --run --dir test/unit/`, and every file
under `packages/executor/test/unit/` fails to load because `test/fixtures/getClient.ts` still
imports a deleted `@skandha/types/.../EPv7/factories/core/EntryPoint__factory` module (stale
ERC-4337 fixture, unrepaired). The package's real, currently-exercised frame-tx test suite lives
outside `test/unit/` and must be run directly with vitest instead:

```sh
cd packages/executor
bunx vitest run                                                         # whole suite (skips broken test/unit/ files as failed, not fatal)
bunx vitest run test/services/UserOpValidation/validators/frameTx.test.ts  # single file
bunx vitest run -t "some test name"                                     # by name
```

Running vitest from `packages/executor` itself (its own `vitest.config.js`) is meaningfully
different from running it against `packages/executor/test/` from the repo root: only the former
loads `test/vitestSetup.ts`'s `setupFiles`, which globally mocks `GethTracer`
(`test/mocks/GethTracer.ts`) for every test in the package. Always prefer running from inside
`packages/executor` when touching anything under `UserOpValidation/` or `FrameTxSimulationService/`
— it's the config CI and a human would actually use, and it's the one that exercises the mock.

Vitest config is shared via `vitest.base.config.ts` at the repo root (single-threaded,
`maxConcurrency: 1` — tests are not designed to run in parallel).

Build order matters and is NOT automatically inferred by `tsc`/turbo — packages are built in an
explicit dependency chain: `types` → `db` → `utils` → `params` → `monitoring` → `executor` → `api`
→ `node` → `cli`. If you change a lower-level package (e.g. `types`), rebuild it (or run the full
`bun run build`) before packages that depend on it will pick up the change, since intra-workspace
imports resolve against each package's built `lib/` output, not its `src/`.

### Running the bundler locally

```sh
cp config.json.default config.json   # then edit config.json (rpcEndpoint, relayers, ...)
./skandha standalone                 # runs packages/cli/bin/skandha.js via bun --bun
```

`entryPoints`/`canonicalEntryPoint`/`supportedMempools[].entryPoint` in `config.json` must all be
the fixed EIP-8141 `ENTRY_POINT` sentinel (`0x00000000000000000000000000000000000000aa`, exported
from `packages/types/src/contracts/FrameTx.ts`), not a deployed contract address — a stale
ERC-4337-shaped address there silently disables gossip publish (`Eth.sendFrameTransaction`'s
publish gate checks it) with no error. `rpcEndpoint`/`rpcEndpointSubmit` must point at an
EIP-8141-aware execution client (ethrex), not plain geth.

`./skandha standalone` runs the bundler without P2P; `./skandha node` runs it with the libp2p
gossip network attached (see `P2P.md` for a full local devnet walkthrough against a real ethrex
node, including a scripted `test/e2e/ethrex-devnet.sh` + `bun run test:e2e` fast path). The
block-producing suite (`bun run test:e2e:mining`, Kurtosis) includes the EIP-8250/8272 acceptance
test `frameTxSharedSender.e2e.test.ts`. `MINING_DEVNET_RPC_URL=<url>` (mining) and
`DEVNET_EXTERNAL=1` (`--dev`, port 8555) reuse an already-running devnet, e.g. a remote amd64 VM
through an SSH tunnel, since the ethrex image is amd64-only. Key CLI flags: `--redirectRpc`, `--executor.bundlingMode manual|auto`, `--metrics.enable`, `--explorer.enable`,
`--dataDir`, `--api.port`. (`--unsafeMode` still exists but is now largely vestigial — the opcode/stake-check
bypass it used to gate was removed along with the ERC-4337 validation path; it now only affects
EIP-2930 selection.) Full config schema and defaults are documented in `README.md`.

## Architecture

### Package layout (`packages/*`, each an independent `@skandha/*` npm package)

- **`types`** — shared TypeScript types: the `FrameTransaction`/`Frame` wire model
  (`contracts/FrameTx.ts`, including EIP-8250 `nonceKeys`/`nonceSeq`, EIP-8272
  `recentRootReferences`, and their static-validity/slot-window helpers), RPC error
  codes/interfaces, options schemas. Nearly everything else depends on this; build it first.
- **`params`** — chain/network parameter tables (e.g. `chainsWithoutEIP1559`), per-chain constants.
- **`utils`** — small shared helpers (e.g. `deepHexlify`).
- **`db`** — `IDbController` implementations: `RocksDbController` (persistent, used by `standalone`
  and `node` in normal operation) and `LocalDbController` (in-memory, used in `testingMode`).
- **`monitoring`** — Prometheus metrics (`createMetrics`, `PerChainMetrics`, HTTP metrics server).
- **`executor`** — the core bundler engine; see below.
- **`api`** — the JSON-RPC/HTTP/WebSocket server layer that wraps an `Executor`.
- **`node`** — the libp2p P2P layer (`BundlerNode`): gossipsub, discv5 discovery, req/resp
  protocols, peer scoring/banning — wraps an `api`+`executor` stack with a gossiped frame-tx
  mempool.
- **`cli`** — the `skandha` executable entrypoint; parses CLI args/config and wires up either the
  standalone (`api` + `executor`, no P2P) or node (`node` + P2P) mode.
- **`devnet-ui`** — a static React app (Vite, Tailwind, TanStack Query/Router) that explores one or
  more sidecar instances through `skandha_explorer_*`: pool, activity, per-rule admission reports,
  peers. Not part of the `build` chain: it has its own `dev`/`test`/`build`/`test:e2e` scripts and its
  own toolchain versions (see its README). `bun run mock` there starts fake nodes for development.

### Core flow: `Executor` (packages/executor/src/executor.ts)

`Executor` is the composition root for a single chain. It's constructed per-chain (see
`Config.testingMode` special-casing chain `1337`) and wires together the services in this order,
each depending on the previous:

`ExecutorEventBus`/`SubscriptionService` → `ReputationService` → `MempoolService` → `Skandha`
(module) → `BundlingService` → `Web3`/`Debug` (modules) → `StakingRegistryService` →
`FrameTxValidationService` → `FrameTxSimulationService` → `ReceiptService` → `Eth` (module)

There is no `EntryPointService` and no on-chain-event-driven `EventsService` — both were removed
along with the ERC-4337 `EntryPoint` contract model. A frame transaction has no separate
assemble/simulate/`handleOps`-batch step; the bundler validates an already-signed transaction and
relays it largely as-is.

Key services (`packages/executor/src/services/*`):
- **`MempoolService`** — the frame-transaction pool (persisted via `IDbController`), not scoped by
  `entryPoint` (EIP-8141 has exactly one fixed `ENTRY_POINT` sentinel).
  - **Slots:** entries are keyed by `frameTxSlotKey` (`MempoolService/utils.ts`):
    `chainId:sender:nonceSeq` for linear (`nonceKeys = [0]`) txs, unchanged from before EIP-8250;
    `chainId:sender:k[<keys>]:nonceSeq` for EIP-8250 keyed ones. The same slot means a fee-bump
    replacement.
  - **Key conflicts:** `checkNonceKeyConflict` holds each `(sender, nonce key)` by at most one
    pending tx.
  - **Caps:** keyed txs are exempt from the sender's own per-entity caps
    (`MempoolService/reputation.ts`).
  - **Balances:** `obligations.ts` keeps pending gas (payer) and top-level frame value (sender)
    within each account's balance, at admission (`addFrameTx`) and per block (`enforceBalances`).
  - These are deliberately minimal alt-mempool rules, not ethrex's public-mempool policy;
    `README.md` §Keyed nonces lists them.
- **`StakingRegistryService`** (`services/StakingRegistryService/`) — client for EIP-8141's
  separate on-chain staking registry (`IStakingRegistry`), used by `FrameTxValidationService` for
  ERC-7562-style staked-entity storage-access carve-outs.
- **`FrameTxValidationService`** (`services/UserOpValidation/validators/frameTx.ts`) — the
  validation-prefix opcode/storage interpreter: recognizes a frame transaction's validation-prefix
  shape, runs it through `GethTracer`'s ethrex-native `ethrex_simulateFrameTransaction` trace, and
  applies ported ERC-7562 OP-/STO-/COD-010 banned-opcode and associated-storage rules per
  frame/entity.
- **EIP-8272 recent roots** are enforced in four places, all reported under the explorer's
  `recent-root` rule:
  - `Eth.checkRecentRootWindow` pre-checks the slot window before simulating (head slot via
    `utils/headSlot.ts`);
  - ethrex's simulation checks commitment (`FrameTxValidationService` classifies its "EIP-8272"
    errors);
  - `MempoolReconciler` evicts expired entries by slot arithmetic;
  - `BundlingService` does not relay entries expiring within `RELAY_ROOT_EXPIRY_MARGIN_SLOTS`.
- **`FrameTxSimulationService`** (`services/FrameTxSimulationService/`) — makes exactly one traced
  `GethTracer.simulateFrameTransaction(rawTx, true)` call per `simulate()`, then feeds that same
  result to both its own gas/receipt mapping and `FrameTxValidationService.validate(tx,
  simResult)` (the admission-gate check) — no redundant second round-trip.
- **`BundlingService`** — relays already-validated frame transactions on an interval; supports
  `manual`/`auto` bundling mode via the single relaying strategy under
  `services/BundlingService/relayers/` (`PrivilegedRelayer`, submitting through a co-located,
  trusted ethrex node's privileged `ethrex_submitPrivilegedFrameTransaction` RPC method — this
  sidecar is an outsourced mempool client for one node, not a general-purpose bundler choosing
  among relay strategies).
- **`ReceiptService`** — looks up frame-transaction receipts (backing
  `eth_getFrameTransactionReceipt`), bounded by `receiptLookupRange`. (`skandha_frameTransactionStatus`
  and `eth_getFrameTransactionByHash` instead read straight from `MempoolService`'s own entry, not
  this service.)
- **`ExplorerService`** (`services/ExplorerService/`) — in-memory admission reports (`AdmissionRecord`,
  built via `CheckCollector` while `FrameTxValidationService` runs) and a bounded lifecycle event log.
  Created only with `--explorer.enable`; served read-only through `skandha_explorer_*`
  (`modules/explorer.ts`) and the `explorerEvents` stream. See `docs/sidecar_explorer.md`.
- **`ExecutorEventBus`** / **`SubscriptionService`** (`services/SubscriptionService.ts`) —
  internal event bus that `skandha_subscribe` WebSocket clients tap into.
- **`ReputationService`** — ERC-7562-style stake/throttle/ban bookkeeping primitives, consulted by
  `MempoolService` and exposed via `debug_bundler_setReputation`/`dumpReputation`.

`Config` (`packages/executor/src/config.ts`) loads per-chain `NetworkConfig` from `config.json`
and/or `SKANDHA_*` env vars and exposes `getPublicClient()` (a viem `PublicClient`).

### API layer (`packages/api/src/app.ts`)

`ApiApp` is a thin RPC dispatcher: it registers one Fastify-style HTTP `POST /rpc/` route and
(optionally) a WebSocket `/rpc/` route, and switches on `method` to call into the `Executor`'s
modules (`eth`, `debug`, `web3`, `skandha`) declared in `packages/executor/src/modules/`. The real
RPC surface (`packages/api/src/constants.ts`) centers on `eth_sendFrameTransaction`,
`eth_estimateFrameTransactionGas`, `eth_getFrameTransactionByHash`,
`eth_getFrameTransactionReceipt`, `skandha_frameTransactionStatus`, `skandha_getGasPrice`,
`skandha_config`, `skandha_subscribe`/`unsubscribe`, and the `debug_bundler_*` admin methods
(gated to localhost/testingMode/admin-key requests). There is no ERC-4337 `eth_sendUserOperation`
or `eth_supportedEntryPoints`. When `redirectRpc` is enabled, whitelisted standard `eth_*` methods
are proxied straight to the underlying execution client RPC instead of being handled locally (see
`RedirectedRPCMethods`). All RPC results are passed through `deepHexlify` before being returned,
except `skandha_config`.

### P2P layer (`packages/node`)

`BundlerNode` composes a libp2p stack (gossipsub pubsub over a `frame_transaction_v2` topic, discv5
peer discovery, req/resp protocols — `PooledFrameTxHashes`, `PooledFrameTxsByHash`, `Status`,
`Ping`, `Goodbye`, `Metadata`, see `packages/node/src/network/reqresp/types.ts` — peer
scoring/banning; the wire format is versioned, see `P2P.md` §Wire format version) around the
same `api`+`executor` core used by standalone mode, so that frame transactions propagate across
bundler nodes before being relayed. See `P2P.md` for a manual
walkthrough of running a boot node + regular nodes against a local ethrex devnet.

### CLI entrypoint (`packages/cli`)

`packages/cli/src/cli.ts` → `cmds/standalone` (no P2P) or `cmds/node` (P2P) → each `handler.ts`
loads `Config`, opens the `IDbController`, constructs the `api.Server`, constructs an `Executor`
(standalone) or `BundlerNode` (node mode), and starts listening.
