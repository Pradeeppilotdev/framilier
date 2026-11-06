import { rpcCall, type RpcOptions } from "./client";
import {
  AdmissionPageSchema,
  ExplorerInfoSchema,
  FaucetResultSchema,
  PeerListSchema,
  ReputationPageSchema,
  TransactionDetailSchema,
  TransactionPageSchema,
} from "../protocol/schemas";

export interface ListTransactionsParams {
  status?: string;
  cursor?: string;
  limit?: number;
}

export interface ListAdmissionsParams {
  outcome?: "accepted" | "rejected" | "replaced" | "included" | "dropped";
  cursor?: string;
  limit?: number;
}

export interface ListReputationParams {
  cursor?: string;
  limit?: number;
}

/** Typed wrappers for the six read-only `skandha_explorer_*` methods, and the faucet. */
export const explorerApi = {
  info: (url: string, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_info", [], ExplorerInfoSchema, opts),

  listTransactions: (url: string, params: ListTransactionsParams = {}, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_listTransactions", [params], TransactionPageSchema, opts),

  listAdmissions: (url: string, params: ListAdmissionsParams = {}, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_listAdmissions", [params], AdmissionPageSchema, opts),

  getTransaction: (url: string, hash: string, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_getTransaction", [hash], TransactionDetailSchema, opts),

  peers: (url: string, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_peers", [], PeerListSchema, opts),

  listReputation: (url: string, params: ListReputationParams = {}, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_listReputation", [params], ReputationPageSchema, opts),

  /** Not read-only: asks the node to send the faucet amount to `address`. */
  faucet: (url: string, address: string, opts?: RpcOptions) =>
    rpcCall(url, "skandha_explorer_faucet", [address], FaucetResultSchema, opts),
};
