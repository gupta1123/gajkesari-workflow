import test from 'node:test';
import assert from 'node:assert/strict';
import { recheckEvidence, recheckObservation, recheckPayload, confirmedRecheckResult } from './bank-statement-recheck.ts';

const original = { transactionId: 'transaction-1', voucherDate: '2026-09-30', amount: 518779,
  expectedDirection: 'outgoing', referenceNumber: '1967486047', bankLedgerName: 'HDFC' };
const command = { status: 'succeeded', payload: { recheckPostingCommandId: 'original-command', transactions: [original] },
  result: { transactions: [{ transactionId: 'transaction-1', verificationStatus: 'found', matchCount: 1, voucherId: '123', voucherNumber: '456' }] } };

test('recheck only accepts unique confirmed evidence for the original approved transaction', () => {
  assert.equal(recheckEvidence(command, original).voucherId, '123');
  for (const modification of [{ verificationStatus: 'missing' }, { verificationStatus: 'ambiguous' }, { matchCount: 2 },
    { transactionId: 'different' }, { voucherId: null }, { duplicateInTally: true }]) {
    assert.equal(recheckEvidence({ ...command, result: { transactions: [{ ...command.result.transactions[0], ...modification }] } }, original), null);
  }
  assert.equal(recheckEvidence({ ...command, status: 'failed' }, original), null);
  assert.equal(recheckEvidence(command, { ...original, amount: 1 }), null);
  assert.equal(recheckEvidence(command, { ...original, bankLedgerName: 'Another bank' }), null);
});

test('ledger corrections preserve every approved financial and reference field and reject stale checks', () => {
  const originalPayload = { ...original, counterpartyLedgerName: 'BluePeak', matchedLedgerName: 'BluePeak', sourceBankReference: 'UTR123456', companyName: 'Company' };
  const corrected = recheckPayload(originalPayload, { possibleDuplicateInTally: true, reviewLedgerName: 'Arvind' });
  assert.deepEqual(corrected, { ...originalPayload, counterpartyLedgerName: 'Arvind', matchedLedgerName: 'Arvind' });
  assert.deepEqual(recheckPayload(originalPayload, { reviewLedgerName: 'Arvind' }), originalPayload);
  const correctedCommand = { ...command, payload: { ...command.payload, transactions: [corrected] } };
  assert.equal(recheckEvidence(correctedCommand, corrected).voucherId, '123');
  assert.equal(recheckEvidence({ ...correctedCommand, payload: { ...correctedCommand.payload, transactions: [originalPayload] } }, corrected), null);
  for (const patch of [{ sourceBankReference: 'different' }, { companyName: 'Other' }, { counterpartyLedgerName: 'Other' }]) {
    assert.equal(recheckEvidence({ ...correctedCommand, payload: { ...correctedCommand.payload, transactions: [{ ...corrected, ...patch }] } }, corrected), null);
  }
});

test('recheck saves observations without treating missing, failed or multiple matches as confirmation', () => {
  for (const verificationStatus of ['missing', 'ambiguous']) {
    const check = { ...command, result: { transactions: [{ transactionId: original.transactionId, verificationStatus, matchCount: 0, matches: [] }] } };
    assert.equal(recheckObservation(check, original).verificationStatus, verificationStatus);
    assert.equal(recheckEvidence(check, original), null);
  }
  assert.equal(recheckObservation({ ...command, status: 'failed' }, original).verificationStatus, 'failed');
});

test('finding a held or unknown voucher never invents a newly posted entry', () => {
  const verification = { voucherId: '123', voucherNumber: '456' };
  assert.equal(confirmedRecheckResult({ possibleDuplicateInTally: true }, verification).alreadyInTally, true);
  assert.equal(confirmedRecheckResult({ reconciliationRequired: true }, verification).alreadyInTally, true);
  assert.equal(confirmedRecheckResult({ importSummary: { created: 1, errors: 0 } }, verification).alreadyInTally, false);
  assert.equal(confirmedRecheckResult({ alreadyInTally: true, importSummary: { created: 1, errors: 0 } }, verification).alreadyInTally, true);
});
