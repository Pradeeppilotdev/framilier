import { ValueOf } from "@chainsafe/ssz";
import { Executor } from "@skandha/executor/lib/executor";
import { Config } from "@skandha/executor/lib/config";
import { PeerId } from "@libp2p/interface";
import {
  PooledFrameTxsByHashRequest as PooledFrameTxsByHashRequestSsz,
  PooledFrameTxsByHash as PooledFrameTxsByHashSsz,
} from "@skandha/types/lib/node/frameTx.js";
import { IReqRespNode } from "./interface.js";

export async function pooledFrameTxsByHash(
  reqResp: IReqRespNode,
  peerId: PeerId,
  executor: Executor,
  relayersConfig: Config,
  req: ValueOf<typeof PooledFrameTxsByHashRequestSsz>
): Promise<ValueOf<typeof PooledFrameTxsByHashSsz>> {
  return await reqResp.pooledFrameTxsByHash(peerId, req);
}
