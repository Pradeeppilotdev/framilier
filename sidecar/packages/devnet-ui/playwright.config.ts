import { defineConfig } from "@playwright/test";

/** The three mock nodes from `mock/dev.ts`, as the app's first-visit instance list. */
const INSTANCES = JSON.stringify([
  { name: "Devnet miner", url: "http://localhost:14401/rpc" },
  { name: "Local peer", url: "http://localhost:14402/rpc" },
  { name: "No explorer", url: "http://localhost:14403/rpc" },
]);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    // Playwright cannot install its own Chromium on some older macOS versions;
    // the installed Chrome works everywhere. Set PW_CHANNEL=chromium in CI to
    // use the bundled build instead.
    channel: process.env.PW_CHANNEL ?? "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: [
    { command: "bun run mock/dev.ts", port: 14401, reuseExistingServer: !process.env.CI },
    {
      command: "bunx vite --port 4173 --strictPort",
      port: 4173,
      reuseExistingServer: !process.env.CI,
      env: { VITE_EXPLORER_INSTANCES: INSTANCES },
    },
  ],
});
