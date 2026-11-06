import { disabledNode, primaryNode, secondaryNode } from "./fixtures";
import { MOCK_PORTS } from "./ports";
import { startMockServer } from "./server";

/**
 * The fixtures span about two minutes; start them just under that before now so
 * every page reads as recent instead of "350 d ago".
 */
const t0 = Date.now() - 130_000;

const servers = [
  { name: "Devnet miner (busy pool, p2p on)", port: MOCK_PORTS.primary, make: () => primaryNode(undefined, t0) },
  { name: "Local peer (saw part of it later, p2p off)", port: MOCK_PORTS.secondary, make: () => secondaryNode(undefined, t0) },
  { name: "No explorer (flag off)", port: MOCK_PORTS.disabled, make: () => disabledNode() },
];

for (const { name, port, make } of servers) {
  startMockServer(make, port);
  console.log(`${name}: http://localhost:${port}/rpc`);
}
console.log("Controls: POST /__mock/admit, /__mock/status?hash=&status=, /__mock/restart, /__mock/disconnect, /__mock/reset");
