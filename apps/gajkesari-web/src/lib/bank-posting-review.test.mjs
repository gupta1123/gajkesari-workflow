import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePostingVoucher, recheckResultMessage } from './bank-posting-review.ts';
import { savedPostingPresence, summarizeSavedPostings } from './statement-bank-book.ts';

const row = { id: 'held', transactionDate: '2026-10-08', description: 'Credit BluePeak', creditAmount: 1101.11, selectedLedgerName: 'BluePeak' };
const statement = { date: row.transactionDate, amount: row.creditAmount, ledger: 'BluePeak', bank: 'Axis', reference: 'UTR12345678', direction: 'incoming' };
const match = { amount: 1101.11, date: '2026-10-07', bankLedgerName: 'Axis', direction: 'incoming', partyLedgerName: 'Arvind', ledgerNames: ['Axis', 'Arvind'], bankReferences: ['UTR87654321'], reference: 'INV123', voucherNumber: '2721' };

test('the comparison highlights actual date, party and reference differences and uses the Tally amount', () => {
  const fields = comparePostingVoucher(statement, match);
  assert.deepEqual(fields.filter(field => field.state === 'different').map(field => field.label), ['Date', 'Party / ledger', 'Bank reference / UTR']);
  assert.equal(fields.find(field => field.label === 'Amount').state, 'match');
  assert.equal(comparePostingVoucher(statement, { ...match, amount: 1102 })[1].state, 'different');
  assert.equal(comparePostingVoucher(statement, {})[1].tally, null);
  assert.equal(comparePostingVoucher(statement, {})[1].state, 'unavailable');
});

test('latest unresolved evidence replaces old candidates including an empty result', () => {
  const posting = { ...row, postingStatus: 'needs_tally_review', postingResult: { possibleDuplicateInTally: true, duplicateCheck: { matches: [{ ...match, voucherNumber: 'old' }] }, recheck: { checkedAt: '2026-10-09T10:00:00Z', verification: { verificationStatus: 'ambiguous', matches: [match] } } } };
  const latest = savedPostingPresence([row], [posting]).held;
  assert.equal(latest.matches[0].voucherNumber, '2721');
  assert.equal(latest.matches[0].amount, 1101.11);
  assert.equal(latest.checkedAt, '2026-10-09T10:00:00Z');
  const missing = savedPostingPresence([row], [{ ...posting, postingResult: { ...posting.postingResult, recheck: { verification: { verificationStatus: 'missing', matches: [] } } } }]).held;
  assert.deepEqual(missing.matches, []);
  assert.equal(missing.label, 'Still needs review');
  assert.match(missing.reason, /No matching voucher.*not posted/);
});

test('a failed recheck labels earlier evidence honestly and does not permit posting', () => {
  const posting = { ...row, postingStatus: 'needs_tally_review', postingResult: { possibleDuplicateInTally: true, matches: [match], recheck: { verification: { verificationStatus: 'failed', matches: [] } } } };
  const presence = savedPostingPresence([row], [posting]).held;
  assert.equal(presence.checkFailed, true);
  assert.equal(presence.status, 'verification_pending');
  assert.equal(presence.matches[0].voucherNumber, '2721');
  assert.match(presence.reason, /previous check/);
  const newer = savedPostingPresence([row], [{ ...posting, postingResult: { ...posting.postingResult,
    recheck: { verification: { verificationStatus: 'failed' }, lastSuccessfulVerification: { matches: [{ ...match, voucherNumber: 'fresh' }] } } } }]).held;
  assert.equal(newer.matches[0].voucherNumber, 'fresh');
});

test('recheck messages distinguish new confirmations, no change, failure and complete results', () => {
  assert.match(recheckResultMessage({ confirmed: 2, checked: 3, remaining: 1 }), /2 entries confirmed.*1 entry still needs review/);
  assert.match(recheckResultMessage({ confirmed: 0, checked: 1, remaining: 1 }), /No additional entries were confirmed/);
  assert.match(recheckResultMessage({ confirmed: 0, checked: 1, remaining: 1, checkFailed: 1 }), /couldn't be checked/);
  assert.match(recheckResultMessage({ confirmed: 1, checked: 1, remaining: 0 }), /All entries are confirmed.*No vouchers were posted/);
  assert.equal(summarizeSavedPostings([{ ...row, postingStatus: 'verified', postingResult: { alreadyInTally: true } }]).alreadyExisting, 1);
});
