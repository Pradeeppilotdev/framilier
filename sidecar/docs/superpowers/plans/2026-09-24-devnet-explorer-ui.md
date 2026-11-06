# Devnet Explorer UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/devnet-ui`, a static web explorer that shows, for a selected the sidecar EIP-8141 instance, its mempool, every admission (including rejections, rule by rule), the lifecycle of a transaction, its peers, and which of the user's other instances have a given transaction and when they first saw it.

**Architecture:** A Vite + React single-page app that talks straight to each node's read-only `skandha_explorer_*` JSON-RPC methods and its `explorerEvents` WebSocket stream. Every response is validated with zod against schemas that are compile-time-checked against the backend's wire types. Only the selected instance holds a WebSocket; a resumable stream client (`sinceSeq`, `bootId` restart check, history-gap check, backoff) feeds React Query invalidation. A fake explorer node with the real protocol behavior serves as the development backend and the browser-test target.

**Tech Stack:** Bun 1.2, Vite 8, React 19, TypeScript 5.9, TanStack Query 5 and Router 1 (code-based routes), Tailwind CSS 4 with hand-built components, zod 4, Vitest 5 (jsdom) and Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-09-24-devnet-explorer-design.md`, "UI design (sub-project 2)". The backend contract this plan consumes is `docs/sidecar_explorer.md` and `packages/types/src/explorer/index.ts` (branch `feat/devnet-explorer-backend`, PR forshtat/framepool#3).

## How this plan was produced

Every file below was written and verified first in a scratch project: **152 unit tests and 11 Playwright tests pass**, both type-check projects are clean, and the production build works. The tasks are cut so that each one, built from only the files created up to that point, type-checks and passes its cumulative test count on its own (8, 19, 33, 50, 72, 92, 105, 117, 122, 152 after Tasks 1 to 10). The code blocks in this plan are those verified files, verbatim. An implementer who changes them has to justify it with a failing test; "I would have written it differently" is not a reason.

## Branch and prerequisites

- Work on branch `feat/devnet-explorer-ui`, stacked on `feat/devnet-explorer-backend`, because the app imports the explorer wire types from `@skandha/types/lib/explorer/index.js`, which exist only on that branch. When PR #3 merges into `develop`, rebase this branch onto `develop`.
- In a fresh worktree run `bun install` at the repo root, then build the packages the executor's tests need: `types`, `db`, `utils`, `params`, `monitoring` (each `cd packages/<name> && bun run build`). Task 1 does this.
- All commands below are run from the worktree root unless a step says `cd packages/devnet-ui`.
- Commit messages end with these two lines:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
  ```

## Global Constraints

Copied from the spec, with the two amendments Task 1 records in the spec:

- Location: leaf workspace package `packages/devnet-ui`. Not a git submodule. It is not part of the root `build` chain.
- Stack: Vite, React 19, TypeScript, Bun, TanStack Query and Router, Tailwind v4. **Amended:** components are hand-built (no shadcn/ui), and there is no viem until the transaction builder needs it. zod does runtime response validation.
- One shared UI with an editable list of instance URLs; the main screen shows the selected instance. The list and selection persist in `localStorage`; no other global state library.
- Data comes only from the read-only `skandha_explorer_*` methods. The UI never calls `debug_bundler_*`.
- Only the selected instance holds a WebSocket. Other instances are queried over HTTP on demand.
- React Query keys start with the instance URL (`["x", url, ...]`) so one prefix invalidates or resets everything held for a node.
- The UI checks `protocolVersion` and shows a compatibility banner on mismatch. Responses are validated at runtime; unknown object keys are dropped and unknown rule ids, lifecycle kinds and statuses are tolerated.
- Routing: `/`, `/activity`, `/peers`, `/tx/:hash?node=<url>`. A link whose `node` is not in the list offers to add it.
- Error states, each with plain-language copy: instance unreachable (with a CORS hint), method not found (start the node with `--explorer.enable`), protocol mismatch, socket dropped (reconnect and resume from `sinceSeq`; a changed `bootId` or evicted history reloads and says so).
- Wire numbers are plain JSON numbers; nonce and fees are `0x` hex strings.
- The only `@skandha/types` import is the zero-import subpath `@skandha/types/lib/explorer/index.js`.
- Version pins are exact and were verified together. Do not "upgrade while you are there".
- Other packages' tests must keep passing after this package is installed (Task 1 checks it).

## Design direction

The subject is a mempool inspector for protocol engineers and devnet testers; its job is to answer "why was my transaction accepted or rejected, what is in the pool, what happened to it, and who has it". A frame transaction is an ordered strip of frames checked by rules, so the UI draws exactly that.

- **The memorable element is the frame strip** (`FrameStrip`): each frame is a block whose style says what it is (solid = verify, outlined = sender, dashed outline = default), with the verdict of every rule that checked it drawn beneath. Everything else stays quiet.
- **Color:** a cool "fog" ground (`#e9eef1`) with a petrol ink (`#12232e`), and one accent (`#2b49c4`). The saturated hues are only the verdicts (`pass #0b7a63`, `fail #c2263f`, `warn #8f5400`), so a failed rule is the loudest thing on any screen. A dark theme follows `prefers-color-scheme`. Verdicts are never color alone: a ringed tick (passed), a diamond cross (failed) and a dashed ring (not evaluated) differ in shape and always carry text.
- **Type:** Bricolage Grotesque for headings, Instrument Sans for text, Spline Sans Mono only for hashes, addresses and rule ids. All self-hosted through Fontsource, so the page needs no third-party request. Sentence case throughout; no all-caps labels.
- **Layout:** a persistent instance list on the left, the selected instance's views on the right, left-aligned, rules and whitespace instead of cards. Tables scroll inside their own container so the page never scrolls sideways at phone width.
- **Motion:** only where it answers an event: a row that just changed gets a fading wash and a static marker (the marker alone under `prefers-reduced-motion`).
- **Copy:** plain verbs; errors say what happened and what to try; empty screens say what to do.

## File structure

```
packages/devnet-ui/
  package.json  tsconfig.json  tsconfig.tools.json  vite.config.ts  playwright.config.ts
  index.html  README.md  .gitignore
  mock/                 fake explorer node: state.ts (pure), fixtures.ts, ports.ts, server.ts (Bun), dev.ts
  e2e/                  Playwright tests
  src/
    protocol/           zod schemas + compile-time guard against the backend types, version check
    rpc/                JSON-RPC client and error kinds; ExplorerStream (resumable WebSocket follower)
    instances/          instance list: pure reducer, URL normalization, tolerant persistence, React context
    data/               React Query keys/hooks, live feed (row highlights), provider that owns the stream
    logic/              pure: formatting, frame decoding, rule grouping
    ui/                 primitives (FrameStrip, VerdictMark, ...), shell/, screens/, tx/
    app.tsx  main.tsx  index.css  setupTests.ts  testUtils.tsx
```

## Review Focus

Failure modes the spec implies that a happy path would not exercise. Each is pinned by a test in the task named.

1. **A node that answers with things this version does not know:** unknown rule ids, lifecycle kinds or statuses, extra fields, a `null` entry, checks with no frame index. The page must render, not crash. (Tasks 1, 5, 8, 9, 10)
2. **A stream that misbehaves:** duplicate or out-of-order events, a drop mid-stream, a node restart, evicted history, an explorer that is off, switching instance while reconnecting, unmounting. No lost or doubled event, no leaked timer or socket. (Tasks 3, 7, 11)
3. **Hostile or broken input and storage:** blocked or corrupt `localStorage`, duplicate or malformed instance URLs written differently, junk typed into the hash search. (Tasks 4, 10)
4. **Users who cannot rely on color or a mouse:** verdicts differ by shape and text, focus is visible, motion respects `prefers-reduced-motion`, everything is reachable by keyboard. (Tasks 8, 10, 11)
5. **Long unbroken text:** a huge failure detail or revert reason must wrap inside its container, and no page may scroll sideways at 375 px. (Task 11)

## Not in this plan

- Serving the built app from the sidecar API server under `/ui` (the spec allows it; any static host works today). Deploying it to the public devnet is the next piece of work.
- The frame-transaction builder.
- Persisted history, charts, authentication.
- A collapsible instance list on phones (the list stacks above the content; noted as a follow-up).
- A dedicated accessibility audit tool (axe); the tests here pin the specific behaviors above.

---

### Task 1: Package scaffold and protocol schemas

**Files:**
- Create: `packages/devnet-ui/package.json`, `tsconfig.json`, `tsconfig.tools.json`, `vite.config.ts`, `.gitignore`, `src/setupTests.ts`
- Create: `packages/devnet-ui/src/protocol/schemas.ts`, `src/protocol/compat.ts`
- Test: `packages/devnet-ui/src/protocol/protocol.test.ts`
- Modify: `docs/superpowers/specs/2026-09-24-devnet-explorer-design.md` (stack row); `bun.lock` (generated by `bun install`)

**Interfaces:**
- Produces: `ExplorerInfoSchema`, `AdmissionRecordSchema`, `LifecycleEventSchema`, `TransactionSummarySchema`, `TransactionDetailSchema`, `PeerSchema`, `TransactionPageSchema`, `AdmissionPageSchema`, `PeerListSchema`, `SerializedFrameTxSchema`, the inferred types `Info`, `Admission`, `Check`, `LifecycleEventData`, `TransactionSummary`, `TransactionDetail`, `Peer`, `SerializedFrameTx`, `protocolGuards`; `SUPPORTED_PROTOCOL_VERSION`, `checkProtocol(info): Compat`.

- [ ] **Step 1: Prepare the worktree and confirm a green baseline**

From the worktree root:

```bash
bun install
(cd packages/types && bun run build)
(cd packages/db && bun run build)
(cd packages/utils && bun run build)
(cd packages/params && bun run build)
(cd packages/monitoring && bun run build)
(cd packages/executor && bunx vitest run test/services test/modules test/config.test.ts)
```

Expected: the executor run ends with `Test Files  22 passed (22)` and `Tests  212 passed (212)`. If it does not, stop: the baseline is not green and nothing below can be judged.

- [ ] **Step 2: Create the package configuration**

Create these files. The versions are exact and were verified together. Two pitfalls found while verifying, both handled by what is written here: do **not** add `@testing-library/jest-dom` (it hoists to the repo root and binds to the root's older `vitest`, so its matchers break), and import `describe`/`it`/`expect` from `"vitest"` explicitly in every test (never rely on globals), so they always resolve to this package's own Vitest.

**`packages/devnet-ui/package.json`**

```json
{
  "name": "@skandha/devnet-ui",
  "private": true,
  "version": "0.1.0",
  "description": "Explorer for the sidecar EIP-8141 instances (mempool, admission reports, lifecycle)",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "mock": "bun run mock/dev.ts",
    "build": "tsc --noEmit && tsc --noEmit -p tsconfig.tools.json && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.tools.json",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@fontsource-variable/bricolage-grotesque": "5.3.0",
    "@fontsource-variable/instrument-sans": "5.3.0",
    "@fontsource-variable/spline-sans-mono": "5.3.0",
    "@tanstack/react-query": "5.103.2",
    "@tanstack/react-router": "1.170.39",
    "clsx": "2.1.1",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@tailwindcss/vite": "4.3.3",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "bun-types": "1.2.19",
    "jsdom": "30.1.1",
    "tailwindcss": "4.3.3",
    "typescript": "5.9.3",
    "vite": "8.3.1",
    "vitest": "5.0.1"
  }
}
```

**`packages/devnet-ui/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "types": ["vite/client"]
  },
  "include": ["src", "mock/state.ts", "mock/fixtures.ts", "vite.config.ts"]
}
```

**`packages/devnet-ui/tsconfig.tools.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["bun-types"]
  },
  "include": ["mock", "e2e", "playwright.config.ts"]
}
```

**`packages/devnet-ui/vite.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.test.{ts,tsx}", "mock/**/*.test.ts"],
    css: false,
  },
});
```

**`packages/devnet-ui/.gitignore`**

```
dist
test-results
playwright-report
shots
```

**`packages/devnet-ui/src/setupTests.ts`**

```ts
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom does not implement scrollTo; the router calls it on navigation.
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
});
```


`tsconfig.json` lists `mock/state.ts` and `mock/fixtures.ts` in `include` before they exist; that is fine (an `include` entry that matches nothing is ignored) and keeps the file unchanged for the rest of the plan.

- [ ] **Step 3: Install and check the new package did not disturb the others**

```bash
bun install
grep -m1 '"version"' node_modules/vitest/package.json
grep -m1 '"version"' packages/devnet-ui/node_modules/vitest/package.json
grep -m1 '"version"' packages/devnet-ui/node_modules/typescript/package.json
(cd packages/executor && bunx vitest run test/services test/modules test/config.test.ts)
```

Expected: the root `vitest` is still `0.34.6`; the package's own are `5.0.1` and `5.9.3`; the executor run again ends with `22 passed` files and `212 passed` tests. If the executor run changes, stop and report it: the workspace install is not safe as specified.

- [ ] **Step 4: Write the failing tests**

**`packages/devnet-ui/src/protocol/protocol.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  AdmissionRecordSchema,
  ExplorerInfoSchema,
  LifecycleEventSchema,
  SerializedFrameTxSchema,
  TransactionDetailSchema,
  protocolGuards,
} from "./schemas";
import { SUPPORTED_PROTOCOL_VERSION, checkProtocol } from "./compat";

const admission = {
  id: 4,
  txHash: "0xaa",
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x2",
  at: 1760000000000,
  source: "gossip:16Uiu2HAm",
  outcome: "rejected",
  errorCode: -32502,
  checks: [
    { rule: "prefix", verdict: "pass" },
    {
      rule: "OP-011",
      frameIndex: 0,
      entity: "payer",
      verdict: "fail",
      detail: "payer uses banned opcode: DIFFICULTY",
    },
    { rule: "mempool", verdict: "skipped" },
  ],
};

const info = {
  protocolVersion: 1,
  chainId: 1337,
  version: "4.1.1",
  commit: "abc1234",
  bundlingMode: "auto",
  p2pEnabled: true,
  latestSeq: 9,
  oldestSeq: 1,
  historyCapacity: 10000,
  bootId: "0011223344556677",
};

describe("protocol schemas", () => {
  it("keeps the compile-time guard against the backend wire types", () => {
    expect(protocolGuards).toBe(true);
  });

  it("accepts a full admission record", () => {
    expect(AdmissionRecordSchema.parse(admission)).toEqual(admission);
  });

  it("drops unknown keys and tolerates unknown rule ids and lifecycle kinds", () => {
    const parsed = AdmissionRecordSchema.parse({
      ...admission,
      surprise: true,
      checks: [{ rule: "some-future-rule", verdict: "pass", extra: 1 }],
    });
    expect(parsed).not.toHaveProperty("surprise");
    expect(parsed.checks[0]).toEqual({ rule: "some-future-rule", verdict: "pass" });
    expect(
      LifecycleEventSchema.parse({ seq: 1, txHash: "0xaa", at: 1, kind: "brand-new-kind" }).kind,
    ).toBe("brand-new-kind");
  });

  it("rejects an unknown verdict and a missing bootId", () => {
    expect(
      AdmissionRecordSchema.safeParse({ ...admission, checks: [{ rule: "x", verdict: "maybe" }] })
        .success,
    ).toBe(false);
    const { bootId: _omit, ...withoutBootId } = info;
    expect(ExplorerInfoSchema.safeParse(withoutBootId).success).toBe(false);
    expect(ExplorerInfoSchema.safeParse(info).success).toBe(true);
  });

  it("accepts a detail with a null entry (a rejected transaction)", () => {
    const detail = { hash: "0xaa", entry: null, admission, events: [] };
    expect(TransactionDetailSchema.parse(detail).entry).toBeNull();
  });

  it("parses a serialized frame transaction and rejects a malformed one", () => {
    const tx = {
      chainId: "0x539",
      nonce: "0x1",
      sender: "0x1111111111111111111111111111111111111111",
      frames: [
        {
          mode: 1,
          flags: 3,
          target: null,
          limits: { execution: "0x7530", state: "0x0" },
          value: "0x0",
          data: "0x",
        },
      ],
      fees: { maxPriorityFeePerGas: "0x1", maxFeePerGas: "0x2", maxFeePerBlobGas: "0x0" },
    };
    expect(SerializedFrameTxSchema.safeParse(tx).success).toBe(true);
    expect(SerializedFrameTxSchema.safeParse({ ...tx, frames: [{ mode: "verify" }] }).success).toBe(
      false,
    );
  });
});

describe("checkProtocol", () => {
  it("accepts the supported version", () => {
    expect(checkProtocol({ protocolVersion: SUPPORTED_PROTOCOL_VERSION })).toEqual({ ok: true });
  });

  it("reports both versions on a mismatch", () => {
    expect(checkProtocol({ protocolVersion: 2 })).toEqual({
      ok: false,
      nodeVersion: 2,
      supported: SUPPORTED_PROTOCOL_VERSION,
    });
  });
});
```


- [ ] **Step 5: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run src/protocol
```

Expected: FAIL. The test file cannot load because `./schemas` and `./compat` do not exist (`Failed to load url ./schemas`).

- [ ] **Step 6: Write the implementation**

**`packages/devnet-ui/src/protocol/schemas.ts`**

```ts
import { z } from "zod";
import type {
  AdmissionRecord,
  ExplorerInfo,
  ExplorerPeer,
  ExplorerTransactionDetail,
  ExplorerTransactionSummary,
  LifecycleEvent,
  RuleCheck,
} from "@skandha/types/lib/explorer/index.js";

/**
 * Runtime validation of explorer responses. The UI talks to instances that may
 * run different versions, so every response is checked. Unknown object keys are
 * dropped; unknown string values in open-ended fields (rule ids, lifecycle
 * kinds, statuses) are accepted so a newer node does not break an older UI.
 */

export const RuleCheckSchema = z.object({
  rule: z.string(),
  frameIndex: z.number().int().nonnegative().optional(),
  entity: z.enum(["sender", "payer", "factory"]).optional(),
  verdict: z.enum(["pass", "fail", "skipped"]),
  detail: z.string().optional(),
});

export const AdmissionRecordSchema = z.object({
  id: z.number(),
  txHash: z.string(),
  sender: z.string(),
  nonce: z.string(),
  at: z.number(),
  source: z.string(),
  outcome: z.enum(["accepted", "rejected", "replaced"]),
  errorCode: z.number().optional(),
  checks: z.array(RuleCheckSchema),
});

export const LifecycleEventSchema = z.object({
  seq: z.number(),
  txHash: z.string(),
  at: z.number(),
  kind: z.string(),
  status: z.string().optional(),
  reason: z.string().optional(),
  blockNumber: z.number().optional(),
});

export const ExplorerInfoSchema = z.object({
  protocolVersion: z.number(),
  chainId: z.number(),
  version: z.string(),
  commit: z.string(),
  bundlingMode: z.string(),
  p2pEnabled: z.boolean(),
  latestSeq: z.number(),
  oldestSeq: z.number(),
  historyCapacity: z.number(),
  bootId: z.string(),
});

export const TransactionSummarySchema = z.object({
  txHash: z.string(),
  sender: z.string(),
  payer: z.string(),
  factory: z.string().optional(),
  nonce: z.string(),
  status: z.string(),
  frames: z.number(),
  maxFeePerGas: z.string(),
  submittedTime: z.number().optional(),
  lastUpdatedTime: z.number(),
});

export const TransactionEntrySchema = TransactionSummarySchema.extend({
  tx: z.record(z.string(), z.unknown()),
  revertReason: z.string().optional(),
  transaction: z.string().optional(),
});

export const TransactionDetailSchema = z.object({
  hash: z.string(),
  entry: TransactionEntrySchema.nullable(),
  admission: AdmissionRecordSchema.nullable(),
  events: z.array(LifecycleEventSchema),
});

export const PeerSchema = z.object({
  peerId: z.string(),
  direction: z.string(),
  connectedAt: z.number(),
  lastReceivedAt: z.number(),
  agentVersion: z.string().nullable(),
  supportedMempools: z.array(z.string()),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
  });
}

export const TransactionPageSchema = pageSchema(TransactionSummarySchema);
export const AdmissionPageSchema = pageSchema(AdmissionRecordSchema);
export const PeerListSchema = z.array(PeerSchema);

/** The serialized frame transaction inside `getTransaction().entry.tx`. */
export const SerializedFrameTxSchema = z.object({
  chainId: z.string(),
  nonce: z.string(),
  sender: z.string(),
  frames: z.array(
    z.object({
      mode: z.number(),
      flags: z.number(),
      target: z.string().nullable(),
      limits: z.object({ execution: z.string(), state: z.string() }),
      value: z.string(),
      data: z.string(),
    }),
  ),
  fees: z.object({
    maxPriorityFeePerGas: z.string(),
    maxFeePerGas: z.string(),
    maxFeePerBlobGas: z.string(),
  }),
});

export type SerializedFrameTx = z.infer<typeof SerializedFrameTxSchema>;
export type Info = z.infer<typeof ExplorerInfoSchema>;
export type TransactionSummary = z.infer<typeof TransactionSummarySchema>;
export type TransactionDetail = z.infer<typeof TransactionDetailSchema>;
export type Admission = z.infer<typeof AdmissionRecordSchema>;
export type LifecycleEventData = z.infer<typeof LifecycleEventSchema>;
export type Peer = z.infer<typeof PeerSchema>;
export type Check = z.infer<typeof RuleCheckSchema>;
export type TransactionPage = z.infer<typeof TransactionPageSchema>;
export type AdmissionPage = z.infer<typeof AdmissionPageSchema>;

// Compile-time guard: everything the backend's wire types can emit must be
// accepted by these schemas. If a field is added or renamed in
// `@skandha/types/lib/explorer`, this file stops compiling.
type Accepts<Schema, Wire> = [Wire] extends [Schema] ? true : false;
type AllTrue<T extends boolean[]> = false extends T[number] ? false : true;
export const protocolGuards: AllTrue<
  [
    Accepts<Check, RuleCheck>,
    Accepts<Admission, AdmissionRecord>,
    Accepts<LifecycleEventData, LifecycleEvent>,
    Accepts<Info, ExplorerInfo>,
    Accepts<TransactionSummary, ExplorerTransactionSummary>,
    Accepts<TransactionDetail, ExplorerTransactionDetail>,
    Accepts<Peer, ExplorerPeer>,
  ]
> = true;
```

**`packages/devnet-ui/src/protocol/compat.ts`**

```ts
import { EXPLORER_PROTOCOL_VERSION } from "@skandha/types/lib/explorer/index.js";

/** The explorer protocol version this app understands. */
export const SUPPORTED_PROTOCOL_VERSION = EXPLORER_PROTOCOL_VERSION;

export type Compat =
  | { ok: true }
  | { ok: false; nodeVersion: number; supported: number };

export function checkProtocol(info: { protocolVersion: number }): Compat {
  return info.protocolVersion === SUPPORTED_PROTOCOL_VERSION
    ? { ok: true }
    : {
        ok: false,
        nodeVersion: info.protocolVersion,
        supported: SUPPORTED_PROTOCOL_VERSION,
      };
}
```


- [ ] **Step 7: Run the tests and the type-check**

```bash
cd packages/devnet-ui && bunx vitest run src/protocol && bunx tsc --noEmit
```

Expected: `Tests  8 passed (8)`; `tsc` prints nothing.

- [ ] **Step 8: Record the stack amendment in the spec**

In `docs/superpowers/specs/2026-09-24-devnet-explorer-design.md`, replace the row

```
| Stack | Vite, React 19, TypeScript, Bun, TanStack Query and Router, Tailwind v4, shadcn/ui, viem. |
```

with

```
| Stack | Vite, React 19, TypeScript, Bun, TanStack Query and Router, Tailwind v4, zod. Components are hand-built (no component library); viem is added when the builder needs it. |
```

- [ ] **Step 9: Commit**

```bash
git add packages/devnet-ui bun.lock docs/superpowers/specs/2026-09-24-devnet-explorer-design.md
git commit -m "$(cat <<'EOF'
feat(devnet-ui): package scaffold and validated explorer protocol schemas

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

- [ ] **Step 10: Prove the compile-time guard bites**

The guard at the bottom of `schemas.ts` is worthless if it can never fail. Add a required field to `ExplorerInfoSchema` with your editor (a line `bogusFutureField: z.string(),` right after `bootId: z.string(),`), then:

```bash
cd packages/devnet-ui && bunx tsc --noEmit; echo "exit: $?"
```

Expected: `error TS2322: Type 'true' is not assignable to type 'false'` and a non-zero exit. Restore the file and confirm nothing changed:

```bash
git checkout -- packages/devnet-ui/src/protocol/schemas.ts
cd packages/devnet-ui && bunx tsc --noEmit; echo "exit: $?"
git status --short
```

Expected: `exit: 0` and no output from `git status`.

---

### Task 2: JSON-RPC client and error kinds

**Files:**
- Create: `packages/devnet-ui/src/rpc/errors.ts`, `src/rpc/client.ts`, `src/rpc/methods.ts`
- Test: `packages/devnet-ui/src/rpc/rpc.test.ts`

**Interfaces:**
- Consumes: the schemas from Task 1.
- Produces: `rpcCall(url, method, params, schema, opts)`; error classes `UnreachableError`, `ExplorerDisabledError`, `ProtocolError`, `RpcMethodError`, `HttpStatusError`; `describeError(err, url): ErrorNotice`; `explorerApi.{info, listTransactions, listAdmissions, getTransaction, peers}`.

The sidecar API answers a failed call with HTTP 200 and `{ error: { message, data, code } }`, and an unexpected crash with a 5xx and `{ error: "<string>" }`; the client handles both, plus proxy error pages that are not JSON.

- [ ] **Step 1: Write the failing tests**

**`packages/devnet-ui/src/rpc/rpc.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { rpcCall } from "./client";
import {
  ExplorerDisabledError,
  HttpStatusError,
  ProtocolError,
  RpcMethodError,
  UnreachableError,
  describeError,
} from "./errors";
import { explorerApi } from "./methods";

const URL_ = "https://node.example/rpc";
const Schema = z.object({ n: z.number() });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("rpcCall", () => {
  it("posts a JSON-RPC request and returns the validated result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { n: 7 } }));
    const result = await rpcCall(URL_, "m", ["a"], Schema, { fetchImpl });
    expect(result).toEqual({ n: 7 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ jsonrpc: "2.0", method: "m", params: ["a"] });
  });

  it("maps a network failure to UnreachableError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(rpcCall(URL_, "m", [], Schema, { fetchImpl })).rejects.toBeInstanceOf(
      UnreachableError,
    );
  });

  it("rethrows an abort instead of calling it unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(rpcCall(URL_, "m", [], Schema, { fetchImpl })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("maps -32601 to ExplorerDisabledError", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { message: "off", code: -32601 } }),
    );
    await expect(rpcCall(URL_, "m", [], Schema, { fetchImpl })).rejects.toBeInstanceOf(
      ExplorerDisabledError,
    );
  });

  it("maps another JSON-RPC error to RpcMethodError with its code", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { message: "Frame transaction not found", code: -32600 } }),
    );
    await expect(rpcCall(URL_, "m", [], Schema, { fetchImpl })).rejects.toMatchObject({
      name: "RpcMethodError",
      code: -32600,
      message: "Frame transaction not found",
    });
  });

  it("maps a 500 with a string error to HttpStatusError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Unexpected behaviour" }, 500));
    await expect(rpcCall(URL_, "m", [], Schema, { fetchImpl })).rejects.toEqual(
      new HttpStatusError(500),
    );
  });

  it("maps a non-JSON proxy error page to HttpStatusError, and non-JSON 200 to ProtocolError", async () => {
    const proxy = vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(rpcCall(URL_, "m", [], Schema, { fetchImpl: proxy })).rejects.toBeInstanceOf(
      HttpStatusError,
    );
    const odd = vi.fn(async () => new Response("hello", { status: 200 }));
    await expect(rpcCall(URL_, "m", [], Schema, { fetchImpl: odd })).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it("maps a result that fails validation to ProtocolError naming the field", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: { n: "x" } }));
    await expect(rpcCall(URL_, "m", [], Schema, { fetchImpl })).rejects.toMatchObject({
      name: "ProtocolError",
      detail: expect.stringContaining("n:"),
    });
  });

  it("maps a missing result to ProtocolError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1 }));
    await expect(rpcCall(URL_, "m", [], Schema, { fetchImpl })).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });
});

describe("explorerApi", () => {
  it("calls the five explorer methods with the documented parameters", async () => {
    const seen: Array<{ method: string; params: unknown[] }> = [];
    const results: Record<string, unknown> = {
      skandha_explorer_info: {
        protocolVersion: 1, chainId: 1337, version: "1", commit: "c", bundlingMode: "auto",
        p2pEnabled: false, latestSeq: 0, oldestSeq: 0, historyCapacity: 10, bootId: "b",
      },
      skandha_explorer_listTransactions: { items: [] },
      skandha_explorer_listAdmissions: { items: [] },
      skandha_explorer_getTransaction: { hash: "0xaa", entry: null, admission: null, events: [] },
      skandha_explorer_peers: [],
    };
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      seen.push({ method: body.method, params: body.params });
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: results[body.method] });
    });
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch };

    await explorerApi.info(URL_, opts);
    await explorerApi.listTransactions(URL_, { status: "New", limit: 5 }, opts);
    await explorerApi.listAdmissions(URL_, { outcome: "rejected", cursor: "3" }, opts);
    await explorerApi.getTransaction(URL_, "0xaa", opts);
    await explorerApi.peers(URL_, opts);

    expect(seen).toEqual([
      { method: "skandha_explorer_info", params: [] },
      { method: "skandha_explorer_listTransactions", params: [{ status: "New", limit: 5 }] },
      { method: "skandha_explorer_listAdmissions", params: [{ outcome: "rejected", cursor: "3" }] },
      { method: "skandha_explorer_getTransaction", params: ["0xaa"] },
      { method: "skandha_explorer_peers", params: [] },
    ]);
  });
});

describe("describeError", () => {
  it("gives each failure a title and a next step", () => {
    expect(describeError(new UnreachableError(URL_), URL_)).toMatchObject({
      kind: "unreachable",
      title: "Couldn't reach node.example",
      hint: expect.stringContaining("--api.cors"),
    });
    expect(describeError(new ExplorerDisabledError(), URL_)).toMatchObject({
      kind: "disabled",
      hint: expect.stringContaining("--explorer.enable"),
    });
    expect(describeError(new ProtocolError("nonce: Invalid input"), URL_)).toMatchObject({
      kind: "protocol",
      hint: "nonce: Invalid input",
    });
    expect(describeError(new HttpStatusError(502), URL_).title).toContain("502");
    expect(describeError(new RpcMethodError("Bad hash", -32600), URL_)).toMatchObject({
      kind: "rpc",
      title: "Bad hash",
    });
    expect(describeError("weird", URL_)).toMatchObject({ kind: "unknown", hint: "weird" });
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run src/rpc/rpc.test.ts
```

Expected: FAIL (`Failed to load url ./client`).

- [ ] **Step 3: Write the implementation**

**`packages/devnet-ui/src/rpc/errors.ts`**

```ts
/**
 * The ways an explorer request can fail, kept apart so the UI can say what to
 * do about each one.
 */

export class UnreachableError extends Error {
  readonly kind = "unreachable" as const;
  constructor(
    readonly url: string,
    cause?: unknown,
  ) {
    super(`Could not reach ${url}`, { cause });
    this.name = "UnreachableError";
  }
}

/** JSON-RPC "method not found": the node is off, or predates, the explorer. */
export class ExplorerDisabledError extends Error {
  readonly kind = "disabled" as const;
  constructor() {
    super("The explorer is not available on this node");
    this.name = "ExplorerDisabledError";
  }
}

export class ProtocolError extends Error {
  readonly kind = "protocol" as const;
  constructor(readonly detail: string) {
    super(`Unexpected explorer response: ${detail}`);
    this.name = "ProtocolError";
  }
}

export class RpcMethodError extends Error {
  readonly kind = "rpc" as const;
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcMethodError";
  }
}

export class HttpStatusError extends Error {
  readonly kind = "http" as const;
  constructor(readonly status: number) {
    super(`The node answered HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

export interface ErrorNotice {
  kind: "unreachable" | "disabled" | "protocol" | "rpc" | "http" | "unknown";
  title: string;
  hint: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Turns any error into plain-language copy for a banner or an inline message. */
export function describeError(err: unknown, url: string): ErrorNotice {
  if (err instanceof UnreachableError) {
    return {
      kind: "unreachable",
      title: `Couldn't reach ${hostOf(url)}`,
      hint: "Check that the node is running and that the URL ends in /rpc. If the node is on another origin, it must allow this page's origin (--api.cors).",
    };
  }
  if (err instanceof ExplorerDisabledError) {
    return {
      kind: "disabled",
      title: "The explorer isn't available on this node",
      hint: "Start the sidecar with --explorer.enable. Nodes older than the explorer don't have it.",
    };
  }
  if (err instanceof ProtocolError) {
    return {
      kind: "protocol",
      title: "This node's answer doesn't match the explorer protocol",
      hint: err.detail,
    };
  }
  if (err instanceof RpcMethodError) {
    return { kind: "rpc", title: err.message, hint: `Error code ${err.code}.` };
  }
  if (err instanceof HttpStatusError) {
    return {
      kind: "http",
      title: `The node answered HTTP ${err.status}`,
      hint: "It may sit behind a proxy that doesn't forward /rpc to the sidecar.",
    };
  }
  return {
    kind: "unknown",
    title: "Something went wrong",
    hint: err instanceof Error ? err.message : String(err),
  };
}
```

**`packages/devnet-ui/src/rpc/client.ts`**

```ts
import type { z } from "zod";
import {
  ExplorerDisabledError,
  HttpStatusError,
  ProtocolError,
  RpcMethodError,
  UnreachableError,
} from "./errors";

export interface RpcOptions {
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const METHOD_NOT_FOUND = -32601;
let requestId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeIssues(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "The response did not match the expected shape.";
  const path = first.path.length > 0 ? first.path.join(".") : "response";
  return `${path}: ${first.message}`;
}

/**
 * One JSON-RPC call over HTTP. The sidecar API answers a failed call with HTTP
 * 200 and `{ error: { message, data, code } }`, and an unexpected crash with a
 * 5xx and `{ error: "<string>" }`; both are handled here.
 */
export async function rpcCall<S extends z.ZodType>(
  url: string,
  method: string,
  params: unknown[],
  schema: S,
  opts: RpcOptions = {},
): Promise<z.output<S>> {
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new UnreachableError(url, err);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) throw new HttpStatusError(res.status);
    throw new ProtocolError("The response was not JSON.");
  }
  const record = isRecord(body) ? body : {};

  if (record.error !== undefined) {
    const failure = record.error;
    if (isRecord(failure)) {
      const code = typeof failure.code === "number" ? failure.code : 0;
      if (code === METHOD_NOT_FOUND) throw new ExplorerDisabledError();
      const message = typeof failure.message === "string" ? failure.message : "The request failed";
      throw new RpcMethodError(message, code, failure.data);
    }
    if (!res.ok) throw new HttpStatusError(res.status);
    throw new RpcMethodError(String(failure), 0);
  }
  if (!res.ok) throw new HttpStatusError(res.status);
  if (!("result" in record)) throw new ProtocolError("The response had no result.");

  const parsed = schema.safeParse(record.result);
  if (!parsed.success) throw new ProtocolError(summarizeIssues(parsed.error));
  return parsed.data;
}
```

**`packages/devnet-ui/src/rpc/methods.ts`**

```ts
import { rpcCall, type RpcOptions } from "./client";
import {
  AdmissionPageSchema,
  ExplorerInfoSchema,
  PeerListSchema,
  TransactionDetailSchema,
  TransactionPageSchema,
} from "../protocol/schemas";

export interface ListTransactionsParams {
  status?: string;
  cursor?: string;
  limit?: number;
}

export interface ListAdmissionsParams {
  outcome?: "accepted" | "rejected" | "replaced";
  cursor?: string;
  limit?: number;
}

/** Typed wrappers for the five read-only `skandha_explorer_*` methods. */
export const explorerApi = {
  info: (url: string, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_info", [], ExplorerInfoSchema, opts),

  listTransactions: (url: string, params: ListTransactionsParams = {}, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_listTransactions", [params], TransactionPageSchema, opts),

  listAdmissions: (url: string, params: ListAdmissionsParams = {}, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_listAdmissions", [params], AdmissionPageSchema, opts),

  getTransaction: (url: string, hash: string, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_getTransaction", [hash], TransactionDetailSchema, opts),

  peers: (url: string, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_peers", [], PeerListSchema, opts),
};
```


- [ ] **Step 4: Run the tests and the type-check**

```bash
cd packages/devnet-ui && bunx vitest run && bunx tsc --noEmit
```

Expected: `Test Files  2 passed (2)`, `Tests  19 passed (19)` (8 protocol + 11 rpc); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/devnet-ui/src/rpc
git commit -m "$(cat <<'EOF'
feat(devnet-ui): JSON-RPC client with typed explorer methods and error kinds

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 3: Resumable event stream

**Files:**
- Create: `packages/devnet-ui/src/rpc/stream.ts`
- Test: `packages/devnet-ui/src/rpc/stream.test.ts`

**Interfaces:**
- Consumes: `LifecycleEventSchema`, `Info` (Task 1).
- Produces: `ExplorerStream` (`start()`, `stop()`), `StreamCallbacks` (`onEvent`, `onStatus`, `onReset`, `onFatal`), `StreamDeps` (`createSocket`, `fetchInfo`, `setTimer`, `clearTimer`), `SocketLike`, `StreamStatus`, `ResetReason`.

On every (re)connect the stream reads `info` first. A different `bootId` means the node restarted (its `seq` restarted too); `lastSeq + 1 < oldestSeq` means the node evicted events this client never saw. Either way the caller is told to reload and the stream resumes from the node's current `latestSeq`. Otherwise it resumes from the last delivered `seq`. Sockets and timers are injected so every branch is testable.

- [ ] **Step 1: Write the failing tests**

**`packages/devnet-ui/src/rpc/stream.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerStream, type SocketLike, type StreamStatus } from "./stream";
import type { Info, LifecycleEventData } from "../protocol/schemas";

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop() {
    this.onclose?.({});
  }
  get subscribeParams(): unknown[] {
    return JSON.parse(this.sent[0] ?? "{}").params;
  }
}

const info = (over: Partial<Info> = {}): Info => ({
  protocolVersion: 1,
  chainId: 1337,
  version: "1",
  commit: "c",
  bundlingMode: "auto",
  p2pEnabled: false,
  latestSeq: 10,
  oldestSeq: 1,
  historyCapacity: 10000,
  bootId: "boot-a",
  ...over,
});

const event = (seq: number): LifecycleEventData => ({
  seq,
  txHash: `0x${seq}`,
  at: 1000 + seq,
  kind: "admitted",
});

const notification = (e: LifecycleEventData, subscription = "sub") => ({
  jsonrpc: "2.0",
  method: "skandha_subscription",
  params: { subscription, result: e },
});

function setup(infos: Array<Info | Error>) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const statuses: StreamStatus[] = [];
  const events: LifecycleEventData[] = [];
  const resets: string[] = [];
  const fatal: string[] = [];
  const queue = [...infos];
  const fetchInfo = vi.fn(async () => {
    const next = queue.shift() ?? infos[infos.length - 1];
    if (next instanceof Error) throw next;
    return next as Info;
  });
  const stream = new ExplorerStream(
    "ws://node/rpc",
    {
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      fetchInfo,
      setTimer: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        (h as { live: boolean }).live = false;
      },
    },
    {
      onEvent: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      onReset: (r) => resets.push(r),
      onFatal: (m) => fatal.push(m),
    },
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const fireTimer = async () => {
    const t = timers.find((x) => x.live);
    if (!t) throw new Error("no pending timer");
    t.live = false;
    t.fn();
    await flush();
  };
  return { stream, sockets, timers, statuses, events, resets, fatal, fetchInfo, flush, fireTimer };
}

describe("ExplorerStream", () => {
  let ctx: ReturnType<typeof setup>;

  describe("first connection", () => {
    beforeEach(async () => {
      ctx = setup([info({ latestSeq: 10 })]);
      ctx.stream.start();
      await ctx.flush();
    });

    it("reads info, opens the socket and subscribes from the node's latestSeq", () => {
      expect(ctx.statuses).toEqual(["connecting"]);
      expect(ctx.sockets).toHaveLength(1);
      expect(ctx.sockets[0]?.url).toBe("ws://node/rpc");
      ctx.sockets[0]?.open();
      expect(ctx.sockets[0]?.subscribeParams).toEqual(["explorerEvents", 10]);
    });

    it("goes live when the subscription is acknowledged", () => {
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      expect(ctx.statuses).toEqual(["connecting", "live"]);
    });

    it("delivers newer events once, ignoring duplicates, older seqs and malformed notifications", () => {
      const s = ctx.sockets[0]!;
      s.open();
      s.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      s.receive(notification(event(11)));
      s.receive(notification(event(11)));
      s.receive(notification(event(9)));
      s.receive(notification({ seq: "x" } as unknown as LifecycleEventData));
      s.receive({ jsonrpc: "2.0", method: "other", params: {} });
      s.onmessage?.({ data: "not json" });
      s.onmessage?.({ data: 42 });
      s.receive(notification(event(12)));
      expect(ctx.events.map((e) => e.seq)).toEqual([11, 12]);
    });
  });

  describe("reconnecting", () => {
    it("resumes from the last delivered seq when the node is unchanged", async () => {
      ctx = setup([info({ latestSeq: 10 }), info({ latestSeq: 14 })]);
      ctx.stream.start();
      await ctx.flush();
      const first = ctx.sockets[0]!;
      first.open();
      first.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      first.receive(notification(event(11)));
      first.drop();
      expect(ctx.statuses.at(-1)).toBe("reconnecting");
      expect(ctx.timers[0]?.ms).toBe(1000);

      await ctx.fireTimer();
      expect(ctx.sockets).toHaveLength(2);
      ctx.sockets[1]?.open();
      expect(ctx.sockets[1]?.subscribeParams).toEqual(["explorerEvents", 11]);
      expect(ctx.resets).toEqual([]);
    });

    it("asks the caller to reload when bootId changed, and resumes from the new latestSeq", async () => {
      ctx = setup([info({ bootId: "boot-a", latestSeq: 10 }), info({ bootId: "boot-b", latestSeq: 2 })]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive(notification(event(11)));
      ctx.sockets[0]?.drop();
      await ctx.fireTimer();
      expect(ctx.resets).toEqual(["restart"]);
      ctx.sockets[1]?.open();
      expect(ctx.sockets[1]?.subscribeParams).toEqual(["explorerEvents", 2]);
    });

    it("asks the caller to reload when the node evicted events it never saw", async () => {
      ctx = setup([info({ latestSeq: 10, oldestSeq: 1 }), info({ latestSeq: 500, oldestSeq: 300 })]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive(notification(event(11)));
      ctx.sockets[0]?.drop();
      await ctx.fireTimer();
      expect(ctx.resets).toEqual(["gap"]);
      ctx.sockets[1]?.open();
      expect(ctx.sockets[1]?.subscribeParams).toEqual(["explorerEvents", 500]);
    });

    it.each([
      ["an empty history (oldestSeq 0)", { latestSeq: 0, oldestSeq: 0 }],
      ["a resume point right at the oldest retained event", { latestSeq: 40, oldestSeq: 11 }],
    ])("does not reset for %s", async (_name, second) => {
      ctx = setup([info({ latestSeq: 10 }), info(second)]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.drop();
      await ctx.fireTimer();
      expect(ctx.resets).toEqual([]);
    });

    it("backs off while info fails, reports offline after three failures, then recovers", async () => {
      const down = new Error("down");
      ctx = setup([info(), down, down, down, info({ latestSeq: 10 })]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      ctx.sockets[0]?.drop();
      expect(ctx.timers.map((t) => t.ms)).toEqual([1000]);

      await ctx.fireTimer();
      await ctx.fireTimer();
      await ctx.fireTimer();
      expect(ctx.timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000]);
      expect(ctx.statuses.at(-1)).toBe("offline");

      await ctx.fireTimer();
      ctx.sockets[1]?.open();
      ctx.sockets[1]?.receive({ jsonrpc: "2.0", id: 1, result: "sub" });
      expect(ctx.statuses.at(-1)).toBe("live");
    });

    it("caps the backoff at 15 seconds", async () => {
      const down = new Error("down");
      ctx = setup([info(), down]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.drop();
      for (let i = 0; i < 7; i++) await ctx.fireTimer();
      expect(Math.max(...ctx.timers.map((t) => t.ms))).toBe(15000);
    });
  });

  describe("failures and shutdown", () => {
    it("stops retrying and reports fatal when the explorer is off", async () => {
      ctx = setup([info()]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({
        jsonrpc: "2.0",
        id: 1,
        message: "Explorer is disabled: start the node with --explorer.enable",
      });
      expect(ctx.fatal).toEqual(["Explorer is disabled: start the node with --explorer.enable"]);
      expect(ctx.statuses.at(-1)).toBe("offline");
      expect(ctx.timers).toHaveLength(0);
      expect(ctx.sockets[0]?.closed).toBe(true);
    });

    it("retries after a subscribe error that is not about the explorer", async () => {
      ctx = setup([info(), info()]);
      ctx.stream.start();
      await ctx.flush();
      ctx.sockets[0]?.open();
      ctx.sockets[0]?.receive({ jsonrpc: "2.0", id: 1, error: "Internal server error" });
      expect(ctx.fatal).toEqual([]);
      expect(ctx.timers).toHaveLength(1);
    });

    it("stop() closes the socket, cancels a pending retry and silences callbacks", async () => {
      ctx = setup([info(), info()]);
      ctx.stream.start();
      await ctx.flush();
      const s = ctx.sockets[0]!;
      s.open();
      s.drop();
      expect(ctx.timers).toHaveLength(1);
      ctx.stream.stop();
      expect(ctx.timers[0]?.live).toBe(false);

      const before = ctx.statuses.length;
      s.receive(notification(event(50)));
      expect(ctx.events).toEqual([]);
      expect(ctx.statuses.length).toBe(before);
    });

    it("stop() while a socket is open closes it and ignores its later close event", async () => {
      ctx = setup([info()]);
      ctx.stream.start();
      await ctx.flush();
      const s = ctx.sockets[0]!;
      s.open();
      ctx.stream.stop();
      expect(s.closed).toBe(true);
      s.drop();
      expect(ctx.timers).toHaveLength(0);
    });
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run src/rpc/stream.test.ts
```

Expected: FAIL (`Failed to load url ./stream`).

- [ ] **Step 3: Write the implementation**

**`packages/devnet-ui/src/rpc/stream.ts`**

```ts
import { LifecycleEventSchema, type Info, type LifecycleEventData } from "../protocol/schemas";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline";

/** Why the caller must reload everything it holds for this node. */
export type ResetReason = "restart" | "gap";

export interface StreamCallbacks {
  onEvent(event: LifecycleEventData): void;
  onStatus(status: StreamStatus): void;
  /** The node restarted (`bootId` changed) or evicted events the client never saw. */
  onReset(reason: ResetReason): void;
  /** Subscribing failed in a way retrying will not fix, for example the explorer is off. */
  onFatal(message: string): void;
}

/** The subset of `WebSocket` the stream uses, so tests can fake it. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface StreamDeps {
  createSocket(url: string): SocketLike;
  fetchInfo(): Promise<Info>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const SUBSCRIBE_ID = 1;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;
/** After this many failed reconnects the status becomes "offline" (retries continue). */
const OFFLINE_AFTER_ATTEMPTS = 3;

/**
 * Follows one node's `explorerEvents` stream and keeps it correct across
 * reconnects. On every (re)connect it reads `info` first:
 *  - a different `bootId` means the node restarted, so `seq` restarted too;
 *  - `lastSeq + 1 < oldestSeq` means the node evicted events this client never
 *    saw;
 * either way the caller is told to reload (`onReset`) and the stream resumes
 * from the node's current `latestSeq`. Otherwise it resumes from `lastSeq`.
 */
export class ExplorerStream {
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private stopped = true;
  private attempt = 0;
  private bootId: string | null = null;
  private lastSeq = 0;

  constructor(
    private readonly url: string,
    private readonly deps: StreamDeps,
    private readonly callbacks: StreamCallbacks,
  ) {}

  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.bootId = null;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    this.detach();
  }

  private detach(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.callbacks.onStatus(this.bootId === null ? "connecting" : "reconnecting");

    let info: Info;
    try {
      info = await this.deps.fetchInfo();
    } catch {
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;

    if (this.bootId === null) {
      this.lastSeq = info.latestSeq;
    } else if (info.bootId !== this.bootId) {
      this.lastSeq = info.latestSeq;
      this.callbacks.onReset("restart");
    } else if (this.lastSeq + 1 < info.oldestSeq) {
      this.lastSeq = info.latestSeq;
      this.callbacks.onReset("gap");
    }
    this.bootId = info.bootId;
    this.open();
  }

  private open(): void {
    const socket = this.deps.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: SUBSCRIBE_ID,
          method: "skandha_subscribe",
          params: ["explorerEvents", this.lastSeq],
        }),
      );
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onclose = () => {
      if (this.socket === socket) this.lost();
    };
    socket.onerror = () => {
      // A close event follows; reconnecting is handled there.
    };
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;

    if (record.id === SUBSCRIBE_ID) {
      if ("result" in record) {
        this.attempt = 0;
        this.callbacks.onStatus("live");
        return;
      }
      // WebSocket errors arrive as `{ message }` or `{ error: "text" }`, without a code.
      const text = String(record.message ?? record.error ?? "Subscription failed");
      if (/explorer/i.test(text)) {
        this.stopped = true;
        this.detach();
        this.callbacks.onFatal(text);
        this.callbacks.onStatus("offline");
        return;
      }
      this.lost();
      return;
    }

    if (record.method !== "skandha_subscription") return;
    const params = record.params;
    if (typeof params !== "object" || params === null) return;
    const parsed = LifecycleEventSchema.safeParse((params as Record<string, unknown>).result);
    if (!parsed.success) return;
    if (parsed.data.seq <= this.lastSeq) return;
    this.lastSeq = parsed.data.seq;
    this.callbacks.onEvent(parsed.data);
  }

  private lost(): void {
    if (this.stopped) return;
    this.detach();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.callbacks.onStatus(this.attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}
```


- [ ] **Step 4: Run the tests and the type-check**

```bash
cd packages/devnet-ui && bunx vitest run && bunx tsc --noEmit
```

Expected: `Tests  33 passed (33)` (19 before + 14 stream); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/devnet-ui/src/rpc/stream.ts packages/devnet-ui/src/rpc/stream.test.ts
git commit -m "$(cat <<'EOF'
feat(devnet-ui): resumable explorerEvents stream with restart and gap detection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

- [ ] **Step 6: Prove the gap test bites**

Change `this.lastSeq + 1 < info.oldestSeq` to `<=` in `src/rpc/stream.ts` with your editor and run `cd packages/devnet-ui && bunx vitest run src/rpc/stream.test.ts`.

Expected: exactly one failure, `does not reset for a resume point right at the oldest retained event` (`expected [ 'gap' ] to deeply equal []`). Restore it and confirm nothing changed:

```bash
git checkout -- packages/devnet-ui/src/rpc/stream.ts
cd packages/devnet-ui && bunx vitest run src/rpc/stream.test.ts
git status --short
```

Expected: the run is green again (`Tests  14 passed (14)`) and `git status` prints nothing.

---

### Task 4: Instance list store

**Files:**
- Create: `packages/devnet-ui/src/instances/store.ts`
- Test: `packages/devnet-ui/src/instances/store.test.ts`

**Interfaces:**
- Produces: `Instance`, `InstancesState`, `InstancesAction`, `instancesReducer`, `normalizeUrl`, `validateNewInstance`, `wsUrl`, `loadState`, `saveState`, `fallbackState`, `defaultInstances`, `STORAGE_KEY`.

A bare origin becomes `<origin>/rpc` (where the sidecar serves JSON-RPC); a URL is the instance's identity, so the same node written two ways is a duplicate; storage that is missing, blocked, corrupt or invalid falls back to the defaults.

- [ ] **Step 1: Write the failing tests**

**`packages/devnet-ui/src/instances/store.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  STORAGE_KEY,
  defaultInstances,
  instancesReducer,
  loadState,
  normalizeUrl,
  saveState,
  validateNewInstance,
  wsUrl,
  type InstancesState,
} from "./store";

const A = { name: "Devnet", url: "https://altmempool.forshtat.com/rpc" };
const B = { name: "Local", url: "http://localhost:14337/rpc" };
const two: InstancesState = { instances: [A, B], selectedUrl: A.url };

describe("instancesReducer", () => {
  it("adds an instance and selects it when nothing was selected", () => {
    const next = instancesReducer({ instances: [], selectedUrl: null }, { type: "add", instance: A });
    expect(next).toEqual({ instances: [A], selectedUrl: A.url });
  });

  it("ignores a duplicate url", () => {
    expect(instancesReducer(two, { type: "add", instance: { name: "Again", url: A.url } })).toBe(two);
  });

  it("renames, ignoring a blank name", () => {
    expect(instancesReducer(two, { type: "rename", url: B.url, name: "  Mine " }).instances[1]?.name).toBe("Mine");
    expect(instancesReducer(two, { type: "rename", url: B.url, name: "   " })).toBe(two);
  });

  it("moves the selection when the selected instance is removed", () => {
    expect(instancesReducer(two, { type: "remove", url: A.url })).toEqual({
      instances: [B],
      selectedUrl: B.url,
    });
    expect(instancesReducer({ instances: [A], selectedUrl: A.url }, { type: "remove", url: A.url })).toEqual({
      instances: [],
      selectedUrl: null,
    });
  });

  it("keeps the selection when another instance is removed", () => {
    expect(instancesReducer(two, { type: "remove", url: B.url }).selectedUrl).toBe(A.url);
  });

  it("selects only instances that exist", () => {
    expect(instancesReducer(two, { type: "select", url: B.url }).selectedUrl).toBe(B.url);
    expect(instancesReducer(two, { type: "select", url: "http://nope/rpc" })).toBe(two);
  });
});

describe("normalizeUrl", () => {
  it("appends /rpc to a bare origin and strips trailing slashes", () => {
    expect(normalizeUrl("https://altmempool.forshtat.com")).toEqual({
      ok: true,
      url: "https://altmempool.forshtat.com/rpc",
    });
    expect(normalizeUrl(" http://localhost:14337/rpc/ ")).toEqual({
      ok: true,
      url: "http://localhost:14337/rpc",
    });
  });

  it("rejects empty input, non-URLs and other schemes with a reason", () => {
    expect(normalizeUrl("")).toMatchObject({ ok: false });
    expect(normalizeUrl("localhost:14337")).toMatchObject({ ok: false });
    expect(normalizeUrl("ftp://host/rpc")).toEqual({ ok: false, error: "Use an http:// or https:// URL." });
    expect(normalizeUrl("not a url")).toMatchObject({ ok: false });
  });
});

describe("validateNewInstance", () => {
  it("defaults the name to the host", () => {
    expect(validateNewInstance(two, " ", "http://10.0.0.5:14337")).toEqual({
      ok: true,
      instance: { name: "10.0.0.5:14337", url: "http://10.0.0.5:14337/rpc" },
    });
  });

  it("rejects a url that is already listed, even written differently", () => {
    expect(validateNewInstance(two, "x", "http://localhost:14337/rpc/")).toEqual({
      ok: false,
      error: "That instance is already in the list.",
    });
  });
});

describe("wsUrl", () => {
  it("swaps the scheme", () => {
    expect(wsUrl("http://localhost:14337/rpc")).toBe("ws://localhost:14337/rpc");
    expect(wsUrl("https://altmempool.forshtat.com/rpc")).toBe("wss://altmempool.forshtat.com/rpc");
  });
});

describe("persistence", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };

  it("round-trips the list and selection", () => {
    const storage = memory();
    saveState(storage, two);
    expect(loadState(storage, [B])).toEqual(two);
  });

  it("falls back to defaults for empty, corrupt or invalid storage", () => {
    expect(loadState(memory(), [B])).toEqual({ instances: [B], selectedUrl: B.url });
    const corrupt = memory();
    corrupt.setItem(STORAGE_KEY, "{oops");
    expect(loadState(corrupt, [B]).instances).toEqual([B]);
    const invalid = memory();
    invalid.setItem(STORAGE_KEY, JSON.stringify({ instances: "no" }));
    expect(loadState(invalid, [B]).instances).toEqual([B]);
  });

  it("repairs a selection that points at a missing instance", () => {
    const storage = memory();
    storage.setItem(STORAGE_KEY, JSON.stringify({ instances: [A], selectedUrl: "http://gone/rpc" }));
    expect(loadState(storage, [B]).selectedUrl).toBe(A.url);
  });

  it("survives blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadState(blocked, [B]).instances).toEqual([B]);
    expect(() => saveState(blocked, two)).not.toThrow();
    expect(loadState(undefined, [B]).instances).toEqual([B]);
  });
});

describe("defaultInstances", () => {
  it("uses the configured list, normalizing urls and dropping invalid ones", () => {
    const configured = JSON.stringify([
      { name: "Devnet", url: "https://altmempool.forshtat.com" },
      { name: "Broken", url: "nope" },
    ]);
    expect(defaultInstances(configured)).toEqual([
      { name: "Devnet", url: "https://altmempool.forshtat.com/rpc" },
    ]);
  });

  it("falls back to a local node", () => {
    expect(defaultInstances(undefined)).toEqual([{ name: "Local node", url: "http://localhost:14337/rpc" }]);
    expect(defaultInstances("{bad json")).toEqual([{ name: "Local node", url: "http://localhost:14337/rpc" }]);
    expect(defaultInstances("[]")).toEqual([{ name: "Local node", url: "http://localhost:14337/rpc" }]);
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run src/instances
```

Expected: FAIL (`Failed to load url ./store`).

- [ ] **Step 3: Write the implementation**

**`packages/devnet-ui/src/instances/store.ts`**

```ts
import { z } from "zod";

/** One sidecar instance the explorer can read from. `url` is its JSON-RPC endpoint and identifies it. */
export interface Instance {
  name: string;
  url: string;
}

export interface InstancesState {
  instances: Instance[];
  selectedUrl: string | null;
}

export type InstancesAction =
  | { type: "add"; instance: Instance }
  | { type: "rename"; url: string; name: string }
  | { type: "remove"; url: string }
  | { type: "select"; url: string };

export const STORAGE_KEY = "frame-explorer/instances/v1";

export function instancesReducer(state: InstancesState, action: InstancesAction): InstancesState {
  switch (action.type) {
    case "add": {
      if (state.instances.some((i) => i.url === action.instance.url)) return state;
      return {
        instances: [...state.instances, action.instance],
        selectedUrl: state.selectedUrl ?? action.instance.url,
      };
    }
    case "rename": {
      const name = action.name.trim();
      if (name === "") return state;
      return {
        ...state,
        instances: state.instances.map((i) => (i.url === action.url ? { ...i, name } : i)),
      };
    }
    case "remove": {
      const instances = state.instances.filter((i) => i.url !== action.url);
      const selectedUrl =
        state.selectedUrl === action.url ? (instances[0]?.url ?? null) : state.selectedUrl;
      return { instances, selectedUrl };
    }
    case "select":
      return state.instances.some((i) => i.url === action.url)
        ? { ...state, selectedUrl: action.url }
        : state;
  }
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * Accepts `https://host`, `http://host:14337` or a full `.../rpc` URL. An
 * address with no path gets `/rpc`, which is where the sidecar serves JSON-RPC.
 */
export function normalizeUrl(input: string): UrlCheck {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "Enter the node's URL." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "That doesn't look like a URL. Start it with http:// or https://." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Use an http:// or https:// URL." };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${parsed.origin}${path === "" ? "/rpc" : path}` };
}

export type NewInstanceCheck = { ok: true; instance: Instance } | { ok: false; error: string };

export function validateNewInstance(
  state: InstancesState,
  name: string,
  urlInput: string,
): NewInstanceCheck {
  const checked = normalizeUrl(urlInput);
  if (!checked.ok) return checked;
  if (state.instances.some((i) => i.url === checked.url)) {
    return { ok: false, error: "That instance is already in the list." };
  }
  const trimmed = name.trim();
  return {
    ok: true,
    instance: { name: trimmed === "" ? new URL(checked.url).host : trimmed, url: checked.url },
  };
}

/** `http://host/rpc` becomes `ws://host/rpc`; `https` becomes `wss`. */
export function wsUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

const StoredSchema = z.object({
  instances: z.array(z.object({ name: z.string(), url: z.string() })),
  selectedUrl: z.string().nullable(),
});

export function fallbackState(defaults: Instance[]): InstancesState {
  return { instances: defaults, selectedUrl: defaults[0]?.url ?? null };
}

/** Reads the saved list; falls back to `defaults` when storage is empty, blocked or corrupt. */
export function loadState(
  storage: Pick<Storage, "getItem"> | undefined,
  defaults: Instance[],
): InstancesState {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return fallbackState(defaults);
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return fallbackState(defaults);
    const { instances, selectedUrl } = parsed.data;
    return {
      instances,
      selectedUrl: instances.some((i) => i.url === selectedUrl)
        ? selectedUrl
        : (instances[0]?.url ?? null),
    };
  } catch {
    return fallbackState(defaults);
  }
}

export function saveState(storage: Pick<Storage, "setItem"> | undefined, state: InstancesState): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be blocked or full; the list still works for this visit.
  }
}

/** The list shown on a first visit: `VITE_EXPLORER_INSTANCES` (a JSON array) or a local node. */
export function defaultInstances(configured?: string): Instance[] {
  if (configured) {
    try {
      const parsed = z
        .array(z.object({ name: z.string(), url: z.string() }))
        .safeParse(JSON.parse(configured));
      if (parsed.success && parsed.data.length > 0) {
        const cleaned: Instance[] = [];
        for (const item of parsed.data) {
          const checked = normalizeUrl(item.url);
          if (checked.ok) cleaned.push({ name: item.name, url: checked.url });
        }
        if (cleaned.length > 0) return cleaned;
      }
    } catch {
      // fall through to the local default
    }
  }
  return [{ name: "Local node", url: "http://localhost:14337/rpc" }];
}
```


- [ ] **Step 4: Run the tests and the type-check**

```bash
cd packages/devnet-ui && bunx vitest run && bunx tsc --noEmit
```

Expected: `Tests  50 passed (50)` (33 before + 17 store); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/devnet-ui/src/instances
git commit -m "$(cat <<'EOF'
feat(devnet-ui): instance list reducer, URL normalization and tolerant persistence

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 5: Formatting, frame decoding and rule grouping

**Files:**
- Create: `packages/devnet-ui/src/logic/format.ts`, `src/logic/frames.ts`, `src/logic/rules.ts`
- Test: `packages/devnet-ui/src/logic/logic.test.ts`

**Interfaces:**
- Consumes: `Check`, `SerializedFrameTxSchema` (Task 1); `GLOBAL_RULE_ORDER`, `ENTITY_RULE_ORDER`, `EXPLORER_RULES` from `@skandha/types/lib/explorer/index.js`.
- Produces: `shortHash`, `shortAddress`, `hexToBigInt`, `formatQuantity`, `formatGwei`, `formatClock`, `formatAgo`, `formatDelta`, `describeSource`, `formatBytes`; `scopeOf`, `modeName`, `frameRole`, `parseFrameTx`, `entitiesByFrame`, `describeFrames`, `FrameView`, `Entity`; `ruleInfo`, `groupChecks`, `failureSummary`, `GroupedChecks`, `EntityGroup`.

The node does not promise the order of `checks[]`, so `groupChecks` sorts by the protocol's rule-order arrays and never trusts array order.

- [ ] **Step 1: Write the failing tests**

**`packages/devnet-ui/src/logic/logic.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  describeSource,
  formatAgo,
  formatBytes,
  formatClock,
  formatDelta,
  formatGwei,
  formatQuantity,
  hexToBigInt,
  shortAddress,
  shortHash,
} from "./format";
import { describeFrames, entitiesByFrame, frameRole, parseFrameTx, scopeOf } from "./frames";
import { failureSummary, groupChecks, ruleInfo } from "./rules";
import type { Check } from "../protocol/schemas";

describe("format", () => {
  it("shortens hashes and leaves short strings alone", () => {
    expect(shortHash("0x1234567890abcdef1234567890abcdef")).toBe("0x1234…cdef");
    expect(shortHash("0x12")).toBe("0x12");
    expect(shortAddress("0x1111111111111111111111111111111111111111")).toBe("0x1111…1111");
  });

  it("reads hex quantities, treating empty or malformed input as zero", () => {
    expect(hexToBigInt("0x1f")).toBe(31n);
    expect(hexToBigInt("0x")).toBe(0n);
    expect(hexToBigInt("")).toBe(0n);
    expect(hexToBigInt("0xzz")).toBe(0n);
    expect(formatQuantity("0x7530")).toBe("30,000");
  });

  it("formats wei as gwei with up to three decimals", () => {
    expect(formatGwei("0x0")).toBe("0 gwei");
    expect(formatGwei("0x3b9aca00")).toBe("1 gwei"); // 1e9 wei
    expect(formatGwei("0x77359400")).toBe("2 gwei");
    expect(formatGwei("0x1dcd6500")).toBe("0.5 gwei"); // 5e8 wei
    expect(formatGwei("0x4a817c800")).toBe("20 gwei"); // 2e10 wei
    expect(formatGwei(`0x${(1_234_567_890n).toString(16)}`)).toBe("1.234 gwei");
    expect(formatGwei("0x1")).toBe("<0.001 gwei");
    expect(formatGwei(`0x${(1_500_000_000_000n).toString(16)}`)).toBe("1,500 gwei");
  });

  it("formats a clock time with milliseconds in a chosen time zone", () => {
    expect(formatClock(Date.UTC(2026, 8, 24, 13, 5, 9, 42), "UTC")).toBe("13:05:09.042");
  });

  it("formats relative time coarsely", () => {
    const now = 1_000_000_000;
    expect(formatAgo(now - 2_000, now)).toBe("just now");
    expect(formatAgo(now - 12_000, now)).toBe("12 s ago");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe("2 d ago");
    expect(formatAgo(now + 5_000, now)).toBe("just now");
  });

  it("formats an offset from the first observation", () => {
    expect(formatDelta(0)).toBe("first");
    expect(formatDelta(240)).toBe("+240 ms");
    expect(formatDelta(1234)).toBe("+1.2 s");
    expect(formatDelta(180_000)).toBe("+3 min");
  });

  it("describes where a transaction first arrived from", () => {
    expect(describeSource("rpc")).toBe("Sent to this node");
    expect(describeSource("gossip:16Uiu2HAmKZdV7rQx")).toBe("Gossip from 16Uiu2…7rQx");
    expect(describeSource("sync:16Uiu2HAm3PqWzE9nD")).toBe("Synced from 16Uiu2…E9nD");
    expect(describeSource("carrier-pigeon")).toBe("carrier-pigeon");
  });

  it("counts bytes in a data string", () => {
    expect(formatBytes("0x")).toBe("0 bytes");
    expect(formatBytes("0xaa")).toBe("1 byte");
    expect(formatBytes(`0x${"ab".repeat(36)}`)).toBe("36 bytes");
  });
});

describe("frames", () => {
  it("decodes approval scope from the low two bits and ignores the atomic bit", () => {
    expect(scopeOf(0)).toBe("none");
    expect(scopeOf(1)).toBe("payment");
    expect(scopeOf(2)).toBe("execution");
    expect(scopeOf(3)).toBe("execution and payment");
    expect(scopeOf(0x4 | 0x2)).toBe("execution");
  });

  it("names a frame by its mode and scope", () => {
    expect(frameRole(1, 0)).toBe("expiry check");
    expect(frameRole(1, 1)).toBe("payment approval");
    expect(frameRole(1, 2)).toBe("execution approval");
    expect(frameRole(1, 3)).toBe("self-verification");
    expect(frameRole(2, 0)).toBe("user operation");
    expect(frameRole(0, 0)).toBe("deploy or post-operation");
    expect(frameRole(9, 0)).toBe("unknown frame");
  });

  const tx = {
    chainId: "0x539",
    nonce: "0x1",
    sender: "0x1111111111111111111111111111111111111111",
    frames: [
      { mode: 1, flags: 3, target: null, limits: { execution: "0x7530", state: "0x0" }, value: "0x0", data: "0x" },
      {
        mode: 2,
        flags: 4,
        target: "0x2222222222222222222222222222222222222222",
        limits: { execution: "0xc350", state: "0x10" },
        value: "0x1",
        data: "0xa9059cbb",
      },
    ],
    fees: { maxPriorityFeePerGas: "0x1", maxFeePerGas: "0x2", maxFeePerBlobGas: "0x0" },
  };

  it("parses a serialized transaction and returns null for anything else", () => {
    expect(parseFrameTx(tx)?.frames).toHaveLength(2);
    expect(parseFrameTx({ frames: "no" })).toBeNull();
    expect(parseFrameTx(null)).toBeNull();
  });

  it("maps frame indexes to the validator's entities", () => {
    const checks: Check[] = [
      { rule: "prefix", verdict: "pass" },
      { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "pass" },
      { rule: "OP-011", frameIndex: 1, entity: "factory", verdict: "pass" },
    ];
    expect([...entitiesByFrame(checks)]).toEqual([
      [0, "payer"],
      [1, "factory"],
    ]);
  });

  it("describes each frame with role, scope, gas, value and data size", () => {
    const parsed = parseFrameTx(tx)!;
    const views = describeFrames(parsed, [{ rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "pass" }]);
    expect(views[0]).toMatchObject({
      index: 0,
      modeName: "verify",
      role: "self-verification",
      scope: "execution and payment",
      atomic: false,
      entity: "payer",
      target: null,
      executionGas: 30000n,
      stateGas: 0n,
      dataBytes: 0,
    });
    expect(views[1]).toMatchObject({
      modeName: "sender",
      role: "user operation",
      atomic: true,
      entity: undefined,
      executionGas: 50000n,
      stateGas: 16n,
      value: 1n,
      dataBytes: 4,
    });
  });
});

describe("groupChecks", () => {
  // Deliberately out of order, as the node does not promise an order.
  const checks: Check[] = [
    { rule: "storage", frameIndex: 1, entity: "factory", verdict: "pass" },
    { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "fail", detail: "payer uses banned opcode: DIFFICULTY" },
    { rule: "signature", verdict: "pass" },
    { rule: "prefix", verdict: "pass" },
    { rule: "trace-alignment", frameIndex: 0, entity: "payer", verdict: "pass" },
    { rule: "storage", frameIndex: 0, entity: "payer", verdict: "fail", detail: "unstaked payer accessed slot" },
    { rule: "mempool", verdict: "skipped" },
    { rule: "some-future-rule", verdict: "pass" },
  ];

  it("orders transaction-level rules by the protocol's rule order, unknown ids last", () => {
    expect(groupChecks(checks).global.map((c) => c.rule)).toEqual([
      "prefix",
      "signature",
      "mempool",
      "some-future-rule",
    ]);
  });

  it("groups per-frame results by frame and orders rules within a frame", () => {
    const { entities } = groupChecks(checks);
    expect(entities.map((g) => [g.frameIndex, g.entity])).toEqual([
      [0, "payer"],
      [1, "factory"],
    ]);
    expect(entities[0]?.checks.map((c) => c.rule)).toEqual(["trace-alignment", "OP-011", "storage"]);
  });

  it("reports the verdict and every failure in display order", () => {
    const grouped = groupChecks(checks);
    expect(grouped.verdict).toBe("fail");
    expect(grouped.failing.map((c) => c.rule)).toEqual(["OP-011", "storage"]);
  });

  it("separates per-entity rules that were never evaluated", () => {
    const grouped = groupChecks([
      { rule: "prefix", verdict: "fail", detail: "not recognized" },
      { rule: "signature", verdict: "skipped" },
      { rule: "storage", verdict: "skipped" },
      { rule: "OP-011", verdict: "skipped" },
    ]);
    expect(grouped.global.map((c) => c.rule)).toEqual(["prefix", "signature"]);
    expect(grouped.notEvaluated.map((c) => c.rule)).toEqual(["OP-011", "storage"]);
    expect(grouped.entities).toEqual([]);
  });

  it("returns pass for a clean report and incomplete when rules were skipped without a failure", () => {
    expect(groupChecks([{ rule: "prefix", verdict: "pass" }]).verdict).toBe("pass");
    expect(groupChecks([{ rule: "prefix", verdict: "pass" }, { rule: "mempool", verdict: "skipped" }]).verdict).toBe(
      "incomplete",
    );
    expect(groupChecks([]).verdict).toBe("pass");
  });

  it("keeps an entity without a frame index in its own group rather than dropping it", () => {
    const grouped = groupChecks([{ rule: "OP-011", entity: "sender", verdict: "pass" }]);
    expect(grouped.entities).toEqual([
      { frameIndex: -1, entity: "sender", checks: [{ rule: "OP-011", entity: "sender", verdict: "pass" }] },
    ]);
  });

  it("does not mutate its input", () => {
    const input: Check[] = [
      { rule: "signature", verdict: "pass" },
      { rule: "prefix", verdict: "pass" },
    ];
    const copy = structuredClone(input);
    groupChecks(input);
    expect(input).toEqual(copy);
  });
});

describe("failureSummary and ruleInfo", () => {
  it("names the first failure with its entity and frame", () => {
    expect(
      failureSummary([
        { rule: "prefix", verdict: "pass" },
        { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "fail" },
      ]),
    ).toBe("Banned opcodes (payer, frame 0)");
    expect(failureSummary([{ rule: "prefix", verdict: "fail" }])).toBe("Validation prefix");
    expect(failureSummary([{ rule: "prefix", verdict: "pass" }])).toBeNull();
  });

  it("knows every rule id the protocol defines and falls back for unknown ones", () => {
    for (const rule of ["gas-limit", "prefix", "structure", "signature", "simulation", "trace-alignment", "OP-061", "execution", "out-of-gas", "OP-011", "create", "storage", "COD-010", "entrypoint-access", "mempool", "admission"]) {
      expect(ruleInfo(rule).label).not.toBe(rule);
      expect(ruleInfo(rule).explain.length).toBeGreaterThan(10);
    }
    expect(ruleInfo("brand-new")).toMatchObject({ label: "brand-new" });
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run src/logic
```

Expected: FAIL (`Failed to load url ./format`).

- [ ] **Step 3: Write the implementation**

**`packages/devnet-ui/src/logic/format.ts`**

```ts
/** Display helpers. Everything here is pure so it can be tested without a DOM. */

/** `0x1234…abcd`. Strings that are already short are returned unchanged. */
export function shortHash(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export const shortAddress = (address: string): string => shortHash(address, 6, 4);

/** Parses a `0x` quantity; empty or malformed input reads as zero. */
export function hexToBigInt(hex: string): bigint {
  if (hex === "" || hex === "0x") return 0n;
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

/** A `0x` quantity in decimal with thousands separators. */
export function formatQuantity(hex: string): string {
  return hexToBigInt(hex).toLocaleString("en-US");
}

/** A wei amount, given as a `0x` quantity, shown in gwei with up to three decimals. */
export function formatGwei(hexWei: string): string {
  const wei = hexToBigInt(hexWei);
  if (wei === 0n) return "0 gwei";
  const gwei = 1_000_000_000n;
  const whole = wei / gwei;
  const rest = wei % gwei;
  if (whole === 0n && rest < 1_000_000n) return "<0.001 gwei";
  const thousandths = rest / 1_000_000n;
  const decimals =
    thousandths === 0n ? "" : `.${thousandths.toString().padStart(3, "0").replace(/0+$/, "")}`;
  return `${whole.toLocaleString("en-US")}${decimals} gwei`;
}

/** `HH:MM:SS.mmm`, in the viewer's time zone unless `timeZone` is given. */
export function formatClock(ms: number, timeZone?: string): string {
  const time = new Date(ms).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  });
  return `${time}.${String(ms % 1000).padStart(3, "0")}`;
}

/** Coarse relative time: "just now", "12 s ago", "5 min ago", "3 h ago", "2 d ago". */
export function formatAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** An offset from the first observation: "first", "+240 ms", "+1.2 s", "+3 min". */
export function formatDelta(ms: number): string {
  if (ms <= 0) return "first";
  if (ms < 1000) return `+${ms} ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${Math.round(ms / 60_000)} min`;
}

/** Where a node first saw a transaction, in words: "Sent to this node", "Gossip from 16Uiu2…Pq8P". */
export function describeSource(source: string): string {
  if (source === "rpc") return "Sent to this node";
  const gossip = /^gossip:(.+)$/.exec(source);
  if (gossip?.[1]) return `Gossip from ${shortHash(gossip[1], 6, 4)}`;
  const sync = /^sync:(.+)$/.exec(source);
  if (sync?.[1]) return `Synced from ${shortHash(sync[1], 6, 4)}`;
  return source;
}

/** The byte length of a `0x` data string, as words: "0 bytes", "1 byte", "36 bytes". */
export function formatBytes(hexData: string): string {
  const bytes = Math.max(0, Math.floor((hexData.length - 2) / 2));
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}
```

**`packages/devnet-ui/src/logic/frames.ts`**

```ts
import { SerializedFrameTxSchema, type Check, type SerializedFrameTx } from "../protocol/schemas";
import { hexToBigInt } from "./format";

export type Entity = NonNullable<Check["entity"]>;

/** Frame `mode` values from EIP-8141 (see `FRAME_MODE` in the backend). */
const MODE_DEFAULT = 0;
const MODE_VERIFY = 1;
const MODE_SENDER = 2;

/** Bits 0-1 of `flags` are the approval scope; bit 2 makes a frame atomic with the next one. */
const SCOPE_MASK = 0x3;
const ATOMIC_BATCH_FLAG = 0x4;

export type Scope = "none" | "payment" | "execution" | "execution and payment";

export function scopeOf(flags: number): Scope {
  switch (flags & SCOPE_MASK) {
    case 1:
      return "payment";
    case 2:
      return "execution";
    case 3:
      return "execution and payment";
    default:
      return "none";
  }
}

export function modeName(mode: number): string {
  switch (mode) {
    case MODE_DEFAULT:
      return "default";
    case MODE_VERIFY:
      return "verify";
    case MODE_SENDER:
      return "sender";
    default:
      return "unknown";
  }
}

/** What a frame is for, from its mode and approval scope. */
export function frameRole(mode: number, flags: number): string {
  if (mode === MODE_VERIFY) {
    switch (flags & SCOPE_MASK) {
      case 1:
        return "payment approval";
      case 2:
        return "execution approval";
      case 3:
        return "self-verification";
      default:
        return "expiry check";
    }
  }
  if (mode === MODE_SENDER) return "user operation";
  if (mode === MODE_DEFAULT) return "deploy or post-operation";
  return "unknown frame";
}

/** Reads the serialized transaction from `getTransaction`; null when it is not the expected shape. */
export function parseFrameTx(tx: unknown): SerializedFrameTx | null {
  const parsed = SerializedFrameTxSchema.safeParse(tx);
  return parsed.success ? parsed.data : null;
}

/** Which entity (sender, payer or factory) the validator attached to each frame index. */
export function entitiesByFrame(checks: Check[]): Map<number, Entity> {
  const result = new Map<number, Entity>();
  for (const check of checks) {
    if (check.frameIndex !== undefined && check.entity !== undefined) {
      result.set(check.frameIndex, check.entity);
    }
  }
  return result;
}

export interface FrameView {
  index: number;
  mode: number;
  modeName: string;
  role: string;
  scope: Scope;
  atomic: boolean;
  entity: Entity | undefined;
  target: string | null;
  executionGas: bigint;
  stateGas: bigint;
  value: bigint;
  dataBytes: number;
}

export function describeFrames(tx: SerializedFrameTx, checks: Check[]): FrameView[] {
  const entities = entitiesByFrame(checks);
  return tx.frames.map((frame, index) => ({
    index,
    mode: frame.mode,
    modeName: modeName(frame.mode),
    role: frameRole(frame.mode, frame.flags),
    scope: scopeOf(frame.flags),
    atomic: (frame.flags & ATOMIC_BATCH_FLAG) !== 0,
    entity: entities.get(index),
    target: frame.target,
    executionGas: hexToBigInt(frame.limits.execution),
    stateGas: hexToBigInt(frame.limits.state),
    value: hexToBigInt(frame.value),
    dataBytes: Math.max(0, Math.floor((frame.data.length - 2) / 2)),
  }));
}
```

**`packages/devnet-ui/src/logic/rules.ts`**

```ts
import {
  ENTITY_RULE_ORDER,
  EXPLORER_RULES,
  GLOBAL_RULE_ORDER,
} from "@skandha/types/lib/explorer/index.js";
import type { Check } from "../protocol/schemas";
import type { Entity } from "./frames";

export interface RuleInfo {
  label: string;
  explain: string;
}

/** Plain-language names for the rule ids the node reports (see docs/sidecar_explorer.md). */
const RULE_INFO: Record<string, RuleInfo> = {
  "gas-limit": {
    label: "Gas limit",
    explain: "The frames' execution and state gas limits add up to no more than this node allows.",
  },
  prefix: {
    label: "Validation prefix",
    explain: "The leading frames form a recognized validation prefix with sender, payer and factory roles.",
  },
  structure: {
    label: "Frame structure",
    explain: "The prefix follows EIP-8141's structural rules for targets, flags and verification gas.",
  },
  signature: {
    label: "Signatures",
    explain: "Every signature on the transaction verifies.",
  },
  simulation: {
    label: "Simulation",
    explain: "The execution client simulated the transaction with a trace and did not reject it.",
  },
  "trace-alignment": {
    label: "Trace alignment",
    explain: "The trace lines up with the frames, one top-level call per validation frame.",
  },
  "OP-061": {
    label: "No value in nested calls",
    explain: "Validation code makes no nested call that sends value.",
  },
  execution: {
    label: "Validation execution",
    explain: "The simulation reported no execution error.",
  },
  "out-of-gas": {
    label: "No out-of-gas",
    explain: "The entity did not run out of gas internally during validation.",
  },
  "OP-011": {
    label: "Banned opcodes",
    explain: "The entity used none of the opcodes validation forbids, such as TIMESTAMP, NUMBER or GAS.",
  },
  create: {
    label: "Contract creation",
    explain: "The entity created no contracts, except a factory within its limits.",
  },
  storage: {
    label: "Storage access",
    explain: "The entity touched only storage it may: its own, or storage associated with it, and more if staked.",
  },
  "COD-010": {
    label: "Deployed code only",
    explain: "The entity did not read the code of a contract that is not deployed.",
  },
  "entrypoint-access": {
    label: "EntryPoint code",
    explain: "The entity did not read the code of the EntryPoint address.",
  },
  mempool: {
    label: "Mempool admission",
    explain: "The mempool accepted the transaction: replacement fee rules and reputation limits passed.",
  },
  admission: {
    label: "Other failure",
    explain: "The node failed for a reason no other rule claims, such as an unexpected error.",
  },
};

export function ruleInfo(rule: string): RuleInfo {
  return RULE_INFO[rule] ?? { label: rule, explain: "A rule this version of the explorer does not know." };
}

const GLOBAL_ORDER: readonly string[] = GLOBAL_RULE_ORDER;
const ENTITY_ORDER: readonly string[] = ENTITY_RULE_ORDER;
/** Within one frame, `trace-alignment` is reported first, then the per-entity rules. */
const FRAME_ORDER: readonly string[] = [EXPLORER_RULES.TRACE_ALIGNMENT, ...ENTITY_RULE_ORDER];

function rank(order: readonly string[], rule: string): number {
  const index = order.indexOf(rule);
  return index === -1 ? order.length : index;
}

export interface EntityGroup {
  /** -1 when the node reported an entity without a frame index. */
  frameIndex: number;
  entity: Entity | undefined;
  checks: Check[];
}

export type ReportVerdict = "pass" | "fail" | "incomplete";

export interface GroupedChecks {
  /** Transaction-level rules, in the order the node runs them. */
  global: Check[];
  /** Per-entity rules that were never evaluated because an earlier rule failed. */
  notEvaluated: Check[];
  /** Per-frame results, ordered by frame. */
  entities: EntityGroup[];
  verdict: ReportVerdict;
  /** Every failing check, in display order. */
  failing: Check[];
}

/**
 * Arranges a flat `checks[]` for display. The node does not guarantee array
 * order, so everything is sorted by the rule-order arrays from the protocol.
 */
export function groupChecks(checks: Check[]): GroupedChecks {
  const global: Check[] = [];
  const notEvaluated: Check[] = [];
  const groups = new Map<string, EntityGroup>();

  for (const check of checks) {
    if (check.frameIndex === undefined && check.entity === undefined) {
      (ENTITY_ORDER.includes(check.rule) ? notEvaluated : global).push(check);
      continue;
    }
    const frameIndex = check.frameIndex ?? -1;
    const key = `${frameIndex}:${check.entity ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { frameIndex, entity: check.entity, checks: [] };
      groups.set(key, group);
    }
    group.checks.push(check);
  }

  global.sort((a, b) => rank(GLOBAL_ORDER, a.rule) - rank(GLOBAL_ORDER, b.rule));
  notEvaluated.sort((a, b) => rank(ENTITY_ORDER, a.rule) - rank(ENTITY_ORDER, b.rule));
  const entities = [...groups.values()].sort(
    (a, b) => a.frameIndex - b.frameIndex || (a.entity ?? "").localeCompare(b.entity ?? ""),
  );
  for (const group of entities) {
    group.checks.sort((a, b) => rank(FRAME_ORDER, a.rule) - rank(FRAME_ORDER, b.rule));
  }

  const failing = [...global, ...entities.flatMap((g) => g.checks)].filter((c) => c.verdict === "fail");
  const anySkipped = checks.some((c) => c.verdict === "skipped");
  const verdict: ReportVerdict = failing.length > 0 ? "fail" : anySkipped ? "incomplete" : "pass";
  return { global, notEvaluated, entities, verdict, failing };
}

/** One line naming the first failed rule, for lists: "Banned opcodes (payer, frame 0)". */
export function failureSummary(checks: Check[]): string | null {
  const first = groupChecks(checks).failing[0];
  if (!first) return null;
  const { label } = ruleInfo(first.rule);
  if (first.entity !== undefined && first.frameIndex !== undefined) {
    return `${label} (${first.entity}, frame ${first.frameIndex})`;
  }
  return label;
}
```


- [ ] **Step 4: Run the tests and the type-check**

```bash
cd packages/devnet-ui && bunx vitest run && bunx tsc --noEmit
```

Expected: `Tests  72 passed (72)` (50 before + 22 logic); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/devnet-ui/src/logic
git commit -m "$(cat <<'EOF'
feat(devnet-ui): formatting, frame decoding and admission-report grouping

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 6: Mock explorer node

**Files:**
- Create: `packages/devnet-ui/mock/state.ts`, `mock/fixtures.ts`, `mock/ports.ts`
- Test: `packages/devnet-ui/mock/state.test.ts`

**Interfaces:**
- Consumes: the schemas (Task 1).
- Produces: `MockNode` (`handle(method, params)`, `subscribe(sinceSeq, send)`, `admit`, `reject`, `setStatus`, `replace`, `restart`, `explorerEnabled`, `bootId`), `passingChecks`, `serializeTx`, `STATUSES`; fixtures `TX`, `makeTx(t0)`, `T0`, `PEERS`, `primaryNode`, `secondaryNode`, `disabledNode`, `liveTx`, `hashOf`, `addrOf`; `MOCK_PORTS`.

The mock is a pure state machine that answers the five `skandha_explorer_*` methods exactly like the backend: the same error codes (`-32601` explorer off, `-32600` bad request), the same cursor rules (offset for the pool, `id` for admissions), the same page-size clamp (default 50, max 200) and the same status-to-event mapping (`OnChain` is `included`, `Cancelled` is `dropped`, everything else is `statusChanged`). Its tests validate every response with the UI's own schemas, so the mock cannot drift from the contract. The fixtures cover every state the UI must render: an included transaction, a sponsored 3-frame one, a fresh one, two different rejections (several violations at once; a failure at the prefix stage), a whitelist waiver, a revert, a replacement, and a factory deploy. `makeTx(t0)` lets the dev server place the data just before "now", while tests use the fixed `T0`.

- [ ] **Step 1: Write the failing tests**

**`packages/devnet-ui/mock/state.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  AdmissionPageSchema,
  ExplorerInfoSchema,
  PeerListSchema,
  SerializedFrameTxSchema,
  TransactionDetailSchema,
  TransactionPageSchema,
  type LifecycleEventData,
} from "../src/protocol/schemas";
import { PEERS, TX, disabledNode, primaryNode, secondaryNode } from "./fixtures";
import { MockNode, type RpcOutcome } from "./state";

const ok = (outcome: RpcOutcome): unknown => {
  if (!("result" in outcome)) throw new Error(`expected a result, got ${JSON.stringify(outcome)}`);
  return outcome.result;
};
const failure = (outcome: RpcOutcome) => {
  if (!("error" in outcome)) throw new Error("expected an error");
  return outcome.error;
};

describe("MockNode protocol parity", () => {
  const node = primaryNode();

  it("answers every method with a result the UI's schemas accept", () => {
    expect(ExplorerInfoSchema.safeParse(ok(node.handle("skandha_explorer_info"))).success).toBe(true);
    expect(TransactionPageSchema.safeParse(ok(node.handle("skandha_explorer_listTransactions", [{}]))).success).toBe(true);
    expect(AdmissionPageSchema.safeParse(ok(node.handle("skandha_explorer_listAdmissions", [{}]))).success).toBe(true);
    expect(PeerListSchema.safeParse(ok(node.handle("skandha_explorer_peers"))).success).toBe(true);
    for (const tx of Object.values(TX).filter((t) => t.hash !== TX.onlySecondary.hash)) {
      const outcome = node.handle("skandha_explorer_getTransaction", [tx.hash]);
      expect(TransactionDetailSchema.safeParse(ok(outcome)).success).toBe(true);
    }
  });

  it("reports the retained history window and a 16-character bootId in info", () => {
    const info = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info")));
    expect(info).toMatchObject({ protocolVersion: 1, chainId: 1337, oldestSeq: 1, p2pEnabled: true });
    expect(info.latestSeq).toBeGreaterThan(10);
    expect(info.bootId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("lists only what is in the mempool store, newest first", () => {
    const page = TransactionPageSchema.parse(ok(node.handle("skandha_explorer_listTransactions", [{}])));
    const hashes = page.items.map((i) => i.txHash);
    expect(hashes).toContain(TX.onChain.hash);
    expect(hashes).toContain(TX.replacedNew.hash);
    expect(hashes).not.toContain(TX.bannedOpcode.hash); // rejected: never pooled
    expect(hashes).not.toContain(TX.replacedOld.hash); // replaced: left the pool
    const times = page.items.map((i) => i.submittedTime ?? 0);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("filters by status and pages with an offset cursor", () => {
    const filtered = TransactionPageSchema.parse(
      ok(node.handle("skandha_explorer_listTransactions", [{ status: "New" }])),
    );
    expect(filtered.items.every((i) => i.status === "New")).toBe(true);
    const first = TransactionPageSchema.parse(ok(node.handle("skandha_explorer_listTransactions", [{ limit: 2 }])));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const second = TransactionPageSchema.parse(
      ok(node.handle("skandha_explorer_listTransactions", [{ limit: 2, cursor: first.nextCursor }])),
    );
    expect(second.items.map((i) => i.txHash)).not.toContain(first.items[0]?.txHash);
  });

  it("rejects bad list parameters with INVALID_REQUEST and clamps the limit", () => {
    expect(failure(node.handle("skandha_explorer_listTransactions", [{ status: "Bogus" }])).code).toBe(-32600);
    expect(failure(node.handle("skandha_explorer_listTransactions", [{ cursor: "-1" }])).code).toBe(-32600);
    expect(failure(node.handle("skandha_explorer_listAdmissions", [{ outcome: "nope" }])).code).toBe(-32600);
    expect(failure(node.handle("skandha_explorer_listAdmissions", [{ cursor: "x" }])).code).toBe(-32600);
    const page = TransactionPageSchema.parse(ok(node.handle("skandha_explorer_listTransactions", [{ limit: 0 }])));
    expect(page.items.length).toBeGreaterThan(0);
  });

  it("lists admissions newest first, including rejected and replaced ones", () => {
    const page = AdmissionPageSchema.parse(ok(node.handle("skandha_explorer_listAdmissions", [{}])));
    const outcomes = new Set(page.items.map((a) => a.outcome));
    expect(outcomes).toEqual(new Set(["accepted", "rejected", "replaced"]));
    const ids = page.items.map((a) => a.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const rejected = AdmissionPageSchema.parse(
      ok(node.handle("skandha_explorer_listAdmissions", [{ outcome: "rejected" }])),
    );
    expect(rejected.items.map((a) => a.txHash).sort()).toEqual([TX.bannedOpcode.hash, TX.noPrefix.hash].sort());
  });

  it("pages admissions with an id cursor", () => {
    const first = AdmissionPageSchema.parse(ok(node.handle("skandha_explorer_listAdmissions", [{ limit: 3 }])));
    expect(first.items).toHaveLength(3);
    const second = AdmissionPageSchema.parse(
      ok(node.handle("skandha_explorer_listAdmissions", [{ limit: 3, cursor: first.nextCursor }])),
    );
    expect(Math.max(...second.items.map((a) => a.id))).toBeLessThan(Math.min(...first.items.map((a) => a.id)));
  });

  it("returns a pooled transaction with its serialized frames, report and timeline", () => {
    const detail = TransactionDetailSchema.parse(ok(node.handle("skandha_explorer_getTransaction", [TX.onChain.hash])));
    expect(detail.entry?.status).toBe("OnChain");
    expect(SerializedFrameTxSchema.safeParse(detail.entry?.tx).success).toBe(true);
    expect(detail.admission?.outcome).toBe("accepted");
    expect(detail.events.map((e) => e.kind)).toEqual(["admitted", "statusChanged", "included"]);
  });

  it("returns a rejected transaction with no entry and a failing report", () => {
    const detail = TransactionDetailSchema.parse(
      ok(node.handle("skandha_explorer_getTransaction", [TX.bannedOpcode.hash])),
    );
    expect(detail.entry).toBeNull();
    expect(detail.admission?.outcome).toBe("rejected");
    expect(detail.admission?.errorCode).toBe(-32502);
    expect(detail.admission?.checks.filter((c) => c.verdict === "fail").map((c) => c.rule)).toEqual([
      "OP-011",
      "storage",
    ]);
    expect(detail.events.map((e) => e.kind)).toEqual(["rejected"]);
  });

  it("returns a replaced transaction with no entry, outcome replaced and a replaced event", () => {
    const detail = TransactionDetailSchema.parse(
      ok(node.handle("skandha_explorer_getTransaction", [TX.replacedOld.hash])),
    );
    expect(detail.entry).toBeNull();
    expect(detail.admission?.outcome).toBe("replaced");
    expect(detail.events.at(-1)).toMatchObject({ kind: "replaced", reason: `replaced by ${TX.replacedNew.hash}` });
  });

  it("carries a revert reason on a reverted entry", () => {
    const detail = TransactionDetailSchema.parse(ok(node.handle("skandha_explorer_getTransaction", [TX.reverted.hash])));
    expect(detail.entry).toMatchObject({ status: "Reverted", revertReason: "execution reverted: insufficient allowance" });
  });

  it("accepts an upper-case hash and rejects unknown or malformed hashes", () => {
    const upper = `0x${TX.onChain.hash.slice(2).toUpperCase()}`;
    expect(TransactionDetailSchema.parse(ok(node.handle("skandha_explorer_getTransaction", [upper]))).hash).toBe(
      TX.onChain.hash,
    );
    expect(failure(node.handle("skandha_explorer_getTransaction", [`0x${"1".repeat(64)}`]))).toEqual({
      code: -32600,
      message: "Frame transaction not found",
    });
    expect(failure(node.handle("skandha_explorer_getTransaction", ["0x12"])).code).toBe(-32600);
    expect(failure(node.handle("skandha_explorer_getTransaction", [])).code).toBe(-32600);
  });

  it("returns peers, or none when p2p is off", () => {
    expect(PeerListSchema.parse(ok(node.handle("skandha_explorer_peers")))).toEqual(PEERS);
    expect(ok(secondaryNode().handle("skandha_explorer_peers"))).toEqual([]);
  });

  it("answers METHOD_NOT_FOUND for every explorer method when the explorer is off, and for unknown methods", () => {
    const off = disabledNode();
    for (const method of [
      "skandha_explorer_info",
      "skandha_explorer_listTransactions",
      "skandha_explorer_listAdmissions",
      "skandha_explorer_getTransaction",
      "skandha_explorer_peers",
    ]) {
      expect(failure(off.handle(method, [])).code).toBe(-32601);
    }
    expect(failure(node.handle("eth_chainId")).code).toBe(-32601);
  });
});

describe("MockNode events and stream", () => {
  const collect = (node: MockNode, since?: number) => {
    const seen: LifecycleEventData[] = [];
    const off = node.subscribe(since, (e) => seen.push(e));
    return { seen, off };
  };

  it("replays events after sinceSeq, then delivers live ones, until unsubscribed", () => {
    const node = primaryNode();
    const latest = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info"))).latestSeq;
    const replay = collect(node, latest - 2);
    expect(replay.seen.map((e) => e.seq)).toEqual([latest - 1, latest]);

    node.admit({ ...TX.fresh, hash: `0x${"9".repeat(64)}`, frames: TX.fresh.frames.map((f) => ({ ...f })) });
    expect(replay.seen.at(-1)?.seq).toBe(latest + 1);
    replay.off();
    node.admit({ ...TX.fresh, hash: `0x${"8".repeat(64)}`, frames: TX.fresh.frames.map((f) => ({ ...f })) });
    expect(replay.seen.at(-1)?.seq).toBe(latest + 1);
  });

  it("sends only live events when no sinceSeq is given", () => {
    const node = primaryNode();
    const live = collect(node);
    expect(live.seen).toEqual([]);
  });

  it("maps status changes to lifecycle kinds like the backend", () => {
    const node = primaryNode();
    const live = collect(node);
    node.setStatus(TX.fresh.hash, "Submitted");
    node.setStatus(TX.fresh.hash, "OnChain");
    node.setStatus(TX.waived.hash, "Cancelled", "nonce too low");
    expect(live.seen.map((e) => [e.kind, e.status, e.reason])).toEqual([
      ["statusChanged", "Submitted", undefined],
      ["included", "OnChain", undefined],
      ["dropped", "Cancelled", "nonce too low"],
    ]);
  });

  it("restart() changes bootId and clears history but keeps the pool", () => {
    const node = primaryNode();
    const before = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info")));
    node.restart();
    const after = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info")));
    expect(after.bootId).not.toBe(before.bootId);
    expect(after).toMatchObject({ latestSeq: 0, oldestSeq: 0 });
    expect(AdmissionPageSchema.parse(ok(node.handle("skandha_explorer_listAdmissions", [{}]))).items).toEqual([]);
    expect(TransactionPageSchema.parse(ok(node.handle("skandha_explorer_listTransactions", [{}]))).items.length).toBeGreaterThan(0);
  });

  it("evicts the oldest history beyond its capacity and reports the new oldestSeq", () => {
    const node = new MockNode({ name: "tiny", capacity: 3 });
    for (let i = 1; i <= 5; i++) {
      node.admit({
        ...TX.fresh,
        hash: `0x${String(i).repeat(64)}`,
        nonce: i,
        frames: TX.fresh.frames.map((f) => ({ ...f })),
      });
    }
    const info = ExplorerInfoSchema.parse(ok(node.handle("skandha_explorer_info")));
    expect(info).toMatchObject({ latestSeq: 5, oldestSeq: 3, historyCapacity: 3 });
  });
});

describe("secondary fixture node", () => {
  it("saw the shared traffic later and has a transaction the primary never saw", () => {
    const primary = primaryNode();
    const secondary = secondaryNode();
    const at = (node: MockNode, hash: string) =>
      TransactionDetailSchema.parse(ok(node.handle("skandha_explorer_getTransaction", [hash]))).admission?.at;
    expect((at(secondary, TX.onChain.hash) ?? 0) - (at(primary, TX.onChain.hash) ?? 0)).toBe(240);
    expect(failure(primary.handle("skandha_explorer_getTransaction", [TX.onlySecondary.hash])).code).toBe(-32600);
    expect(at(secondary, TX.onlySecondary.hash)).toBeDefined();
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run mock
```

Expected: FAIL (`Failed to load url ./fixtures`).

- [ ] **Step 3: Write the implementation**

**`packages/devnet-ui/mock/state.ts`**

```ts
import type {
  Admission,
  Check,
  Info,
  LifecycleEventData,
  Peer,
  TransactionDetail,
  TransactionSummary,
} from "../src/protocol/schemas";

/**
 * A fake sidecar explorer node. It keeps state in memory and answers the five
 * `skandha_explorer_*` methods exactly like the real backend (same error codes,
 * cursor rules, page-size clamp and lifecycle-event mapping), so the UI can be
 * developed and tested without a running devnet. The HTTP/WebSocket wrapper is
 * in `server.ts`; everything here is plain TypeScript and unit-tested.
 */

export const STATUSES = ["New", "Pending", "Submitted", "OnChain", "Finalized", "Cancelled", "Reverted"] as const;
export type Status = (typeof STATUSES)[number];

export interface MockFrame {
  mode: number;
  flags: number;
  target: string | null;
  execution: number;
  state?: number;
  value?: number;
  data?: string;
}

export interface MockTx {
  hash: string;
  sender: string;
  payer: string;
  factory?: string;
  nonce: number;
  status: Status;
  frames: MockFrame[];
  maxFeePerGas: bigint;
  submittedTime: number;
  revertReason?: string;
}

export interface MockNodeOptions {
  name: string;
  chainId?: number;
  explorerEnabled?: boolean;
  p2pEnabled?: boolean;
  capacity?: number;
  bootId?: string;
  peers?: Peer[];
  now?: () => number;
}

export type RpcOutcome = { result: unknown } | { error: { code: number; message: string } };

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const hex = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;
const fail = (code: number, message: string): RpcOutcome => ({ error: { code, message } });

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE;
  return Math.min(Math.floor(limit), MAX_PAGE);
}

function randomBootId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export class MockNode {
  readonly name: string;
  bootId: string;
  private readonly now: () => number;
  private readonly pool = new Map<string, MockTx>();
  private admissions = new Map<string, Admission>();
  private events: LifecycleEventData[] = [];
  private nextSeq = 1;
  private nextAdmissionId = 1;
  private readonly listeners = new Set<(event: LifecycleEventData) => void>();

  constructor(readonly options: MockNodeOptions) {
    this.name = options.name;
    this.now = options.now ?? Date.now;
    this.bootId = options.bootId ?? randomBootId();
  }

  get explorerEnabled(): boolean {
    return this.options.explorerEnabled ?? true;
  }

  private get capacity(): number {
    return this.options.capacity ?? 10_000;
  }

  // ---- scenario controls -------------------------------------------------

  /** Puts a transaction in the mempool store and records its admission and `admitted` event. */
  admit(tx: MockTx, source = "rpc", checks: Check[] = passingChecks(tx), at = tx.submittedTime): void {
    this.pool.set(tx.hash, tx);
    this.recordAdmission(tx, "accepted", checks, source, undefined, at);
    this.emit(tx.hash, "admitted", tx.status, undefined, at);
  }

  /** Records a rejection: an admission and a `rejected` event, and nothing in the mempool. */
  reject(tx: MockTx, checks: Check[], source = "rpc", errorCode = -32502, at = tx.submittedTime): void {
    this.recordAdmission(tx, "rejected", checks, source, errorCode, at);
    const first = checks.find((c) => c.verdict === "fail");
    this.emit(tx.hash, "rejected", undefined, first?.detail, at);
  }

  /** Moves a pooled transaction to a new status and emits the matching lifecycle event. */
  setStatus(hash: string, status: Status, reason?: string, at = this.now()): void {
    const tx = this.pool.get(hash);
    if (!tx) return;
    tx.status = status;
    if (reason !== undefined) tx.revertReason = reason;
    const kind = status === "OnChain" ? "included" : status === "Cancelled" ? "dropped" : "statusChanged";
    this.emit(hash, kind, status, reason, at);
  }

  /** A newer transaction takes the old one's slot: the old entry leaves the pool. */
  replace(oldHash: string, next: MockTx, source = "rpc", at = next.submittedTime): void {
    this.pool.delete(oldHash);
    const old = this.admissions.get(oldHash);
    if (old) old.outcome = "replaced";
    this.emit(oldHash, "replaced", undefined, `replaced by ${next.hash}`, at);
    this.admit(next, source, undefined, at);
  }

  /** Simulates a process restart: history and `seq` reset, the mempool store stays, `bootId` changes. */
  restart(): void {
    this.bootId = randomBootId();
    this.admissions = new Map();
    this.events = [];
    this.nextSeq = 1;
    this.nextAdmissionId = 1;
  }

  // ---- protocol ----------------------------------------------------------

  private recordAdmission(
    tx: MockTx,
    outcome: Admission["outcome"],
    checks: Check[],
    source: string,
    errorCode: number | undefined,
    at: number,
  ): void {
    const record: Admission = {
      id: this.nextAdmissionId++,
      txHash: tx.hash,
      sender: tx.sender,
      nonce: hex(tx.nonce),
      at,
      source,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      checks,
    };
    this.admissions.set(tx.hash, record);
    while (this.admissions.size > this.capacity) {
      this.admissions.delete(this.admissions.keys().next().value as string);
    }
  }

  private emit(txHash: string, kind: string, status?: string, reason?: string, at = this.now()): void {
    const event: LifecycleEventData = {
      seq: this.nextSeq++,
      txHash,
      at,
      kind,
      ...(status === undefined ? {} : { status }),
      ...(reason === undefined ? {} : { reason }),
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const listener of this.listeners) listener(event);
  }

  /**
   * The `explorerEvents` stream. With `sinceSeq`, every retained event after it
   * is replayed first; then live events follow. Returns an unsubscribe function.
   */
  subscribe(sinceSeq: number | undefined, send: (event: LifecycleEventData) => void): () => void {
    if (typeof sinceSeq === "number") {
      for (const event of this.events) if (event.seq > sinceSeq) send(event);
    }
    this.listeners.add(send);
    return () => {
      this.listeners.delete(send);
    };
  }

  /** Answers one JSON-RPC call the way the real API does. */
  handle(method: string, params: unknown[] = []): RpcOutcome {
    if (!method.startsWith("skandha_explorer_")) {
      return fail(METHOD_NOT_FOUND, `Method ${method} is not supported`);
    }
    if (!this.explorerEnabled) {
      return fail(METHOD_NOT_FOUND, "Explorer is disabled: start the node with --explorer.enable");
    }
    const arg = params[0];
    const object = typeof arg === "object" && arg !== null ? (arg as Record<string, unknown>) : {};
    switch (method) {
      case "skandha_explorer_info":
        return { result: this.info() };
      case "skandha_explorer_listTransactions":
        return this.listTransactions(object);
      case "skandha_explorer_listAdmissions":
        return this.listAdmissions(object);
      case "skandha_explorer_getTransaction":
        return this.getTransaction(arg);
      case "skandha_explorer_peers":
        return { result: this.options.p2pEnabled === false ? [] : (this.options.peers ?? []) };
      default:
        return fail(METHOD_NOT_FOUND, `Method ${method} is not supported`);
    }
  }

  private info(): Info {
    return {
      protocolVersion: 1,
      chainId: this.options.chainId ?? 1337,
      version: "4.1.1",
      commit: "a1b2c3d",
      bundlingMode: "auto",
      p2pEnabled: this.options.p2pEnabled ?? true,
      latestSeq: this.nextSeq - 1,
      oldestSeq: this.events[0]?.seq ?? 0,
      historyCapacity: this.capacity,
      bootId: this.bootId,
    };
  }

  private summary(tx: MockTx): TransactionSummary {
    return {
      txHash: tx.hash,
      sender: tx.sender,
      payer: tx.payer,
      ...(tx.factory === undefined ? {} : { factory: tx.factory }),
      nonce: hex(tx.nonce),
      status: tx.status,
      frames: tx.frames.length,
      maxFeePerGas: hex(tx.maxFeePerGas),
      submittedTime: tx.submittedTime,
      lastUpdatedTime: tx.submittedTime,
    };
  }

  private listTransactions(p: Record<string, unknown>): RpcOutcome {
    let wanted: string | undefined;
    if (p.status !== undefined) {
      if (typeof p.status !== "string" || !(STATUSES as readonly string[]).includes(p.status)) {
        return fail(INVALID_REQUEST, `Unknown status: ${String(p.status)}`);
      }
      wanted = p.status;
    }
    const offset = p.cursor === undefined ? 0 : Number(p.cursor);
    if (!Number.isInteger(offset) || offset < 0) return fail(INVALID_REQUEST, `Invalid cursor: ${String(p.cursor)}`);
    const limit = clampLimit(p.limit);
    const all = [...this.pool.values()]
      .filter((tx) => wanted === undefined || tx.status === wanted)
      .sort((a, b) => b.submittedTime - a.submittedTime);
    const items = all.slice(offset, offset + limit).map((tx) => this.summary(tx));
    return {
      result: offset + limit < all.length ? { items, nextCursor: String(offset + limit) } : { items },
    };
  }

  private listAdmissions(p: Record<string, unknown>): RpcOutcome {
    if (p.outcome !== undefined && !["accepted", "rejected", "replaced"].includes(String(p.outcome))) {
      return fail(INVALID_REQUEST, `Unknown outcome: ${String(p.outcome)}`);
    }
    if (p.cursor !== undefined && !Number.isFinite(Number(p.cursor))) {
      return fail(INVALID_REQUEST, `Invalid cursor: ${String(p.cursor)}`);
    }
    const before = p.cursor === undefined ? Infinity : Number(p.cursor);
    const limit = clampLimit(p.limit);
    const matching = [...this.admissions.values()]
      .reverse()
      .filter((r) => r.id < before && (p.outcome === undefined || r.outcome === p.outcome));
    const items = matching.slice(0, limit);
    const last = items[items.length - 1];
    return {
      result: matching.length > limit && last ? { items, nextCursor: String(last.id) } : { items },
    };
  }

  private getTransaction(arg: unknown): RpcOutcome {
    if (typeof arg !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(arg)) {
      return fail(INVALID_REQUEST, "Expected a 32-byte hex transaction hash");
    }
    const hash = arg.toLowerCase();
    const tx = this.pool.get(hash);
    const admission = this.admissions.get(hash) ?? null;
    const events = this.events.filter((e) => e.txHash === hash);
    if (!tx && !admission && events.length === 0) return fail(INVALID_REQUEST, "Frame transaction not found");
    const detail: TransactionDetail = {
      hash,
      entry: tx
        ? {
            ...this.summary(tx),
            tx: serializeTx(tx),
            ...(tx.revertReason === undefined ? {} : { revertReason: tx.revertReason }),
          }
        : null,
      admission,
      events,
    };
    return { result: detail };
  }
}

/** The frame transaction as `getTransaction` serializes it: every quantity a `0x` hex string. */
export function serializeTx(tx: MockTx): Record<string, unknown> {
  return {
    chainId: hex(1337),
    nonce: hex(tx.nonce),
    sender: tx.sender,
    frames: tx.frames.map((f) => ({
      mode: f.mode,
      flags: f.flags,
      target: f.target,
      limits: { execution: hex(f.execution), state: hex(f.state ?? 0) },
      value: hex(f.value ?? 0),
      data: f.data ?? "0x",
    })),
    signatures: [],
    fees: { maxPriorityFeePerGas: hex(1_000_000_000), maxFeePerGas: hex(tx.maxFeePerGas), maxFeePerBlobGas: hex(0) },
    blobVersionedHashes: [],
  };
}

/** A clean report for an accepted transaction: every rule passes, per entity for its validation frames. */
export function passingChecks(tx: MockTx): Check[] {
  const globals = [
    "gas-limit", "prefix", "structure", "signature", "simulation", "trace-alignment", "OP-061", "execution",
  ];
  const perFrame = ["trace-alignment", "out-of-gas", "OP-011", "create", "storage", "COD-010", "entrypoint-access"];
  const checks: Check[] = globals.map((rule) => ({ rule, verdict: "pass" }));
  tx.frames.forEach((frame, frameIndex) => {
    // Only validation-prefix frames have an entity: a leading deploy frame is
    // the factory; a verify frame is the payer (payment scope) or the sender.
    let entity: Check["entity"];
    if (frame.mode === 0 && frameIndex === 0 && tx.factory !== undefined) entity = "factory";
    else if (frame.mode === 1) entity = (frame.flags & 1) !== 0 ? "payer" : "sender";
    else return;
    for (const rule of perFrame) checks.push({ rule, frameIndex, entity, verdict: "pass" });
  });
  checks.push({ rule: "mempool", verdict: "pass" });
  return checks;
}
```

**`packages/devnet-ui/mock/fixtures.ts`**

```ts
import type { Check, Peer } from "../src/protocol/schemas";
import { MockNode, passingChecks, type MockFrame, type MockTx } from "./state";

/** The fixed base time used by tests, so their expectations never change. */
export const T0 = 1_760_000_000_000;

/** Deterministic pseudo-random hex, so fixture hashes and addresses look real and never change. */
function hexOf(seed: number, length: number): string {
  let x = (seed * 2_654_435_761) % 2 ** 32;
  let out = "";
  while (out.length < length) {
    x = (x * 1_664_525 + 1_013_904_223) % 2 ** 32;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

export const hashOf = (seed: number): string => `0x${hexOf(seed, 64)}`;
export const addrOf = (seed: number): string => `0x${hexOf(seed + 1000, 40)}`;

const TOKEN = addrOf(20);
const PAYER = addrOf(10);
const FACTORY = addrOf(11);
const TRANSFER = `0xa9059cbb${hexOf(7, 128)}`;

const selfVerify: MockFrame = { mode: 1, flags: 3, target: null, execution: 30_000 };
const userOp = (data = TRANSFER): MockFrame => ({ mode: 2, flags: 0, target: TOKEN, execution: 60_000, data });

function selfRelay(seed: number, nonce: number, at: number, status: MockTx["status"] = "New"): MockTx {
  const sender = addrOf(seed);
  return {
    hash: hashOf(100 + seed),
    sender,
    payer: sender,
    nonce,
    status,
    frames: [{ ...selfVerify }, userOp()],
    maxFeePerGas: 2_000_000_000n,
    submittedTime: at,
  };
}

/**
 * Every fixture transaction, with times counted from `t0`. Tests use `TX`
 * (built from `T0`); the dev servers pass a `t0` just before "now" so the pages
 * read as recent.
 */
export function makeTx(t0: number) {
  return {
    onChain: selfRelay(1, 0, t0 + 1_000),
    sponsored: {
      hash: hashOf(102),
      sender: addrOf(2),
      payer: PAYER,
      nonce: 3,
      status: "New",
      frames: [
        { mode: 1, flags: 2, target: null, execution: 20_000 },
        { mode: 1, flags: 1, target: PAYER, execution: 25_000 },
        userOp(),
      ],
      maxFeePerGas: 3_500_000_000n,
      submittedTime: t0 + 30_000,
    } satisfies MockTx,
    fresh: selfRelay(3, 1, t0 + 60_000),
    bannedOpcode: selfRelay(4, 2, t0 + 65_000),
    noPrefix: {
      hash: hashOf(105),
      sender: addrOf(5),
      payer: addrOf(5),
      nonce: 0,
      status: "New",
      frames: [userOp()],
      maxFeePerGas: 1_000_000_000n,
      submittedTime: t0 + 68_000,
    } satisfies MockTx,
    waived: { ...selfRelay(8, 4, t0 + 70_000, "Pending"), payer: addrOf(8) },
    reverted: selfRelay(9, 5, t0 + 72_000),
    replacedOld: { ...selfRelay(6, 5, t0 + 80_000), hash: hashOf(106), maxFeePerGas: 1_500_000_000n },
    replacedNew: { ...selfRelay(6, 5, t0 + 95_000), hash: hashOf(107), maxFeePerGas: 4_000_000_000n },
    onlySecondary: selfRelay(12, 0, t0 + 100_000),
    withFactory: {
      hash: hashOf(113),
      sender: addrOf(13),
      payer: addrOf(13),
      factory: FACTORY,
      nonce: 0,
      status: "New",
      frames: [
        { mode: 0, flags: 0, target: FACTORY, execution: 200_000, state: 32_000 },
        { ...selfVerify },
        userOp(),
      ],
      maxFeePerGas: 2_000_000_000n,
      submittedTime: t0 + 110_000,
    } satisfies MockTx,
  };
}

/** The fixed-time set the tests use. */
export const TX = makeTx(T0);

const clean = (tx: MockTx): Check[] => passingChecks(tx);

const bannedOpcodeChecks: Check[] = [
  ...["gas-limit", "prefix", "structure", "signature", "simulation", "trace-alignment", "OP-061", "execution"].map(
    (rule): Check => ({ rule, verdict: "pass" }),
  ),
  { rule: "trace-alignment", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "out-of-gas", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "fail", detail: "payer uses banned opcode: DIFFICULTY" },
  { rule: "create", frameIndex: 0, entity: "payer", verdict: "pass" },
  {
    rule: "storage",
    frameIndex: 0,
    entity: "payer",
    verdict: "fail",
    detail: `unstaked payer accessed ${addrOf(30)} slot 0x0000000000000000000000000000000000000000000000000000000000000001`,
  },
  { rule: "COD-010", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "entrypoint-access", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "mempool", verdict: "skipped" },
];

const noPrefixChecks: Check[] = [
  { rule: "gas-limit", verdict: "pass" },
  { rule: "prefix", verdict: "fail", detail: "frame transaction validation prefix not recognized" },
  ...["structure", "signature", "simulation", "trace-alignment", "OP-061", "execution", "mempool"].map(
    (rule): Check => ({ rule, verdict: "skipped" }),
  ),
  ...["out-of-gas", "OP-011", "create", "storage", "COD-010", "entrypoint-access"].map(
    (rule): Check => ({ rule, verdict: "skipped" }),
  ),
];

const waivedChecks = (tx: MockTx): Check[] =>
  clean(tx).map((c) =>
    c.rule === "OP-011" && c.entity === "payer"
      ? { ...c, detail: "waived (whitelisted entity): payer uses banned opcode: GAS" }
      : c,
  );

export function peersAt(t0: number): Peer[] {
  return [
    {
      peerId: "16Uiu2HAmKZdV7rQx1uN3YqYc9bTn6k5Zc1fJb2uWq8PzGdXrEoL4",
      direction: "outbound",
      connectedAt: t0 - 3_600_000,
      lastReceivedAt: t0 + 60_000,
      agentVersion: "skandha/4.1.1",
      supportedMempools: ["QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk"],
    },
    {
      peerId: "16Uiu2HAm3PqWzE9nD5sTt8fVhK2uYxAqGcJb7rLmN4oXdRe1Ca6p",
      direction: "inbound",
      connectedAt: t0 - 120_000,
      lastReceivedAt: t0 + 30_000,
      agentVersion: null,
      supportedMempools: [],
    },
  ];
}

export const PEERS: Peer[] = peersAt(T0);

const clone = (tx: MockTx): MockTx => ({ ...tx, frames: tx.frames.map((f) => ({ ...f })) });

/** The primary fixture node: a busy pool with one of every interesting state. */
export function seedPrimary(node: MockNode, t0 = T0): MockNode {
  const t = makeTx(t0);
  const peerA = "gossip:16Uiu2HAmKZdV7rQx1uN3YqYc9bTn6k5Zc1fJb2uWq8PzGdXrEoL4";

  node.admit(clone(t.onChain), "rpc", undefined, t0 + 1_000);
  node.setStatus(t.onChain.hash, "Submitted", undefined, t0 + 2_500);
  node.setStatus(t.onChain.hash, "OnChain", undefined, t0 + 11_000);

  node.admit(clone(t.sponsored), peerA);
  node.setStatus(t.sponsored.hash, "Submitted", undefined, t0 + 31_000);

  node.admit(clone(t.fresh));
  node.reject(clone(t.bannedOpcode), bannedOpcodeChecks, peerA);
  node.reject(clone(t.noPrefix), noPrefixChecks, "rpc");
  node.admit(clone(t.waived), "rpc", waivedChecks(t.waived));
  node.admit(clone(t.reverted));
  node.setStatus(t.reverted.hash, "Reverted", "execution reverted: insufficient allowance", t0 + 74_000);
  node.admit(clone(t.replacedOld));
  node.replace(t.replacedOld.hash, clone(t.replacedNew), "rpc", t0 + 95_000);
  node.admit(clone(t.withFactory));
  return node;
}

/** A second node that saw part of the same traffic a little later, plus one transaction of its own. */
export function seedSecondary(node: MockNode, t0 = T0): MockNode {
  const t = makeTx(t0);
  const via = "gossip:16Uiu2HAm3PqWzE9nD5sTt8fVhK2uYxAqGcJb7rLmN4oXdRe1Ca6p";
  node.admit({ ...clone(t.onChain), submittedTime: t0 + 1_240 }, via, undefined, t0 + 1_240);
  node.setStatus(t.onChain.hash, "OnChain", undefined, t0 + 11_400);
  node.admit({ ...clone(t.fresh), submittedTime: t0 + 61_200 }, via, undefined, t0 + 61_200);
  node.admit(clone(t.onlySecondary), "rpc");
  return node;
}

export function primaryNode(now?: () => number, t0 = T0): MockNode {
  return seedPrimary(
    new MockNode({ name: "Devnet miner", bootId: "0a1b2c3d4e5f6071", peers: peersAt(t0), now }),
    t0,
  );
}

export function secondaryNode(now?: () => number, t0 = T0): MockNode {
  return seedSecondary(new MockNode({ name: "Local peer", bootId: "7160f5e4d3c2b1a0", p2pEnabled: false, now }), t0);
}

export function disabledNode(): MockNode {
  return new MockNode({ name: "No explorer", explorerEnabled: false });
}

/** A fresh self-relay transaction for live demos and browser tests (`n` picks its hash and sender). */
export function liveTx(n: number, at: number): MockTx {
  return { ...selfRelay(200 + n, 0, at), hash: hashOf(300 + n) };
}
```

**`packages/devnet-ui/mock/ports.ts`**

```ts
/** Ports for the three mock nodes; `bun run mock` and the browser tests use the same ones. */
export const MOCK_PORTS = { primary: 14401, secondary: 14402, disabled: 14403 } as const;
```


- [ ] **Step 4: Run the tests and the type-check**

```bash
cd packages/devnet-ui && bunx vitest run && bunx tsc --noEmit
```

Expected: `Tests  92 passed (92)` (72 before + 20 mock); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/devnet-ui/mock
git commit -m "$(cat <<'EOF'
feat(devnet-ui): mock explorer node with the real protocol behavior

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 7: Data layer

**Files:**
- Create: `packages/devnet-ui/src/data/keys.ts`, `src/data/liveFeed.ts`, `src/data/live.tsx`, `src/data/hooks.ts`, `src/instances/context.tsx`
- Test: `packages/devnet-ui/src/data/live.test.tsx`

**Interfaces:**
- Consumes: `explorerApi` and error kinds (Task 2), `ExplorerStream` (Task 3), the instance store (Task 4).
- Produces: `keys`; `LiveFeed`; `LiveProvider`, `useLive`, `useFresh`, `StreamFactoryContext`, `createBrowserStream`, `StreamFactory`; hooks `useInfo`, `usePool`, `useActivity`, `usePeers`, `useTransaction`, `useAcrossInstances`, `fetchTransaction`, `useNow`; `InstancesProvider`, `useInstances`.

`LiveProvider` owns the selected instance's stream. Events refresh that instance's queries (batched over 250 ms); reaching "live" refreshes everything; a restart or history gap resets everything and shows a notice; switching instance stops the old stream; renaming an instance does not restart it. Queries poll only while the stream is not live. A transaction the node has never heard of resolves to `null` (an answer), so the UI can tell "not there" from "could not ask".

- [ ] **Step 1: Write the failing tests**

**`packages/devnet-ui/src/data/live.test.tsx`**

```tsx
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveProvider, useFresh, useLive, type StreamFactory } from "./live";
import { LiveFeed } from "./liveFeed";
import { keys } from "./keys";
import type { StreamCallbacks } from "../rpc/stream";
import type { Instance } from "../instances/store";
import type { LifecycleEventData } from "../protocol/schemas";

const A: Instance = { name: "Devnet", url: "https://a.example/rpc" };
const B: Instance = { name: "Local", url: "http://localhost:14337/rpc" };

const event = (seq: number, txHash = `0x${seq}`): LifecycleEventData => ({
  seq,
  txHash,
  at: 1,
  kind: "admitted",
});

function Probe({ hash = "0xaa" }: { hash?: string }) {
  const live = useLive();
  const fresh = useFresh(hash);
  return (
    <div>
      <p data-testid="status">{live.status}</p>
      <p data-testid="fatal">{live.fatal ?? "-"}</p>
      <p data-testid="notice">{live.notice ?? "-"}</p>
      <p data-testid="fresh">{String(fresh)}</p>
      <button onClick={live.dismissNotice}>dismiss</button>
    </div>
  );
}

function setup(instance: Instance | null) {
  const created: Array<{ instance: Instance; callbacks: StreamCallbacks; start: () => void; stop: () => void }> = [];
  const factory: StreamFactory = (inst, callbacks) => {
    const handle = { instance: inst, callbacks, start: vi.fn(), stop: vi.fn() };
    created.push(handle);
    return handle;
  };
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const reset = vi.spyOn(client, "resetQueries");
  const tree = (inst: Instance | null) => (
    <QueryClientProvider client={client}>
      <LiveProvider instance={inst} createStream={factory}>
        <Probe />
      </LiveProvider>
    </QueryClientProvider>
  );
  const view = render(tree(instance));
  return { created, invalidate, reset, view, tree };
}

describe("LiveProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a stream for the selected instance and mirrors its status", () => {
    const { created } = setup(A);
    expect(created).toHaveLength(1);
    expect(created[0]?.instance).toEqual(A);
    expect(created[0]?.start).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status").textContent).toBe("connecting");
    act(() => created[0]?.callbacks.onStatus("reconnecting"));
    expect(screen.getByTestId("status").textContent).toBe("reconnecting");
  });

  it("does not start anything without an instance", () => {
    const { created } = setup(null);
    expect(created).toHaveLength(0);
  });

  it("batches events into one refresh of that instance's queries", () => {
    const { created, invalidate } = setup(A);
    act(() => {
      created[0]?.callbacks.onEvent(event(1));
      created[0]?.callbacks.onEvent(event(2));
      created[0]?.callbacks.onEvent(event(3));
    });
    expect(invalidate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.all(A.url) });
  });

  it("refreshes everything whenever the stream goes live", () => {
    const { created, invalidate } = setup(A);
    act(() => created[0]?.callbacks.onStatus("live"));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.all(A.url) });
  });

  it("highlights a transaction briefly after an event for it", () => {
    const { created } = setup(A);
    expect(screen.getByTestId("fresh").textContent).toBe("false");
    act(() => created[0]?.callbacks.onEvent(event(1, "0xAA")));
    expect(screen.getByTestId("fresh").textContent).toBe("true");
    act(() => vi.advanceTimersByTime(2600));
    expect(screen.getByTestId("fresh").textContent).toBe("false");
  });

  it("resets the instance's queries and explains a restart, until dismissed", () => {
    const { created, reset } = setup(A);
    act(() => created[0]?.callbacks.onReset("restart"));
    expect(reset).toHaveBeenCalledWith({ queryKey: keys.all(A.url) });
    expect(screen.getByTestId("notice").textContent).toContain("restarted");
    act(() => screen.getByText("dismiss").click());
    expect(screen.getByTestId("notice").textContent).toBe("-");
  });

  it("explains a history gap differently from a restart", () => {
    const { created } = setup(A);
    act(() => created[0]?.callbacks.onReset("gap"));
    expect(screen.getByTestId("notice").textContent).toContain("dropped some history");
  });

  it("surfaces a fatal stream error", () => {
    const { created } = setup(A);
    act(() => created[0]?.callbacks.onFatal("Explorer is disabled"));
    expect(screen.getByTestId("fatal").textContent).toBe("Explorer is disabled");
  });

  it("stops the old stream and starts a new one when the instance changes", () => {
    const { created, view, tree } = setup(A);
    view.rerender(tree(B));
    expect(created[0]?.stop).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(2);
    expect(created[1]?.instance).toEqual(B);
    expect(screen.getByTestId("status").textContent).toBe("connecting");
  });

  it("keeps the stream when an instance is only renamed", () => {
    const { created, view, tree } = setup(A);
    view.rerender(tree({ ...A, name: "Renamed" }));
    expect(created).toHaveLength(1);
    expect(created[0]?.stop).not.toHaveBeenCalled();
  });

  it("stops the stream on unmount and cancels a pending refresh", () => {
    const { created, invalidate, view } = setup(A);
    act(() => created[0]?.callbacks.onEvent(event(1)));
    view.unmount();
    expect(created[0]?.stop).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(500));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("LiveFeed", () => {
  it("treats an arrival as fresh until its ttl passes, ignoring hash case", () => {
    let now = 1000;
    const feed = new LiveFeed(() => now, 2500, () => undefined);
    feed.push(event(1, "0xAbC"));
    expect(feed.isFresh("0xabc")).toBe(true);
    now += 2499;
    expect(feed.isFresh("0xABC")).toBe(true);
    now += 1;
    expect(feed.isFresh("0xabc")).toBe(false);
    expect(feed.isFresh("0xother")).toBe(false);
  });

  it("notifies subscribers on push and on expiry, and stops after unsubscribe", () => {
    const timers: Array<() => void> = [];
    const feed = new LiveFeed(() => 0, 2500, (fn) => timers.push(fn));
    const calls: number[] = [];
    const off = feed.subscribe(() => calls.push(feed.getSnapshot()));
    feed.push(event(1));
    expect(calls).toEqual([1]);
    timers[0]?.();
    expect(calls).toEqual([1, 2]);
    off();
    feed.push(event(2));
    expect(calls).toEqual([1, 2]);
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run src/data
```

Expected: FAIL (`Failed to load url ./live`).

- [ ] **Step 3: Write the implementation**

**`packages/devnet-ui/src/data/keys.ts`**

```ts
/**
 * React Query keys. Every key starts with the instance URL so that everything
 * held for one node can be invalidated or reset with a single prefix.
 */
export const keys = {
  all: (url: string) => ["x", url] as const,
  info: (url: string) => ["x", url, "info"] as const,
  pool: (url: string, status: string) => ["x", url, "pool", status] as const,
  activity: (url: string, outcome: string) => ["x", url, "activity", outcome] as const,
  tx: (url: string, hash: string) => ["x", url, "tx", hash.toLowerCase()] as const,
  peers: (url: string) => ["x", url, "peers"] as const,
};
```

**`packages/devnet-ui/src/data/liveFeed.ts`**

```ts
import type { LifecycleEventData } from "../protocol/schemas";

/**
 * Remembers which transactions just changed, so a row can be highlighted for a
 * moment after a live event. External-store shaped for `useSyncExternalStore`.
 */
export class LiveFeed {
  private readonly arrivals = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly ttlMs = 2500,
    private readonly setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  ) {}

  push(event: LifecycleEventData): void {
    this.arrivals.set(event.txHash.toLowerCase(), this.clock());
    this.bump();
    // Re-render once the highlight has expired.
    this.setTimer(() => this.bump(), this.ttlMs + 20);
  }

  isFresh(txHash: string): boolean {
    const at = this.arrivals.get(txHash.toLowerCase());
    return at !== undefined && this.clock() - at < this.ttlMs;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
```

**`packages/devnet-ui/src/data/live.tsx`**

```tsx
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { explorerApi } from "../rpc/methods";
import { ExplorerStream, type SocketLike, type StreamCallbacks, type StreamStatus } from "../rpc/stream";
import { wsUrl, type Instance } from "../instances/store";
import { keys } from "./keys";
import { LiveFeed } from "./liveFeed";

export interface StreamHandle {
  start(): void;
  stop(): void;
}

export type StreamFactory = (instance: Instance, callbacks: StreamCallbacks) => StreamHandle;

/** The real stream: a browser WebSocket to the instance, with `info` for restart and gap checks. */
export const createBrowserStream: StreamFactory = (instance, callbacks) =>
  new ExplorerStream(
    wsUrl(instance.url),
    {
      // `SocketLike` is the small subset of WebSocket the stream uses.
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      fetchInfo: () => explorerApi.info(instance.url),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    callbacks,
  );

/** Lets the app (and tests) choose how streams are created without threading a prop through the router. */
export const StreamFactoryContext = createContext<StreamFactory>(createBrowserStream);

export interface LiveState {
  status: StreamStatus;
  /** Set when the stream can never work here (the explorer is off); polling stays on. */
  fatal: string | null;
  /** A one-off message, such as "The node restarted"; cleared by `dismissNotice`. */
  notice: string | null;
  dismissNotice(): void;
  feed: LiveFeed;
}

const defaultFeed = new LiveFeed();
const LiveContext = createContext<LiveState>({
  status: "connecting",
  fatal: null,
  notice: null,
  dismissNotice: () => {},
  feed: defaultFeed,
});

export function useLive(): LiveState {
  return useContext(LiveContext);
}

/** True while `txHash` changed a moment ago. Re-renders when the highlight starts and ends. */
export function useFresh(txHash: string): boolean {
  const { feed } = useLive();
  useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  return feed.isFresh(txHash);
}

/** How long to batch stream events before refetching what they touched. */
const REFRESH_DEBOUNCE_MS = 250;

/**
 * Owns the stream for the selected instance. Events refresh that instance's
 * queries (batched); reconnects refresh everything; a restart or history gap
 * resets everything and shows a notice. Switching instance stops the old stream.
 */
export function LiveProvider({
  instance,
  children,
  createStream,
}: {
  instance: Instance | null;
  children: ReactNode;
  /** Overrides the factory from `StreamFactoryContext`. */
  createStream?: StreamFactory;
}) {
  const queryClient = useQueryClient();
  const contextFactory = useContext(StreamFactoryContext);
  const feed = useMemo(() => new LiveFeed(), []);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const url = instance?.url ?? null;
  const factoryRef = useRef(createStream ?? contextFactory);
  factoryRef.current = createStream ?? contextFactory;

  useEffect(() => {
    setStatus("connecting");
    setFatal(null);
    setNotice(null);
    if (!instance || url === null) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      refreshTimer = null;
      void queryClient.invalidateQueries({ queryKey: keys.all(url) });
    };

    const stream = factoryRef.current(instance, {
      onEvent: (event) => {
        feed.push(event);
        if (refreshTimer === null) refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
      },
      onStatus: (next) => {
        setStatus(next);
        if (next === "live") void queryClient.invalidateQueries({ queryKey: keys.all(url) });
      },
      onReset: (reason) => {
        void queryClient.resetQueries({ queryKey: keys.all(url) });
        setNotice(
          reason === "restart"
            ? "This node restarted, so its history was reloaded."
            : "This node dropped some history while you were disconnected, so it was reloaded.",
        );
      },
      onFatal: (message) => setFatal(message),
    });
    stream.start();

    return () => {
      stream.stop();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    };
    // The stream belongs to the instance's URL; renaming an instance must not restart it.
  }, [url, queryClient, feed]);

  const value = useMemo<LiveState>(
    () => ({ status, fatal, notice, dismissNotice: () => setNotice(null), feed }),
    [status, fatal, notice, feed],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
```

**`packages/devnet-ui/src/data/hooks.ts`**

```ts
import { useEffect, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { explorerApi } from "../rpc/methods";
import { RpcMethodError } from "../rpc/errors";
import type { TransactionDetail } from "../protocol/schemas";
import { keys } from "./keys";
import { useLive } from "./live";

/** Poll only while the stream is not delivering; a live stream refreshes queries itself. */
const POLL_MS = 5000;
const INFO_POLL_MS = 10_000;

function usePollInterval(): number | false {
  const { status } = useLive();
  return status === "live" ? false : POLL_MS;
}

/** Node facts, polled so the instance list can show which nodes are up. */
export function useInfo(url: string) {
  return useQuery({
    queryKey: keys.info(url),
    queryFn: ({ signal }) => explorerApi.info(url, { signal }),
    refetchInterval: INFO_POLL_MS,
    retry: false,
  });
}

export function usePool(url: string, status: string) {
  const refetchInterval = usePollInterval();
  return useInfiniteQuery({
    queryKey: keys.pool(url, status),
    queryFn: ({ pageParam, signal }) =>
      explorerApi.listTransactions(
        url,
        { status: status === "all" ? undefined : status, cursor: pageParam, limit: 50 },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval,
    retry: false,
  });
}

export function useActivity(url: string, outcome: "all" | "accepted" | "rejected" | "replaced") {
  const refetchInterval = usePollInterval();
  return useInfiniteQuery({
    queryKey: keys.activity(url, outcome),
    queryFn: ({ pageParam, signal }) =>
      explorerApi.listAdmissions(
        url,
        { outcome: outcome === "all" ? undefined : outcome, cursor: pageParam, limit: 50 },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval,
    retry: false,
  });
}

export function usePeers(url: string) {
  const refetchInterval = usePollInterval();
  return useQuery({
    queryKey: keys.peers(url),
    queryFn: ({ signal }) => explorerApi.peers(url, { signal }),
    refetchInterval,
    retry: false,
  });
}

function isNotFound(err: unknown): boolean {
  return err instanceof RpcMethodError && /not found/i.test(err.message);
}

/**
 * One node's view of a transaction. Resolves to `null` when the node has never
 * heard of it: that is an answer, not an error, so callers can tell "not there"
 * from "could not ask".
 */
export async function fetchTransaction(
  url: string,
  hash: string,
  signal?: AbortSignal,
): Promise<TransactionDetail | null> {
  try {
    return await explorerApi.getTransaction(url, hash, { signal });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export function useTransaction(url: string, hash: string) {
  const refetchInterval = usePollInterval();
  return useQuery<TransactionDetail | null>({
    queryKey: keys.tx(url, hash),
    queryFn: ({ signal }) => fetchTransaction(url, hash, signal),
    refetchInterval,
    retry: false,
  });
}

/** Asks every listed instance about one transaction, for the cross-instance view. */
export function useAcrossInstances(urls: string[], hash: string) {
  const refetchInterval = usePollInterval();
  return useQueries({
    queries: urls.map((url) => ({
      queryKey: keys.tx(url, hash),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchTransaction(url, hash, signal),
      refetchInterval,
      retry: false,
    })),
  });
}

/** The current time, refreshed on an interval, so "12 s ago" labels stay honest. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
```

**`packages/devnet-ui/src/instances/context.tsx`**

```tsx
import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import {
  defaultInstances,
  instancesReducer,
  loadState,
  saveState,
  type Instance,
  type InstancesAction,
  type InstancesState,
} from "./store";

interface InstancesValue {
  instances: Instance[];
  selected: Instance | null;
  dispatch: Dispatch<InstancesAction>;
}

const InstancesContext = createContext<InstancesValue | null>(null);

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // some browsers throw when storage is blocked
  }
}

export function InstancesProvider({
  children,
  initial,
}: {
  children: ReactNode;
  /** Tests pass a fixed starting state; the app loads the saved list. */
  initial?: InstancesState;
}) {
  const [state, dispatch] = useReducer(instancesReducer, undefined, () =>
    initial ??
    loadState(browserStorage(), defaultInstances(import.meta.env.VITE_EXPLORER_INSTANCES as string | undefined)),
  );

  useEffect(() => {
    if (!initial) saveState(browserStorage(), state);
  }, [state, initial]);

  const value = useMemo<InstancesValue>(
    () => ({
      instances: state.instances,
      selected: state.instances.find((i) => i.url === state.selectedUrl) ?? null,
      dispatch,
    }),
    [state],
  );
  return <InstancesContext.Provider value={value}>{children}</InstancesContext.Provider>;
}

export function useInstances(): InstancesValue {
  const value = useContext(InstancesContext);
  if (!value) throw new Error("useInstances must be used inside <InstancesProvider>");
  return value;
}
```


- [ ] **Step 4: Run the tests and the type-check**

```bash
cd packages/devnet-ui && bunx vitest run && bunx tsc --noEmit
```

Expected: `Tests  105 passed (105)` (92 before + 13 live); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/devnet-ui/src/data packages/devnet-ui/src/instances/context.tsx
git commit -m "$(cat <<'EOF'
feat(devnet-ui): query hooks and the provider that owns the selected node's stream

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 8: Design foundation and the frame strip

**Files:**
- Create: `packages/devnet-ui/src/index.css`, `src/ui/VerdictMark.tsx`, `src/ui/StatusBadge.tsx`, `src/ui/CopyText.tsx`, `src/ui/Banner.tsx`, `src/ui/FrameStrip.tsx`
- Test: `packages/devnet-ui/src/ui/primitives.test.tsx`

**Interfaces:**
- Consumes: `Check` (Task 1), `modeName` and `ruleInfo` (Task 5).
- Produces: `VerdictMark`, `verdictLabel`, `Verdict`; `StatusBadge`; `CopyText`; `Banner`; `FrameStrip`, `frameVerdict`, `framesFromChecks`, `framesOfCount`, `StripFrame`; the design tokens in `index.css`.

`CopyText` must never claim a copy that did not happen: with no clipboard it does nothing (a check the tests pin; the first version of this code got it wrong). Note for tests that use `userEvent.setup()`: it installs its own clipboard stub, so stub `navigator.clipboard` after calling it.

- [ ] **Step 1: Write the failing tests**

**`packages/devnet-ui/src/ui/primitives.test.tsx`**

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Banner } from "./Banner";
import { CopyText } from "./CopyText";
import { FrameStrip, frameVerdict, framesFromChecks, framesOfCount } from "./FrameStrip";
import { StatusBadge } from "./StatusBadge";
import { VerdictMark } from "./VerdictMark";
import type { Check } from "../protocol/schemas";

describe("VerdictMark", () => {
  it("names each verdict for assistive technology", () => {
    render(
      <>
        <VerdictMark verdict="pass" />
        <VerdictMark verdict="fail" />
        <VerdictMark verdict="skipped" />
        <VerdictMark verdict="fail" title="Banned opcodes: failed" />
      </>,
    );
    expect(screen.getByRole("img", { name: "Passed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Not evaluated" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Banned opcodes: failed" })).toBeTruthy();
  });
});

describe("StatusBadge", () => {
  it("shows a readable label and passes unknown statuses through", () => {
    render(
      <>
        <StatusBadge status="OnChain" />
        <StatusBadge status="rejected" />
        <StatusBadge status="SomethingNew" />
      </>,
    );
    expect(screen.getByText("On chain")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(screen.getByText("SomethingNew")).toBeTruthy();
  });
});

describe("Banner", () => {
  it("is an alert for errors and a status otherwise, with a hint and an action", () => {
    render(
      <>
        <Banner tone="error" title="Couldn't reach node" hint="Check the URL." action={<button>Try again</button>} />
        <Banner tone="info" title="Reloaded" />
      </>,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Couldn't reach node")).toBeTruthy();
    expect(within(alert).getByText("Check the URL.")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Reloaded");
  });
});

describe("CopyText", () => {
  it("copies the full value and announces it", async () => {
    const user = userEvent.setup();
    // Defined after setup(): user-event installs its own clipboard stub there.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyText value="0x1234567890abcdef" display="0x1234…cdef" />);
    const button = screen.getByRole("button", { name: /0x1234…cdef/ });
    expect(button.getAttribute("title")).toBe("Copy 0x1234567890abcdef");
    await user.click(button);
    expect(writeText).toHaveBeenCalledWith("0x1234567890abcdef");
    expect(await screen.findByText("Copied to clipboard")).toBeTruthy();
  });

  it("does not claim a copy when the clipboard is unavailable", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<CopyText value="0xabc" />);
    await user.click(screen.getByRole("button"));
    expect(screen.queryByText("Copied to clipboard")).toBeNull();
  });
});

const checks: Check[] = [
  { rule: "trace-alignment", frameIndex: 0, entity: "payer", verdict: "pass" },
  { rule: "OP-011", frameIndex: 0, entity: "payer", verdict: "fail", detail: "x" },
  { rule: "trace-alignment", frameIndex: 1, entity: "sender", verdict: "pass" },
];

describe("frameVerdict", () => {
  it("fails on any failure, is skipped only when everything is, and is undefined with no checks", () => {
    expect(frameVerdict([])).toBeUndefined();
    expect(frameVerdict(checks.slice(0, 2))).toBe("fail");
    expect(frameVerdict([{ rule: "a", verdict: "skipped" }])).toBe("skipped");
    expect(frameVerdict([{ rule: "a", verdict: "pass" }, { rule: "b", verdict: "skipped" }])).toBe("pass");
  });
});

describe("frame helpers", () => {
  it("derives frames from a report when the transaction is gone", () => {
    expect(framesFromChecks([...checks, { rule: "prefix", verdict: "pass" }])).toEqual([
      { index: 0, entity: "payer" },
      { index: 1, entity: "sender" },
    ]);
    expect(framesOfCount(3).map((f) => f.index)).toEqual([0, 1, 2]);
  });
});

describe("FrameStrip", () => {
  const frames = [
    { index: 0, mode: 1, role: "self-verification", entity: "payer" },
    { index: 1, mode: 2, role: "user operation", atomic: true },
  ];

  it("small: labels each frame with its role and verdict", () => {
    render(<FrameStrip frames={frames} checks={checks} />);
    expect(screen.getByLabelText("Frame 0, self-verification: failed")).toBeTruthy();
    expect(screen.getByLabelText("Frame 1, user operation: passed")).toBeTruthy();
  });

  it("small: marks a failure that happened before any frame was examined", () => {
    render(<FrameStrip frames={[]} globalFailure={{ rule: "prefix", verdict: "fail" }} />);
    expect(screen.getByLabelText("Validation prefix: failed")).toBeTruthy();
  });

  it("small: draws frames whose mode is unknown, with no verdict when there are no checks", () => {
    render(<FrameStrip frames={framesOfCount(2)} />);
    expect(screen.getByLabelText("Frame 0")).toBeTruthy();
    expect(screen.getByLabelText("Frame 1")).toBeTruthy();
  });

  it("large: shows role, entity, atomic flag and one mark per check", () => {
    render(<FrameStrip frames={frames} checks={checks} size="lg" />);
    expect(screen.getByText("self-verification")).toBeTruthy();
    expect(screen.getByText("payer")).toBeTruthy();
    expect(screen.getByText("atomic with the next frame")).toBeTruthy();
    const marks = screen.getByLabelText("Checks for frame 0");
    expect(within(marks).getByRole("img", { name: "Banned opcodes: failed" })).toBeTruthy();
    expect(within(marks).getByRole("img", { name: "Trace alignment: passed" })).toBeTruthy();
  });

  it("large: shows a before-the-frames block for a transaction-level failure", () => {
    render(<FrameStrip frames={[]} size="lg" globalFailure={{ rule: "prefix", verdict: "fail" }} />);
    expect(screen.getByText("Before the frames")).toBeTruthy();
    expect(screen.getByText("Validation prefix")).toBeTruthy();
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run src/ui
```

Expected: FAIL (`Failed to load url ./Banner`).

- [ ] **Step 3: Write the implementation**

**`packages/devnet-ui/src/index.css`**

```css
@import "@fontsource-variable/bricolage-grotesque";
@import "@fontsource-variable/instrument-sans";
@import "@fontsource-variable/spline-sans-mono";
@import "tailwindcss";

/*
 * Design tokens. A cool, slightly blue "fog" ground with a petrol ink; verdict
 * colors are the only saturated hues, so a failed rule is the loudest thing on
 * any screen. Pass and fail are never color alone: they also differ in shape.
 */
:root {
  color-scheme: light dark;
  --paper: #e9eef1;
  --rail: #dbe3e8;
  --raised: #f5f8f9;
  --ink: #12232e;
  --ink-soft: #46596a;
  --line: #bccad3;
  --accent: #2b49c4;
  --accent-wash: #d3ddf7;
  --pass: #0b7a63;
  --fail: #c2263f;
  --warn: #8f5400;
  --mute: #7b8c97;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0f1a22;
    --rail: #16252f;
    --raised: #1b2d39;
    --ink: #dbe6ec;
    --ink-soft: #9fb3c0;
    --line: #2d4351;
    --accent: #8fa6ff;
    --accent-wash: #22305f;
    --pass: #4cc9a8;
    --fail: #ff7a90;
    --warn: #e6b04c;
    --mute: #6b8291;
  }
}

@theme inline {
  --color-paper: var(--paper);
  --color-rail: var(--rail);
  --color-raised: var(--raised);
  --color-ink: var(--ink);
  --color-ink-soft: var(--ink-soft);
  --color-line: var(--line);
  --color-accent: var(--accent);
  --color-accent-wash: var(--accent-wash);
  --color-pass: var(--pass);
  --color-fail: var(--fail);
  --color-warn: var(--warn);
  --color-mute: var(--mute);
  --font-display: "Bricolage Grotesque Variable", ui-sans-serif, system-ui, sans-serif;
  --font-sans: "Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Spline Sans Mono Variable", ui-monospace, SFMono-Regular, monospace;
}

@layer base {
  html {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: 15px;
    line-height: 1.5;
    -webkit-text-size-adjust: 100%;
  }
  body {
    margin: 0;
    min-height: 100vh;
  }
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  button,
  input,
  select {
    font: inherit;
    color: inherit;
  }
  h1,
  h2,
  h3 {
    font-family: var(--font-display);
    line-height: 1.15;
    margin: 0;
  }
  table {
    border-collapse: collapse;
  }
}

@layer utilities {
  .tabular {
    font-variant-numeric: tabular-nums;
  }
}

/* A row that just changed: a fading wash, plus a static marker for reduced motion. */
@keyframes arrive {
  from {
    background-color: var(--accent-wash);
  }
  to {
    background-color: transparent;
  }
}

.row-fresh {
  box-shadow: inset 3px 0 0 var(--accent);
}

@media (prefers-reduced-motion: no-preference) {
  .row-fresh {
    animation: arrive 2.4s ease-out;
  }
}
```

**`packages/devnet-ui/src/ui/VerdictMark.tsx`**

```tsx
import clsx from "clsx";

export type Verdict = "pass" | "fail" | "skipped";

const LABEL: Record<Verdict, string> = {
  pass: "Passed",
  fail: "Failed",
  skipped: "Not evaluated",
};

export function verdictLabel(verdict: Verdict): string {
  return LABEL[verdict];
}

/**
 * A rule's verdict as a shape as well as a color: a filled circle with a tick
 * (passed), a filled diamond with a cross (failed), a dashed ring (not evaluated).
 */
export function VerdictMark({
  verdict,
  size = 14,
  title,
}: {
  verdict: Verdict;
  size?: number;
  /** Overrides the accessible name, for example "Banned opcodes: failed". */
  title?: string;
}) {
  const label = title ?? LABEL[verdict];
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={clsx(
        "shrink-0",
        verdict === "pass" && "text-pass",
        verdict === "fail" && "text-fail",
        verdict === "skipped" && "text-ink-soft",
      )}
    >
      <title>{label}</title>
      {verdict === "pass" && (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M4.6 8.3l2.2 2.2 4.6-4.9"
            fill="none"
            stroke="var(--paper)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {verdict === "fail" && (
        <>
          <path d="M8 0.8 15.2 8 8 15.2 0.8 8Z" fill="currentColor" />
          <path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="var(--paper)" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
      {verdict === "skipped" && (
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.6 2.4" />
      )}
    </svg>
  );
}
```

**`packages/devnet-ui/src/ui/StatusBadge.tsx`**

```tsx
import clsx from "clsx";

type Tone = "pass" | "fail" | "warn" | "accent" | "mute";

const TONE: Record<string, Tone> = {
  New: "mute",
  Pending: "warn",
  Submitted: "accent",
  OnChain: "pass",
  Finalized: "pass",
  Cancelled: "mute",
  Reverted: "fail",
  accepted: "pass",
  rejected: "fail",
  replaced: "mute",
};

const LABEL: Record<string, string> = {
  New: "New",
  Pending: "Pending",
  Submitted: "Submitted",
  OnChain: "On chain",
  Finalized: "Finalized",
  Cancelled: "Cancelled",
  Reverted: "Reverted",
  accepted: "Accepted",
  rejected: "Rejected",
  replaced: "Replaced",
};

const DOT: Record<Tone, string> = {
  pass: "bg-pass",
  fail: "bg-fail",
  warn: "bg-warn",
  accent: "bg-accent",
  mute: "border border-ink-soft",
};

/** A mempool status or an admission outcome: a small dot and the word. */
export function StatusBadge({ status }: { status: string }) {
  const tone = TONE[status] ?? "mute";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={clsx("size-2 rounded-full", DOT[tone])} />
      {LABEL[status] ?? status}
    </span>
  );
}
```

**`packages/devnet-ui/src/ui/CopyText.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

/** Monospaced text that copies its full value when pressed. */
export function CopyText({
  value,
  display,
  className,
}: {
  value: string;
  /** What to show; defaults to the full value. */
  display?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    // No clipboard (an insecure origin, or blocked): do nothing rather than claim a copy.
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      // Copying can be blocked (insecure origin); the full value is still in the title.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${value}`}
      className={clsx(
        "cursor-copy text-left font-mono text-[0.8125rem] decoration-dotted underline-offset-4 hover:underline",
        className,
      )}
    >
      {display ?? value}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}
```

**`packages/devnet-ui/src/ui/Banner.tsx`**

```tsx
import type { ReactNode } from "react";
import clsx from "clsx";

const TONE = {
  error: "border-fail",
  warn: "border-warn",
  info: "border-accent",
} as const;

/** A message with a next step. Errors say what happened and what to try; they never apologize. */
export function Banner({
  tone,
  title,
  hint,
  action,
}: {
  tone: keyof typeof TONE;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={clsx("flex flex-wrap items-start gap-x-6 gap-y-2 border-l-4 bg-raised px-4 py-3", TONE[tone])}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {hint && <p className="max-w-[68ch] text-ink-soft">{hint}</p>}
      </div>
      {action}
    </div>
  );
}
```

**`packages/devnet-ui/src/ui/FrameStrip.tsx`**

```tsx
import clsx from "clsx";
import type { Check } from "../protocol/schemas";
import { modeName } from "../logic/frames";
import { ruleInfo } from "../logic/rules";
import { VerdictMark, verdictLabel, type Verdict } from "./VerdictMark";

export interface StripFrame {
  index: number;
  /** 0 default, 1 verify, 2 sender. Unknown when only a frame count is known. */
  mode?: number;
  role?: string;
  entity?: string;
  atomic?: boolean;
}

/** The overall verdict for a frame's checks: any failure fails it; all skipped is skipped. */
export function frameVerdict(checks: Check[]): Verdict | undefined {
  if (checks.length === 0) return undefined;
  if (checks.some((c) => c.verdict === "fail")) return "fail";
  if (checks.every((c) => c.verdict === "skipped")) return "skipped";
  return "pass";
}

/** Frames implied by a report, for a transaction that is no longer in the pool. */
export function framesFromChecks(checks: Check[]): StripFrame[] {
  const seen = new Map<number, StripFrame>();
  for (const check of checks) {
    if (check.frameIndex !== undefined && check.frameIndex >= 0 && !seen.has(check.frameIndex)) {
      seen.set(check.frameIndex, { index: check.frameIndex, entity: check.entity });
    }
  }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

/** A bare strip of `count` frames whose modes are not known. */
export function framesOfCount(count: number): StripFrame[] {
  return Array.from({ length: count }, (_, index) => ({ index }));
}

/**
 * How a frame block looks. Mode is the shape: verify is solid, sender is an
 * outline, default is a dashed outline. A failed frame turns red in all three.
 */
function blockClass(mode: number | undefined, verdict: Verdict | undefined): string {
  const failed = verdict === "fail";
  if (mode === 1) {
    if (failed) return "bg-fail text-paper";
    return verdict === "skipped" ? "bg-rail text-ink-soft" : "bg-ink text-paper";
  }
  if (mode === 2) return clsx("border-2 bg-transparent", failed ? "border-fail text-fail" : "border-ink text-ink");
  if (mode === 0) {
    return clsx("border-2 border-dashed bg-transparent", failed ? "border-fail text-fail" : "border-ink text-ink");
  }
  return failed ? "border-2 border-fail text-fail" : "border border-line bg-rail text-ink-soft";
}

const GLYPH: Record<Verdict, string> = { pass: "✓", fail: "✕", skipped: "–" };

/**
 * A frame transaction drawn as its frames, left to right. The small size fits a
 * table row; the large size adds each frame's role and the verdict of every
 * rule that checked it. `globalFailure` marks a failure before any frame was
 * examined, such as an unrecognized prefix.
 */
export function FrameStrip({
  frames,
  checks = [],
  size = "sm",
  globalFailure,
}: {
  frames: StripFrame[];
  checks?: Check[];
  size?: "sm" | "lg";
  globalFailure?: Check;
}) {
  const checksOf = (index: number) => checks.filter((c) => c.frameIndex === index);

  if (size === "sm") {
    return (
      <ol aria-label="Frames" className="m-0 flex list-none items-center gap-[3px] p-0">
        {frames.map((frame) => {
          const verdict = frameVerdict(checksOf(frame.index));
          const label = `Frame ${frame.index}${frame.role ? `, ${frame.role}` : ""}${
            verdict ? `: ${verdictLabel(verdict).toLowerCase()}` : ""
          }`;
          return (
            <li
              key={frame.index}
              title={label}
              aria-label={label}
              className={clsx(
                "grid size-[18px] place-items-center rounded-[3px] text-[11px] leading-none font-bold",
                blockClass(frame.mode, verdict),
              )}
            >
              <span aria-hidden>{verdict ? GLYPH[verdict] : ""}</span>
            </li>
          );
        })}
        {globalFailure && (
          <li
            title={`${ruleInfo(globalFailure.rule).label}: failed`}
            aria-label={`${ruleInfo(globalFailure.rule).label}: failed`}
            className="ml-1 grid size-[18px] place-items-center rounded-[3px] bg-fail text-[11px] leading-none font-bold text-paper"
          >
            <span aria-hidden>!</span>
          </li>
        )}
      </ol>
    );
  }

  return (
    <ol aria-label="Frames" className="m-0 flex list-none flex-wrap items-start gap-3 p-0">
      {frames.map((frame) => {
        const own = checksOf(frame.index);
        const verdict = frameVerdict(own);
        return (
          <li key={frame.index} className="w-40">
            <div className={clsx("rounded-[3px] px-3 py-2 leading-tight", blockClass(frame.mode, verdict))}>
              <p className="tabular font-display text-lg font-semibold">Frame {frame.index}</p>
              {(frame.role ?? (frame.mode !== undefined ? modeName(frame.mode) : undefined)) && (
                <p className="text-[0.8125rem]">{frame.role ?? modeName(frame.mode as number)}</p>
              )}
              {frame.entity && <p className="text-[0.8125rem] opacity-80">{frame.entity}</p>}
              {frame.atomic && <p className="text-[0.8125rem] opacity-80">atomic with the next frame</p>}
            </div>
            {own.length > 0 && (
              <ul aria-label={`Checks for frame ${frame.index}`} className="m-0 mt-2 flex list-none flex-wrap gap-1 p-0">
                {own.map((check, i) => (
                  <li key={`${check.rule}-${i}`}>
                    <VerdictMark
                      verdict={check.verdict}
                      title={`${ruleInfo(check.rule).label}: ${verdictLabel(check.verdict).toLowerCase()}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
      {globalFailure && (
        <li className="w-40">
          <div className="rounded-[3px] border-2 border-fail px-3 py-2 leading-tight text-fail">
            <p className="font-display text-lg font-semibold">Before the frames</p>
            <p className="text-[0.8125rem]">{ruleInfo(globalFailure.rule).label}</p>
          </div>
        </li>
      )}
    </ol>
  );
}
```


- [ ] **Step 4: Run the tests and the type-check**

```bash
cd packages/devnet-ui && bunx vitest run && bunx tsc --noEmit
```

Expected: `Tests  117 passed (117)` (105 before + 12 primitives); `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/devnet-ui/src/index.css packages/devnet-ui/src/ui
git commit -m "$(cat <<'EOF'
feat(devnet-ui): design tokens, verdict marks and the frame strip

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 9: Transaction page parts

**Files:**
- Create: `packages/devnet-ui/src/ui/tx/RuleChecklist.tsx`, `src/ui/tx/FramesTable.tsx`, `src/ui/tx/Timeline.tsx`, `src/ui/tx/AcrossInstances.tsx`
- Test: `packages/devnet-ui/src/ui/tx/RuleChecklist.test.tsx`

**Interfaces:**
- Consumes: `groupChecks`, `failureSummary`, `ruleInfo` (Task 5); `VerdictMark`, `StatusBadge` (Task 8); `useAcrossInstances` (Task 7).
- Produces: `RuleChecklist({ checks })`, `FramesTable({ frames })`, `Timeline({ events })`, `AcrossInstances({ instances, hash, current })`.

The checklist shows transaction-level rules first, then each validation frame's rules, then rules that never ran. A frame whose rules all passed folds away (`<details>`, closed); a frame with a failure stays open, so failure stays the loudest thing on the page. `AcrossInstances` asks every listed instance about the transaction and lines up who saw it and how much later.

- [ ] **Step 1: Write the failing tests**

**`packages/devnet-ui/src/ui/tx/RuleChecklist.test.tsx`**

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RuleChecklist } from "./RuleChecklist";
import type { Check } from "../../protocol/schemas";

const frameChecks = (frameIndex: number, entity: "sender" | "payer", failRule?: string): Check[] =>
  ["trace-alignment", "out-of-gas", "OP-011"].map((rule) => ({
    rule,
    frameIndex,
    entity,
    verdict: rule === failRule ? "fail" : "pass",
    ...(rule === failRule ? { detail: `${entity} broke ${rule}` } : {}),
  }));

describe("RuleChecklist", () => {
  it("folds a frame whose rules all passed and keeps a frame with a failure open", () => {
    const checks: Check[] = [
      { rule: "prefix", verdict: "pass" },
      ...frameChecks(0, "sender"),
      ...frameChecks(1, "payer", "OP-011"),
    ];
    const { container } = render(<RuleChecklist checks={checks} />);
    const groups = container.querySelectorAll("details");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.open).toBe(false);
    expect(groups[1]?.open).toBe(true);
    expect(screen.getByText("3 of 3 passed")).toBeTruthy();
    expect(screen.getByText("1 failed, 2 passed")).toBeTruthy();
    expect(screen.getByText("Turned away: Banned opcodes (payer, frame 1).")).toBeTruthy();
    expect(screen.getByText("payer broke OP-011")).toBeTruthy();
  });

  it("says every rule passed for a clean report", () => {
    render(<RuleChecklist checks={[{ rule: "prefix", verdict: "pass" }]} />);
    expect(screen.getByText("Every rule passed.")).toBeTruthy();
  });

  it("says some rules were not evaluated when nothing failed but something was skipped", () => {
    render(
      <RuleChecklist
        checks={[
          { rule: "prefix", verdict: "pass" },
          { rule: "mempool", verdict: "skipped" },
        ]}
      />,
    );
    expect(screen.getByText("Some rules were not evaluated.")).toBeTruthy();
  });

  it("lists unevaluated frame rules apart, with the reason", () => {
    render(
      <RuleChecklist
        checks={[
          { rule: "prefix", verdict: "fail", detail: "not recognized" },
          { rule: "OP-011", verdict: "skipped" },
          { rule: "storage", verdict: "skipped" },
        ]}
      />,
    );
    const section = screen.getByRole("heading", { name: "Frame rules not evaluated" }).parentElement!;
    expect(within(section).getByText(/an earlier failure stopped them/)).toBeTruthy();
    expect(within(section).getByText("Banned opcodes")).toBeTruthy();
    expect(within(section).getByText("Storage access")).toBeTruthy();
  });

  it("gives each rule a tooltip explaining what it checks", () => {
    render(<RuleChecklist checks={[{ rule: "OP-011", verdict: "pass" }]} />);
    expect(screen.getByTitle(/opcodes validation forbids/)).toBeTruthy();
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run src/ui/tx
```

Expected: FAIL (`Failed to load url ./RuleChecklist`).

- [ ] **Step 3: Write the implementation**

**`packages/devnet-ui/src/ui/tx/RuleChecklist.tsx`**

```tsx
import type { Check } from "../../protocol/schemas";
import { failureSummary, groupChecks, ruleInfo } from "../../logic/rules";
import { VerdictMark, verdictLabel } from "../VerdictMark";

function CheckItem({ check }: { check: Check }) {
  const info = ruleInfo(check.rule);
  return (
    <li className="py-1.5" title={info.explain}>
      <div className="flex items-baseline gap-2.5">
        <span className="translate-y-[3px]">
          <VerdictMark verdict={check.verdict} title={`${info.label}: ${verdictLabel(check.verdict).toLowerCase()}`} />
        </span>
        <span className="font-medium">{info.label}</span>
        <span className="font-mono text-[0.75rem] text-ink-soft">{check.rule}</span>
      </div>
      {check.detail && (
        <p className="max-w-[76ch] pl-[1.625rem] text-[0.875rem] break-words text-ink-soft">{check.detail}</p>
      )}
    </li>
  );
}

/**
 * The node's rule-by-rule verdict on a transaction: transaction-level rules
 * first, then each validation frame's own rules, then any rules that never ran.
 */
export function RuleChecklist({ checks }: { checks: Check[] }) {
  const grouped = groupChecks(checks);
  const summary = failureSummary(checks);

  return (
    <section aria-labelledby="report-title">
      <h2 id="report-title" className="mb-1 text-xl">
        Admission report
      </h2>
      <p className="mb-4 text-ink-soft">
        {grouped.verdict === "fail"
          ? `Turned away: ${summary}.`
          : grouped.verdict === "incomplete"
            ? "Some rules were not evaluated."
            : "Every rule passed."}
      </p>

      <ul aria-label="Transaction-level rules" className="m-0 list-none p-0">
        {grouped.global.map((check, i) => (
          <CheckItem key={`${check.rule}-${i}`} check={check} />
        ))}
      </ul>

      {grouped.entities.map((group) => {
        const failed = group.checks.filter((c) => c.verdict === "fail").length;
        const passed = group.checks.filter((c) => c.verdict === "pass").length;
        // A frame whose rules all passed folds away; one with a failure stays open.
        return (
          <details key={`${group.frameIndex}-${group.entity ?? ""}`} open={failed > 0} className="mt-5">
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-4">
              <h3 className="inline text-lg">
                {group.frameIndex >= 0 ? `Frame ${group.frameIndex}` : "Unplaced frame"}
                {group.entity ? `, ${group.entity}` : ""}
              </h3>
              <span className={failed > 0 ? "text-fail" : "text-ink-soft"}>
                {failed > 0
                  ? `${failed} failed, ${passed} passed`
                  : `${passed} of ${group.checks.length} passed`}
              </span>
            </summary>
            <ul
              aria-label={`Rules for frame ${group.frameIndex}`}
              className="m-0 mt-1 list-none border-l border-line pl-4"
            >
              {group.checks.map((check, i) => (
                <CheckItem key={`${check.rule}-${i}`} check={check} />
              ))}
            </ul>
          </details>
        );
      })}

      {grouped.notEvaluated.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-1 text-lg">Frame rules not evaluated</h3>
          <p className="mb-1 max-w-[62ch] text-[0.875rem] text-ink-soft">
            These run after the transaction-level rules, so an earlier failure stopped them.
          </p>
          <ul aria-label="Rules that were not evaluated" className="m-0 list-none p-0">
            {grouped.notEvaluated.map((check, i) => (
              <CheckItem key={`${check.rule}-${i}`} check={check} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
```

**`packages/devnet-ui/src/ui/tx/FramesTable.tsx`**

```tsx
import type { FrameView } from "../../logic/frames";
import { shortAddress } from "../../logic/format";

/** The frames as sent: what each one is, who it calls, and how much gas and value it carries. */
export function FramesTable({ frames }: { frames: FrameView[] }) {
  return (
    <section aria-labelledby="frames-title">
      <h2 id="frames-title" className="mb-3 text-xl">
        Frame details
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left">
          <thead>
            <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
              <th scope="col" className="py-2 pr-4 font-normal">Frame</th>
              <th scope="col" className="py-2 pr-4 font-normal">Role</th>
              <th scope="col" className="py-2 pr-4 font-normal">Approves</th>
              <th scope="col" className="py-2 pr-4 font-normal">Target</th>
              <th scope="col" className="py-2 pr-4 font-normal">Gas limit</th>
              <th scope="col" className="py-2 pr-4 font-normal">State gas</th>
              <th scope="col" className="py-2 pr-4 font-normal">Value</th>
              <th scope="col" className="py-2 font-normal">Data</th>
            </tr>
          </thead>
          <tbody>
            {frames.map((frame) => (
              <tr key={frame.index} className="border-b border-line align-top">
                <td className="tabular py-2.5 pr-4 font-display font-semibold">{frame.index}</td>
                <td className="py-2.5 pr-4">
                  {frame.role}
                  <span className="block text-[0.8125rem] text-ink-soft">
                    {frame.modeName} mode{frame.atomic ? ", atomic with next" : ""}
                    {frame.entity ? `, ${frame.entity}` : ""}
                  </span>
                </td>
                <td className="py-2.5 pr-4">{frame.scope}</td>
                <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={frame.target ?? undefined}>
                  {frame.target ? shortAddress(frame.target) : "the sender"}
                </td>
                <td className="tabular py-2.5 pr-4">{frame.executionGas.toLocaleString("en-US")}</td>
                <td className="tabular py-2.5 pr-4">{frame.stateGas.toLocaleString("en-US")}</td>
                <td className="tabular py-2.5 pr-4">{frame.value.toLocaleString("en-US")} wei</td>
                <td className="tabular py-2.5">{frame.dataBytes === 0 ? "none" : `${frame.dataBytes} bytes`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

**`packages/devnet-ui/src/ui/tx/Timeline.tsx`**

```tsx
import type { LifecycleEventData } from "../../protocol/schemas";
import { formatClock } from "../../logic/format";
import { StatusBadge } from "../StatusBadge";

const KIND_LABEL: Record<string, string> = {
  admitted: "Admitted",
  rejected: "Rejected",
  replaced: "Replaced",
  statusChanged: "Status changed",
  dropped: "Dropped",
  included: "Included in a block",
};

/** What happened to a transaction on this node, in order. */
export function Timeline({ events }: { events: LifecycleEventData[] }) {
  return (
    <section aria-labelledby="timeline-title">
      <h2 id="timeline-title" className="mb-3 text-xl">
        Timeline
      </h2>
      {events.length === 0 ? (
        <p className="text-ink-soft">No events recorded. This node keeps its history in memory, so a restart clears it.</p>
      ) : (
        <ol className="m-0 list-none border-l border-line p-0 pl-5">
          {events.map((event) => (
            <li key={event.seq} className="relative pb-4 last:pb-0">
              <span aria-hidden className="absolute top-[0.55rem] -left-[1.625rem] size-2 rounded-full bg-ink" />
              <p className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{KIND_LABEL[event.kind] ?? event.kind}</span>
                {event.status && <StatusBadge status={event.status} />}
                <span className="tabular text-[0.8125rem] text-ink-soft">{formatClock(event.at)}</span>
              </p>
              {event.reason && (
                <p className="max-w-[76ch] text-[0.875rem] break-words text-ink-soft">{event.reason}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

**`packages/devnet-ui/src/ui/tx/AcrossInstances.tsx`**

```tsx
import { Link } from "@tanstack/react-router";
import { useAcrossInstances } from "../../data/hooks";
import type { Instance } from "../../instances/store";
import { describeSource, formatClock, formatDelta } from "../../logic/format";
import type { TransactionDetail } from "../../protocol/schemas";
import { describeError } from "../../rpc/errors";
import { StatusBadge } from "../StatusBadge";

interface Sighting {
  instance: Instance;
  state: "asking" | "seen" | "missing" | "failed";
  detail?: TransactionDetail;
  firstSeen?: number;
  problem?: string;
}

/** When a node first saw the transaction: its admission time, else its earliest event. */
function firstSeenOf(detail: TransactionDetail): number | undefined {
  return detail.admission?.at ?? detail.events[0]?.at;
}

/**
 * Asks every listed instance about this transaction and lines up who saw it and
 * when, which is how you see it travel across the network.
 */
export function AcrossInstances({ instances, hash, current }: { instances: Instance[]; hash: string; current: string }) {
  const results = useAcrossInstances(
    instances.map((i) => i.url),
    hash,
  );

  const sightings: Sighting[] = instances.map((instance, i) => {
    const result = results[i];
    if (!result || result.isPending) return { instance, state: "asking" };
    if (result.isError) {
      return { instance, state: "failed", problem: describeError(result.error, instance.url).title };
    }
    if (result.data === null || result.data === undefined) return { instance, state: "missing" };
    return { instance, state: "seen", detail: result.data, firstSeen: firstSeenOf(result.data) };
  });

  const seenTimes = sightings.flatMap((s) => (s.state === "seen" && s.firstSeen !== undefined ? [s.firstSeen] : []));
  const earliest = seenTimes.length > 0 ? Math.min(...seenTimes) : undefined;
  const order = (s: Sighting) => (s.state === "seen" ? (s.firstSeen ?? Infinity) : Infinity);
  sightings.sort((a, b) => order(a) - order(b));

  return (
    <section aria-labelledby="across-title">
      <h2 id="across-title" className="mb-1 text-xl">
        Across instances
      </h2>
      <p className="mb-3 max-w-[64ch] text-ink-soft">
        Every instance in your list, asked about this transaction. Times are when each node first saw it.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left">
          <thead>
            <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
              <th scope="col" className="py-2 pr-4 font-normal">Instance</th>
              <th scope="col" className="py-2 pr-4 font-normal">First seen</th>
              <th scope="col" className="py-2 pr-4 font-normal">Behind the first</th>
              <th scope="col" className="py-2 pr-4 font-normal">How it arrived</th>
              <th scope="col" className="py-2 font-normal">Now</th>
            </tr>
          </thead>
          <tbody>
            {sightings.map((s) => (
              <tr key={s.instance.url} className="border-b border-line align-middle">
                <td className="py-2.5 pr-4">
                  {s.instance.url === current ? (
                    <span className="font-medium">{s.instance.name}</span>
                  ) : (
                    <Link
                      to="/tx/$hash"
                      params={{ hash }}
                      search={{ node: s.instance.url }}
                      className="font-medium underline underline-offset-4"
                    >
                      {s.instance.name}
                    </Link>
                  )}
                </td>
                {s.state === "seen" ? (
                  <>
                    <td className="tabular py-2.5 pr-4">{s.firstSeen !== undefined ? formatClock(s.firstSeen) : "–"}</td>
                    <td className="tabular py-2.5 pr-4">
                      {s.firstSeen !== undefined && earliest !== undefined ? formatDelta(s.firstSeen - earliest) : "–"}
                    </td>
                    <td className="py-2.5 pr-4">
                      {s.detail?.admission ? describeSource(s.detail.admission.source) : "–"}
                    </td>
                    <td className="py-2.5">
                      {s.detail?.entry ? (
                        <StatusBadge status={s.detail.entry.status} />
                      ) : s.detail?.admission ? (
                        <StatusBadge status={s.detail.admission.outcome} />
                      ) : (
                        "–"
                      )}
                    </td>
                  </>
                ) : (
                  <td colSpan={4} className="py-2.5 text-ink-soft">
                    {s.state === "asking" && "Asking…"}
                    {s.state === "missing" && "Has not seen it"}
                    {s.state === "failed" && s.problem}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```


- [ ] **Step 4: Run the tests and the type-check**

```bash
cd packages/devnet-ui && bunx vitest run && bunx tsc --noEmit
```

Expected: `Tests  122 passed (122)` (117 before + 5); `tsc` prints nothing. (`AcrossInstances` uses the router's `Link`; it type-checks now, before the router is registered in Task 10, and again after.)

- [ ] **Step 5: Commit**

```bash
git add packages/devnet-ui/src/ui/tx
git commit -m "$(cat <<'EOF'
feat(devnet-ui): admission report, frame table, timeline and cross-instance view

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 10: Shell, screens and the app

This is the largest task (eleven source files and the 30 app-level tests) because the router's registered types tie the screens and the app together; it cannot be split without leaving a stage that does not compile. Review it file by file.

**Files:**
- Create: `packages/devnet-ui/index.html`, `src/main.tsx`, `src/app.tsx`, `src/testUtils.tsx`
- Create: `packages/devnet-ui/src/ui/shell/InstanceRail.tsx`, `SearchBox.tsx`, `LiveChip.tsx`, `NodeGate.tsx`
- Create: `packages/devnet-ui/src/ui/screens/PoolScreen.tsx`, `ActivityScreen.tsx`, `PeersScreen.tsx`, `TxScreen.tsx`
- Test: `packages/devnet-ui/src/app.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1 to 9, and `mock/fixtures.ts` (test data).
- Produces: `App`, `createAppRouter`; `renderApp`, `installMockFetch`, `idleStream` (test helpers).

The app tests wire the real UI to the mock node through a stubbed `fetch`, so each test exercises a screen down through the protocol and the schemas, with no hand-made responses. Test-writing notes learned while verifying: the router renders asynchronously, so tests must `await screen.findBy...` before the first query; a failure's text legitimately appears twice (in the report and in the timeline), so scope such queries to a section with `within(...)`; the instance's "select" button and its "Rename"/"Remove" buttons all contain the name, so match the select button with `/^Name/`.

- [ ] **Step 1: Write the test helpers and the failing tests**

**`packages/devnet-ui/src/testUtils.tsx`**

```tsx
import { render } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { vi } from "vitest";
import { App, createAppRouter } from "./app";
import type { StreamFactory } from "./data/live";
import type { Instance } from "./instances/store";
import type { MockNode } from "../mock/state";

/** A stream that never connects, so tests stay in control of live events. */
export const idleStream: StreamFactory = () => ({ start() {}, stop() {} });

/**
 * Routes `fetch` to in-memory mock nodes by URL, answering the way the real API
 * does. A URL with no node behaves like an unreachable host.
 */
export function installMockFetch(nodes: Record<string, MockNode>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const node = nodes[url];
      if (!node) throw new TypeError("Failed to fetch");
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const outcome = node.handle(body.method, body.params);
      const payload =
        "error" in outcome
          ? { jsonrpc: "2.0", id: body.id, error: outcome.error }
          : { jsonrpc: "2.0", id: body.id, result: outcome.result };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

export interface RenderAppOptions {
  path?: string;
  instances: Instance[];
  selectedUrl?: string;
  createStream?: StreamFactory;
}

/** Renders the whole app on a memory router with a fixed instance list. */
export function renderApp({ path = "/", instances, selectedUrl, createStream = idleStream }: RenderAppOptions) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  const view = render(
    <App
      router={router}
      queryClient={queryClient}
      initialInstances={{ instances, selectedUrl: selectedUrl ?? instances[0]?.url ?? null }}
      createStream={createStream}
    />,
  );
  return { ...view, router, queryClient };
}
```

**`packages/devnet-ui/src/app.test.tsx`**

```tsx
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TX, disabledNode, primaryNode, secondaryNode } from "../mock/fixtures";
import type { StreamCallbacks } from "./rpc/stream";
import type { StreamFactory } from "./data/live";
import { shortHash } from "./logic/format";
import { installMockFetch, renderApp } from "./testUtils";

const A = { name: "Devnet miner", url: "http://mock-a/rpc" };
const B = { name: "Local peer", url: "http://mock-b/rpc" };
const OFF = { name: "No explorer", url: "http://mock-off/rpc" };
const DOWN = { name: "Unplugged", url: "http://mock-down/rpc" };

beforeEach(() => {
  installMockFetch({
    [A.url]: primaryNode(),
    [B.url]: secondaryNode(),
    [OFF.url]: disabledNode(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pool screen", () => {
  it("shows the selected instance's facts and only what is in its mempool", async () => {
    renderApp({ instances: [A, B] });
    expect(await screen.findByText("Chain 1337, auto bundling, the sidecar 4.1.1 (a1b2c3d), p2p on")).toBeTruthy();
    expect(await screen.findByTitle(TX.onChain.hash)).toBeTruthy();
    expect(screen.getByTitle(TX.sponsored.hash)).toBeTruthy();
    expect(screen.getByTitle(TX.replacedNew.hash)).toBeTruthy();
    expect(screen.queryByTitle(TX.bannedOpcode.hash)).toBeNull(); // rejected: never pooled
    expect(screen.queryByTitle(TX.replacedOld.hash)).toBeNull(); // replaced: left the pool
    const table = within(screen.getByRole("table"));
    expect(table.getByText("On chain")).toBeTruthy();
    expect(table.getByText("Reverted")).toBeTruthy();
  });

  it("filters by status", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await screen.findByTitle(TX.onChain.hash);
    await user.selectOptions(screen.getByLabelText("Status"), "OnChain");
    await waitFor(() => expect(screen.queryByTitle(TX.sponsored.hash)).toBeNull());
    expect(screen.getByTitle(TX.onChain.hash)).toBeTruthy();
  });

  it("explains an empty pool", async () => {
    installMockFetch({ [A.url]: secondaryNode(), [B.url]: secondaryNode() });
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await screen.findByTitle(TX.onlySecondary.hash);
    await user.selectOptions(screen.getByLabelText("Status"), "Cancelled");
    expect(await screen.findByText("No Cancelled transactions.")).toBeTruthy();
  });
});

describe("activity screen", () => {
  it("shows what was turned away and why, on the frame strip and in words", async () => {
    renderApp({ path: "/activity", instances: [A] });
    expect(await screen.findByText("Banned opcodes (payer, frame 0)")).toBeTruthy();
    expect(screen.getByText("Validation prefix")).toBeTruthy();
    expect(screen.getByText("Replaced by a newer transaction")).toBeTruthy();
    expect(screen.getAllByLabelText(/^Frame 0.*: failed$/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Validation prefix: failed")).toBeTruthy();
  });

  it("filters to rejected transactions", async () => {
    const user = userEvent.setup();
    renderApp({ path: "/activity", instances: [A] });
    await screen.findByText("Banned opcodes (payer, frame 0)");
    await user.selectOptions(screen.getByLabelText("Outcome"), "rejected");
    await waitFor(() => expect(screen.queryByTitle(TX.onChain.hash)).toBeNull());
    expect(screen.getByTitle(TX.bannedOpcode.hash)).toBeTruthy();
    expect(screen.getByTitle(TX.noPrefix.hash)).toBeTruthy();
  });
});

describe("transaction screen", () => {
  it("explains a rejection rule by rule, with several violations at once", async () => {
    renderApp({ path: `/tx/${TX.bannedOpcode.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText("Turned away: Banned opcodes (payer, frame 0).")).toBeTruthy();
    const report = screen.getByRole("heading", { name: "Admission report" }).closest("section")!;
    expect(within(report).getByText("payer uses banned opcode: DIFFICULTY")).toBeTruthy();
    expect(within(report).getByText(/unstaked payer accessed/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Frame 0, payer" })).toBeTruthy();
    const timeline = screen.getByRole("heading", { name: "Timeline" }).closest("section")!;
    expect(within(timeline).getByText("Rejected")).toBeTruthy();
  });

  it("shows a failure before any frame was examined, and the rules that never ran", async () => {
    renderApp({ path: `/tx/${TX.noPrefix.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText("Turned away: Validation prefix.")).toBeTruthy();
    expect(screen.getByText("Before the frames")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Frame rules not evaluated" })).toBeTruthy();
    const report = screen.getByRole("heading", { name: "Admission report" }).closest("section")!;
    expect(within(report).getByText("frame transaction validation prefix not recognized")).toBeTruthy();
  });

  it("shows an accepted, included transaction with its frames, report and timeline", async () => {
    renderApp({ path: `/tx/${TX.onChain.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText("Every rule passed.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Frame details" })).toBeTruthy();
    expect(screen.getAllByText("self-verification").length).toBeGreaterThan(0);
    const timeline = screen.getByRole("heading", { name: "Timeline" }).closest("section")!;
    expect(within(timeline).getByText("Included in a block")).toBeTruthy();
  });

  it("shows a whitelist waiver as a pass with its note", async () => {
    renderApp({ path: `/tx/${TX.waived.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText(/waived \(whitelisted entity\)/)).toBeTruthy();
  });

  it("shows a revert reason", async () => {
    renderApp({ path: `/tx/${TX.reverted.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    const facts = (await screen.findByText("Revert reason")).closest("dl")!;
    expect(within(facts).getByText("execution reverted: insufficient allowance")).toBeTruthy();
  });

  it("explains that a replaced transaction's frames are no longer kept", async () => {
    renderApp({ path: `/tx/${TX.replacedOld.hash}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText(/Frame contents are not kept once a transaction leaves the pool/)).toBeTruthy();
    const timeline = screen.getByRole("heading", { name: "Timeline" }).closest("section")!;
    expect(within(timeline).getByText("Replaced")).toBeTruthy();
    expect(within(timeline).getByText(`replaced by ${TX.replacedNew.hash}`)).toBeTruthy();
  });

  it("says so when the node has never seen the transaction", async () => {
    renderApp({ path: `/tx/0x${"1".repeat(64)}?node=${encodeURIComponent(A.url)}`, instances: [A] });
    expect(await screen.findByText("Devnet miner hasn't seen this transaction.")).toBeTruthy();
  });

  it("lines up which instances saw the transaction and how much later", async () => {
    renderApp({ path: `/tx/${TX.onChain.hash}?node=${encodeURIComponent(A.url)}`, instances: [A, B] });
    const across = (await screen.findByRole("heading", { name: "Across instances" })).closest("section")!;
    await waitFor(() => expect(within(across).getByText("+240 ms")).toBeTruthy());
    expect(within(across).getByText("first")).toBeTruthy();
    expect(within(across).getByText("Sent to this node")).toBeTruthy();
    expect(within(across).getByText(/^Gossip from /)).toBeTruthy();
  });

  it("marks an instance that has not seen it, or cannot be reached", async () => {
    renderApp({ path: `/tx/${TX.sponsored.hash}?node=${encodeURIComponent(A.url)}`, instances: [A, B, DOWN, OFF] });
    const across = (await screen.findByRole("heading", { name: "Across instances" })).closest("section")!;
    await waitFor(() => expect(within(across).getByText("Has not seen it")).toBeTruthy());
    expect(within(across).getByText("Couldn't reach mock-down")).toBeTruthy();
    expect(within(across).getByText("The explorer isn't available on this node")).toBeTruthy();
  });

  it("offers to add an instance that a shared link points at", async () => {
    const user = userEvent.setup();
    renderApp({ path: `/tx/${TX.onlySecondary.hash}?node=${encodeURIComponent(B.url)}`, instances: [A] });
    expect(await screen.findByText("mock-b isn't in your list")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    await waitFor(() => expect(screen.queryByText("mock-b isn't in your list")).toBeNull());
  });
});

describe("node gate", () => {
  it("says the explorer is off, with the flag to use", async () => {
    renderApp({ instances: [OFF] });
    expect(await screen.findByText("The explorer isn't available on this node")).toBeTruthy();
    expect(screen.getByText(/--explorer\.enable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says a host cannot be reached, and mentions CORS", async () => {
    renderApp({ instances: [DOWN] });
    expect(await screen.findByText("Couldn't reach mock-down")).toBeTruthy();
    expect(screen.getByText(/--api\.cors/)).toBeTruthy();
  });

  it("warns when the node speaks another protocol version", async () => {
    const node = primaryNode();
    const original = node.handle.bind(node);
    node.handle = (method, params) => {
      const outcome = original(method, params);
      if (method === "skandha_explorer_info" && "result" in outcome) {
        return { result: { ...(outcome.result as object), protocolVersion: 2 } };
      }
      return outcome;
    };
    installMockFetch({ [A.url]: node });
    renderApp({ instances: [A] });
    expect(await screen.findByText("This node speaks explorer protocol v2")).toBeTruthy();
  });
});

describe("instance list", () => {
  it("adds an instance after checking the URL, and selects it", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await screen.findByTitle(TX.onChain.hash);
    await user.click(screen.getByRole("button", { name: "Add instance" }));
    await user.type(screen.getByLabelText("Node URL"), "not a url");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toContain("URL");

    await user.clear(screen.getByLabelText("Node URL"));
    await user.type(screen.getByLabelText("Node URL"), "http://mock-b");
    await user.type(screen.getByLabelText("Name (optional)"), "Peer");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("heading", { name: "Peer" }, { timeout: 3000 })).toBeTruthy();
  });

  it("refuses a duplicate", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await user.click(await screen.findByRole("button", { name: "Add instance" }));
    await user.type(screen.getByLabelText("Node URL"), "http://mock-a/rpc/");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That instance is already in the list.");
  });

  it("renames and removes an instance, and switches the main view to the one you pick", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A, B] });
    await screen.findByTitle(TX.onChain.hash);

    await user.click(screen.getByRole("button", { name: "Rename Local peer" }));
    const box = screen.getByLabelText("Name for http://mock-b/rpc");
    await user.clear(box);
    await user.type(box, "Laptop");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: /^Laptop/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Laptop/ }));
    expect(await screen.findByRole("heading", { name: "Laptop", level: 1 })).toBeTruthy();
    expect(await screen.findByTitle(TX.onlySecondary.hash)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove Laptop" }));
    expect(await screen.findByRole("heading", { name: "Devnet miner", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Laptop/ })).toBeNull();
  });

  it("shows each instance's health", async () => {
    renderApp({ instances: [A, DOWN, OFF] });
    expect(await screen.findByText("Up, chain 1337")).toBeTruthy();
    expect(await screen.findByText("Unreachable")).toBeTruthy();
    expect(await screen.findByText("Explorer off")).toBeTruthy();
  });

  it("invites you to add one when the list is empty", async () => {
    renderApp({ instances: [] });
    expect(await screen.findByText("No instance selected")).toBeTruthy();
    expect(screen.getByText(/No instances yet/)).toBeTruthy();
  });
});

describe("search", () => {
  it("rejects something that is not a transaction hash", async () => {
    const user = userEvent.setup();
    renderApp({ instances: [A] });
    await user.type(await screen.findByLabelText("Find a transaction by hash"), "0x1234{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("64 hex characters");
  });

  it("opens the transaction, on the selected instance", async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ instances: [A] });
    await user.type(await screen.findByLabelText("Find a transaction by hash"), `${TX.onChain.hash.toUpperCase().replace("0X", "0x")}{Enter}`);
    expect(await screen.findByText("Every rule passed.")).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/tx/${TX.onChain.hash}`);
    expect(router.state.location.search).toEqual({ node: A.url });
  });
});

describe("peers screen", () => {
  it("lists peers", async () => {
    renderApp({ path: "/peers", instances: [A] });
    expect(await screen.findByText("skandha/4.1.1")).toBeTruthy();
    expect(screen.getByText("outbound")).toBeTruthy();
    expect(screen.getByText(shortHash("16Uiu2HAmKZdV7rQx1uN3YqYc9bTn6k5Zc1fJb2uWq8PzGdXrEoL4", 8, 6))).toBeTruthy();
  });

  it("explains a node without p2p", async () => {
    renderApp({ path: "/peers", instances: [B] });
    expect(await screen.findByText("This node runs without p2p.")).toBeTruthy();
  });
});

describe("live status and notices", () => {
  function capturingStream() {
    const callbacks: StreamCallbacks[] = [];
    const factory: StreamFactory = (_instance, cb) => {
      callbacks.push(cb);
      return { start() {}, stop() {} };
    };
    return { callbacks, factory };
  }

  it("shows whether updates are live, and explains a restart until dismissed", async () => {
    const user = userEvent.setup();
    const { callbacks, factory } = capturingStream();
    renderApp({ instances: [A], createStream: factory });
    await screen.findByTitle(TX.onChain.hash);
    expect(screen.getByText("Connecting")).toBeTruthy();

    act(() => callbacks[0]?.onStatus("live"));
    expect(await screen.findByText("Live")).toBeTruthy();

    act(() => callbacks[0]?.onReset("restart"));
    expect(await screen.findByText("This node restarted, so its history was reloaded.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("This node restarted, so its history was reloaded.")).toBeNull();
  });

  it("says live updates are unavailable when the stream can never work, and keeps polling", async () => {
    const { callbacks, factory } = capturingStream();
    renderApp({ instances: [A], createStream: factory });
    await screen.findByTitle(TX.onChain.hash);
    act(() => callbacks[0]?.onFatal("Explorer is disabled: start the node with --explorer.enable"));
    expect(await screen.findByText("Live updates are unavailable on this node")).toBeTruthy();
    expect(screen.getByText("Polling, live updates unavailable")).toBeTruthy();
  });

  it("highlights a row that just changed", async () => {
    const { callbacks, factory } = capturingStream();
    const { container } = renderApp({ instances: [A], createStream: factory });
    await screen.findByTitle(TX.onChain.hash);
    act(() =>
      callbacks[0]?.onEvent({ seq: 999, txHash: TX.onChain.hash, at: Date.now(), kind: "statusChanged" }),
    );
    await waitFor(() => expect(container.querySelector(".row-fresh")).not.toBeNull());
  });
});
```


- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/devnet-ui && bunx vitest run src/app.test.tsx
```

Expected: FAIL (`Failed to load url ./app`).

- [ ] **Step 3: Write the implementation**

**`packages/devnet-ui/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>Frame pool explorer</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**`packages/devnet-ui/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App, createAppRouter } from "./app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App router={createAppRouter()} />
  </StrictMode>,
);
```

**`packages/devnet-ui/src/ui/shell/InstanceRail.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import clsx from "clsx";
import { useInfo } from "../../data/hooks";
import { useInstances } from "../../instances/context";
import { validateNewInstance, type Instance } from "../../instances/store";
import { checkProtocol } from "../../protocol/compat";
import { describeError } from "../../rpc/errors";

type Lamp = "up" | "warn" | "down" | "checking";

const LAMP_DOT: Record<Lamp, string> = {
  up: "bg-pass",
  warn: "bg-warn",
  down: "bg-fail",
  checking: "border border-ink-soft",
};

/** Reads one instance's health from its polled `info`. */
function useHealth(url: string): { lamp: Lamp; text: string } {
  const info = useInfo(url);
  if (info.isPending) return { lamp: "checking", text: "Checking" };
  if (info.isError) {
    const notice = describeError(info.error, url);
    if (notice.kind === "unreachable") return { lamp: "down", text: "Unreachable" };
    if (notice.kind === "disabled") return { lamp: "warn", text: "Explorer off" };
    return { lamp: "warn", text: "Unexpected answer" };
  }
  const compat = checkProtocol(info.data);
  if (!compat.ok) return { lamp: "warn", text: `Protocol v${compat.nodeVersion}` };
  return { lamp: "up", text: `Up, chain ${info.data.chainId}` };
}

function InstanceRow({ instance, selected }: { instance: Instance; selected: boolean }) {
  const { dispatch } = useInstances();
  const health = useHealth(instance.url);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(instance.name);

  function saveName(event: FormEvent) {
    event.preventDefault();
    dispatch({ type: "rename", url: instance.url, name: draft });
    setRenaming(false);
  }

  return (
    <li className={clsx("group border-b border-line", selected && "bg-paper shadow-[inset_3px_0_0_var(--accent)]")}>
      {renaming ? (
        <form onSubmit={saveName} className="flex items-center gap-2 px-4 py-3">
          <label className="sr-only" htmlFor={`rename-${instance.url}`}>
            Name for {instance.url}
          </label>
          <input
            id={`rename-${instance.url}`}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-1 border border-line bg-raised px-2 py-1"
          />
          <button type="submit" className="underline underline-offset-4">
            Save
          </button>
          <button type="button" onClick={() => setRenaming(false)} className="text-ink-soft underline underline-offset-4">
            Cancel
          </button>
        </form>
      ) : (
        <div className="px-4 py-3">
          <button
            type="button"
            onClick={() => dispatch({ type: "select", url: instance.url })}
            aria-current={selected ? "true" : undefined}
            className="block w-full text-left"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden className={clsx("size-2.5 shrink-0 rounded-full", LAMP_DOT[health.lamp])} />
              <span className="font-display text-[1.0625rem] font-semibold">{instance.name}</span>
            </span>
            <span className="mt-0.5 block truncate pl-[1.125rem] text-[0.8125rem] text-ink-soft">
              {health.text}
            </span>
            <span className="block truncate pl-[1.125rem] font-mono text-[0.75rem] text-ink-soft" title={instance.url}>
              {new URL(instance.url).host}
            </span>
          </button>
          <div
            className={clsx(
              "mt-1 flex gap-4 pl-[1.125rem] text-[0.8125rem] transition-opacity",
              !selected && "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
            )}
          >
            <button
              type="button"
              onClick={() => {
                setDraft(instance.name);
                setRenaming(true);
              }}
              className="text-ink-soft underline underline-offset-4"
              aria-label={`Rename ${instance.name}`}
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "remove", url: instance.url })}
              className="text-ink-soft underline underline-offset-4"
              aria-label={`Remove ${instance.name}`}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function AddInstance() {
  const { instances, dispatch } = useInstances();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const checked = validateNewInstance({ instances, selectedUrl: null }, name, url);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    dispatch({ type: "add", instance: checked.instance });
    dispatch({ type: "select", url: checked.instance.url });
    setName("");
    setUrl("");
    setError(null);
    setOpen(false);
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full px-4 py-3 text-left underline underline-offset-4">
        Add instance
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-3" aria-label="Add an instance">
      <label className="flex flex-col gap-1 text-[0.8125rem] text-ink-soft">
        Node URL
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://altmempool.forshtat.com"
          className="border border-line bg-raised px-2 py-1.5 font-mono text-[0.8125rem] text-ink"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "add-instance-error" : undefined}
        />
      </label>
      <label className="flex flex-col gap-1 text-[0.8125rem] text-ink-soft">
        Name (optional)
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border border-line bg-raised px-2 py-1.5 text-ink"
        />
      </label>
      {error && (
        <p id="add-instance-error" role="alert" className="text-[0.8125rem] text-fail">
          {error}
        </p>
      )}
      <div className="flex gap-4">
        <button type="submit" className="underline underline-offset-4">
          Add
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="text-ink-soft underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The shared list of instances: pick one to inspect, rename or remove it, or add another. */
export function InstanceRail() {
  const { instances, selected } = useInstances();
  return (
    <nav aria-label="Instances" className="bg-rail">
      <h2 className="px-4 pt-5 pb-3 text-[1.125rem]">Instances</h2>
      {instances.length === 0 ? (
        <p className="px-4 pb-3 text-ink-soft">No instances yet. Add the URL of a sidecar node to start.</p>
      ) : (
        <ul className="m-0 list-none border-t border-line p-0">
          {instances.map((instance) => (
            <InstanceRow key={instance.url} instance={instance} selected={instance.url === selected?.url} />
          ))}
        </ul>
      )}
      <AddInstance />
    </nav>
  );
}
```

**`packages/devnet-ui/src/ui/shell/SearchBox.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useInstances } from "../../instances/context";

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Jump to a transaction by hash, on the selected instance. */
export function SearchBox() {
  const navigate = useNavigate();
  const { selected } = useInstances();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const hash = value.trim();
    if (!HASH.test(hash)) {
      setError("Enter a transaction hash: 0x followed by 64 hex characters.");
      return;
    }
    setError(null);
    setValue("");
    void navigate({
      to: "/tx/$hash",
      params: { hash: hash.toLowerCase() },
      search: { node: selected?.url },
    });
  }

  return (
    <form onSubmit={submit} role="search" className="w-full sm:w-[24rem]">
      <label className="sr-only" htmlFor="tx-search">
        Find a transaction by hash
      </label>
      <input
        id="tx-search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Find a transaction by hash"
        spellCheck={false}
        autoComplete="off"
        className="w-full border border-line bg-raised px-3 py-1.5 font-mono text-[0.8125rem]"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "tx-search-error" : undefined}
      />
      {error && (
        <p id="tx-search-error" role="alert" className="mt-1 text-[0.8125rem] text-fail">
          {error}
        </p>
      )}
    </form>
  );
}
```

**`packages/devnet-ui/src/ui/shell/LiveChip.tsx`**

```tsx
import clsx from "clsx";
import { useLive } from "../../data/live";

/** Whether the selected instance is pushing updates, or the page is polling instead. */
export function LiveChip() {
  const { status, fatal } = useLive();
  let text: string;
  let dot: string;
  if (fatal) {
    text = "Polling, live updates unavailable";
    dot = "bg-warn";
  } else if (status === "live") {
    text = "Live";
    dot = "bg-pass";
  } else if (status === "offline") {
    text = "Offline, retrying";
    dot = "bg-fail";
  } else if (status === "reconnecting") {
    text = "Reconnecting";
    dot = "bg-warn";
  } else {
    text = "Connecting";
    dot = "border border-ink-soft";
  }
  return (
    <p role="status" className="inline-flex items-center gap-2 text-[0.8125rem] text-ink-soft">
      <span aria-hidden className={clsx("size-2 rounded-full", dot)} />
      {text}
    </p>
  );
}
```

**`packages/devnet-ui/src/ui/shell/NodeGate.tsx`**

```tsx
import type { ReactNode } from "react";
import { useInfo } from "../../data/hooks";
import type { Instance } from "../../instances/store";
import { checkProtocol } from "../../protocol/compat";
import type { Info } from "../../protocol/schemas";
import { describeError } from "../../rpc/errors";
import { Banner } from "../Banner";

/**
 * Shows a screen only when the instance answers and speaks this protocol
 * version; otherwise says what is wrong and what to try.
 */
export function NodeGate({
  instance,
  children,
}: {
  instance: Instance;
  children: (info: Info) => ReactNode;
}) {
  const info = useInfo(instance.url);

  if (info.isPending) {
    return (
      <p role="status" className="py-10 text-ink-soft">
        Connecting to {instance.name}…
      </p>
    );
  }
  if (info.isError) {
    const notice = describeError(info.error, instance.url);
    return (
      <Banner
        tone={notice.kind === "disabled" ? "warn" : "error"}
        title={notice.title}
        hint={notice.hint}
        action={
          <button type="button" onClick={() => void info.refetch()} className="underline underline-offset-4">
            Try again
          </button>
        }
      />
    );
  }
  const compat = checkProtocol(info.data);
  if (!compat.ok) {
    return (
      <Banner
        tone="warn"
        title={`This node speaks explorer protocol v${compat.nodeVersion}`}
        hint={`This app understands v${compat.supported}. Update the app or the node so they match.`}
      />
    );
  }
  return <>{children(info.data)}</>;
}
```

**`packages/devnet-ui/src/ui/screens/PoolScreen.tsx`**

```tsx
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { useNow, usePool } from "../../data/hooks";
import { useFresh } from "../../data/live";
import type { Instance } from "../../instances/store";
import { formatAgo, formatClock, formatGwei, formatQuantity, shortAddress, shortHash } from "../../logic/format";
import type { TransactionSummary } from "../../protocol/schemas";
import { describeError } from "../../rpc/errors";
import { Banner } from "../Banner";
import { FrameStrip, framesOfCount } from "../FrameStrip";
import { StatusBadge } from "../StatusBadge";

const STATUS_FILTERS = ["all", "New", "Pending", "Submitted", "OnChain", "Finalized", "Cancelled", "Reverted"] as const;

function PoolRow({ tx, instance, now }: { tx: TransactionSummary; instance: Instance; now: number }) {
  const fresh = useFresh(tx.txHash);
  return (
    <tr className={clsx("border-b border-line align-middle", fresh && "row-fresh")}>
      <td className="py-2.5 pr-4">
        <Link
          to="/tx/$hash"
          params={{ hash: tx.txHash }}
          search={{ node: instance.url }}
          className="font-mono text-[0.8125rem] underline-offset-4 hover:underline"
          title={tx.txHash}
        >
          {shortHash(tx.txHash, 8, 6)}
        </Link>
      </td>
      <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={tx.sender}>
        {shortAddress(tx.sender)}
      </td>
      <td className="tabular py-2.5 pr-4">{formatQuantity(tx.nonce)}</td>
      <td className="py-2.5 pr-4">
        <StatusBadge status={tx.status} />
      </td>
      <td className="py-2.5 pr-4">
        <FrameStrip frames={framesOfCount(tx.frames)} />
      </td>
      <td className="tabular py-2.5 pr-4">{formatGwei(tx.maxFeePerGas)}</td>
      <td
        className="tabular py-2.5 text-ink-soft"
        title={tx.submittedTime ? formatClock(tx.submittedTime) : undefined}
      >
        {tx.submittedTime ? formatAgo(tx.submittedTime, now) : "–"}
      </td>
    </tr>
  );
}

/** What is in this node's mempool right now, newest first, updating as transactions arrive. */
export function PoolScreen({ instance }: { instance: Instance }) {
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const pool = usePool(instance.url, status);
  const now = useNow();
  const items = pool.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="pool-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <h2 id="pool-title" className="text-2xl">
          Pool
        </h2>
        <label className="flex items-center gap-2 text-[0.875rem] text-ink-soft">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as (typeof STATUS_FILTERS)[number])}
            className="border border-line bg-raised px-2 py-1 text-ink"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : s === "OnChain" ? "On chain" : s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {pool.isError ? (
        <Banner
          tone="error"
          title={describeError(pool.error, instance.url).title}
          hint={describeError(pool.error, instance.url).hint}
          action={
            <button type="button" onClick={() => void pool.refetch()} className="underline underline-offset-4">
              Try again
            </button>
          }
        />
      ) : pool.isPending ? (
        <p role="status" className="py-8 text-ink-soft">
          Loading the pool…
        </p>
      ) : items.length === 0 ? (
        <div className="py-8">
          <p className="font-medium">{status === "all" ? "The pool is empty." : `No ${status} transactions.`}</p>
          <p className="max-w-[60ch] text-ink-soft">
            Transactions appear here as this node admits them. Send one with eth_sendFrameTransaction, or open
            Activity to see the ones it turned away.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-left">
            <thead>
              <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-normal">Transaction</th>
                <th scope="col" className="py-2 pr-4 font-normal">Sender</th>
                <th scope="col" className="py-2 pr-4 font-normal">Nonce</th>
                <th scope="col" className="py-2 pr-4 font-normal">Status</th>
                <th scope="col" className="py-2 pr-4 font-normal">Frames</th>
                <th scope="col" className="py-2 pr-4 font-normal">Max fee</th>
                <th scope="col" className="py-2 font-normal">Seen</th>
              </tr>
            </thead>
            <tbody>
              {items.map((tx) => (
                <PoolRow key={tx.txHash} tx={tx} instance={instance} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pool.hasNextPage && (
        <button
          type="button"
          onClick={() => void pool.fetchNextPage()}
          disabled={pool.isFetchingNextPage}
          className="mt-4 underline underline-offset-4"
        >
          {pool.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
```

**`packages/devnet-ui/src/ui/screens/ActivityScreen.tsx`**

```tsx
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { useActivity, useNow } from "../../data/hooks";
import { useFresh } from "../../data/live";
import type { Instance } from "../../instances/store";
import { describeSource, formatAgo, formatClock, shortAddress, shortHash } from "../../logic/format";
import { failureSummary } from "../../logic/rules";
import type { Admission } from "../../protocol/schemas";
import { describeError } from "../../rpc/errors";
import { Banner } from "../Banner";
import { FrameStrip, framesFromChecks } from "../FrameStrip";
import { StatusBadge } from "../StatusBadge";

type Outcome = "all" | "accepted" | "rejected" | "replaced";
const OUTCOMES: Outcome[] = ["all", "rejected", "accepted", "replaced"];

function whatHappened(admission: Admission): string {
  if (admission.outcome === "rejected") return failureSummary(admission.checks) ?? "Rejected";
  if (admission.outcome === "replaced") return "Replaced by a newer transaction";
  return describeSource(admission.source);
}

function ActivityRow({ admission, instance, now }: { admission: Admission; instance: Instance; now: number }) {
  const fresh = useFresh(admission.txHash);
  const globalFailure = admission.checks.find((c) => c.verdict === "fail" && c.frameIndex === undefined);
  return (
    <tr className={clsx("border-b border-line align-middle", fresh && "row-fresh")}>
      <td className="tabular py-2.5 pr-4 whitespace-nowrap text-ink-soft" title={formatAgo(admission.at, now)}>
        {formatClock(admission.at)}
      </td>
      <td className="py-2.5 pr-4">
        <StatusBadge status={admission.outcome} />
      </td>
      <td className="py-2.5 pr-4">
        <Link
          to="/tx/$hash"
          params={{ hash: admission.txHash }}
          search={{ node: instance.url }}
          className="font-mono text-[0.8125rem] underline-offset-4 hover:underline"
          title={admission.txHash}
        >
          {shortHash(admission.txHash, 8, 6)}
        </Link>
      </td>
      <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={admission.sender}>
        {shortAddress(admission.sender)}
      </td>
      <td className="py-2.5 pr-4">
        <FrameStrip frames={framesFromChecks(admission.checks)} checks={admission.checks} globalFailure={globalFailure} />
      </td>
      <td className={clsx("py-2.5", admission.outcome === "rejected" ? "text-fail" : "text-ink-soft")}>
        {whatHappened(admission)}
      </td>
    </tr>
  );
}

/** Everything this node was asked to admit, newest first, including what it turned away and why. */
export function ActivityScreen({ instance }: { instance: Instance }) {
  const [outcome, setOutcome] = useState<Outcome>("all");
  const activity = useActivity(instance.url, outcome);
  const now = useNow();
  const items = activity.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="activity-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <h2 id="activity-title" className="text-2xl">
          Activity
        </h2>
        <label className="flex items-center gap-2 text-[0.875rem] text-ink-soft">
          Outcome
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as Outcome)}
            className="border border-line bg-raised px-2 py-1 text-ink"
          >
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o === "all" ? "All outcomes" : o[0]?.toUpperCase() + o.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {activity.isError ? (
        <Banner
          tone="error"
          title={describeError(activity.error, instance.url).title}
          hint={describeError(activity.error, instance.url).hint}
          action={
            <button type="button" onClick={() => void activity.refetch()} className="underline underline-offset-4">
              Try again
            </button>
          }
        />
      ) : activity.isPending ? (
        <p role="status" className="py-8 text-ink-soft">
          Loading activity…
        </p>
      ) : items.length === 0 ? (
        <div className="py-8">
          <p className="font-medium">Nothing here yet.</p>
          <p className="max-w-[60ch] text-ink-soft">
            This node keeps its history in memory, so a restart clears it. New submissions show up as they arrive.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-left">
            <thead>
              <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-normal">Time</th>
                <th scope="col" className="py-2 pr-4 font-normal">Outcome</th>
                <th scope="col" className="py-2 pr-4 font-normal">Transaction</th>
                <th scope="col" className="py-2 pr-4 font-normal">Sender</th>
                <th scope="col" className="py-2 pr-4 font-normal">Frames</th>
                <th scope="col" className="py-2 font-normal">What happened</th>
              </tr>
            </thead>
            <tbody>
              {items.map((admission) => (
                <ActivityRow key={admission.id} admission={admission} instance={instance} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activity.hasNextPage && (
        <button
          type="button"
          onClick={() => void activity.fetchNextPage()}
          disabled={activity.isFetchingNextPage}
          className="mt-4 underline underline-offset-4"
        >
          {activity.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
```

**`packages/devnet-ui/src/ui/screens/PeersScreen.tsx`**

```tsx
import { useNow, usePeers } from "../../data/hooks";
import type { Instance } from "../../instances/store";
import { formatAgo, shortHash } from "../../logic/format";
import { describeError } from "../../rpc/errors";
import { Banner } from "../Banner";

/** The peers this node is connected to over the p2p network. */
export function PeersScreen({ instance, p2pEnabled }: { instance: Instance; p2pEnabled: boolean }) {
  const peers = usePeers(instance.url);
  const now = useNow();

  return (
    <section aria-labelledby="peers-title">
      <h2 id="peers-title" className="mb-4 text-2xl">
        Peers
      </h2>
      {peers.isError ? (
        <Banner
          tone="error"
          title={describeError(peers.error, instance.url).title}
          hint={describeError(peers.error, instance.url).hint}
        />
      ) : peers.isPending ? (
        <p role="status" className="py-8 text-ink-soft">
          Loading peers…
        </p>
      ) : peers.data.length === 0 ? (
        <div className="py-8">
          <p className="font-medium">{p2pEnabled ? "No peers connected." : "This node runs without p2p."}</p>
          <p className="max-w-[60ch] text-ink-soft">
            {p2pEnabled
              ? "Peers appear once this node discovers or is dialed by other bundlers. Check that it has a boot ENR."
              : "Standalone mode does not gossip transactions, so it has no peers. Start it with the node command to join the network."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left">
            <thead>
              <tr className="border-b border-line text-[0.8125rem] text-ink-soft">
                <th scope="col" className="py-2 pr-4 font-normal">Peer</th>
                <th scope="col" className="py-2 pr-4 font-normal">Direction</th>
                <th scope="col" className="py-2 pr-4 font-normal">Connected</th>
                <th scope="col" className="py-2 pr-4 font-normal">Last message</th>
                <th scope="col" className="py-2 pr-4 font-normal">Client</th>
                <th scope="col" className="py-2 font-normal">Mempools</th>
              </tr>
            </thead>
            <tbody>
              {peers.data.map((peer) => (
                <tr key={peer.peerId} className="border-b border-line align-middle">
                  <td className="py-2.5 pr-4 font-mono text-[0.8125rem]" title={peer.peerId}>
                    {shortHash(peer.peerId, 8, 6)}
                  </td>
                  <td className="py-2.5 pr-4">{peer.direction}</td>
                  <td className="tabular py-2.5 pr-4 text-ink-soft">{formatAgo(peer.connectedAt, now)}</td>
                  <td className="tabular py-2.5 pr-4 text-ink-soft">
                    {peer.lastReceivedAt > 0 ? formatAgo(peer.lastReceivedAt, now) : "–"}
                  </td>
                  <td className="py-2.5 pr-4">{peer.agentVersion ?? "unknown"}</td>
                  <td className="tabular py-2.5">{peer.supportedMempools.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
```

**`packages/devnet-ui/src/ui/screens/TxScreen.tsx`**

```tsx
import type { ReactNode } from "react";
import { useInstances } from "../../instances/context";
import type { Instance } from "../../instances/store";
import { useNow, useTransaction } from "../../data/hooks";
import { describeSource, formatAgo, formatClock, formatGwei, formatQuantity, shortAddress } from "../../logic/format";
import { describeFrames, parseFrameTx } from "../../logic/frames";
import { describeError } from "../../rpc/errors";
import { Banner } from "../Banner";
import { CopyText } from "../CopyText";
import { FrameStrip, framesFromChecks, type StripFrame } from "../FrameStrip";
import { StatusBadge } from "../StatusBadge";
import { AcrossInstances } from "../tx/AcrossInstances";
import { FramesTable } from "../tx/FramesTable";
import { RuleChecklist } from "../tx/RuleChecklist";
import { Timeline } from "../tx/Timeline";

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-soft">{term}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

/**
 * One transaction as one node sees it: its frames, the rule-by-rule admission
 * report, what happened to it, and which other instances have it.
 */
export function TxScreen({ hash, nodeUrl }: { hash: string; nodeUrl: string }) {
  const { instances, dispatch } = useInstances();
  const listed = instances.find((i) => i.url === nodeUrl);
  const instance: Instance = listed ?? { name: new URL(nodeUrl).host, url: nodeUrl };
  const query = useTransaction(nodeUrl, hash);
  const now = useNow();

  return (
    <div className="flex flex-col gap-8">
      {!listed && (
        <Banner
          tone="info"
          title={`${instance.name} isn't in your list`}
          hint="You opened a link to another instance. Add it to keep it in the list and compare across instances."
          action={
            <button
              type="button"
              onClick={() => dispatch({ type: "add", instance })}
              className="underline underline-offset-4"
            >
              Add to list
            </button>
          }
        />
      )}

      <section aria-labelledby="tx-title">
        <h2 id="tx-title" className="text-2xl">
          Transaction
        </h2>
        <p className="mt-1">
          <CopyText value={hash} className="break-all" />
        </p>
        <p className="text-[0.8125rem] text-ink-soft">As seen by {instance.name}</p>
      </section>

      {query.isPending ? (
        <p role="status" className="text-ink-soft">
          Asking {instance.name}…
        </p>
      ) : query.isError ? (
        <Banner
          tone="error"
          title={describeError(query.error, nodeUrl).title}
          hint={describeError(query.error, nodeUrl).hint}
          action={
            <button type="button" onClick={() => void query.refetch()} className="underline underline-offset-4">
              Try again
            </button>
          }
        />
      ) : query.data === null ? (
        <div>
          <p className="font-medium">{instance.name} hasn't seen this transaction.</p>
          <p className="max-w-[64ch] text-ink-soft">
            It may never have been sent here, or the node restarted since (its history is kept in memory). The
            instances below may have it.
          </p>
        </div>
      ) : (
        (() => {
          const { entry, admission, events } = query.data;
          const checks = admission?.checks ?? [];
          const parsed = entry ? parseFrameTx(entry.tx) : null;
          const views = parsed ? describeFrames(parsed, checks) : [];
          const stripFrames: StripFrame[] =
            views.length > 0
              ? views.map((v) => ({ index: v.index, mode: v.mode, role: v.role, entity: v.entity, atomic: v.atomic }))
              : framesFromChecks(checks);
          const globalFailure = checks.find((c) => c.verdict === "fail" && c.frameIndex === undefined);
          const status = entry?.status ?? admission?.outcome;

          return (
            <>
              <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-8 gap-y-1.5">
                {status && (
                  <Fact term="Status">
                    <StatusBadge status={status} />
                  </Fact>
                )}
                {admission && (
                  <>
                    <Fact term="Sender">
                      <CopyText value={admission.sender} display={shortAddress(admission.sender)} />
                    </Fact>
                    <Fact term="Nonce">{formatQuantity(admission.nonce)}</Fact>
                    <Fact term="First seen">
                      {formatClock(admission.at)}, {formatAgo(admission.at, now)}. {describeSource(admission.source)}.
                    </Fact>
                  </>
                )}
                {entry && (
                  <>
                    <Fact term="Payer">
                      <CopyText value={entry.payer} display={shortAddress(entry.payer)} />
                    </Fact>
                    {entry.factory && (
                      <Fact term="Factory">
                        <CopyText value={entry.factory} display={shortAddress(entry.factory)} />
                      </Fact>
                    )}
                    <Fact term="Max fee">{formatGwei(entry.maxFeePerGas)}</Fact>
                    {entry.revertReason && <Fact term="Revert reason">{entry.revertReason}</Fact>}
                  </>
                )}
              </dl>

              <div>
                <FrameStrip frames={stripFrames} checks={checks} size="lg" globalFailure={globalFailure} />
                {!parsed && stripFrames.length > 0 && (
                  <p className="mt-2 max-w-[64ch] text-[0.8125rem] text-ink-soft">
                    Frame contents are not kept once a transaction leaves the pool, so only the frames the report
                    mentions are shown.
                  </p>
                )}
              </div>

              {admission ? (
                <RuleChecklist checks={admission.checks} />
              ) : (
                <p className="text-ink-soft">
                  This node has no admission report for it. Reports are kept in memory and cleared when the node
                  restarts.
                </p>
              )}
              {views.length > 0 && <FramesTable frames={views} />}
              <Timeline events={events} />
            </>
          );
        })()
      )}

      <AcrossInstances instances={instances.length > 0 ? instances : [instance]} hash={hash} current={nodeUrl} />
    </div>
  );
}
```

**`packages/devnet-ui/src/app.tsx`**

```tsx
import { useMemo, type ReactNode } from "react";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useInfo } from "./data/hooks";
import { LiveProvider, StreamFactoryContext, useLive, type StreamFactory } from "./data/live";
import { InstancesProvider, useInstances } from "./instances/context";
import type { Instance, InstancesState } from "./instances/store";
import { Banner } from "./ui/Banner";
import { InstanceRail } from "./ui/shell/InstanceRail";
import { LiveChip } from "./ui/shell/LiveChip";
import { NodeGate } from "./ui/shell/NodeGate";
import { SearchBox } from "./ui/shell/SearchBox";
import { ActivityScreen } from "./ui/screens/ActivityScreen";
import { PeersScreen } from "./ui/screens/PeersScreen";
import { PoolScreen } from "./ui/screens/PoolScreen";
import { TxScreen } from "./ui/screens/TxScreen";

function TabLink({ to, children }: { to: "/" | "/activity" | "/peers"; children: ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="-mb-px border-b-2 border-transparent pb-2 text-ink-soft hover:text-ink"
      activeProps={{ className: "-mb-px border-b-2 border-ink pb-2 font-medium text-ink" }}
    >
      {children}
    </Link>
  );
}

function Header({ instance }: { instance: Instance }) {
  const info = useInfo(instance.url);
  return (
    <header className="mb-8">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-[2rem] font-semibold">{instance.name}</h1>
          <p className="mt-1 text-ink-soft">
            {info.data ? (
              `Chain ${info.data.chainId}, ${info.data.bundlingMode} bundling, the sidecar ${info.data.version} (${info.data.commit}), p2p ${info.data.p2pEnabled ? "on" : "off"}`
            ) : (
              <span className="font-mono text-[0.8125rem]">{instance.url}</span>
            )}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <SearchBox />
          <LiveChip />
        </div>
      </div>
      <nav aria-label="Views" className="mt-6 flex gap-7 border-b border-line">
        <TabLink to="/">Pool</TabLink>
        <TabLink to="/activity">Activity</TabLink>
        <TabLink to="/peers">Peers</TabLink>
      </nav>
    </header>
  );
}

function Notices() {
  const { notice, dismissNotice, fatal } = useLive();
  return (
    <>
      {notice && (
        <div className="mb-4">
          <Banner
            tone="info"
            title={notice}
            action={
              <button type="button" onClick={dismissNotice} className="underline underline-offset-4">
                Dismiss
              </button>
            }
          />
        </div>
      )}
      {fatal && (
        <div className="mb-4">
          <Banner
            tone="warn"
            title="Live updates are unavailable on this node"
            hint={`${fatal} This page refreshes every few seconds instead.`}
          />
        </div>
      )}
    </>
  );
}

function EmptyInstances() {
  return (
    <div className="py-10">
      <h1 className="text-[2rem] font-semibold">No instance selected</h1>
      <p className="mt-2 max-w-[56ch] text-ink-soft">
        Add the URL of a sidecar node in the list on the left. It needs to run with --explorer.enable.
      </p>
    </div>
  );
}

function Shell() {
  const { selected } = useInstances();
  return (
    <LiveProvider instance={selected}>
      <div className="min-h-screen md:grid md:grid-cols-[17rem_1fr]">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:bg-raised focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <aside className="border-b border-line bg-rail md:min-h-screen md:border-r md:border-b-0">
          <InstanceRail />
        </aside>
        <div className="min-w-0 px-5 pt-6 pb-20 md:px-10">
          {selected ? <Header instance={selected} /> : <EmptyInstances />}
          <Notices />
          <main id="main">
            <Outlet />
          </main>
        </div>
      </div>
    </LiveProvider>
  );
}

function PoolPage() {
  const { selected } = useInstances();
  if (!selected) return null;
  return <NodeGate instance={selected}>{() => <PoolScreen instance={selected} />}</NodeGate>;
}

function ActivityPage() {
  const { selected } = useInstances();
  if (!selected) return null;
  return <NodeGate instance={selected}>{() => <ActivityScreen instance={selected} />}</NodeGate>;
}

function PeersPage() {
  const { selected } = useInstances();
  if (!selected) return null;
  return (
    <NodeGate instance={selected}>
      {(info) => <PeersScreen instance={selected} p2pEnabled={info.p2pEnabled} />}
    </NodeGate>
  );
}

function TxPage() {
  const { hash } = txRoute.useParams();
  const { node } = txRoute.useSearch();
  const { selected } = useInstances();
  const url = node ?? selected?.url;
  if (!url) return null;
  return <TxScreen hash={hash} nodeUrl={url} />;
}

const rootRoute = createRootRoute({ component: Shell });
const poolRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: PoolPage });
const activityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/activity", component: ActivityPage });
const peersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/peers", component: PeersPage });
const txRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tx/$hash",
  validateSearch: (search: Record<string, unknown>): { node?: string } => ({
    node: typeof search.node === "string" ? search.node : undefined,
  }),
  component: TxPage,
});

const routeTree = rootRoute.addChildren([poolRoute, activityRoute, peersRoute, txRoute]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter(history ? { routeTree, history } : { routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

export function App({
  router,
  queryClient,
  initialInstances,
  createStream,
}: {
  router: ReturnType<typeof createAppRouter>;
  /** Tests pass their own client so they can tune retries and caching. */
  queryClient?: QueryClient;
  /** Tests pass a fixed starting list; the app loads the saved one. */
  initialInstances?: InstancesState;
  /** Tests pass a fake stream; the app opens a real WebSocket. */
  createStream?: StreamFactory;
}) {
  const client = useMemo(
    () => queryClient ?? new QueryClient({ defaultOptions: { queries: { staleTime: 2000 } } }),
    [queryClient],
  );
  const tree = (
    <QueryClientProvider client={client}>
      <InstancesProvider initial={initialInstances}>
        <RouterProvider router={router} />
      </InstancesProvider>
    </QueryClientProvider>
  );
  return createStream ? <StreamFactoryContext.Provider value={createStream}>{tree}</StreamFactoryContext.Provider> : tree;
}
```


- [ ] **Step 4: Run the tests, the type-check and the build**

```bash
cd packages/devnet-ui && bunx vitest run && bunx tsc --noEmit && bunx vite build
```

Expected: `Test Files  10 passed (10)`, `Tests  152 passed (152)` with no warnings in the output; `tsc` prints nothing; `vite build` ends with `✓ built` and writes `dist/` (about 480 kB of JavaScript, 145 kB gzipped, plus self-hosted font files). `dist/` is git-ignored.

- [ ] **Step 5: Commit**

```bash
git add packages/devnet-ui/index.html packages/devnet-ui/src
git commit -m "$(cat <<'EOF'
feat(devnet-ui): instance list, pool, activity, peers and transaction screens

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 11: Mock server and browser tests

**Files:**
- Create: `packages/devnet-ui/mock/server.ts`, `mock/dev.ts`, `playwright.config.ts`
- Test: `packages/devnet-ui/e2e/explorer.spec.ts`

**Interfaces:**
- Consumes: `MockNode` and fixtures (Task 6), the app (Task 10).
- Produces: `startMockServer(makeNode, port)`; `bun run mock` (three nodes on ports 14401 busy, 14402 peer, 14403 explorer off); test controls `POST /__mock/{admit,status,restart,disconnect,reset}`.

`server.ts` serves a `MockNode` the way a sidecar instance does: JSON-RPC over HTTP at `/rpc` with CORS open and an `RpcError` as HTTP 200 with `error.code`, and the `explorerEvents` stream over WebSocket at the same path, registering and replaying on the next tick after the subscribe response (as the real node does). A WebSocket error carries a `message` and no `code`, matching the real node. `dev.ts` places the fixtures just before "now" so pages read as recent.

- [ ] **Step 1: Write the server, the dev entry and the Playwright config**

**`packages/devnet-ui/mock/server.ts`**

```ts
import type { ServerWebSocket } from "bun";
import { liveTx } from "./fixtures";
import { MockNode, STATUSES, type Status } from "./state";

interface SocketData {
  unsubscribe: (() => void) | null;
}

export interface MockServer {
  port: number;
  node: () => MockNode;
  stop(): void;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function randomId(): string {
  return `0x${Math.floor(Math.random() * 2 ** 48).toString(16).padStart(12, "0")}`;
}

/**
 * Serves a `MockNode` the way a sidecar instance does: JSON-RPC over HTTP at
 * `/rpc` (CORS open, RpcError as HTTP 200 with `error.code`) and the
 * `explorerEvents` stream over WebSocket at the same path. `/__mock/*` are
 * test controls, not part of the real API.
 */
export function startMockServer(makeNode: () => MockNode, port = 0): MockServer {
  let node = makeNode();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  let liveCounter = 0;

  const server = Bun.serve<SocketData, string>({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      if (url.pathname.startsWith("/__mock/")) {
        return control(url.pathname.slice("/__mock/".length), url);
      }

      if (url.pathname === "/rpc" || url.pathname === "/rpc/") {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return srv.upgrade(req, { data: { unsubscribe: null } })
            ? undefined
            : new Response("Upgrade failed", { status: 400 });
        }
        if (req.method !== "POST") return new Response("GET requests are not supported.", { headers: CORS });
        let body: { id?: unknown; method?: unknown; params?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ error: "Cannot parse request" }, 400);
        }
        const outcome = node.handle(String(body.method), Array.isArray(body.params) ? body.params : []);
        return "error" in outcome
          ? json({ jsonrpc: "2.0", id: body.id, error: outcome.error })
          : json({ jsonrpc: "2.0", id: body.id, result: outcome.result });
      }
      return new Response("Not found", { status: 404, headers: CORS });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      message(ws, raw) {
        let request: { id?: unknown; method?: unknown; params?: unknown[] };
        try {
          request = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (request.method === "skandha_subscribe" && request.params?.[0] === "explorerEvents") {
          if (!node.explorerEnabled) {
            // Real WebSocket errors carry a message and no `code`.
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                message: "Explorer is disabled: start the node with --explorer.enable",
              }),
            );
            return;
          }
          const subscription = randomId();
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: subscription }));
          const sinceSeq = request.params[1];
          // Like the real node: register and replay on the next tick, after the response.
          setTimeout(() => {
            ws.data.unsubscribe = node.subscribe(typeof sinceSeq === "number" ? sinceSeq : undefined, (event) =>
              ws.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "skandha_subscription",
                  params: { subscription, result: event },
                }),
              ),
            );
          }, 0);
          return;
        }
        const outcome = node.handle(String(request.method), request.params ?? []);
        ws.send(
          JSON.stringify(
            "error" in outcome
              ? { jsonrpc: "2.0", id: request.id, message: outcome.error.message }
              : { jsonrpc: "2.0", id: request.id, result: outcome.result },
          ),
        );
      },
      close(ws) {
        ws.data.unsubscribe?.();
        sockets.delete(ws);
      },
    },
  });

  function control(action: string, url: URL): Response {
    switch (action) {
      case "admit": {
        const tx = liveTx(++liveCounter, Date.now());
        node.admit(tx, "rpc");
        return json({ hash: tx.hash });
      }
      case "status": {
        const hash = url.searchParams.get("hash") ?? "";
        const status = url.searchParams.get("status") ?? "";
        if (!(STATUSES as readonly string[]).includes(status)) return json({ error: "unknown status" }, 400);
        node.setStatus(hash, status as Status, url.searchParams.get("reason") ?? undefined);
        return json({ ok: true });
      }
      case "restart":
        node.restart();
        return json({ bootId: node.bootId });
      case "disconnect":
        for (const ws of sockets) ws.close(1012, "mock disconnect");
        return json({ closed: sockets.size });
      case "reset":
        node = makeNode();
        for (const ws of sockets) ws.close(1012, "mock reset");
        return json({ bootId: node.bootId });
      default:
        return json({ error: "unknown control" }, 404);
    }
  }

  return {
    port: server.port as number,
    node: () => node,
    stop: () => server.stop(true),
  };
}
```

**`packages/devnet-ui/mock/dev.ts`**

```ts
import { disabledNode, primaryNode, secondaryNode } from "./fixtures";
import { MOCK_PORTS } from "./ports";
import { startMockServer } from "./server";

/**
 * The fixtures span about two minutes; start them just under that before now so
 * every page reads as recent instead of "350 d ago".
 */
const t0 = Date.now() - 130_000;

const servers = [
  { name: "Devnet miner (busy pool, p2p on)", port: MOCK_PORTS.primary, make: () => primaryNode(undefined, t0) },
  { name: "Local peer (saw part of it later, p2p off)", port: MOCK_PORTS.secondary, make: () => secondaryNode(undefined, t0) },
  { name: "No explorer (flag off)", port: MOCK_PORTS.disabled, make: () => disabledNode() },
];

for (const { name, port, make } of servers) {
  startMockServer(make, port);
  console.log(`${name}: http://localhost:${port}/rpc`);
}
console.log("Controls: POST /__mock/admit, /__mock/status?hash=&status=, /__mock/restart, /__mock/disconnect, /__mock/reset");
```

**`packages/devnet-ui/playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

/** The three mock nodes from `mock/dev.ts`, as the app's first-visit instance list. */
const INSTANCES = JSON.stringify([
  { name: "Devnet miner", url: "http://localhost:14401/rpc" },
  { name: "Local peer", url: "http://localhost:14402/rpc" },
  { name: "No explorer", url: "http://localhost:14403/rpc" },
]);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    // Playwright cannot install its own Chromium on some older macOS versions;
    // the installed Chrome works everywhere. Set PW_CHANNEL=chromium in CI to
    // use the bundled build instead.
    channel: process.env.PW_CHANNEL ?? "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: [
    { command: "bun run mock/dev.ts", port: 14401, reuseExistingServer: true },
    {
      command: "bunx vite --port 4173 --strictPort",
      port: 4173,
      reuseExistingServer: true,
      env: { VITE_EXPLORER_INSTANCES: INSTANCES },
    },
  ],
});
```


- [ ] **Step 2: Type-check both projects and smoke-test the mock**

```bash
cd packages/devnet-ui && bun run typecheck
bun run mock &
sleep 2
curl -s localhost:14401/rpc -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"skandha_explorer_info","params":[]}'
curl -s localhost:14403/rpc -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"skandha_explorer_info","params":[]}'
kill %1
```

Expected: `typecheck` prints nothing; the first `curl` returns a `result` with `"protocolVersion":1` and `"bootId":"0a1b2c3d4e5f6071"`; the second returns `"error":{"code":-32601,"message":"Explorer is disabled: start the node with --explorer.enable"}`.

- [ ] **Step 3: Write the browser tests**

**`packages/devnet-ui/e2e/explorer.spec.ts`**

```ts
import { expect, test, type Page } from "@playwright/test";
import { TX } from "../mock/fixtures";
import { MOCK_PORTS } from "../mock/ports";

const control = (port: number, path: string) => fetch(`http://localhost:${port}/__mock/${path}`, { method: "POST" });

test.beforeEach(async () => {
  for (const port of Object.values(MOCK_PORTS)) await control(port, "reset");
});

const rowsIn = (page: Page) => page.locator("main tbody tr");

test("shows the pool of the first instance, live, with a strip of frames per transaction", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Devnet miner" })).toBeVisible();
  await expect(page.getByText("Chain 1337, auto bundling, the sidecar 4.1.1 (a1b2c3d), p2p on")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  await expect(page.getByTitle(TX.onChain.hash)).toBeVisible();
  await expect(page.getByTitle(TX.bannedOpcode.hash)).toHaveCount(0);
  await expect(rowsIn(page).first().getByLabel("Frames")).toBeVisible();
});

test("a transaction that arrives appears without a reload, and is highlighted for a moment", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  const before = await rowsIn(page).count();
  const response = await control(MOCK_PORTS.primary, "admit");
  const { hash } = (await response.json()) as { hash: string };
  await expect(rowsIn(page)).toHaveCount(before + 1);
  await expect(page.getByTitle(hash)).toBeVisible();
  await expect(page.locator("main tbody tr.row-fresh")).toHaveCount(1);
  await expect(page.locator("main tbody tr.row-fresh")).toHaveCount(0, { timeout: 6000 });
});

test("explains a rejection on the activity list and on the transaction page", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByText("Banned opcodes (payer, frame 0)")).toBeVisible();
  await expect(page.getByLabel("Validation prefix: failed")).toBeVisible();

  await page.getByTitle(TX.bannedOpcode.hash).click();
  await expect(page).toHaveURL(new RegExp(`/tx/${TX.bannedOpcode.hash}`));
  await expect(page.getByText("Turned away: Banned opcodes (payer, frame 0).")).toBeVisible();
  const report = page.getByRole("heading", { name: "Admission report" }).locator("xpath=ancestor::section[1]");
  await expect(report.getByText("payer uses banned opcode: DIFFICULTY")).toBeVisible();
  await expect(report.getByRole("heading", { name: "Frame 0, payer" })).toBeVisible();
});

test("lines up when each instance first saw a transaction", async ({ page }) => {
  await page.goto(`/tx/${TX.onChain.hash}?node=${encodeURIComponent("http://localhost:14401/rpc")}`);
  const across = page.getByRole("heading", { name: "Across instances" }).locator("xpath=ancestor::section[1]");
  await expect(across.getByText("+240 ms")).toBeVisible();
  await expect(across.getByRole("cell", { name: "first", exact: true })).toBeVisible();
  await expect(across.getByText("The explorer isn't available on this node")).toBeVisible();
});

test("switches instances, and says when a node has the explorer off", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTitle(TX.onChain.hash)).toBeVisible();
  await page.getByRole("button", { name: /^Local peer/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Local peer" })).toBeVisible();
  await expect(page.getByTitle(TX.onlySecondary.hash)).toBeVisible();
  await expect(page.getByTitle(TX.sponsored.hash)).toHaveCount(0);

  await page.getByRole("button", { name: /^No explorer/ }).click();
  await expect(page.getByText("The explorer isn't available on this node")).toBeVisible();
  await expect(page.getByText(/--explorer\.enable/)).toBeVisible();
});

test("resumes after the connection drops, without missing a transaction", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  const before = await rowsIn(page).count();
  await control(MOCK_PORTS.primary, "disconnect");
  await expect(page.getByRole("status").filter({ hasText: /Reconnecting|Offline/ })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible({ timeout: 8000 });
  await control(MOCK_PORTS.primary, "admit");
  await expect(rowsIn(page)).toHaveCount(before + 1);
});

test("tells you when the node restarted, and reloads what it knows", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  await expect(page.getByText("Banned opcodes (payer, frame 0)")).toBeVisible();
  await control(MOCK_PORTS.primary, "restart");
  await control(MOCK_PORTS.primary, "disconnect");
  await expect(page.getByText("This node restarted, so its history was reloaded.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Nothing here yet.")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("This node restarted, so its history was reloaded.")).toHaveCount(0);
});

test("adds an instance from the list and removes it again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add instance" }).click();
  await page.getByLabel("Node URL").fill("http://localhost:14402");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("That instance is already in the list.");
  await page.getByLabel("Node URL").fill("http://localhost:1");
  await page.getByLabel("Name (optional)").fill("Nothing here");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Nothing here" })).toBeVisible();
  await expect(page.getByText("Couldn't reach localhost:1")).toBeVisible();
  await page.getByRole("button", { name: "Remove Nothing here" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Devnet miner" })).toBeVisible();
});

test("remembers the list across a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Rename Devnet miner" }).click();
  await page.getByLabel("Name for http://localhost:14401/rpc").fill("Kept name");
  await page.getByRole("button", { name: "Save" }).click();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Kept name" })).toBeVisible();
});

test("follows the system color scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByTitle(TX.onChain.hash)).toBeVisible();
  const light = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(light).toBe("rgb(233, 238, 241)");
  expect(dark).toBe("rgb(15, 26, 34)");
});

test("fits a phone-width screen without sideways scrolling of the page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ["/", "/activity", `/tx/${TX.bannedOpcode.hash}?node=${encodeURIComponent("http://localhost:14401/rpc")}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Devnet miner" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `page overflows sideways at ${path}`).toBeLessThanOrEqual(0);
  }
});
```


- [ ] **Step 4: Run them**

```bash
cd packages/devnet-ui && bunx playwright test
```

Expected: `11 passed`. The config starts the mock nodes and a Vite dev server itself. It drives the Chrome installed on the machine (`channel: "chrome"`) because Playwright 1.63 cannot install its own Chromium on macOS 13 (`bunx playwright install chromium` fails there). In CI, run `bunx playwright install chromium` and set `PW_CHANNEL=chromium`. If a test fails, `test-results/` holds a trace (`bunx playwright show-trace <trace.zip>`).

- [ ] **Step 5: Look at it**

Start `bun run mock` and, in another terminal, `VITE_EXPLORER_INSTANCES='[{"name":"Devnet miner","url":"http://localhost:14401/rpc"},{"name":"Local peer","url":"http://localhost:14402/rpc"},{"name":"No explorer","url":"http://localhost:14403/rpc"}]' bun run dev`, open http://localhost:5173 and check by eye, in light and dark and at phone width: the pool, the activity list, a rejected transaction (`/activity`, then click the one with a red frame), and the sponsored 3-frame transaction. Expected: the frame strip reads as designed (solid blocks for verify frames, an outlined block for the user operation, verdict marks beneath), a failed rule is the loudest thing on its page, and nothing scrolls sideways on a phone. Report anything that looks wrong; do not restyle on taste alone.

- [ ] **Step 6: Commit**

```bash
git add packages/devnet-ui/mock/server.ts packages/devnet-ui/mock/dev.ts packages/devnet-ui/playwright.config.ts packages/devnet-ui/e2e
git commit -m "$(cat <<'EOF'
feat(devnet-ui): mock explorer server and Playwright browser tests

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

### Task 12: Package README and repo docs

**Files:**
- Create: `packages/devnet-ui/README.md`
- Modify: `CLAUDE.md` (two small additions)

- [ ] **Step 1: Write the README**

**`packages/devnet-ui/README.md`**

````markdown
# @skandha/devnet-ui

A web explorer for the sidecar EIP-8141 instances. Point it at one or more nodes started with
`--explorer.enable` and it shows, for the selected node:

- **Pool**: what is in the mempool now, updating live.
- **Activity**: every admission, including what the node turned away, with the failing rule.
- **Transaction**: the frames, the rule-by-rule admission report, what happened to the transaction,
  and which of your other instances have it and when they first saw it.
- **Peers**: the node's p2p peers.

It is a static single-page app. It talks to each node directly over JSON-RPC and WebSocket
(`skandha_explorer_*`, see [`docs/sidecar_explorer.md`](../../docs/sidecar_explorer.md)), so a node
must allow this page's origin (`--api.cors`, default `*`).

## Run it

```sh
bun install                      # from the repo root
cd packages/types && bun run build && cd ../devnet-ui   # the app imports the explorer wire types

bun run mock                     # three fake nodes on :14401 (busy), :14402 (peer), :14403 (explorer off)
VITE_EXPLORER_INSTANCES='[{"name":"Devnet miner","url":"http://localhost:14401/rpc"},{"name":"Local peer","url":"http://localhost:14402/rpc"},{"name":"No explorer","url":"http://localhost:14403/rpc"}]' \
  bun run dev                    # http://localhost:5173
```

Against a real node, skip the mock and set `VITE_EXPLORER_INSTANCES` to its URL, or add it from the
**Add instance** form. Without `VITE_EXPLORER_INSTANCES` the first visit lists `http://localhost:14337/rpc`.
The list is remembered in the browser.

## Test it

```sh
bun run typecheck                # app and tooling projects
bun run test                     # Vitest: protocol, RPC, stream, logic, mock node, components, app
bun run test:e2e                 # Playwright against the mock nodes and a Vite dev server
```

`test:e2e` drives the Chrome installed on your machine (`channel: "chrome"`), because Playwright
cannot install its own Chromium on some older macOS versions. In CI, run
`bunx playwright install chromium` and set `PW_CHANNEL=chromium`.

## Build and host it

```sh
bun run build                    # type-checks, then writes dist/
```

`dist/` is plain static files: serve it from any static host. Set `VITE_EXPLORER_INSTANCES` at build
time to preset the instance list. A page served over https can only call https nodes (browsers block
mixed content), so put nodes behind TLS or serve the page over http.

## How it is put together

| Folder | Role |
| --- | --- |
| `src/protocol` | zod schemas for every explorer response, a compile-time guard against the backend's wire types, and the protocol-version check |
| `src/rpc` | the JSON-RPC client and its error kinds, and `ExplorerStream`: the resumable WebSocket follower (`sinceSeq`, `bootId` restart check, history-gap check, backoff) |
| `src/instances` | the instance list: a pure reducer, URL normalization, and tolerant persistence |
| `src/data` | React Query keys and hooks, the live feed for row highlights, and the provider that owns the selected node's stream |
| `src/logic` | pure formatting, frame decoding and rule grouping |
| `src/ui` | the primitives (`FrameStrip`, `VerdictMark`, ...), the shell and the screens |
| `mock/` | a fake explorer node with the real protocol behavior, and a thin Bun server around it (`bun run mock`) |
| `e2e/` | Playwright tests |

Design in one paragraph: a frame transaction is an ordered strip of frames checked by rules, so the
UI draws exactly that. Each frame is a block whose style says what it is (solid: verify, outlined:
sender, dashed: default) and the verdict of each rule that checked it sits beneath. Verdicts differ in
shape as well as color (ringed tick, diamond cross, dashed ring). Failure is the only saturated color.
````


- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, replace

```
This is a Bun/Yarn workspace monorepo managed with Lerna + Nx, containing nine `@skandha/*`
packages under `packages/`.
```

with

```
This is a Bun/Yarn workspace monorepo managed with Lerna + Nx, containing nine `@skandha/*`
bundler packages and the `devnet-ui` web explorer under `packages/`.
```

and, in "Package layout", add this bullet after the `cli` bullet (the one ending `node (\`node\` + P2P) mode.`):

```
- **`devnet-ui`** — a static React app (Vite, Tailwind, TanStack Query/Router) that explores one or
  more sidecar instances through `skandha_explorer_*`: pool, activity, per-rule admission reports,
  peers. Not part of the `build` chain: it has its own `dev`/`test`/`build`/`test:e2e` scripts and its
  own toolchain versions (see its README). `bun run mock` there starts fake nodes for development.
```

- [ ] **Step 3: Full verification**

```bash
cd packages/devnet-ui
bun run typecheck
bun run test
bun run build
bun run test:e2e
cd ../executor && bunx vitest run test/services test/modules test/config.test.ts
```

Expected: `typecheck` silent; `Tests  152 passed (152)`; the build ends `✓ built`; `11 passed` for the browser tests; the executor run `Test Files  22 passed (22)`, `Tests  212 passed (212)` (this branch adds nothing there, and it proves the new package did not disturb it). `git status` shows only the README and `CLAUDE.md` as changes.

- [ ] **Step 4: Commit**

```bash
git add packages/devnet-ui/README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(devnet-ui): package README and CLAUDE.md notes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FATqmamAtQWbUpSPzJg8dJ
EOF
)"
```

---

## Self-Review

**Spec coverage (sub-project 2).** Top bar with instance switcher, health and search: Task 10 (`InstanceRail`, `SearchBox`; health from polled `info`). Overview with a live mempool table and status filter: Task 10 (`PoolScreen`). Transaction detail with frames, rule-by-rule checklist grouped by frame and entity, lifecycle timeline, and the across-instances panel: Tasks 9 and 10. Activity including rejected ones with the failing rule: Task 10. Peers: Task 10. RPC layer with only the selected instance holding a WebSocket: Tasks 2, 3, 7. State (query cache keyed by instance, context persisted to `localStorage`): Tasks 4, 7. Protocol package with runtime validation and version banner: Tasks 1, 10. Routing `/tx/:hash?node=`, unknown node offers to add: Task 10. Error states: Tasks 2, 3, 10. Testing (Vitest for client, cache and rule grouping; Playwright against a fixture mock that is also the dev backend): Tasks 2 to 11. Build to a static bundle: Task 10. Deliberately not covered: serving under `/ui` from the API server, and deployment (see "Not in this plan").

**Deviations from the spec, all recorded.** No shadcn/ui and no viem (Task 1 amends the spec); code-based TanStack routes instead of file-based; query keys are `["x", url, ...]` rather than `[url, method, params]` (same prefix-invalidation property); hex quantities are decoded with `BigInt` instead of viem.

**Placeholder scan.** None: every code block is a verified file, every command has its expected output.

**Type consistency.** The names produced in each task's Interfaces block are the ones later tasks import; the per-task cumulative type-check and test counts were verified independently.
