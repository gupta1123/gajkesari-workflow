import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { bankPostingMessage, bankPostingTitle } from '@gajkesari/shared/lib/bank-posting-outcome';
import { markPreviouslyConfirmedPostings, savedPostingPresence, savedPostingOutcome,
  summarizeSavedPostings, summarizeStatementPostings, statementRowKey } from './statement-bank-book.ts';
import { isReadyForTallyPosting } from './bank-statement-posting-readiness.ts';

const source = await readFile(new URL('../components/bank-statements/BankStatementsPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
const extracted = ['applyPreviewPayload', 'restorePostingState', 'sendToTally'].map(name => functions.get(name)).join('\n');
const code = ts.transpileModule(extracted, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function reviewHarness(rows, saved) {
  const payload = { import: { id: 'repeat-import' }, account: { accountNumber: '1234', tallyLedgerName: 'Bank' },
    bankLedgerResolution: { verified: true }, transactions: rows, postedTransactions: saved };
  // Start with another completed statement to catch leaked badges/downloads.
  const state = { transactions: rows, persistedPostedTransactions: saved, statementDoneSummary: { tone: 'success' } };
  const requests = [];
  const toasts = [];
  const context = {
    preview: payload, validTransactions: rows, ledgerMasters: [], bankLedgerOptions: [], EMPTY_ACCOUNT: {},
    connectorCandidateMasters: () => [], normalizeName: value => value.toLowerCase(),
    normalizeBankAccountNumber: value => value, isBankLedgerMaster: () => false,
    normalizeReviewTransaction: row => row, findLedgerByNormalizedName: () => null,
    readyReceiptTransactions: rows, readyPaymentTransactions: [], readyPostingTransactions: rows,
    tallyPresenceByTransactionId: {}, transactionsNeedingTallyWork: rows, previewExtractionIncomplete: false,
    tallyConnectionId: 'connection', bankLedgerName: 'Bank', selectedAccountId: '', account: payload.account,
    commandConnection: { id: 'connection' }, directPosting: true, selectedCompanyName: 'Company',
    isIncomingReceiptRow: () => true, isOutgoingPaymentRow: () => false,
    transactionQueueKey: row => row.id, parseNumber: value => value == null ? null : Number(value),
    markPreviouslyConfirmedPostings, savedPostingPresence, savedPostingOutcome, summarizeSavedPostings,
    summarizeStatementPostings, statementRowKey, bankPostingMessage, bankPostingTitle,
    showToast: (...args) => toasts.push(args), selectReviewTransaction: () => {},
    loadImportPreviewMetadata: async () => payload,
    apiFetch: async (url, options) => {
      requests.push({ url, ...options });
      assert.ok(url.endsWith('/confirm'), 'previously recorded rows must not create posting commands');
      return { ok: true, json: async () => ({ account: { id: 'account' }, import: payload.import,
        importedTransactionCount: 0, duplicateTransactionCount: rows.length, queueableTransactions: [] }) };
    },
  };
  for (const [, setter] of extracted.matchAll(/\b(set[A-Z]\w*)\(/g)) {
    const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
    context[setter] = update => { state[key] = typeof update === 'function' ? update(state[key] ?? []) : update; };
  }
  const handlers = new Function(...Object.keys(context), `${code}; return { applyPreviewPayload, sendToTally };`)(...Object.values(context));
  return { payload, state, requests, toasts, ...handlers };
}

function fixtures(count = 23) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: `preview-${i}`, transactionDate: '2026-10-08',
    description: `Entry ${i}`, selectedLedgerName: 'Customer', creditAmount: 100 + i, balanceAmount: 1000 + i }));
  const saved = rows.map((row, i) => ({ ...row, id: `db-${i}`, postingStatus: i < 18 ? 'verified' : 'needs_tally_review',
    voucherNumber: i < 18 ? `${2700 + i}` : null, postingResult: i < 18 ? { created: 1 } : { possibleDuplicateInTally: true } }));
  return { rows, saved };
}

test('repeat upload starts in review without prior Tally badges, completed footer, download or recheck state', () => {
  const { rows, saved } = fixtures();
  const review = reviewHarness(rows, saved);
  review.applyPreviewPayload(review.payload);
  assert.deepEqual(review.state.persistedPostedTransactions, []);
  assert.deepEqual(review.state.tallyPresenceByTransactionId, {});
  assert.equal(review.state.postedTransactionIds.size, 0);
  assert.equal(review.state.statementDoneSummary, null);
  assert.equal(review.state.tallyPostingStatus, null);
  assert.equal(review.state.tallyCheckAttempted, false);
  assert.equal(review.state.billMatchingRequested, false);
  assert.equal(review.requests.length, 0);
  assert.equal(rows.filter(row => isReadyForTallyPosting({ ledgerName: row.selectedLedgerName,
    ledgerNeedsReview: false, directPosting: true, amount: row.creditAmount, billRequired: false })).length, 23);
  assert.equal(review.state.preview.postedTransactions.length, 23, 'prior evidence is retained for the explicit action');
});

test('click Post on a completely recorded repeat upload reveals 18 existing and 5 held without queueing vouchers', async () => {
  const { rows, saved } = fixtures();
  const review = reviewHarness(rows, saved);
  review.applyPreviewPayload(review.payload);
  await review.sendToTally('post_all');
  assert.equal(review.requests.length, 1);
  assert.equal(review.toasts.some(([tone]) => tone === 'error'), false, JSON.stringify(review.toasts));
  const summary = summarizeStatementPostings(rows, review.state.persistedPostedTransactions);
  assert.equal(summary.confirmed, 18);
  assert.equal(summary.alreadyExisting, 18);
  assert.equal(summary.held, 5);
  assert.equal(summary.total, 23);
  assert.equal(review.state.statementDoneSummary.tone, 'info');
  assert.equal(Object.values(review.state.tallyPresenceByTransactionId).filter(row => row.status === 'found').length, 18);
  assert.equal(Object.values(review.state.tallyPresenceByTransactionId).filter(row => row.status === 'verification_pending').length, 5);
  assert.equal(review.state.postedTransactionIds.size, 0);
});

test('mixed results distinguish prior confirmations from newly posted rows and retain held evidence', () => {
  const { rows, saved } = fixtures();
  const prior = saved.slice(4);
  const current = markPreviouslyConfirmedPostings(saved, prior);
  const summary = summarizeStatementPostings(rows, current);
  assert.equal(summary.confirmed - summary.alreadyExisting, 4);
  assert.equal(summary.alreadyExisting, 14);
  assert.equal(summary.held, 5);
  assert.equal(saved[4].postingResult.alreadyInTally, undefined, 'do not modify the saved baseline');
  assert.equal(current[18], saved[18], 'held evidence must not be reclassified as confirmed');
});

test('an all-existing repeat upload completes successfully only after Post is clicked', async () => {
  const { rows, saved } = fixtures(18);
  const review = reviewHarness(rows, saved);
  review.applyPreviewPayload(review.payload);
  assert.equal(review.state.statementDoneSummary, null);
  await review.sendToTally('post_all');
  assert.equal(review.state.statementDoneSummary.tone, 'success');
  assert.equal(summarizeStatementPostings(rows, review.state.persistedPostedTransactions).alreadyExisting, 18);
  assert.equal(review.requests.length, 1);
  assert.equal(review.toasts.some(([tone]) => tone === 'error'), false);
});

test('a fresh upload does not inherit the preceding statement results', () => {
  const { rows } = fixtures();
  const review = reviewHarness(rows, []);
  review.state.persistedPostedTransactions = [{ id: 'old-job', postingStatus: 'verified' }];
  review.applyPreviewPayload(review.payload);
  assert.deepEqual(review.state.persistedPostedTransactions, []);
  assert.deepEqual(review.state.tallyPresenceByTransactionId, {});
  assert.equal(review.state.statementDoneSummary, null);
  assert.equal(review.requests.length, 0);
});
