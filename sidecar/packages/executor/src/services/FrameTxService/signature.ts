import { recoverAddress, keccak256, Hex, isAddressEqual, toBytes } from "viem";
import { p256 } from "@noble/curves/p256";
import { SignatureEntry, SIG_SCHEME } from "@skandha/types/lib/contracts/FrameTx.js";

// BigInt literals (e.g. `0n`) require ES2020+; this workspace targets ES2019
// (see tsconfig.build.json), so every bigint below is built via BigInt(...).
const SECP256K1N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256R1N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const TWO = BigInt(2);
const ZERO = BigInt(0);

/**
 * Per EIP-8141 §Signature Validation: transcribes the `validate_signature`
 * pseudocode. SECP256K1 recovery (`recoverAddress`) is inherently async in
 * viem, so this function is async end-to-end; every caller (the validation
 * pipeline, the simulation entry point) must `await` it.
 */
export async function validateSignature(sig: SignatureEntry, txSender: Hex, sigHash: Hex): Promise<boolean> {
  let msg: Hex;
  if (sig.msg === "0x") {
    msg = sigHash;
  } else {
    const msgBytes = sig.msg.slice(2);
    if (msgBytes.length !== 64) return false;
    if (/^0{64}$/.test(msgBytes)) return false; // explicit zero digest is invalid
    msg = sig.msg as Hex;
  }

  let resolvedSigner: Hex;
  if (sig.signer === "0x") {
    resolvedSigner = txSender;
  } else if (sig.signer.length === 42) {
    resolvedSigner = sig.signer as Hex;
  } else {
    return false;
  }

  if (sig.scheme === SIG_SCHEME.SECP256K1) {
    const bytes = sig.signature.slice(2);
    if (bytes.length !== 130) return false; // 65 bytes
    const v = parseInt(bytes.slice(0, 2), 16);
    const r = BigInt("0x" + bytes.slice(2, 66));
    const s = BigInt("0x" + bytes.slice(66, 130));
    if (v > 1 || !(r > ZERO && r < SECP256K1N) || !(s > ZERO && s <= SECP256K1N / TWO)) return false;
    // recoverAddress expects v as 27/28; EIP-8141's v is the 0/1 recovery id directly.
    try {
      const recovered = await recoverAddress({
        hash: msg,
        signature: { r: `0x${r.toString(16)}` as Hex, s: `0x${s.toString(16)}` as Hex, v: BigInt(v + 27) },
      });
      return isAddressEqual(recovered, resolvedSigner);
    } catch {
      // A crafted r/s can pass the range check above without corresponding
      // to a valid curve point; viem's recovery can throw in that case.
      // Signature validation must never throw on attacker-controlled input.
      return false;
    }
  } else if (sig.scheme === SIG_SCHEME.P256) {
    const bytes = sig.signature.slice(2);
    if (bytes.length !== 256) return false; // 128 bytes
    const r = BigInt("0x" + bytes.slice(0, 64));
    const s = BigInt("0x" + bytes.slice(64, 128));
    const qx = ("0x" + bytes.slice(128, 192)) as Hex;
    const qy = ("0x" + bytes.slice(192, 256)) as Hex;
    if (!(r > ZERO && r < SECP256R1N) || !(s > ZERO && s <= SECP256R1N / TWO)) return false;
    // EIP-8141: resolved_signer == keccak256(qx + qy)[12:] — the LAST 20
    // bytes of the hash (Python [12:] slicing on a 32-byte digest), the
    // same convention viem's own publicKeyToAddress uses. NOT the first 20
    // bytes (that would be an ecrecover-address-style derivation, which
    // does not apply here).
    const expectedSigner = ("0x" + keccak256(("0x" + qx.slice(2) + qy.slice(2)) as Hex).slice(26)) as Hex;
    if (!isAddressEqual(expectedSigner, resolvedSigner)) return false;
    // Per EIP-8141 line 319: signature validation does not happen in EVM
    // execution, so ecrecover/P256VERIFY are NOT precompile calls here —
    // this is the same pure off-chain math the P256VERIFY precompile
    // performs, done directly with @noble/curves' secp256r1 implementation.
    // Uncompressed SEC1 public key encoding: 0x04 || qx (32 bytes) || qy (32 bytes).
    const publicKey = new Uint8Array([0x04, ...toBytes(qx), ...toBytes(qy)]);
    return p256.verify({ r, s }, toBytes(msg), publicKey, { lowS: false });
  } else if (sig.scheme === SIG_SCHEME.ARBITRARY) {
    return sig.signer === "0x";
  }
  return false;
}
