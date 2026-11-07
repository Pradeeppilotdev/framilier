import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { signedSponsoredWalletFrame, signedWalletFrame } from "./wallet-frame.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("fixtures.json includes compiled SimplePaymaster", async () => {
  const fixtures = JSON.parse(await readFile(path.join(here, "fixtures.json"), "utf8"));
  assert.ok(fixtures.contracts.SimplePaymaster, "SimplePaymaster missing from fixtures.json");
  assert.ok(fixtures.contracts.SimplePaymaster.abi.length > 0, "SimplePaymaster ABI missing");
  assert.ok(fixtures.contracts.SimplePaymaster.bytecode.startsWith("0x"), "SimplePaymaster bytecode invalid");
});

test("signedSponsoredWalletFrame constructs valid 3-frame EIP-8141 payload", async () => {
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const mockWallet = "0x1111111111111111111111111111111111111111";
  const mockPaymaster = "0x2222222222222222222222222222222222222222";
  const mockTarget = "0x3333333333333333333333333333333333333333";

  const tx = await signedSponsoredWalletFrame({
    chainId: 8141337,
    wallet: mockWallet,
    owner: owner.address,
    key: ownerKey,
    paymaster: mockPaymaster,
    nonceSeq: 0n,
    gas: 997200n,
    verifyData: "0xabcdef",
    target: mockTarget,
  });

  // Verify 3-frame pipeline
  assert.equal(tx.frames.length, 3, "Expected 3 frames in sponsored transaction");

  // Frame 0: VERIFY mode on Paymaster (flags = 1, APPROVE_PAY)
  assert.equal(tx.frames[0].mode, 1);
  assert.equal(tx.frames[0].flags, 1);
  assert.equal(tx.frames[0].target, mockPaymaster);

  // Frame 1: VERIFY mode on Account (flags = 2, APPROVE_EXEC)
  assert.equal(tx.frames[1].mode, 1);
  assert.equal(tx.frames[1].flags, 2);
  assert.equal(tx.frames[1].target, null);
  assert.equal(tx.frames[1].limits.execution, 997200n);

  // Frame 2: SENDER mode on Target (flags = 0, Execution)
  assert.equal(tx.frames[2].mode, 2);
  assert.equal(tx.frames[2].flags, 0);
  assert.equal(tx.frames[2].target, mockTarget);

  // Signatures present
  assert.equal(tx.signatures.length, 1);
  assert.ok(tx.signatures[0].signature.startsWith("0x"));
});

test("comparing self-paid 2-frame vs shared-paymaster 3-frame structures", async () => {
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const mockWallet = "0x1111111111111111111111111111111111111111";
  const mockPaymaster = "0x2222222222222222222222222222222222222222";

  const selfPaidTx = await signedWalletFrame({
    chainId: 8141337,
    wallet: mockWallet,
    owner: owner.address,
    key: ownerKey,
    nonceSeq: 0n,
    gas: 997200n,
    verifyData: "0x",
    target: owner.address,
  });

  const sponsoredTx = await signedSponsoredWalletFrame({
    chainId: 8141337,
    wallet: mockWallet,
    owner: owner.address,
    key: ownerKey,
    paymaster: mockPaymaster,
    nonceSeq: 0n,
    gas: 997200n,
    verifyData: "0x",
    target: owner.address,
  });

  assert.equal(selfPaidTx.frames.length, 2);
  assert.equal(selfPaidTx.frames[0].flags, 3); // APPROVE_ALL = 0x03

  assert.equal(sponsoredTx.frames.length, 3);
  assert.equal(sponsoredTx.frames[0].flags, 1); // APPROVE_PAY = 0x01
  assert.equal(sponsoredTx.frames[1].flags, 2); // APPROVE_EXEC = 0x02
  assert.equal(sponsoredTx.frames[0].target, mockPaymaster);
});
