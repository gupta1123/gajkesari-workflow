export type BankPostingCommand = {
  status?: string | null;
  reconciliationRequired?: boolean;
  reconciliation_required?: boolean;
  result?: Record<string, unknown> | null;
};

export function bankPostingOutcome(command: BankPostingCommand) {
  const result = command.result ?? {};
  const check = result.duplicateCheck as Record<string, unknown> | undefined;
  const verified = ["verified", "found", "matched"].includes(String(result.verificationStatus ?? check?.verificationStatus ?? ""));
  if (command.status === "succeeded" && verified) return { status: "confirmed", accepted: true } as const;
  const needsCheck = command.reconciliationRequired || command.reconciliation_required ||
    result.reconciliationRequired === true || result.possibleDuplicateInTally === true ||
    result.voucherCreatedButVerificationFailed === true || (command.status === "succeeded" && !verified);
  if (needsCheck) {
    const summary = result.importSummary as Record<string, unknown> | undefined;
    const accepted = Boolean(summary && Number(summary.created) > 0 && Number(summary.errors) === 0 &&
      Number(summary.exceptions ?? 0) === 0 && Number(summary.cancelled ?? 0) === 0 && Number(summary.ignored ?? 0) === 0 &&
      (result.batchSize == null || Number(summary.created) === Number(result.batchSize)));
    return { status: "needs_check", accepted } as const;
  }
  if (["failed", "cancelled", "canceled", "expired", "quarantined"].includes(String(command.status))) {
    return { status: "failed", accepted: false } as const;
  }
  return { status: "pending", accepted: false } as const;
}

export function summarizeBankPostings(commands: BankPostingCommand[]) {
  const summary = { total: commands.length, confirmed: 0, needsCheck: 0, failed: 0, pending: 0, accepted: 0, alreadyExisting: 0,
    held: 0, confirmationPending: 0, outcomeUnknown: 0 };
  for (const command of commands) {
    const outcome = bankPostingOutcome(command);
    if (outcome.accepted) summary.accepted++;
    if (outcome.status === "confirmed") {
      summary.confirmed++;
      if (command.result?.alreadyInTally === true) summary.alreadyExisting++;
    }
    else if (outcome.status === "needs_check") {
      summary.needsCheck++;
      if (command.result?.possibleDuplicateInTally === true) summary.held++;
      else if (outcome.accepted) summary.confirmationPending++;
      else summary.outcomeUnknown++;
    }
    else if (outcome.status === "failed") summary.failed++;
    else summary.pending++;
  }
  return summary;
}

export function bankPostingMessage(summary: ReturnType<typeof summarizeBankPostings>) {
  const progress = [`${summary.confirmed - summary.alreadyExisting} newly posted`, `${summary.alreadyExisting} already entered in Tally`];
  if (summary.held) progress.push(`${summary.held} not posted: possible duplicates need review`);
  if (summary.confirmationPending) progress.push(`${summary.confirmationPending} accepted by Tally: confirmation pending`);
  if (summary.outcomeUnknown) progress.push(`${summary.outcomeUnknown} posting ${summary.outcomeUnknown === 1 ? "outcome" : "outcomes"} unknown: check Tally before retrying`);
  if (summary.failed) progress.push(`${summary.failed} couldn't be posted`);
  if (summary.pending) progress.push(`${summary.pending} still processing`);
  if (summary.pending || summary.needsCheck || summary.failed) return `${progress.join("; ")}.`;
  if (!summary.total) return "No entries were posted.";
  if (summary.alreadyExisting === summary.total && summary.total > 0) return `${summary.alreadyExisting} ${summary.alreadyExisting === 1 ? "entry was" : "entries were"} already entered in Tally. No new entries were posted.`;
  if (summary.alreadyExisting > 0) {
    const posted = summary.confirmed - summary.alreadyExisting;
    return `${posted} ${posted === 1 ? "entry" : "entries"} posted and confirmed in Tally. ${summary.alreadyExisting} already entered in Tally; skipped.`;
  }
  return `${summary.confirmed} ${summary.confirmed === 1 ? "entry" : "entries"} posted and confirmed in Tally.`;
}

export function bankPostingTitle(summary: ReturnType<typeof summarizeBankPostings>) {
  if (summary.failed) return "Some entries couldn't be posted";
  if (summary.pending) return "Processing entries in Tally";
  if (summary.held) return "Some entries need review";
  if (summary.needsCheck) return "Some posting confirmations need checking";
  return "Entries confirmed in Tally";
}
