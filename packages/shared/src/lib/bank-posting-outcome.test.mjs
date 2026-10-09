import test from 'node:test';
import assert from 'node:assert/strict';
import { bankPostingOutcome, bankPostingMessage, bankPostingTitle, summarizeBankPostings } from './bank-posting-outcome.ts';

test('mixed upload counts existing, new and held rows separately', () => {
  const existing = { status: 'succeeded', result: { alreadyInTally: true, duplicateCheck: { verificationStatus: 'found' } } };
  const created = { status: 'succeeded', result: { created: 1, verificationStatus: 'verified' } };
  const held = { status: 'failed', result: { possibleDuplicateInTally: true } };
  assert.equal(bankPostingMessage(summarizeBankPostings([...Array(13).fill(existing), ...Array(5).fill(created), ...Array(4).fill(held)])),
    '5 newly posted; 13 already entered in Tally; 4 not posted: possible duplicates need review.');
});

test('17 confirmations and 1 accepted but unconfirmed entry is a needs-check outcome', () => {
  const confirmed = { status: 'succeeded', result: { verificationStatus: 'verified' } };
  const uncertain = { status: 'failed', reconciliation_required: true, result: {
    reconciliationRequired: true, batchSize: 18, importSummary: { created: 18, errors: 0 },
  } };
  const summary = summarizeBankPostings([...Array(17).fill(confirmed), uncertain]);
  assert.deepEqual(summary, { total: 18, confirmed: 17, needsCheck: 1, failed: 0, pending: 0, accepted: 18, alreadyExisting: 0,
    held: 0, confirmationPending: 1, outcomeUnknown: 0 });
  assert.equal(bankPostingMessage(summary), '17 newly posted; 0 already entered in Tally; 1 accepted by Tally: confirmation pending.');
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

test('already-entered vouchers are reported as skipped rather than newly posted', () => {
  const existing = { status: 'succeeded', result: { alreadyInTally: true, created: 0,
    duplicateCheck: { verificationStatus: 'found' } } };
  assert.equal(bankPostingMessage(summarizeBankPostings([existing, existing])),
    '2 entries were already entered in Tally. No new entries were posted.');
  const posted = { status: 'succeeded', result: { created: 1, verificationStatus: 'verified' } };
  assert.equal(bankPostingMessage(summarizeBankPostings([existing, posted])),
    '1 entry posted and confirmed in Tally. 1 already entered in Tally; skipped.');
});

test('holding a possible manual duplicate never claims it was accepted by Tally', () => {
  const held = { status: 'failed', result: { possibleDuplicateInTally: true,
    duplicateCheck: { verificationStatus: 'ambiguous' } } };
  assert.deepEqual(bankPostingOutcome(held), { status: 'needs_check', accepted: false });
  assert.doesNotMatch(bankPostingMessage(summarizeBankPostings([held])), /accepted|posted and confirmed/);
});

test('mixed review states name held, accepted, unknown and rejected entries separately', () => {
  const summary = summarizeBankPostings([
    { status: 'failed', result: { possibleDuplicateInTally: true } },
    { status: 'failed', result: { reconciliationRequired: true, importSummary: { created: 1, errors: 0 } } },
    { status: 'failed', result: { reconciliationRequired: true } },
    { status: 'failed', result: { errors: 1 } },
  ]);
  assert.equal(summary.needsCheck, 3);
  assert.equal(summary.held, 1);
  assert.equal(summary.confirmationPending, 1);
  assert.equal(summary.outcomeUnknown, 1);
  assert.equal(summary.failed, 1);
  assert.match(bankPostingMessage(summary), /1 not posted.*1 accepted by Tally.*1 posting outcome unknown.*1 couldn't be posted/);
  assert.equal(bankPostingTitle(summary), "Some entries couldn't be posted");
});

test('empty work and pending work never claim a completed posting', () => {
  assert.equal(bankPostingMessage(summarizeBankPostings([])), 'No entries were posted.');
  const pending = summarizeBankPostings([{ status: 'queued' }]);
  assert.match(bankPostingMessage(pending), /1 still processing/);
  assert.equal(bankPostingTitle(pending), 'Processing entries in Tally');
});
