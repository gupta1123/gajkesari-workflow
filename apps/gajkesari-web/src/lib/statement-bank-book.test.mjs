import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatementBankBook, savedPostingPresence, statementBalances, summarizeSavedPostings,
  statementCheckMessage, statementBalanceMessage } from './statement-bank-book.ts';
import { buildBankBookRows } from './bank-book-csv.ts';
import { isReadyForTallyPosting } from './bank-statement-posting-readiness.ts';

test('same-amount rows keep distinct saved statuses and existing-voucher identity after reopening', () => {
  const first = { id: 'first', transactionDate: '2026-10-08', description: 'Credit from Arvind', creditAmount: 303.33, balanceAmount: 1303.33 };
  const second = { ...first, id: 'second', balanceAmount: 1606.66 };
  const saved = [{ ...first, postingStatus: 'verified', voucherNumber: '2722', postingResult: { alreadyInTally: true } },
    { ...second, postingStatus: 'needs_tally_review', postingResult: { possibleDuplicateInTally: true } }];
  const presence = savedPostingPresence([first, second], saved);
  assert.equal(presence.first.status, 'found');
  assert.equal(presence.first.alreadyInTally, true);
  assert.equal(presence.first.label, 'Already entered in Tally');
  assert.equal(presence.second.status, 'verification_pending');
  assert.equal(presence.second.label, 'Possible existing entry');
  assert.equal(presence.second.voucherNumber, null);
  assert.deepEqual(statementBalances([first, second]), { opening: 1000, closing: 1606.66 });
  assert.equal(buildStatementBankBook([first, second], saved).length, 2);
});

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
  assert.equal(presence['preview-17'].label, 'Accepted by Tally; confirmation pending');
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

test('reopening a statement keeps manual entries labeled as already entered', () => {
  const saved = [{ ...postings[0], postingResult: { alreadyInTally: true, created: 0 } }];
  assert.equal(summarizeSavedPostings(saved).alreadyExisting, 1);
  const presence = savedPostingPresence([rows[0]], saved);
  assert.equal(presence['preview-0'].label, 'Already entered in Tally');
  assert.match(presence['preview-0'].reason, /No new entry was posted/);
  assert.equal(buildStatementBankBook([rows[0]], saved).length, 1);
});

test('held manual duplicates explain that nothing was posted', () => {
  const saved = [{ ...postings[0], postingStatus: 'needs_tally_review',
    postingResult: { possibleDuplicateInTally: true } }];
  const presence = savedPostingPresence([rows[0]], saved);
  assert.equal(presence['preview-0'].status, 'verification_pending');
  assert.match(presence['preview-0'].reason, /Possible existing entry.*Nothing was posted/);
});

test('completed held rows retain voucher evidence and do not appear as a pending Tally check', () => {
  const row = { id: 'held', transactionDate: '2026-10-08', description: 'Payment to Deccan', debitAmount: 220.22, selectedLedgerName: 'Deccan' };
  const matches = ['5266', '5267'].map(voucherNumber => ({ voucherNumber, date: '2026-10-08', partyLedgerName: 'Deccan', ledgerNames: ['Deccan', 'ICICI'], bankReferences: [] }));
  const presence = savedPostingPresence([row], [{ ...row, postingStatus: 'needs_tally_review', postingResult: { possibleDuplicateInTally: true, duplicateCheck: { matches } } }]);
  assert.equal(presence.held.reviewKind, 'held');
  assert.deepEqual(presence.held.matches.map(match => match.voucherNumber), ['5266', '5267']);
  assert.match(presence.held.reason, /2 Tally vouchers/);
  assert.match(presence.held.reason, /Nothing was posted/);
  assert.match(statementCheckMessage(Object.values(presence)), /Check complete.*1 entry needs review/);
  assert.doesNotMatch(statementCheckMessage(Object.values(presence)), /pending|not been checked/);
  assert.equal(isReadyForTallyPosting({ ledgerName: 'Deccan', ledgerNeedsReview: false, presence: presence.held, amount: 220.22, directPosting: true, billRequired: false }), false);
});

test('single possible matches explain repeated rows, reference conflicts and party conflicts', () => {
  const row = { id: 'first', transactionDate: '2026-10-08', description: 'Credit from Arvind', creditAmount: 1201.12, balanceAmount: 2000, selectedLedgerName: 'Arvind' };
  const match = { voucherNumber: '2725', ledgerNames: ['Arvind', 'ICICI'], partyLedgerName: 'Arvind', bankReferences: [] };
  const saved = (row, match) => ({ ...row, postingStatus: 'needs_tally_review', postingResult: { possibleDuplicateInTally: true, duplicateCheck: { matches: [match] } } });
  const repeated = savedPostingPresence([row, { ...row, id: 'second', balanceAmount: 3201.12 }], [saved(row, match)]);
  assert.match(repeated.first.reason, /repeats.*One existing Tally voucher cannot confirm both rows/);
  const referenced = { ...row, referenceNumber: 'UTRIC261009004' };
  const conflict = savedPostingPresence([referenced], [saved(referenced, { ...match, reference: 'INV-2026-1009' })]);
  assert.match(conflict.first.reason, /different reference/);
  assert.equal(conflict.first.matches[0].reference, 'INV-2026-1009');
  const suspense = { ...row, selectedLedgerName: 'Suspense' };
  assert.match(savedPostingPresence([suspense], [saved(suspense, match)]).first.reason, /different party ledger/);
  const bankRef = savedPostingPresence([referenced], [saved(referenced, { ...match, reference: 'INV-2026-1009', bankReferences: ['UTRIC261009004'] })]);
  assert.doesNotMatch(bankRef.first.reason, /different reference/);
});

test('unknown posting outcomes never claim either acceptance or no posting', () => {
  const row = rows[0];
  const presence = savedPostingPresence([row], [{ ...postings[0], postingStatus: 'needs_tally_review', postingResult: { reconciliationRequired: true } }]);
  assert.equal(presence[row.id].reviewKind, 'outcome_unknown');
  assert.match(presence[row.id].reason, /whether.*posted.*before retrying/);
  assert.doesNotMatch(presence[row.id].reason, /accepted|Nothing was posted/);
});

test('balance differences show source and Tally amounts, including an opening-only mismatch', () => {
  const message = statementBalanceMessage({ balancesMatch: false, statementOpeningBalance: 1000, tallyOpeningBalance: 900, statementClosingBalance: 2000, tallyClosingBalance: 2000 });
  assert.match(message, /Opening balance: statement.*1,000.*Tally.*900.*difference.*100/);
  assert.match(message, /Closing balance: statement.*2,000.*Tally.*2,000.*difference.*0/);
  assert.match(message, /may explain.*download keeps the statement balances/);
  assert.equal(statementBalanceMessage({ balancesMatch: true }), '');
  assert.doesNotMatch(statementBalanceMessage({ balancesMatch: false }), /undefined|NaN/);
});
