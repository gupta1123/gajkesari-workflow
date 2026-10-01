export function recheckEvidence(command: {
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
}, originalPayload?: Record<string, unknown>) {
  if (command.status !== "succeeded" || !command.payload.recheckPostingCommandId) return null;
  const expected = command.payload.transactions as Array<Record<string, unknown>> | undefined;
  const rows = command.result?.transactions as Array<Record<string, unknown>> | undefined;
  if (expected?.length !== 1 || rows?.length !== 1) return null;
  if (originalPayload && ["transactionId", "voucherDate", "amount", "expectedDirection", "referenceNumber", "bankLedgerName"]
    .some(key => expected[0][key] !== originalPayload[key])) return null;
  const row = rows[0];
  if (row.transactionId !== expected[0].transactionId || row.verificationStatus !== "found" ||
    row.matchCount !== 1 || row.duplicateInTally === true || !row.voucherId) return null;
  return { transactionId: String(row.transactionId), voucherId: String(row.voucherId),
    voucherNumber: typeof row.voucherNumber === "string" ? row.voucherNumber : "", verification: row };
}
