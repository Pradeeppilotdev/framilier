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
