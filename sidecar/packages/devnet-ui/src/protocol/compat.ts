import { EXPLORER_PROTOCOL_VERSION } from "@skandha/types/lib/explorer/index.js";

/** The explorer protocol version this app understands. */
export const SUPPORTED_PROTOCOL_VERSION = EXPLORER_PROTOCOL_VERSION;

export type Compat =
  | { ok: true }
  | { ok: false; nodeVersion: number; supported: number };

export function checkProtocol(info: { protocolVersion: number }): Compat {
  return info.protocolVersion === SUPPORTED_PROTOCOL_VERSION
    ? { ok: true }
    : {
        ok: false,
        nodeVersion: info.protocolVersion,
        supported: SUPPORTED_PROTOCOL_VERSION,
      };
}
