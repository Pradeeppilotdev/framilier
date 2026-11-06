import { describe, expect, it, vi } from "vitest";
import {
  FAUCET_ADDRESS_COOLDOWN_MS,
  FAUCET_AMOUNT,
  FAUCET_GLOBAL_LIMIT,
  FaucetService,
} from "../../../src/services/FaucetService/index.js";

const FAUCET = "0x1111111111111111111111111111111111111111";
const ADDRESS = "0x5544596212F91984C986A919C8026DF0576816f9";

function setup(balance = FAUCET_AMOUNT * 10n) {
  let now = 1_000_000;
  const sendTransaction = vi.fn(async () => "0xabc" as const);
  const wallet = { account: { address: FAUCET }, chain: undefined, sendTransaction } as any;
  const publicClient = { getBalance: vi.fn(async () => balance) };
  const faucet = new FaucetService(wallet, publicClient, () => now);
  return { faucet, sendTransaction, advance: (ms: number) => (now += ms) };
}

describe("FaucetService", () => {
  it("sends 1 ETH to a valid address and returns the hash", async () => {
    const { faucet, sendTransaction } = setup();
    await expect(faucet.drip(ADDRESS)).resolves.toBe("0xabc");
    expect(sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: ADDRESS, value: 10n ** 18n })
    );
  });

  it("rejects what is not an address", async () => {
    const { faucet, sendTransaction } = setup();
    for (const bad of [undefined, 5, "0x123", "nope"]) {
      await expect(Promise.resolve().then(() => faucet.drip(bad))).rejects.toThrow("Expected an address");
    }
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("allows one drip per address per window, whatever the casing", async () => {
    const { faucet, advance } = setup();
    await faucet.drip(ADDRESS);
    await expect(faucet.drip(ADDRESS.toLowerCase())).rejects.toThrow("already received");
    advance(FAUCET_ADDRESS_COOLDOWN_MS);
    await expect(faucet.drip(ADDRESS)).resolves.toBe("0xabc");
  });

  it("caps drips across all addresses", async () => {
    const { faucet } = setup(FAUCET_AMOUNT * 1000n);
    for (let i = 0; i < FAUCET_GLOBAL_LIMIT; i++) {
      await faucet.drip(`0x${i.toString(16).padStart(40, "0")}`);
    }
    await expect(faucet.drip(`0x${"f".repeat(40)}`)).rejects.toThrow("rate limited");
  });

  it("refuses when the faucet account is empty, and does not use up the address's turn", async () => {
    const { faucet, sendTransaction } = setup(FAUCET_AMOUNT - 1n);
    await expect(faucet.drip(ADDRESS)).rejects.toThrow("empty");
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
