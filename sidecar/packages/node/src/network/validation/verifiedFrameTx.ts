import { ts } from "@skandha/types/lib/index.js";
import { Config } from "@skandha/executor/lib/config";
import { GossipErrorCode, GossipValidationError } from "../gossip/errors.js";

export async function validateGossipVerifiedFrameTx(
  relayersConfig: Config,
  verifiedFrameTx: ts.VerifiedFrameTx
): Promise<void> {
  const blockHash = Number(verifiedFrameTx.verified_at_block_hash);
  const publicClient = relayersConfig.getPublicClient();
  const blockNumber = await publicClient.getBlockNumber();
  if (blockNumber == null || blockHash + 20 < blockNumber) {
    throw new GossipValidationError(GossipErrorCode.OUTDATED_USER_OP, "Old frame transaction");
  }
}
