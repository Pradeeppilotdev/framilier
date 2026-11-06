import { Address, Hex, PublicClient, WalletClient, isAddress, parseEther } from "viem";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";

export const FAUCET_AMOUNT = parseEther("1");
/** One drip per address per window. */
export const FAUCET_ADDRESS_COOLDOWN_MS = 60 * 60 * 1000;
/** Drips per window across all addresses, so a script cannot drain the faucet account. */
export const FAUCET_GLOBAL_LIMIT = 100;
export const FAUCET_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * Sends a fixed amount of ETH from a dedicated faucet account. Requests are
 * serialized so the account's nonce never collides with itself, and limited
 * per address and overall. The account should hold only what you are willing
 * to give away: the limits slow a drain down, the balance bounds it.
 */
export class FaucetService {
  private lastDrip = new Map<string, number>();
  private recent: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private wallet: WalletClient,
    private publicClient: Pick<PublicClient, "getBalance">,
    private now: () => number = Date.now
  ) {}

  get amount(): bigint {
    return FAUCET_AMOUNT;
  }

  /** Sends the faucet amount to `to` and returns the transaction hash (not yet mined). */
  drip(to: unknown): Promise<Hex> {
    if (typeof to !== "string" || !isAddress(to, { strict: false })) {
      throw new RpcError("Expected an address", RpcErrorCodes.INVALID_REQUEST);
    }
    const address = to as Address;
    // Runs after earlier requests settle; a failure must not block the queue.
    const result = this.queue.then(() => this.send(address));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async send(to: Address): Promise<Hex> {
    const now = this.now();
    const key = to.toLowerCase();
    const last = this.lastDrip.get(key);
    if (last !== undefined && now - last < FAUCET_ADDRESS_COOLDOWN_MS) {
      const minutes = Math.ceil((FAUCET_ADDRESS_COOLDOWN_MS - (now - last)) / 60_000);
      throw new RpcError(
        `This address already received funds: try again in ${minutes} min`,
        RpcErrorCodes.INVALID_REQUEST
      );
    }
    this.recent = this.recent.filter((t) => now - t < FAUCET_GLOBAL_WINDOW_MS);
    if (this.recent.length >= FAUCET_GLOBAL_LIMIT) {
      throw new RpcError(
        "The faucet is rate limited right now: try again later",
        RpcErrorCodes.INVALID_REQUEST
      );
    }
    const account = this.wallet.account!;
    const balance = await this.publicClient.getBalance({ address: account.address });
    if (balance < FAUCET_AMOUNT) {
      throw new RpcError("The faucet is empty", RpcErrorCodes.INVALID_REQUEST);
    }
    const hash = await this.wallet.sendTransaction({
      account,
      chain: this.wallet.chain,
      to,
      value: FAUCET_AMOUNT,
    });
    this.lastDrip.set(key, now);
    this.recent.push(now);
    return hash;
  }
}
