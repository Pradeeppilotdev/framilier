import { concatHex, keccak256, stringToHex, toHex } from "viem";
import { sign } from "viem/accounts";
import { computeSigHash } from "../../packages/executor/lib/services/FrameTxService/codec.js";

export function hashChain(rounds) {
  const witness = keccak256(stringToHex("StakeLane private inclusion fixture v1"));
  let commitment = witness;
  for (let i = 0; i < rounds; i++) commitment = keccak256(commitment);
  return { witness, commitment };
}

export async function signedWalletFrame({
  chainId, wallet, owner, key, nonceSeq, nonceKeys = [0n], gas, verifyData, verifyState = 0n,
  target, value = 0n, bodyData = "0x",
}) {
  const tx = {
    chainId: BigInt(chainId), sender: wallet, nonceKeys, nonceSeq,
    frames: [
      { mode: 1, flags: 3, target: null, limits: { execution: gas, state: verifyState }, value: 0n, data: verifyData },
      { mode: 2, flags: 0, target, limits: { execution: 150000n, state: value ? 300000n : 0n }, value, data: bodyData },
    ],
    signatures: [{ scheme: 1, signer: owner, msg: "0x", signature: "0x" }],
    fees: { maxPriorityFeePerGas: 1000000000n, maxFeePerGas: 2000000000n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [], recentRootReferences: [],
  };
  const sig = await sign({ hash: computeSigHash(tx), privateKey: key });
  tx.signatures[0].signature = concatHex([toHex(sig.yParity, { size: 1 }), sig.r, sig.s]);
  return tx;
}
