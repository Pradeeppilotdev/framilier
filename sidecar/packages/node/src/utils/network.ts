import os from "node:os";
import type { PeerId } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import type { Connection } from "@libp2p/interface";
import type { SignableENR } from "@chainsafe/enr";
import type { Libp2p } from "../network/interface.js";

// peers

/**
 * Check if multiaddr belongs to the local network interfaces.
 */
export function isLocalMultiAddr(multiaddr: Multiaddr | undefined): boolean {
  if (!multiaddr) return false;

  const protoNames = multiaddr.protoNames();
  if (protoNames.length !== 2 && protoNames[1] !== "udp") {
    throw new Error("Invalid udp multiaddr");
  }

  const interfaces = os.networkInterfaces();
  const tuples = multiaddr.tuples();
  const family = tuples[0][0];
  const isIPv4: boolean = family === 4;
  const ip = tuples[0][1];

  if (!ip) {
    return false;
  }

  const ipStr = isIPv4
    ? Array.from(ip).join(".")
    : Array.from(Uint16Array.from(ip))
        .map((n) => n.toString(16))
        .join(":");

  for (const networkInterfaces of Object.values(interfaces)) {
    for (const networkInterface of networkInterfaces || []) {
      // since node version 18, the netowrkinterface family returns 4 | 6 instead of ipv4 | ipv6,
      // even though the documentation says otherwise.
      // This might be a bug that would be corrected in future version, in the meantime
      // the check using endsWith ensures things work in node version 18 and earlier
      if (
        String(networkInterface.family).endsWith(String(family)) &&
        networkInterface.address === ipStr
      ) {
        return true;
      }
    }
  }

  return false;
}

export function clearMultiaddrUDP(enr: SignableENR): void {
  // enr.multiaddrUDP = undefined in new version
  enr.delete("ip");
  enr.delete("udp");
  enr.delete("ip6");
  enr.delete("udp6");
}

export function prettyPrintPeerId(peerId: PeerId): string {
  const id = peerId.toString();
  return `${id.substr(0, 2)}...${id.substr(id.length - 6, id.length)}`;
}

/**
 * Get a peerIdStr -> open connections map for a libp2p node.
 *
 * libp2p 1.x+ no longer exposes a `.connectionManager` sub-object with an
 * internal `connections` map (the whole Components pattern is gone) - the
 * public replacement is `Libp2p#getConnections()`, grouped here by remote
 * peer id string to preserve the shape this codebase expects.
 */
export function getConnectionsMap(libp2p: Libp2p): Map<string, Connection[]> {
  const map = new Map<string, Connection[]>();
  for (const connection of libp2p.getConnections()) {
    const peerIdStr = connection.remotePeer.toString();
    const connections = map.get(peerIdStr);
    if (connections) {
      connections.push(connection);
    } else {
      map.set(peerIdStr, [connection]);
    }
  }
  return map;
}

export function getConnection(
  libp2p: Libp2p,
  peerIdStr: string
): Connection | undefined {
  return getConnectionsMap(libp2p).get(peerIdStr)?.[0] ?? undefined;
}

// https://github.com/ChainSafe/js-libp2p-gossipsub/blob/3475242ed254f7647798ab7f36b21909f6cb61da/src/index.ts#L2009
export function isPublishToZeroPeersError(e: Error): boolean {
  return e.message.includes("PublishError.InsufficientPeers");
}

/**
 * True if libp2p has a dial to `peerIdStr` queued or in progress.
 *
 * libp2p 1.x+ no longer exposes a `.components.dialer.pendingDials` map -
 * the public replacement is `Libp2p#getDialQueue()`.
 */
export function isDialingPeer(libp2p: Libp2p, peerIdStr: string): boolean {
  return libp2p
    .getDialQueue()
    .some(
      (dial) =>
        dial.peerId?.toString() === peerIdStr &&
        (dial.status === "queued" || dial.status === "active")
    );
}
