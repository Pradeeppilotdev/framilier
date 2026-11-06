import { ValueOf } from "@chainsafe/ssz";
import { ts } from "@skandha/types/lib/index.js";
import {
  PooledFrameTxHashesRequest as PooledFrameTxHashesRequestSsz,
  PooledFrameTxsByHashRequest as PooledFrameTxsByHashRequestSsz,
} from "@skandha/types/lib/node/frameTx.js";

export enum ReqRespMethod {
  Status = "status",
  Goodbye = "goodbye",
  Ping = "ping",
  Metadata = "metadata",
  PooledFrameTxHashes = "pooled_frame_tx_hashes",
  PooledFrameTxsByHash = "pooled_frame_txs_by_hash",
}

type RequestBodyByMethod = {
  [ReqRespMethod.Status]: ts.Status;
  [ReqRespMethod.Goodbye]: ts.Goodbye;
  [ReqRespMethod.Ping]: ts.Ping;
  [ReqRespMethod.Metadata]: null;
  [ReqRespMethod.PooledFrameTxHashes]: ValueOf<
    typeof PooledFrameTxHashesRequestSsz
  >;
  [ReqRespMethod.PooledFrameTxsByHash]: ValueOf<
    typeof PooledFrameTxsByHashRequestSsz
  >;
};

export type RequestTypedContainer = {
  [K in ReqRespMethod]: { method: K; body: RequestBodyByMethod[K] };
}[ReqRespMethod];

export enum Version {
  V1 = 1,
  V2 = 2,
}
