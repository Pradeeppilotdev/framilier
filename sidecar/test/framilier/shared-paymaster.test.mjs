import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { recoverAddress, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { computeSigHash } from "../../packages/executor/lib/services/FrameTxService/codec.js";
import {
  calculateDeclaredVerifyGas, isHeavyFrameTx,
} from "../../packages/executor/lib/services/UserOpValidation/utils/validationBudget.js";
import { signedWalletFrame } from "./wallet-frame.mjs";

const wallet = "0x1111111111111111111111111111111111111111";
const paymaster = "0x2222222222222222222222222222222222222222";
const target = "0x3333333333333333333333333333333333333333";
const key = generatePrivateKey();
const owner = privateKeyToAccount(key).address;
const base = { chainId: 8141337, wallet, owner, key, nonceSeq: 0n, target };

test("pinned compiler artifacts include both sponsored fixtures", async () => {
  const file = new URL("./fixtures.json", import.meta.url);
  const { compiler, contracts } = JSON.parse(await readFile(file, "utf8"));
  assert.match(compiler, /^0\.8\.28\+commit\.7893614a/);
  for (const name of ["SponsoredHashChainWallet", "SimplePaymaster"]) {
    assert.match(contracts[name].bytecode, /^0x[0-9a-f]+$/);
    assert.ok(contracts[name].abi.some(item => item.type === "constructor" && item.stateMutability === "payable"));
  }
});

test("signed sponsored prefix identifies separate sender and payer with the intended scheduler classes", async () => {
  const witness = toHex(123n, {size: 32});
  const heavy = await signedWalletFrame({ ...base, paymaster, gas: 997200n, verifyData: witness });
  const cheap = await signedWalletFrame({ ...base, paymaster, gas: 70000n, verifyData: "0x" });
  assert.deepEqual(heavy.frames.map(f => [f.mode, f.flags, f.target]), [
    [1, 2, null], [1, 1, paymaster], [2, 0, target],
  ]);
  assert.equal(heavy.frames[0].data, witness + "01");
  assert.equal(cheap.frames[0].data, "0x01");
  assert.equal(heavy.frames[1].data, "0x");
  assert.equal(calculateDeclaredVerifyGas(cheap), 92800n);
  assert.equal(isHeavyFrameTx(cheap), false);
  assert.equal(calculateDeclaredVerifyGas(heavy), 1020000n);
  assert.equal(isHeavyFrameTx(heavy), true);

  const bytes = heavy.signatures[0].signature;
  const signature = {yParity: Number(bytes.slice(0, 4)), r: "0x" + bytes.slice(4, 68), s: "0x" + bytes.slice(68)};
  assert.equal(await recoverAddress({hash: computeSigHash(heavy), signature}), owner);
  heavy.frames[1].target = target;
  assert.notEqual(await recoverAddress({hash: computeSigHash(heavy), signature}), owner);
});

test("self-paid sender keeps its signed two-frame payload", async () => {
  const witness = toHex(321n, {size: 32});
  const tx = await signedWalletFrame({ ...base, gas: 997200n, verifyData: witness });
  assert.deepEqual(tx.frames.map(f => [f.mode, f.flags, f.target]), [[1, 3, null], [2, 0, target]]);
  assert.equal(tx.frames[0].data, witness);
});
