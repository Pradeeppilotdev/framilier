import { isHex, toHex } from "viem";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { BundlingMode } from "@skandha/types/lib/api/interfaces";
import { MempoolEntryStatus, ReputationStatus } from "@skandha/types/lib/executor";
import { SkandhaVersion } from "@skandha/types/lib/executor/index.js";
import {
  AdmissionOutcome,
  AdmissionRecord,
  EXPLORER_PROTOCOL_VERSION,
  ExplorerInfo,
  ExplorerPeer,
  ExplorerReputationEntry,
  ExplorerReputationStatus,
  ExplorerTransactionDetail,
  ExplorerTransactionSummary,
  Page,
} from "@skandha/types/lib/explorer/index.js";
import { FrameTxMempoolEntry } from "../entities/FrameTxMempoolEntry.js";
import { GetNodeAPI } from "../interfaces.js";
import { MempoolService } from "../services/MempoolService/service.js";
import { ExplorerService } from "../services/ExplorerService/service.js";
import { ReputationService } from "../services/ReputationService.js";
import { StakingRegistryService } from "../services/StakingRegistryService/index.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const OUTCOMES: AdmissionOutcome[] = [
  "accepted",
  "rejected",
  "replaced",
  "included",
  "dropped",
];
const REPUTATION_STATUS: Record<ReputationStatus, ExplorerReputationStatus> = {
  [ReputationStatus.OK]: "ok",
  [ReputationStatus.THROTTLED]: "throttled",
  [ReputationStatus.BANNED]: "banned",
};

function clampLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

function invalid(message: string): RpcError {
  return new RpcError(message, RpcErrorCodes.INVALID_REQUEST);
}

/**
 * Read-only explorer RPC surface (`skandha_explorer_*`). Every method is
 * unavailable (METHOD_NOT_FOUND) unless the node was started with
 * `--explorer.enable`, which is what supplies `explorerService`.
 *
 * Results are plain JSON: numbers stay numbers, quantities that can exceed
 * 2^53 are `0x` hex strings. The API layer must not `deepHexlify` them.
 */
export class Explorer {
  constructor(
    private chainId: number,
    private version: SkandhaVersion,
    private bundlingService: { getBundlingMode(): BundlingMode },
    private mempoolService: Pick<MempoolService, "listAll" | "getEntryByHash">,
    private explorerService: ExplorerService | null,
    private getNodeAPI: GetNodeAPI,
    private reputationService: Pick<ReputationService, "dump" | "isWhitelisted" | "isBlacklisted">,
    private stakingRegistryService: Pick<StakingRegistryService, "getDepositInfo">,
    private minStake: bigint,
    private minUnstakeDelay: number,
    private minInclusionDenominator: number,
    private throttlingSlack: number,
    private banSlack: number,
    private faucetEnabled = false
  ) {}

  private service(): ExplorerService {
    if (!this.explorerService) {
      throw new RpcError(
        "Explorer is disabled: start the node with --explorer.enable",
        RpcErrorCodes.METHOD_NOT_FOUND
      );
    }
    return this.explorerService;
  }

  info(): ExplorerInfo {
    const service = this.service();
    return {
      protocolVersion: EXPLORER_PROTOCOL_VERSION,
      chainId: this.chainId,
      version: this.version.version,
      commit: this.version.commit,
      bundlingMode: this.bundlingService.getBundlingMode(),
      p2pEnabled: this.getNodeAPI() != null,
      latestSeq: service.latestSeq(),
      oldestSeq: service.oldestSeq(),
      historyCapacity: service.historyCapacity,
      bootId: service.bootId,
      minInclusionDenominator: this.minInclusionDenominator,
      throttlingSlack: this.throttlingSlack,
      banSlack: this.banSlack,
      ...(this.faucetEnabled ? { faucetEnabled: true } : {}),
    };
  }

  async listTransactions(
    params: { status?: string; cursor?: string; limit?: number } = {}
  ): Promise<Page<ExplorerTransactionSummary>> {
    this.service();
    let wanted: MempoolEntryStatus | undefined;
    if (params.status !== undefined) {
      wanted =
        MempoolEntryStatus[params.status as keyof typeof MempoolEntryStatus];
      if (typeof wanted !== "number") {
        throw invalid(`Unknown status: ${params.status}`);
      }
    }
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    if (!Number.isInteger(offset) || offset < 0) {
      throw invalid(`Invalid cursor: ${params.cursor}`);
    }
    const limit = clampLimit(params.limit);

    const entries = (await this.mempoolService.listAll())
      .filter((e) => wanted === undefined || e.status === wanted)
      .sort(
        (a, b) =>
          (b.submittedTime ?? b.lastUpdatedTime) -
          (a.submittedTime ?? a.lastUpdatedTime)
      );
    const items = entries
      .slice(offset, offset + limit)
      .map((e) => this.summary(e));
    return offset + limit < entries.length
      ? { items, nextCursor: String(offset + limit) }
      : { items };
  }

  listAdmissions(
    params: { outcome?: AdmissionOutcome; cursor?: string; limit?: number } = {}
  ): Page<AdmissionRecord> {
    const service = this.service();
    if (params.outcome !== undefined && !OUTCOMES.includes(params.outcome)) {
      throw invalid(`Unknown outcome: ${params.outcome}`);
    }
    if (
      params.cursor !== undefined &&
      !Number.isFinite(Number(params.cursor))
    ) {
      throw invalid(`Invalid cursor: ${params.cursor}`);
    }
    return service.listAdmissions({
      outcome: params.outcome,
      cursor: params.cursor,
      limit: clampLimit(params.limit),
    });
  }

  /**
   * Unlike every other explorer method, this one fans out to the execution
   * client: up to `limit` (default 50, capped 200) concurrent
   * `getDepositInfo` on-chain reads per call, from an unauthenticated caller
   * that the UI's own polling (`useReputation`) hits repeatedly. Acceptable
   * at devnet scale; revisit (cache deposit info, or cap concurrency) before
   * running this against a node with real request volume.
   */
  async listReputation(
    params: { cursor?: string; limit?: number } = {}
  ): Promise<Page<ExplorerReputationEntry>> {
    this.service();
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    if (!Number.isInteger(offset) || offset < 0) {
      throw invalid(`Invalid cursor: ${params.cursor}`);
    }
    const limit = clampLimit(params.limit);

    const dump = (await this.reputationService.dump()).sort((a, b) =>
      a.address.toLowerCase().localeCompare(b.address.toLowerCase())
    );
    const page = dump.slice(offset, offset + limit);
    const items = await Promise.all(
      page.map(async (entry): Promise<ExplorerReputationEntry> => {
        const deposit = await this.stakingRegistryService.getDepositInfo(
          entry.address as `0x${string}`
        );
        const isStaked =
          deposit.stake >= this.minStake &&
          deposit.unstakeDelaySec >= this.minUnstakeDelay &&
          deposit.withdrawTime === BigInt(0);
        return {
          address: entry.address,
          opsSeen: entry.opsSeen,
          opsIncluded: entry.opsIncluded,
          status: REPUTATION_STATUS[entry.status],
          isWhitelisted: await this.reputationService.isWhitelisted(entry.address),
          isBlacklisted: await this.reputationService.isBlacklisted(entry.address),
          stake: toHex(deposit.stake),
          unstakeDelaySec: deposit.unstakeDelaySec,
          withdrawTime: toHex(deposit.withdrawTime),
          isStaked,
        };
      })
    );
    return offset + limit < dump.length
      ? { items, nextCursor: String(offset + limit) }
      : { items };
  }

  async getTransaction(hash: string): Promise<ExplorerTransactionDetail> {
    const service = this.service();
    if (
      typeof hash !== "string" ||
      !isHex(hash, { strict: true }) ||
      hash.length !== 66
    ) {
      throw invalid("Expected a 32-byte hex transaction hash");
    }
    const normalized = hash.toLowerCase();
    const entry = await this.mempoolService.getEntryByHash(normalized);
    const admission = service.getAdmission(normalized) ?? null;
    const events = service.getEvents(normalized);
    if (!entry && !admission && events.length === 0) {
      throw invalid("Frame transaction not found");
    }
    return {
      hash: normalized,
      entry: entry
        ? {
            ...this.summary(entry),
            tx: entry.serialize().tx as unknown as Record<string, unknown>,
            revertReason: entry.revertReason,
            transaction: entry.actualTransaction ?? entry.transaction,
          }
        : null,
      admission,
      events,
    };
  }

  peers(): ExplorerPeer[] {
    this.service();
    const nodeApi = this.getNodeAPI();
    if (!nodeApi) return [];
    return nodeApi.getConnectedPeers().map((raw) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = raw as Record<string, any>;
      return {
        peerId: String(p.peerId),
        direction: typeof p.direction === "string" ? p.direction : "unknown",
        connectedAt: Number(p.connectedUnixTsMs ?? 0),
        lastReceivedAt: Number(p.lastReceivedMsgUnixTsMs ?? 0),
        agentVersion: p.agentVersion ?? null,
        supportedMempools: Array.isArray(p.metadata?.supported_mempools)
          ? p.metadata.supported_mempools.map(String)
          : [],
      };
    });
  }

  private summary(entry: FrameTxMempoolEntry): ExplorerTransactionSummary {
    const source = this.explorerService?.getAdmission(
      (entry.txHash ?? "").toLowerCase()
    )?.source;
    return {
      txHash: entry.txHash ?? "",
      sender: entry.sender,
      payer: entry.payer,
      factory: entry.factory,
      nonce: toHex(entry.tx.nonceSeq),
      nonceKeys: entry.tx.nonceKeys.map((k) => toHex(k)),
      status: MempoolEntryStatus[entry.status],
      frames: entry.tx.frames.length,
      maxFeePerGas: toHex(entry.tx.fees.maxFeePerGas),
      submittedTime: entry.submittedTime,
      lastUpdatedTime: entry.lastUpdatedTime,
      ...(source === undefined ? {} : { source }),
    };
  }
}
