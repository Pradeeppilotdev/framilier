import { INodeAPI } from "@skandha/types/lib/node";
import { NodeAPIModules } from "./types.js";
import publishVerifiedFrameTx from "./publishVerifiedFrameTx.js";
import publishVerifiedFrameTxJSON from "./publishVerifiedFrameTxJSON.js";
import getConnectedPeers from "./peers.js";

export function getApi(modules: NodeAPIModules): INodeAPI {
  return {
    publishVerifiedFrameTx: publishVerifiedFrameTx(modules),
    publishVerifiedFrameTxJSON: publishVerifiedFrameTxJSON(modules),
    getConnectedPeers: getConnectedPeers(modules)
  };
}
