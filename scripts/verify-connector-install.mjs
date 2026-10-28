import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const baseline = path.resolve(process.argv[2]);
const candidate = path.resolve(process.argv[3]);
function manifest(root, current = root, result = new Map()) {
  for (const entry of fs.readdirSync(current, {withFileTypes:true})) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) manifest(root, file, result);
    else if (entry.isFile()) result.set(path.relative(root, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  }
  return result;
}
if (!process.argv.includes('--skip-manifest')) {
  const expected = manifest(baseline);
  const actual = manifest(candidate);
  assert.equal(actual.size, expected.size);
  for (const [file, hash] of expected) assert.equal(actual.get(file), hash, `Installed file changed: ${file}`);
  console.log(`Verified SHA256 of all ${actual.size} installed files.`);
}
const app = path.join(candidate, 'resources/app');
const smoke = path.join(path.dirname(candidate), 'parser-smoke.mjs');
fs.writeFileSync(smoke, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const app = ${JSON.stringify(app)};
const require = createRequire(app + '/package.json');
const {resolveBankBillReference} = await import(pathToFileURL(app + '/src/local-matching/bill-reference.mjs'));
assert.equal(typeof resolveBankBillReference, 'function');
require('@zvec/zvec');
require('@napi-rs/canvas');
const {parseDocumentLocal, processBankStatementMarkdownLocal} = await import(pathToFileURL(app + '/src/document-parsing/parser.mjs'));
const pdf = ${JSON.stringify(process.argv[4] || 'C:/Users/Shubham/Desktop/Axis-Statement-from-Capture-24-25-Oct-2026.pdf')};
const result = await parseDocumentLocal({filePath:pdf});
const bank = await processBankStatementMarkdownLocal(result.content, {pdfBytes:fs.readFileSync(pdf)});
assert.equal(bank.parsed.transactions.length, 6);
assert.notEqual(bank.diagnostics.balanceValidation.status, 'failed');
const summary = {nativeModules:true, transactions:bank.parsed.transactions.length, balances:bank.diagnostics.balanceValidation.status};
fs.writeFileSync(${JSON.stringify(path.join(path.dirname(candidate), 'parser-smoke-result.json'))}, JSON.stringify(summary));
console.log(JSON.stringify(summary));
process.exit(0);
`);
execFileSync(path.join(candidate, 'Gajkesari Tally Connector.exe'), [smoke], {
  cwd:app, windowsHide:true, timeout:120000, stdio:'inherit',
  env:{...process.env, ELECTRON_RUN_AS_NODE:'1'},
});
assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(candidate), 'parser-smoke-result.json'))).transactions, 6);
