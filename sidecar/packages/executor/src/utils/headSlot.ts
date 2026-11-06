import { PublicClient } from "viem";

/**
 * The beacon slot (EIP-7843 `slotNumber`) of the latest block, read from the
 * raw header: viem's block formatter does not know the field. `undefined`
 * when the chain does not report one, in which case EIP-8272 slot checks are
 * left to the execution client.
 */
export async function getHeadSlot(
  publicClient: PublicClient
): Promise<bigint | undefined> {
  const block = (await publicClient.request({
    method: "eth_getBlockByNumber",
    params: ["latest", false],
  })) as { slotNumber?: `0x${string}` } | null;
  return block?.slotNumber ? BigInt(block.slotNumber) : undefined;
}
