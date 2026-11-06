/* eslint-disable @typescript-eslint/no-explicit-any */
import { Hex, PublicClient } from "viem";
import { EthrexSimulateFrameTransactionResult } from "@skandha/types/lib/executor/validation/ethrexFrameTx.js";

export class GethTracer {
  constructor(private publicClient: PublicClient) {}

  /**
   * `ethrex_simulateFrameTransaction` - ethrex's (LambdaClass's
   * `hegota-testnet` branch) real EIP-8141 frame-transaction simulation
   * RPC. Unlike `debug_traceCall`, this takes the transaction's own raw
   * canonical encoding directly (see `FrameTxService/codec.ts`'s
   * `encodeRawFrameTx`) - there is no `TransactionRequest`/ABI-call shape
   * involved, since a frame transaction's execution semantics are
   * protocol-native, not a contract call.
   *
   * Verified against ethrex's `SimulateFrameTransactionRequest::parse`
   * (`crates/networking/rpc/ethrex.rs`): `rawTx` must be `0x`-prefixed;
   * `block` is deliberately never sent as a literal JSON `null` - ethrex's
   * `BlockIdentifierOrHash::parse` rejects a `null` second param outright
   * (falls through every match arm to a `BadParams` error), so an absent
   * `block` here means "default to latest" via an explicit `"latest"`
   * string, not an explicit null. `{trace}` is always sent as the third
   * param; `false` there is byte-for-byte the RPC's pre-existing
   * (pre-tracing) behavior, so callers not needing a trace should still
   * pass `trace: false` explicitly rather than omitting the param, to keep
   * this method's own contract simple (always 3 params).
   *
   * `GethTracer`'s name is a slight misnomer for this method (it talks to
   * ethrex, not geth) - kept as-is since this is the sole tracer this
   * fork's bundler depends on.
   */
  async simulateFrameTransaction(
    rawTx: Hex,
    trace: boolean,
    block?: string
  ): Promise<EthrexSimulateFrameTransactionResult> {
    const payload = {
      method: "ethrex_simulateFrameTransaction" as any,
      params: [rawTx, block ?? "latest", { trace }],
    };
    return (await this.publicClient.request(
      payload as any
    )) as EthrexSimulateFrameTransactionResult;
  }
}
