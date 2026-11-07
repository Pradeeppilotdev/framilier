import * as fs from 'fs';
import * as path from 'path';
import { Address, Hex } from 'viem';

export interface GuardianCard {
  id: number;
  secret: Hex;
  nullifierSecret: Hex;
  leaf: Hex;
}

export interface WalletProfile {
  address: Address;
  ownerPrivateKey: Hex;
  scheme: string;
  guardianMerkleRoot: Hex | string;
  signatureCommitment: Hex;
  guardians: GuardianCard[];
  createdAt: string;
  network: {
    chainId: number;
    rpc: string;
    gateway: string;
  };
}

const VAULT_DIR = path.join(process.cwd(), '.frameforge', 'wallets');

export function ensureVaultDir(): string {
  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
  }
  return VAULT_DIR;
}

export function saveWalletProfile(profile: WalletProfile): string {
  ensureVaultDir();
  const filePath = path.join(VAULT_DIR, `${profile.address.toLowerCase()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf8');
  return filePath;
}

export function loadWalletProfile(address: Address): WalletProfile | null {
  ensureVaultDir();
  const filePath = path.join(VAULT_DIR, `${address.toLowerCase()}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content) as WalletProfile;
}

export function listWalletProfiles(): WalletProfile[] {
  ensureVaultDir();
  if (!fs.existsSync(VAULT_DIR)) return [];
  const files: string[] = fs.readdirSync(VAULT_DIR).filter((f: string) => f.endsWith('.json'));
  return files.map((f: string) => {
    const content = fs.readFileSync(path.join(VAULT_DIR, f), 'utf8');
    return JSON.parse(content) as WalletProfile;
  });
}

