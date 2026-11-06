import fs from "node:fs";
import path from "node:path";
import { SignableENR } from "@chainsafe/enr";
import type { PeerId, PrivateKey } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import { defaultP2POptions } from "@skandha/types/lib/options/index.js";
import { Logger } from "@skandha/api/lib/logger.js";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { readFile, writeFile600Perm } from "../../util/index.js";
import { IGlobalArgs } from "../../options/index.js";

export type PeerIdJSON = { id: string; privKey?: string };

export function overwriteEnrWithCliArgs(
  enr: SignableENR,
  args: IGlobalArgs
): void {
  const [host, enrPort, enrSeq] = [args["p2p.enrHost"], args["p2p.enrPort"], args["p2p.enrSeq"]];

  const newHost = host ?? defaultP2POptions.enrHost;
  // Normalize port to a number to avoid accidental mismatches
  const newPort =
    enrPort !== undefined && enrPort !== null
      ? Number(enrPort)
      : defaultP2POptions.enrPort;

  // Only update when a value actually changes to avoid bumping the ENR seq
  if (enr.ip !== newHost) {
    enr.ip = newHost;
  }
  if (enr.tcp !== newPort) {
    enr.tcp = newPort;
  }
  if (enr.udp !== newPort) {
    enr.udp = newPort;
  }

  enr.seq = enrSeq ? BigInt(enrSeq) : BigInt(defaultP2POptions.enrSeq)
}

export async function initPeerIdAndEnr(
  args: IGlobalArgs,
  logger: Logger
): Promise<{ peerId: PeerId; enr: SignableENR }> {
  const { dataDir } = args;
  const retainPeerId = args["p2p.retainPeerId"];

  const newPeerIdAndENR = async (): Promise<{
    peerId: PeerId;
    privateKey: PrivateKey;
    enr: SignableENR;
  }> => {
    const privateKey = await generateKeyPair("secp256k1");
    const enr = SignableENR.createV4(privateKey.raw);
    // discv5/enr's SignableENR#peerId is a synchronous getter and is always
    // in sync with the private key used to create it.
    return { peerId: enr.peerId, privateKey, enr };
  };

  const readPersistedPeerIdAndENR = async (
    peerIdFile: string,
    enrFile: string
  ): Promise<{ peerId: PeerId; privateKey: PrivateKey; enr: SignableENR }> => {
    let peerId: PeerId;
    let privateKey: PrivateKey | undefined;
    let enr: SignableENR;

    // attempt to read stored peer id
    try {
      ({ peerId, privateKey } = await readPeerId(peerIdFile));
    } catch (e) {
      logger.warn("Unable to read peerIdFile, creating a new peer id");
      return newPeerIdAndENR();
    }
    if (!privateKey) {
      logger.warn(
        "Stored peerIdFile has no private key, creating a new peer id"
      );
      return newPeerIdAndENR();
    }
    // attempt to read stored enr
    try {
      enr = SignableENR.decodeTxt(
        fs.readFileSync(enrFile, "utf-8"),
        privateKey.raw
      );
    } catch (e) {
      logger.warn("Unable to decode stored local ENR, creating a new ENR");
      enr = SignableENR.createV4(privateKey.raw);
      return { peerId, privateKey, enr };
    }
    // check stored peer id against stored enr
    if (!peerId.equals(enr.peerId)) {
      logger.warn(
        "Stored local ENR doesn't match peerIdFile, creating a new ENR"
      );
      enr = SignableENR.createV4(privateKey.raw);
      return { peerId, privateKey, enr };
    }
    return { peerId, privateKey, enr };
  };

  if (retainPeerId) {
    const enrFile = path.join(dataDir, "enr");
    const peerIdFile = path.join(dataDir, "peer-id.json");
    const { peerId, privateKey, enr } = await readPersistedPeerIdAndENR(
      peerIdFile,
      enrFile
    );
    overwriteEnrWithCliArgs(enr, args);
    writeFile600Perm(peerIdFile, exportToJSON(peerId, privateKey));
    writeFile600Perm(enrFile, enr.encodeTxt());
    return { peerId, enr };
  } else {
    const { peerId, enr } = await newPeerIdAndENR();
    overwriteEnrWithCliArgs(enr, args);
    return { peerId, enr };
  }
}

export function exportToJSON(
  peerId: PeerId,
  privateKey?: PrivateKey,
  excludePrivateKey?: boolean
): PeerIdJSON {
  return {
    id: peerId.toString(),
    privKey:
      excludePrivateKey === true || privateKey == null
        ? undefined
        : uint8ArrayToString(privateKeyToProtobuf(privateKey), "base64pad"),
  };
}

async function createFromJSON(
  obj: PeerIdJSON
): Promise<{ peerId: PeerId; privateKey?: PrivateKey }> {
  const privateKey =
    obj.privKey != null
      ? privateKeyFromProtobuf(uint8ArrayFromString(obj.privKey, "base64pad"))
      : undefined;

  // The peer id embeds the public key (for Ed25519/secp256k1 identities, the
  // ones this CLI generates), so it can always be reconstructed from the
  // stored id string alone; the private key (when present) is kept
  // separately since it is not recoverable from the peer id.
  return { peerId: peerIdFromString(obj.id), privateKey };
}

async function readPeerId(
  filepath: string
): Promise<{ peerId: PeerId; privateKey?: PrivateKey }> {
  return createFromJSON(readFile(filepath));
}
