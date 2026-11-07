import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readReport } from "../report.mjs";

// A single Worker module serves the same assets and verified archive as the local server.
const output = process.argv[2];
if (!output) throw new Error("Usage: node live/host/build.mjs <output-worker.mjs>");
const publicDir = new URL("../public/", import.meta.url);
const archives = {
  "self-paid": "merged-main-7d052e7",
  "shared-paymaster": "shared-paymaster-smoke",
};
const replays = {};
for (const [scenario, directory] of Object.entries(archives)) {
  const archive = fileURLToPath(new URL(`../../sidecar/evidence/compare/${directory}/`, import.meta.url));
  const result = await readReport(archive, "replay");
  if (result.scenario !== scenario) throw new Error("Replay scenario mismatch");
  replays[scenario] = JSON.stringify(result);
}
const assets = {};
for (const [path, type] of [["index.html", "text/html"], ["app.js", "text/javascript"], ["style.css", "text/css"]]) {
  assets["/" + path] = [type, await readFile(new URL(path, publicDir), "utf8")];
}
const relay = await readFile(new URL("./relay.mjs", import.meta.url), "utf8");
const entry = await readFile(new URL("./entry.mjs", import.meta.url), "utf8");
await writeFile(output, [relay, "const staticResponses = new Map(Object.entries(" + JSON.stringify(assets) + "));", "const replayResponses = " + JSON.stringify(replays) + ";", entry].join("\n"));
