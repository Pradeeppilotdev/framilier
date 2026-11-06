# Frame Transaction Sidecar (the sidecar Fork) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork `/Users/alexf/skandha` into a sidecar process that participates in the private/alt mempool defined by `2026-09-02-erc7562-native-aa-mempool-spec.md`, gossiping and validating [EIP-8141](../../../../EIPs/EIPS/eip-8141.md) frame transactions instead of ERC-4337 UserOperations, while reusing the sidecar's p2p transport (discv5/gossipsub/reqresp) largely as-is.

**Architecture:** Keep `packages/node` (p2p transport) and `packages/db` close to verbatim, swapping only their payload types and the handful of UserOp-specific files identified below. Delete `packages/types/src/contracts/{EPv6,EPv7,EPv8}` (generated EntryPoint ABI bindings) and `packages/executor/src/services/{EntryPointService,EventsService}` outright — there is no contract to bind to. Rewrite `packages/executor/src/services/UserOpValidation/validators/safe.ts` (the opcode/storage tracer interpreter) and `packages/executor/src/services/MempoolService/reputation.ts` (the reputation state machine) against the frame/mode model, transcribing their existing logic rule-by-rule rather than blind-diffing, using `erc-7562.md`'s finished combined-standard text as the literal source of truth for every rule — resolving ERC-4337 entity names to frame-tx roles via that document's Terminology Mapping section, and treating any rule it marks "ERC-4337 only" as not applicable here. New code is needed for: frame transaction RLP/type definitions, `compute_sig_hash`/signature validation, a simulation service that replaces `EntryPointService` without an ABI to call against, and a `IStakingRegistry` client.

**Tech Stack:** TypeScript (existing the sidecar stack: `viem`, `@chainsafe/ssz`, `@chainsafe/discv5`, `@chainsafe/libp2p-gossipsub`, `libp2p`), against a `geth` execution client reachable via `debug_traceCall`.

**Spec:**
- `/Users/alexf/skandha/docs/plans/2026-09-02-erc7562-native-aa-mempool-spec.md` — edits `/Users/alexf/ERCs/ERCS/erc-7562.md` in place, turning it into a combined ERC-4337 + EIP-8141 standard (a Terminology Mapping section, inline "ERC-4337 only" markers on rules that don't apply to frame transactions, and a new `FRA-*` rule family for frame-tx-specific concepts), rather than producing a separate document. This plan's validation/reputation tasks transcribe from that same file. **Do not start Phase 4/5 tasks below until that plan's self-review task is checked off** — the rule tables those tasks transcribe are not stable until then.
- `/Users/alexf/EIPs/EIPS/eip-8141.md` — the frame transaction protocol itself (RLP structure, `APPROVE` semantics, gas accounting, mempool validation-prefix rules).
- Current repo state as read in this conversation: `/Users/alexf/skandha` (`packages/{api,cli,db,executor,monitoring,node,params,types,utils}`).

## Global Constraints

- Every new/modified package keeps the sidecar's existing monorepo layout (`packages/<name>/src/...`, lerna + nx workspace) — do not restructure the workspace itself.
- No task may reference `packages/types/src/contracts/{EPv6,EPv7,EPv8}` after Task 2 deletes them; any later task whose original sidecar file imports from there must have that import removed as part of adapting the file, not left dangling.
- No task may add a new dependency to `packages/node` beyond upgrading existing libp2p-family packages (Task 11) — the p2p transport's minimal UserOp-coupling is the reason it's reusable; don't reintroduce coupling by importing executor-package types into it. `packages/node` may depend only on new types added to `packages/types/src/node` (frame-tx SSZ schemas), never directly on `packages/executor`.
- Every pure function introduced (RLP/SSZ codecs, `compute_sig_hash`, signature validators, associated-storage slot matching, validation-prefix classification) MUST have a unit test with concrete input/output vectors — no task that introduces such a function may skip its test step.
- Every deletion task (Tasks 2, 3, 25) MUST end with a full workspace build (`bun run build` or the repo's existing build script) passing with zero references to the deleted code, not just "the file compiles in isolation."
- Follow the existing repo's lint/format config (`.eslintrc.js`) for all new/modified TypeScript.

---

## File Structure

| Path | Responsibility | Disposition |
|---|---|---|
| `packages/types/src/contracts/{EPv6,EPv7,EPv8}` | Generated EntryPoint ABI bindings (~70k LOC) | **Delete** (Task 2) |
| `packages/executor/src/services/EntryPointService/*` | EntryPoint contract call encoding/decoding | **Delete**, replaced by `packages/executor/src/services/FrameTxSimulationService/*` (Task 20) |
| `packages/executor/src/services/EventsService/*` | `UserOperationEvent` log parsing | **Delete**, replaced by `packages/executor/src/services/ReceiptService/*` (Task 21) |
| `packages/types/src/contracts/FrameTx.ts` | Frame transaction TS types (RLP field structure) | **New** (Task 4) |
| `packages/types/src/contracts/frame.ts` | Frame object type, `mode`/`flags` constants | **New** (Task 5) |
| `packages/executor/src/services/FrameTxService/codec.ts` | RLP encode/decode, `compute_sig_hash` | **New** (Task 6) |
| `packages/executor/src/services/FrameTxService/signature.ts` | SECP256K1/P256/ARBITRARY signature validation | **New** (Task 7) |
| `packages/types/src/node/frameTx.ts` | SSZ gossip/reqresp schemas for frame transactions | **New** (Task 8) |
| `packages/node/src/network/validation/verifiedFrameTx.ts` | Gossip validation (replaces `verifiedUserOperation.ts`) | **Adapt** (Task 9) |
| `packages/node/src/reqresp/protocols/{PooledFrameTxHashes,PooledFrameTxsByHash}.ts` | ReqResp protocol defs (replace `PooledUserOp*`) | **Adapt** (Task 10) |
| `packages/node/package.json` | libp2p-family dependency versions | **Modify** (Task 11) |
| `packages/executor/tracer.js` | Bundler-collector JS tracer rule table | **Modify** (Task 12) |
| `packages/executor/src/services/UserOpValidation/validators/frameTx.ts` | Validation-prefix opcode/storage interpreter (replaces `safe.ts`) | **New**, ports logic from `safe.ts` (Task 13) |
| `packages/executor/src/services/UserOpValidation/utils/associatedStorage.ts` | `isSlotAssociatedWith`/`parseEntitySlots`, re-keyed | **Adapt** (Task 14) |
| `packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts` | Recognizes the four EIP-8141 validation-prefix shapes | **New** (Task 15) |
| `packages/executor/src/entities/FrameTxMempoolEntry.ts` | Mempool entry shape (replaces `MempoolEntry.ts`) | **New** (Task 16) |
| `packages/executor/src/services/MempoolService/reputation.ts` | Reputation state machine | **Adapt in place** (Task 17) |
| `packages/executor/src/services/MempoolService/canonicalPaymaster.ts` | Canonical-payer code-match + balance reservation | **New** (Task 18) |
| `packages/executor/src/services/StakingRegistryService/index.ts` | `IStakingRegistry` client | **New** (Task 19) |
| `packages/executor/src/services/FrameTxSimulationService/*` | Replaces `EntryPointService` — builds/interprets `debug_traceCall` against a frame tx directly | **New** (Task 20) |
| `packages/executor/src/services/ReceiptService/*` | Replaces `EventsService` — parses `ReceiptPayload` | **New** (Task 21) |
| `packages/executor/src/modules/eth.ts` | RPC method surface | **Adapt** (Task 22, 23) |
| `packages/executor/src/services/BundlingService/service.ts` | Strip `handleOps` batching; per-tx relay submission | **Adapt** (Task 24) |
| `packages/executor/src/services/UserOpValidation/service.ts`, `utils/eip7702.ts` | EIP-7702 authorization handling | **Delete** (Task 25) |

---

### Task 1: Fork setup and workspace sanity check

**Files:**
- Read: `/Users/alexf/skandha/package.json`, `/Users/alexf/skandha/nx.json`, `/Users/alexf/skandha/lerna.json`
- Modify: `/Users/alexf/skandha/package.json` (name/description fields only)

**Interfaces:**
- Produces: a confirmed-buildable baseline commit to branch from, so every later task's "run the build" step has a known-good starting point.

- [ ] **Step 1: Create the fork branch**

```bash
cd /Users/alexf/skandha
git checkout -b frame-tx-sidecar
```

- [ ] **Step 2: Confirm the baseline builds and existing tests pass**

```bash
bun install
bun run build
bun run test
```

Expected: build succeeds; note the existing test pass/fail count as the baseline (some existing UserOp-specific tests are expected to be deleted in later tasks — this baseline is only to confirm the starting point is not already broken).

- [ ] **Step 3: Rename package identity fields**

Edit `package.json`'s `name` and `description` fields to reflect the fork (e.g. `name: "frame-tx-sidecar"`, `description: "P2P sidecar for EIP-8141 frame transaction alt-mempool"`). Do not touch dependency versions in this step.

- [ ] **Step 4: Commit**

```bash
git add package.json && git commit -m "chore: fork skandha into frame-tx-sidecar"
```

---

### Task 2: Delete generated EntryPoint ABI bindings

**Files:**
- Delete: `packages/types/src/contracts/EPv6/`, `packages/types/src/contracts/EPv7/`, `packages/types/src/contracts/EPv8/`
- Modify: any file importing from those paths (discovered via Step 1 below)

**Interfaces:**
- Consumes: nothing.
- Produces: a `packages/types` package with zero EntryPoint-ABI content, and a recorded list of every file that imported from it (input to Tasks 3, 20, 22).

- [ ] **Step 1: Enumerate every importer before deleting anything**

```bash
cd /Users/alexf/skandha
grep -rln "contracts/EPv[678]" packages --include="*.ts" | grep -v node_modules | tee /tmp/ep-abi-importers.txt
```

Expected: this list includes at minimum `packages/executor/src/services/EntryPointService/versions/{0.0.7,0.0.8}.ts`, `packages/executor/src/services/EventsService/versions/{0.0.7,0.0.8}.ts`, and likely files under `packages/executor/src/modules/`. Save this list — Tasks 3, 20, and 22 each need to confirm their target files appear here.

- [ ] **Step 2: Delete the generated bindings**

```bash
rm -rf packages/types/src/contracts/EPv6 packages/types/src/contracts/EPv7 packages/types/src/contracts/EPv8
```

- [ ] **Step 3: Attempt a build and capture the break list**

```bash
bun run build 2>&1 | tee /tmp/build-break-after-ep-delete.log
```

Expected: build fails with import errors for every file in `/tmp/ep-abi-importers.txt`. This is expected and correct at this point in the plan — do **not** try to fix these imports here. Confirm the failing file list is a subset of `/tmp/ep-abi-importers.txt` (if a file fails that wasn't in the grep output, the grep pattern in Step 1 was incomplete — fix the pattern and re-run before proceeding).

- [ ] **Step 4: Commit the deletion with the build left intentionally broken**

```bash
git add -A && git commit -m "wip: delete generated EntryPoint ABI bindings (build broken until EntryPointService/EventsService replaced)"
```

This is a deliberate exception to "always commit working code" — the deletion and its downstream repair (Tasks 3, 20, 21, 22) are one logical unit spread across several tasks for reviewability; the branch as a whole is not expected to build again until Task 22 completes. Note this explicitly in the commit message so later reviewers aren't confused by a red build.

---

### Task 3: Delete EntryPointService and EventsService

**Files:**
- Delete: `packages/executor/src/services/EntryPointService/` (entire directory: `constants.ts`, `index.ts`, `interfaces.ts`, `service.ts`, `utils/`, `versions/`)
- Delete: `packages/executor/src/services/EventsService/` (entire directory)
- Modify: `packages/executor/src/services/index.ts` (remove the now-dead exports)

**Interfaces:**
- Consumes: the importer list from Task 2, Step 1.
- Produces: confirmation that the only remaining build breakage after this deletion is in the files that will be actively rewritten in Tasks 13, 20, 21, 22 (i.e., no *other* unexpected breakage was hiding behind these two services).

- [ ] **Step 1: Delete both service directories**

```bash
cd /Users/alexf/skandha
rm -rf packages/executor/src/services/EntryPointService
rm -rf packages/executor/src/services/EventsService
```

- [ ] **Step 2: Remove their exports from the services barrel file**

Read `packages/executor/src/services/index.ts`, remove the `export * from "./EntryPointService/index.js"` and `export * from "./EventsService/index.js"` lines (exact line content to be confirmed by reading the file at execution time — do not guess the export syntax without reading it first).

- [ ] **Step 3: Re-run the build and diff the break list against Task 2's**

```bash
bun run build 2>&1 | tee /tmp/build-break-after-service-delete.log
diff <(grep -oE '^[^:]+\.ts' /tmp/build-break-after-ep-delete.log | sort -u) \
     <(grep -oE '^[^:]+\.ts' /tmp/build-break-after-service-delete.log | sort -u)
```

Expected: the new break list is a **subset** of the old one (files that only imported `EntryPointService`/`EventsService` types, now resolved by those services no longer existing to import from, should have fewer errors — though most files will still fail because they also reference `EPv6/7/8` types transitively). Any file that appears in the *new* list but not the old one indicates this deletion broke something Task 2 hadn't already broken — investigate and resolve before proceeding; do not carry unexplained new breakage forward.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "wip: delete EntryPointService and EventsService (build still broken, expected — see Task 2 commit note)"
```

---

### Task 4: Frame transaction TS types

**Files:**
- Create: `packages/types/src/contracts/FrameTx.ts`
- Test: `packages/types/test/contracts/FrameTx.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FrameTransaction`, `Frame`, `SignatureEntry`, `FeeParams` TS interfaces, consumed by every later task that touches a frame transaction's fields (Tasks 5, 6, 7, 13, 16, 20, 22).

- [ ] **Step 1: Write the failing test for the type shape (a construction/serialization round-trip smoke test)**

```typescript
// packages/types/test/contracts/FrameTx.test.ts
import { describe, it, expect } from "vitest";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "../../src/contracts/FrameTx.js";

describe("FrameTransaction type", () => {
  it("constructs a minimal well-formed transaction object", () => {
    const tx: FrameTransaction = {
      chainId: 1n,
      nonce: 0n,
      sender: "0x0000000000000000000000000000000000000001",
      frames: [
        {
          mode: FRAME_MODE.VERIFY,
          flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
          target: null,
          limits: { execution: 65536n, state: 0n },
          value: 0n,
          data: "0x",
        },
      ],
      signatures: [],
      fees: {
        maxPriorityFeePerGas: 1_000_000_000n,
        maxFeePerGas: 2_000_000_000n,
        maxFeePerBlobGas: 0n,
      },
      blobVersionedHashes: [],
    };
    expect(tx.frames.length).toBe(1);
    expect(tx.frames[0].mode).toBe(FRAME_MODE.VERIFY);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails (module doesn't exist yet)**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/types/test/contracts/FrameTx.test.ts
```

Expected: FAIL with a module-not-found error for `../../src/contracts/FrameTx.js`.

- [ ] **Step 3: Write the type definitions, matching EIP-8141 §Payload Encoding and §Frame object field-for-field**

```typescript
// packages/types/src/contracts/FrameTx.ts
export const FRAME_MODE = {
  DEFAULT: 0,
  VERIFY: 1,
  SENDER: 2,
} as const;
export type FrameMode = (typeof FRAME_MODE)[keyof typeof FRAME_MODE];

export const APPROVE_SCOPE = {
  NONE: 0x0,
  PAYMENT: 0x1,
  EXECUTION: 0x2,
  EXECUTION_AND_PAYMENT: 0x3,
} as const;
export type ApproveScope = (typeof APPROVE_SCOPE)[keyof typeof APPROVE_SCOPE];

export const ATOMIC_BATCH_FLAG = 0x4;

export interface FrameLimits {
  execution: bigint;
  state: bigint;
}

export interface Frame {
  mode: FrameMode;
  /** bits 0-1: approval scope (see APPROVE_SCOPE); bit 2: ATOMIC_BATCH_FLAG */
  flags: number;
  target: `0x${string}` | null;
  limits: FrameLimits;
  value: bigint;
  data: `0x${string}`;
}

export const SIG_SCHEME = {
  ARBITRARY: 0x0,
  SECP256K1: 0x1,
  P256: 0x2,
} as const;
export type SigScheme = (typeof SIG_SCHEME)[keyof typeof SIG_SCHEME];

export interface SignatureEntry {
  scheme: SigScheme;
  /** empty for ARBITRARY; 20-byte address for SECP256K1/P256 */
  signer: `0x${string}` | "0x";
  /** empty (canonical sig hash) or an explicit 32-byte digest */
  msg: `0x${string}` | "0x";
  signature: `0x${string}`;
}

export interface FeeParams {
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  maxFeePerBlobGas: bigint;
}

export interface FrameTransaction {
  chainId: bigint;
  nonce: bigint;
  sender: `0x${string}`;
  frames: Frame[];
  signatures: SignatureEntry[];
  fees: FeeParams;
  blobVersionedHashes: `0x${string}`[];
}

export const MAX_FRAMES = 64;
export const FRAME_TX_TYPE = 0x06;
export const ENTRY_POINT = "0x00000000000000000000000000000000000000aa" as const; // placeholder — verify exact EIP-8141 §Constants value at implementation time
export const EXPIRY_VERIFIER = "0x0000000000000000000000000000000000008141" as const; // placeholder — verify exact EIP-8141 §Constants value at implementation time
```

> **Implementer note:** the `ENTRY_POINT`/`EXPIRY_VERIFIER` address literals above are placeholders sized to match `address(0xaa)`/`address(0x8141)` conceptually — re-derive the exact 20-byte hex padding from EIP-8141 §Constants (lines 39–40) before this file is used by any downstream task; do not trust the literal bytes shown here without checking.

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/types/test/contracts/FrameTx.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/contracts/FrameTx.ts packages/types/test/contracts/FrameTx.test.ts
git commit -m "feat(types): add FrameTransaction type definitions"
```

---

### Task 5: Frame object mode/flags constants and validation-prefix subclassification types

**Files:**
- Create: `packages/types/src/contracts/frameModes.ts`
- Test: `packages/types/test/contracts/frameModes.test.ts`

**Interfaces:**
- Consumes: `FRAME_MODE`, `APPROVE_SCOPE`, `Frame` from `packages/types/src/contracts/FrameTx.ts` (Task 4).
- Produces: `FRAME_SUBCLASS` enum (`self_verify`, `deploy`, `only_verify`, `pay`, `expiry_verify`, `user_op`, `post_op`) and a `classifyFrame(frame: Frame): FrameSubclass | null` pure function, consumed by Task 15 (validation-prefix recognition).

- [ ] **Step 1: Write the failing tests, one per EIP-8141 §Mode Subclassifications row**

```typescript
// packages/types/test/contracts/frameModes.test.ts
import { describe, it, expect } from "vitest";
import { classifyFrame, FRAME_SUBCLASS } from "../../src/contracts/frameModes.js";
import { FRAME_MODE, APPROVE_SCOPE } from "../../src/contracts/FrameTx.js";

const baseFrame = (overrides: Partial<Parameters<typeof classifyFrame>[0]>) => ({
  mode: FRAME_MODE.VERIFY,
  flags: 0,
  target: null,
  limits: { execution: 0n, state: 0n },
  value: 0n,
  data: "0x" as const,
  ...overrides,
});

describe("classifyFrame", () => {
  it("classifies self_verify: VERIFY mode, flags 0x3", () => {
    expect(classifyFrame(baseFrame({ mode: FRAME_MODE.VERIFY, flags: 0x3 }))).toBe(FRAME_SUBCLASS.SELF_VERIFY);
  });
  it("classifies only_verify: VERIFY mode, flags 0x2", () => {
    expect(classifyFrame(baseFrame({ mode: FRAME_MODE.VERIFY, flags: 0x2 }))).toBe(FRAME_SUBCLASS.ONLY_VERIFY);
  });
  it("classifies pay: VERIFY mode, flags 0x1", () => {
    expect(classifyFrame(baseFrame({ mode: FRAME_MODE.VERIFY, flags: 0x1 }))).toBe(FRAME_SUBCLASS.PAY);
  });
  it("classifies expiry_verify: VERIFY mode, flags 0x0", () => {
    expect(classifyFrame(baseFrame({ mode: FRAME_MODE.VERIFY, flags: 0x0 }))).toBe(FRAME_SUBCLASS.EXPIRY_VERIFY);
  });
  it("classifies deploy: DEFAULT mode, flags 0x0", () => {
    expect(classifyFrame(baseFrame({ mode: FRAME_MODE.DEFAULT, flags: 0x0 }))).toBe(FRAME_SUBCLASS.DEPLOY_OR_POST_OP);
  });
  it("classifies user_op: SENDER mode, any flags", () => {
    expect(classifyFrame(baseFrame({ mode: FRAME_MODE.SENDER, flags: 0x0 }))).toBe(FRAME_SUBCLASS.USER_OP);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/types/test/contracts/frameModes.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/types/src/contracts/frameModes.ts
import { Frame, FRAME_MODE, APPROVE_SCOPE } from "./FrameTx.js";

export const FRAME_SUBCLASS = {
  SELF_VERIFY: "self_verify",
  ONLY_VERIFY: "only_verify",
  PAY: "pay",
  EXPIRY_VERIFY: "expiry_verify",
  /** DEFAULT-mode frames are ambiguous between `deploy` and `post_op` by
   * mode/flags alone — EIP-8141 §Mode Subclassifications distinguishes
   * them by structural position (deploy must be first frame in the
   * validation prefix), not by any field on the frame itself. Task 15's
   * validation-prefix matcher resolves this ambiguity positionally. */
  DEPLOY_OR_POST_OP: "deploy_or_post_op",
  USER_OP: "user_op",
} as const;
export type FrameSubclass = (typeof FRAME_SUBCLASS)[keyof typeof FRAME_SUBCLASS];

export function classifyFrame(frame: Frame): FrameSubclass | null {
  const scope = frame.flags & APPROVE_SCOPE.EXECUTION_AND_PAYMENT;
  switch (frame.mode) {
    case FRAME_MODE.VERIFY:
      if (scope === APPROVE_SCOPE.EXECUTION_AND_PAYMENT) return FRAME_SUBCLASS.SELF_VERIFY;
      if (scope === APPROVE_SCOPE.EXECUTION) return FRAME_SUBCLASS.ONLY_VERIFY;
      if (scope === APPROVE_SCOPE.PAYMENT) return FRAME_SUBCLASS.PAY;
      return FRAME_SUBCLASS.EXPIRY_VERIFY;
    case FRAME_MODE.DEFAULT:
      return FRAME_SUBCLASS.DEPLOY_OR_POST_OP;
    case FRAME_MODE.SENDER:
      return FRAME_SUBCLASS.USER_OP;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/types/test/contracts/frameModes.test.ts
```

Expected: PASS, all six cases green.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/contracts/frameModes.ts packages/types/test/contracts/frameModes.test.ts
git commit -m "feat(types): add frame mode/flags subclassification"
```

---

### Task 6: RLP codec and `compute_sig_hash`

**Files:**
- Create: `packages/executor/src/services/FrameTxService/codec.ts`
- Test: `packages/executor/test/services/FrameTxService/codec.test.ts`

**Interfaces:**
- Consumes: `FrameTransaction`, `Frame`, `SignatureEntry`, `FeeParams` from Task 4.
- Produces: `encodeFrameTx(tx: FrameTransaction): Uint8Array`, `decodeFrameTx(bytes: Uint8Array): FrameTransaction`, `computeSigHash(tx: FrameTransaction): \`0x${string}\``, consumed by Task 7 (signature validation), Task 13 (validation), Task 20 (simulation).

- [ ] **Step 1: Write the failing round-trip test**

```typescript
// packages/executor/test/services/FrameTxService/codec.test.ts
import { describe, it, expect } from "vitest";
import { encodeFrameTx, decodeFrameTx, computeSigHash } from "../../../src/services/FrameTxService/codec.js";
import { FRAME_MODE, APPROVE_SCOPE, FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";

const sampleTx: FrameTransaction = {
  chainId: 1n,
  nonce: 0n,
  sender: "0x1111111111111111111111111111111111111111",
  frames: [
    {
      mode: FRAME_MODE.VERIFY,
      flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
      target: null,
      limits: { execution: 65536n, state: 0n },
      value: 0n,
      data: "0x",
    },
  ],
  signatures: [],
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
};

describe("FrameTx codec", () => {
  it("round-trips encode -> decode to an identical object", () => {
    const encoded = encodeFrameTx(sampleTx);
    const decoded = decodeFrameTx(encoded);
    expect(decoded).toEqual(sampleTx);
  });

  it("computeSigHash is deterministic for the same transaction", () => {
    const h1 = computeSigHash(sampleTx);
    const h2 = computeSigHash(sampleTx);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("computeSigHash elides raw signature bytes for empty-msg signatures", () => {
    const txWithSig: FrameTransaction = {
      ...sampleTx,
      signatures: [{ scheme: 1, signer: "0x", msg: "0x", signature: "0xaa" }],
    };
    const txWithDifferentSigBytes: FrameTransaction = {
      ...sampleTx,
      signatures: [{ scheme: 1, signer: "0x", msg: "0x", signature: "0xbb" }],
    };
    // Per EIP-8141 §Signature Hash: raw signature bytes of empty-msg
    // entries are elided before hashing, so these must match.
    expect(computeSigHash(txWithSig)).toBe(computeSigHash(txWithDifferentSigBytes));
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/FrameTxService/codec.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement, following EIP-8141 §Payload Encoding and §Signature Hash exactly**

```typescript
// packages/executor/src/services/FrameTxService/codec.ts
import { RLP } from "@ethereumjs/rlp"; // add to packages/executor/package.json dependencies
import { keccak256, toHex, toBytes, Hex } from "viem";
import {
  FrameTransaction,
  Frame,
  SignatureEntry,
  FeeParams,
  FRAME_TX_TYPE,
} from "@skandha/types/lib/contracts/FrameTx.js";

function encodeBigint(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array();
  return toBytes(toHex(n));
}

function encodeFrame(f: Frame): unknown[] {
  return [
    encodeBigint(BigInt(f.mode)),
    encodeBigint(BigInt(f.flags)),
    f.target ? toBytes(f.target) : new Uint8Array(),
    [encodeBigint(f.limits.execution), encodeBigint(f.limits.state)],
    encodeBigint(f.value),
    toBytes(f.data),
  ];
}

function encodeSignature(s: SignatureEntry): unknown[] {
  return [
    encodeBigint(BigInt(s.scheme)),
    toBytes(s.signer),
    toBytes(s.msg),
    toBytes(s.signature),
  ];
}

function encodeFees(fees: FeeParams): unknown[] {
  return [
    encodeBigint(fees.maxPriorityFeePerGas),
    encodeBigint(fees.maxFeePerGas),
    encodeBigint(fees.maxFeePerBlobGas),
  ];
}

/** Per EIP-8141 §Payload Encoding: [chain_id, nonce, sender, frames, signatures, fees, blob_versioned_hashes] */
export function encodeFrameTx(tx: FrameTransaction): Uint8Array {
  const structure = [
    encodeBigint(tx.chainId),
    encodeBigint(tx.nonce),
    toBytes(tx.sender),
    tx.frames.map(encodeFrame),
    tx.signatures.map(encodeSignature),
    encodeFees(tx.fees),
    tx.blobVersionedHashes.map((h) => toBytes(h)),
  ];
  return RLP.encode(structure);
}

/** Inverse of encodeFrameTx. Implementer note: fill in the decode-side
 * bigint/address/hex reconstruction to exactly mirror encodeFrameTx's
 * shape above; write this by running the round-trip test in Step 1 and
 * iterating until it passes rather than deriving it from RLP docs alone,
 * since @ethereumjs/rlp's decoded shape (nested Uint8Array arrays) needs
 * careful un-flattening back into the typed FrameTransaction structure. */
export function decodeFrameTx(bytes: Uint8Array): FrameTransaction {
  throw new Error("implement against the round-trip test in Step 1 — see implementer note above");
}

/** Per EIP-8141 §Signature Hash: elide raw signature bytes for any
 * signature entry whose msg is empty before hashing. */
export function computeSigHash(tx: FrameTransaction): Hex {
  const elided: FrameTransaction = {
    ...tx,
    signatures: tx.signatures.map((s) => (s.msg === "0x" ? { ...s, signature: "0x" as const } : s)),
  };
  const payload = new Uint8Array([FRAME_TX_TYPE, ...encodeFrameTx(elided)]);
  return keccak256(payload);
}
```

> **Implementer note on `decodeFrameTx`:** deliberately left as a directed stub — the correct approach is to implement it against Step 1's round-trip test iteratively (this is exactly the kind of narrowly-scoped, testable pure function called out in this plan's Global Constraints as needing a real test; do not mark this task's Step 5 (commit) done until `decodeFrameTx` is actually implemented and the round-trip test in Step 1 passes for real, not merely compiles).

- [ ] **Step 4: Implement `decodeFrameTx` and iterate until all three tests pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/FrameTxService/codec.test.ts
```

Expected: all three tests PASS after `decodeFrameTx` is filled in.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/services/FrameTxService/codec.ts packages/executor/test/services/FrameTxService/codec.test.ts packages/executor/package.json
git commit -m "feat(executor): add FrameTx RLP codec and compute_sig_hash"
```

---

### Task 7: Signature validation (SECP256K1 / P256 / ARBITRARY)

**Files:**
- Create: `packages/executor/src/services/FrameTxService/signature.ts`
- Test: `packages/executor/test/services/FrameTxService/signature.test.ts`

**Interfaces:**
- Consumes: `SignatureEntry`, `SIG_SCHEME` from Task 4; `computeSigHash` from Task 6.
- Produces: `validateSignature(sig: SignatureEntry, txSender: Hex, sigHash: Hex): boolean`, consumed by Task 13 (validation) and Task 20 (simulation entry point, per EIP-8141 §Behavior step "For each `sig` in `tx.signatures`, ensure `validate_signature(...) == true`").

- [ ] **Step 1: Write failing tests covering the canonical/low-s and zero-digest rejection cases from EIP-8141 §Signature Validation**

```typescript
// packages/executor/test/services/FrameTxService/signature.test.ts
import { describe, it, expect } from "vitest";
import { privateKeyToAccount, sign } from "viem/accounts";
import { validateSignature } from "../../../src/services/FrameTxService/signature.js";
import { SIG_SCHEME } from "@skandha/types/lib/contracts/FrameTx.js";

describe("validateSignature", () => {
  const pk = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const account = privateKeyToAccount(pk);
  const sigHash = "0x" + "11".repeat(32) as `0x${string}`;

  it("accepts a valid SECP256K1 signature with empty signer (defaults to tx.sender)", async () => {
    const { r, s, v } = await sign({ hash: sigHash, privateKey: pk });
    const vByte = Number(v! - 27n); // recovery id, per EIP-8141: v is 0 or 1
    const sigBytes = ("0x" +
      vByte.toString(16).padStart(2, "0") +
      r.slice(2) +
      s.slice(2)) as `0x${string}`;
    const result = validateSignature(
      { scheme: SIG_SCHEME.SECP256K1, signer: "0x", msg: "0x", signature: sigBytes },
      account.address,
      sigHash
    );
    expect(result).toBe(true);
  });

  it("rejects a SECP256K1 signature with high-s (non-canonical)", () => {
    // SECP256K1N // 2 + 1, an out-of-range high-s value per EIP-8141 §Signature Validation
    const highS = "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1";
    const sigBytes = ("0x00" + "11".repeat(32) + highS.slice(2)) as `0x${string}`;
    const result = validateSignature(
      { scheme: SIG_SCHEME.SECP256K1, signer: "0x", msg: "0x", signature: sigBytes },
      account.address,
      sigHash
    );
    expect(result).toBe(false);
  });

  it("rejects the explicit 32-byte zero digest as msg", () => {
    const result = validateSignature(
      { scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: ("0x" + "00".repeat(32)) as `0x${string}`, signature: "0x" },
      account.address,
      sigHash
    );
    expect(result).toBe(false);
  });

  it("ARBITRARY scheme requires empty signer", () => {
    const result = validateSignature(
      { scheme: SIG_SCHEME.ARBITRARY, signer: account.address, msg: "0x", signature: "0xdead" },
      account.address,
      sigHash
    );
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/FrameTxService/signature.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement, transcribing EIP-8141's `validate_signature` pseudocode (§Signature Validation) directly**

```typescript
// packages/executor/src/services/FrameTxService/signature.ts
import { recoverAddress, keccak256, Hex, isAddressEqual } from "viem";
import { SignatureEntry, SIG_SCHEME } from "@skandha/types/lib/contracts/FrameTx.js";

const SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256R1N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export function validateSignature(sig: SignatureEntry, txSender: Hex, sigHash: Hex): boolean {
  let msg: Hex;
  if (sig.msg === "0x") {
    msg = sigHash;
  } else {
    const msgBytes = sig.msg.slice(2);
    if (msgBytes.length !== 64) return false;
    if (/^0{64}$/.test(msgBytes)) return false; // explicit zero digest is invalid
    msg = sig.msg as Hex;
  }

  let resolvedSigner: Hex;
  if (sig.signer === "0x") {
    resolvedSigner = txSender;
  } else if (sig.signer.length === 42) {
    resolvedSigner = sig.signer as Hex;
  } else {
    return false;
  }

  if (sig.scheme === SIG_SCHEME.SECP256K1) {
    const bytes = sig.signature.slice(2);
    if (bytes.length !== 130) return false; // 65 bytes
    const v = parseInt(bytes.slice(0, 2), 16);
    const r = BigInt("0x" + bytes.slice(2, 66));
    const s = BigInt("0x" + bytes.slice(66, 130));
    if (v > 1 || !(r > 0n && r < SECP256K1N) || !(s > 0n && s <= SECP256K1N / 2n)) return false;
    // recoverAddress expects v as 27/28; EIP-8141's v is the 0/1 recovery id directly.
    return recoverAddress({ hash: msg, signature: { r: `0x${r.toString(16)}` as Hex, s: `0x${s.toString(16)}` as Hex, v: BigInt(v + 27) } })
      .then((recovered) => isAddressEqual(recovered, resolvedSigner)) as unknown as boolean;
    // NOTE: recoverAddress is async in viem — Step 4 below must correct this
    // function's signature to `Promise<boolean>` and propagate that through
    // every caller (Task 13, Task 20) before this compiles cleanly. Fix this
    // during Step 4, not by leaving the synchronous signature in place.
  } else if (sig.scheme === SIG_SCHEME.P256) {
    const bytes = sig.signature.slice(2);
    if (bytes.length !== 256) return false; // 128 bytes
    const r = BigInt("0x" + bytes.slice(0, 64));
    const s = BigInt("0x" + bytes.slice(64, 128));
    const qx = ("0x" + bytes.slice(128, 192)) as Hex;
    const qy = ("0x" + bytes.slice(192, 256)) as Hex;
    if (!(r > 0n && r < SECP256R1N) || !(s > 0n && s <= SECP256R1N / 2n)) return false;
    const expectedSigner = keccak256(("0x" + qx.slice(2) + qy.slice(2)) as Hex).slice(0, 42) as Hex;
    if (!isAddressEqual(expectedSigner, resolvedSigner)) return false;
    // P256VERIFY precompile call: implement against EIP-7951's precompile
    // address once available in this workspace's viem/geth client config.
    throw new Error("P256VERIFY precompile call not yet wired — implement during Step 4");
  } else if (sig.scheme === SIG_SCHEME.ARBITRARY) {
    return sig.signer === "0x";
  }
  return false;
}
```

- [ ] **Step 4: Fix the async/`Promise<boolean>` signature mismatch flagged in Step 3, wire the P256VERIFY precompile call, and iterate until all four tests pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/FrameTxService/signature.test.ts
```

Expected: all four tests PASS. Update this file's exported signature to `export async function validateSignature(...): Promise<boolean>` and update the test file's assertions to `await`/`expect(await validateSignature(...))` accordingly — the sketch in Step 3 intentionally leaves this inconsistency for the implementer to resolve here, not earlier, since the correct async boundary only becomes obvious once `recoverAddress`'s real signature is in front of you.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/services/FrameTxService/signature.ts packages/executor/test/services/FrameTxService/signature.test.ts
git commit -m "feat(executor): add frame tx signature validation (SECP256K1/P256/ARBITRARY)"
```

---

### Task 8: SSZ gossip/reqresp schemas for frame transactions

**Files:**
- Create: `packages/types/src/node/frameTx.ts`
- Test: `packages/types/test/node/frameTx.test.ts`
- Reference: `packages/types/src/node/` (existing `ts.VerifiedUserOperation`, `ts.PooledUserOpHashes`, `ts.PooledUserOpsByHash` SSZ definitions — read these first to match the existing `@chainsafe/ssz` container-definition style before writing new ones)

**Interfaces:**
- Consumes: `FrameTransaction` field shapes from Task 4 (as the source of truth for what the SSZ container must be able to represent).
- Produces: `ssz.VerifiedFrameTx`, `ssz.PooledFrameTxHashesRequest`, `ssz.PooledFrameTxHashes`, `ssz.PooledFrameTxsByHashRequest`, `ssz.PooledFrameTxsByHash` SSZ container types, consumed by Task 9 (gossip validation) and Task 10 (reqresp protocols).

- [ ] **Step 1: Read the existing UserOp SSZ definitions to match their style exactly**

```bash
cd /Users/alexf/skandha
find packages/types/src/node -name "*.ts" | xargs grep -l "VerifiedUserOperation\|PooledUserOp" 
```

Read each matched file fully before writing Step 3 below — do not guess the `@chainsafe/ssz` container-builder API from memory; this repo's existing style (likely `ContainerType`/`ListCompositeType` from `@chainsafe/ssz`) is the pattern to replicate, not a generic SSZ tutorial's pattern.

- [ ] **Step 2: Write the failing serialization round-trip test**

```typescript
// packages/types/test/node/frameTx.test.ts
import { describe, it, expect } from "vitest";
import { ssz } from "../../src/node/frameTx.js";

describe("frame tx SSZ schemas", () => {
  it("serializes and deserializes a VerifiedFrameTx round-trip", () => {
    const sample = ssz.VerifiedFrameTx.defaultValue();
    const serialized = ssz.VerifiedFrameTx.serialize(sample);
    const deserialized = ssz.VerifiedFrameTx.deserialize(serialized);
    expect(ssz.VerifiedFrameTx.equals(sample, deserialized)).toBe(true);
  });
});
```

- [ ] **Step 3: Implement the SSZ containers**, following exactly the style discovered in Step 1 (do not write speculative code here — this step's actual content is determined by what Step 1 reads, so implement it live against that reference rather than from a canned snippet).

- [ ] **Step 4: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/types/test/node/frameTx.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/node/frameTx.ts packages/types/test/node/frameTx.test.ts
git commit -m "feat(types): add SSZ schemas for frame tx gossip/reqresp"
```

---

### Task 9: Gossip validation (replaces `verifiedUserOperation.ts`)

**Files:**
- Create: `packages/node/src/network/validation/verifiedFrameTx.ts`
- Delete: `packages/node/src/network/validation/verifiedUserOperation.ts`
- Test: `packages/node/test/network/validation/verifiedFrameTx.test.ts`

**Interfaces:**
- Consumes: `ssz.VerifiedFrameTx` from Task 8.
- Produces: `validateGossipVerifiedFrameTx(config, verifiedFrameTx): Promise<void>` (throws `GossipValidationError` on failure), wired into `packages/node/src/network/gossip/handler.ts`'s existing dispatch (read that file to find where `validateGossipVerifiedUserOperation` is currently called and replace the call site — do not duplicate the handler wiring).

- [ ] **Step 1: Write the failing tests, mirroring the original file's two checks**

```typescript
// packages/node/test/network/validation/verifiedFrameTx.test.ts
import { describe, it, expect, vi } from "vitest";
import { validateGossipVerifiedFrameTx } from "../../../src/network/validation/verifiedFrameTx.js";
import { GossipValidationError, GossipErrorCode } from "../../../src/network/gossip/errors.js";

describe("validateGossipVerifiedFrameTx", () => {
  it("rejects a transaction whose block hash is more than 20 blocks stale", async () => {
    const config = {
      getPublicClient: () => ({ getBlockNumber: async () => 1000n }),
    } as any;
    const staleFrameTx = { verified_at_block_hash: 979n }; // 1000 - 21
    await expect(validateGossipVerifiedFrameTx(config, staleFrameTx)).rejects.toThrow(GossipValidationError);
  });

  it("accepts a transaction within the staleness window", async () => {
    const config = {
      getPublicClient: () => ({ getBlockNumber: async () => 1000n }),
    } as any;
    const freshFrameTx = { verified_at_block_hash: 985n }; // 1000 - 15
    await expect(validateGossipVerifiedFrameTx(config, freshFrameTx)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/node/test/network/validation/verifiedFrameTx.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement, adapting `verifiedUserOperation.ts`'s two checks (already read in full in this conversation) — drop the `isEntryPointSupported` check entirely, since there is no per-deployment EntryPoint address to whitelist under EIP-8141 (`ENTRY_POINT` is a single protocol constant)**

```typescript
// packages/node/src/network/validation/verifiedFrameTx.ts
import { ts } from "@skandha/types/lib/index.js";
import { Config } from "@skandha/executor/lib/config";
import { GossipErrorCode, GossipValidationError } from "../gossip/errors.js";

export async function validateGossipVerifiedFrameTx(
  relayersConfig: Config,
  verifiedFrameTx: ts.VerifiedFrameTx
): Promise<void> {
  const blockHash = Number(verifiedFrameTx.verified_at_block_hash);
  const publicClient = relayersConfig.getPublicClient();
  const blockNumber = await publicClient.getBlockNumber();
  if (blockNumber == null || blockHash + 20 < blockNumber) {
    throw new GossipValidationError(GossipErrorCode.OUTDATED_USER_OP, "Old frame transaction");
  }
}
```

- [ ] **Step 4: Delete the old file and update the gossip handler's call site**

```bash
rm packages/node/src/network/validation/verifiedUserOperation.ts
```

Read `packages/node/src/network/processor/gossipHandlers.ts` (or wherever `validateGossipVerifiedUserOperation` is invoked — confirm the exact call site by grep before editing):

```bash
grep -rn "validateGossipVerifiedUserOperation" packages/node/src
```

Replace that call with `validateGossipVerifiedFrameTx`, updating the imported type accordingly.

- [ ] **Step 5: Run to confirm pass, and confirm no remaining references to the deleted file**

```bash
cd /Users/alexf/skandha
bun run vitest run packages/node/test/network/validation/verifiedFrameTx.test.ts
grep -rn "verifiedUserOperation" packages/node/src
```

Expected: tests PASS; grep returns zero matches.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(node): replace UserOp gossip validation with frame tx validation"
```

---

### Task 10: ReqResp protocols (`PooledFrameTxHashes` / `PooledFrameTxsByHash`)

**Files:**
- Create: `packages/node/src/reqresp/protocols/PooledFrameTxHashes.ts`, `packages/node/src/reqresp/protocols/PooledFrameTxsByHash.ts`
- Delete: `packages/node/src/reqresp/protocols/PooledUserOpHashes.ts`, `packages/node/src/reqresp/protocols/PooledUserOpsByHash.ts`
- Modify: `packages/node/src/reqresp/protocols/index.ts`, `packages/node/src/reqresp/handlers/index.ts` (and the two handler files, renamed to match)
- Test: `packages/node/test/reqresp/protocols/PooledFrameTxHashes.test.ts`

**Interfaces:**
- Consumes: `ssz.PooledFrameTxHashesRequest`, `ssz.PooledFrameTxHashes`, `ssz.PooledFrameTxsByHashRequest`, `ssz.PooledFrameTxsByHash` from Task 8.
- Produces: two `DuplexProtocolDefinitionGenerator`-shaped protocol definitions registered in the reqresp protocol table, consumed by Task 11's peer sync/reqresp integration (already existing — this task only swaps what's registered, not the registration mechanism).

- [ ] **Step 1: Write the failing protocol-shape test**

```typescript
// packages/node/test/reqresp/protocols/PooledFrameTxHashes.test.ts
import { describe, it, expect } from "vitest";
import { PooledFrameTxHashes } from "../../../src/reqresp/protocols/PooledFrameTxHashes.js";

describe("PooledFrameTxHashes protocol definition", () => {
  it("declares the expected method name and encoding", () => {
    const def = PooledFrameTxHashes({} as any, (() => {}) as any);
    expect(def.method).toBe("pooled_frame_tx_hashes");
    expect(def.encoding).toBe("ssz_snappy");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/node/test/reqresp/protocols/PooledFrameTxHashes.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement `PooledFrameTxsByHash.ts`, transcribing the structure already read in this conversation (`packages/node/src/reqresp/protocols/PooledUserOpsByHash.ts`) with renamed method/types**

```typescript
// packages/node/src/reqresp/protocols/PooledFrameTxsByHash.ts
import { ssz, ts } from "@skandha/types/lib/index.js";
import { ContextBytesType, DuplexProtocolDefinitionGenerator, Encoding } from "../types.js";

export const PooledFrameTxsByHash: DuplexProtocolDefinitionGenerator<
  ts.PooledFrameTxsByHashRequest,
  ts.PooledFrameTxsByHash
> = (modules, handler) => {
  return {
    method: "pooled_frame_txs_by_hash",
    version: 1,
    encoding: Encoding.SSZ_SNAPPY,
    requestType: () => ssz.PooledFrameTxsByHashRequest,
    responseType: () => ssz.PooledFrameTxsByHash,
    contextBytes: { type: ContextBytesType.Empty },
    handler,
    inboundRateLimits: {
      byPeer: { quota: 5, quotaTimeMs: 15_000 },
    },
  };
};
```

Implement `PooledFrameTxHashes.ts` analogously against its own already-existing `PooledUserOpHashes.ts` counterpart (read that file before writing this one — do not guess its shape).

- [ ] **Step 4: Delete the old protocol files, update the protocol/handler index files and their handler implementations**

```bash
rm packages/node/src/reqresp/protocols/PooledUserOpHashes.ts packages/node/src/reqresp/protocols/PooledUserOpsByHash.ts
rm packages/node/src/reqresp/handlers/pooledUserOpHashes.ts packages/node/src/reqresp/handlers/pooledUserOpsByHash.ts
```

Create `packages/node/src/reqresp/handlers/pooledFrameTxHashes.ts` and `pooledFrameTxsByHash.ts` by adapting the deleted handlers' logic (read them first — they query the local mempool for pending hashes/entries; the query interface changes only in which mempool service method they call, once Task 16 exists). Update `packages/node/src/reqresp/protocols/index.ts` and `packages/node/src/reqresp/handlers/index.ts` to export the new names instead of the old.

- [ ] **Step 5: Run to confirm pass and confirm no dangling references**

```bash
cd /Users/alexf/skandha
bun run vitest run packages/node/test/reqresp/protocols/PooledFrameTxHashes.test.ts
grep -rln "PooledUserOp" packages/node/src
```

Expected: test PASSes; grep returns zero matches (aside from any that legitimately still reference `packages/types`'s not-yet-deleted UserOp SSZ types — none should remain in `packages/node/src` after this task, since Task 8 already added the frame-tx equivalents alongside, not instead of, the old ones; only fully remove the old `ts.PooledUserOp*` SSZ types from `packages/types` once this task and Task 22 have both landed, to avoid breaking `packages/executor`'s still-UserOp-shaped code mid-refactor).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(node): replace PooledUserOp reqresp protocols with PooledFrameTx equivalents"
```

---

### Task 11: Upgrade the libp2p dependency stack

**Files:**
- Modify: `packages/node/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a `packages/node` buildable and testable against current `libp2p`/`@chainsafe/*` package majors, addressing the staleness risk identified when surveying the fork target (`libp2p@0.42.2`, `@libp2p/mplex@7.1.3`, `@chainsafe/libp2p-gossipsub@6.2.0`, `@chainsafe/discv5@3.0.0` were the versions found in the repo at fork time — all pre-date libp2p's 1.0 API rewrite).

- [ ] **Step 1: Record the current pinned versions as a baseline**

```bash
cd /Users/alexf/skandha
grep -E "libp2p|discv5|gossipsub|noise|mplex|yamux" packages/node/package.json | tee /tmp/libp2p-baseline.txt
```

- [ ] **Step 2: Check current upstream versions**

```bash
for pkg in libp2p @libp2p/tcp @libp2p/mplex @libp2p/bootstrap @libp2p/mdns @libp2p/peer-id-factory @chainsafe/discv5 @chainsafe/libp2p-gossipsub @chainsafe/libp2p-noise; do
  echo "=== $pkg ==="
  npm view "$pkg" version 2>&1
done
```

- [ ] **Step 3: Bump each dependency in `packages/node/package.json` to its current major, one family at a time, running the existing node package's test suite after each bump — do not bump everything in one shot**

Order: `@chainsafe/discv5` first (discovery layer, most isolated), then `@chainsafe/libp2p-gossipsub` + `@chainsafe/libp2p-noise`, then core `libp2p` + `@libp2p/*` transport/muxer packages last (these have the most interdependent breaking-change surface across a 0.x→1.x jump).

```bash
bun install
bun run vitest run packages/node
```

Expected after each bump: either the existing tests pass unchanged, or fail with clear API-shape errors (e.g. a renamed method, a changed constructor signature) that must be fixed in the calling code before moving to the next bump — do not accumulate multiple families' breakage before fixing any of it.

- [ ] **Step 4: Full node package build + test pass**

```bash
bun run build --filter=@skandha/node
bun run vitest run packages/node
```

Expected: clean build, all tests passing against the upgraded stack.

- [ ] **Step 5: Commit**

```bash
git add packages/node/package.json packages/node/src
git commit -m "chore(node): upgrade libp2p/discv5/gossipsub dependency stack to current majors"
```

---

### Task 12: Rewrite the tracer.js opcode/associated-storage rule table

**Files:**
- Modify: `packages/executor/tracer.js`
- Test: `packages/executor/test/tracer.test.ts` (new — the existing repo has no direct unit test for `tracer.js` since it only runs inside `debug_traceCall`; this task adds a local-geth-backed integration test)

**Interfaces:**
- Consumes: the finished `erc-7562.md` §Opcode Rules (from the companion spec plan's Task 6) as the literal rule source.
- Produces: an updated `BundlerCollectorReturn`-shaped tracer whose opcode/storage collection matches the frame-tx banned-opcode list, consumed by Task 13.

- [ ] **Step 1: Read the current tracer.js in full and identify every place it references ERC-4337-specific concepts**

```bash
cat packages/executor/tracer.js
```

Identify (do not guess) every reference to: the `EntryPoint` address special-case, `depositTo`/`incrementNonce` call allow-listing, and any UserOp-entity-specific call-depth bookkeeping. Cross-reference each against `erc-7562.md` §Opcode Rules' `[OP-051]`/`[OP-052]`/`[OP-053]`/`[OP-054]`/`[OP-055]`, which the companion spec plan marks "ERC-4337 only" (no `EntryPoint` contract exists to allow-list calls against under EIP-8141 — see the combined document's Terminology Mapping section), to confirm which blocks of the tracer are safe to delete outright versus which need retargeting.

- [ ] **Step 2: Set up a local geth-dev environment for the tracer integration test**

```bash
cd /Users/alexf/skandha/test && docker-compose up -d geth-dev
```

(This reuses the existing `test/docker-compose.yml` already present in the repo, per `P2P.md`'s documented workflow — read `P2P.md` first to confirm the exact service name and port before assuming `geth-dev` is correct.)

- [ ] **Step 3: Write a failing integration test that traces a minimal frame-tx-shaped call and asserts a banned opcode is caught**

```typescript
// packages/executor/test/tracer.test.ts
import { describe, it, expect } from "vitest";
import { createPublicClient, http, encodeFunctionData } from "viem";
import { GethTracer } from "../src/services/UserOpValidation/GethTracer.js";

describe("tracer.js banned opcode detection", () => {
  it("flags TIMESTAMP usage in a traced call", async () => {
    const publicClient = createPublicClient({ transport: http("http://127.0.0.1:8545") });
    const gethTracer = new GethTracer(publicClient, { nativeTracer: false } as any);
    // Deploy-and-call a minimal contract whose code is just `TIMESTAMP POP STOP`
    // via debug_traceCall's stateOverrides.code, then confirm the tracer's
    // returned opcode list contains "TIMESTAMP" for that call frame.
    // Implementer note: fill in the exact stateOverrides payload against
    // this repo's existing GethTracer.debug_traceCall signature (already
    // read in full earlier in this fork) once the local geth-dev node is
    // confirmed reachable — do not hardcode a contract address without
    // first confirming the deployment step against the running node.
  });
});
```

- [ ] **Step 4: Confirm the test fails for the expected reason (either the tracer doesn't run yet against a bare stateOverride call, or the opcode isn't yet in the banned set) — fill in the implementer note from Step 3 before proceeding**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/tracer.test.ts
```

- [ ] **Step 5: Edit `tracer.js`'s opcode-collection rule table to match `erc-7562.md` §Opcode Rules exactly for the frame-tx case** — add `SLOTNUM` (`0x4B`) and `SETDELEGATE` (`0xF6`) to the banned/deploy-frame-exception handling (the new `FRA-*`-adjacent additions the combined doc makes), remove any `ORIGIN`-specific banning logic (marked "ERC-4337 only" in the combined doc, since EIP-8141 redefines `ORIGIN`'s meaning), and remove any `EntryPoint`-address-specific call-allowlisting logic identified in Step 1 (per `[OP-051]`–`[OP-055]`'s "ERC-4337 only" marking).

- [ ] **Step 6: Run to confirm the test passes**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/tracer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Tear down the local geth-dev environment**

```bash
cd /Users/alexf/skandha/test && docker-compose down
```

- [ ] **Step 8: Commit**

```bash
git add packages/executor/tracer.js packages/executor/test/tracer.test.ts
git commit -m "feat(executor): rewrite tracer.js opcode rule table for frame tx validation prefix"
```

---

### Task 13: Validation-prefix opcode/storage interpreter (replaces `safe.ts`)

**Files:**
- Create: `packages/executor/src/services/UserOpValidation/validators/frameTx.ts`
- Delete: `packages/executor/src/services/UserOpValidation/validators/safe.ts`, `packages/executor/src/services/UserOpValidation/validators/unsafe.ts`
- Test: `packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts`

**Interfaces:**
- Consumes: `GethTracer` (unchanged, from `GethTracer.ts`), `validateSignature` (Task 7), `classifyFrame`/`FRAME_SUBCLASS` (Task 5), associated-storage utilities from Task 14, validation-prefix recognition from Task 15.
- Produces: `FrameTxValidationService.validate(tx: FrameTransaction): Promise<FrameTxValidationResult>`, consumed by Task 20 (simulation) and Task 22 (RPC surface).

**This is the highest-value transcription task in the plan.** `safe.ts` (already read in full earlier in this conversation, 869 lines) is a faithful, working implementation of ERC-7562's OP-*/STO-*/COD-010 rules, keyed to a 4-slot entity model (`stakeInfoEntities = {factory, account, paymaster}`, indexed by `callsFromEntryPointMethodSigs` — "which call depth was `validateUserOp` vs `validatePaymasterUserOp`"). This task re-keys that same logic to iterate the validation prefix's frames by mode/subclass instead of by call depth. Do not rewrite the underlying opcode/storage-access judgment calls from scratch — port them line-by-line from `safe.ts`, changing only the indexing scheme.

- [ ] **Step 1: Write failing tests for the two structural checks `safe.ts` already performs that carry over unchanged (no CALL-with-value outside SENDER frames; no illegal EntryPoint calls)**

```typescript
// packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts
import { describe, it, expect, vi } from "vitest";
import { FrameTxValidationService } from "../../../../src/services/UserOpValidation/validators/frameTx.js";
import { FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";

describe("FrameTxValidationService", () => {
  it("rejects a VERIFY-mode frame that reads storage outside tx.sender", async () => {
    // Construct a GethTracer stub whose debug_traceCall result shows an
    // SLOAD access to an address other than tx.sender during a VERIFY
    // frame, and assert FrameTxValidationService.validate(...) rejects
    // it with a message referencing STO rules (per erc-7562.md
    // §Storage Rules — an unstaked entity accessing non-sender storage
    // outside the associated-storage carve-outs is invalid).
    // Implementer note: build this stub against GethTracer's actual
    // BundlerCollectorReturn shape (packages/types/src/executor/index.ts,
    // already referenced by safe.ts) — read that type definition before
    // writing the mock's shape.
  });

  it("accepts a staked payer's read of its own associated storage per STO-032", async () => {
    // Mirrors the equivalent staked-entity carve-out safe.ts already
    // tests indirectly via its access-info handling — construct a stake
    // above minStake for the payer entity and confirm no rejection.
  });
});
```

- [ ] **Step 2: Confirm failure (module not found)**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts
```

- [ ] **Step 3: Implement `FrameTxValidationService`, transcribing `safe.ts`'s `validateCustomTracerResult`/`validateNativeTracerResult` methods with the entity-indexing scheme changed from call-depth-by-method-signature to frame-index-by-subclass**

Key structural change from `safe.ts`: replace

```typescript
// old (safe.ts): indexed by which EntryPoint call depth matched a known method sig
const currentNumLevel = traceCall.callsFromEntryPoint.find(
  (info) => info.topLevelMethodSig === callsFromEntryPointMethodSigs[entityTitle]
);
```

with

```typescript
// new: indexed by validation-prefix frame subclass (Task 5/15)
import { classifyFrame, FRAME_SUBCLASS } from "@skandha/types/lib/contracts/frameModes.js";
import { recognizeValidationPrefix } from "../utils/validationPrefix.js"; // Task 15

const prefix = recognizeValidationPrefix(tx.frames);
if (prefix == null) {
  throw new RpcError("frame transaction validation prefix not recognized", RpcErrorCodes.INVALID_OPCODE);
}
for (const { frame, frameIndex, role } of prefix.frames) {
  // role is "sender" | "payer" | "factory", per Task 2 of the companion
  // spec plan's Entity redefinition — this replaces safe.ts's
  // stakeInfoEntities loop over {factory, account, paymaster}.
  const currentNumLevel = traceCall.callsFromEntryPoint[frameIndex]; // or the native-tracer equivalent, mirroring safe.ts's two-branch (custom/native) structure
  // ... port the banned-opcode check, CREATE/CREATE2 special-casing, and
  // associated-storage access loop from safe.ts's corresponding block
  // verbatim, substituting `entityTitle` -> `role` and
  // `stakeInfoEntities[entityTitle]` -> the role's resolved stake info
  // (from Task 19's StakingRegistryService, not from a parsed EntryPoint
  // validation-result struct, since no such struct exists).
}
```

Port the remainder of `safe.ts`'s logic (banned opcode set from `tracer.js`/Task 12, `isSlotAssociatedWith` calls, contract-size/un-deployed-address checks, `extCodeAccessInfo` EntryPoint-address check — this last one changes to check against `ENTRY_POINT` the protocol constant from Task 4, not a per-deployment address) line-by-line, keeping the whitelisted-entities carve-out logic (`this.networkConfig.whitelistedEntities`) unchanged in shape.

- [ ] **Step 4: Delete `safe.ts` and `unsafe.ts`, update `UserOpValidation/service.ts`'s references**

```bash
rm packages/executor/src/services/UserOpValidation/validators/safe.ts
rm packages/executor/src/services/UserOpValidation/validators/unsafe.ts
```

(`unsafe.ts`'s "skip the tracer, just call the EntryPoint directly" fallback path has no analogue once `EntryPointService` is deleted — Task 20's `FrameTxSimulationService` becomes the only simulation path; there is no separate "unsafe mode" for a protocol-native transaction type, since there's no contract call to skip tracing on.)

- [ ] **Step 5: Run to confirm both tests pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/UserOpValidation/validators/frameTx.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(executor): replace safe.ts/unsafe.ts with frame-tx validation-prefix interpreter"
```

---

### Task 14: Adapt associated-storage utilities

**Files:**
- Modify: `packages/executor/src/services/UserOpValidation/utils.ts` (contains `isSlotAssociatedWith`, `parseEntitySlots`, already read in this conversation as imports of `safe.ts`)
- Test: `packages/executor/test/services/UserOpValidation/utils.test.ts`

**Interfaces:**
- Consumes: the sender/payer/factory role list (Task 2 of the companion spec plan).
- Produces: `parseEntitySlots(stakeInfoEntities: {sender, payer, factory}, keccakValues: string[]): Record<string, Set<string>>` (renamed parameter shape from `{factory, account, paymaster}`), consumed by Task 13.

- [ ] **Step 1: Write a failing test asserting the associated-storage slot pattern from `erc-7562.md` §Definitions item 4 (`keccak(A||x)+n`, n∈0..128) is detected correctly for the new three-role shape**

```typescript
// packages/executor/test/services/UserOpValidation/utils.test.ts
import { describe, it, expect } from "vitest";
import { keccak256, encodePacked, toHex } from "viem";
import { isSlotAssociatedWith, parseEntitySlots } from "../../../src/services/UserOpValidation/utils.js";

describe("associated storage detection", () => {
  it("detects a slot at keccak(payer||x)+5 as associated with the payer", () => {
    const payerAddr = "0x2222222222222222222222222222222222222222";
    const x = "0x" + "00".repeat(32);
    const base = BigInt(keccak256(encodePacked(["address", "bytes32"], [payerAddr, x as `0x${string}`])));
    const slot = toHex(base + 5n);
    const entitySlots = parseEntitySlots({ payer: { addr: payerAddr } } as any, []);
    expect(isSlotAssociatedWith(slot, payerAddr, entitySlots)).toBe(true);
  });

  it("does not flag a slot at offset 129 as associated (outside the 0..128 range)", () => {
    const payerAddr = "0x2222222222222222222222222222222222222222";
    const x = "0x" + "00".repeat(32);
    const base = BigInt(keccak256(encodePacked(["address", "bytes32"], [payerAddr, x as `0x${string}`])));
    const slot = toHex(base + 129n);
    const entitySlots = parseEntitySlots({ payer: { addr: payerAddr } } as any, []);
    expect(isSlotAssociatedWith(slot, payerAddr, entitySlots)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm current behavior**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/UserOpValidation/utils.test.ts
```

Expected: read `utils.ts`'s current implementation first — if the existing `isSlotAssociatedWith`/`parseEntitySlots` logic already implements the `n∈0..128` range check correctly (likely, since ERC-7562's definition is unchanged in the companion spec), this test may PASS immediately against the *unmodified* function signature, in which case this task reduces to updating the parameter *names* (`factory`/`account`/`paymaster` → `factory`/`sender`/`payer`) for callers in Task 13, not the underlying logic. Confirm which case applies before writing Step 3.

- [ ] **Step 3: If the range-check logic itself needs no change, skip to renaming; if it does, fix it to match**

(Content of this step depends on Step 2's finding — do not assume in advance.)

- [ ] **Step 4: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/UserOpValidation/utils.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/services/UserOpValidation/utils.ts packages/executor/test/services/UserOpValidation/utils.test.ts
git commit -m "test(executor): confirm/adapt associated-storage detection for frame tx roles"
```

---

### Task 15: Validation-prefix recognition (the four EIP-8141 prefix shapes)

**Files:**
- Create: `packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts`
- Test: `packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts`

**Interfaces:**
- Consumes: `Frame`, `FRAME_MODE`, `APPROVE_SCOPE` (Task 4), `classifyFrame`/`FRAME_SUBCLASS` (Task 5).
- Produces: `recognizeValidationPrefix(frames: Frame[]): ValidationPrefixMatch | null`, where `ValidationPrefixMatch = { payerFrameIndex: number, frames: {frame: Frame, frameIndex: number, role: "sender"|"payer"|"factory"}[] }`, consumed by Task 13.

- [ ] **Step 1: Write failing tests for all four recognized shapes from EIP-8141 §Public Mempool-recognized Validation Prefixes, plus one rejection case**

```typescript
// packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts
import { describe, it, expect } from "vitest";
import { recognizeValidationPrefix } from "../../../../src/services/UserOpValidation/utils/validationPrefix.js";
import { FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";

const verifyFrame = (flags: number) => ({
  mode: FRAME_MODE.VERIFY, flags, target: null,
  limits: { execution: 1n, state: 0n }, value: 0n, data: "0x" as const,
});
const deployFrame = () => ({
  mode: FRAME_MODE.DEFAULT, flags: 0, target: "0x3333333333333333333333333333333333333333" as const,
  limits: { execution: 1n, state: 1n }, value: 0n, data: "0x" as const,
});

describe("recognizeValidationPrefix", () => {
  it("recognizes [self_verify] — Basic Transaction, Self Relay", () => {
    const match = recognizeValidationPrefix([verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)]);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(0);
  });

  it("recognizes [deploy, self_verify] — Deploy New Account, Self Relay", () => {
    const match = recognizeValidationPrefix([deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)]);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(1);
    expect(match!.frames.find((f) => f.role === "factory")).toBeDefined();
  });

  it("recognizes [only_verify, pay] — Basic Transaction, Canonical Paymaster", () => {
    const match = recognizeValidationPrefix([verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)]);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(1);
    expect(match!.frames.find((f) => f.role === "payer")!.frameIndex).toBe(1);
  });

  it("recognizes [deploy, only_verify, pay] — Deploy New Account, Canonical Paymaster", () => {
    const match = recognizeValidationPrefix([deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)]);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(2);
  });

  it("rejects a frame list matching none of the four shapes", () => {
    const match = recognizeValidationPrefix([verifyFrame(APPROVE_SCOPE.PAYMENT), verifyFrame(APPROVE_SCOPE.EXECUTION)]); // pay before only_verify — wrong order
    expect(match).toBeNull();
  });

  it("skips a leading expiry_verify frame per EIP-8141 §Expiry Verifier Frame", () => {
    const expiryFrame = verifyFrame(APPROVE_SCOPE.NONE);
    const match = recognizeValidationPrefix([expiryFrame, verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)]);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(1);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement, transcribing EIP-8141 §Public Mempool-recognized Validation Prefixes' four shapes and §Structural Rules items 1–8 exactly**

```typescript
// packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts
import { Frame, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { classifyFrame, FRAME_SUBCLASS } from "@skandha/types/lib/contracts/frameModes.js";

export interface ValidationPrefixMatch {
  payerFrameIndex: number;
  frames: { frame: Frame; frameIndex: number; role: "sender" | "payer" | "factory" }[];
}

export function recognizeValidationPrefix(allFrames: Frame[]): ValidationPrefixMatch | null {
  // Per EIP-8141 §Expiry Verifier Frame: an expiry_verify frame may only
  // appear as the first frame, and is skipped for prefix-shape matching.
  let offset = 0;
  if (allFrames.length > 0 && classifyFrame(allFrames[0]) === FRAME_SUBCLASS.EXPIRY_VERIFY) {
    offset = 1;
  }
  const frames = allFrames.slice(offset);

  const hasDeploy = frames.length > 0 && classifyFrame(frames[0]) === FRAME_SUBCLASS.DEPLOY_OR_POST_OP;
  const rest = hasDeploy ? frames.slice(1) : frames;
  const deployIndexOffset = offset + (hasDeploy ? 1 : 0);

  const result: ValidationPrefixMatch["frames"] = [];
  if (hasDeploy) {
    result.push({ frame: frames[0], frameIndex: offset, role: "factory" });
  }

  // Self Relay: [self_verify]
  if (rest.length >= 1 && (rest[0].flags & APPROVE_SCOPE.EXECUTION_AND_PAYMENT) === APPROVE_SCOPE.EXECUTION_AND_PAYMENT && rest[0].mode === FRAME_MODE.VERIFY) {
    result.push({ frame: rest[0], frameIndex: deployIndexOffset, role: "payer" });
    return { payerFrameIndex: deployIndexOffset, frames: result };
  }

  // Canonical Paymaster: [only_verify, pay]
  if (
    rest.length >= 2 &&
    rest[0].mode === FRAME_MODE.VERIFY && (rest[0].flags & APPROVE_SCOPE.EXECUTION_AND_PAYMENT) === APPROVE_SCOPE.EXECUTION &&
    rest[1].mode === FRAME_MODE.VERIFY && (rest[1].flags & APPROVE_SCOPE.EXECUTION_AND_PAYMENT) === APPROVE_SCOPE.PAYMENT
  ) {
    result.push({ frame: rest[0], frameIndex: deployIndexOffset, role: "sender" });
    result.push({ frame: rest[1], frameIndex: deployIndexOffset + 1, role: "payer" });
    return { payerFrameIndex: deployIndexOffset + 1, frames: result };
  }

  return null;
}
```

> **Implementer note:** this sketch omits EIP-8141 §Structural Rules items 5–8 (no `ATOMIC_BATCH_FLAG` in the prefix, gas-sum bound against `MAX_VERIFY_GAS`/`MAX_VERIFY_STATE_GAS`, no trailing `VERIFY` frame after the prefix) — those are cross-cutting checks best implemented as a separate `validateStructuralRules(tx, prefix)` function called from Task 13, not folded into shape-recognition itself, since they need the *whole* transaction (for the "no VERIFY after prefix" check) not just the candidate prefix slice. Add that function to this same file before Step 4, with its own test cases mirroring `erc-7562.md`'s (companion plan) eventual Structural Rules disposition.

- [ ] **Step 4: Implement the omitted `validateStructuralRules` function flagged above, add its tests, and run everything**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts
```

Expected: all tests PASS, including the six from Step 1 and whatever's added for `validateStructuralRules`.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts packages/executor/test/services/UserOpValidation/utils/validationPrefix.test.ts
git commit -m "feat(executor): add EIP-8141 validation-prefix shape recognition"
```

---

### Task 16: Frame tx mempool entry entity

**Files:**
- Create: `packages/executor/src/entities/FrameTxMempoolEntry.ts`
- Delete: `packages/executor/src/entities/MempoolEntry.ts`
- Test: `packages/executor/test/entities/FrameTxMempoolEntry.test.ts`

**Interfaces:**
- Consumes: `FrameTransaction` (Task 4), `ValidationPrefixMatch` (Task 15).
- Produces: `FrameTxMempoolEntry` class replacing `MempoolEntry`, with `sender`/`payer`/`factory` fields instead of `sender`/`factory`/`paymaster`/`aggregator`, consumed by Tasks 17, 18, 20, 22, 24.

- [ ] **Step 1: Read the existing `MempoolEntry.ts` in full to enumerate every field/method that must carry over**

```bash
cat packages/executor/src/entities/MempoolEntry.ts
```

- [ ] **Step 2: Write a failing test asserting the new entity's constructor accepts a `FrameTransaction` and exposes `sender`/`payer`/`factory` (not `aggregator`)**

```typescript
// packages/executor/test/entities/FrameTxMempoolEntry.test.ts
import { describe, it, expect } from "vitest";
import { FrameTxMempoolEntry } from "../../src/entities/FrameTxMempoolEntry.js";
import { FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";

describe("FrameTxMempoolEntry", () => {
  it("exposes sender/payer/factory derived from the validation prefix, with no aggregator field", () => {
    const tx = {
      chainId: 1n, nonce: 0n, sender: "0x1111111111111111111111111111111111111111" as const,
      frames: [{ mode: FRAME_MODE.VERIFY, flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT, target: null, limits: { execution: 1n, state: 0n }, value: 0n, data: "0x" as const }],
      signatures: [], fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, maxFeePerBlobGas: 0n }, blobVersionedHashes: [],
    };
    const entry = new FrameTxMempoolEntry(tx);
    expect(entry.sender).toBe(tx.sender);
    expect(entry.payer).toBe(tx.sender); // self_verify: payer resolves to tx.sender
    expect((entry as any).aggregator).toBeUndefined();
  });
});
```

- [ ] **Step 3: Confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/entities/FrameTxMempoolEntry.test.ts
```

- [ ] **Step 4: Implement, porting `MempoolEntry.ts`'s non-entity-specific fields/methods (hash, gas fields, insertion timestamp, DB serialization — read Step 1's output for the exact list) unchanged, and computing `sender`/`payer`/`factory` via `recognizeValidationPrefix` (Task 15) in the constructor**

- [ ] **Step 5: Delete the old entity, update every importer**

```bash
rm packages/executor/src/entities/MempoolEntry.ts
grep -rln "MempoolEntry" packages/executor/src | grep -v FrameTxMempoolEntry
```

For each file the grep returns, update the import — most will be fully rewritten in later tasks (17, 18, 20, 22, 24) anyway; for any not yet reached by this plan, leave a `// TODO(Task N): migrate to FrameTxMempoolEntry` comment referencing the specific later task that owns the migration, so the workspace-wide build failure list stays traceable rather than silently broken.

- [ ] **Step 6: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/entities/FrameTxMempoolEntry.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(executor): replace MempoolEntry with FrameTxMempoolEntry (sender/payer/factory)"
```

---

### Task 17: Adapt reputation.ts to the three-role model

**Files:**
- Modify: `packages/executor/src/services/MempoolService/reputation.ts` (already read in full earlier in this conversation)
- Test: `packages/executor/test/services/MempoolService/reputation.test.ts`

**Interfaces:**
- Consumes: `FrameTxMempoolEntry` (Task 16).
- Produces: `MempoolReputationChecks` with `checkEntityCountInMempool`, `checkMultipleRolesViolation`, `updateSeenStatus` re-keyed to the three-role model, no `aggregator` parameter anywhere.

- [ ] **Step 1: Write failing tests mirroring the two structural checks already implemented in the original file (`checkMultipleRolesViolation`'s "sender used as a different entity elsewhere" and "payer used as a sender elsewhere" cases), minus the aggregator branch**

```typescript
// packages/executor/test/services/MempoolService/reputation.test.ts
import { describe, it, expect, vi } from "vitest";
import { MempoolReputationChecks } from "../../../src/services/MempoolService/reputation.js";

describe("MempoolReputationChecks.checkMultipleRolesViolation", () => {
  it("rejects a frame tx whose payer address is already a sender elsewhere in the mempool", async () => {
    const payerAddr = "0x2222222222222222222222222222222222222222";
    const mempoolService = {
      fetchPendingFrameTxs: vi.fn().mockResolvedValue([{ sender: payerAddr, payer: payerAddr, factory: undefined }]),
    } as any;
    const checks = new MempoolReputationChecks(mempoolService, {} as any, {} as any);
    const entry = { sender: "0x3333333333333333333333333333333333333333", payer: payerAddr, factory: undefined } as any;
    await expect(checks.checkMultipleRolesViolation(entry)).rejects.toThrow();
  });

  it("has no aggregator-related method or parameter anywhere on the class", () => {
    const checks = new MempoolReputationChecks({} as any, {} as any, {} as any);
    expect((checks as any).checkAggregatorRoleViolation).toBeUndefined();
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/MempoolService/reputation.test.ts
```

Expected: the first test fails because the module still uses the old four-parameter constructor/entity shape; the second may already pass trivially or fail depending on how far Task 16 propagated — record which before proceeding.

- [ ] **Step 3: Adapt the file** — remove the `aggregator` parameter from `checkEntityCountInMempool`'s signature and its four-element `titles`/`count`/`stakes` arrays (shrink to three: `["sender", "factory", "payer"]`); remove the `aggregatorInfo` handling in `updateSeenStatus`; in `checkMultipleRolesViolation`, rename `entry.paymaster`/`entry.factory` field access to `entry.payer`/`entry.factory` (per `FrameTxMempoolEntry`'s field names from Task 16) and drop the `INITCODE_EIP7702_MARKER` special-case (no EIP-7702 initcode marker exists under EIP-8141 — factory identification goes through `classifyFrame`/Task 15 instead). Keep every other line of logic — the ban/throttle lookup flow, the `MAX_MEMPOOL_USEROPS_PER_SENDER`/`THROTTLED_ENTITY_MEMPOOL_COUNT` constant usage, the whitelist carve-out — unchanged.

- [ ] **Step 4: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/MempoolService/reputation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/services/MempoolService/reputation.ts packages/executor/test/services/MempoolService/reputation.test.ts
git commit -m "feat(executor): adapt reputation checks to sender/payer/factory model, drop aggregator"
```

---

### Task 18: Canonical-payer code-match detection and balance reservation

**Files:**
- Create: `packages/executor/src/services/MempoolService/canonicalPaymaster.ts`
- Test: `packages/executor/test/services/MempoolService/canonicalPaymaster.test.ts`

**Interfaces:**
- Consumes: `FrameTxMempoolEntry` (Task 16).
- Produces: `isCanonicalPaymaster(runtimeCode: Hex): boolean`, `CanonicalPaymasterReservationTracker` class with `reserve(paymaster, maxCost)`/`release(paymaster, maxCost)`/`availableBalance(paymaster, currentBalance)` methods, implementing EIP-8141 §Canonical paymaster's `reserved_pending_cost` accounting, consumed by Task 17's `checkEntityCountInMempool` extension point (payer solvency check, per this plan's companion spec Task 10's `[EREP-010]` disposition).

- [ ] **Step 1: Write failing tests for the reservation lifecycle**

```typescript
// packages/executor/test/services/MempoolService/canonicalPaymaster.test.ts
import { describe, it, expect } from "vitest";
import { CanonicalPaymasterReservationTracker } from "../../../src/services/MempoolService/canonicalPaymaster.js";

describe("CanonicalPaymasterReservationTracker", () => {
  it("rejects a new reservation that would exceed available balance", () => {
    const tracker = new CanonicalPaymasterReservationTracker();
    const paymaster = "0x4444444444444444444444444444444444444444";
    tracker.reserve(paymaster, 100n);
    const available = tracker.availableBalance(paymaster, 150n); // balance=150, reserved=100
    expect(available).toBe(50n);
    expect(() => {
      if (200n > available) throw new Error("insufficient available balance");
    }).toThrow();
  });

  it("release() reduces reserved_pending_cost for that paymaster only", () => {
    const tracker = new CanonicalPaymasterReservationTracker();
    const p1 = "0x4444444444444444444444444444444444444444";
    const p2 = "0x5555555555555555555555555555555555555555";
    tracker.reserve(p1, 100n);
    tracker.reserve(p2, 200n);
    tracker.release(p1, 100n);
    expect(tracker.availableBalance(p1, 100n)).toBe(100n);
    expect(tracker.availableBalance(p2, 200n)).toBe(0n);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/MempoolService/canonicalPaymaster.test.ts
```

- [ ] **Step 3: Implement, transcribing EIP-8141 §Canonical paymaster's `reserved_pending_cost`/`available_paymaster_balance` formulas exactly**

```typescript
// packages/executor/src/services/MempoolService/canonicalPaymaster.ts
import { Hex, keccak256 } from "viem";

/** Runtime bytecode hash of the canonical paymaster implementation this
 * mempool trusts. Implementer note: this must be pinned to a specific,
 * audited deployment's runtime code — do not leave it as a placeholder
 * hash in any commit that reaches a shared branch; obtain the real value
 * from the canonical paymaster reference implementation once published
 * alongside EIP-8141, and treat a mismatch here as "not canonical" (the
 * non-canonical, MAX_PENDING_TXS_USING_NON_CANONICAL_PAYMASTER-capped
 * path), never as an error. */
const CANONICAL_PAYMASTER_CODE_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

export function isCanonicalPaymaster(runtimeCode: Hex): boolean {
  return keccak256(runtimeCode) === CANONICAL_PAYMASTER_CODE_HASH;
}

export class CanonicalPaymasterReservationTracker {
  private reservedPendingCost = new Map<Hex, bigint>();

  reserve(paymaster: Hex, maxCost: bigint): void {
    const current = this.reservedPendingCost.get(paymaster) ?? 0n;
    this.reservedPendingCost.set(paymaster, current + maxCost);
  }

  release(paymaster: Hex, maxCost: bigint): void {
    const current = this.reservedPendingCost.get(paymaster) ?? 0n;
    const next = current - maxCost;
    this.reservedPendingCost.set(paymaster, next < 0n ? 0n : next);
  }

  /** Per EIP-8141 §Canonical paymaster:
   * available_paymaster_balance = balance - reserved_pending_cost - pending_withdrawal_amount
   * pending_withdrawal_amount is omitted here (0n) — wire it once the
   * canonical paymaster's delayed-withdrawal read path is implemented in
   * Task 20's simulation service. */
  availableBalance(paymaster: Hex, currentBalance: bigint, pendingWithdrawalAmount: bigint = 0n): bigint {
    const reserved = this.reservedPendingCost.get(paymaster) ?? 0n;
    const available = currentBalance - reserved - pendingWithdrawalAmount;
    return available < 0n ? 0n : available;
  }
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/MempoolService/canonicalPaymaster.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/services/MempoolService/canonicalPaymaster.ts packages/executor/test/services/MempoolService/canonicalPaymaster.test.ts
git commit -m "feat(executor): add canonical-paymaster code match and balance reservation tracking"
```

---

### Task 19: `IStakingRegistry` client

**Files:**
- Create: `packages/executor/src/services/StakingRegistryService/index.ts`
- Test: `packages/executor/test/services/StakingRegistryService/index.test.ts`

**Interfaces:**
- Consumes: `erc-7562.md` §Appendix A's `IStakingRegistry` Solidity interface (companion spec plan's Task 14) as the ABI source of truth.
- Produces: `StakingRegistryService.getDepositInfo(entity: Hex): Promise<{stake: bigint, unstakeDelaySec: number, withdrawTime: bigint}>`, `StakingRegistryService.checkStake(entity: Hex): Promise<{code: number, msg: string}>` (mirroring the existing `ReputationService.checkStake` shape already read in this conversation's `reputation.ts` review, so `reputation.ts`/`safe.ts`'s callers need minimal change), consumed by Tasks 13 and 17.

- [ ] **Step 1: Write failing tests using a mocked `viem` public client**

```typescript
// packages/executor/test/services/StakingRegistryService/index.test.ts
import { describe, it, expect, vi } from "vitest";
import { StakingRegistryService } from "../../../src/services/StakingRegistryService/index.js";

describe("StakingRegistryService", () => {
  it("checkStake returns code 0 when stake and unstake delay both meet the minimum", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue([2_000_000_000_000_000_000n, 172800, 0n]), // stake, unstakeDelaySec, withdrawTime
    } as any;
    const svc = new StakingRegistryService(publicClient, "0x6666666666666666666666666666666666666666", {
      minStake: 1_000_000_000_000_000_000n,
      minUnstakeDelay: 86400,
    } as any);
    const result = await svc.checkStake("0x7777777777777777777777777777777777777777");
    expect(result.code).toBe(0);
  });

  it("checkStake returns a nonzero code when unstake delay is below the minimum", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue([2_000_000_000_000_000_000n, 3600, 0n]),
    } as any;
    const svc = new StakingRegistryService(publicClient, "0x6666666666666666666666666666666666666666", {
      minStake: 1_000_000_000_000_000_000n,
      minUnstakeDelay: 86400,
    } as any);
    const result = await svc.checkStake("0x7777777777777777777777777777777777777777");
    expect(result.code).not.toBe(0);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/StakingRegistryService/index.test.ts
```

- [ ] **Step 3: Implement against the `IStakingRegistry` ABI from the companion spec's Appendix A**

```typescript
// packages/executor/src/services/StakingRegistryService/index.ts
import { PublicClient, Hex } from "viem";

const STAKING_REGISTRY_ABI = [
  {
    type: "function", name: "getDepositInfo", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "stake", type: "uint256" },
      { name: "unstakeDelaySec", type: "uint32" },
      { name: "withdrawTime", type: "uint64" },
    ],
  },
] as const;

export class StakingRegistryService {
  constructor(
    private publicClient: PublicClient,
    private registryAddress: Hex,
    private networkConfig: { minStake: bigint; minUnstakeDelay: number }
  ) {}

  async getDepositInfo(entity: Hex): Promise<{ stake: bigint; unstakeDelaySec: number; withdrawTime: bigint }> {
    const [stake, unstakeDelaySec, withdrawTime] = (await this.publicClient.readContract({
      address: this.registryAddress,
      abi: STAKING_REGISTRY_ABI,
      functionName: "getDepositInfo",
      args: [entity],
    })) as unknown as [bigint, number, bigint];
    return { stake, unstakeDelaySec, withdrawTime };
  }

  async checkStake(entity: Hex): Promise<{ code: number; msg: string }> {
    const { stake, unstakeDelaySec } = await this.getDepositInfo(entity);
    if (stake < this.networkConfig.minStake) {
      return { code: 1, msg: `${entity} stake ${stake} below minimum ${this.networkConfig.minStake}` };
    }
    if (unstakeDelaySec < this.networkConfig.minUnstakeDelay) {
      return { code: 2, msg: `${entity} unstake delay ${unstakeDelaySec} below minimum ${this.networkConfig.minUnstakeDelay}` };
    }
    return { code: 0, msg: "" };
  }
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/StakingRegistryService/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/services/StakingRegistryService packages/executor/test/services/StakingRegistryService
git commit -m "feat(executor): add IStakingRegistry client"
```

---

### Task 20: `FrameTxSimulationService` (replaces `EntryPointService`)

**Files:**
- Create: `packages/executor/src/services/FrameTxSimulationService/index.ts`
- Test: `packages/executor/test/services/FrameTxSimulationService/index.test.ts`

**Interfaces:**
- Consumes: `encodeFrameTx`/`computeSigHash` (Task 6), `validateSignature` (Task 7), `GethTracer` (unchanged), `FrameTxValidationService` (Task 13).
- Produces: `FrameTxSimulationService.simulate(tx: FrameTransaction): Promise<FrameTxSimulationResult>`, the direct replacement for `EntryPointService.encodeSimulateValidation`/`parseValidationResult`/`balanceOf` — but built around a `debug_traceCall` against the frame transaction's own decoded execution semantics (per EIP-8141 §Behavior) rather than an ABI-encoded call to a contract. Consumed by Task 22 (RPC surface `sendFrameTransaction`/`estimateFrameTransactionGas`).

**This task has no direct ERC-4337/the sidecar precedent to port from** — `EntryPointService` assumed a deployed contract to call `eth_call`/`debug_traceCall` against; here, "simulating a frame transaction" means executing the protocol-defined per-frame behavior (EIP-8141 §Behavior: signature validation, then each frame's `mode`/`target`/`APPROVE` handling) directly, which requires either (a) a geth build that accepts `FRAME_TX_TYPE` (`0x06`) transactions and can simulate them via a standard `eth_call`-equivalent once EIP-8141 is actually implemented in the execution client, or (b) a client-side EVM interpreter shim that replays the frame semantics against `debug_traceCall`'s state-override primitives when no compliant execution client is available yet. Resolve which path applies before starting Step 3 below — this is a real environment dependency, not a coding choice this plan can make in the abstract.

- [ ] **Step 1: Determine which execution-client path is available**

```bash
# Check whether the local/target geth build recognizes FRAME_TX_TYPE transactions:
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' http://127.0.0.1:8545
# Then check for frame-tx support specifically — no standard RPC method
# exists yet to probe this generically; consult whichever go-ethereum
# branch/fork is being run against for EIP-8141 (this is a coordination
# point with whoever maintains the target geth build, not something to
# resolve unilaterally from this repo).
```

Record the answer in this task's PR description before proceeding — Steps 2–5 below assume path (a) (a compliant execution client exists); if only path (b) is available, this task's scope grows substantially (a client-side frame-semantics interpreter) and should be split into its own plan rather than force-fit into this task's steps.

- [ ] **Step 2: Write a failing test asserting `simulate()` returns per-frame results shaped like EIP-8141's `ReceiptPayload`**

```typescript
// packages/executor/test/services/FrameTxSimulationService/index.test.ts
import { describe, it, expect, vi } from "vitest";
import { FrameTxSimulationService } from "../../../src/services/FrameTxSimulationService/index.js";

describe("FrameTxSimulationService.simulate", () => {
  it("returns a per-frame status/gas_used array matching tx.frames.length", async () => {
    // Implementer note: this test's concrete shape depends on Step 1's
    // finding. If a compliant execution client is available, stub its
    // debug_traceCall response with a minimal two-frame trace and assert
    // the parsed FrameTxSimulationResult.frameReceipts has length 2. Do
    // not write this test's body until Step 1 is resolved.
  });
});
```

- [ ] **Step 3: Confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/FrameTxSimulationService/index.test.ts
```

- [ ] **Step 4: Implement `FrameTxSimulationService`, structured to call `GethTracer.debug_traceCall` (unchanged from Task 12) against the encoded frame transaction (Task 6's `encodeFrameTx`) and `FrameTxValidationService.validate` (Task 13) to interpret the resulting trace, returning a `FrameTxSimulationResult` shaped after EIP-8141 §Receipt Encoding (`cumulative_gas_used`, `payer`, per-frame `{status, gas_used: {execution, state}, logs}`)**

- [ ] **Step 5: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/FrameTxSimulationService/index.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/executor/src/services/FrameTxSimulationService packages/executor/test/services/FrameTxSimulationService
git commit -m "feat(executor): add FrameTxSimulationService, replacing EntryPointService"
```

---

### Task 21: `ReceiptService` (replaces `EventsService`)

**Files:**
- Create: `packages/executor/src/services/ReceiptService/index.ts`
- Test: `packages/executor/test/services/ReceiptService/index.test.ts`

**Interfaces:**
- Consumes: `FrameTxSimulationResult` shape (Task 20).
- Produces: `ReceiptService.getReceipt(txHash: Hex): Promise<FrameTxReceipt>` parsing EIP-8141's `ReceiptPayload` (`[cumulative_gas_used, payer, [frame_receipt, ...]]`, `frame_receipt = [status, gas_used, logs]`) directly from `eth_getTransactionReceipt`'s raw response, replacing `EventsService`'s `UserOperationEvent` log-topic filtering entirely (there is no event log to filter — the receipt itself is protocol-native, per EIP-8141 §Receipt Encoding).

- [ ] **Step 1: Write a failing test parsing a sample raw receipt matching EIP-8141's `ReceiptPayload` shape**

```typescript
// packages/executor/test/services/ReceiptService/index.test.ts
import { describe, it, expect, vi } from "vitest";
import { ReceiptService } from "../../../src/services/ReceiptService/index.js";

describe("ReceiptService.getReceipt", () => {
  it("parses payer and per-frame status/gas_used from a raw frame-tx receipt", async () => {
    const publicClient = {
      request: vi.fn().mockResolvedValue({
        cumulativeGasUsed: "0x186a0",
        payer: "0x8888888888888888888888888888888888888888",
        frameReceipts: [
          { status: "0x1", gasUsed: { execution: "0x100", state: "0x0" }, logs: [] },
          { status: "0x1", gasUsed: { execution: "0x200", state: "0x50" }, logs: [] },
        ],
      }),
    } as any;
    const svc = new ReceiptService(publicClient);
    const receipt = await svc.getReceipt("0x" + "aa".repeat(32) as `0x${string}`);
    expect(receipt.payer).toBe("0x8888888888888888888888888888888888888888");
    expect(receipt.frameReceipts).toHaveLength(2);
    expect(receipt.frameReceipts[1].gasUsed.state).toBe(0x50n);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/ReceiptService/index.test.ts
```

- [ ] **Step 3: Implement, parsing exactly the field names/shapes tested above** (the exact raw JSON-RPC field naming — `cumulativeGasUsed`/`payer`/`frameReceipts` vs. some other casing — depends on the target execution client's actual `eth_getTransactionReceipt` response shape for `FRAME_TX_TYPE` transactions once implemented; confirm against a live node before finalizing field names, per the same environment dependency flagged in Task 20 Step 1).

- [ ] **Step 4: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/ReceiptService/index.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/services/ReceiptService packages/executor/test/services/ReceiptService
git commit -m "feat(executor): add ReceiptService, replacing EventsService"
```

---

### Task 22: RPC surface — `sendFrameTransaction` / gas estimation

**Files:**
- Modify: `packages/executor/src/modules/eth.ts` (already read in full earlier in this conversation: `sendUserOperation`, `estimateUserOperationGas`, `getUserOperationByHash`, `getUserOperationReceipt`, `getChainId`, `getSupportedEntryPoints`)
- Test: `packages/executor/test/modules/eth.test.ts`

**Interfaces:**
- Consumes: `FrameTxSimulationService` (Task 20), `ReceiptService` (Task 21), `FrameTxMempoolEntry` (Task 16), `FrameTxValidationService` (Task 13).
- Produces: `sendFrameTransaction(tx: FrameTransaction): Promise<Hex>` (renamed/retyped from `sendUserOperation`), `estimateFrameTransactionGas(tx: Partial<FrameTransaction>): Promise<FrameGasEstimate>`, `getFrameTransactionByHash`, `getFrameTransactionReceipt`, `getChainId` (unchanged), with `getSupportedEntryPoints` removed entirely (there is exactly one `ENTRY_POINT` constant under EIP-8141, not a configurable set — see Task 4).

- [ ] **Step 1: Write failing tests for the renamed/retyped RPC methods' request-validation behavior (mirroring `eth.ts`'s existing gas-markup logic, already read in this conversation, which should carry over largely unchanged in *shape* even though it now operates on `frame.limits.execution`/`frame.limits.state` instead of `verificationGasLimit`/`callGasLimit`)**

```typescript
// packages/executor/test/modules/eth.test.ts
import { describe, it, expect, vi } from "vitest";
import { Eth } from "../../src/modules/eth.js";

describe("Eth.sendFrameTransaction", () => {
  it("rejects a transaction whose validation prefix is not recognized", async () => {
    const mockDeps = {
      /* construct minimal stubs for FrameTxValidationService, FrameTxSimulationService,
         mempoolService per this file's actual constructor — read eth.ts's
         current constructor signature (already read in this conversation,
         packages/executor/src/modules/eth.ts lines 1-50-ish) before
         building these stubs, do not guess the dependency list */
    } as any;
    const eth = new Eth(mockDeps);
    const malformedTx = { frames: [] } as any; // empty frames list — invalid per EIP-8141 Constraints
    await expect(eth.sendFrameTransaction(malformedTx)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/modules/eth.test.ts
```

- [ ] **Step 3: Implement** — rename `sendUserOperation` → `sendFrameTransaction`, retype its parameter from `SendUserOperationGasArgs` to `FrameTransaction`, replace its internal call to `entryPointService.*` with `frameTxSimulationService.simulate(tx)` and `frameTxValidationService.validate(tx)`; port the gas-markup arithmetic (`cglMarkupPercent`/`vglMarkupPercent`/`pvgMarkupPercent`/etc. — already read in full in this conversation) onto `frame.limits.execution`/`frame.limits.state` per-frame instead of the flat `verificationGasLimit`/`callGasLimit`/`preVerificationGas` fields; delete `getSupportedEntryPoints` entirely and any caller of it (grep for callers before deleting); rename `getUserOperationByHash`/`getUserOperationReceipt` to `getFrameTransactionByHash`/`getFrameTransactionReceipt`, backed by `ReceiptService` (Task 21) instead of `EventsService`.

- [ ] **Step 4: Run to confirm pass, and confirm the full workspace now builds clean (this is the task where Task 2's deliberately-broken build is finally repaired)**

```bash
cd /Users/alexf/skandha
bun run vitest run packages/executor/test/modules/eth.test.ts
bun run build
```

Expected: test PASSes; **full workspace build succeeds with zero errors** — this confirms every dangling reference from Tasks 2 and 3's deletions has now been resolved by Tasks 4–22. If the build still fails, do not proceed to Task 23 until the remaining errors are fixed; consult `/tmp/build-break-after-service-delete.log` from Task 3 to confirm every originally-broken file has since been either rewritten or deleted.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/modules/eth.ts packages/executor/test/modules/eth.test.ts
git commit -m "feat(executor): rewrite eth.ts RPC surface for frame transactions, remove getSupportedEntryPoints"
```

---

### Task 23: `skandha.ts`/`debug.ts` RPC modules — audit and adapt remaining UserOp references

**Files:**
- Modify: `packages/executor/src/modules/skandha.ts`, `packages/executor/src/modules/debug.ts`
- Test: `packages/executor/test/modules/skandha.test.ts`, `packages/executor/test/modules/debug.test.ts`

**Interfaces:**
- Consumes: whatever Task 22 exposed from `FrameTxSimulationService`/`ReceiptService`/mempool services.
- Produces: both modules free of `UserOperation`-typed parameters.

- [ ] **Step 1: Enumerate every UserOp reference remaining in these two files**

```bash
cd /Users/alexf/skandha
grep -n "UserOperation\|userOp" packages/executor/src/modules/skandha.ts packages/executor/src/modules/debug.ts
```

- [ ] **Step 2: For each method found, write a failing test asserting it now accepts/returns frame-tx-shaped data** (specific test content depends entirely on Step 1's output — do not write speculative tests before running Step 1 for real).

- [ ] **Step 3: Confirm failures, then adapt each method**, following the same rename/retype pattern established in Task 22 (`UserOperation` → `FrameTransaction`, entity-specific fields → sender/payer/factory).

- [ ] **Step 4: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/modules/skandha.test.ts packages/executor/test/modules/debug.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/modules/skandha.ts packages/executor/src/modules/debug.ts packages/executor/test/modules/skandha.test.ts packages/executor/test/modules/debug.test.ts
git commit -m "feat(executor): adapt skandha.ts/debug.ts RPC modules to frame transactions"
```

---

### Task 24: Strip `handleOps` batching from `BundlingService`; adapt relayer strategies to per-tx submission

**Files:**
- Modify: `packages/executor/src/services/BundlingService/service.ts` (481 lines, already surveyed), `packages/executor/src/services/BundlingService/utils/estimateBundleGasLimit.ts`
- Keep unchanged (confirm, don't rewrite): `packages/executor/src/services/BundlingService/relayers/{classic,echo,fastlane,flashbots,kolibri,merkle}.ts`
- Test: `packages/executor/test/services/BundlingService/service.test.ts`

**Interfaces:**
- Consumes: `FrameTxMempoolEntry` (Task 16), the relayer strategy interface already defined in `relayers/index.ts` (unchanged).
- Produces: `BundlingService.submitFrameTransaction(entry: FrameTxMempoolEntry): Promise<Hex>`, replacing the multi-op `handleOps`-assembly path with direct per-transaction relay submission — each relayer strategy receives one already-signed frame transaction to submit privately, not a constructed batch calldata blob.

- [ ] **Step 1: Read `service.ts` in full to separate its two concerns: (a) building the `handleOps` calldata batch from multiple mempool entries, and (b) handing the resulting signed transaction to a relayer strategy**

```bash
cat packages/executor/src/services/BundlingService/service.ts
```

Confirm concern (b) — the relayer dispatch — is structurally separable from concern (a); if it's tangled (e.g. a relayer strategy's interface assumes it always receives a `handleOps`-shaped calldata blob rather than an arbitrary signed transaction), note the exact coupling point before writing Step 3.

- [ ] **Step 2: Write a failing test asserting `submitFrameTransaction` calls the configured relayer strategy with a single signed frame transaction, not a batch**

```typescript
// packages/executor/test/services/BundlingService/service.test.ts
import { describe, it, expect, vi } from "vitest";
import { BundlingService } from "../../../src/services/BundlingService/service.js";

describe("BundlingService.submitFrameTransaction", () => {
  it("submits exactly one signed frame transaction to the configured relayer, with no batching", async () => {
    const relayer = { sendTransaction: vi.fn().mockResolvedValue("0x" + "cc".repeat(32)) };
    const svc = new BundlingService({ relayer } as any);
    const entry = { signedTx: "0x" + "dd".repeat(50) } as any;
    const hash = await svc.submitFrameTransaction(entry);
    expect(relayer.sendTransaction).toHaveBeenCalledTimes(1);
    expect(relayer.sendTransaction).toHaveBeenCalledWith(entry.signedTx);
    expect(hash).toBe("0x" + "cc".repeat(32));
  });
});
```

- [ ] **Step 3: Confirm failure**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/BundlingService/service.test.ts
```

- [ ] **Step 4: Implement** — delete the `handleOps`-calldata-assembly code path and `estimateBundleGasLimit.ts`'s multi-op packing logic entirely; add `submitFrameTransaction`, calling straight through to the configured relayer strategy's existing `sendTransaction`-shaped method with the single already-RLP-encoded, signed frame transaction (from Task 6's `encodeFrameTx` plus a signature applied by the sender's own wallet — signing itself is out of this sidecar's scope, it relays already-signed transactions).

- [ ] **Step 5: Confirm the relayer strategy files need no changes** — run their existing test suites (if present) unmodified:

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/BundlingService/relayers
```

Expected: PASS unchanged, confirming Task 24's File Structure note ("Keep unchanged") holds in practice, not just in the plan's prediction.

- [ ] **Step 6: Run to confirm the new test passes**

```bash
cd /Users/alexf/skandha && bun run vitest run packages/executor/test/services/BundlingService/service.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(executor): strip handleOps batching, submit frame txs individually via existing relayer strategies"
```

---

### Task 25: Remove EIP-7702 authorization-tuple handling

**Files:**
- Delete: `packages/executor/src/services/BundlingService/utils/eip7702.ts`
- Modify: `packages/executor/src/services/UserOpValidation/service.ts` (remove `validateEip7702Auth`, `Eip7702Auth` import — already read in full earlier in this conversation)

**Interfaces:**
- Consumes: nothing.
- Produces: a workspace with zero EIP-7702-authorization-tuple-specific code, since EIP-8141 carries no authorization list at all (delegation goes through the `deploy` frame's `SETDELEGATE` opcode, already handled by Task 12's tracer rule table and Task 15's `deploy` frame recognition).

- [ ] **Step 1: Confirm every caller of the code being deleted**

```bash
cd /Users/alexf/skandha
grep -rln "validateEip7702Auth\|Eip7702Auth\|eip7702" packages/executor/src
```

- [ ] **Step 2: Delete the file and remove the method/import from each caller found in Step 1**

```bash
rm packages/executor/src/services/BundlingService/utils/eip7702.ts
```

Edit `packages/executor/src/services/UserOpValidation/service.ts` to remove the `validateEip7702Auth` method and its `Eip7702Auth`/`verifyAuthorization` imports (read the file's current state at execution time before editing, since Tasks 13 and 22 have already modified this file's surrounding code by this point in the plan).

- [ ] **Step 3: Full workspace build**

```bash
bun run build
```

Expected: clean build, zero references to `eip7702` remaining in `packages/executor/src` (confirm with the Step 1 grep re-run, expecting zero results).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore(executor): remove EIP-7702 authorization-tuple handling, superseded by SETDELEGATE deploy frame"
```

---

### Task 26: End-to-end local devnet integration test

**Files:**
- Create: `test/e2e/frameTx.e2e.test.ts`
- Modify: `test/docker-compose.yml` (confirm `geth-dev` service still matches what `P2P.md` documents — update if Task 20's environment-dependency finding requires a different client image)

**Interfaces:**
- Consumes: every service built in Tasks 4–25, wired together through the full RPC → mempool → tracer → gossip → simulated-inclusion path.
- Produces: one passing end-to-end test proving the sidecar can accept a frame transaction over RPC, validate it, admit it to the local mempool, gossip it to a second local node over the (upgraded, Task 11) p2p stack, and have that second node independently validate and accept it.

- [ ] **Step 1: Bring up the local devnet, following `P2P.md`'s documented two-node workflow (already read in full earlier in this conversation), substituted for frame-tx RPC/CLI flags established by Tasks 22/24**

```bash
cd /Users/alexf/skandha/test && docker-compose up -d geth-dev
```

- [ ] **Step 2: Write the failing end-to-end test**

```typescript
// test/e2e/frameTx.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "node:child_process";

describe("frame tx e2e: two-node gossip round trip", () => {
  let bootnode: ChildProcess;
  let regularNode: ChildProcess;

  beforeAll(async () => {
    // Spawn a bootnode and a regular node, per P2P.md's documented flags,
    // substituting --executor.bundlingMode manual as in the existing
    // The sidecar workflow. Implementer note: fill in the exact CLI
    // invocation once Task 22's CLI flag names are finalized (they will
    // differ from the sidecar's --p2p.bootEnrs etc. only in flag names tied
    // to renamed RPC methods, not in the underlying node/network layer,
    // which Task 11 already confirmed still functions).
  });

  afterAll(async () => {
    bootnode?.kill();
    regularNode?.kill();
  });

  it("propagates a frame transaction from the bootnode's RPC to the regular node's mempool", async () => {
    // 1. Submit a well-formed frame transaction (self_relay shape, per
    //    Task 15's recognized prefixes) to the bootnode's sendFrameTransaction RPC.
    // 2. Poll the regular node's mempool (getFrameTransactionByHash, or
    //    an equivalent introspection RPC) until the transaction appears
    //    or a timeout elapses.
    // 3. Assert it appears within the timeout.
  });
});
```

- [ ] **Step 3: Confirm failure (either the node processes don't spawn correctly yet, or the transaction never propagates) — fill in the implementer note from Step 2 before proceeding**

```bash
cd /Users/alexf/skandha && bun run vitest run test/e2e/frameTx.e2e.test.ts
```

- [ ] **Step 4: Debug and fix until the round trip succeeds** — this step is genuinely open-ended integration debugging, not a scripted fix; expect to revisit Tasks 9, 10, 11, or 22 if a mismatch surfaces between what the gossip layer expects and what the RPC layer produces.

- [ ] **Step 5: Run to confirm pass**

```bash
cd /Users/alexf/skandha && bun run vitest run test/e2e/frameTx.e2e.test.ts
```

Expected: PASS.

- [ ] **Step 6: Tear down**

```bash
cd /Users/alexf/skandha/test && docker-compose down
```

- [ ] **Step 7: Commit**

```bash
git add test/e2e/frameTx.e2e.test.ts test/docker-compose.yml
git commit -m "test(e2e): add two-node frame tx gossip round-trip integration test"
```

---

### Task 27: Documentation update

**Files:**
- Modify: `/Users/alexf/skandha/README.md`, `/Users/alexf/skandha/P2P.md`
- Delete or update: `docs/sidecar_subscribe.md`, `docs/skandha_userOperationStatus.md` (audit for UserOp-specific RPC references per Task 22/23's renames)

**Interfaces:**
- Consumes: the final RPC method names/CLI flags from Tasks 22–24.
- Produces: documentation that matches the shipped fork, not the original sidecar.

- [ ] **Step 1: Audit both docs files for UserOp-specific RPC method names**

```bash
cd /Users/alexf/skandha
grep -n "eth_sendUserOperation\|eth_getUserOperation\|UserOperation" docs/sidecar_subscribe.md docs/skandha_userOperationStatus.md README.md P2P.md
```

- [ ] **Step 2: Update each matched reference to its Task 22/23-renamed equivalent** (`eth_sendUserOperation` → `eth_sendFrameTransaction`, etc. — use the exact final names as implemented, not the plan's sketch names, since Task 22/23's implementer notes left some naming decisions open).

- [ ] **Step 3: Update `P2P.md`'s worked example** (currently deploys an ERC-4337 `SimpleAccountFactory`/`SimpleAccount` via the `eth-infinitism/account-abstraction` repo — replace with a frame-tx-shaped worked example: an EIP-7997 deterministic factory deployment plus a `self_verify` transaction, matching Task 26's e2e test scenario).

- [ ] **Step 4: Confirm no broken references remain**

```bash
grep -rn "UserOperation\|validateUserOp\|handleOps" README.md P2P.md docs/
```

Expected: zero matches outside of any explicitly-retained "for context, this fork started from ERC-4337's the sidecar" historical note.

- [ ] **Step 5: Commit**

```bash
git add README.md P2P.md docs/
git commit -m "docs: update README/P2P docs for frame transaction RPC surface"
```
