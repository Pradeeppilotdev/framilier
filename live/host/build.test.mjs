import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("packaged Worker serves the selected verified replay without a runner or database", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "framilier-worker-check-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "worker.mjs");
  const build = fileURLToPath(new URL("./build.mjs", import.meta.url));
  const outcome = spawnSync(process.execPath, [build, file], { encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stderr);
  const { default: worker } = await import(pathToFileURL(file));
  const request = (query = "", method = "GET") => worker.fetch(new Request("https://demo.example/api/replay" + query, { method }), {});
  const legacy = await (await request()).json();
  assert.equal(legacy.scenario, "self-paid");
  assert.equal(legacy.source, "replay");
  const sponsored = await (await request("?scenario=shared-paymaster")).json();
  assert.equal(sponsored.scenario, "shared-paymaster");
  assert.equal(sponsored.evidence.totalMined, 81);
  assert.ok(sponsored.evidence.sponsorshipChecked);
  for (const query of ["?scenario=zk", "?rpc=https://example.com", "?scenario=self-paid&scenario=shared-paymaster", "?scenario=__proto__"]) {
    assert.equal((await request(query)).status, 400);
  }
  assert.equal((await request("", "POST")).status, 405);
  assert.equal(await (await request("?scenario=shared-paymaster", "HEAD")).text(), "");
});
