/** Display helpers. Everything here is pure so it can be tested without a DOM. */

/** `0x1234…abcd`. Strings that are already short are returned unchanged. */
export function shortHash(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export const shortAddress = (address: string): string => shortHash(address, 6, 4);

/** Parses a `0x` quantity; empty or malformed input reads as zero. */
export function hexToBigInt(hex: string): bigint {
  if (hex === "" || hex === "0x") return 0n;
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

/** A `0x` quantity in decimal with thousands separators. */
export function formatQuantity(hex: string): string {
  return hexToBigInt(hex).toLocaleString("en-US");
}

/** A wei amount, given as a `0x` quantity, shown in gwei with up to three decimals. */
export function formatGwei(hexWei: string): string {
  const wei = hexToBigInt(hexWei);
  if (wei === 0n) return "0 gwei";
  const gwei = 1_000_000_000n;
  const whole = wei / gwei;
  const rest = wei % gwei;
  if (whole === 0n && rest < 1_000_000n) return "<0.001 gwei";
  const thousandths = rest / 1_000_000n;
  const decimals =
    thousandths === 0n ? "" : `.${thousandths.toString().padStart(3, "0").replace(/0+$/, "")}`;
  return `${whole.toLocaleString("en-US")}${decimals} gwei`;
}

/** A wei amount, given as a `0x` quantity, shown in ETH with up to four decimals. */
export function formatEther(hexWei: string): string {
  const wei = hexToBigInt(hexWei);
  if (wei === 0n) return "0 ETH";
  const ether = 1_000_000_000_000_000_000n;
  const whole = wei / ether;
  const rest = wei % ether;
  if (whole === 0n && rest < 100_000_000_000_000n) return "<0.0001 ETH";
  const tenThousandths = rest / 100_000_000_000_000n;
  const decimals =
    tenThousandths === 0n ? "" : `.${tenThousandths.toString().padStart(4, "0").replace(/0+$/, "")}`;
  return `${whole.toLocaleString("en-US")}${decimals} ETH`;
}

/** `HH:MM:SS.mmm`, in the viewer's time zone unless `timeZone` is given. */
export function formatClock(ms: number, timeZone?: string): string {
  const time = new Date(ms).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  });
  return `${time}.${String(ms % 1000).padStart(3, "0")}`;
}

/** Coarse relative time: "just now", "12 s ago", "5 min ago", "3 h ago", "2 d ago". */
export function formatAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** An offset from the first observation: "first", "+240 ms", "+1.2 s", "+3 min". */
export function formatDelta(ms: number): string {
  if (ms <= 0) return "first";
  if (ms < 1000) return `+${ms} ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  return `+${Math.round(ms / 60_000)} min`;
}

/** Where a node first saw a transaction, in words: "Submitted by RPC", "P2P from 16Uiu2…Pq8P". */
export function describeSource(source: string): string {
  if (source === "rpc") return "Submitted by RPC";
  const gossip = /^gossip:(.+)$/.exec(source);
  if (gossip?.[1]) return `P2P from ${shortHash(gossip[1], 6, 4)}`;
  const sync = /^sync:(.+)$/.exec(source);
  if (sync?.[1]) return `P2P sync from ${shortHash(sync[1], 6, 4)}`;
  return source;
}

/** The full peer id behind a `gossip:` or `sync:` source; null for RPC or an unknown form. */
export function sourcePeer(source: string): string | null {
  return /^(?:gossip|sync):(.+)$/.exec(source)?.[1] ?? null;
}

/** A byte count, or the byte length of a `0x` data string, as words: "0 bytes", "1 byte", "36 bytes". */
export function formatBytes(data: string | number): string {
  const bytes = typeof data === "number" ? data : Math.max(0, Math.floor((data.length - 2) / 2));
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

/**
 * An EIP-8250 nonce: the plain sequence for the linear domain (no keys, or
 * `["0x0"]`), otherwise "seq N on key(s) …". A key is usually a 32-byte hash
 * (e.g. a nullifier), so it is shortened.
 */
export function formatNonce(seq: string, keys?: readonly string[]): string {
  const n = formatQuantity(seq);
  if (!keys || keys.length === 0 || (keys.length === 1 && hexToBigInt(keys[0] ?? "0x0") === 0n)) return n;
  const shown = keys.map((k) => (k.length > 14 ? shortHash(k) : k)).join(", ");
  return `seq ${n} on key${keys.length > 1 ? "s" : ""} ${shown}`;
}

/** An EIP-8272 recent-root reference, one line: slot, root and its source namespace. */
export function formatRecentRoot(ref: { sourceId: string; slot: string; root: string }): string {
  return `slot ${formatQuantity(ref.slot)}: root ${shortHash(ref.root)} from source ${shortHash(ref.sourceId)}`;
}
