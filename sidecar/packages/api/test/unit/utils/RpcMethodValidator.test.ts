import { describe, expect, it, vi } from "vitest";
import { Eth } from "@skandha/executor/lib/modules/eth.js";
import { Debug } from "@skandha/executor/lib/modules/debug.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import { EthAPI } from "../../../src/modules/eth.js";
import { DebugAPI } from "../../../src/modules/debug.js";
import { describeValidationErrors } from "../../../src/utils/RpcMethodValidator.js";
import { validFrameTransactionWire } from "../../fixtures.js";

/**
 * B1 regression coverage: `app.ts`'s new dispatch shape passes `params[0]`
 * DIRECTLY as the DTO validation root for `eth_sendFrameTransaction`/
 * `eth_estimateFrameTransactionGas` (unlike the old `{userOp, entryPoint}`
 * wrapping-envelope shape, which happened to shield `plainToInstance` from
 * ever seeing a non-object value). A missing/null/scalar `params[0]` - the
 * single most likely malformed request against this new public RPC surface -
 * must produce a clean `RpcError`, not a raw `TypeError` that `server.ts`
 * would render as an HTTP 500 leaking an internal error message.
 */
function buildEthAPI(): EthAPI {
  const ethModule = {
    sendFrameTransaction: vi.fn().mockResolvedValue("0xhash"),
    estimateFrameTransactionGas: vi.fn().mockResolvedValue({}),
  } as unknown as Eth;
  return new EthAPI(ethModule);
}

function buildDebugAPI(): DebugAPI {
  const debugModule = {
    setMempool: vi.fn().mockResolvedValue("ok"),
  } as unknown as Debug;
  return new DebugAPI(debugModule);
}

const malformedInputs: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["a scalar string", "0xdeadbeef"],
  ["a scalar number", 42],
];

describe("RpcMethodValidator - malformed raw argument handling (B1)", () => {
  describe("EthAPI.sendFrameTransaction", () => {
    for (const [label, value] of malformedInputs) {
      it(`throws a clean RpcError, not a raw TypeError, for ${label}`, async () => {
        const ethAPI = buildEthAPI();
        await expect(
          ethAPI.sendFrameTransaction(value as any)
        ).rejects.toBeInstanceOf(RpcError);
      });
    }
  });

  describe("EthAPI.estimateFrameTransactionGas", () => {
    for (const [label, value] of malformedInputs) {
      it(`throws a clean RpcError, not a raw TypeError, for ${label}`, async () => {
        const ethAPI = buildEthAPI();
        await expect(
          ethAPI.estimateFrameTransactionGas(value as any)
        ).rejects.toBeInstanceOf(RpcError);
      });
    }
  });

  describe("DebugAPI.setMempool", () => {
    for (const [label, value] of malformedInputs) {
      it(`throws a clean RpcError, not a raw TypeError, for ${label}`, async () => {
        const debugAPI = buildDebugAPI();
        await expect(
          debugAPI.setMempool(value as any)
        ).rejects.toBeInstanceOf(RpcError);
      });
    }
  });
});

describe("RpcMethodValidator - the error names what is wrong", () => {
  const rejection = async (body: unknown) => {
    const err = await buildEthAPI()
      .sendFrameTransaction(body as any)
      .catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    return err as RpcError;
  };

  it("names a frame's field and the rule it broke", async () => {
    const wire = JSON.parse(JSON.stringify(validFrameTransactionWire));
    wire.frames[0].mode = 7;
    const err = await rejection(wire);
    expect(err.code).toBe(-32600);
    expect(err.message).toMatch(/^Invalid Request: frames\.0\.mode: mode must be a valid number or hex string in range/);
  });

  it("names a missing top-level field", async () => {
    const wire = JSON.parse(JSON.stringify(validFrameTransactionWire));
    delete wire.signatures;
    const err = await rejection(wire);
    expect(err.message).toMatch(/^Invalid Request: signatures: /);
  });

  it("lists at most three problems and keeps the full list in data", async () => {
    const err = await rejection({});
    expect(err.message.split("; ").length).toBeLessThanOrEqual(3);
    expect((err.data as any).data.errors.length).toBeGreaterThan(3);
  });

  it("describeValidationErrors walks nested children into dotted paths", () => {
    const errors = [
      {
        property: "frames",
        children: [{ property: "1", children: [{ property: "value", constraints: { isBigNumber: "value must be a big number" } }] }],
      },
    ] as any;
    expect(describeValidationErrors(errors)).toBe("frames.1.value: value must be a big number");
  });
});
