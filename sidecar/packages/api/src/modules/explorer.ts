import { Explorer } from "@skandha/executor/lib/modules";
import { FaucetService } from "@skandha/executor/lib/services";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import {
  AdmissionOutcome,
  AdmissionRecord,
  ExplorerInfo,
  ExplorerPeer,
  ExplorerReputationEntry,
  ExplorerTransactionDetail,
  ExplorerTransactionSummary,
  Page,
} from "@skandha/types/lib/explorer/index.js";

/** Thin wrapper over the executor's read-only `Explorer` module. */
export class ExplorerAPI {
  constructor(
    private explorer: Explorer,
    private faucet: FaucetService | null = null
  ) {}

  info(): ExplorerInfo {
    return this.explorer.info();
  }

  listTransactions(params?: {
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ExplorerTransactionSummary>> {
    return this.explorer.listTransactions(params ?? {});
  }

  listAdmissions(params?: {
    outcome?: AdmissionOutcome;
    cursor?: string;
    limit?: number;
  }): Page<AdmissionRecord> {
    return this.explorer.listAdmissions(params ?? {});
  }

  getTransaction(hash: string): Promise<ExplorerTransactionDetail> {
    return this.explorer.getTransaction(hash);
  }

  peers(): ExplorerPeer[] {
    return this.explorer.peers();
  }

  listReputation(params?: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<ExplorerReputationEntry>> {
    return this.explorer.listReputation(params ?? {});
  }

  /** Sends the faucet amount to `address`. The one explorer method that changes chain state. */
  async faucetDrip(address: unknown): Promise<{ txHash: string; amount: string }> {
    if (!this.faucet) {
      throw new RpcError(
        "Faucet is disabled: start the node with --explorer.enable and SKANDHA_FAUCET_KEY",
        RpcErrorCodes.METHOD_NOT_FOUND
      );
    }
    const txHash = await this.faucet.drip(address);
    return { txHash, amount: this.faucet.amount.toString() };
  }
}
