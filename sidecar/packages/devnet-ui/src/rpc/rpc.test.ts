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
        minInclusionDenominator: 10, throttlingSlack: 10, banSlack: 50,
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
