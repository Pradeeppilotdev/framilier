import { describe, it, expect } from "vitest";
import {
  calculateDeclaredVerifyGas,
  isHeavyFrameTx,
  DEFAULT_HEAVY_VERIFY_GAS_THRESHOLD,
  MAX_VERIFY_GAS_PER_ENTITY,
  MAX_VERIFY_GAS_STAKED_ENTITY,
} from "../../../../src/services/UserOpValidation/utils/validationBudget.js";
import {
  FRAME_MODE,
  APPROVE_SCOPE,
  Frame,
  FrameTransaction,
  SIG_SCHEME,
  SignatureEntry,
} from "@skandha/types/lib/contracts/FrameTx.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0x5555555555555555555555555555555555555555" as const;

const verify = (flags: number, execution: bigint, target: `0x${string}` | null = null): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags,
  target,
  limits: { execution, state: 0n },
  value: 0n,
  data: "0x",
});
const selfVerify = (execution: bigint) => verify(APPROVE_SCOPE.EXECUTION_AND_PAYMENT, execution);
const onlyVerify = (execution: bigint) => verify(APPROVE_SCOPE.EXECUTION, execution);
const pay = (execution: bigint, target: `0x${string}` = PAYER) => verify(APPROVE_SCOPE.PAYMENT, execution, target);
const expiryVerify = (execution: bigint) => verify(APPROVE_SCOPE.NONE, execution);
const body = (): Frame => ({
  mode: FRAME_MODE.SENDER,
  flags: 0,
  target: "0x4444444444444444444444444444444444444444",
  limits: { execution: 5_000_000n, state: 0n },
  value: 0n,
  data: "0x",
});

const sig = (scheme: number): SignatureEntry =>
  ({ scheme, signer: "0x2222222222222222222222222222222222222222", msg: "0x", signature: "0x" }) as SignatureEntry;

const tx = (frames: Frame[], signatures: SignatureEntry[] = []): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender: SENDER,
  frames,
  signatures,
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

describe("validationBudget utils", () => {
  it("re-exports BUDGET-010 constants from validationPrefix", () => {
    expect(MAX_VERIFY_GAS_PER_ENTITY).toBe(100_000n);
    expect(MAX_VERIFY_GAS_STAKED_ENTITY).toBe(1_000_000n);
    expect(DEFAULT_HEAVY_VERIFY_GAS_THRESHOLD).toBe(100_000n);
  });

  describe("calculateDeclaredVerifyGas", () => {
    it("counts self_verify execution gas plus signature cost for sender", () => {
      // 150_000 execution + SECP256K1 sig cost (2,800) = 152,800
      const t = tx([selfVerify(150_000n), body()], [sig(SIG_SCHEME.SECP256K1)]);
      const gas = calculateDeclaredVerifyGas(t);
      expect(gas).toBe(152_800n);
    });

    it("counts each entity declared budget once (sender + payer)", () => {
      // sender: 90_000 + 2,800 sig = 92,800
      // payer: 30_000
      // total = 122,800
      const t = tx([onlyVerify(90_000n), pay(30_000n), body()], [sig(SIG_SCHEME.SECP256K1)]);
      const gas = calculateDeclaredVerifyGas(t);
      expect(gas).toBe(122_800n);
    });

    it("includes separate expiry_verify budget in total declared verify gas", () => {
      // expiry_verify: 50_000
      // self_verify: 60_000 + 2,800 sig = 62_800
      // total = 112_800
      const t = tx([expiryVerify(50_000n), selfVerify(60_000n), body()], [sig(SIG_SCHEME.SECP256K1)]);
      const gas = calculateDeclaredVerifyGas(t);
      expect(gas).toBe(112_800n);
    });

    it("returns 0n for malformed transactions or unrecognized prefix without throwing", () => {
      expect(calculateDeclaredVerifyGas(null as any)).toBe(0n);
      expect(calculateDeclaredVerifyGas({} as any)).toBe(0n);
      expect(calculateDeclaredVerifyGas(tx([body()]))).toBe(0n); // No verify frame
    });
  });

  describe("isHeavyFrameTx", () => {
    it("classifies total verify gas > 100_000 as heavy", () => {
      const heavyTx = tx([selfVerify(150_000n), body()]);
      expect(isHeavyFrameTx(heavyTx)).toBe(true);

      const lightTx = tx([selfVerify(50_000n), body()]);
      expect(isHeavyFrameTx(lightTx)).toBe(false);
    });

    it("boundary at exactly 100_000 is not heavy (strictly greater than threshold)", () => {
      const boundaryTx = tx([selfVerify(100_000n), body()]);
      expect(isHeavyFrameTx(boundaryTx, 100_000n)).toBe(false);

      const overTx = tx([selfVerify(100_001n), body()]);
      expect(isHeavyFrameTx(overTx, 100_000n)).toBe(true);
    });

    it("respects custom threshold", () => {
      const t = tx([selfVerify(50_000n), body()]);
      expect(isHeavyFrameTx(t, 40_000)).toBe(true);
      expect(isHeavyFrameTx(t, 60_000)).toBe(false);
    });
  });
});

