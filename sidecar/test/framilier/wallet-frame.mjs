import { concatHex, keccak256, toHex } from "viem";
import { sign } from "viem/accounts";
import { computeSigHash } from "../../packages/executor/lib/services/FrameTxService/codec.js";

export function hashChain(rounds) {
  // Fixed input shared by the archived and new hash-chain runs.
  const witness = "0x0561fba5e50f309ae6fcd4c6f7b27a2e0225d4befcfe7c5e636308d3ed56a289";
  let commitment = witness;
  for (let i = 0; i < rounds; i++) commitment = keccak256(commitment);
  return { witness, commitment };
}

export async function signedWalletFrame({
  chainId, wallet, owner, key, nonceSeq, nonceKeys = [0n], gas, verifyData, verifyState = 0n,
  target, value = 0n, bodyData = "0x", paymaster,
}) {
  const tx = {
    chainId: BigInt(chainId), sender: wallet, nonceKeys, nonceSeq,
    frames: [
      { mode: 1, flags: paymaster ? 2 : 3, target: null, limits: { execution: gas, state: verifyState }, value: 0n, data: paymaster ? concatHex([verifyData, "0x01"]) : verifyData },
      { mode: 2, flags: 0, target, limits: { execution: 150000n, state: value ? 300000n : 0n }, value, data: bodyData },
    ],
    signatures: [{ scheme: 1, signer: owner, msg: "0x", signature: "0x" }],
    fees: { maxPriorityFeePerGas: 1000000000n, maxFeePerGas: 2000000000n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [], recentRootReferences: [],
  };
  if (paymaster) {
    // A sponsored prefix authenticates the sender before asking the payer to cover fees.
    tx.frames.splice(1, 0, {
      mode: 1, flags: 1, target: paymaster, limits: { execution: 20000n, state: 0n }, value: 0n, data: "0x",
    });
  }
  const sig = await sign({ hash: computeSigHash(tx), privateKey: key });
  tx.signatures[0].signature = concatHex([toHex(sig.yParity, { size: 1 }), sig.r, sig.s]);
  return tx;
}
