import { Config } from "@skandha/executor/lib/config";
import { Executor } from "@skandha/executor/lib/executor";
import { AllChainsMetrics } from "@skandha/monitoring/lib/index.js";
import * as protocols from "../../../reqresp/protocols/index.js";
import { HandlerTypeFromMessage } from "../../../reqresp/types.js";
import { onStatus } from "./status.js";
import { onPooledFrameTxHashes } from "./pooledFrameTxHashes.js";
import { onPooledFrameTxsByHash } from "./pooledFrameTxsByHash.js";

export interface ReqRespHandlers {
  onStatus: HandlerTypeFromMessage<typeof protocols.Status>;
  onPooledFrameTxHashes: HandlerTypeFromMessage<
    typeof protocols.PooledFrameTxHashes
  >;
  onPooledFrameTxsByHash: HandlerTypeFromMessage<
    typeof protocols.PooledFrameTxsByHash
  >;
}

export function getReqRespHandlers(
  executor: Executor,
  config: Config,
  metrics: AllChainsMetrics | null
): ReqRespHandlers {
  return {
    async *onStatus() {
      yield* onStatus(config);
    },
    async *onPooledFrameTxHashes(req) {
      yield* onPooledFrameTxHashes(executor, config, req);
    },
    async *onPooledFrameTxsByHash(req) {
      yield* onPooledFrameTxsByHash(executor, config, req, metrics);
    },
  };
}
