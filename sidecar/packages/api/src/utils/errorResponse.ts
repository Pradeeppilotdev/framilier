import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

/**
 * The HTTP status and JSON-RPC body for an error that escaped a handler.
 *
 * Every answer is a JSON-RPC error object carrying the request's id (`null`
 * when the body is missing, a batch or has none), so clients can match it to
 * their call. An `RpcError` is the node's deliberate answer. A 4xx error from
 * the HTTP layer (such as an unparseable body) keeps its status. Anything
 * else is this node's fault: it is reported as "Internal error" and its
 * message stays in the server log rather than going to the client.
 */
export function toErrorResponse(
  err: Error & { statusCode?: number },
  body: unknown
): { status: number; payload: object } {
  const request =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as { jsonrpc?: string; id?: unknown })
      : undefined;
  const base = { jsonrpc: request?.jsonrpc ?? "2.0", id: request?.id ?? null };

  if (err instanceof RpcError) {
    return {
      status: 200,
      payload: {
        ...base,
        error: { message: err.message, data: err.data, code: err.code },
      },
    };
  }
  if (
    typeof err.statusCode === "number" &&
    err.statusCode >= 400 &&
    err.statusCode < 500
  ) {
    return {
      status: err.statusCode,
      payload: {
        ...base,
        error: {
          code: err.statusCode === 400 ? PARSE_ERROR : INVALID_REQUEST,
          message: err.message,
        },
      },
    };
  }
  return {
    status: 200,
    payload: { ...base, error: { code: INTERNAL_ERROR, message: "Internal error" } },
  };
}
