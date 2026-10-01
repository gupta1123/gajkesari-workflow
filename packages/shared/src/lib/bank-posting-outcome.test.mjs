import test from 'node:test';
import assert from 'node:assert/strict';
import { bankPostingOutcome, bankPostingMessage, summarizeBankPostings } from './bank-posting-outcome.ts';

test('17 confirmations and 1 accepted but unconfirmed entry is a needs-check outcome', () => {
  const confirmed = { status: 'succeeded', result: { verificationStatus: 'verified' } };
  const uncertain = { status: 'failed', reconciliation_required: true, result: {
    reconciliationRequired: true, batchSize: 18, importSummary: { created: 18, errors: 0 },
  } };
  const summary = summarizeBankPostings([...Array(17).fill(confirmed), uncertain]);
  assert.deepEqual(summary, { total: 18, confirmed: 17, needsCheck: 1, failed: 0, pending: 0, accepted: 18 });
  assert.equal(bankPostingMessage(summary), 'Tally accepted 18 entries. 17 confirmed; 1 needs checking.');
});

test('a timeout or partial import does not claim acceptance or enable retrying', () => {
  for (const importSummary of [undefined, { created: 18 }, { created: 17, errors: 0 }, { created: 18, errors: 1 }]) {
    const outcome = bankPostingOutcome({ status: 'failed', result: { reconciliationRequired: true, batchSize: 18, importSummary } });
    assert.equal(outcome.status, 'needs_check');
    assert.equal(outcome.accepted, false);
  }
});

test('actual rejection remains a failure and old unverified successes need checking', () => {
  assert.equal(bankPostingOutcome({ status: 'failed', result: { errors: 1 } }).status, 'failed');
  assert.equal(bankPostingOutcome({ status: 'succeeded', result: { created: 1 } }).status, 'needs_check');
});
