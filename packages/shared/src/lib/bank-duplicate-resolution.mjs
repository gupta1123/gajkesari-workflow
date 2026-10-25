const norm = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const name = value => norm(value).replace(/[^a-z0-9]/g, '');
const read = (row, camel, snake) => row?.[camel] ?? row?.[snake];
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
export const isTrackingReference = value => /^(?:CHG|INT|UPI|RTGS|NEFT|IMPS|RCT|PMT|BNK)-[A-Z0-9]{1,6}-[A-F0-9]{20}$/i.test(String(value || '').trim());
export function duplicateRowKey(row) {
  const balance = read(row, 'balanceAmount', 'balance_amount');
  return JSON.stringify([read(row, 'transactionDate', 'transaction_date') || row.voucherDate || '',
    String(read(row, 'referenceNumber', 'reference_number') || '').trim(), norm(row.description),
    Number(read(row, 'debitAmount', 'debit_amount') || 0), Number(read(row, 'creditAmount', 'credit_amount') || 0),
    balance == null || balance === '' ? null : Number(balance)]);
}
export function duplicateContext(row, bank = row.bankLedgerName, ledger = row.selectedLedgerName || row.counterpartyLedgerName) {
  const credit = Number(read(row, 'creditAmount', 'credit_amount') || 0);
  return { date: row.voucherDate || read(row, 'transactionDate', 'transaction_date'),
    amount: Number(row.amount || Math.max(Number(read(row, 'debitAmount', 'debit_amount') || 0), credit)),
    direction: row.expectedDirection || (credit > 0 ? 'incoming' : 'outgoing'), bank: name(bank), ledger: name(ledger) };
}
export function candidateIdentity(match) {
  return { masterId: String(match.masterId || ''), voucherNumber: String(match.voucherNumber || ''), date: match.date,
    amount: Number(match.amount), direction: match.direction, bank: name(match.bankLedgerName), ledger: name(match.partyLedgerName),
    references: [...new Set([match.reference, ...(match.bankReferences || [])].filter(Boolean).map(name))].sort() };
}
export function canResolveRepeatedPayment(row, rows, matches, bank, ledger) {
  if (String(read(row, 'referenceNumber', 'reference_number') || '').trim() || matches?.length !== 1) return false;
  const context = duplicateContext(row, bank, ledger), match = matches[0], identity = candidateIdentity(match);
  if (!identity.masterId || !context.ledger || context.ledger.includes('suspense') || !context.bank || !context.date || !(context.amount > 0)) return false;
  if ([match.reference, ...(match.bankReferences || [])].some(ref => ref && !isTrackingReference(ref))) return false;
  if (identity.date !== context.date || identity.amount !== context.amount || identity.direction !== context.direction ||
      identity.bank !== context.bank || identity.ledger !== context.ledger) return false;
  return rows.filter(other => !String(read(other, 'referenceNumber', 'reference_number') || '').trim() &&
    duplicateContext(other, bank, other.selectedLedgerName || other.counterpartyLedgerName || ledger).date === context.date &&
    duplicateContext(other, bank, other.selectedLedgerName || other.counterpartyLedgerName || ledger).amount === context.amount &&
    duplicateContext(other, bank, other.selectedLedgerName || other.counterpartyLedgerName || ledger).direction === context.direction &&
    norm(other.description) === norm(row.description)).length > 1;
}
export function resolutionForRow(decisions, row, bank, ledger) {
  const decision = decisions?.[duplicateRowKey(row)];
  return decision && ['skip','separate'].includes(decision.action) && decision.decidedBy && decision.decidedAt &&
    same(decision.context, duplicateContext(row, bank, ledger)) ? decision : null;
}
// Used at both live matching and final posting. Only the exact reviewed voucher
// may be excluded. A changed/deleted voucher invalidates the decision; a new
// matching voucher remains evidence and cannot be overridden by this decision.
export function applySeparatePaymentDecision(decision, row, candidates, bank, ledger) {
  if (!decision || decision.action !== 'separate') return { candidates, stale: false };
  const refs = Object.hasOwn(row, 'bankReferenceNumber') ? row.bankReferenceNumber : read(row, 'referenceNumber', 'reference_number');
  const genuineRef = refs && !isTrackingReference(refs);
  if (genuineRef || !decision.decidedBy || !decision.decidedAt || decision.candidates?.length !== 1 ||
      !same(decision.context, duplicateContext(row, bank, ledger))) return { candidates, stale: true };
  const approved = decision.candidates[0];
  const current = candidates.find(match => String(match.masterId) === String(approved.masterId));
  if (!current || !same(candidateIdentity(current), approved)) return { candidates, stale: true };
  return { candidates: candidates.filter(match => String(match.masterId) !== String(approved.masterId)), stale: false };
}
