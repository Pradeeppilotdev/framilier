/**
 * Test-only stand-in for the real `GethTracer`
 * (`packages/executor/src/services/UserOpValidation/GethTracer.ts`), wired
 * in globally via `vitestSetup.ts`'s `vi.mock`. Callers throughout
 * `src/` (`FrameTxValidationService`, `FrameTxSimulationService`, ...)
 * construct this with `new GethTracer(publicClient)` and then call its
 * methods - so this mock must accept the same constructor shape and, when
 * a `publicClient` is given, delegate to `publicClient.request(...)`
 * exactly like the real implementation does. That's what lets tests inject
 * fixture data via a fake `{ request: vi.fn().mockResolvedValue(...) }`
 * client (see e.g. `test/services/UserOpValidation/validators/frameTx.test.ts`'s
 * `fakePublicClient`) and have it actually reach the service under test,
 * rather than being shadowed by a hardcoded empty response.
 *
 * When no `publicClient` is supplied (e.g. a bare `new GethTracer()`),
 * falls back to a minimal well-shaped passing result so any caller that
 * doesn't care about tracer output still gets a well-shaped response.
 */
export class GethTracer {
  constructor(
    private publicClient?: { request: (payload: unknown) => Promise<unknown> }
  ) {}

  /**
   * Mirrors the real `GethTracer.simulateFrameTransaction` (ethrex's
   * `ethrex_simulateFrameTransaction` RPC) - see the real implementation's
   * doc comment for the wire contract. Delegates to `publicClient.request`
   * when a client is present so tests can inject a fake
   * `EthrexSimulateFrameTransactionResult` fixture; otherwise falls back to
   * a minimal well-shaped passing result.
   */
  async simulateFrameTransaction(
    rawTx: `0x${string}`,
    trace: boolean,
    block?: string
  ): Promise<unknown> {
    if (this.publicClient) {
      return await this.publicClient.request({
        method: "ethrex_simulateFrameTransaction",
        params: [rawTx, block ?? "latest", { trace }],
      });
    }
    return {
      canonicalMempoolValid: true,
      prefixShape: "SelfVerify",
      payer: "0x0000000000000000000000000000000000000000",
      maxCost: "0x0",
      canonicalMempoolViolation: null,
      gasUsed: "0x0",
      frames: [],
      executionStatus: "success",
      executionError: null,
      erc7562Trace: [],
      erc7562TraceError: null,
    };
  }
}
