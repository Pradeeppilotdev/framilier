# Devnet Predeploy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `deploy/predeploy/`, a tool that replays original mainnet deployment transactions onto the EIP-8141 devnet, and use it to deploy LINK, USDT and Bored Ape Yacht Club.

**Architecture:** One generic replay engine plus one small declarative manifest per protocol. `fetch` downloads mainnet creation transactions from Etherscan into committed artifacts. `run` replays them onto the devnet from a dedicated deployer key, rewriting known mainnet addresses inside constructor arguments, and journals progress so it resumes and survives devnet restarts. `verify` runs read-only checks. The engine talks to the chain through a small `ChainPort` interface, so almost everything is unit-tested against a fake chain.

**Tech Stack:** TypeScript, Bun (runtime), viem 2.27.0, Vitest 0.34.6, TypeScript 5.4.5, Etherscan API V2.

**Spec:** `docs/superpowers/specs/2026-09-21-devnet-predeploy-design.md`. Read it first.

## Scope of this plan

The spec covers eight increments. This plan delivers the engine plus the three protocols whose transaction lists are known and simple: **LINK, USDT, BAYC**. WETH9/Permit2/USDC, Tornado Cash, Uniswap v4 and Railgun each need their own transaction list settled from Etherscan history, so each gets its own later plan, written when reached. Deviations from the spec, all deliberate:

- The `call` step kind (replaying a mainnet call transaction) is not built here. Nothing in this plan needs it. The USDC plan adds it.
- A `creation <address>` command is added. It prints a mainnet contract's creation transaction, which every later plan needs to write a manifest.
- `deploy/predeploy/` is a standalone package with its own `package.json` and lockfile, not a member of the root workspace. Root scripts call into it.

## Global Constraints

- Location: `deploy/predeploy/`. Bun runs the TypeScript. Dependencies: `viem` 2.27.0 only (plus `vitest`, `typescript`, `@types/node` for development).
- The Etherscan key is read only from the `ETHERSCAN_API_KEY` environment variable, and only by `fetch` and `creation`. It is never written to any file in the repo. `.env` is already git-ignored.
- Gas limit = `eth_estimateGas` plus 20%, capped at the block gas limit (60M on the live devnet). Gas price = `2 x eth_gasPrice`. Legacy transactions, sent one at a time. The engine never sends a transaction whose estimate failed.
- Address rewriting touches only whole 32-byte words in constructor arguments (12 zero bytes, then the address). It never modifies init code.
- The deployer is a dedicated throwaway key, published in `config.ts`. It is not the shared devnet key. `fund` sends 10 ETH from the shared key when the deployer holds less than 2 ETH.
- `run --all` deploys in registry order: `link`, `usdt`, `bayc`. Addresses depend on that order.
- A runtime-code-hash difference from mainnet is reported as information and never fails a run.
- Commits: end every message with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Preparation already done (2026-09-21)

While writing this plan, every module below was implemented in a scratch directory and its tests run: 83 tests pass and `tsc --noEmit` is clean. The code in this plan is that verified code. The following also ran against the live devnet: the viem adapter (chain ID, gas price, block gas limit, estimates), `predeploy list`, and `predeploy fund` (the deployer `0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0` already holds 10 ETH, so `fund` is now a no-op). `fetch` ran for all three protocols and the engine's payloads estimated cleanly on the devnet (LINK 5,379,527 gas; USDT 18,649,474; BAYC 28,177,182). Nothing has been deployed yet.

**Human input needed once:** the `fetch` steps need the Etherscan key. Ask the user for it, `export ETHERSCAN_API_KEY=...` in the shell, and never commit it.

## File Structure

All paths are relative to `deploy/predeploy/`.

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Standalone package setup |
| `src/types.ts` | Every shared type and interface (`ChainPort`, `Protocol`, `Step`, journal and artifact shapes) |
| `src/config.ts` | Constants: RPC URL, keys, gas policy, funding amounts |
| `src/address-map.ts` | Mainnet-to-devnet address map and word-level rewriting |
| `src/creation.ts` | Splitting a creation input, overriding constructor words |
| `src/gas.ts` | Pure gas-limit and gas-price policy |
| `src/send.ts` | `submit`: estimate, apply policy, send, wait, fail loudly |
| `src/artifacts.ts`, `src/journal.ts` | File-backed stores for fetched transactions and for progress |
| `src/engine.ts` | Dependency ordering and `runProtocols` (replay, resume, stale detection) |
| `src/etherscan.ts`, `src/fetch.ts` | Rate-limited Etherscan V2 client and the `fetch` step |
| `src/verify.ts` | Read-only checks plus mainnet code-hash comparison |
| `src/chain-viem.ts` | The real `ChainPort` implementation |
| `src/args.ts`, `src/cli.ts` | Command-line parsing and the commands |
| `src/protocols/define.ts`, `link.ts`, `usdt.ts`, `bayc.ts`, `index.ts` | Manifests and the registry |
| `test/fakes.ts` | `FakeChain`, in-memory stores, artifact factory |
| `artifacts/<protocol>/<hash>.json` | Fetched mainnet transactions (committed) |
| `addresses/1337.json` | Recorded devnet addresses and step journal (committed) |
| `README.md` | Operator usage |

---

### Task 1: Package scaffold, types, config and address rewriting

**Files:**
- Create: `deploy/predeploy/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/types.ts`, `src/config.ts`, `src/address-map.ts`
- Create: `deploy/predeploy/test/address-map.test.ts`
- Modify: `package.json` (root, `scripts`)

**Interfaces:**
- Produces: all types in `src/types.ts` (later tasks import them by these exact names); `AddressMap` with `set(mainnet, devnet)`, `get(mainnet)`, `toJSON()`, `rewrite(data): { data, replaced, unmapped }`; the config constants.

- [ ] **Step 1: Create the package files**

`deploy/predeploy/package.json`:

```json
{
  "name": "@skandha/devnet-predeploy",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "description": "Replays mainnet deployment transactions onto the EIP-8141 devnet",
  "scripts": {
    "predeploy": "bun run src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "viem": "2.27.0"
  },
  "devDependencies": {
    "@types/node": "20.14.9",
    "typescript": "5.4.5",
    "vitest": "0.34.6"
  }
}
```

`deploy/predeploy/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`deploy/predeploy/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bun install
```

Expected: `viem@2.27.0`, `vitest@0.34.6` and about 70 packages installed, and a `bun.lock` created. `node_modules/` is already git-ignored.

- [ ] **Step 3: Write the failing test**

`deploy/predeploy/test/address-map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AddressMap } from "../src/address-map";
import type { Address, Hex } from "../src/types";

const word = (hex: string): string => hex.replace(/^0x/, "").padStart(64, "0");
const MAINNET_A = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const DEVNET_A = "0x1111111111111111111111111111111111111111" as Address;
// Permit2 starts with zero bytes: a vanity address.
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const DEVNET_P = "0x2222222222222222222222222222222222222222" as Address;

describe("AddressMap.rewrite", () => {
  it("replaces a mapped address word and leaves other words alone", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const input = `0x${word("0x2a")}${word(MAINNET_A)}${word("0x01")}` as Hex;

    const result = map.rewrite(input);

    expect(result.data).toBe(`0x${word("0x2a")}${word(DEVNET_A)}${word("0x01")}`);
    expect(result.replaced).toBe(1);
    expect(result.unmapped).toEqual([]);
  });

  it("matches addresses case-insensitively", () => {
    const map = new AddressMap();
    map.set(MAINNET_A.toUpperCase().replace("0X", "0x") as Address, DEVNET_A);
    const result = map.rewrite(`0x${word(MAINNET_A.toLowerCase())}` as Hex);
    expect(result.data).toBe(`0x${word(DEVNET_A)}`);
  });

  it("rewrites vanity addresses that start with zero bytes", () => {
    const map = new AddressMap();
    map.set(PERMIT2, DEVNET_P);
    const result = map.rewrite(`0x${word(PERMIT2)}` as Hex);
    expect(result.data).toBe(`0x${word(DEVNET_P)}`);
    expect(result.replaced).toBe(1);
  });

  it("reports address-looking words with no mapping and leaves them unchanged", () => {
    const map = new AddressMap();
    const input = `0x${word(MAINNET_A)}` as Hex;
    const result = map.rewrite(input);
    expect(result.data).toBe(input);
    expect(result.replaced).toBe(0);
    expect(result.unmapped).toEqual([MAINNET_A.toLowerCase()]);
  });

  it("does not flag small numbers or text as addresses", () => {
    const map = new AddressMap();
    const text = Buffer.from("Tether USD").toString("hex").padEnd(64, "0");
    const input = `0x${word("0x174876e800")}${word("0x06")}${text}` as Hex;
    const result = map.rewrite(input);
    expect(result.unmapped).toEqual([]);
    expect(result.data).toBe(input);
  });

  it("rejects data that is not a whole number of words", () => {
    expect(() => new AddressMap().rewrite("0x1234" as Hex)).toThrow(/32-byte words/);
  });

  it("round-trips through toJSON and the constructor", () => {
    const map = new AddressMap();
    map.set(MAINNET_A, DEVNET_A);
    const copy = new AddressMap(map.toJSON());
    expect(copy.get(MAINNET_A)).toBe(DEVNET_A);
  });
});
```

- [ ] **Step 4: Run it to see it fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/address-map.test.ts
```

Expected: FAIL, the test file cannot resolve `../src/address-map`.

- [ ] **Step 5: Write the types, config and implementation**

`src/types.ts`:

```ts
import type { Abi } from "viem";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface TxRequest {
  to: Address | null;
  data: Hex;
  value: bigint;
}

export interface TxResult {
  hash: Hex;
  status: "success" | "reverted";
  contractAddress: Address | null;
  gasUsed: bigint;
}

/** Everything the engine needs from a chain. Implemented by chain-viem.ts (real) and test/fakes.ts. */
export interface ChainPort {
  readonly chainId: number;
  /** Address that sends every transaction. */
  readonly account: Address;
  getCode(address: Address): Promise<Hex>;
  getBalance(address: Address): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  blockGasLimit(): Promise<bigint>;
  estimateGas(tx: TxRequest): Promise<bigint>;
  sendAndWait(tx: TxRequest & { gas: bigint; gasPrice: bigint }): Promise<TxResult>;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
}

/** One fetched mainnet contract-creation transaction, stored under artifacts/<protocol>/<hash>.json. */
export interface TxArtifact {
  hash: Hex;
  from: Address;
  to: Address | null;
  /** Hex quantity, e.g. "0x0". */
  value: Hex;
  blockNumber: number;
  /** Full creation input: init code followed by constructor arguments. */
  input: Hex;
  contractAddress: Address | null;
  /** Constructor arguments alone ("0x" when there are none). A suffix of `input`. */
  constructorArgs: Hex;
  contractName: string;
  compiler: string;
  /** keccak256 of the mainnet runtime code, or null if the contract has no code. */
  runtimeCodeHash: Hex | null;
}

export interface StepContext {
  deployer: Address;
  /** Devnet address of a contract created earlier in this protocol or in a dependency. */
  address(name: string): Address;
  send(tx: TxRequest): Promise<TxResult>;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
}

export interface CreateStep {
  id: string;
  kind: "create";
  /** Mainnet creation transaction hash. */
  tx: Hex;
  /** Name under which the created contract is recorded. */
  as: string;
  /** Replace 32-byte head words of the constructor arguments, by word index. Static types only. */
  argWords?: Record<number, Hex>;
}

export interface CustomStep {
  id: string;
  kind: "custom";
  run(ctx: StepContext): Promise<void>;
}

export type Step = CreateStep | CustomStep;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyContext {
  deployer: Address;
  address(name: string): Address;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
}

export interface Protocol {
  name: string;
  dependsOn: string[];
  steps: Step[];
  verify(ctx: VerifyContext): Promise<CheckResult[]>;
}

export interface ProtocolState {
  stepsDone: string[];
  /** Recorded name -> devnet address. */
  contracts: Record<string, Address>;
  /** Lower-case mainnet address -> devnet address, for address rewriting. */
  mainnetToDevnet: Record<string, Address>;
}

export interface JournalFile {
  chainId: number;
  protocols: Record<string, ProtocolState>;
}

export interface ArtifactStore {
  read(protocol: string, hash: Hex): TxArtifact;
  write(protocol: string, artifact: TxArtifact): void;
}

export interface JournalStore {
  load(chainId: number): JournalFile;
  save(file: JournalFile): void;
}
```

`src/config.ts` (the deployer key below is a freshly generated throwaway; it is published on purpose, see the comment in the file):

```ts
import type { Address, Hex } from "./types";

export const DEFAULT_RPC_URL = "https://altmempool.forshtat.com";
export const DEFAULT_CHAIN_ID = 1337;

/**
 * The devnet's only genesis-funded account. Throwaway key, already public in
 * deploy/devnet/genesis.values.env. Used only by `predeploy fund`.
 */
export const SHARED_DEVNET_KEY: Hex =
  "0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15";

/**
 * Throwaway devnet deployer. Published on purpose: it owns every deployed
 * contract, so anyone holding it can administer them. It is separate from the
 * shared key so that other people's transactions never shift its nonce (and
 * with it every CREATE address). NEVER use it on a real network.
 */
export const DEPLOYER_KEY: Hex =
  "0xcbb754e47d54ec3bf76954e8e4df02e68d1484c703e47d29f189e32904545191";
export const DEPLOYER_ADDRESS: Address = "0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0";

/** Extra gas on top of eth_estimateGas, in percent. */
export const GAS_MARGIN_PERCENT = 20n;
/** Multiplier applied to eth_gasPrice. */
export const GAS_PRICE_MULTIPLIER = 2n;

/** `predeploy fund` tops the deployer up to FUND_AMOUNT_WEI when its balance is below FUND_MIN_BALANCE_WEI. */
export const FUND_AMOUNT_WEI = 10n * 10n ** 18n;
export const FUND_MIN_BALANCE_WEI = 2n * 10n ** 18n;

/** Etherscan's free tier allows 5 requests per second; stay under it. */
export const ETHERSCAN_MIN_INTERVAL_MS = 250;
```

`src/address-map.ts`:

```ts
import type { Address, Hex } from "./types";

const WORD_HEX_CHARS = 64;
const ZERO_PREFIX = "0".repeat(24);

export interface RewriteResult {
  data: Hex;
  /** Number of words replaced with a devnet address. */
  replaced: number;
  /** Address-looking words that had no mapping (left unchanged). A warning, not an error. */
  unmapped: Address[];
}

/**
 * Maps mainnet addresses to the devnet addresses their replays produced, and
 * rewrites ABI-encoded data accordingly.
 *
 * Only whole 32-byte words are inspected (12 zero bytes followed by a 20-byte
 * address). That is exactly how ABI encoding places an address, and it keeps
 * the rewrite from touching bytes inside code or packed data.
 */
export class AddressMap {
  private readonly map = new Map<string, Address>();

  constructor(entries: Record<string, Address> = {}) {
    for (const [mainnet, devnet] of Object.entries(entries)) {
      this.map.set(mainnet.toLowerCase(), devnet);
    }
  }

  set(mainnet: Address, devnet: Address): void {
    this.map.set(mainnet.toLowerCase(), devnet);
  }

  get(mainnet: Address): Address | undefined {
    return this.map.get(mainnet.toLowerCase());
  }

  toJSON(): Record<string, Address> {
    return Object.fromEntries(this.map);
  }

  rewrite(data: Hex): RewriteResult {
    const body = data.slice(2);
    if (body.length % WORD_HEX_CHARS !== 0) {
      throw new Error(
        `cannot rewrite ${body.length / 2} bytes: not a whole number of 32-byte words`
      );
    }
    let out = "";
    let replaced = 0;
    const unmapped = new Set<Address>();
    for (let i = 0; i < body.length; i += WORD_HEX_CHARS) {
      const word = body.slice(i, i + WORD_HEX_CHARS);
      if (!word.startsWith(ZERO_PREFIX)) {
        out += word;
        continue;
      }
      const address = `0x${word.slice(24).toLowerCase()}` as Address;
      const devnet = this.map.get(address);
      if (devnet) {
        out += ZERO_PREFIX + devnet.slice(2).toLowerCase();
        replaced++;
        continue;
      }
      // Heuristic for the warning only: a value >= 2^152 (first address byte
      // non-zero) is almost certainly an address, not a number. Addresses that
      // start with a zero byte (vanity addresses) are not flagged.
      if (word.slice(24, 26) !== "00") unmapped.add(address);
      out += word;
    }
    return { data: `0x${out}` as Hex, replaced, unmapped: [...unmapped] };
  }
}
```

- [ ] **Step 6: Run the tests and the typecheck**

```bash
bunx vitest run test/address-map.test.ts && bunx tsc --noEmit
```

Expected: 7 tests pass, and `tsc` prints nothing.

- [ ] **Step 7: Add root scripts**

In the root `package.json`, add these two entries to `scripts`, directly after the `"test:e2e:mining"` line:

```json
    "predeploy": "bun run deploy/predeploy/src/cli.ts",
    "test:predeploy": "cd deploy/predeploy && bunx vitest run",
```

Check that the root file is still valid JSON: `bun -e 'JSON.parse(require("fs").readFileSync("package.json","utf8")); console.log("ok")'`. Expected: `ok`.

- [ ] **Step 8: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy package.json
git commit -m "feat(predeploy): package scaffold, types, config and address rewriting" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Creation splitting, constructor overrides and gas policy

**Files:**
- Create: `deploy/predeploy/src/creation.ts`, `src/gas.ts`, `test/creation.test.ts`, `test/gas.test.ts`

**Interfaces:**
- Consumes: `Hex`, `TxArtifact` from `src/types.ts`.
- Produces: `splitCreation(artifact): { initCode, args }`, `uintWord(value: bigint): Hex`, `applyArgWords(args, words | undefined): Hex`, `planGas(estimate, blockGasLimit, marginPercent): bigint`, `planGasPrice(nodeGasPrice, multiplier): bigint`.

- [ ] **Step 1: Write the failing tests**

`test/creation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyArgWords, splitCreation, uintWord } from "../src/creation";
import type { Hex } from "../src/types";

const ARGS = `0x${"00".repeat(31)}05${"00".repeat(31)}07` as Hex; // two words: 5, 7

describe("splitCreation", () => {
  it("splits init code from constructor arguments", () => {
    const { initCode, args } = splitCreation({
      input: `0x6080604052${ARGS.slice(2)}` as Hex,
      constructorArgs: ARGS,
    });
    expect(initCode).toBe("0x6080604052");
    expect(args).toBe(ARGS);
  });

  it("handles contracts without constructor arguments", () => {
    const { initCode, args } = splitCreation({ input: "0x6080", constructorArgs: "0x" });
    expect(initCode).toBe("0x6080");
    expect(args).toBe("0x");
  });

  it("throws when the arguments are not a suffix of the input", () => {
    expect(() => splitCreation({ input: "0x6080", constructorArgs: "0xff" })).toThrow(/suffix/);
  });
});

describe("uintWord", () => {
  it("encodes big-endian into 32 bytes", () => {
    expect(uintWord(10n ** 15n)).toBe(
      "0x00000000000000000000000000000000000000000000000000038d7ea4c68000"
    );
  });
  it("rejects negative values", () => {
    expect(() => uintWord(-1n)).toThrow();
  });
});

describe("applyArgWords", () => {
  it("returns the arguments unchanged when there are no overrides", () => {
    expect(applyArgWords(ARGS, undefined)).toBe(ARGS);
  });

  it("replaces the word at the given index", () => {
    const result = applyArgWords(ARGS, { 1: uintWord(9n) });
    expect(result).toBe(`0x${"00".repeat(31)}05${"00".repeat(31)}09`);
  });

  it("rejects an index outside the arguments", () => {
    expect(() => applyArgWords(ARGS, { 2: uintWord(1n) })).toThrow(/outside/);
  });

  it("rejects a value that is not a 32-byte word", () => {
    expect(() => applyArgWords(ARGS, { 0: "0x01" })).toThrow(/32-byte/);
  });
});
```

`test/gas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planGas, planGasPrice } from "../src/gas";

describe("planGas", () => {
  it("adds the margin", () => {
    expect(planGas(1_000_000n, 60_000_000n, 20n)).toBe(1_200_000n);
  });

  it("caps at the block gas limit when only the margin overshoots", () => {
    expect(planGas(55_000_000n, 60_000_000n, 20n)).toBe(60_000_000n);
  });

  it("throws when the estimate itself exceeds the block gas limit", () => {
    expect(() => planGas(61_000_000n, 60_000_000n, 20n)).toThrow(/exceeds the block gas limit/);
  });
});

describe("planGasPrice", () => {
  it("multiplies the node price", () => {
    expect(planGasPrice(1_000_007n, 2n)).toBe(2_000_014n);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/creation.test.ts test/gas.test.ts
```

Expected: FAIL, cannot resolve `../src/creation` and `../src/gas`.

- [ ] **Step 3: Implement**

`src/creation.ts`:

```ts
import type { Hex, TxArtifact } from "./types";

const WORD_HEX_CHARS = 64;

/** Splits a creation input into init code and constructor arguments. */
export function splitCreation(
  artifact: Pick<TxArtifact, "input" | "constructorArgs">
): { initCode: Hex; args: Hex } {
  const input = artifact.input.slice(2);
  const args = artifact.constructorArgs.slice(2);
  if (args.length > input.length || !input.toLowerCase().endsWith(args.toLowerCase())) {
    throw new Error("constructorArgs is not a suffix of the creation input");
  }
  return {
    initCode: `0x${input.slice(0, input.length - args.length)}` as Hex,
    args: artifact.constructorArgs,
  };
}

/** Big-endian 32-byte word for an unsigned integer. */
export function uintWord(value: bigint): Hex {
  if (value < 0n) throw new Error("uintWord: negative value");
  const hex = value.toString(16);
  if (hex.length > WORD_HEX_CHARS) throw new Error("uintWord: value does not fit in 32 bytes");
  return `0x${hex.padStart(WORD_HEX_CHARS, "0")}` as Hex;
}

/** Replaces 32-byte words of constructor arguments by word index. */
export function applyArgWords(args: Hex, words: Record<number, Hex> | undefined): Hex {
  if (!words) return args;
  let body = args.slice(2);
  for (const [key, word] of Object.entries(words)) {
    const index = Number(key);
    if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
      throw new Error(`argWords[${index}] must be a 32-byte hex word`);
    }
    const start = index * WORD_HEX_CHARS;
    if (start + WORD_HEX_CHARS > body.length) {
      throw new Error(
        `argWords[${index}] is outside the ${body.length / 2}-byte constructor arguments`
      );
    }
    body = body.slice(0, start) + word.slice(2).toLowerCase() + body.slice(start + WORD_HEX_CHARS);
  }
  return `0x${body}` as Hex;
}
```

`src/gas.ts`:

```ts
/**
 * Gas limit for a transaction: the node's estimate plus a margin, never above
 * the block gas limit. An estimate that already exceeds the block gas limit
 * can never be mined, so it is an error.
 */
export function planGas(estimate: bigint, blockGasLimit: bigint, marginPercent: bigint): bigint {
  if (estimate > blockGasLimit) {
    throw new Error(`estimated gas ${estimate} exceeds the block gas limit ${blockGasLimit}`);
  }
  const withMargin = (estimate * (100n + marginPercent)) / 100n;
  return withMargin > blockGasLimit ? blockGasLimit : withMargin;
}

export function planGasPrice(nodeGasPrice: bigint, multiplier: bigint): bigint {
  return nodeGasPrice * multiplier;
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
bunx vitest run test/creation.test.ts test/gas.test.ts && bunx tsc --noEmit
```

Expected: 13 tests pass (9 + 4), `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/creation.ts deploy/predeploy/src/gas.ts deploy/predeploy/test/creation.test.ts deploy/predeploy/test/gas.test.ts
git commit -m "feat(predeploy): creation splitting, constructor word overrides and gas policy" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Fake chain and the submit policy

**Files:**
- Create: `deploy/predeploy/test/fakes.ts`, `src/send.ts`, `test/send.test.ts`

**Interfaces:**
- Consumes: `ChainPort`, `TxRequest`, `TxResult` from `src/types.ts`; `planGas`, `planGasPrice` from `src/gas.ts`; `GAS_MARGIN_PERCENT`, `GAS_PRICE_MULTIPLIER` from `src/config.ts`.
- Produces: `submit(chain, tx, label, log): Promise<TxResult>`. Test helpers (all exported from `test/fakes.ts`): `FakeChain` (fields `estimate`, `blockLimit`, `price`, `estimateError`, `revertNext`, `sent`, `codes`, `balances`; method `setRead(address, functionName, value)`), `MemoryArtifacts`, `MemoryJournal`, `makeArtifact(overrides)`, `hash(n)`, `DEPLOYER`. `FakeChain` gives each creation the address `0x…01`, `0x…02`, and so on.

- [ ] **Step 1: Write the fakes and the failing test**

`test/fakes.ts`:

```ts
import type { Abi } from "viem";
import type {
  Address,
  ArtifactStore,
  ChainPort,
  Hex,
  JournalFile,
  JournalStore,
  TxArtifact,
  TxRequest,
  TxResult,
} from "../src/types";

export const DEPLOYER = "0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0" as Address;

export type SentTx = TxRequest & { gas: bigint; gasPrice: bigint };

/** In-memory chain. Contract creations get addresses 0x…01, 0x…02, … and non-empty code. */
export class FakeChain implements ChainPort {
  chainId = 1337;
  account = DEPLOYER;
  estimate = 100_000n;
  blockLimit = 60_000_000n;
  price = 1_000_000n;
  estimateError: string | null = null;
  revertNext = false;
  readonly sent: SentTx[] = [];
  readonly codes = new Map<string, Hex>();
  readonly balances = new Map<string, bigint>();
  readonly reads = new Map<string, unknown>();
  private counter = 0;

  async getCode(address: Address): Promise<Hex> {
    return this.codes.get(address.toLowerCase()) ?? "0x";
  }
  async getBalance(address: Address): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }
  async gasPrice(): Promise<bigint> {
    return this.price;
  }
  async blockGasLimit(): Promise<bigint> {
    return this.blockLimit;
  }
  async estimateGas(_tx: TxRequest): Promise<bigint> {
    if (this.estimateError) throw new Error(this.estimateError);
    return this.estimate;
  }
  async sendAndWait(tx: SentTx): Promise<TxResult> {
    this.sent.push(tx);
    const hash = `0x${"ab".repeat(31)}${this.sent.length.toString(16).padStart(2, "0")}` as Hex;
    if (this.revertNext) {
      this.revertNext = false;
      return { hash, status: "reverted", contractAddress: null, gasUsed: 0n };
    }
    let contractAddress: Address | null = null;
    if (tx.to === null) {
      contractAddress = `0x${(++this.counter).toString(16).padStart(40, "0")}` as Address;
      this.codes.set(contractAddress.toLowerCase(), "0x6001");
    }
    return { hash, status: "success", contractAddress, gasUsed: tx.gas };
  }
  async read(address: Address, _abi: Abi, functionName: string): Promise<unknown> {
    const key = `${address.toLowerCase()}:${functionName}`;
    if (!this.reads.has(key)) throw new Error(`FakeChain: no canned read for ${key}`);
    return this.reads.get(key);
  }
  /** Canned answer for read(address, _, functionName). */
  setRead(address: Address, functionName: string, value: unknown): void {
    this.reads.set(`${address.toLowerCase()}:${functionName}`, value);
  }
}

export class MemoryArtifacts implements ArtifactStore {
  private readonly items = new Map<string, TxArtifact>();
  read(protocol: string, hash: Hex): TxArtifact {
    const found = this.items.get(`${protocol}/${hash}`);
    if (!found) throw new Error(`MemoryArtifacts: missing ${protocol}/${hash}`);
    return found;
  }
  write(protocol: string, artifact: TxArtifact): void {
    this.items.set(`${protocol}/${artifact.hash}`, artifact);
  }
}

export class MemoryJournal implements JournalStore {
  file: JournalFile = { chainId: 1337, protocols: {} };
  load(chainId: number): JournalFile {
    return structuredClone({ ...this.file, chainId });
  }
  save(file: JournalFile): void {
    this.file = structuredClone(file);
  }
}

export function makeArtifact(overrides: Partial<TxArtifact> & Pick<TxArtifact, "hash">): TxArtifact {
  return {
    from: "0x36928500Bc1dCd7af6a2B4008875CC336b927D57",
    to: null,
    value: "0x0",
    blockNumber: 1,
    input: "0x6080",
    contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    constructorArgs: "0x",
    contractName: "Token",
    compiler: "v0.4.18",
    runtimeCodeHash: null,
    ...overrides,
  };
}

export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
```

`test/send.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { submit } from "../src/send";
import { FakeChain } from "./fakes";

const TX = { to: null, data: "0x6080", value: 0n } as const;

describe("submit", () => {
  it("sends with the margin applied to the estimate and a doubled gas price", async () => {
    const chain = new FakeChain();
    chain.estimate = 1_000_000n;
    chain.price = 1_000_007n;

    const result = await submit(chain, TX, "test/step", () => {});

    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].gas).toBe(1_200_000n);
    expect(chain.sent[0].gasPrice).toBe(2_000_014n);
    expect(result.contractAddress).not.toBeNull();
  });

  it("refuses to send when estimation fails, and says why", async () => {
    const chain = new FakeChain();
    chain.estimateError = "execution reverted: nope";

    await expect(submit(chain, TX, "test/step", () => {})).rejects.toThrow(
      /test\/step: gas estimation failed, refusing to send: execution reverted: nope/
    );
    expect(chain.sent).toHaveLength(0);
  });

  it("throws with the transaction hash when the transaction reverts", async () => {
    const chain = new FakeChain();
    chain.revertNext = true;

    await expect(submit(chain, TX, "test/step", () => {})).rejects.toThrow(
      /test\/step: transaction 0x[0-9a-f]+ reverted/
    );
  });

  it("logs the estimate and the limit", async () => {
    const chain = new FakeChain();
    const lines: string[] = [];
    await submit(chain, TX, "test/step", (m) => lines.push(m));
    expect(lines[0]).toBe("test/step: estimate 100000 gas, limit 120000");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/send.test.ts
```

Expected: FAIL, cannot resolve `../src/send`.

- [ ] **Step 3: Implement**

`src/send.ts`:

```ts
import { GAS_MARGIN_PERCENT, GAS_PRICE_MULTIPLIER } from "./config";
import { planGas, planGasPrice } from "./gas";
import type { ChainPort, TxRequest, TxResult } from "./types";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

/**
 * Estimates, then sends and waits. Never sends blind: if the node cannot
 * estimate the transaction (a revert, usually), it stops and says why.
 */
export async function submit(
  chain: ChainPort,
  tx: TxRequest,
  label: string,
  log: (message: string) => void
): Promise<TxResult> {
  let estimate: bigint;
  try {
    estimate = await chain.estimateGas(tx);
  } catch (error) {
    throw new Error(`${label}: gas estimation failed, refusing to send: ${describeError(error)}`);
  }
  const [blockLimit, nodePrice] = await Promise.all([chain.blockGasLimit(), chain.gasPrice()]);
  const gas = planGas(estimate, blockLimit, GAS_MARGIN_PERCENT);
  const gasPrice = planGasPrice(nodePrice, GAS_PRICE_MULTIPLIER);
  log(`${label}: estimate ${estimate} gas, limit ${gas}`);

  const result = await chain.sendAndWait({ ...tx, gas, gasPrice });
  if (result.status !== "success") {
    throw new Error(`${label}: transaction ${result.hash} reverted`);
  }
  return result;
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
bunx vitest run test/send.test.ts && bunx tsc --noEmit
```

Expected: 4 tests pass, `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/send.ts deploy/predeploy/test/fakes.ts deploy/predeploy/test/send.test.ts
git commit -m "feat(predeploy): submit policy (estimate, margin, never send blind) and fake chain" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: File-backed artifact and journal stores

**Files:**
- Create: `deploy/predeploy/src/artifacts.ts`, `src/journal.ts`, `test/stores.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore`, `JournalStore`, `JournalFile`, `TxArtifact`, `Hex` from `src/types.ts`; `hash`, `makeArtifact` from `test/fakes.ts`.
- Produces: `FileArtifactStore(dir)` (`read(protocol, hash)`, `write(protocol, artifact)`, files at `<dir>/<protocol>/<hash>.json`); `FileJournalStore(dir)` (`load(chainId)`, `save(file)`, files at `<dir>/<chainId>.json`).

- [ ] **Step 1: Write the failing test**

`test/stores.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileArtifactStore } from "../src/artifacts";
import { FileJournalStore } from "../src/journal";
import { hash, makeArtifact } from "./fakes";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "predeploy-stores-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileArtifactStore", () => {
  it("round-trips an artifact", () => {
    const store = new FileArtifactStore(dir);
    const artifact = makeArtifact({ hash: hash(1) });
    store.write("usdt", artifact);
    expect(store.read("usdt", hash(1))).toEqual(artifact);
    expect(fs.existsSync(path.join(dir, "usdt", `${hash(1)}.json`))).toBe(true);
  });

  it("explains how to fetch a missing artifact", () => {
    const store = new FileArtifactStore(dir);
    expect(() => store.read("usdt", hash(2))).toThrow(/predeploy fetch usdt/);
  });
});

describe("FileJournalStore", () => {
  it("returns an empty journal for an unknown chain", () => {
    expect(new FileJournalStore(dir).load(1337)).toEqual({ chainId: 1337, protocols: {} });
  });

  it("round-trips a journal", () => {
    const store = new FileJournalStore(dir);
    const journal = {
      chainId: 1337,
      protocols: {
        link: {
          stepsDone: ["token"],
          contracts: { LINK: "0x0000000000000000000000000000000000000001" as const },
          mainnetToDevnet: {
            "0x514910771af9ca656af840dff83e8264ecf986ca":
              "0x0000000000000000000000000000000000000001" as const,
          },
        },
      },
    };
    store.save(journal);
    expect(store.load(1337)).toEqual(journal);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/stores.test.ts
```

Expected: FAIL, cannot resolve `../src/artifacts`.

- [ ] **Step 3: Implement**

`src/artifacts.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import type { ArtifactStore, Hex, TxArtifact } from "./types";

/** Stores each fetched transaction at <dir>/<protocol>/<hash>.json. */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly dir: string) {}

  private file(protocol: string, hash: Hex): string {
    return path.join(this.dir, protocol, `${hash}.json`);
  }

  read(protocol: string, hash: Hex): TxArtifact {
    const file = this.file(protocol, hash);
    if (!fs.existsSync(file)) {
      throw new Error(
        `missing artifact ${file}. Run \`bun run predeploy fetch ${protocol}\` (needs ETHERSCAN_API_KEY).`
      );
    }
    return JSON.parse(fs.readFileSync(file, "utf8")) as TxArtifact;
  }

  write(protocol: string, artifact: TxArtifact): void {
    const file = this.file(protocol, artifact.hash);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
  }
}
```

`src/journal.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import type { JournalFile, JournalStore } from "./types";

/** Stores the address map and step journal for a chain at <dir>/<chainId>.json. */
export class FileJournalStore implements JournalStore {
  constructor(private readonly dir: string) {}

  private file(chainId: number): string {
    return path.join(this.dir, `${chainId}.json`);
  }

  load(chainId: number): JournalFile {
    const file = this.file(chainId);
    if (!fs.existsSync(file)) return { chainId, protocols: {} };
    return JSON.parse(fs.readFileSync(file, "utf8")) as JournalFile;
  }

  save(journal: JournalFile): void {
    const file = this.file(journal.chainId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
bunx vitest run test/stores.test.ts && bunx tsc --noEmit
```

Expected: 4 tests pass, `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/artifacts.ts deploy/predeploy/src/journal.ts deploy/predeploy/test/stores.test.ts
git commit -m "feat(predeploy): file-backed artifact and journal stores" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: The replay engine

**Files:**
- Create: `deploy/predeploy/src/protocols/define.ts`, `src/engine.ts`, `test/engine.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: `defineProtocol(protocol): Protocol`; `type Registry = Record<string, Protocol>`; `EngineDeps { chain, artifacts, journal, log }`; `resolveOrder(names, registry): string[]` (dependencies first, each once; throws on unknown names and cycles); `runProtocols(names, registry, deps, { force? }): Promise<JournalFile>`.

Behavior the tests pin down: a `create` step replays the artifact's init code plus rewritten, override-applied constructor arguments; each finished step is journaled immediately; a protocol whose steps are all journaled is skipped; a protocol whose recorded contracts have no code (chain restarted) starts over; `force` redeploys only the requested protocols, not their dependencies; custom steps receive a context whose `address()` resolves names from this protocol and earlier ones and whose `send()` uses the same estimate-and-margin policy.

- [ ] **Step 1: Write the failing test**

`test/engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveOrder, runProtocols, type Registry } from "../src/engine";
import { uintWord } from "../src/creation";
import { defineProtocol } from "../src/protocols/define";
import type { Address, Hex } from "../src/types";
import { FakeChain, MemoryArtifacts, MemoryJournal, hash, makeArtifact } from "./fakes";

const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const MAINNET_TOKEN = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
const word = (hex: string): string => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

const noop = async () => [];
function create(name: string, txs: Array<{ tx: Hex; as: string }>, dependsOn: string[] = []) {
  return defineProtocol({
    name,
    dependsOn,
    steps: txs.map((t, i) => ({ id: `s${i}`, kind: "create" as const, tx: t.tx, as: t.as })),
    verify: noop,
  });
}

function setup(registry: Registry) {
  const chain = new FakeChain();
  const artifacts = new MemoryArtifacts();
  const journal = new MemoryJournal();
  const logs: string[] = [];
  const deps = { chain, artifacts, journal, log: (m: string) => logs.push(m) };
  return { chain, artifacts, journal, logs, deps, registry };
}

describe("resolveOrder", () => {
  const registry: Registry = {
    a: create("a", []),
    b: create("b", [], ["a"]),
    c: create("c", [], ["a", "b"]),
  };

  it("puts dependencies first and lists each protocol once", () => {
    expect(resolveOrder(["c", "b"], registry)).toEqual(["a", "b", "c"]);
  });

  it("rejects unknown protocols", () => {
    expect(() => resolveOrder(["nope"], registry)).toThrow(/unknown protocol "nope"/);
  });

  it("rejects dependency cycles", () => {
    const cyclic: Registry = { x: create("x", [], ["y"]), y: create("y", [], ["x"]) };
    expect(() => resolveOrder(["x"], cyclic)).toThrow(/dependency cycle: x -> y -> x/);
  });
});

describe("runProtocols", () => {
  it("replays a creation, records the address, and journals the step", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, journal, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1), input: "0x6080", contractAddress: MAINNET_TOKEN }));

    await runProtocols(["token"], registry, deps);

    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].to).toBeNull();
    expect(chain.sent[0].data).toBe("0x6080");
    const state = journal.file.protocols.token;
    expect(state.stepsDone).toEqual(["s0"]);
    expect(state.contracts.TOKEN).toBe("0x0000000000000000000000000000000000000001");
    expect(state.mainnetToDevnet[MAINNET_TOKEN.toLowerCase()]).toBe(state.contracts.TOKEN);
  });

  it("applies the gas margin and the doubled gas price", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));
    chain.estimate = 1_000_000n;
    chain.price = 1_000_007n;

    await runProtocols(["token"], registry, deps);

    expect(chain.sent[0].gas).toBe(1_200_000n);
    expect(chain.sent[0].gasPrice).toBe(2_000_014n);
  });

  it("rewrites a dependency's mainnet address inside constructor arguments", async () => {
    const registry: Registry = {
      weth: create("weth", [{ tx: hash(1), as: "WETH" }]),
      router: create("router", [{ tx: hash(2), as: "ROUTER" }], ["weth"]),
    };
    const { chain, artifacts, deps } = setup(registry);
    artifacts.write("weth", makeArtifact({ hash: hash(1), input: "0x6001", contractAddress: MAINNET_WETH }));
    const args = `0x${word(MAINNET_WETH)}` as Hex;
    artifacts.write(
      "router",
      makeArtifact({
        hash: hash(2),
        input: `0x6002${args.slice(2)}` as Hex,
        constructorArgs: args,
        contractAddress: "0x000000000004444c5dc75cB358380D2e3dE08A90",
      })
    );

    await runProtocols(["router"], registry, deps);

    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1].data).toBe(`0x6002${word("0x0000000000000000000000000000000000000001")}`);
  });

  it("applies argWords overrides before rewriting", async () => {
    const registry: Registry = {
      token: defineProtocol({
        name: "token",
        dependsOn: [],
        steps: [{ id: "s0", kind: "create", tx: hash(1), as: "T", argWords: { 0: uintWord(99n) } }],
        verify: noop,
      }),
    };
    const { chain, artifacts, deps } = setup(registry);
    const args = `0x${word("0x05")}` as Hex;
    artifacts.write("token", makeArtifact({ hash: hash(1), input: `0x6080${args.slice(2)}` as Hex, constructorArgs: args }));

    await runProtocols(["token"], registry, deps);

    expect(chain.sent[0].data).toBe(`0x6080${word("0x63")}`);
  });

  it("does nothing for a protocol that is already deployed", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));

    await runProtocols(["token"], registry, deps);
    await runProtocols(["token"], registry, deps);

    expect(chain.sent).toHaveLength(1);
  });

  it("resumes at the first incomplete step", async () => {
    const registry: Registry = {
      pair: create("pair", [{ tx: hash(1), as: "A" }, { tx: hash(2), as: "B" }]),
    };
    const { chain, artifacts, journal, deps } = setup(registry);
    artifacts.write("pair", makeArtifact({ hash: hash(1), input: "0x6001" }));
    artifacts.write("pair", makeArtifact({ hash: hash(2), input: "0x6002" }));
    const first = "0x00000000000000000000000000000000000000aa" as Address;
    chain.codes.set(first, "0x6001");
    journal.file.protocols.pair = { stepsDone: ["s0"], contracts: { A: first }, mainnetToDevnet: {} };

    await runProtocols(["pair"], registry, deps);

    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].data).toBe("0x6002");
    expect(journal.file.protocols.pair.stepsDone).toEqual(["s0", "s1"]);
  });

  it("starts over when recorded contracts are missing from the chain", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, journal, logs, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));
    journal.file.protocols.token = {
      stepsDone: ["s0"],
      contracts: { TOKEN: "0x00000000000000000000000000000000000000bb" },
      mainnetToDevnet: {},
    };

    await runProtocols(["token"], registry, deps);

    expect(chain.sent).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/token: recorded contracts are missing from this chain/);
  });

  it("--force redeploys the requested protocol but not its dependency", async () => {
    const registry: Registry = {
      weth: create("weth", [{ tx: hash(1), as: "WETH" }]),
      router: create("router", [{ tx: hash(2), as: "ROUTER" }], ["weth"]),
    };
    const { chain, artifacts, deps } = setup(registry);
    artifacts.write("weth", makeArtifact({ hash: hash(1), contractAddress: MAINNET_WETH }));
    artifacts.write("router", makeArtifact({ hash: hash(2), contractAddress: MAINNET_TOKEN }));

    await runProtocols(["router"], registry, deps);
    await runProtocols(["router"], registry, deps, { force: true });

    expect(chain.sent).toHaveLength(3); // weth, router, router again
  });

  it("runs custom steps with a context that resolves addresses and sends through the same policy", async () => {
    let seen: { deployer?: Address; token?: Address } = {};
    const registry: Registry = {
      token: defineProtocol({
        name: "token",
        dependsOn: [],
        steps: [
          { id: "make", kind: "create", tx: hash(1), as: "TOKEN" },
          {
            id: "poke",
            kind: "custom",
            run: async (ctx) => {
              seen = { deployer: ctx.deployer, token: ctx.address("TOKEN") };
              await ctx.send({ to: ctx.address("TOKEN"), data: "0xdeadbeef", value: 0n });
            },
          },
        ],
        verify: noop,
      }),
    };
    const { chain, artifacts, journal, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));

    await runProtocols(["token"], registry, deps);

    expect(seen.deployer).toBe(chain.account);
    expect(seen.token).toBe("0x0000000000000000000000000000000000000001");
    expect(chain.sent[1]).toMatchObject({ to: seen.token, data: "0xdeadbeef", gas: 120_000n });
    expect(journal.file.protocols.token.stepsDone).toEqual(["make", "poke"]);
  });

  it("throws and does not journal a step whose transaction reverts", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { chain, artifacts, journal, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1) }));
    chain.revertNext = true;

    await expect(runProtocols(["token"], registry, deps)).rejects.toThrow(/token\/s0: transaction .* reverted/);
    expect(journal.file.protocols.token?.stepsDone ?? []).toEqual([]);
  });

  it("rejects an artifact that is not a contract creation", async () => {
    const registry: Registry = { token: create("token", [{ tx: hash(1), as: "TOKEN" }]) };
    const { artifacts, deps } = setup(registry);
    artifacts.write("token", makeArtifact({ hash: hash(1), contractAddress: null }));

    await expect(runProtocols(["token"], registry, deps)).rejects.toThrow(/is not a contract creation/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/engine.test.ts
```

Expected: FAIL, cannot resolve `../src/engine`.

- [ ] **Step 3: Implement**

`src/protocols/define.ts`:

```ts
import type { Protocol } from "../types";

/** Identity helper that type-checks a protocol manifest. */
export function defineProtocol(protocol: Protocol): Protocol {
  return protocol;
}
```

`src/engine.ts`:

```ts
import { AddressMap } from "./address-map";
import { applyArgWords, splitCreation } from "./creation";
import { submit } from "./send";
import type {
  Address,
  ArtifactStore,
  ChainPort,
  CreateStep,
  Hex,
  JournalFile,
  JournalStore,
  Protocol,
  ProtocolState,
  StepContext,
} from "./types";

export type Registry = Record<string, Protocol>;

export interface EngineDeps {
  chain: ChainPort;
  artifacts: ArtifactStore;
  journal: JournalStore;
  log: (message: string) => void;
}

/** Requested protocols plus their dependencies, dependencies first, each once. */
export function resolveOrder(names: string[], registry: Registry): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string, path: string[]): void => {
    if (!Object.hasOwn(registry, name)) throw new Error(`unknown protocol "${name}"`);
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`dependency cycle: ${[...path, name].join(" -> ")}`);
    visiting.add(name);
    for (const dependency of registry[name].dependsOn) visit(dependency, [...path, name]);
    visiting.delete(name);
    done.add(name);
    order.push(name);
  };

  for (const name of names) visit(name, []);
  return order;
}

/** True when a recorded contract has no code on the chain, e.g. after a devnet restart. */
async function isStale(state: ProtocolState, chain: ChainPort): Promise<boolean> {
  for (const address of Object.values(state.contracts)) {
    if ((await chain.getCode(address)) === "0x") return true;
  }
  return false;
}

async function runCreate(
  protocolName: string,
  step: CreateStep,
  state: ProtocolState,
  map: AddressMap,
  deps: EngineDeps
): Promise<void> {
  const label = `${protocolName}/${step.id}`;
  const artifact = deps.artifacts.read(protocolName, step.tx);
  if (!artifact.contractAddress) {
    throw new Error(`${label}: artifact ${step.tx} is not a contract creation`);
  }
  const { initCode, args } = splitCreation(artifact);
  const rewritten = map.rewrite(applyArgWords(args, step.argWords));
  for (const address of rewritten.unmapped) {
    deps.log(`${label}: warning: constructor argument ${address} looks like an address but has no devnet mapping`);
  }
  const data = `${initCode}${rewritten.data.slice(2)}` as Hex;

  const result = await submit(
    deps.chain,
    { to: null, data, value: BigInt(artifact.value) },
    label,
    deps.log
  );
  if (!result.contractAddress) throw new Error(`${label}: receipt has no contract address`);

  state.contracts[step.as] = result.contractAddress;
  state.mainnetToDevnet[artifact.contractAddress.toLowerCase()] = result.contractAddress;
  map.set(artifact.contractAddress, result.contractAddress);
  deps.log(`${label}: ${step.as} -> ${result.contractAddress}`);
}

/**
 * Deploys the requested protocols (dependencies first) by replaying their
 * manifests. Progress is journaled after every step, so an interrupted run
 * resumes where it stopped and a restarted chain (recorded contracts gone)
 * starts over.
 */
export async function runProtocols(
  names: string[],
  registry: Registry,
  deps: EngineDeps,
  options: { force?: boolean } = {}
): Promise<JournalFile> {
  const { chain, log } = deps;
  const order = resolveOrder(names, registry);
  const requested = new Set(names);
  const journal = deps.journal.load(chain.chainId);

  for (const name of order) {
    const protocol = registry[name];
    let state: ProtocolState | undefined = journal.protocols[name];

    if (state && options.force && requested.has(name)) {
      log(`${name}: --force, deploying a fresh copy`);
      state = undefined;
    }
    if (state && (await isStale(state, chain))) {
      log(`${name}: recorded contracts are missing from this chain (restarted?), starting over`);
      state = undefined;
    }
    if (!state) state = { stepsDone: [], contracts: {}, mainnetToDevnet: {} };
    journal.protocols[name] = state;

    if (state.stepsDone.length === protocol.steps.length) {
      log(`${name}: already deployed`);
      continue;
    }

    const earlier = order.slice(0, order.indexOf(name));
    const map = new AddressMap();
    for (const other of earlier) {
      for (const [mainnet, devnet] of Object.entries(journal.protocols[other]?.mainnetToDevnet ?? {})) {
        map.set(mainnet as Address, devnet);
      }
    }
    for (const [mainnet, devnet] of Object.entries(state.mainnetToDevnet)) {
      map.set(mainnet as Address, devnet);
    }

    const lookup = (contractName: string): Address => {
      for (const scope of [name, ...[...earlier].reverse()]) {
        const found = journal.protocols[scope]?.contracts[contractName];
        if (found) return found;
      }
      throw new Error(`${name}: no deployed contract named "${contractName}"`);
    };

    for (const step of protocol.steps) {
      if (state.stepsDone.includes(step.id)) continue;
      if (step.kind === "create") {
        await runCreate(name, step, state, map, deps);
      } else {
        const label = `${name}/${step.id}`;
        const context: StepContext = {
          deployer: chain.account,
          address: lookup,
          send: (tx) => submit(chain, tx, label, log),
          read: (address, abi, functionName, args) => chain.read(address, abi, functionName, args),
        };
        await step.run(context);
        log(`${label}: done`);
      }
      state.stepsDone.push(step.id);
      deps.journal.save(journal);
    }
    log(`${name}: deployed`);
  }

  deps.journal.save(journal);
  return journal;
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
bunx vitest run test/engine.test.ts && bunx tsc --noEmit
```

Expected: 14 tests pass, `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/protocols/define.ts deploy/predeploy/src/engine.ts deploy/predeploy/test/engine.test.ts
git commit -m "feat(predeploy): replay engine with dependencies, resume, stale detection and force" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Etherscan client and the `fetch` step

**Files:**
- Create: `deploy/predeploy/src/etherscan.ts`, `src/fetch.ts`, `test/etherscan.test.ts`, `test/fetch.test.ts`

**Interfaces:**
- Consumes: `splitCreation` (Task 2), `defineProtocol` (Task 5), `ETHERSCAN_MIN_INTERVAL_MS` (Task 1), fakes (Task 3).
- Produces: `EtherscanClient(apiKey, options?)` implementing `EtherscanApi` (`getTransaction`, `getReceiptContractAddress`, `getSourceMeta`, `getRuntimeCode`, `getContractCreation`); `fetchProtocolArtifacts(protocol, api, store, log): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`test/etherscan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EtherscanClient } from "../src/etherscan";
import type { Address, Hex } from "../src/types";

interface Call {
  url: URL;
}

function harness(bodies: unknown[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const fetchFn = (async (input: string | URL) => {
    calls.push({ url: new URL(String(input)) });
    const body = bodies[calls.length - 1];
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  const client = new EtherscanClient("KEY123", {
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    minIntervalMs: 250,
  });
  return { client, calls, sleeps };
}

const ADDRESS = "0x514910771AF9Ca656af840dff83E8264EcF986CA" as Address;
const TX = ("0x" + "11".repeat(32)) as Hex;

describe("EtherscanClient", () => {
  it("calls the V2 API for mainnet with the key and parses source metadata", async () => {
    const { client, calls } = harness([
      {
        status: "1",
        message: "OK",
        result: [{ ContractName: "LinkToken", CompilerVersion: "v0.4.16", ConstructorArguments: "" }],
      },
    ]);

    const meta = await client.getSourceMeta(ADDRESS);

    expect(meta).toEqual({ contractName: "LinkToken", compilerVersion: "v0.4.16", constructorArguments: "0x" });
    const params = calls[0].url.searchParams;
    expect(calls[0].url.origin + calls[0].url.pathname).toBe("https://api.etherscan.io/v2/api");
    expect(params.get("chainid")).toBe("1");
    expect(params.get("module")).toBe("contract");
    expect(params.get("action")).toBe("getsourcecode");
    expect(params.get("address")).toBe(ADDRESS);
    expect(params.get("apikey")).toBe("KEY123");
  });

  it("rejects unverified contracts", async () => {
    const { client } = harness([
      { status: "1", message: "OK", result: [{ ContractName: "", CompilerVersion: "", ConstructorArguments: "" }] },
    ]);
    await expect(client.getSourceMeta(ADDRESS)).rejects.toThrow(/not verified/);
  });

  it("retries after a rate-limit response, sleeping first", async () => {
    const { client, calls, sleeps } = harness([
      { status: "0", message: "NOTOK", result: "Max rate limit reached" },
      { jsonrpc: "2.0", id: 1, result: "0x6080" },
    ]);

    const code = await client.getRuntimeCode(ADDRESS);

    expect(code).toBe("0x6080");
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(1000);
  });

  it("spaces consecutive calls by the minimum interval", async () => {
    const { client, sleeps } = harness([
      { jsonrpc: "2.0", id: 1, result: "0x60" },
      { jsonrpc: "2.0", id: 1, result: "0x61" },
    ]);
    await client.getRuntimeCode(ADDRESS);
    await client.getRuntimeCode(ADDRESS);
    expect(sleeps).toEqual([250]);
  });

  it("fails on other API errors, with the reason", async () => {
    const { client } = harness([{ status: "0", message: "NOTOK", result: "Invalid API Key" }]);
    await expect(client.getRuntimeCode(ADDRESS)).rejects.toThrow(/Invalid API Key/);
  });

  it("parses a transaction, converting the block number", async () => {
    const { client } = harness([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { from: "0xf5", to: null, input: "0x6080", value: "0x0", blockNumber: "0x105b8b" },
      },
    ]);
    const tx = await client.getTransaction(TX);
    expect(tx).toMatchObject({ hash: TX, to: null, input: "0x6080", value: "0x0", blockNumber: 1072011 });
  });

  it("throws when a transaction is not found", async () => {
    const { client } = harness([{ jsonrpc: "2.0", id: 1, result: null }]);
    await expect(client.getTransaction(TX)).rejects.toThrow(/not found/);
  });

  it("parses a creation record, mapping an empty factory to null", async () => {
    const { client } = harness([
      {
        status: "1",
        message: "OK",
        result: [
          {
            contractAddress: ADDRESS,
            contractCreator: "0xf5",
            txHash: TX,
            blockNumber: "4281611",
            contractFactory: "",
          },
        ],
      },
    ]);
    const info = await client.getContractCreation(ADDRESS);
    expect(info).toMatchObject({ txHash: TX, blockNumber: 4281611, contractFactory: null });
  });
});
```

`test/fetch.test.ts`:

```ts
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { EtherscanApi } from "../src/etherscan";
import { fetchProtocolArtifacts } from "../src/fetch";
import { defineProtocol } from "../src/protocols/define";
import type { Address, Hex } from "../src/types";
import { MemoryArtifacts, hash } from "./fakes";

const CONTRACT = "0x514910771AF9Ca656af840dff83E8264EcF986CA" as Address;
const ARGS = `0x${"00".repeat(31)}05` as Hex;
const RUNTIME = "0x6080604052" as Hex;

function fakeApi(overrides: Partial<EtherscanApi> = {}): EtherscanApi {
  return {
    getTransaction: async (h) => ({
      hash: h,
      from: "0xf55037738604FDdFC4043D12F25124E94D7D1780" as Address,
      to: null,
      input: `0x6001${ARGS.slice(2)}` as Hex,
      value: "0x0" as Hex,
      blockNumber: 42,
    }),
    getReceiptContractAddress: async () => CONTRACT,
    getSourceMeta: async () => ({ contractName: "LinkToken", compilerVersion: "v0.4.16", constructorArguments: ARGS }),
    getRuntimeCode: async () => RUNTIME,
    getContractCreation: async () => {
      throw new Error("unused");
    },
    ...overrides,
  };
}

const protocol = defineProtocol({
  name: "link",
  dependsOn: [],
  steps: [
    { id: "token", kind: "create", tx: hash(1), as: "LINK" },
    { id: "noop", kind: "custom", run: async () => {} },
  ],
  verify: async () => [],
});

describe("fetchProtocolArtifacts", () => {
  it("stores one artifact per create step and skips custom steps", async () => {
    const store = new MemoryArtifacts();
    const logs: string[] = [];

    await fetchProtocolArtifacts(protocol, fakeApi(), store, (m) => logs.push(m));

    const artifact = store.read("link", hash(1));
    expect(artifact).toMatchObject({
      hash: hash(1),
      to: null,
      blockNumber: 42,
      contractAddress: CONTRACT,
      constructorArgs: ARGS,
      contractName: "LinkToken",
      compiler: "v0.4.16",
      runtimeCodeHash: keccak256(RUNTIME),
    });
    expect(logs[0]).toMatch(/link\/token: fetched LinkToken/);
  });

  it("records a null runtime hash for a contract with no code", async () => {
    const store = new MemoryArtifacts();
    await fetchProtocolArtifacts(protocol, fakeApi({ getRuntimeCode: async () => "0x" }), store, () => {});
    expect(store.read("link", hash(1)).runtimeCodeHash).toBeNull();
  });

  it("rejects a transaction that is not a direct creation", async () => {
    const api = fakeApi({
      getTransaction: async (h) => ({
        hash: h,
        from: "0xf5" as Address,
        to: "0x48E516B34A1274f49457b9C6182097796D59E248" as Address,
        input: "0x",
        value: "0x0" as Hex,
        blockNumber: 1,
      }),
    });
    await expect(fetchProtocolArtifacts(protocol, api, new MemoryArtifacts(), () => {})).rejects.toThrow(
      /not a direct contract creation/
    );
  });

  it("rejects constructor arguments that are not a suffix of the input", async () => {
    const api = fakeApi({
      getSourceMeta: async () => ({ contractName: "X", compilerVersion: "v", constructorArguments: "0xff" as Hex }),
    });
    await expect(fetchProtocolArtifacts(protocol, api, new MemoryArtifacts(), () => {})).rejects.toThrow(/suffix/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/etherscan.test.ts test/fetch.test.ts
```

Expected: FAIL, cannot resolve `../src/etherscan` and `../src/fetch`.

- [ ] **Step 3: Implement**

`src/etherscan.ts`:

```ts
import { ETHERSCAN_MIN_INTERVAL_MS } from "./config";
import type { Address, Hex } from "./types";

export interface RawTx {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  /** Hex quantity. */
  value: Hex;
  blockNumber: number;
}

export interface SourceMeta {
  contractName: string;
  compilerVersion: string;
  /** "0x" when the constructor takes no arguments. */
  constructorArguments: Hex;
}

export interface CreationInfo {
  contractAddress: Address;
  contractCreator: Address;
  txHash: Hex;
  blockNumber: number;
  /** Set when the contract was created by another contract (a factory). */
  contractFactory: Address | null;
}

/** The parts of Etherscan that `fetch` uses. Tests substitute a fake. */
export interface EtherscanApi {
  getTransaction(hash: Hex): Promise<RawTx>;
  getReceiptContractAddress(hash: Hex): Promise<Address | null>;
  getSourceMeta(address: Address): Promise<SourceMeta>;
  getRuntimeCode(address: Address): Promise<Hex>;
  getContractCreation(address: Address): Promise<CreationInfo>;
}

export interface EtherscanOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
  maxRetries?: number;
  baseUrl?: string;
}

/** Etherscan API V2, Ethereum mainnet (chainid=1). Rate-limited, retries on "rate limit". */
export class EtherscanClient implements EtherscanApi {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseUrl: string;
  private lastCall = -Infinity;

  constructor(private readonly apiKey: string, options: EtherscanOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? ETHERSCAN_MIN_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? 4;
    this.baseUrl = options.baseUrl ?? "https://api.etherscan.io/v2/api";
  }

  private async call(params: Record<string, string>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCall + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCall = this.now();

      const query = new URLSearchParams({ chainid: "1", ...params, apikey: this.apiKey });
      const response = await this.fetchFn(`${this.baseUrl}?${query}`);
      if (!response.ok) throw new Error(`Etherscan HTTP ${response.status}`);
      const body = (await response.json()) as {
        status?: string;
        message?: string;
        result?: unknown;
        error?: { message?: string };
      };

      if (typeof body.result === "string" && /rate limit/i.test(body.result)) {
        if (attempt >= this.maxRetries) {
          throw new Error(`Etherscan rate limit persisted after ${attempt + 1} attempts`);
        }
        await this.sleep(1000 * (attempt + 1));
        continue;
      }
      if (body.error) throw new Error(`Etherscan error: ${body.error.message ?? "unknown"}`);
      if (body.status === "0") {
        throw new Error(`Etherscan ${params.action} failed: ${body.message}: ${String(body.result)}`);
      }
      return body.result;
    }
  }

  async getTransaction(hash: Hex): Promise<RawTx> {
    const result = (await this.call({
      module: "proxy",
      action: "eth_getTransactionByHash",
      txhash: hash,
    })) as { from: Address; to: Address | null; input: Hex; value: Hex; blockNumber: Hex } | null;
    if (!result) throw new Error(`Etherscan: transaction ${hash} not found`);
    return {
      hash,
      from: result.from,
      to: result.to,
      input: result.input,
      value: result.value,
      blockNumber: Number(BigInt(result.blockNumber)),
    };
  }

  async getReceiptContractAddress(hash: Hex): Promise<Address | null> {
    const result = (await this.call({
      module: "proxy",
      action: "eth_getTransactionReceipt",
      txhash: hash,
    })) as { contractAddress: Address | null } | null;
    if (!result) throw new Error(`Etherscan: receipt for ${hash} not found`);
    return result.contractAddress ?? null;
  }

  async getSourceMeta(address: Address): Promise<SourceMeta> {
    const result = (await this.call({
      module: "contract",
      action: "getsourcecode",
      address,
    })) as Array<{ ContractName: string; CompilerVersion: string; ConstructorArguments: string }>;
    const entry = result?.[0];
    if (!entry || entry.ContractName === "") {
      throw new Error(`Etherscan: source for ${address} is not verified`);
    }
    return {
      contractName: entry.ContractName,
      compilerVersion: entry.CompilerVersion,
      constructorArguments: `0x${entry.ConstructorArguments}` as Hex,
    };
  }

  async getRuntimeCode(address: Address): Promise<Hex> {
    return (await this.call({
      module: "proxy",
      action: "eth_getCode",
      address,
      tag: "latest",
    })) as Hex;
  }

  async getContractCreation(address: Address): Promise<CreationInfo> {
    const result = (await this.call({
      module: "contract",
      action: "getcontractcreation",
      contractaddresses: address,
    })) as Array<{
      contractAddress: Address;
      contractCreator: Address;
      txHash: Hex;
      blockNumber: string;
      contractFactory: string;
    }>;
    const entry = result?.[0];
    if (!entry) throw new Error(`Etherscan: no creation record for ${address}`);
    return {
      contractAddress: entry.contractAddress,
      contractCreator: entry.contractCreator,
      txHash: entry.txHash,
      blockNumber: Number(entry.blockNumber),
      contractFactory: entry.contractFactory ? (entry.contractFactory as Address) : null,
    };
  }
}
```

`src/fetch.ts`:

```ts
import { keccak256 } from "viem";
import { splitCreation } from "./creation";
import type { EtherscanApi } from "./etherscan";
import type { ArtifactStore, Hex, Protocol } from "./types";

/**
 * Downloads every `create` step's mainnet transaction into the artifact
 * store: the creation input, its constructor arguments, the compiler, and the
 * hash of the mainnet runtime code (used later as an informational check).
 */
export async function fetchProtocolArtifacts(
  protocol: Protocol,
  api: EtherscanApi,
  store: ArtifactStore,
  log: (message: string) => void
): Promise<void> {
  for (const step of protocol.steps) {
    if (step.kind !== "create") continue;
    const label = `${protocol.name}/${step.id}`;

    const tx = await api.getTransaction(step.tx);
    if (tx.to !== null) {
      throw new Error(
        `${label}: ${step.tx} is not a direct contract creation (it calls ${tx.to}); factory-created contracts need a different step kind`
      );
    }
    const contractAddress = await api.getReceiptContractAddress(step.tx);
    if (!contractAddress) throw new Error(`${label}: ${step.tx} created no contract`);

    const source = await api.getSourceMeta(contractAddress);
    const runtime = await api.getRuntimeCode(contractAddress);
    // Throws if the arguments Etherscan reports are not a suffix of the input.
    splitCreation({ input: tx.input, constructorArgs: source.constructorArguments });

    store.write(protocol.name, {
      hash: step.tx,
      from: tx.from,
      to: null,
      value: tx.value,
      blockNumber: tx.blockNumber,
      input: tx.input,
      contractAddress,
      constructorArgs: source.constructorArguments,
      contractName: source.contractName,
      compiler: source.compilerVersion,
      runtimeCodeHash: runtime === "0x" ? null : (keccak256(runtime as Hex) as Hex),
    });
    log(`${label}: fetched ${source.contractName} (${source.compilerVersion}) at ${contractAddress}`);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
bunx vitest run test/etherscan.test.ts test/fetch.test.ts && bunx tsc --noEmit
```

Expected: 12 tests pass (8 + 4), `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/etherscan.ts deploy/predeploy/src/fetch.ts deploy/predeploy/test/etherscan.test.ts deploy/predeploy/test/fetch.test.ts
git commit -m "feat(predeploy): rate-limited Etherscan V2 client and artifact fetching" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Verification

**Files:**
- Create: `deploy/predeploy/src/verify.ts`, `test/verify.test.ts`

**Interfaces:**
- Consumes: `Registry` (Task 5), `defineProtocol` (Task 5), fakes (Task 3).
- Produces: `equalCheck(name, actual, expected): CheckResult` (compares as lower-case strings, so `6n`, `6` and `"6"` are equal); `verifyProtocols(names, registry, { chain, artifacts, journal }): Promise<VerifyReport[]>`; `formatReport(report): string`; types `VerifyReport`, `CodeHashInfo`, `VerifyDeps`.

- [ ] **Step 1: Write the failing test**

`test/verify.test.ts`:

```ts
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { Registry } from "../src/engine";
import { defineProtocol } from "../src/protocols/define";
import type { Address, Hex } from "../src/types";
import { equalCheck, formatReport, verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal, hash, makeArtifact } from "./fakes";

const TOKEN = "0x0000000000000000000000000000000000000001" as Address;

const protocol = defineProtocol({
  name: "token",
  dependsOn: [],
  steps: [{ id: "make", kind: "create", tx: hash(1), as: "TOKEN" }],
  verify: async (ctx) => [equalCheck("symbol", await ctx.read(ctx.address("TOKEN"), [], "symbol"), "TKN")],
});
const registry: Registry = { token: protocol };

function deployed() {
  const chain = new FakeChain();
  const artifacts = new MemoryArtifacts();
  const journal = new MemoryJournal();
  chain.codes.set(TOKEN.toLowerCase(), "0x6001");
  journal.file.protocols.token = { stepsDone: ["make"], contracts: { TOKEN }, mainnetToDevnet: {} };
  return { chain, artifacts, journal };
}

describe("equalCheck", () => {
  it("treats bigint, number and string forms as equal, and addresses case-insensitively", () => {
    expect(equalCheck("n", 6n, 6).ok).toBe(true);
    expect(equalCheck("a", "0xABC", "0xabc").ok).toBe(true);
  });
  it("explains a mismatch", () => {
    expect(equalCheck("n", 5n, 6)).toEqual({ name: "n", ok: false, detail: "expected 6, got 5" });
  });
});

describe("verifyProtocols", () => {
  it("passes when contracts have code and the protocol's checks pass", async () => {
    const { chain, artifacts, journal } = deployed();
    chain.setRead(TOKEN, "symbol", "TKN");

    const [report] = await verifyProtocols(["token"], registry, { chain, artifacts, journal });

    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(["TOKEN has code", "symbol"]);
  });

  it("fails when a protocol check fails", async () => {
    const { chain, artifacts, journal } = deployed();
    chain.setRead(TOKEN, "symbol", "OOPS");

    const [report] = await verifyProtocols(["token"], registry, { chain, artifacts, journal });

    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ name: "symbol", ok: false, detail: "expected TKN, got OOPS" });
  });

  it("turns a throwing check into a failed result instead of crashing", async () => {
    const { chain, artifacts, journal } = deployed(); // no canned read, so chain.read throws

    const [report] = await verifyProtocols(["token"], registry, { chain, artifacts, journal });

    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ name: "verify", ok: false });
    expect(report.checks.at(-1)?.detail).toMatch(/^threw: FakeChain: no canned read/);
  });

  it("reports a protocol that is not deployed", async () => {
    const chain = new FakeChain();

    const [report] = await verifyProtocols(["token"], registry, {
      chain,
      artifacts: new MemoryArtifacts(),
      journal: new MemoryJournal(),
    });

    expect(report.ok).toBe(false);
    expect(report.checks[0].detail).toMatch(/run: bun run predeploy run token/);
  });

  it("fails when a recorded contract has no code", async () => {
    const { chain, artifacts, journal } = deployed();
    chain.codes.clear();
    chain.setRead(TOKEN, "symbol", "TKN");

    const [report] = await verifyProtocols(["token"], registry, { chain, artifacts, journal });

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ name: "TOKEN has code", ok: false });
  });

  it("reports runtime code identical to, different from, or unknown against mainnet, without failing", async () => {
    const same = deployed();
    same.chain.setRead(TOKEN, "symbol", "TKN");
    same.artifacts.write("token", makeArtifact({ hash: hash(1), runtimeCodeHash: keccak256("0x6001" as Hex) }));
    const differs = deployed();
    differs.chain.setRead(TOKEN, "symbol", "TKN");
    differs.artifacts.write("token", makeArtifact({ hash: hash(1), runtimeCodeHash: keccak256("0x6002" as Hex) }));
    const unknown = deployed();
    unknown.chain.setRead(TOKEN, "symbol", "TKN"); // no artifact stored

    const [a] = await verifyProtocols(["token"], registry, same);
    const [b] = await verifyProtocols(["token"], registry, differs);
    const [c] = await verifyProtocols(["token"], registry, unknown);

    expect(a.codeHashes).toEqual([{ contract: "TOKEN", status: "identical" }]);
    expect(b.codeHashes).toEqual([{ contract: "TOKEN", status: "differs" }]);
    expect(c.codeHashes).toEqual([{ contract: "TOKEN", status: "unknown" }]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
  });

  it("rejects unknown protocols", async () => {
    const { chain, artifacts, journal } = deployed();
    await expect(verifyProtocols(["nope"], registry, { chain, artifacts, journal })).rejects.toThrow(
      /unknown protocol "nope"/
    );
  });
});

describe("formatReport", () => {
  it("prints PASS/FAIL, each check, and code-hash info", () => {
    const text = formatReport({
      protocol: "token",
      ok: false,
      checks: [
        { name: "a", ok: true, detail: "1" },
        { name: "b", ok: false, detail: "expected 2, got 3" },
      ],
      codeHashes: [{ contract: "TOKEN", status: "differs" }],
    });
    expect(text).toContain("FAIL token");
    expect(text).toContain("ok   a: 1");
    expect(text).toContain("FAIL b: expected 2, got 3");
    expect(text).toContain("info TOKEN: runtime code differs from mainnet");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/verify.test.ts
```

Expected: FAIL, cannot resolve `../src/verify`.

- [ ] **Step 3: Implement**

`src/verify.ts`:

```ts
import { keccak256 } from "viem";
import type { Registry } from "./engine";
import type { Address, ArtifactStore, ChainPort, CheckResult, Hex, JournalStore } from "./types";

export interface CodeHashInfo {
  contract: string;
  /** "unknown" when no mainnet hash was fetched. */
  status: "identical" | "differs" | "unknown";
}

export interface VerifyReport {
  protocol: string;
  ok: boolean;
  checks: CheckResult[];
  codeHashes: CodeHashInfo[];
}

export interface VerifyDeps {
  chain: ChainPort;
  artifacts: ArtifactStore;
  journal: JournalStore;
}

/** Compares as lower-case strings, so bigint 6n equals number 6 equals "6", and addresses ignore case. */
export function equalCheck(name: string, actual: unknown, expected: unknown): CheckResult {
  const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
  return { name, ok, detail: ok ? String(actual) : `expected ${String(expected)}, got ${String(actual)}` };
}

/**
 * Runs each protocol's read-only checks against the chain, plus two generic
 * ones: every recorded contract has code, and its runtime code is compared
 * with mainnet's. A code-hash difference is reported but never fails a run:
 * immutables and baked-in arguments legitimately change the runtime code.
 */
export async function verifyProtocols(
  names: string[],
  registry: Registry,
  deps: VerifyDeps
): Promise<VerifyReport[]> {
  const { chain } = deps;
  const journal = deps.journal.load(chain.chainId);
  const reports: VerifyReport[] = [];

  for (const name of names) {
    if (!Object.hasOwn(registry, name)) throw new Error(`unknown protocol "${name}"`);
    const protocol = registry[name];
    const state = journal.protocols[name];

    if (!state || state.stepsDone.length !== protocol.steps.length) {
      reports.push({
        protocol: name,
        ok: false,
        checks: [{ name: "deployed", ok: false, detail: `not fully deployed; run: bun run predeploy run ${name}` }],
        codeHashes: [],
      });
      continue;
    }

    const lookup = (contractName: string): Address => {
      const scopes = [state, ...Object.values(journal.protocols)];
      for (const scope of scopes) {
        const found = scope.contracts[contractName];
        if (found) return found;
      }
      throw new Error(`${name}: no deployed contract named "${contractName}"`);
    };

    const checks: CheckResult[] = [];
    for (const [contractName, address] of Object.entries(state.contracts)) {
      const code = await chain.getCode(address);
      checks.push({ name: `${contractName} has code`, ok: code !== "0x", detail: address });
    }

    try {
      checks.push(
        ...(await protocol.verify({
          deployer: chain.account,
          address: lookup,
          read: (address, abi, functionName, args) => chain.read(address, abi, functionName, args),
        }))
      );
    } catch (error) {
      checks.push({
        name: "verify",
        ok: false,
        detail: `threw: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      });
    }

    const codeHashes: CodeHashInfo[] = [];
    for (const step of protocol.steps) {
      if (step.kind !== "create") continue;
      const address = state.contracts[step.as];
      let mainnetHash: Hex | null = null;
      try {
        mainnetHash = deps.artifacts.read(name, step.tx).runtimeCodeHash;
      } catch {
        mainnetHash = null;
      }
      if (!address || !mainnetHash) {
        codeHashes.push({ contract: step.as, status: "unknown" });
        continue;
      }
      const local = keccak256((await chain.getCode(address)) as Hex);
      codeHashes.push({ contract: step.as, status: local === mainnetHash ? "identical" : "differs" });
    }

    reports.push({ protocol: name, ok: checks.every((c) => c.ok), checks, codeHashes });
  }
  return reports;
}

export function formatReport(report: VerifyReport): string {
  const lines = [`${report.ok ? "PASS" : "FAIL"} ${report.protocol}`];
  for (const check of report.checks) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
  }
  for (const info of report.codeHashes) {
    const text =
      info.status === "identical"
        ? "runtime code identical to mainnet"
        : info.status === "differs"
          ? "runtime code differs from mainnet (expected with immutables or baked-in arguments)"
          : "no mainnet code hash to compare";
    lines.push(`  info ${info.contract}: ${text}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
bunx vitest run test/verify.test.ts && bunx tsc --noEmit
```

Expected: 10 tests pass, `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/verify.ts deploy/predeploy/test/verify.test.ts
git commit -m "feat(predeploy): read-only verification with mainnet code-hash comparison" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Chain adapter, command line and operator README

**Files:**
- Create: `deploy/predeploy/src/chain-viem.ts`, `src/args.ts`, `src/cli.ts`, `test/args.test.ts`, `README.md`
- Create: `deploy/predeploy/src/protocols/index.ts` (empty registry for now)

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: `createViemChain(rpcUrl, privateKey): Promise<ChainPort>`; `parseArgs(argv): ParsedArgs { command, names, all, force }`; `USAGE`; the `registry` export from `src/protocols/index.ts`; the CLI commands `list`, `creation`, `fetch`, `fund`, `run`, `verify`.

- [ ] **Step 1: Write the failing test**

`test/args.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";

describe("parseArgs", () => {
  it("parses a command with protocol names", () => {
    expect(parseArgs(["run", "link", "usdt"])).toEqual({
      command: "run",
      names: ["link", "usdt"],
      all: false,
      force: false,
    });
  });

  it("parses --all and --force", () => {
    expect(parseArgs(["run", "--all", "--force"])).toMatchObject({ all: true, force: true });
  });

  it("accepts commands that need no protocols", () => {
    expect(parseArgs(["list"]).command).toBe("list");
    expect(parseArgs(["fund"]).command).toBe("fund");
  });

  it("requires protocols or --all for fetch, run and verify", () => {
    for (const command of ["fetch", "run", "verify"]) {
      expect(() => parseArgs([command])).toThrow(/name at least one protocol/);
    }
  });

  it("rejects --all together with names", () => {
    expect(() => parseArgs(["run", "link", "--all"])).toThrow(/either --all or protocol names/);
  });

  it("rejects --force outside run", () => {
    expect(() => parseArgs(["verify", "link", "--force"])).toThrow(/only applies to `run`/);
  });

  it("requires exactly one address for creation", () => {
    expect(parseArgs(["creation", "0xabc"]).names).toEqual(["0xabc"]);
    expect(() => parseArgs(["creation"])).toThrow(/exactly one contract address/);
  });

  it("rejects unknown commands and flags with the usage text", () => {
    expect(() => parseArgs([])).toThrow(/usage: bun run predeploy/);
    expect(() => parseArgs(["deploy"])).toThrow(/usage: bun run predeploy/);
    expect(() => parseArgs(["run", "link", "--wat"])).toThrow(/unknown flag --wat/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/args.test.ts
```

Expected: FAIL, cannot resolve `../src/args`.

- [ ] **Step 3: Implement**

`src/args.ts`:

```ts
export type Command = "fetch" | "fund" | "run" | "verify" | "list" | "creation";

const COMMANDS: readonly Command[] = ["fetch", "fund", "run", "verify", "list", "creation"];
const NEEDS_PROTOCOLS: readonly Command[] = ["fetch", "run", "verify"];

export interface ParsedArgs {
  command: Command;
  /** Protocol names, or for `creation` the contract address. */
  names: string[];
  all: boolean;
  force: boolean;
}

export const USAGE = `usage: bun run predeploy <command> [protocols... | --all] [--force]

commands:
  list                         show protocols, dependencies and recorded addresses
  fetch <protocols|--all>      download mainnet transactions from Etherscan (needs ETHERSCAN_API_KEY)
  fund                         send devnet ETH from the shared key to the deployer
  run <protocols|--all>        replay the fetched transactions onto the devnet (--force: deploy a fresh copy)
  verify <protocols|--all>     run read-only checks against the devnet
  creation <address>           print a mainnet contract's creation transaction (needs ETHERSCAN_API_KEY)

environment:
  PREDEPLOY_RPC_URL            devnet RPC (default https://altmempool.forshtat.com)
  PREDEPLOY_DEPLOYER_KEY       deployer private key (default: the published throwaway key)
  ETHERSCAN_API_KEY            only for fetch and creation`;

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command as Command)) throw new Error(USAGE);

  let all = false;
  let force = false;
  const names: string[] = [];
  for (const arg of rest) {
    if (arg === "--all") all = true;
    else if (arg === "--force") force = true;
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}\n\n${USAGE}`);
    else names.push(arg);
  }

  if (all && names.length > 0) throw new Error("use either --all or protocol names, not both");
  if (force && command !== "run") throw new Error("--force only applies to `run`");
  if (NEEDS_PROTOCOLS.includes(command as Command) && !all && names.length === 0) {
    throw new Error(`${command}: name at least one protocol, or pass --all`);
  }
  if (command === "creation" && names.length !== 1) {
    throw new Error("creation: pass exactly one contract address");
  }
  return { command: command as Command, names, all, force };
}
```

`src/chain-viem.ts` (the real chain access; it has no unit test, Step 5 exercises it against the live devnet):

```ts
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainPort, Hex } from "./types";

/** Real chain access through viem, sending legacy transactions signed by `privateKey`. */
export async function createViemChain(rpcUrl: string, privateKey: Hex): Promise<ChainPort> {
  const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
  const chain = defineChain({
    id: chainId,
    name: "devnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  return {
    chainId,
    account: account.address,
    getCode: async (address) => (await publicClient.getCode({ address })) ?? "0x",
    getBalance: (address) => publicClient.getBalance({ address }),
    gasPrice: () => publicClient.getGasPrice(),
    blockGasLimit: async () => (await publicClient.getBlock()).gasLimit,
    estimateGas: (tx) =>
      publicClient.estimateGas({
        account: account.address,
        to: tx.to ?? undefined,
        data: tx.data,
        value: tx.value,
      }),
    sendAndWait: async (tx) => {
      const hash = await wallet.sendTransaction({
        type: "legacy",
        to: tx.to ?? undefined,
        data: tx.data,
        value: tx.value,
        gas: tx.gas,
        gasPrice: tx.gasPrice,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: 1_000,
        timeout: 5 * 60_000,
      });
      return {
        hash,
        status: receipt.status,
        contractAddress: receipt.contractAddress ?? null,
        gasUsed: receipt.gasUsed,
      };
    },
    read: (address, abi, functionName, args) =>
      publicClient.readContract({ address, abi, functionName, args } as never),
  };
}
```

`src/protocols/index.ts` (empty for now; Tasks 9-11 add one protocol each):

```ts
import type { Registry } from "../engine";

/** Order matters: `run --all` deploys in this order, and addresses depend on it. */
export const registry: Registry = {};
```

`src/cli.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther } from "viem";
import { parseArgs } from "./args";
import { FileArtifactStore } from "./artifacts";
import { createViemChain } from "./chain-viem";
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_RPC_URL,
  DEPLOYER_KEY,
  FUND_AMOUNT_WEI,
  FUND_MIN_BALANCE_WEI,
  SHARED_DEVNET_KEY,
} from "./config";
import { runProtocols } from "./engine";
import { EtherscanClient } from "./etherscan";
import { fetchProtocolArtifacts } from "./fetch";
import { FileJournalStore } from "./journal";
import { registry } from "./protocols";
import { submit } from "./send";
import type { Address, Hex } from "./types";
import { formatReport, verifyProtocols } from "./verify";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifacts = new FileArtifactStore(path.join(ROOT, "artifacts"));
const journal = new FileJournalStore(path.join(ROOT, "addresses"));
const log = (message: string): void => console.log(message);

const rpcUrl = process.env.PREDEPLOY_RPC_URL ?? DEFAULT_RPC_URL;
const deployerKey = (process.env.PREDEPLOY_DEPLOYER_KEY ?? DEPLOYER_KEY) as Hex;

function etherscan(): EtherscanClient {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error("ETHERSCAN_API_KEY is not set");
  return new EtherscanClient(key);
}

function printAddresses(chainId: number, names: string[]): void {
  const file = journal.load(chainId);
  for (const name of names) {
    for (const [contract, address] of Object.entries(file.protocols[name]?.contracts ?? {})) {
      log(`  ${name}/${contract}: ${address}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const names = args.all ? Object.keys(registry) : args.names;

  switch (args.command) {
    case "list": {
      const recorded = journal.load(DEFAULT_CHAIN_ID);
      for (const [name, protocol] of Object.entries(registry)) {
        const deps = protocol.dependsOn.length ? ` (needs ${protocol.dependsOn.join(", ")})` : "";
        log(`${name}${deps}: ${protocol.steps.map((s) => `${s.id}[${s.kind}]`).join(" -> ")}`);
        for (const [contract, address] of Object.entries(recorded.protocols[name]?.contracts ?? {})) {
          log(`  ${contract}: ${address}`);
        }
      }
      break;
    }
    case "creation": {
      const info = await etherscan().getContractCreation(args.names[0] as Address);
      log(JSON.stringify(info, null, 2));
      break;
    }
    case "fetch": {
      const client = etherscan();
      for (const name of names) {
        if (!Object.hasOwn(registry, name)) throw new Error(`unknown protocol "${name}"`);
        await fetchProtocolArtifacts(registry[name], client, artifacts, log);
      }
      break;
    }
    case "fund": {
      const deployer = await createViemChain(rpcUrl, deployerKey);
      const balance = await deployer.getBalance(deployer.account);
      if (balance >= FUND_MIN_BALANCE_WEI) {
        log(`deployer ${deployer.account} already has ${formatEther(balance)} ETH`);
        break;
      }
      const shared = await createViemChain(rpcUrl, SHARED_DEVNET_KEY);
      await submit(shared, { to: deployer.account, data: "0x", value: FUND_AMOUNT_WEI }, "fund", log);
      log(`funded ${deployer.account} with ${formatEther(FUND_AMOUNT_WEI)} ETH`);
      break;
    }
    case "run": {
      const chain = await createViemChain(rpcUrl, deployerKey);
      log(`deployer ${chain.account} on chain ${chain.chainId} via ${rpcUrl}`);
      await runProtocols(names, registry, { chain, artifacts, journal, log }, { force: args.force });
      log("addresses:");
      printAddresses(chain.chainId, names);
      break;
    }
    case "verify": {
      const chain = await createViemChain(rpcUrl, deployerKey);
      const reports = await verifyProtocols(names, registry, { chain, artifacts, journal });
      for (const report of reports) log(formatReport(report));
      if (reports.some((r) => !r.ok)) process.exit(1);
      break;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests and typecheck**

```bash
bunx vitest run && bunx tsc --noEmit
```

Expected: 72 tests pass in 10 files, and `tsc` prints nothing.

- [ ] **Step 5: Exercise the chain adapter against the live devnet (read-only, plus fund)**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
bun run predeploy list
bun run predeploy fund
```

Expected: `list` prints nothing (empty registry). `fund` prints `deployer 0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0 already has 10 ETH` because it was funded during plan preparation. If the balance is below 2 ETH it instead prints an estimate line and `funded 0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0 with 10 ETH`; that proves the real send path works on ethrex. Either output is a pass.

- [ ] **Step 6: Write the operator README**

`deploy/predeploy/README.md`:

````markdown
# Devnet predeploy

Replays original **mainnet deployment transactions** onto the EIP-8141 devnet, so testers get
the real USDT, USDC, LINK, BAYC, Tornado Cash, Railgun and Uniswap v4 without compiling
anything. Design: `docs/superpowers/specs/2026-09-21-devnet-predeploy-design.md`.

## Commands

Run from the repo root as `bun run predeploy <command>`.

| Command | Needs | Does |
|---|---|---|
| `list` | nothing | Protocols, their steps and dependencies, and recorded devnet addresses. |
| `creation <address>` | `ETHERSCAN_API_KEY` | Prints a mainnet contract's creation transaction. Use it to write a manifest. |
| `fetch <protocols\|--all>` | `ETHERSCAN_API_KEY` | Downloads each manifest transaction into `artifacts/` (committed). |
| `fund` | devnet RPC | Sends 10 ETH from the shared devnet key to the deployer if it holds less than 2 ETH. |
| `run <protocols\|--all>` | devnet RPC | Replays the artifacts onto the devnet. `--force` deploys a fresh copy. |
| `verify <protocols\|--all>` | devnet RPC | Read-only checks. Exits 1 if any check fails. |

Environment: `PREDEPLOY_RPC_URL` (default `https://altmempool.forshtat.com`),
`PREDEPLOY_DEPLOYER_KEY` (default: the published throwaway key in `src/config.ts`),
`ETHERSCAN_API_KEY` (`fetch` and `creation` only; never commit it).

## After a devnet restart

The chain is empty again, so every recorded contract is gone. Run:

```sh
bun run predeploy fund
bun run predeploy run --all
bun run predeploy verify --all
```

The deployer starts at nonce 0 on a fresh chain and `--all` runs in registry order, so the
addresses come out the same as before. `run` detects that the recorded contracts are missing
and starts over.

## Adding a protocol

1. `bun run predeploy creation <mainnet address>` prints the creation transaction hash.
2. Add `src/protocols/<name>.ts` with `defineProtocol({ name, dependsOn, steps, verify })`.
   `create` steps replay a mainnet creation by hash. `custom` steps run TypeScript for setup with
   no mainnet counterpart. `argWords` overrides a static 32-byte constructor argument by index.
3. Register it in `src/protocols/index.ts`. Order matters for `--all`.
4. `bun run predeploy fetch <name>`, commit the new `artifacts/<name>/` files.
5. Write `test/<name>.test.ts`, then `run` and `verify` against the devnet.

## Notes

- The deployer key is published on purpose and owns every deployed contract. Never use it on a
  real network.
- Address rewriting only touches whole 32-byte words in constructor arguments. Contracts that
  embed mainnet addresses in their bytecode need a dedicated step; the engine does not patch code.
- `verify` compares each contract's runtime code hash with mainnet's and reports it as
  information. A difference is expected for contracts with immutables.
````

- [ ] **Step 7: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/chain-viem.ts deploy/predeploy/src/args.ts deploy/predeploy/src/cli.ts deploy/predeploy/src/protocols/index.ts deploy/predeploy/test/args.test.ts deploy/predeploy/README.md
git commit -m "feat(predeploy): viem chain adapter, CLI and operator README" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: LINK

**Files:**
- Create: `deploy/predeploy/src/protocols/link.ts`, `test/link.test.ts`, `test/registry.test.ts`
- Modify: `deploy/predeploy/src/protocols/index.ts`
- Generated and committed: `artifacts/link/0x5488510d….json`, `addresses/1337.json`

**Interfaces:**
- Consumes: `defineProtocol`, `equalCheck`, the engine, `fetch`, `run`, `verify`.
- Produces: registry entry `link`, contract name `LINK`.

LINK is the smallest of the three contracts (5.4M gas) and has no constructor arguments, so it proves the whole path with the least risk. Mainnet creation transaction: `0x5488510df045770efbff57f25d0c6d2c1404d58c1199b21eb8dc5072b22d91d7`.

- [ ] **Step 1: Write the failing tests**

`test/link.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { FakeChain, MemoryArtifacts, MemoryJournal } from "./fakes";

const LINK = "0x0000000000000000000000000000000000000001" as Address;

function deployedLink() {
  const chain = new FakeChain();
  const journal = new MemoryJournal();
  chain.codes.set(LINK.toLowerCase(), "0x6001");
  journal.file.protocols.link = { stepsDone: ["token"], contracts: { LINK }, mainnetToDevnet: {} };
  chain.setRead(LINK, "name", "ChainLink Token");
  chain.setRead(LINK, "symbol", "LINK");
  chain.setRead(LINK, "decimals", 18);
  chain.setRead(LINK, "totalSupply", 10n ** 27n);
  chain.setRead(LINK, "balanceOf", 10n ** 27n);
  return { chain, journal, artifacts: new MemoryArtifacts() };
}

describe("link", () => {
  it("verify passes for the mainnet values", async () => {
    const [report] = await verifyProtocols(["link"], registry, deployedLink());
    expect(report.ok).toBe(true);
  });

  it("verify fails for a wrong supply", async () => {
    const deps = deployedLink();
    deps.chain.setRead(LINK, "totalSupply", 1n);
    const [report] = await verifyProtocols(["link"], registry, deps);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "totalSupply")?.ok).toBe(false);
  });
});
```

`test/registry.test.ts` (for now it expects only `link`; Tasks 10 and 11 extend the expected order):

```ts
import { describe, expect, it } from "vitest";
import { registry } from "../src/protocols";

describe("protocol registry", () => {
  it("has consistent manifests", () => {
    for (const [key, protocol] of Object.entries(registry)) {
      expect(protocol.name).toBe(key);
      for (const dependency of protocol.dependsOn) expect(registry).toHaveProperty(dependency);
      const ids = protocol.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      const names = protocol.steps.flatMap((s) => (s.kind === "create" ? [s.as] : []));
      expect(new Set(names).size).toBe(names.length);
      for (const step of protocol.steps) {
        if (step.kind === "create") expect(step.tx).toMatch(/^0x[0-9a-f]{64}$/);
      }
    }
  });

  it("deploys in the documented order: link, usdt, bayc", () => {
    expect(Object.keys(registry)).toEqual(["link"]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/link.test.ts test/registry.test.ts
```

Expected: FAIL. `link.test.ts` fails because `registry.link` is undefined; `registry.test.ts` fails on the order assertion.

- [ ] **Step 3: Implement the manifest and register it**

`src/protocols/link.ts`:

```ts
import { parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";

const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const TOTAL_SUPPLY = 10n ** 27n; // 1 billion LINK, all minted to the deployer by the constructor

/** Chainlink's LINK (ERC-677) token. Mainnet: 0x514910771AF9Ca656af840dff83E8264EcF986CA. */
export default defineProtocol({
  name: "link",
  dependsOn: [],
  steps: [
    {
      id: "token",
      kind: "create",
      tx: "0x5488510df045770efbff57f25d0c6d2c1404d58c1199b21eb8dc5072b22d91d7",
      as: "LINK",
    },
  ],
  async verify(ctx) {
    const link = ctx.address("LINK");
    return [
      equalCheck("name", await ctx.read(link, abi, "name"), "ChainLink Token"),
      equalCheck("symbol", await ctx.read(link, abi, "symbol"), "LINK"),
      equalCheck("decimals", await ctx.read(link, abi, "decimals"), 18),
      equalCheck("totalSupply", await ctx.read(link, abi, "totalSupply"), TOTAL_SUPPLY),
      equalCheck("deployer balance", await ctx.read(link, abi, "balanceOf", [ctx.deployer]), TOTAL_SUPPLY),
    ];
  },
});
```

Replace the whole content of `src/protocols/index.ts` with:

```ts
import type { Registry } from "../engine";
import link from "./link";

/** Order matters: `run --all` deploys in this order, and addresses depend on it. */
export const registry: Registry = { link };
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
bunx vitest run && bunx tsc --noEmit
```

Expected: 76 tests pass in 12 files, and `tsc` prints nothing.

- [ ] **Step 5: Fetch the mainnet transaction**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
export ETHERSCAN_API_KEY=...   # ask the user; never write it to a file
bun run predeploy fetch link
```

Expected: `link/token: fetched LinkToken (v0.4.16+commit.d7661dd9) at 0x514910771af9ca656af840dff83e8264ecf986ca`, and a new file `deploy/predeploy/artifacts/link/0x5488510d….json`.

- [ ] **Step 6: Check the deployer's nonce, then deploy**

The expected addresses below assume the deployer is at nonce 0.

```bash
curl -s -X POST https://altmempool.forshtat.com -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionCount","params":["0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0","latest"]}'
```

Expected: `"result":"0x0"`. If it is not zero, deployments already happened; the addresses printed by `run` will differ from the ones in this plan, so use the printed ones everywhere below.

```bash
bun run predeploy run link
```

Expected output (gas figures may differ slightly):

```
deployer 0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0 on chain 1337 via https://altmempool.forshtat.com
link/token: estimate 5379527 gas, limit 6455432
link/token: LINK -> 0x7BF399a347FC0757e668058f11D3B696932353e4
link: deployed
addresses:
  link/LINK: 0x7BF399a347FC0757e668058f11D3B696932353e4
```

- [ ] **Step 7: Verify on the devnet**

```bash
bun run predeploy verify link
```

Expected:

```
PASS link
  ok   LINK has code: 0x7BF399a347FC0757e668058f11D3B696932353e4
  ok   name: ChainLink Token
  ok   symbol: LINK
  ok   decimals: 18
  ok   totalSupply: 1000000000000000000000000000
  ok   deployer balance: 1000000000000000000000000000
  info LINK: runtime code identical to mainnet
```

The `info` line is expected to say `identical` (LINK has no constructor arguments or immutables). If it says `differs`, note that in the commit message; it does not fail the run. Also run `bun run predeploy run link` a second time and expect `link: already deployed` with no transaction sent.

- [ ] **Step 8: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/protocols deploy/predeploy/test deploy/predeploy/artifacts/link deploy/predeploy/addresses
git commit -m "feat(predeploy): LINK, replayed from the mainnet deployment transaction" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: USDT and the gas-cap test

**Files:**
- Create: `deploy/predeploy/src/protocols/usdt.ts`, `test/usdt.test.ts`
- Modify: `deploy/predeploy/src/protocols/index.ts`, `test/registry.test.ts`
- Generated and committed: `artifacts/usdt/0x2f1c5c2b….json`, `addresses/1337.json`

**Interfaces:**
- Consumes: `uintWord` and `argWords` (Task 2), the engine.
- Produces: registry entry `usdt`, contract name `USDT`.

USDT is the first real test of the per-transaction gas cap: its deployment estimates at 18,649,474 gas, above the usual EIP-7825 cap of 16,777,216. `eth_estimateGas` does not enforce that cap, so only a real send answers the question. The constructor is `(uint _initialSupply, string _name, string _symbol, uint _decimals)`. The manifest replaces word 0 (mainnet's 1e11, that is 100,000 USDT) with 1e15, that is 1,000,000,000 USDT, so testers have plenty; the deployer, as owner, can mint more with `issue()`. Mainnet creation transaction: `0x2f1c5c2b44f771e942a8506148e256f94f1a464babc938ae0690c6e34cd79190`.

- [ ] **Step 1: Write the failing test**

`test/usdt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { uintWord } from "../src/creation";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { DEPLOYER, FakeChain, MemoryArtifacts, MemoryJournal, makeArtifact } from "./fakes";

describe("usdt", () => {
  it("replaces the initial supply (constructor word 0) with 1e15 and keeps the other words", async () => {
    const chain = new FakeChain();
    const artifacts = new MemoryArtifacts();
    const journal = new MemoryJournal();
    const words = [
      "00".repeat(27) + "174876e800", // initialSupply 1e11, as on mainnet
      "00".repeat(31) + "80",
      "00".repeat(31) + "c0",
      "00".repeat(31) + "06",
    ].join("");
    const step = registry.usdt.steps[0];
    if (step.kind !== "create") throw new Error("expected a create step");
    artifacts.write("usdt", makeArtifact({ hash: step.tx, input: `0x6080${words}`, constructorArgs: `0x${words}` }));

    await runProtocols(["usdt"], registry, { chain, artifacts, journal, log: () => {} });

    const sent = chain.sent[0].data;
    expect(sent.slice(0, 6)).toBe("0x6080");
    expect(sent.slice(6, 70)).toBe(uintWord(10n ** 15n).slice(2)); // word 0 replaced
    expect(sent.slice(70)).toBe(words.slice(64)); // words 1..3 untouched
  });

  const USDT = "0x0000000000000000000000000000000000000001" as Address;
  function deployedUsdt() {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    chain.codes.set(USDT.toLowerCase(), "0x6001");
    journal.file.protocols.usdt = { stepsDone: ["token"], contracts: { USDT }, mainnetToDevnet: {} };
    chain.setRead(USDT, "name", "Tether USD");
    chain.setRead(USDT, "symbol", "USDT");
    chain.setRead(USDT, "decimals", 6n);
    chain.setRead(USDT, "totalSupply", 10n ** 15n);
    chain.setRead(USDT, "owner", DEPLOYER);
    chain.setRead(USDT, "balanceOf", 10n ** 15n);
    return { chain, journal, artifacts: new MemoryArtifacts() };
  }

  it("verify passes when the deployer owns the token", async () => {
    const [report] = await verifyProtocols(["usdt"], registry, deployedUsdt());
    expect(report.ok).toBe(true);
  });

  it("verify fails when someone else owns the token", async () => {
    const deps = deployedUsdt();
    deps.chain.setRead(USDT, "owner", "0x00000000000000000000000000000000000000ff");
    const [report] = await verifyProtocols(["usdt"], registry, deps);
    expect(report.checks.find((c) => c.name === "owner is the deployer")?.ok).toBe(false);
  });
});
```

Also change the order assertion in `test/registry.test.ts` from `["link"]` to:

```ts
    expect(Object.keys(registry)).toEqual(["link", "usdt"]);
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/usdt.test.ts test/registry.test.ts
```

Expected: FAIL, `registry.usdt` is undefined and the order assertion fails.

- [ ] **Step 3: Implement the manifest and register it**

`src/protocols/usdt.ts`:

```ts
import { parseAbi } from "viem";
import { uintWord } from "../creation";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";

const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);

// Mainnet minted 100,000 USDT at deployment (1e11 base units). The devnet gets
// 1,000,000,000 USDT (1e15 base units) so testers have plenty; the deployer
// can mint more with issue().
const INITIAL_SUPPLY = 10n ** 15n;

/** Tether USD (TetherToken, solc 0.4.18). Mainnet: 0xdAC17F958D2ee523a2206206994597C13D831ec7. */
export default defineProtocol({
  name: "usdt",
  dependsOn: [],
  steps: [
    {
      id: "token",
      kind: "create",
      tx: "0x2f1c5c2b44f771e942a8506148e256f94f1a464babc938ae0690c6e34cd79190",
      as: "USDT",
      // Constructor: (uint _initialSupply, string _name, string _symbol, uint _decimals). Word 0 is the supply.
      argWords: { 0: uintWord(INITIAL_SUPPLY) },
    },
  ],
  async verify(ctx) {
    const usdt = ctx.address("USDT");
    return [
      equalCheck("name", await ctx.read(usdt, abi, "name"), "Tether USD"),
      equalCheck("symbol", await ctx.read(usdt, abi, "symbol"), "USDT"),
      equalCheck("decimals", await ctx.read(usdt, abi, "decimals"), 6),
      equalCheck("totalSupply", await ctx.read(usdt, abi, "totalSupply"), INITIAL_SUPPLY),
      equalCheck("owner is the deployer", await ctx.read(usdt, abi, "owner"), ctx.deployer),
      equalCheck("deployer balance", await ctx.read(usdt, abi, "balanceOf", [ctx.deployer]), INITIAL_SUPPLY),
    ];
  },
});
```

Replace the whole content of `src/protocols/index.ts` with:

```ts
import type { Registry } from "../engine";
import link from "./link";
import usdt from "./usdt";

/** Order matters: `run --all` deploys in this order, and addresses depend on it. */
export const registry: Registry = { link, usdt };
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
bunx vitest run && bunx tsc --noEmit
```

Expected: 79 tests pass in 13 files, and `tsc` prints nothing.

- [ ] **Step 5: Fetch and deploy (the gas-cap test)**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
bun run predeploy fetch usdt
bun run predeploy run usdt
```

Expected on success:

```
usdt/token: estimate 18649474 gas, limit 22379368
usdt/token: USDT -> 0xdb6785eB39E80a1770699C5dF8Ab7d4AC683b4D9
usdt: deployed
```

**If the send is rejected** (an error mentioning the gas limit, a transaction gas cap, or 16777216), STOP. Do not work around it. Report the exact error to the user: the spec's fallback (a devnet-only cap override in the ethrex fork) is a separate change that needs their decision. The deployer's nonce is not consumed by a rejected send, so nothing needs cleaning up. Tasks 11 and 12 depend on this task, so they wait too.

- [ ] **Step 6: Verify on the devnet**

```bash
bun run predeploy verify usdt
```

Expected:

```
PASS usdt
  ok   USDT has code: 0xdb6785eB39E80a1770699C5dF8Ab7d4AC683b4D9
  ok   name: Tether USD
  ok   symbol: USDT
  ok   decimals: 6
  ok   totalSupply: 1000000000000000
  ok   owner is the deployer: 0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0
  ok   deployer balance: 1000000000000000
  info USDT: runtime code identical to mainnet
```

- [ ] **Step 7: Commit**

The subject below assumes the >16.7M-gas deployment was accepted (Step 5). Adjust it if the result differed.

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/protocols deploy/predeploy/test deploy/predeploy/artifacts/usdt deploy/predeploy/addresses
git commit -m "feat(predeploy): USDT with 1e9 initial supply; devnet accepts >16.7M gas deployments" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Bored Ape Yacht Club

**Files:**
- Create: `deploy/predeploy/src/protocols/bayc.ts`, `test/bayc.test.ts`
- Modify: `deploy/predeploy/src/protocols/index.ts`, `test/registry.test.ts`
- Generated and committed: `artifacts/bayc/0x22199329….json`, `addresses/1337.json`

**Interfaces:**
- Consumes: the engine's `custom` step and `StepContext.read`/`send`.
- Produces: registry entry `bayc`, contract name `BAYC`; a `custom` step `open-sale`.

BAYC deploys with the sale closed. The manifest adds a `custom` step that opens it, so testers can call `mintApe()` (0.08 ETH each). The step reads `saleIsActive` first and only calls `flipSaleState()` when it is false, so a re-run can never flip the sale shut again. Mainnet creation transaction: `0x22199329b0aa1aa68902a78e3b32ca327c872fab166c7a2838273de6ad383eba`; constructor arguments are `("BoredApeYachtClub", "BAYC", 10000, 1618994903)` and are replayed unchanged.

- [ ] **Step 1: Write the failing test**

`test/bayc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runProtocols } from "../src/engine";
import { registry } from "../src/protocols";
import type { Address } from "../src/types";
import { verifyProtocols } from "../src/verify";
import { DEPLOYER, FakeChain, MemoryArtifacts, MemoryJournal, makeArtifact } from "./fakes";

// The first creation on a FakeChain gets this address.
const BAYC = "0x0000000000000000000000000000000000000001" as Address;

describe("bayc open-sale step", () => {
  const setup = (saleActive: boolean) => {
    const chain = new FakeChain();
    const artifacts = new MemoryArtifacts();
    const journal = new MemoryJournal();
    const step = registry.bayc.steps[0];
    if (step.kind !== "create") throw new Error("expected a create step");
    artifacts.write("bayc", makeArtifact({ hash: step.tx }));
    chain.setRead(BAYC, "saleIsActive", saleActive);
    return { chain, artifacts, journal, log: () => {} };
  };

  it("opens the sale when it is closed", async () => {
    const deps = setup(false);
    await runProtocols(["bayc"], registry, deps);
    expect(deps.chain.sent).toHaveLength(2);
    expect(deps.chain.sent[1].to).toBe(BAYC);
    expect(deps.chain.sent[1].data).toMatch(/^0x[0-9a-f]{8}$/); // flipSaleState() selector, no arguments
  });

  it("does not flip the sale shut when it is already open", async () => {
    const deps = setup(true);
    await runProtocols(["bayc"], registry, deps);
    expect(deps.chain.sent).toHaveLength(1); // creation only
  });
});

describe("bayc verify", () => {
  function deployedBayc() {
    const chain = new FakeChain();
    const journal = new MemoryJournal();
    chain.codes.set(BAYC.toLowerCase(), "0x6001");
    journal.file.protocols.bayc = {
      stepsDone: ["collection", "open-sale"],
      contracts: { BAYC },
      mainnetToDevnet: {},
    };
    chain.setRead(BAYC, "name", "BoredApeYachtClub");
    chain.setRead(BAYC, "symbol", "BAYC");
    chain.setRead(BAYC, "MAX_APES", 10_000n);
    chain.setRead(BAYC, "apePrice", 80_000_000_000_000_000n);
    chain.setRead(BAYC, "owner", DEPLOYER);
    chain.setRead(BAYC, "saleIsActive", true);
    return { chain, journal, artifacts: new MemoryArtifacts() };
  }

  it("passes for the mainnet values with the sale open", async () => {
    const [report] = await verifyProtocols(["bayc"], registry, deployedBayc());
    expect(report.ok).toBe(true);
  });

  it("fails when the sale is closed", async () => {
    const deps = deployedBayc();
    deps.chain.setRead(BAYC, "saleIsActive", false);
    const [report] = await verifyProtocols(["bayc"], registry, deps);
    expect(report.checks.find((c) => c.name === "sale is open")?.ok).toBe(false);
  });
});
```

Also change the order assertion in `test/registry.test.ts` to:

```ts
    expect(Object.keys(registry)).toEqual(["link", "usdt", "bayc"]);
```

- [ ] **Step 2: Run it to see it fail**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy/deploy/predeploy
bunx vitest run test/bayc.test.ts test/registry.test.ts
```

Expected: FAIL, `registry.bayc` is undefined and the order assertion fails.

- [ ] **Step 3: Implement the manifest and register it**

`src/protocols/bayc.ts`:

```ts
import { encodeFunctionData, parseAbi } from "viem";
import { equalCheck } from "../verify";
import { defineProtocol } from "./define";

const abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function MAX_APES() view returns (uint256)",
  "function apePrice() view returns (uint256)",
  "function owner() view returns (address)",
  "function saleIsActive() view returns (bool)",
  "function flipSaleState()",
]);

/** Bored Ape Yacht Club (solc 0.7.0). Mainnet: 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D. */
export default defineProtocol({
  name: "bayc",
  dependsOn: [],
  steps: [
    {
      id: "collection",
      kind: "create",
      tx: "0x22199329b0aa1aa68902a78e3b32ca327c872fab166c7a2838273de6ad383eba",
      as: "BAYC",
    },
    {
      // The mainnet contract deploys with the sale closed. Open it so testers can call mintApe().
      // Reads first, so a re-run never flips the sale shut again.
      id: "open-sale",
      kind: "custom",
      run: async (ctx) => {
        const bayc = ctx.address("BAYC");
        if ((await ctx.read(bayc, abi, "saleIsActive")) === true) return;
        await ctx.send({ to: bayc, data: encodeFunctionData({ abi, functionName: "flipSaleState" }), value: 0n });
      },
    },
  ],
  async verify(ctx) {
    const bayc = ctx.address("BAYC");
    return [
      equalCheck("name", await ctx.read(bayc, abi, "name"), "BoredApeYachtClub"),
      equalCheck("symbol", await ctx.read(bayc, abi, "symbol"), "BAYC"),
      equalCheck("MAX_APES", await ctx.read(bayc, abi, "MAX_APES"), 10_000),
      equalCheck("apePrice (0.08 ETH)", await ctx.read(bayc, abi, "apePrice"), 80_000_000_000_000_000n),
      equalCheck("owner is the deployer", await ctx.read(bayc, abi, "owner"), ctx.deployer),
      equalCheck("sale is open", await ctx.read(bayc, abi, "saleIsActive"), true),
    ];
  },
});
```

Replace the whole content of `src/protocols/index.ts` with the final version:

```ts
import type { Registry } from "../engine";
import bayc from "./bayc";
import link from "./link";
import usdt from "./usdt";

/** Order matters: `run --all` deploys in this order, and addresses depend on it. */
export const registry: Registry = { link, usdt, bayc };
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
bunx vitest run && bunx tsc --noEmit
```

Expected: all 83 tests pass in 14 files, and `tsc` prints nothing.

- [ ] **Step 5: Fetch and deploy**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
bun run predeploy fetch bayc
bun run predeploy run bayc
```

Expected:

```
bayc/collection: estimate 28177182 gas, limit 33812618
bayc/collection: BAYC -> 0x4F07c6E07C502f43373E5ecb42adBb92b41e192d
bayc/open-sale: estimate ... gas, limit ...
bayc/open-sale: done
bayc: deployed
```

- [ ] **Step 6: Verify on the devnet**

```bash
bun run predeploy verify bayc
```

Expected:

```
PASS bayc
  ok   BAYC has code: 0x4F07c6E07C502f43373E5ecb42adBb92b41e192d
  ok   name: BoredApeYachtClub
  ok   symbol: BAYC
  ok   MAX_APES: 10000
  ok   apePrice (0.08 ETH): 80000000000000000
  ok   owner is the deployer: 0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0
  ok   sale is open: true
  info BAYC: runtime code identical to mainnet
```

- [ ] **Step 7: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/predeploy/src/protocols deploy/predeploy/test deploy/predeploy/artifacts/bayc deploy/predeploy/addresses
git commit -m "feat(predeploy): BAYC with the sale opened for testers" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: Canonical run, tester documentation and operator runbook

**Files:**
- Modify: `deploy/devnet/devnet-readme.md` (table of contents and a new section before "Known limitations")
- Modify: `deploy/devnet/README.md` (new subsection before "Throwaway devnet key")
- Committed: `deploy/predeploy/addresses/1337.json` (already present, checked here)

**Interfaces:**
- Consumes: the three deployed protocols and their recorded addresses.
- Produces: documentation only.

- [ ] **Step 1: Confirm the canonical state**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
bun run predeploy run --all
bun run predeploy verify --all
bun run predeploy list
```

Expected: `run --all` prints `link: already deployed`, `usdt: already deployed`, `bayc: already deployed` and sends nothing. `verify --all` prints `PASS` for all three and exits 0. `list` shows the three addresses:

| Contract | Address |
|---|---|
| LINK | `0x7BF399a347FC0757e668058f11D3B696932353e4` |
| USDT | `0xdb6785eB39E80a1770699C5dF8Ab7d4AC683b4D9` |
| BAYC | `0x4F07c6E07C502f43373E5ecb42adBb92b41e192d` |

If the addresses printed by `list` differ from this table, use the printed ones in Steps 2 and 3.

- [ ] **Step 2: Add the tester section to `deploy/devnet/devnet-readme.md`**

Add this line to the table of contents, directly after `- [7. Running your own node against it](#7-running-your-own-node-against-it)`:

```markdown
- [8. Predeployed contracts](#8-predeployed-contracts)
```

Then insert this section directly before the line `## Known limitations` (keep the `---` separator that precedes it):

````markdown
## 8. Predeployed contracts

Real mainnet contracts, deployed by replaying their original deployment transactions, so their
bytecode is the mainnet bytecode. Addresses are on this devnet (chain ID 1337) and differ from
mainnet's.

| Contract | Address | Notes |
|---|---|---|
| LINK (Chainlink token) | `0x7BF399a347FC0757e668058f11D3B696932353e4` | 1,000,000,000 LINK, all held by the deployer |
| USDT (Tether) | `0xdb6785eB39E80a1770699C5dF8Ab7d4AC683b4D9` | 6 decimals. 1,000,000,000 USDT minted to the deployer, who owns the token and can mint more with `issue(amount)` |
| BAYC (Bored Ape Yacht Club) | `0x4F07c6E07C502f43373E5ecb42adBb92b41e192d` | Sale is open: `mintApe(n)` costs 0.08 ETH per ape, 10,000 max |

Everything is owned by the **deployer**, a throwaway key published on purpose:

```
address:     0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0
private key: 0xcbb754e47d54ec3bf76954e8e4df02e68d1484c703e47d29f189e32904545191
```

Anyone holding this key can administer these contracts (mint USDT, pause, blacklist). Never use
it on a real network. To get tokens, send a transfer from the deployer, or fund your own key
from the shared account in [Getting funds](#getting-funds).

More contracts (USDC, Tornado Cash, Uniswap v4, Railgun) are planned. The tool that deploys
them is in `deploy/predeploy/`.
````

- [ ] **Step 3: Add the operator subsection to `deploy/devnet/README.md`**

Insert this subsection directly before the line `## Throwaway devnet key`:

````markdown
### 10. Predeploying the contract library

After every devnet restart (a new genesis), put the mainnet contract library back:

```sh
# from the repo root, with bun install already run in deploy/predeploy
bun run predeploy fund          # sends devnet ETH to the deployer if it is low
bun run predeploy run --all     # replays the fetched mainnet deployments
bun run predeploy verify --all  # read-only checks; exits 1 on any failure
```

The deployer starts at nonce 0 on a fresh chain and `--all` runs in a fixed order, so the
addresses are the same every time (listed in `devnet-readme.md`). If they ever change, update
that table from `bun run predeploy list`. Details, and how to add a protocol, are in
`deploy/predeploy/README.md`.
````

- [ ] **Step 4: Check the docs render sensibly**

```bash
grep -n "Predeployed contracts" deploy/devnet/devnet-readme.md
grep -n "Predeploying the contract library" deploy/devnet/README.md
```

Expected: one table-of-contents line and one heading in `devnet-readme.md`, and one heading in `README.md`.

- [ ] **Step 5: Run the whole suite one last time**

```bash
bun run test:predeploy
cd deploy/predeploy && bunx tsc --noEmit
```

Expected: 83 tests pass in 14 files, and `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
cd /Users/alexf/skandha/.worktrees/predeploy
git add deploy/devnet/devnet-readme.md deploy/devnet/README.md deploy/predeploy/addresses
git commit -m "docs(devnet): list predeployed contracts and how to restore them after a restart" -m "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand back to the user**

Do not push. Tell the user the branch (`predeploy-scripts`) is ready, list the commits, and report the gas-cap result from Task 10 and whether each `info` code-hash line said `identical`. Pushing and opening a PR are the user's call.

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| Location `deploy/predeploy/`, Bun and viem, root script | 1, 8 |
| `fetch` / `fund` / `run` / `verify` / `list` commands | 8 (built from 6, 5, 7) |
| Etherscan V2 client, rate limit, key only from env | 6, 8 |
| Artifacts committed, deploy needs no key | 4, 6, 9-11 |
| Address rewriting of whole words in constructor args, never init code | 1, 5 |
| Gas: estimate + 20%, block-limit cap, price `2 x`, never send blind | 2, 3 |
| Deployer key: dedicated, published, funded from shared key | 1, 8 |
| Journal, resume, stale detection after restart, `--force` | 4, 5 |
| Deterministic addresses from a fixed order | 9-12 |
| Verification with informational code-hash comparison | 7 |
| Manifest step kinds `create`, `custom` (`call` deferred, see Scope) | 5, 11 |
| `argWords` constructor overrides | 2, 10 |
| Protocol order: engine + LINK, USDT, BAYC | 9, 10, 11 |
| First real test of the per-transaction gas cap | 10 |
| Documentation: tester table and operator runbook | 8, 12 |
| Unit tests for the pure parts; `verify` as integration acceptance | 1-7, 9-11 |
| Etherscan key never written to a repo file | Global Constraints, 9 |

## Post-execution notes

Recorded after execution and the final review. The plan text above is left as written.

- Two deliberate deviations from the spec: the spec's "prints a diff against the committed file"
  is replaced by the `git diff deploy/predeploy/addresses/1337.json` instruction in
  `deploy/predeploy/README.md`; and the spec's `patch` mechanism for mainnet constants baked into
  init code was not built (the README says the engine does not patch code).
- Task 5 and Task 7 changed the "already deployed" predicate from a step count to step ids
  (`engine.ts`, `verify.ts`), so the condition line in the Task 5 code block is stale. The
  predicate was later extracted into `isFullyDeployed`.
- Actual test totals: 85 tests in 14 files at the end of the plan (the per-task totals in the
  plan text are 2 lower from Task 8 on). The final fix wave then added tests on top of the 85.
- The engine journals and prints addresses in lower case; the docs use EIP-55 checksummed forms.
- The deployer-nonce guard (`deployerNonce` in the journal, `ChainPort.transactionCount`) and the
  shared contract resolver (`resolveContract`) were added by the final fix wave.
