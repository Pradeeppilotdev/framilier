import { ValueOf } from "@chainsafe/ssz";
import {
  PooledFrameTxsByHashRequest as PooledFrameTxsByHashRequestSsz,
  PooledFrameTxsByHash as PooledFrameTxsByHashSsz,
} from "@skandha/types/lib/node/frameTx.js";
import {
  ContextBytesType,
  DuplexProtocolDefinitionGenerator,
  Encoding,
} from "../types.js";

// See PooledFrameTxHashes.ts for why these are imported directly from the
// `node/frameTx.js` submodule rather than the package's `ssz`/`ts` barrel.
export const PooledFrameTxsByHash: DuplexProtocolDefinitionGenerator<
  ValueOf<typeof PooledFrameTxsByHashRequestSsz>,
  ValueOf<typeof PooledFrameTxsByHashSsz>
> = (modules, handler) => {
  return {
    method: "pooled_frame_txs_by_hash",
    // v2: the response's FrameTransaction carries EIP-8250 nonce_keys/
    // nonce_seq and EIP-8272 recent_root_references. v1 peers cannot decode
    // it, so they fail protocol negotiation instead of mis-decoding.
    version: 2,
    encoding: Encoding.SSZ_SNAPPY,
    requestType: () => PooledFrameTxsByHashRequestSsz,
    responseType: () => PooledFrameTxsByHashSsz,
    contextBytes: { type: ContextBytesType.Empty },
    handler,
    inboundRateLimits: {
      byPeer: { quota: 5, quotaTimeMs: 15_000 },
    },
  };
};
