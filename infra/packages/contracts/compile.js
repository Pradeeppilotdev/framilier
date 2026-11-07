const fs = require('fs');
const path = require('path');
const solc = require('solc');

const contractsDir = path.join(__dirname, 'src');
const outDir = path.join(__dirname, 'artifacts');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function findSolFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findSolFiles(fullPath));
    } else if (file.endsWith('.sol')) {
      results.push(fullPath);
    }
  });
  return results;
}

const solFiles = findSolFiles(contractsDir);
const sources = {};

solFiles.forEach((file) => {
  const relativePath = path.relative(contractsDir, file).replace(/\\/g, '/');
  sources[relativePath] = {
    content: fs.readFileSync(file, 'utf8'),
  };
});

const input = {
  language: 'Solidity',
  sources,
  settings: {
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object'],
      },
    },
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
};

console.log('Compiling Solidity contracts...');
const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  let hasError = false;
  output.errors.forEach((err) => {
    if (err.severity === 'error') {
      console.error(err.formattedMessage);
      hasError = true;
    } else {
      console.warn(err.formattedMessage);
    }
  });
  if (hasError) {
    process.exit(1);
  }
}

const artifacts = {};
for (const file in output.contracts) {
  for (const name in output.contracts[file]) {
    const contract = output.contracts[file][name];
    artifacts[name] = {
      abi: contract.abi,
      bytecode: contract.evm.bytecode.object,
    };
    fs.writeFileSync(
      path.join(outDir, `${name}.json`),
      JSON.stringify(artifacts[name], null, 2)
    );
    console.log(`Saved artifact: ${name}.json`);
  }
}

console.log('Compilation completed successfully!');

