import { ValueOf } from "@chainsafe/ssz";
import { Config } from "@skandha/executor/lib/config";
import { Executor } from "@skandha/executor/lib/executor";
import { userOpHashToString } from "@skandha/params/lib/utils/userOp";
import { serializeFrameTx } from "@skandha/params/lib/utils/frameTx";
import logger from "@skandha/api/lib/logger";
import { AllChainsMetrics } from "@skandha/monitoring/lib/index.js";
import {
  PooledFrameTxsByHashRequest as PooledFrameTxsByHashRequestSsz,
  PooledFrameTxsByHash as PooledFrameTxsByHashSsz,
} from "@skandha/types/lib/node/frameTx.js";
import { EncodedPayload, EncodedPayloadType } from "../../../reqresp/types.js";

// Reads directly from `executor.mempoolService`, same as
// pooledFrameTxHashes.ts.
//
// No "which EntryPoint" filtering is applied here: under EIP-8141 there is
// exactly one fixed `ENTRY_POINT` sentinel address
// (`packages/types/src/contracts/FrameTx.ts`), not a configurable/
// per-request set, so a mempool entry has no alternate EntryPoint it could
// need to be filtered against.
export async function* onPooledFrameTxsByHash(
  executor: Executor,
  relayersConfig: Config,
  req: ValueOf<typeof PooledFrameTxsByHashRequestSsz>,
  metrics: AllChainsMetrics | null
): AsyncIterable<EncodedPayload<ValueOf<typeof PooledFrameTxsByHashSsz>>> {
  const hashes = req.hashes.map((hash) => userOpHashToString(hash));
  logger.debug(`PooledFrameTxsByHash, received hashes: ${hashes.join(", ")}`);

  const frameTxs: ValueOf<typeof PooledFrameTxsByHashSsz> = [];
  for (const hash of hashes) {
    const entry = await executor.mempoolService.getEntryByHash(hash);
    if (!entry) continue;

    frameTxs.push(serializeFrameTx(entry.tx));
  }

  logger.debug(`PooledFrameTxsByHash, found frame txs: ${frameTxs.length}`);

  if (metrics)
    metrics[relayersConfig.chainId].useropsSent?.inc(frameTxs.length);

  yield {
    type: EncodedPayloadType.ssz,
    data: frameTxs,
  };
}
