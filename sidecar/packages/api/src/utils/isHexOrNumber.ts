import { registerDecorator, ValidationOptions } from "class-validator";

/**
 * Converts a plain integer OR a hex string into a plain `number`, or
 * `undefined` if `value` is neither (or doesn't fit safely into a
 * `number`). Shared by `IsHexOrNumberIn`/`IsHexOrNumberBitfield` below and
 * by `../utils/frameTx.ts`'s wire->executor normalization, so both sides
 * agree on exactly what counts as a valid small integer.
 */
export function toPlainNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === "string") {
    try {
      const n = BigInt(value);
      if (
        n < BigInt(Number.MIN_SAFE_INTEGER) ||
        n > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        return undefined;
      }
      return Number(n);
    } catch (_) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Like `IsBigNumberish` (`./isBigNumber.ts`), but for small integer-enum/
 * bitfield fields (`Frame.mode`/`Frame.flags`, `SignatureEntry.scheme`)
 * that must accept EITHER a plain number or a hex string on the way in.
 *
 * Every RPC response is passed through `deepHexlify` (`app.ts`), which
 * turns plain JS numbers into hex strings - including these fields. A
 * client that reads a transaction back (e.g. from
 * `eth_getFrameTransactionByHash`) and replays that exact JSON into
 * `eth_sendFrameTransaction`/`debug_bundler_setMempool` must not get
 * rejected merely for sending `"0x1"` instead of `1`.
 *
 * `isValid` receives the decoded plain number and decides whether it's in
 * range (e.g. membership in `FRAME_MODE`/`SIG_SCHEME`, or a bitfield
 * bound).
 */
export function IsHexOrNumber(
  isValid: (n: number) => boolean,
  options: ValidationOptions = {}
) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      propertyName,
      options: {
        message: `${propertyName} must be a valid number or hex string in range`,
        ...options,
      },
      name: "isHexOrNumber",
      target: object.constructor,
      constraints: [],
      validator: {
        validate(value): boolean {
          const n = toPlainNumber(value);
          return n !== undefined && isValid(n);
        },
      },
    });
  };
}
