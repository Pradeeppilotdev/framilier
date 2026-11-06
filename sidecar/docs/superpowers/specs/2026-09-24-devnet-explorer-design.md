# Devnet Explorer Design

Date: 2026-09-24
Status: Draft, awaiting review

## Goal

Give the team and demo audiences a web view of what a sidecar EIP-8141 instance is doing. A viewer
can answer four questions without curl or logs:

1. Why was my transaction accepted or rejected, rule by rule?
2. What is in the mempool right now?
3. What happened to a transaction: included, replaced, dropped?
4. Which instances have a transaction, and when did each first see it?

The explorer is internal. It is not published. A frame-transaction builder UI is a later
sub-project and is out of scope here.

## Scope

This spec covers two sub-projects. Each gets its own implementation plan.

1. **Backend observability**: records and a read-only RPC surface in the sidecar.
2. **Explorer UI**: a static web app that reads from one or more instances.

## Non-goals

- The frame-transaction builder (later; it will be built new, not forked from third-party code).
- Metrics and charts (Prometheus already covers metrics).
- Authentication beyond the `--explorer.enable` flag. The exposed data is already public gossip.
- Per-peer propagation tracking inside a node.
- Persisted history. History is in memory and a restart clears it.

## Decisions

| Topic | Decision |
|---|---|
| Location | Leaf workspace package `packages/devnet-ui`, last in the build chain. Not a git submodule. |
| Instances | One shared UI with an editable list of instance URLs. The main screen shows the selected instance. |
| Data access | New read-only `skandha_explorer_*` RPC methods. The UI never calls `debug_bundler_*`. |
| History | In-memory, bounded ring buffer, keyed by transaction hash. |
| Stack | Vite, React 19, TypeScript, Bun, TanStack Query and Router, Tailwind v4, zod. Components are hand-built (no component library); viem is added when the builder needs it. |

## Backend design (sub-project 1)

### Current gaps

- The event bus has three events (`pendingUserOps`, `submittedUserOps`, `onChainUserOps`), all tied
  to entries already in the mempool.
- A rejected transaction leaves no trace. The validator throws and only the RPC caller sees the error.
- A replaced entry disappears. The mempool key is `sender:nonce`, and replacement writes only a
  `logger.debug` line.
- Entries carry `status` and `submittedTime` but no reason for a cancel, revert or drop.

### ExplorerService

A new service in the executor subscribes to the event bus and receives new emit points at
admission (accept and reject), replacement, drop, and gossip receive. It keeps two records, both
keyed by transaction hash so that replaced and rejected transactions stay visible.

**AdmissionRecord**

| Field | Meaning |
|---|---|
| `txHash`, `sender`, `nonce` | Identity |
| `at` | Time the node first saw the transaction |
| `source` | `rpc`, `gossip:<peerId>` or `sync:<peerId>` |
| `outcome` | `accepted`, `rejected` or `replaced`. `replaced` is set on the old transaction's record when a newer one takes its `sender:nonce` slot. |
| `checks[]` | `{rule, frameIndex?, entity?, verdict: pass \| fail \| skipped, detail}` |

`at` and `source` are the first-seen record used for the cross-instance view.

**LifecycleEvent** (append-only ring buffer, default 10,000 events)

Fields: `seq` (monotonic), `txHash`, `at`, `kind`, `reason?`, `blockNumber?`.
Kinds: `admitted`, `rejected`, `replaced`, `statusChanged`, `dropped`, `included`.

### Validator change

`FrameTxValidationService` keeps throwing `RpcError` at its current sites, so callers see no
change. It also builds a `checks[]` list as it runs. Fatal early exits (structural, signature,
simulation revert) produce one failed check, and the remaining rules are marked `skipped`. Only
the ERC-7562 opcode and storage section can report several violations at once.

### Read API

Enabled by `--explorer.enable`. Read-only. Separate from `debug_bundler_*`.

| Method | Returns |
|---|---|
| `skandha_explorer_info` | Chain ID, version, bundling mode, `protocolVersion`, `latestSeq`, `oldestSeq` (a resume point below it has a gap), `bootId` (random per process start: a changed value means a restart, so all earlier `seq` values and history are invalid) |
| `skandha_explorer_listTransactions` | Paginated live mempool entries, filterable by status |
| `skandha_explorer_listAdmissions` | Paginated recent admissions, including rejected |
| `skandha_explorer_getTransaction(hash)` | Entry, admission record, lifecycle events |
| `skandha_explorer_peers` | Normalised peer list; empty in standalone mode |

The `skandha_subscribe` method gains a stream event that carries `LifecycleEvent`s. Clients resume
after a disconnect with `sinceSeq`.

The API server sends CORS headers on these methods, because the browser calls several instances
directly.

Explorer results are plain JSON: numbers are numbers, and quantities that can exceed 2^53 (nonce,
fees) are `0x` hex strings. They bypass the API's `deepHexlify`.

## UI design (sub-project 2)

### Screens

- **Top bar**: instance switcher and global transaction-hash search. The switcher edits the
  instance list (add, rename, remove) and shows a health indicator per instance. The selection
  persists.
- **Overview**: header for the selected instance (chain ID, bundling mode, peer count, protocol
  version) and a live mempool table with a status filter (sender, nonce, frames summary, age, fee).
- **Transaction detail**: frames breakdown (mode, flags, target, limits); the admission report as a
  per-rule checklist grouped by frame and entity; the lifecycle timeline; an **Across instances**
  panel that queries every listed instance for the hash and shows who has it, first-seen time and
  source.
- **Activity**: recent admissions, including rejected ones, each showing the failing rule.
- **Peers**: the selected instance's peer table.

### Architecture

- **RPC layer**: a typed JSON-RPC client per instance. Only the selected instance holds a
  WebSocket. Other instances are queried over HTTP on demand.
- **State**: TanStack Query cache keyed by `[instanceUrl, method, params]`. Stream events update or
  invalidate the cache. The instance list and selection live in a React context persisted to
  localStorage. No other global state library.
- **Protocol package**: explorer method types and runtime response validation. The UI checks
  `protocolVersion` and shows a compatibility banner on mismatch. If `@skandha/types` is not
  browser-safe, this is a new types-only package.
- **Routing**: `/tx/:hash?node=<url>`. A link with an unknown `node` offers to add it to the list.
- **Build and serve**: `bun run build` produces a static bundle. The API server can serve it under
  `/ui` when explorer is enabled. Any static host also works.

### Error states

| Condition | Message |
|---|---|
| Instance unreachable | Says so, with a CORS hint when the failure looks like one |
| "Method not found" | The node was not started with `--explorer.enable` |
| Protocol mismatch | Compatibility banner |
| Socket dropped | Reconnects automatically and resumes from `sinceSeq` |

An https-hosted UI cannot call http instances (mixed content). The devnet UI and nodes use the
same scheme, or the nodes sit behind TLS.

## Testing

- **Backend**: Vitest, run from `packages/executor` (see CLAUDE.md). Unit tests for `checks[]`
  construction per validator exit path, ring-buffer bounds, `seq` ordering, and read-method shapes.
- **UI**: Vitest for the RPC client, cache reducers, and rule-grouping logic. Playwright smoke
  tests run against a fixture-driven mock explorer server. The same mock is the development
  backend, so UI work does not need a running devnet.

## Open items

- Confirm whether `@skandha/types` is browser-safe. If not, add the types-only protocol package.
- Persisted history (RocksDB through `IDbController`) if the devnet needs history across restarts.
- The builder UI needs its own brainstorm and spec.
