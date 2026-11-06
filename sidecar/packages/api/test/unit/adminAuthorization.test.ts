import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiApp } from "../../src/app.js";

const originalKey = process.env.SKANDHA_ADMIN_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.SKANDHA_ADMIN_KEY;
  else process.env.SKANDHA_ADMIN_KEY = originalKey;
});

function fixture(testingMode = false) {
  const clearMempool = vi.fn().mockResolvedValue("ok");
  const context = { testingMode, redirectRpc: false, debugApi: { clearMempool } };
  const call = (ip: string, key?: string) => (ApiApp.prototype as any).handleRpcRequest.call(
    context, { jsonrpc: "2.0", id: 1, method: "debug_bundler_clearMempool", params: [] }, ip, key
  );
  return { call, clearMempool };
}

describe("Debug RPC authorization", () => {
  it.each(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1", "198.51.100.7"])(
    "requires the configured key at %s, including in testing mode", async ip => {
      process.env.SKANDHA_ADMIN_KEY = "test-only-secret";
      for (const testing of [false, true]) {
        const { call, clearMempool } = fixture(testing);
        await expect(call(ip)).rejects.toThrow(/not supported/);
        await expect(call(ip, "wrong-key")).rejects.toThrow(/not supported/);
        expect(clearMempool).not.toHaveBeenCalled();
        await expect(call(ip, "test-only-secret")).resolves.toMatchObject({ result: "ok" });
        expect(clearMempool).toHaveBeenCalledTimes(1);
      }
    }
  );

  it("disables normal debug access when no key is configured", async () => {
    delete process.env.SKANDHA_ADMIN_KEY;
    const { call, clearMempool } = fixture();
    await expect(call("127.0.0.1")).rejects.toThrow();
    await expect(call("198.51.100.7")).rejects.toThrow();
    expect(clearMempool).not.toHaveBeenCalled();
  });

  it("permits explicit keyless testing only over loopback", async () => {
    delete process.env.SKANDHA_ADMIN_KEY;
    const { call, clearMempool } = fixture(true);
    await expect(call("198.51.100.7")).rejects.toThrow();
    await expect(call("")).rejects.toThrow();
    await expect(call("127.0.0.1")).resolves.toMatchObject({ result: "ok" });
    expect(clearMempool).toHaveBeenCalledTimes(1);
  });
});
