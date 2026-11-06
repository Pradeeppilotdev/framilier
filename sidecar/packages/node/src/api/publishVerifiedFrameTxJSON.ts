import { toVerifiedFrameTx } from "@skandha/params/lib/utils/frameTx";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import { NodeAPIModules } from "./types.js";

export default function api(modules: NodeAPIModules) {
  return async function publishVerifiedFrameTxJSON(
    entryPoint: string,
    tx: FrameTransaction,
    blockHash: string,
    mempool: string
  ): Promise<void> {
    const verifiedFrameTx = toVerifiedFrameTx(entryPoint, tx, blockHash);
    await modules.network.publishVerifiedFrameTx(verifiedFrameTx, mempool);
  };
}
