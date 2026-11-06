/**
 * React Query keys. Every key starts with the instance URL so that everything
 * held for one node can be invalidated or reset with a single prefix.
 */
export const keys = {
  all: (url: string) => ["x", url] as const,
  info: (url: string) => ["x", url, "info"] as const,
  pool: (url: string, status: string) => ["x", url, "pool", status] as const,
  activity: (url: string, outcome: string) => ["x", url, "activity", outcome] as const,
  tx: (url: string, hash: string) => ["x", url, "tx", hash.toLowerCase()] as const,
  peers: (url: string) => ["x", url, "peers"] as const,
  reputation: (url: string) => ["x", url, "reputation"] as const,
};
