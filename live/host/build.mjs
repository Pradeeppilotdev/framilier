import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readReport } from "../report.mjs";

// A single Worker module serves the same assets and verified archive as the local server.
const output = process.argv[2];
if (!output) throw new Error("Usage: node live/host/build.mjs <output-worker.mjs>");
const publicDir = new URL("../public/", import.meta.url);
const archive = fileURLToPath(new URL("../../sidecar/evidence/compare/merged-main-7d052e7/", import.meta.url));
const assets = {};
for (const [path, type] of [["index.html", "text/html"], ["app.js", "text/javascript"], ["style.css", "text/css"]]) {
  assets["/" + path] = [type, await readFile(new URL(path, publicDir), "utf8")];
}
assets["/api/replay"] = ["application/json", JSON.stringify(await readReport(archive, "replay"))];
const relay = await readFile(new URL("./relay.mjs", import.meta.url), "utf8");
const entry = await readFile(new URL("./entry.mjs", import.meta.url), "utf8");
await writeFile(output, [relay, "const staticResponses = new Map(Object.entries(" + JSON.stringify(assets) + "));", entry].join("\n"));
