import type { ConnectionEncrypter } from "@libp2p/interface";
import type { NoiseComponents } from "@chainsafe/libp2p-noise";
import { newInstance, ChaCha20Poly1305 } from "@chainsafe/as-chacha20poly1305";
import { ICryptoInterface, noise, pureJsCrypto } from "@chainsafe/libp2p-noise";
import { digest } from "@chainsafe/as-sha256";
import type { Uint8ArrayList } from "uint8arraylist";

type Bytes = Uint8Array;
type Bytes32 = Uint8Array;

const ctx = newInstance();
const asImpl = new ChaCha20Poly1305(ctx);

// same to pureJsCrypto (renamed from stablelib in libp2p-noise 17.x) but we
// use as-chacha20poly1305 and as-sha256
function flatten(data: Uint8Array | Uint8ArrayList): Uint8Array {
  return data instanceof Uint8Array ? data : data.subarray();
}

const varCrypto: ICryptoInterface = {
  ...pureJsCrypto,
  // ICryptoInterface's hashSHA256/chaCha20Poly1305{Encrypt,Decrypt} all
  // accept `Uint8Array | Uint8ArrayList` (chunked/concatenated buffer views
  // are common once real transport-level, not just handshake-level, traffic
  // flows), but as-sha256/as-chacha20poly1305 only operate on flat
  // Uint8Arrays, so every input is flattened first.
  hashSHA256(data: Uint8Array | Uint8ArrayList): Uint8Array {
    return digest(flatten(data));
  },

  chaCha20Poly1305Encrypt(
    plaintext: Uint8Array | Uint8ArrayList,
    nonce: Uint8Array,
    ad: Uint8Array,
    k: Bytes32
  ): Bytes {
    return asImpl.seal(k, nonce, flatten(plaintext), ad);
  },

  chaCha20Poly1305Decrypt(
    ciphertext: Uint8Array | Uint8ArrayList,
    nonce: Uint8Array,
    ad: Uint8Array,
    k: Bytes32,
    dst?: Uint8Array
  ): Bytes {
    const plaintext = asImpl.open(k, nonce, flatten(ciphertext), ad, dst);
    if (plaintext === null) {
      throw new Error("Invalid chacha20poly1305 tag");
    }
    return plaintext;
  },
};

export function createNoise(): (
  components: NoiseComponents
) => ConnectionEncrypter {
  return noise({ crypto: varCrypto });
}
