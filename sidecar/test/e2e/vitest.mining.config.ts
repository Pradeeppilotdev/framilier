import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig, defineConfig } from "vitest/config";
import vitestConfig from "../../vitest.base.config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Separate from `vitest.config.ts` (the other e2e tests) on purpose:
 * `frameTxInclusion.e2e.test.ts` needs a real Kurtosis-driven, block-
 * producing devnet (Docker + the Kurtosis CLI, several minutes of real
 * fork-activation wall-clock time), not just `docker run` against a
 * `--dev`-mode single node - see that test file's own header comment. Kept
 * out of `test/e2e/vitest.config.ts`'s `include` so `bun run test:e2e`
 * (tier 2, frame-tx-e2e.yml) doesn't need the Kurtosis CLI installed.
 *
 * Run with: `npx vitest run --config test/e2e/vitest.mining.config.ts`
 * (or `bun run test:e2e:mining` from the repo root).
 */
export default mergeConfig(
  vitestConfig,
  defineConfig({
    root,
    test: {
      include: [
        "test/e2e/frameTxInclusion.e2e.test.ts",
        "test/e2e/frameTxSharedSender.e2e.test.ts",
      ],
      testTimeout: 300_000,
      hookTimeout: 600_000,
      teardownTimeout: 180_000,
      coverage: { enabled: false },
    },
  })
);
