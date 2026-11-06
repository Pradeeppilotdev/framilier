import { ValueOf } from "@chainsafe/ssz";
import { Executor } from "@skandha/executor/lib/executor";
import { Config } from "@skandha/executor/lib/config";
import { PeerId } from "@libp2p/interface";
import {
  PooledFrameTxHashesRequest as PooledFrameTxHashesRequestSsz,
  PooledFrameTxHashes as PooledFrameTxHashesSsz,
} from "@skandha/types/lib/node/frameTx.js";
import { IReqRespNode } from "./interface.js";

export async function pooledFrameTxHashes(
  reqResp: IReqRespNode,
  peerId: PeerId,
  executor: Executor,
  relayersConfig: Config,
  req: ValueOf<typeof PooledFrameTxHashesRequestSsz>
): Promise<ValueOf<typeof PooledFrameTxHashesSsz>> {
  return await reqResp.pooledFrameTxHashes(peerId, req);
}
