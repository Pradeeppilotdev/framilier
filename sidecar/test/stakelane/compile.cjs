// The workshop opcode helpers require exactly solc 0.8.28.
const fs = require("node:fs");
const path = require("node:path");
const solc = require(process.env.STAKELANE_SOLC || "solc");
const support = path.resolve(process.env.STAKELANE_SUPPORT ||
  path.join(__dirname, "../../../mempool-workshop/node_modules/@forshtat/hegota-support"));
const expected = "0.8.28+commit.7893614a";
if (!solc.version().startsWith(expected)) throw new Error("Expected solc " + expected);
const contracts = ["HashChainWallet", "NaiveStakingRegistry"];
const sources = Object.fromEntries(contracts.map(name => [
  name + ".sol", { content: fs.readFileSync(path.join(__dirname, name + ".sol"), "utf8") }
]));
const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun",
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } };
const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings }), {
  import(p) {
    const prefix = "@forshtat/hegota-support/";
    if (!p.startsWith(prefix)) return { error: "Unknown import " + p };
    return { contents: fs.readFileSync(path.join(support, p.slice(prefix.length)), "utf8") };
  }
}));
const errors = (output.errors || []).filter(e => e.severity === "error");
if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join("\n"));
const fixtures = { compiler: solc.version(), optimizerRuns: 200, evmVersion: "cancun", contracts: {} };
for (const name of contracts) {
  const compiled = output.contracts[name + ".sol"][name];
  fixtures.contracts[name] = { abi: compiled.abi, bytecode: "0x" + compiled.evm.bytecode.object };
}
fs.writeFileSync(path.join(__dirname, "fixtures.json"), JSON.stringify(fixtures, null, 2) + "\n");
