import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as recheckHelpers from '../../../../../../lib/bank-statement-recheck.ts';

const approved = { transactionId: 'tx', voucherDate: '2026-09-30', amount: 518779,
  expectedDirection: 'outgoing', referenceNumber: '1967486047', bankLedgerName: 'HDFC', companyName: 'Company' };

function fixture() {
  const state = {
    user: { id: 'owner' }, datasets: ['dataset'], queued: [], writes: [], refreshed: [], failRowUpdate: false, beforeLogWrite: null,
    target: { companyDatasetId: 'dataset', companyName: 'Company', connectionId: 'connector' },
    tables: {
      bank_statement_imports: [{ id: 'statement', owner_user_id: 'owner', company_dataset_id: 'dataset' }],
      bank_transactions: [{ id: 'tx', fingerprint: 'fingerprint', statement_import_id: 'statement', owner_user_id: 'owner', company_dataset_id: 'dataset', tally_status: 'needs_tally_review' }],
      bank_transaction_posting_log: [{ id: 'log', command_id: 'original', source_transaction_id: 'tx', fingerprint: 'fingerprint', owner_user_id: 'owner', company_dataset_id: 'dataset', status: 'needs_tally_review', result: { importSummary: { created: 18, errors: 0 } } }],
      tally_bridge_commands: [{ id: 'original', owner_user_id: 'owner', company_dataset_id: 'dataset', connection_id: 'connector', command_type: 'post_bank_voucher', payload: approved, queue_job_id: 'job' }],
      tally_masters: [{ owner_user_id: 'owner', company_dataset_id: 'dataset', master_type: 'ledger', is_active: true, tally_name: 'Arvind' }],
    },
  };
  const db = { from(table) {
    const filters = [];
    let values, single = false, limit = Infinity;
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(row => key === 'result' && typeof value === 'string' ? JSON.stringify(row[key]) === value : row[key] === value); return query; },
      filter(key, operator, value) { filters.push(row => operator === 'is' ? row[key] == null : JSON.stringify(row[key]) === value); return query; },
      in(key, values) { filters.push(row => values.includes(row[key])); return query; },
      contains(key, values) { filters.push(row => Object.entries(values).every(([k, v]) => row[key]?.[k] === v)); return query; },
      order() { return query; },
      limit(value) { limit = value; return query; },
      single() { single = true; return query; },
      maybeSingle() { single = true; return query; },
      update(value) { values = value; return query; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (values && table === 'bank_transaction_posting_log' && state.beforeLogWrite) {
            state.beforeLogWrite(state.tables[table]);
            state.beforeLogWrite = null;
          }
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
    '@/lib/bank-statement-recheck': recheckHelpers,
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
    assert.deepEqual(await response.json(), { confirmed: 0, checked: 1, checkFailed: 0, remaining: 1 });
    assert.equal(state.writes.length, 1);
    assert.equal(state.tables.bank_transaction_posting_log[0].result.recheck.verification.verificationStatus, verificationStatus);
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
    assert.deepEqual(await response.json(), { confirmed: 1, checked: 1, checkFailed: 0, remaining: 0 });
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

test('a held entry can correct its selected ledger and recheck without changing the posting command or creating vouchers', async () => {
  const { state, route } = fixture();
  state.tables.bank_transaction_posting_log[0].result = { possibleDuplicateInTally: true };
  state.tables.tally_bridge_commands[0].payload = { ...approved, counterpartyLedgerName: 'BluePeak', matchedLedgerName: 'BluePeak' };
  const response = await route.POST(request('POST', { transactionId: 'tx', ledgerName: 'Arvind' }), context);
  assert.equal(response.status, 200);
  assert.equal(state.tables.bank_transactions[0].confirmed_ledger_name, 'Arvind');
  assert.equal(state.tables.bank_transaction_posting_log[0].result.ledgerReview.reviewedBy, 'owner');
  assert.equal(state.queued[0].commandType, 'verify_bank_transaction');
  assert.deepEqual(state.queued[0].payload.transactions[0], { ...approved, counterpartyLedgerName: 'Arvind', matchedLedgerName: 'Arvind' });
  assert.equal(state.tables.tally_bridge_commands[0].payload.counterpartyLedgerName, 'BluePeak');
  Object.assign(state.tables.tally_bridge_commands[1], { status: 'succeeded', result: { transactions: [{ transactionId: 'tx', verificationStatus: 'found', matchCount: 1, voucherId: '2721', voucherNumber: '2721', matches: [{ amount: 518779, partyLedgerName: 'Arvind' }] }] } });
  const result = await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context);
  assert.equal((await result.json()).confirmed, 1);
  assert.equal(state.tables.bank_transaction_posting_log[0].result.alreadyInTally, true);
  assert.equal(state.tables.bank_transaction_posting_log[0].result.recheck.verification.matches[0].partyLedgerName, 'Arvind');
});

test('ledger correction is rejected for an uncertain posting or another company ledger', async () => {
  for (const held of [false, true]) {
    const { state, route } = fixture();
    state.tables.bank_transaction_posting_log[0].result = { possibleDuplicateInTally: held };
    const response = await route.POST(request('POST', { transactionId: 'tx', ledgerName: held ? 'Other company ledger' : 'Arvind' }), context);
    assert.equal(response.status, held ? 400 : 409);
    assert.equal(state.writes.length, 0);
    assert.equal(state.queued.length, 0);
  }
});

test('a failed check retains the hold and saves a simple failure result', async () => {
  const { state, route } = fixture();
  await route.POST(request('POST'), context);
  state.tables.tally_bridge_commands[1].status = 'failed';
  const response = await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context);
  assert.deepEqual(await response.json(), { confirmed: 0, checked: 1, checkFailed: 1, remaining: 1 });
  assert.equal(state.tables.bank_transactions[0].tally_status, 'needs_tally_review');
  assert.equal(state.tables.bank_transaction_posting_log[0].result.recheck.verification.verificationStatus, 'failed');
});

test('an existing manual voucher cannot confirm a second indistinguishable row during recheck', async () => {
  const { state, route } = fixture();
  state.tables.bank_transaction_posting_log[0].result = { possibleDuplicateInTally: true };
  state.tables.bank_transaction_posting_log.push({ id: 'another-log', source_transaction_id: 'other-row', owner_user_id: 'owner', company_dataset_id: 'dataset', status: 'verified', tally_voucher_id: '2721' });
  await route.POST(request('POST'), context);
  Object.assign(state.tables.tally_bridge_commands[1], { status: 'succeeded', result: { transactions: [{ transactionId: 'tx', verificationStatus: 'found', matchCount: 1, matchBasis: 'date_bank_amount_direction_party', voucherId: '2721' }] } });
  const response = await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context);
  assert.equal((await response.json()).confirmed, 0);
  assert.equal(state.tables.bank_transactions[0].tally_status, 'needs_tally_review');
  assert.match(state.tables.bank_transaction_posting_log[0].result.recheck.verification.reason, /another statement entry/);
});

test('stale checks and other owners cannot replace the current saved evidence', async () => {
  const { state, route } = fixture();
  await route.POST(request('POST'), context);
  state.tables.bank_transaction_posting_log[0].result = { possibleDuplicateInTally: true, reviewLedgerName: 'Arvind' };
  Object.assign(state.tables.tally_bridge_commands[1], { status: 'succeeded', result: { transactions: [{ transactionId: 'tx', verificationStatus: 'found', matchCount: 1, voucherId: '2721' }] } });
  assert.equal((await (await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context)).json()).confirmed, 0);
  assert.equal(state.writes.length, 0);
  state.tables.tally_bridge_commands[1].owner_user_id = 'someone-else';
  assert.equal((await (await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context)).json()).checked, 0);
  assert.equal(state.writes.length, 0);
});

test('a correction saved while confirmation is finishing cannot be overwritten by the older result', async () => {
  const { state, route } = fixture();
  state.tables.bank_transaction_posting_log[0].result = { possibleDuplicateInTally: true };
  await route.POST(request('POST'), context);
  Object.assign(state.tables.tally_bridge_commands[1], { status: 'succeeded', result: { transactions: [{ transactionId: 'tx', verificationStatus: 'found', matchCount: 1, voucherId: '2721' }] } });
  state.beforeLogWrite = rows => { rows[0].result = { possibleDuplicateInTally: true, reviewLedgerName: 'Arvind' }; };
  const response = await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context);
  assert.equal((await response.json()).confirmed, 0);
  assert.equal(state.tables.bank_transaction_posting_log[0].result.reviewLedgerName, 'Arvind');
  assert.equal(state.tables.bank_transactions[0].tally_status, 'needs_tally_review');
});

test('null old results can be checked and an empty recheck returns the real remaining count', async () => {
  const { state, route } = fixture();
  state.tables.bank_transaction_posting_log[0].result = null;
  assert.deepEqual(await (await route.PATCH(request('PATCH', { commandIds: [] }), context)).json(), { confirmed: 0, checked: 0, checkFailed: 0, remaining: 1 });
  await route.POST(request('POST'), context);
  Object.assign(state.tables.tally_bridge_commands[1], { status: 'succeeded', result: { transactions: [{ transactionId: 'tx', verificationStatus: 'found', matchCount: 1, voucherId: '2721' }] } });
  assert.equal((await (await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context)).json()).confirmed, 1);
  assert.equal(state.tables.bank_transaction_posting_log[0].result.alreadyInTally, true);
});

test('a failed recheck retains the most recent successful candidate evidence', async () => {
  const { state, route } = fixture();
  state.tables.bank_transaction_posting_log[0].result = { possibleDuplicateInTally: true,
    recheck: { verification: { verificationStatus: 'ambiguous', matches: [{ voucherNumber: 'fresh', amount: 518779 }] } } };
  await route.POST(request('POST'), context);
  state.tables.tally_bridge_commands[1].status = 'failed';
  await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context);
  assert.equal(state.tables.bank_transaction_posting_log[0].result.recheck.lastSuccessfulVerification.matches[0].voucherNumber, 'fresh');
});

test('a reuploaded row can refresh its original posting evidence without changing the source identity', async () => {
  const { state, route } = fixture();
  state.tables.bank_transactions[0].id = 'reuploaded-row';
  state.tables.bank_transaction_posting_log[0].result = { possibleDuplicateInTally: true };
  await route.POST(request('POST', { transactionId: 'reuploaded-row' }), context);
  assert.equal(state.queued[0].payload.transactions[0].transactionId, 'tx');
  assert.equal(state.queued[0].payload.recheckTransactionId, 'reuploaded-row');
  Object.assign(state.tables.tally_bridge_commands[1], { status: 'succeeded', result: { transactions: [{ transactionId: 'tx', verificationStatus: 'found', matchCount: 1, voucherId: '2721' }] } });
  const response = await route.PATCH(request('PATCH', { commandIds: ['check-1'] }), context);
  assert.equal((await response.json()).confirmed, 1);
  assert.equal(state.tables.bank_transactions[0].tally_status, 'verified');
  assert.equal(state.tables.bank_transaction_posting_log[0].source_transaction_id, 'tx');
  assert.equal(state.tables.bank_transaction_posting_log[0].result.alreadyInTally, true);
});
