import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const worker = await readFile(new URL('./process-packet-jobs.mjs', import.meta.url), 'utf8');
const versionStart = worker.indexOf('function connectorVersionAtLeast(');
const versionEnd = worker.indexOf('\nasync function preprocessBankStatementWithConnector(', versionStart);
const versionCheck = vm.runInNewContext(`(${worker.slice(versionStart, versionEnd).trim()})`);
const waitStart = worker.indexOf('async function waitForConnectorPreprocessCommand(');
const waitEnd = worker.indexOf('\nfunction markBankLedgerRecommendationsUnavailable(', waitStart);
const parsed = { transactions: [{ reference_number: 'UTRAX261009006' }] };
function setup(version) {
  const current = { status: 'succeeded', bridge_version: version, result: { parsed: { content: parsed }, matching: [{ suggestions: [{ ledgerName: 'Deccan Sponge and Minerals' }] }] } };
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: current, error: null }) };
  return vm.runInNewContext(`(${worker.slice(waitStart, waitEnd).trim()})`, {
    supabase: { from: () => query }, connectorVersionAtLeast: versionCheck, CONNECTOR_PREPROCESS_TIMEOUT_MS: 1000,
  });
}
test('completed eager commands from old or unreported connector versions cannot bypass source-reference recovery', async () => {
  for (const version of ['0.1.77', '0.1.69', null]) {
    const result = await setup(version)({ commandId: 'old-eager', ownerUserId: 'owner', prequeued: true });
    assert.equal(result.used, false);
    assert.equal(result.reason, 'connector_update_required');
  }
});
test('updated connector results retain their original bank identity and future versions are supported', async () => {
  for (const version of ['0.1.78', '0.1.79', '0.2.0', '1.0.0']) {
    const result = await setup(version)({ commandId: 'updated-eager', ownerUserId: 'owner', prequeued: true });
    assert.equal(result.used, true);
    assert.equal(result.parsed.transactions[0].reference_number, 'UTRAX261009006');
  }
});
