import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBankChargeLedger, bankChargeNeedsReview } from './bank-charge-ledger.ts';

test('bank commission resolves to the existing expense ledger using its exact name', () => {
  const ledger = { name: 'Bank Commission', parent: 'Indirect Expenses' };
  assert.equal(resolveBankChargeLedger('Bank commission / service charge', [ledger, { name: 'Suspense' }]), ledger);
  assert.equal(resolveBankChargeLedger('Payment to Deccan Sponge and Minerals', [ledger]), null);
  assert.equal(resolveBankChargeLedger('Bank charges', [{ name: 'Bank Charges', parent: 'Sundry Creditors' }]), null);
});

test('ambiguous charges require review; only an explicit selection permits Suspense', () => {
  assert.equal(resolveBankChargeLedger('Bank charges', [{ name: 'Bank Charges' }, { name: 'Bank-Charges' }]), null);
  assert.equal(bankChargeNeedsReview('Bank charges', 'Suspense', false), true);
  assert.equal(bankChargeNeedsReview('Bank charges', 'Suspense', true), false);
  assert.equal(bankChargeNeedsReview('Payment to unknown vendor', 'Suspense', false), false);
});
