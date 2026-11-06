import { ValueOf } from "@chainsafe/ssz";
import {
  PooledFrameTxHashesRequest as PooledFrameTxHashesRequestSsz,
  PooledFrameTxHashes as PooledFrameTxHashesSsz,
} from "@skandha/types/lib/node/frameTx.js";
import {
  ContextBytesType,
  DuplexProtocolDefinitionGenerator,
  Encoding,
} from "../types.js";

// NOTE: `@skandha/types/lib/index.js`'s `ssz`/`ts` barrels only re-export
// `./sszTypes.js` (the legacy UserOp types) plus `VerifiedFrameTx`; the
// other frame-tx SSZ schemas live only in `@skandha/types/lib/node/frameTx.js`
// and are not wired into the package barrel, so we import them directly
// from that submodule here.
export const PooledFrameTxHashes: DuplexProtocolDefinitionGenerator<
  ValueOf<typeof PooledFrameTxHashesRequestSsz>,
  ValueOf<typeof PooledFrameTxHashesSsz>
> = (modules, handler) => {
  return {
    method: "pooled_frame_tx_hashes",
    version: 1,
    encoding: Encoding.SSZ_SNAPPY,
    requestType: () => PooledFrameTxHashesRequestSsz,
    responseType: () => PooledFrameTxHashesSsz,
    contextBytes: { type: ContextBytesType.Empty },
    handler,
    inboundRateLimits: {
      byPeer: { quota: 5, quotaTimeMs: 15_000 },
    },
  };
};
