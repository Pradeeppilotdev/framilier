import { ts } from "..";
import { FrameTransaction } from "../contracts/FrameTx.js";

export interface INodeAPI {
  publishVerifiedFrameTx(
    verifiedFrameTx: ts.VerifiedFrameTx,
    mempool: string
  ): Promise<void>;
  publishVerifiedFrameTxJSON(
    entryPoint: string,
    tx: FrameTransaction,
    blockHash: string,
    mempool: string
  ): Promise<void>;
  getConnectedPeers(): unknown[]
}
