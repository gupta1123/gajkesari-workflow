import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePostingVoucher, recheckResultMessage, uniquePostingReferences, showSeparateVoucherReference } from './bank-posting-review.ts';
import { savedPostingPresence, summarizeSavedPostings, heldPostingLabel, heldPostingReason } from './statement-bank-book.ts';
import { summarizeStatementPostings, postingFooterSegments, recordedTrackingReference } from './statement-bank-book.ts';

test('skipped statement rows remain visible, count separately and never appear as processing or confirmed',()=>{
 const rows=[{id:'existing',transactionDate:'2026-10-25',description:'Payment',debitAmount:10,balanceAmount:100},
   {id:'skip',transactionDate:'2026-10-25',description:'Payment',debitAmount:10,balanceAmount:90}];
 const summary=summarizeStatementPostings(rows,[],{existing:{status:'found',voucherNumber:'1'},skip:{status:'skipped'}});
 assert.equal(summary.total,2);assert.equal(summary.confirmed,1);assert.equal(summary.skipped,1);assert.equal(summary.pending,0);assert.equal(summary.needsCheck,0);
 assert.deepEqual(postingFooterSegments(summary,false).map(r=>r.text),['1 already entered','1 skipped by you']);
});

test('recorded tracking references identify prior app postings without pretending they are bank UTRs',()=>{
 const row={transactionDate:'2026-10-25',description:'Payment',debitAmount:10,balanceAmount:100};
 const tracking='PMT-ICICI-0BF8EA4652030502EE99';
 const saved={...row,id:'saved',postingStatus:'verified',voucherNumber:'5322',postingResult:{duplicateCheck:{matches:[{voucherNumber:'5322',reference:tracking,bankReferences:[tracking],ledgerNames:[]}]}}};
 assert.equal(recordedTrackingReference(row,[saved]),tracking);
 assert.equal(recordedTrackingReference({...row,balanceAmount:90},[saved]),'');
 assert.equal(recordedTrackingReference(row,[{...saved,postingStatus:'needs_tally_review'}]),'');
 const comparison=comparePostingVoucher({date:row.transactionDate,amount:10,ledger:'Deccan',bank:'ICICI',reference:'',direction:'outgoing'},saved.postingResult.duplicateCheck.matches[0]);
 assert.equal(comparison.find(r=>r.label==='Bank reference / UTR').tally,null);
 assert.equal(showSeparateVoucherReference(saved.postingResult.duplicateCheck.matches[0]),true);
});

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


test('duplicate UTRs appear once and an identical voucher-reference footer is hidden', () => {
  const match = { reference: 'UTIBN26300002502', bankReferences: [' UTIBN26300002502 ', 'utibn26300002502', 'UTIBN-26300002502'] };
  assert.deepEqual(uniquePostingReferences(match), ['UTIBN26300002502']);
  assert.equal(showSeparateVoucherReference(match), false);
  assert.equal(comparePostingVoucher({ ...statement, reference: match.reference }, match).find(field => field.label === 'Bank reference / UTR').tally, 'UTIBN26300002502');
});

test('a different invoice or voucher reference remains visible', () => {
  assert.equal(showSeparateVoucherReference({ reference: 'INV-1001', bankReferences: ['UTIBN26300002502'] }), true);
  assert.equal(showSeparateVoucherReference({ reference: 'UTIBN26300002502', bankReferences: [] }), false);
  assert.equal(showSeparateVoucherReference({ bankReferences: ['UTIBN26300002502'] }), false);
});

test('same-UTR amount mismatches name the voucher and both amounts without suggesting a separate payment', () => {
  const payment = { ...row, referenceNumber: 'UTIBN26300002502', debitAmount: 2382.5, creditAmount: 0 };
  const candidate = { ...match, reference: payment.referenceNumber, bankReferences: [payment.referenceNumber], amount: 2383.5, voucherNumber: '5310' };
  assert.equal(heldPostingLabel(payment, [candidate]), 'Amount mismatch');
  const reason = heldPostingReason(payment, [payment], [candidate]);
  assert.match(reason, /Voucher 5310.*same bank reference.*different amount/);
  assert.match(reason, /2,382.50.*2,383.50/);
  assert.match(reason, /Resolve the difference, then recheck Tally/);
  assert.doesNotMatch(reason, /separate transaction/);
  assert.equal(heldPostingLabel(payment, [{ ...candidate, amount: 2382.5 }]), 'Possible Match');
  assert.equal(heldPostingLabel(payment, [{ ...candidate, reference: 'UTIBN99999999999', bankReferences: [] }]), 'Possible Match');
  assert.equal(heldPostingLabel(payment, [{ ...candidate, amount: null }]), 'Possible Match');
});

test('reopening a held amount conflict preserves its specific label and review status', () => {
  const payment = { ...row, referenceNumber: 'UTIBN26300002502', debitAmount: 2382.5, creditAmount: 0 };
  const candidate = { ...match, reference: payment.referenceNumber, bankReferences: [payment.referenceNumber], amount: 2383.5, voucherNumber: '5310' };
  const saved = { ...payment, postingStatus: 'needs_tally_review', postingResult: { possibleDuplicateInTally: true, duplicateCheck: { verificationStatus: 'ambiguous', matches: [candidate] } } };
  const presence = savedPostingPresence([payment], [saved]).held;
  assert.equal(presence.label, 'Amount mismatch');
  assert.equal(presence.status, 'verification_pending');
  assert.match(presence.reason, /2,382.50.*2,383.50/);
});
