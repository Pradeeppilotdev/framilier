import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import { INVALID_USEROP } from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { ts } from "@skandha/types/lib/index.js";
import logger from "@skandha/api/lib/logger";
import { Config } from "@skandha/executor/lib/config";
import { deserializeVerifiedFrameTx } from "@skandha/params/lib/utils/frameTx";
import { AllChainsMetrics } from "@skandha/monitoring/lib/index.js";
import { Executor } from "@skandha/executor/lib/executor";
import { GossipHandlers, GossipType } from "../gossip/interface.js";
import { validateGossipVerifiedFrameTx } from "../validation/index.js";
import { NetworkEventBus } from "../events.js";
import { GossipValidationError } from "../gossip/errors.js";

export type ValidatorFnsModules = {
  relayersConfig: Config;
  events: NetworkEventBus;
  executor: Executor;
  metrics: AllChainsMetrics | null;
};

export function getGossipHandlers(
  modules: ValidatorFnsModules
): GossipHandlers {
  const { relayersConfig, executor } = modules;
  async function validateVerifiedFrameTx(
    verifiedFrameTx: ts.VerifiedFrameTx,
    mempool: string,
    peerIdStr: string,
    seenTimestampSec: number
  ): Promise<boolean> {
    logger.info(
      {
        mempool,
        peerIdStr,
        seenTimestampSec,
      },
      "Received gossip block"
    );
    try {
      await validateGossipVerifiedFrameTx(relayersConfig, verifiedFrameTx);
      logger.debug("Validation successful");
      return true;
    } catch (err) {
      if (err instanceof GossipValidationError) {
        logger.debug(`${err.code}: ${err.message}`);
      } else {
        logger.debug(err);
      }
      return false;
    }
  }

  async function handleValidVerifiedFrameTx(
    verifiedFrameTx: ts.VerifiedFrameTx,
    mempool: string,
    peerIdStr: string,
    seenTimestampSec: number
  ): Promise<void> {
    try {
      const { tx } = deserializeVerifiedFrameTx(verifiedFrameTx);

      const { txHash, added } = await executor.eth.submitFrameTransaction(
        tx,
        `gossip:${peerIdStr}`
      );
      if (!added) return;
      logger.debug(`Processed frame tx: ${txHash}`);
      if (modules.metrics) {
        modules.metrics[executor.chainId].useropsReceived?.inc();
      }
    } catch (err) {
      if (err instanceof RpcError && err.code === INVALID_USEROP) {
        logger.debug(`Ignoring rejected peer transaction: ${err.message}`);
      } else {
        logger.error(`Could not process frame tx: ${err}`);
      }
    }
  }

  return {
    [GossipType.frame_transaction]: async (
      verifiedFrameTx,
      topic,
      peerIdStr,
      seenTimestampSec
    ) => {
      if (
        await validateVerifiedFrameTx(
          verifiedFrameTx,
          topic.mempool,
          peerIdStr,
          seenTimestampSec
        )
      ) {
        await handleValidVerifiedFrameTx(
          verifiedFrameTx,
          topic.mempool,
          peerIdStr,
          seenTimestampSec
        );
      }
    },
  };
}
