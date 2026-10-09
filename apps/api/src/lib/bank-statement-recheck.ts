type RecheckCommand = { status: string; payload: Record<string, unknown>; result: Record<string, unknown> | null };

// Only a saved ledger correction may differ from the approved posting payload.
// Rechecking cannot change a bank, amount, date or reference.
export function recheckPayload(original: Record<string, unknown>, result?: Record<string, unknown> | null) {
  const ledger = result?.possibleDuplicateInTally === true && typeof result.reviewLedgerName === "string" ? result.reviewLedgerName : null;
  return ledger ? { ...original, counterpartyLedgerName: ledger, matchedLedgerName: ledger } : original;
}

export function recheckObservation(command: RecheckCommand, approved?: Record<string, unknown>) {
  if (!command.payload.recheckPostingCommandId) return null;
  const expected = command.payload.transactions as Array<Record<string, unknown>> | undefined;
  if (expected?.length !== 1 || !expected[0] || typeof expected[0] !== "object") return null;
  if (approved && [...new Set([...Object.keys(approved), ...Object.keys(expected[0])])]
    .some(key => JSON.stringify(expected[0][key]) !== JSON.stringify(approved[key]))) return null;
  const rows = command.result?.transactions as Array<Record<string, unknown>> | undefined;
  if (command.status !== "succeeded") return { transactionId: String(expected[0].transactionId),
    verificationStatus: "failed", reason: "We couldn't finish checking this entry. Keep Tally and the connector open, then recheck.", matches: [] };
  if (rows?.length !== 1 || !rows[0] || rows[0].transactionId !== expected[0].transactionId) return null;
  if (!["found", "ambiguous", "missing", "failed"].includes(String(rows[0].verificationStatus))) return null;
  return rows[0];
}

export function recheckEvidence(command: RecheckCommand, approved?: Record<string, unknown>) {
  const row = recheckObservation(command, approved);
  if (!row || command.status !== "succeeded" || row.verificationStatus !== "found" ||
    row.matchCount !== 1 || row.duplicateInTally === true || !row.voucherId) return null;
  return { transactionId: String(row.transactionId), voucherId: String(row.voucherId),
    voucherNumber: typeof row.voucherNumber === "string" ? row.voucherNumber : "", verification: row };
}

export function confirmedRecheckResult(previous: Record<string, unknown>, verification: Record<string, unknown>) {
  const summary = previous.importSummary as Record<string, unknown> | undefined;
  const createdHere = previous.possibleDuplicateInTally !== true && Number(summary?.created) > 0 &&
    Number(summary?.errors) === 0 && Number(summary?.exceptions ?? 0) === 0 && Number(summary?.cancelled ?? 0) === 0 &&
    Number(summary?.ignored ?? 0) === 0 && (previous.batchSize == null || Number(summary?.created) === Number(previous.batchSize));
  return { ...previous, verificationStatus: "verified", voucherId: verification.voucherId,
    voucherNumber: verification.voucherNumber, voucherDate: verification.voucherDate,
    alreadyInTally: previous.alreadyInTally === true || !createdHere };
}
