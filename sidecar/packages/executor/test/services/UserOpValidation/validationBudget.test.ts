import { describe, expect, it, vi } from "vitest";
import { getAddress, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Frame, FrameTransaction, FRAME_MODE, SIG_SCHEME } from "@skandha/types/lib/contracts/FrameTx.js";
import { collectValidationBudgets } from "../../../src/services/UserOpValidation/utils/validationBudget.js";
import { recognizeValidationPrefix, validateStructuralRules } from "../../../src/services/UserOpValidation/utils/validationPrefix.js";
import { FrameTxValidationService } from "../../../src/services/UserOpValidation/validators/frameTx.js";
import { FrameTxSimulationService } from "../../../src/services/FrameTxSimulationService/index.js";
import { StakingRegistryService } from "../../../src/services/StakingRegistryService/index.js";
import { ReputationService } from "../../../src/services/ReputationService.js";
import { CheckCollector } from "../../../src/services/ExplorerService/checkCollector.js";
import { computeSigHash } from "../../../src/services/FrameTxService/codec.js";
import { NetworkConfig } from "../../../src/interfaces.js";

const SENDER = "0x1111111111111111111111111111111111111111" as Hex;
const PAYER = "0x5555555555555555555555555555555555555555" as Hex;
const FACTORY = "0x6666666666666666666666666666666666666666" as Hex;
const ENTRY = "0x00000000000000000000000000000000000000aa";
const STAKE = 10_000_000_000_000_000n;
type Deposit = { stake: bigint; unstakeDelaySec: number; withdrawTime: bigint };
const locked: Deposit = { stake: STAKE, unstakeDelaySec: 86400, withdrawTime: 0n };
const empty: Deposit = { stake: 0n, unstakeDelaySec: 0, withdrawTime: 0n };
const frame = (gas: bigint, flags = 3, target: Hex | null = null, mode: Frame["mode"] = FRAME_MODE.VERIFY): Frame =>
  ({ mode, flags, target, limits: { execution: gas, state: 0n }, value: 0n, data: "0x" });
const tx = (frames: Frame[]): FrameTransaction => ({ chainId: 1337n, sender: SENDER, nonceKeys: [0n], nonceSeq: 0n,
  frames, signatures: [], fees: { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [], recentRootReferences: [] });
function ledger(transaction: FrameTransaction) {
  const prefix = recognizeValidationPrefix(transaction.frames, transaction.sender);
  if (!prefix) throw new Error("Bad test prefix");
  return collectValidationBudgets(transaction, prefix);
}
function harness(deposits: Record<string, Deposit> = {}, code: Hex | undefined = "0x6000", reputationCode = 0) {
  const registry = { getDepositInfo: vi.fn(async (address: string) => deposits[address.toLowerCase()] ?? empty) };
  const reputation = { checkStake: vi.fn(async () => ({ code: reputationCode, msg: reputationCode ? "banned" : "" })) };
  const getCode = vi.fn(async () => code);
  const logger = { debug: vi.fn(), error: vi.fn() } as any;
  const config = { minStake: STAKE, minUnstakeDelay: 86400, precompiles: [], whitelistedEntities: {},
    relayOpsWithWhitelistedEntities: false, standardMempoolId: "framilier-test" } as unknown as NetworkConfig;
  const validation = new FrameTxValidationService(registry as unknown as StakingRegistryService,
    reputation as unknown as ReputationService, config, logger, undefined, getCode);
  return { validation, registry, reputation, getCode, logger };
}
function simulation(transaction: FrameTransaction) {
  const prefix = recognizeValidationPrefix(transaction.frames, transaction.sender)!;
  return { canonicalMempoolValid: false, prefixShape: "SelfVerify", payer: SENDER, maxCost: "0x0",
    canonicalMempoolViolation: "ValidationGasLimitExceeded", executionError: null, executionStatus: "success",
    gasUsed: "0x2761", frames: transaction.frames.map(() => ({ gasUsed: "0x2761", succeeded: true })),
    erc7562TraceError: null, erc7562Trace: transaction.frames.slice(0, prefix.payerFrameIndex + 1).map((f, i) =>
      ({ frameIndex: i, root: { from: ENTRY, to: f.target ?? SENDER, type: "CALL", value: "0x0",
        accessedSlots: { reads: {}, writes: {}, transientReads: {}, transientWrites: {} },
        extCodeAccessInfo: [], usedOpcodes: {}, contractSize: {}, outOfGas: false } })) } as any;
}
function sign(transaction: FrameTransaction) {
  // Public deterministic test fixture, never a devnet participant key.
  const key = `0x${"12".repeat(32)}` as Hex;
  transaction.signatures = [{ scheme: SIG_SCHEME.SECP256K1,
    signer: privateKeyToAccount(key).address, msg: "0x", signature: "0x" }];
  const signature = secp256k1.sign(computeSigHash(transaction).slice(2), key.slice(2));
  transaction.signatures[0].signature = `0x${signature.recovery.toString(16).padStart(2, "0")}${signature.toCompactHex()}`;
  return transaction;
}

describe("framilier BUDGET-010 accounting", () => {
  it("charges all signature schemes only to the sender", () => {
    const transaction = tx([frame(50_000n, 2), frame(900_000n, 1, PAYER)]);
    transaction.signatures = [0, 1, 2].map(scheme => ({ scheme, signer: "0x", msg: "0x", signature: "0x" })) as any;
    const entries = ledger(transaction).entities;
    expect(entries.map(e => [e.address, e.totalGas])).toEqual([[SENDER, 59_600n], [PAYER, 900_000n]]);
  });
  it("combines pre_verify, approval and signatures under one address", () => {
    const transaction = sign(tx([frame(400_000n, 0, SENDER, 0), frame(597_200n)]));
    expect(ledger(transaction).entities).toMatchObject([{ executionGas: 997_200n, signatureGas: 2800n,
      totalGas: 1_000_000n, frameIndices: [0, 1], roles: ["sender", "payer"] }]);
  });
  it("normalizes case and combines sender and payer roles", () => {
    const address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Hex;
    const transaction = tx([frame(60_000n, 2, getAddress(address)), frame(60_000n, 1, address)]);
    transaction.sender = address;
    expect(ledger(transaction).entities).toMatchObject([{ totalGas: 120_000n, roles: ["sender", "payer"] }]);
    expect(validateStructuralRules(transaction, recognizeValidationPrefix(transaction.frames, address)!, "per-entity")).toEqual({ valid: true });
  });
  it("attributes deploy to the factory and leaves the body outside the ledger", () => {
    const entries = ledger(tx([frame(800_000n, 0, FACTORY, 0), frame(90_000n), frame(20_000_000n, 0, PAYER, 2)])).entities;
    expect(entries.map(e => [e.address, e.totalGas])).toEqual([[SENDER, 90_000n], [FACTORY, 800_000n]]);
  });
  it("separately bounds the unattributed protocol expiry frame", async () => {
    const transaction = tx([frame(100_001n, 0), frame(1n)]);
    expect(ledger(transaction).expiryGas).toBe(100_001n);
    await expect(harness().validation.preflight(transaction)).rejects.toThrow("expiry verification gas");
  });
  it("rejects unknown signature schemes rather than pricing them at zero", async () => {
    const transaction = tx([frame(1n)]);
    transaction.signatures = [{ scheme: 99, signer: "0x", msg: "0x", signature: "0x" }] as any;
    await expect(harness().validation.preflight(transaction)).rejects.toThrow("Unknown signature scheme");
  });
  it("rejects negative prefix limits before arithmetic can reduce a budget", async () => {
    await expect(harness().validation.preflight(tx([frame(-1n)]))).rejects.toThrow("Invalid limits");
  });
});

describe("framilier real validation pipeline", () => {
  it.each([97_200n, 997_200n])("accepts the exact inclusive boundary with a real secp256k1 signature: %s", async gas => {
    const transaction = sign(tx([frame(gas)]));
    const h = harness(gas > 100_000n ? { [SENDER]: locked } : {});
    const collector = new CheckCollector();
    await expect(h.validation.validate(transaction, simulation(transaction), collector)).resolves.toMatchObject({ mempoolMembership: { "framilier-test": true } });
    expect(collector.toChecks()).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "BUDGET-010", verdict: "pass" })]));
  });
  it.each([97_201n, 997_201n])("rejects one gas above the signature-inclusive boundary: %s", async gas => {
    const h = harness(gas > 100_000n ? { [SENDER]: locked } : {});
    await expect(h.validation.preflight(sign(tx([frame(gas)])))).rejects.toThrow("BUDGET-010 exceeded");
  });
  it("allows separate entities to exceed 1M in total without sharing their budgets", async () => {
    const h = harness({ [PAYER]: locked });
    const transaction = tx([frame(100_000n, 2), frame(1_000_000n, 1, PAYER)]);
    await expect(h.validation.validate(transaction, simulation(transaction))).resolves.toBeDefined();
  });
  it("a staked payer cannot subsidize an over-budget unstaked sender", async () => {
    const h = harness({ [PAYER]: locked });
    await expect(h.validation.preflight(tx([frame(100_001n, 2), frame(800_000n, 1, PAYER)]))).rejects.toThrow(`entity ${SENDER}`);
  });
  it("a staked sender cannot subsidize an over-budget unstaked payer", async () => {
    const h = harness({ [SENDER]: locked });
    await expect(h.validation.preflight(tx([frame(800_000n, 2), frame(100_001n, 1, PAYER)]))).rejects.toThrow(`entity ${PAYER}`);
  });
  it("reusing a staked address as sender and payer gives one 1M cap", async () => {
    const h = harness({ [SENDER]: locked });
    await expect(h.validation.preflight(tx([frame(600_000n, 2), frame(400_001n, 1, SENDER)]))).rejects.toThrow("BUDGET-010 exceeded");
  });
  it("a factory has its own stake and budget", async () => {
    const transaction = tx([frame(800_000n, 0, FACTORY, 0), frame(90_000n)]);
    await expect(harness({ [FACTORY]: locked }).validation.preflight(transaction)).resolves.toBeDefined();
    await expect(harness({ [SENDER]: locked }).validation.preflight(transaction)).rejects.toThrow(`entity ${FACTORY}`);
  });
  it.each([
    ["insufficient amount", { ...locked, stake: STAKE - 1n }],
    ["short delay", { ...locked, unstakeDelaySec: 86399 }],
    ["withdrawal started", { ...locked, withdrawTime: 1n }],
    ["whitelist with no deposit", empty],
  ])("withholds the higher budget for %s", async (_name, deposit) => {
    await expect(harness({ [SENDER]: deposit as Deposit }).validation.preflight(tx([frame(100_001n)]))).rejects.toThrow("limit 100000");
  });
  it.each(["0x", undefined])("default or unavailable code never gets the higher budget: %s", async code => {
    const h = harness({ [SENDER]: locked }, "0x");
    h.getCode.mockResolvedValue(code as Hex);
    await expect(h.validation.preflight(tx([frame(100_001n)]))).rejects.toThrow("limit 100000");
  });
  it("banned reputation cannot grant the higher budget", async () => {
    await expect(harness({ [SENDER]: locked }, "0x6000", 1).validation.preflight(tx([frame(100_001n)]))).rejects.toThrow("limit 100000");
  });
  it("reads a repeated entity's deposit only once per admission", async () => {
    const h = harness({ [SENDER]: locked });
    await h.validation.preflight(tx([frame(400_000n, 0, SENDER, 0), frame(600_000n)]));
    expect(h.registry.getDepositInfo).toHaveBeenCalledTimes(1);
    expect(h.getCode).toHaveBeenCalledTimes(1);
  });
  it("fails closed on registry errors", async () => {
    const h = harness();
    h.registry.getDepositInfo.mockRejectedValue(new Error("registry unavailable"));
    await expect(h.validation.preflight(tx([frame(500_000n)]))).rejects.toThrow("registry unavailable");
  });
  it("does not retain a stake snapshot across separate admissions", async () => {
    const h = harness({ [SENDER]: locked });
    await h.validation.preflight(tx([frame(500_000n)]));
    h.registry.getDepositInfo.mockResolvedValue({ ...locked, withdrawTime: 1n });
    await expect(h.validation.preflight(tx([frame(500_000n)]))).rejects.toThrow("limit 100000");
  });
  it("removes the canonical prefix state cap while retaining execution budgets", async () => {
    const transaction = tx([frame(90_000n)]);
    transaction.frames[0].limits.state = 600_000n;
    await expect(harness().validation.preflight(transaction)).resolves.toBeDefined();
  });
  it("rejects over-budget work before invoking the tracer", async () => {
    const h = harness();
    const client = { request: vi.fn() };
    const service = new FrameTxSimulationService(client as unknown as PublicClient, h.validation, h.logger);
    await expect(service.simulate(tx([frame(100_001n)]))).rejects.toThrow("BUDGET-010 exceeded");
    expect(client.request).not.toHaveBeenCalled();
  });
  it("runs exactly one traced simulation for an eligible 1M transaction", async () => {
    const h = harness({ [SENDER]: locked });
    const transaction = sign(tx([frame(997_200n)]));
    const client = { request: vi.fn().mockResolvedValue(simulation(transaction)) };
    const service = new FrameTxSimulationService(client as unknown as PublicClient, h.validation, h.logger);
    await expect(service.simulate(transaction)).resolves.toBeDefined();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(h.registry.getDepositInfo).toHaveBeenCalledTimes(1);
  });
  it("still rejects missing trace data for an otherwise eligible staked transaction", async () => {
    const h = harness({ [SENDER]: locked });
    const transaction = tx([frame(500_001n)]);
    await expect(h.validation.validate(transaction, { ...simulation(transaction), erc7562Trace: null })).rejects.toThrow();
  });
});
