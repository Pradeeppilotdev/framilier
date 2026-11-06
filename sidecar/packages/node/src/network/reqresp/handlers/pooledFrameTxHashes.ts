import { ValueOf } from "@chainsafe/ssz";
import { Config } from "@skandha/executor/lib/config";
import { Executor } from "@skandha/executor/lib/executor";
import { MAX_OPS_PER_REQUEST } from "@skandha/types/lib/sszTypes";
import logger from "@skandha/api/lib/logger";
import { userOpHashToBytes } from "@skandha/params/lib/utils/userOp";
import {
  PooledFrameTxHashesRequest as PooledFrameTxHashesRequestSsz,
  PooledFrameTxHashes as PooledFrameTxHashesSsz,
} from "@skandha/types/lib/node/frameTx.js";
import { EncodedPayload, EncodedPayloadType } from "../../../reqresp/types.js";

// Reads directly from `executor.mempoolService` - there is no P2PService
// (or equivalent) layer between the reqresp handler and the mempool.
export async function* onPooledFrameTxHashes(
  executor: Executor,
  relayersConfig: Config,
  req: ValueOf<typeof PooledFrameTxHashesRequestSsz>
): AsyncIterable<EncodedPayload<ValueOf<typeof PooledFrameTxHashesSsz>>> {
  const offset = Number(req.cursor);
  const entries = await executor.mempoolService.getNewEntriesSorted(
    MAX_OPS_PER_REQUEST,
    offset
  );
  const hasMore = entries.length === MAX_OPS_PER_REQUEST;
  const nextCursor = hasMore ? entries.length + offset : 0;
  const hashes = entries
    .map((entry) => entry.txHash)
    .filter((hash): hash is string => !!hash && hash.length === 66);

  logger.debug(
    `Sending: ${JSON.stringify(
      {
        next_cursor: nextCursor,
        hashes,
      },
      undefined,
      2
    )}`
  );

  const data = PooledFrameTxHashesSsz.defaultValue();
  data.next_cursor = BigInt(nextCursor);
  data.hashes = hashes.map((hash) => userOpHashToBytes(hash));

  yield { type: EncodedPayloadType.ssz, data };
}
