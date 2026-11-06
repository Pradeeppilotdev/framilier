import "reflect-metadata";
import { validate, type ValidationError } from "class-validator";
import { plainToInstance } from "class-transformer";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import logger from "../logger.js";

/**
 * The first few problems as `path: message`, `; `-joined, e.g.
 * `frames.0.mode: mode must be a valid number or hex string in range`. Nested
 * errors (class-validator reports them as `children`) get a dotted path.
 */
export function describeValidationErrors(
  errors: ValidationError[],
  limit = 3
): string {
  const found: string[] = [];
  const walk = (list: ValidationError[], path: string[]): void => {
    for (const error of list) {
      if (found.length >= limit) return;
      const here = [...path, error.property];
      const messages = Object.values(error.constraints ?? {});
      if (messages.length > 0) {
        found.push(`${here.join(".")}: ${messages[0]}`);
      }
      if (error.children && error.children.length > 0) {
        walk(error.children, here);
      }
    }
  };
  walk(errors, []);
  return found.join("; ");
}

export function validationFactory<T>(
  metadataKey: symbol,
  model: { new (...args: any[]): T }
) {
  // eslint-disable-next-line func-names
  return function (
    target: any,
    propertyName: string,
    descriptor: TypedPropertyDescriptor<any>
  ) {
    Reflect.defineMetadata(metadataKey, model, target, propertyName);

    const method = descriptor.value!;
    // eslint-disable-next-line func-names
    descriptor.value = async function (...args: any[]) {
      const schema = Reflect.getOwnMetadata(metadataKey, target, propertyName);
      // A missing/nullish/scalar raw argument (e.g. `params[0]` omitted, or
      // `null`/a bare string/number sent by a malformed client) is not a
      // plain object `plainToInstance` can transform - it throws a raw
      // `TypeError` before validation even runs. Normalize any such value to
      // `{}` so it instead fails NORMAL per-field validation (missing
      // required fields) and surfaces as the usual `RpcError`/
      // `INVALID_REQUEST`, rather than as an uncaught exception.
      const raw = args[0];
      const target0 =
        raw !== null && typeof raw === "object" ? raw : {};
      const errors = await validate(plainToInstance(schema, target0));
      if (errors.length > 0) {
        logger.info("Invalid Request", {
          data: {
            errors,
            arguments: args[0],
          },
        });
        const detail = describeValidationErrors(errors);
        throw new RpcError(
          detail === "" ? "Invalid Request" : `Invalid Request: ${detail}`,
          RpcErrorCodes.INVALID_REQUEST,
          {
            data: {
              errors,
            },
          }
        );
      }

      return method.apply(this, args);
    };
  };
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const RpcMethodValidator = (dto: any) =>
  validationFactory(Symbol("rpc-method"), dto);
