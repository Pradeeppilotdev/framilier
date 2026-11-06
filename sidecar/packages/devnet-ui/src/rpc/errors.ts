/**
 * The ways an explorer request can fail, kept apart so the UI can say what to
 * do about each one.
 */

export class UnreachableError extends Error {
  readonly kind = "unreachable" as const;
  constructor(
    readonly url: string,
    cause?: unknown,
  ) {
    super(`Could not reach ${url}`, { cause });
    this.name = "UnreachableError";
  }
}

/** JSON-RPC "method not found": the node is off, or predates, the explorer. */
export class ExplorerDisabledError extends Error {
  readonly kind = "disabled" as const;
  constructor() {
    super("The explorer is not available on this node");
    this.name = "ExplorerDisabledError";
  }
}

export class ProtocolError extends Error {
  readonly kind = "protocol" as const;
  constructor(readonly detail: string) {
    super(`Unexpected explorer response: ${detail}`);
    this.name = "ProtocolError";
  }
}

export class RpcMethodError extends Error {
  readonly kind = "rpc" as const;
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcMethodError";
  }
}

export class HttpStatusError extends Error {
  readonly kind = "http" as const;
  constructor(readonly status: number) {
    super(`The node answered HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

export interface ErrorNotice {
  kind: "unreachable" | "disabled" | "protocol" | "rpc" | "http" | "unknown";
  title: string;
  hint: string;
}

/** The host of a URL, or the raw string when it does not parse, so a bad URL never throws in a render. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Turns any error into plain-language copy for a banner or an inline message. */
export function describeError(err: unknown, url: string): ErrorNotice {
  if (err instanceof UnreachableError) {
    return {
      kind: "unreachable",
      title: `Couldn't reach ${hostOf(url)}`,
      hint: "Check that the node is running and that the URL ends in /rpc. If the node is on another origin, it must allow this page's origin (--api.cors).",
    };
  }
  if (err instanceof ExplorerDisabledError) {
    return {
      kind: "disabled",
      title: "The explorer isn't available on this node",
      hint: "Start the sidecar with --explorer.enable. Nodes older than the explorer don't have it.",
    };
  }
  if (err instanceof ProtocolError) {
    return {
      kind: "protocol",
      title: "This node's answer doesn't match the explorer protocol",
      hint: err.detail,
    };
  }
  if (err instanceof RpcMethodError) {
    return { kind: "rpc", title: err.message, hint: `Error code ${err.code}.` };
  }
  if (err instanceof HttpStatusError) {
    return {
      kind: "http",
      title: `The node answered HTTP ${err.status}`,
      hint: "It may sit behind a proxy that doesn't forward /rpc to the sidecar.",
    };
  }
  return {
    kind: "unknown",
    title: "Something went wrong",
    hint: err instanceof Error ? err.message : String(err),
  };
}
