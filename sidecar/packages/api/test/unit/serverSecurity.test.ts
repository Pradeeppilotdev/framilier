import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@skandha/types/lib/api/interfaces";

const capture = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../src/logger.js", async () => {
  const { default: pino } = await import("pino");
  return { default: pino({ level: "trace" }, { write: (line: string) => capture.lines.push(line) }) };
});
import { Server } from "../../src/server.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.http.close();
    if (server.ws && server.ws !== server.http) await server.ws.close();
  }
  capture.lines.length = 0;
});
const options = (logging: boolean, separate = false): ServerConfig => ({
  host: "127.0.0.1", port: 14337, cors: "*", ws: separate, wsPort: 14338,
  enableRequestLogging: logging,
});

describe("API server security settings", () => {
  it.each([false, true])("honors request logging=%s for custom body hooks", async logging => {
    const server = await Server.init(options(logging));
    servers.push(server);
    server.http.post("/probe", async () => ({ marker: "response-marker" }));
    await server.http.inject({ method: "POST", url: "/probe", payload: { marker: "request-marker" } });
    const logs = capture.lines.join("");
    expect(logs.includes("request-marker")).toBe(logging);
    expect(logs.includes("response-marker")).toBe(logging);
  });

  it("registers bounded WebSockets on a separate port too", async () => {
    const server = await Server.init(options(false, true));
    servers.push(server);
    server.ws!.get("/probe", { websocket: true }, () => {});
    await server.ws!.ready();
    expect(server.ws!.websocketServer.options.maxPayload).toBe(1024 * 1024);
  });
  it("rejects an upgrade with missing parsed headers without throwing", async () => {
    const server = await Server.init({ ...options(false), ws: true, port: 0, wsPort: 0 });
    servers.push(server);
    await server.http.ready();
    const transport = new PassThrough();
    let response = "";
    transport.on("data", chunk => { response += chunk.toString(); });
    // Header-count truncation can remove Upgrade from the parsed header map.
    // Exercise the actual WebSocket dependency selected by the API plugin.
    expect(() => server.http.websocketServer.handleUpgrade(
      { method: "GET", headers: {} } as any, transport as any, Buffer.alloc(0), () => {
        throw new Error("Malformed handshake accepted");
      }
    )).not.toThrow();
    expect(response).toContain("400 Bad Request");
    transport.destroy();
  });

});
