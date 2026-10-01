import test from 'node:test';
import assert from 'node:assert/strict';
import { recheckEvidence } from './bank-statement-recheck.ts';

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
