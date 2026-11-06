import { homedir } from "node:os";
import { IDiscv5DiscoveryInputOptions } from "@chainsafe/discv5";
import { SignableENR } from "@chainsafe/enr";
import { P2POptions, defaultP2POptions } from "@skandha/types/lib/options";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { PeerManagerOpts } from "./peers.js";

export const defaultP2PHost = "127.0.0.1";
export const defaultP2PPort = 4337;
export interface INetworkOptions extends PeerManagerOpts {
  localMultiaddrs: string[];
  bootMultiaddrs?: string[];
  mdns: boolean;
  connectToDiscv5Bootnodes?: boolean;
  version?: string;
  dataDir: string;
}

export const initNetworkOptions = (
  enr: SignableENR,
  p2pOptions: P2POptions,
  dataDir: string
): INetworkOptions => {
  if (dataDir === "") {
    dataDir = `${homedir()}/.skandha/db/`;
  }

  const discv5Options: IDiscv5DiscoveryInputOptions = {
    bindAddrs: { ip4: `/ip4/${p2pOptions.host}/udp/${p2pOptions.enrPort}` },
    enr: enr,
    bootEnrs: p2pOptions.bootEnrs || [],
    enrUpdate: true,
    enabled: true,
  };

  const networkOptions = {
    maxPeers: 7, // Allow some room above targetPeers for new inbound peers
    targetPeers: 5,
    discv5FirstQueryDelayMs: 1000,
    localMultiaddrs: [`/ip4/${p2pOptions.host}/tcp/${p2pOptions.port}`],
    bootMultiaddrs: [],
    mdns: false,
    discv5: discv5Options,
    connectToDiscv5Bootnodes: true,
    dataDir,
  };

  return networkOptions;
};

const randomPrivateKey = await generateKeyPair("secp256k1");
export const defaultNetworkOptions = initNetworkOptions(
  SignableENR.createV4(randomPrivateKey.raw),
  defaultP2POptions,
  ""
);
