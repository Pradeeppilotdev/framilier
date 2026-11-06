/**
 * JSON.stringify/JSON.parse replacer+reviver pair for round-tripping
 * `bigint` values through both `RocksDbController` and `LocalDbController`.
 *
 * Native JSON has no bigint representation, and a plain `"0x" +
 * value.toString(16)` replacer alone is NOT safe to invert with a bare
 * reviver: once serialized, a former bigint ("0x0") is byte-for-byte
 * indistinguishable from any of this same data's genuinely-string hex
 * fields (addresses, hashes, signatures) - a reviver that BigInt-ifies
 * every `0x...` string would corrupt those instead. The `BIGINT_PREFIX`
 * tag is what makes the two directions safely distinguishable; no real
 * address/hash/signature string can start with it.
 *
 * Previously only the replacer existed (`put` calls used it, `get`/
 * `getMany` used plain `JSON.parse` with no matching reviver) - every
 * bigint field silently came back as a plain hex string after a DB
 * write-then-read round trip, discovered via a real end-to-end test that
 * happened to check a numeric field after a re-fetch.
 */

const BIGINT_PREFIX = "bigint:0x";

export function replaceBigints(_key: string, value: unknown): unknown {
  return typeof value === "bigint"
    ? `${BIGINT_PREFIX}${value.toString(16)}`
    : value;
}

export function reviveBigints(_key: string, value: unknown): unknown {
  return typeof value === "string" && value.startsWith(BIGINT_PREFIX)
    ? BigInt(`0x${value.slice(BIGINT_PREFIX.length)}`)
    : value;
}
