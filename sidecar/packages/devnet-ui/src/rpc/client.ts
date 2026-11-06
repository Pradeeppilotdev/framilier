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
