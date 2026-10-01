import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { recheckEvidence } from '../../../../../../lib/bank-statement-recheck.ts';

const approved = { transactionId: 'tx', voucherDate: '2026-09-30', amount: 518779,
  expectedDirection: 'outgoing', referenceNumber: '1967486047', bankLedgerName: 'HDFC', companyName: 'Company' };

function fixture() {
  const state = {
    user: { id: 'owner' }, datasets: ['dataset'], queued: [], writes: [], refreshed: [], failRowUpdate: false,
    target: { companyDatasetId: 'dataset', companyName: 'Company', connectionId: 'connector' },
    tables: {
      bank_statement_imports: [{ id: 'statement', owner_user_id: 'owner', company_dataset_id: 'dataset' }],
      bank_transactions: [{ id: 'tx', fingerprint: 'fingerprint', statement_import_id: 'statement', owner_user_id: 'owner', company_dataset_id: 'dataset', tally_status: 'needs_tally_review' }],
      bank_transaction_posting_log: [{ id: 'log', command_id: 'original', source_transaction_id: 'tx', fingerprint: 'fingerprint', owner_user_id: 'owner', company_dataset_id: 'dataset', status: 'needs_tally_review', result: { importSummary: { created: 18, errors: 0 } } }],
      tally_bridge_commands: [{ id: 'original', owner_user_id: 'owner', company_dataset_id: 'dataset', connection_id: 'connector', command_type: 'post_bank_voucher', payload: approved, queue_job_id: 'job' }],
    },
  };
  const db = { from(table) {
    const filters = [];
    let values, single = false, limit = Infinity;
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      in(key, values) { filters.push(row => values.includes(row[key])); return query; },
      contains(key, values) { filters.push(row => Object.entries(values).every(([k, v]) => row[key]?.[k] === v)); return query; },
      order() { return query; },
      limit(value) { limit = value; return query; },
      single() { single = true; return query; },
      maybeSingle() { single = true; return query; },
      update(value) { values = value; return query; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          const rows = state.tables[table].filter(row => filters.every(filter => filter(row))).slice(0, limit);
          if (values) {
            if (table === 'bank_transactions' && state.failRowUpdate) {
              state.failRowUpdate = false;
              return { data: null, error: new Error('simulated transient failure') };
            }
            state.writes.push({ table, ids: rows.map(row => row.id), values });
            rows.forEach(row => Object.assign(row, values));
          }
          return { data: single ? rows[0] ?? null : rows, error: null };
        }).then(resolve, reject);
      },
    };
    return query;
  } };
  const mocks = {
    '@/lib/api/cors': { jsonWithCors: (_request, body, init) => Response.json(body, init), optionsWithCors: () => new Response(null) },
    '@/lib/api/request-auth': { requireRequestUser: async () => state.user },
    '@/lib/supabase/admin': { createSupabaseAdminClient: () => db },
    '@/lib/tally/browser-scope': { browserDatasetIds: async () => state.datasets, resolveTallyTarget: async () => state.target },
    '@/lib/tally/queue-command': { queueTallyCommandAndWake: async options => {
      state.queued.push(options);
      const command = { id: `check-${state.queued.length}`, status: 'queued', payload: options.payload, command_type: options.commandType,
        connection_id: options.connectionId, owner_user_id: options.ownerUserId, company_dataset_id: options.companyDatasetId };
      state.tables.tally_bridge_commands.push(command);
      return { command };
    } },
    '@/lib/bank-statement-recheck': { recheckEvidence },
    '@/lib/bank-statement-tally-queue-status': { refreshBankStatementQueueJobStatus: async (_db, id) => state.refreshed.push(id) },
  };
  const filename = fileURLToPath(new URL('./route.ts', import.meta.url));
  const mod = new Module(filename);
  mod.require = id => {
    if (!(id in mocks)) throw new Error(`Unexpected import: ${id}`);
    return mocks[id];
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return { state, route: mod.exports };
}
const context = { params: Promise.resolve({ id: 'statement' }) };
const request = (method, body) => new Request('http://localhost/api/bank-statements/imports/statement/recheck', {
  method, ...(body ? { body: JSON.stringify(body) } : {}),
});

test('check again queues only read-only verification with the original approved payload and reuses an active check', async () => {
  const { state, route } = fixture();
  assert.equal((await route.POST(request('POST'), context)).status, 200);
  assert.equal((await route.POST(request('POST'), context)).status, 200);
  assert.equal(state.queued.length, 1);
  assert.equal(state.queued[0].commandType, 'verify_bank_transaction');
  assert.deepEqual(state.queued[0].payload.transactions, [approved]);
  assert.equal(state.queued[0].payload.transactionId, undefined);
  assert.equal(state.writes.length, 0);
});

test('check again rejects signed-out users, inaccessible statements and changed company identities', async () => {
  for (const [change, status] of [[s => { s.user = null; }, 401], [s => { s.datasets = ['another']; }, 404],
    [s => { s.target.companyDatasetId = 'another'; }, 409]]) {
    const { state, route } = fixture();
    change(state);
    assert.equal((await route.POST(request('POST'), context)).status, status);
    assert.equal(state.queued.length, 0);
    assert.equal(state.writes.length, 0);
  }
});

test('missing and ambiguous verification evidence keep the original posting uncertain', async () => {
  for (const verificationStatus of ['missing', 'ambiguous']) {
    const { state, route } = fixture();
    await route.POST(request('POST'), context);
    Object.assign(state.tables.tally_bridge_commands[1], { status: 'succeeded', result: {
      transactions: [{ transactionId: 'tx', verificationStatus, matchCount: verificationStatus === 'missing' ? 0 : 2 }] } });
    const response = await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context);
    assert.deepEqual(await response.json(), { confirmed: 0 });
    assert.equal(state.writes.length, 0);
    assert.equal(state.tables.bank_transactions[0].tally_status, 'needs_tally_review');
  }
});

test('unique evidence saves confirmation idempotently without changing the original command', async () => {
  const { state, route } = fixture();
  await route.POST(request('POST'), context);
  Object.assign(state.tables.tally_bridge_commands[1], { status: 'succeeded', result: {
    transactions: [{ transactionId: 'tx', verificationStatus: 'found', matchCount: 1, voucherId: '428329', voucherNumber: '123' }] } });
  for (let i = 0; i < 2; i++) {
    const response = await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context);
    assert.deepEqual(await response.json(), { confirmed: 1 });
  }
  assert.equal(state.tables.bank_transactions[0].tally_status, 'verified');
  assert.equal(state.tables.bank_transaction_posting_log[0].result.voucherNumber, '123');
  assert.deepEqual(state.tables.bank_transaction_posting_log[0].result.importSummary, { created: 18, errors: 0 });
  assert.deepEqual(state.tables.tally_bridge_commands[0].payload, approved);
  assert.equal(state.queued.length, 1);
  assert.deepEqual(state.refreshed, ['job', 'job']);
});

test('a retry finishes a partially saved confirmation without queuing another command', async () => {
  const { state, route } = fixture();
  await route.POST(request('POST'), context);
  Object.assign(state.tables.tally_bridge_commands[1], { status: 'succeeded', result: {
    transactions: [{ transactionId: 'tx', verificationStatus: 'found', matchCount: 1, voucherId: '428329' }] } });
  state.failRowUpdate = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context)).status, 500);
  } finally { console.error = originalError; }
  assert.equal(state.tables.bank_transaction_posting_log[0].status, 'verified');
  assert.equal(state.tables.bank_transactions[0].tally_status, 'needs_tally_review');
  const retry = await route.POST(request('POST'), context);
  assert.deepEqual((await retry.json()).commandIds, ['check-1']);
  assert.equal(state.queued.length, 1);
  assert.equal((await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context)).status, 200);
  assert.equal(state.tables.bank_transactions[0].tally_status, 'verified');
});
