import { describe, expect, it } from "vitest";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import { toErrorResponse } from "../../../src/utils/errorResponse.js";

describe("toErrorResponse", () => {
  it("answers an RpcError with HTTP 200 and the request's id", () => {
    const { status, payload } = toErrorResponse(new RpcError("boom", -32602, { data: { a: 1 } }), {
      jsonrpc: "2.0",
      id: 7,
      method: "x",
    });
    expect(status).toBe(200);
    expect(payload).toEqual({ jsonrpc: "2.0", id: 7, error: { message: "boom", code: -32602, data: { data: { a: 1 } } } });
  });

  it("reports an unexpected error as JSON-RPC -32603 without leaking its message", () => {
    const { status, payload } = toErrorResponse(new Error("connect ECONNREFUSED 10.0.0.1:8545"), { jsonrpc: "2.0", id: "a" });
    expect(status).toBe(200);
    expect(payload).toEqual({ jsonrpc: "2.0", id: "a", error: { code: -32603, message: "Internal error" } });
  });

  it("keeps the status of a client error such as an unparseable body, as a JSON-RPC error", () => {
    const err = Object.assign(new Error("Unexpected token } in JSON"), { statusCode: 400 });
    const { status, payload } = toErrorResponse(err, undefined);
    expect(status).toBe(400);
    expect(payload).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Unexpected token } in JSON" } });
  });

  it("uses a null id when the body is missing, a batch, or has no id", () => {
    const e = new Error("x");
    for (const body of [undefined, null, [{ id: 1 }], { jsonrpc: "2.0" }, "text"]) {
      expect((toErrorResponse(e, body).payload as any).id).toBeNull();
    }
  });
});
