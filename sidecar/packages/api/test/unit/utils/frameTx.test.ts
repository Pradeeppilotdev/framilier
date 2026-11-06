import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { plainToInstance } from "class-transformer";
import { FrameTransactionDto } from "../../../src/dto/SendFrameTransaction.dto.js";
import { EstimateFrameTransactionArgs } from "../../../src/dto/EstimateFrameTransaction.dto.js";
import {
  toFrameTransaction,
  toPartialFrameTransaction,
} from "../../../src/utils/frameTx.js";
import {
  validFrameTransaction,
  validFrameTransactionWire,
} from "../../fixtures.js";

describe("frameTx wire<->executor conversion", () => {
  it("toFrameTransaction decodes every hex-string field into bigint", () => {
    const dto = plainToInstance(FrameTransactionDto, validFrameTransactionWire);
    expect(toFrameTransaction(dto)).toEqual(validFrameTransaction);
  });

  it("toPartialFrameTransaction leaves omitted optional fields as undefined rather than defaulting them (the executor, not the api layer, owns those defaults)", () => {
    const dto = plainToInstance(EstimateFrameTransactionArgs, {
      sender: validFrameTransactionWire.sender,
      frames: validFrameTransactionWire.frames,
    });

    const result = toPartialFrameTransaction(dto);

    expect(result.chainId).toBeUndefined();
    expect(result.nonce).toBeUndefined();
    expect(result.signatures).toBeUndefined();
    expect(result.fees).toBeUndefined();
    expect(result.blobVersionedHashes).toBeUndefined();
    expect(result.sender).toEqual(validFrameTransactionWire.sender);
    expect(result.frames).toEqual(validFrameTransaction.frames);
  });

  it("toPartialFrameTransaction decodes present optional fields", () => {
    const dto = plainToInstance(
      EstimateFrameTransactionArgs,
      validFrameTransactionWire
    );

    expect(toPartialFrameTransaction(dto)).toEqual(validFrameTransaction);
  });
});
