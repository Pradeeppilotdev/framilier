import { expect, test, type Page } from "@playwright/test";
import { TX } from "../mock/fixtures";
import { MOCK_PORTS } from "../mock/ports";

const control = async (port: number, path: string) => {
  const response = await fetch(`http://localhost:${port}/__mock/${path}`, { method: "POST" });
  if (!response.ok) throw new Error(`Mock control ${path} on port ${port} answered HTTP ${response.status}`);
  return response;
};

test.beforeEach(async () => {
  for (const port of Object.values(MOCK_PORTS)) await control(port, "reset");
});

const rowsIn = (page: Page) => page.locator("main tbody tr");

test("shows the pool of the first instance, live, with a strip of frames per transaction", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Devnet miner" })).toBeVisible();
  await expect(page.getByText("Chain 1337, auto bundling, Sidecar 4.1.1 (a1b2c3d), p2p on")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  await expect(page.getByTitle(TX.onChain.hash)).toBeVisible();
  await expect(page.getByTitle(TX.bannedOpcode.hash)).toHaveCount(0);
  await expect(rowsIn(page).first().getByLabel("Frames")).toBeVisible();
});

test("a transaction that arrives appears without a reload, and is highlighted for a moment", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  await expect(page.getByTitle(TX.onChain.hash)).toBeVisible();
  const before = await rowsIn(page).count();
  const response = await control(MOCK_PORTS.primary, "admit");
  const { hash } = (await response.json()) as { hash: string };
  await expect(rowsIn(page)).toHaveCount(before + 1);
  await expect(page.getByTitle(hash)).toBeVisible();
  await expect(page.locator("main tbody tr.row-fresh")).toHaveCount(1);
  await expect(page.locator("main tbody tr.row-fresh")).toHaveCount(0, { timeout: 6000 });
});

test("explains a rejection on the activity list and on the transaction page", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByText("payer uses banned opcode: DIFFICULTY")).toBeVisible();
  await expect(page.getByLabel("Validation prefix: failed")).toBeVisible();

  await page.getByTitle(TX.bannedOpcode.hash).click();
  await expect(page).toHaveURL(new RegExp(`/tx/${TX.bannedOpcode.hash}`));
  await expect(page.getByText("Turned away: Banned opcodes (payer, frame 0).")).toBeVisible();
  const report = page.getByRole("heading", { name: "Admission report" }).locator("xpath=ancestor::section[1]");
  await expect(report.getByText("payer uses banned opcode: DIFFICULTY")).toBeVisible();
  await expect(report.getByRole("heading", { name: "Frame 0, payer" })).toBeVisible();
});

test("lines up when each instance first saw a transaction", async ({ page }) => {
  await page.goto(`/tx/${TX.onChain.hash}?node=${encodeURIComponent("http://localhost:14401/rpc")}`);
  const across = page.getByRole("heading", { name: "Across instances" }).locator("xpath=ancestor::section[1]");
  await expect(across.getByText("+240 ms")).toBeVisible();
  await expect(across.getByRole("cell", { name: "first", exact: true })).toBeVisible();
  await expect(across.getByText("The explorer isn't available on this node")).toBeVisible();
});

test("switches instances, and says when a node has the explorer off", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTitle(TX.onChain.hash)).toBeVisible();
  await page.getByRole("button", { name: /^Local peer/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Local peer" })).toBeVisible();
  await expect(page.getByTitle(TX.onlySecondary.hash)).toBeVisible();
  await expect(page.getByTitle(TX.sponsored.hash)).toHaveCount(0);

  await page.getByRole("button", { name: /^No explorer/ }).click();
  await expect(page.getByText("The explorer isn't available on this node")).toBeVisible();
  await expect(page.getByText(/--explorer\.enable/)).toBeVisible();
});

test("resumes after the connection drops, without missing a transaction", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  await expect(page.getByTitle(TX.onChain.hash)).toBeVisible();
  const before = await rowsIn(page).count();
  await control(MOCK_PORTS.primary, "disconnect");
  await expect(page.getByRole("status").filter({ hasText: /Reconnecting|Offline/ })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible({ timeout: 8000 });
  await control(MOCK_PORTS.primary, "admit");
  await expect(rowsIn(page)).toHaveCount(before + 1);
});

test("tells you when the node restarted, and reloads what it knows", async ({ page }) => {
  await page.goto("/activity");
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  await expect(page.getByText("payer uses banned opcode: DIFFICULTY")).toBeVisible();
  await control(MOCK_PORTS.primary, "restart");
  await control(MOCK_PORTS.primary, "disconnect");
  await expect(page.getByText("This node restarted, so its history was reloaded.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Nothing here yet.")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("This node restarted, so its history was reloaded.")).toHaveCount(0);
});

test("adds an instance from the list and removes it again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add instance" }).click();
  await page.getByLabel("Node URL").fill("http://localhost:14402");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("That instance is already in the list.");
  await page.getByLabel("Node URL").fill("http://localhost:1");
  await page.getByLabel("Name (optional)").fill("Nothing here");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Nothing here" })).toBeVisible();
  await expect(page.getByText("Couldn't reach localhost:1")).toBeVisible();
  await page.getByRole("button", { name: "Remove Nothing here" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Devnet miner" })).toBeVisible();
});

test("pins the configured instances and remembers the user's own across a reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Pinned")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Rename Devnet miner" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove Devnet miner" })).toHaveCount(0);

  await page.getByRole("button", { name: "Add instance" }).click();
  await page.getByLabel("Node URL").fill("http://localhost:1");
  await page.getByLabel("Name (optional)").fill("Mine");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Mine" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: /^Mine/ })).toBeVisible();
  await expect(page.getByText("Pinned")).toHaveCount(3);
  await expect(page.getByRole("heading", { level: 1, name: "Mine" })).toBeVisible();
});

test("a list saved by an older visit does not override the configured instances", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "frame-explorer/instances/v1",
      JSON.stringify({
        instances: [{ name: "Old name", url: "http://localhost:14401/rpc" }],
        selectedUrl: "http://localhost:14401/rpc",
      }),
    );
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Devnet miner" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Old name/ })).toHaveCount(0);
  await expect(page.getByText("Pinned")).toHaveCount(3);
});

test("follows the system color scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByTitle(TX.onChain.hash)).toBeVisible();
  const light = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(light).toBe("rgb(233, 238, 241)");
  expect(dark).toBe("rgb(15, 26, 34)");
});

test("fits a phone-width screen without sideways scrolling of the page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ["/", "/activity", `/tx/${TX.bannedOpcode.hash}?node=${encodeURIComponent("http://localhost:14401/rpc")}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: "Devnet miner" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `page overflows sideways at ${path}`).toBeLessThanOrEqual(0);
  }
});
