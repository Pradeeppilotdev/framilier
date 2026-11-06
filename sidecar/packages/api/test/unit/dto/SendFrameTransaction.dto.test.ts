import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { deepHexlify } from "@skandha/utils/lib/hexlify.js";
import { FrameTransactionDto } from "../../../src/dto/SendFrameTransaction.dto.js";
import { validFrameTransactionWire } from "../../fixtures.js";

/**
 * N1 regression coverage: every RPC response passes through `deepHexlify`
 * (`app.ts`), which turns plain JS numbers into hex strings - including
 * `FrameDto.mode`/`FrameDto.flags` and `SignatureEntryDto.scheme`. A client
 * that reads a transaction back (e.g. from `eth_getFrameTransactionByHash`)
 * and replays that exact JSON into `eth_sendFrameTransaction`/
 * `debug_bundler_setMempool` must not get rejected merely because those
 * three fields arrived as hex strings instead of plain numbers.
 */
describe("FrameTransactionDto - mode/flags/scheme dual-format acceptance (N1)", () => {
  it("accepts the original plain-number wire format (regression guard)", async () => {
    const dto = plainToInstance(FrameTransactionDto, validFrameTransactionWire);
    const errors = await validate(dto);
    expect(errors).toEqual([]);
  });

  it("accepts a hexlified transaction round-tripped through deepHexlify (mode/flags/scheme as hex strings)", async () => {
    const hexlified = deepHexlify(validFrameTransactionWire);
    // sanity check the fixture actually exercises the hex-string path
    expect(typeof hexlified.frames[0].mode).toBe("string");
    expect(typeof hexlified.frames[0].flags).toBe("string");
    expect(typeof hexlified.signatures[0].scheme).toBe("string");

    const dto = plainToInstance(FrameTransactionDto, hexlified);
    const errors = await validate(dto);
    expect(errors).toEqual([]);
  });

  it("still rejects a mode value outside FRAME_MODE, whether plain or hex", async () => {
    const badPlain = {
      ...validFrameTransactionWire,
      frames: [{ ...validFrameTransactionWire.frames[0], mode: 99 }],
    };
    const badHex = {
      ...validFrameTransactionWire,
      frames: [{ ...validFrameTransactionWire.frames[0], mode: "0x63" }],
    };

    for (const bad of [badPlain, badHex]) {
      const dto = plainToInstance(FrameTransactionDto, bad);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it("still rejects a flags value outside the valid 3-bit range, whether plain or hex", async () => {
    const badPlain = {
      ...validFrameTransactionWire,
      frames: [{ ...validFrameTransactionWire.frames[0], flags: 8 }],
    };
    const badHex = {
      ...validFrameTransactionWire,
      frames: [{ ...validFrameTransactionWire.frames[0], flags: "0x8" }],
    };

    for (const bad of [badPlain, badHex]) {
      const dto = plainToInstance(FrameTransactionDto, bad);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it("still rejects a scheme value outside SIG_SCHEME, whether plain or hex", async () => {
    const badPlain = {
      ...validFrameTransactionWire,
      signatures: [{ ...validFrameTransactionWire.signatures[0], scheme: 7 }],
    };
    const badHex = {
      ...validFrameTransactionWire,
      signatures: [
        { ...validFrameTransactionWire.signatures[0], scheme: "0x7" },
      ],
    };

    for (const bad of [badPlain, badHex]) {
      const dto = plainToInstance(FrameTransactionDto, bad);
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    }
  });
});
