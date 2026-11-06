import { ts } from "@skandha/types/lib/index.js";
import { NodeAPIModules } from "./types.js";

export default function api(modules: NodeAPIModules) {
  return async function publishVerifiedFrameTx(
    verifiedFrameTx: ts.VerifiedFrameTx,
    mempool: string
  ): Promise<void> {
    await modules.network.publishVerifiedFrameTx(verifiedFrameTx, mempool);
  };
}
