import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig, defineConfig } from "vitest/config";
import vitestConfig from "../../vitest.base.config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Separate from the root/per-package configs on purpose: these tests spawn
 * real processes and a real Docker-hosted execution client, so they are far
 * slower than the unit suites and must not be swept into `bun run coverage`.
 *
 * Run with: `npx vitest run --config test/e2e/vitest.config.ts`
 * (or `bun run test:e2e` from the repo root).
 */
export default mergeConfig(
  vitestConfig,
  defineConfig({
    root,
    test: {
      include: ["test/e2e/**/*.e2e.test.ts"],
      // frameTxInclusion.e2e.test.ts needs Docker + the Kurtosis CLI (a real
      // block-producing devnet, not just `docker run`) and runs an order of
      // magnitude slower again than the tests above it - kept out of the
      // default `test:e2e`/tier-2 run and given its own
      // vitest.mining.config.ts + CI job (frame-tx-e2e-mining.yml) instead.
      exclude: [
        "test/e2e/frameTxInclusion.e2e.test.ts",
        "test/e2e/frameTxSharedSender.e2e.test.ts",
      ],
      testTimeout: 300_000,
      hookTimeout: 600_000,
      teardownTimeout: 120_000,
      coverage: { enabled: false },
    },
  })
);
