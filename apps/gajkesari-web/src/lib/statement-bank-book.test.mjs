import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatementBankBook, savedPostingPresence, statementBalances, summarizeSavedPostings } from './statement-bank-book.ts';
import { buildBankBookRows } from './bank-book-csv.ts';
import { isReadyForTallyPosting } from './bank-statement-posting-readiness.ts';

const rows = Array.from({ length: 18 }, (_, i) => ({ id: `preview-${i}`, transactionDate: '2026-09-30',
  description: `Transaction ${i}`, referenceNumber: String(1967486030 + i), debitAmount: i === 17 ? 518779 : 10,
  creditAmount: 0, balanceAmount: 1000000 - Math.min(i + 1, 17) * 10 - (i === 17 ? 518779 : 0), selectedLedgerName: 'Suspense' }));
const postings = rows.map((row, i) => ({ ...row, id: `confirmed-db-${i}`, postingStatus: i === 17 ? 'needs_tally_review' : 'verified',
  voucherNumber: i === 17 ? 'must-not-display' : String(6000 + i), ledgerName: 'Suspense',
  postingResult: i === 17 ? { reconciliationRequired: true, batchSize: 18, importSummary: { created: 18, errors: 0 } } : {} }));

test('all 18 statement movements and balanced totals survive one unconfirmed posting', () => {
  const entries = buildStatementBankBook(rows, postings);
  assert.equal(entries.length, 18);
  assert.equal(entries.at(-1).payment, 518779);
  assert.equal(entries.at(-1).voucherNumber, '');
  assert.match(entries.at(-1).postingStatus, /needs checking/);
  const balances = statementBalances(rows);
  assert.deepEqual(balances, { opening: 1000000, closing: 481051 });
  assert.deepEqual(statementBalances([...rows].reverse()), balances);
  const exported = buildBankBookRows('HDFC', 'September 30', entries, balances);
  assert.ok(exported.every(row => row.length === 9));
  assert.ok(!JSON.stringify(exported).includes('Tally status'));
  assert.ok(!JSON.stringify(exported).includes('needs checking'));
  const totals = exported.find(row => row[2] === 'Grand Total');
  assert.equal(totals[7], totals[8]);
  assert.equal(exported.filter(row => row[5] === 'Payment').length, 18);
  assert.equal(summarizeSavedPostings(postings).needsCheck, 1);
});

test('refresh maps durable posting status to preview IDs and never makes uncertain rows postable', () => {
  const presence = savedPostingPresence(rows, postings);
  assert.equal(presence['preview-0'].status, 'found');
  assert.equal(presence['preview-17'].status, 'verification_pending');
  assert.equal(isReadyForTallyPosting({ ledgerName: 'Suspense', ledgerNeedsReview: false, amount: 518779,
    directPosting: true, billRequired: false, postingRecorded: true, presence: { status: 'missing' } }), false);
});

test('a statement can be exported before posting without inventing source balances', () => {
  const entries = buildStatementBankBook(rows, []);
  assert.equal(entries.length, 18);
  assert.equal(entries[0].postingStatus, 'Not sent to Tally');
  assert.equal(statementBalances([{ ...rows[0], balanceAmount: null }]), undefined);
  assert.equal(statementBalances([{ ...rows[0] }, { ...rows[1], balanceAmount: 4 }]), undefined);
});
