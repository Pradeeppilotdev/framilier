import RpcError from "@skandha/types/lib/api/errors/rpc-error";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { getContract, Hex, keccak256, PublicClient } from "viem";
import {
  BundlingService,
  MempoolService,
  ReputationService,
} from "../services/index.js";
import { encodeRawFrameTx } from "../services/FrameTxService/codec.js";
import {
  FrameTransactionSerialized,
  FrameTxMempoolEntrySerialized,
  ReputationEntryDump,
} from "../entities/interfaces.js";
import { BundlingMode, GetStakeStatus, NetworkConfig } from "../interfaces.js";
import { SetReputationArgs, SetMempoolArgs } from "./interfaces.js";
/*
  SPEC: https://eips.ethereum.org/EIPS/eip-4337#rpc-methods-debug-namespace

  There is no `entryPointService`: `getFactory`/`getPaymaster`/
  `getUserOpHash` used to resolve ERC-4337-specific `initCode`/
  `paymasterAndData` fields that have no `FrameTransaction` analogue.
  `FrameTxMempoolEntry` resolves `sender`/`payer`/`factory` itself from the
  transaction's validation prefix, so `setMempool` doesn't need to compute
  them by hand.
*/
export class Debug {
  constructor(
    private publicClient: PublicClient,
    private bundlingService: BundlingService,
    private mempoolService: MempoolService,
    private reputationService: ReputationService,
    private networkConfig: NetworkConfig
  ) {}

  /**
   * Sets bundling mode.
   * After setting mode to “manual”, an explicit call to debug_bundler_sendBundleNow is required to send a bundle.
   */
  async setBundlingMode(mode: BundlingMode): Promise<string> {
    if (mode !== "auto" && mode !== "manual") {
      throw new RpcError(
        "Method is not supported",
        RpcErrorCodes.INVALID_REQUEST
      );
    }
    this.bundlingService.setBundlingMode(mode);
    return "ok";
  }

  /**
   * Clears the bundler mempool and reputation data of paymasters/accounts/factories/aggregators
   */
  async clearState(): Promise<string> {
    await this.mempoolService.clearState();
    await this.reputationService.clearState();
    return "ok";
  }

  /**
   * Clears the bundler mempool
   */
  async clearMempool(): Promise<string> {
    await this.mempoolService.clearState();
    return "ok";
  }

  /**
   * Dumps the current frame transactions mempool.
   * array - Array of (serialized) FrameTransactions currently in the mempool
   */
  async dumpMempool(): Promise<FrameTransactionSerialized[]> {
    const entries = await this.mempoolService.dump();
    return entries
      .filter((entry) => entry.status === MempoolEntryStatus.New)
      .map((entry) => entry.tx);
  }

  /**
   * Dumps the current frame transactions mempool (raw, serialized entries).
   * array - Array of serialized mempool entries currently in the mempool
   */
  async dumpMempoolRaw(): Promise<FrameTxMempoolEntrySerialized[]> {
    const entries = await this.mempoolService.dump();
    return entries.map((entry) => entry);
  }

  /**
   * Forces the bundler to build and execute a bundle from the mempool as handleOps() transaction
   */
  async sendBundleNow(): Promise<string> {
    await this.bundlingService.sendNextBundle();
    return "ok";
  }

  async setBundlingInterval(interval: number): Promise<string> {
    this.bundlingService.setBundlingInverval(interval);
    return "ok";
  }

  /**
   * Test-only admin lever: see `BundlingService.setPrivilegedRelayTargetBlock`/
   * `PrivilegedRelayer.setTargetBlock`'s own doc comments.
   */
  async setPrivilegedRelayTargetBlock(
    txHash: Hex,
    targetBlock: Hex
  ): Promise<string> {
    this.bundlingService.setPrivilegedRelayTargetBlock(
      txHash,
      BigInt(targetBlock)
    );
    return "ok";
  }

  /**
   * Sets reputation of given addresses. parameters:
   * An array of reputation entries to add/replace, with the fields:
   * reputations - An array of reputation entries to add/replace, with the fields:
   *        address - The address to set the reputation for.
   *        opsSeen - number of times a user operations with that entity was seen and added to the mempool
   *        opsIncluded - number of times a user operations that uses this entity was included on-chain
   *        status? - (string) The status of the address in the bundler ‘ok’
   * entryPoint the entrypoint used by eth_sendUserOperation
   */
  async setReputation(args: SetReputationArgs): Promise<string> {
    for (const reputation of args.reputations) {
      await this.reputationService.setReputation(
        reputation.address,
        reputation.opsSeen,
        reputation.opsIncluded
      );
    }
    return "ok";
  }

  /**
   * Returns the reputation data of all observed addresses.
   * Returns an array of reputation objects, each with the fields described above in debug_bundler_setReputation with the
   * entryPoint - The entrypoint used by eth_sendUserOperation
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async dumpReputation(entryPoint: string): Promise<ReputationEntryDump[]> {
    return await this.reputationService.dump();
  }

  /**
   * `FrameTxMempoolEntry` resolves `sender`/`payer`/`factory` itself from
   * the transaction's own validation prefix, so this doesn't need to
   * compute them by hand (no `entryPoint`/`getFactory`/`getPaymaster`/
   * `getUserOpHash` concept for a frame transaction). The transaction hash
   * is the real EIP-2718 envelope hash (`keccak256(0x06 || rlp(fields))`,
   * `encodeRawFrameTx`), matching `eth.ts`'s `sendFrameTransaction`
   * precedent - not `computeSigHash`, which elides signature bytes for
   * pre-signature signing use only. Per-role `StakeInfo` is intentionally
   * omitted (`addFrameTx(tx, txHash)`, no 3rd-6th args): this endpoint
   * explicitly bypasses simulation/validation ("without simulation" is this
   * method's whole point), so there is no simulated trace to derive
   * `StakeInfo` from here either - same documented gap `addFrameTx`'s own
   * doc comment already covers.
   */
  async setMempool(mempool: SetMempoolArgs): Promise<string> {
    const { txs } = mempool;
    await this.mempoolService.clearState();
    // Loop through the array and persist to the local mempool without simulation.
    for (const tx of txs) {
      const txHash = keccak256(encodeRawFrameTx(tx));
      await this.mempoolService.addFrameTx(tx, txHash);
    }
    return "ok";
  }

  async getStakeStatus(address: Hex, entryPoint: Hex): Promise<GetStakeStatus> {
    // Same minimal ABI as StakingRegistryService's own getDepositInfo call.
    const sm = getContract({
      abi: [
        {
          type: "function",
          name: "getDepositInfo",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [
            { name: "stake", type: "uint256" },
            { name: "unstakeDelaySec", type: "uint32" },
            { name: "withdrawTime", type: "uint64" },
          ],
        },
      ] as const,
      address: entryPoint,
      client: this.publicClient,
    });
    // getContract().read on a plain (non-typechain) ABI returns a
    // positional tuple, not named properties - matches
    // StakingRegistryService's own getDepositInfo call.
    const [stake, unstakeDelaySec, withdrawTime] = (await sm.read.getDepositInfo([
      address,
    ])) as unknown as [bigint, number, bigint];
    const isStaked =
      stake >= this.networkConfig.minStake &&
      unstakeDelaySec >= this.networkConfig.minUnstakeDelay &&
      withdrawTime === BigInt(0);
    return {
      stakeInfo: {
        addr: address,
        stake: stake.toString(),
        unstakeDelaySec: unstakeDelaySec.toString(),
        withdrawTime: withdrawTime.toString(),
      },
      isStaked,
    };
  }

  /**
   * Clears the reputation data of paymasters/accounts/factories/aggregators
   */
  async clearReputation(): Promise<string> {
    await this.reputationService.clearState();
    return "ok";
  }
}
