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
  const summary = { total: commands.length, confirmed: 0, needsCheck: 0, failed: 0, pending: 0, accepted: 0, alreadyExisting: 0 };
  for (const command of commands) {
    const outcome = bankPostingOutcome(command);
    if (outcome.accepted) summary.accepted++;
    if (outcome.status === "confirmed") {
      summary.confirmed++;
      if (command.result?.alreadyInTally === true) summary.alreadyExisting++;
    }
    else if (outcome.status === "needs_check") summary.needsCheck++;
    else if (outcome.status === "failed") summary.failed++;
    else summary.pending++;
  }
  return summary;
}

export function bankPostingMessage(summary: ReturnType<typeof summarizeBankPostings>) {
  const progress = `${summary.confirmed - summary.alreadyExisting} newly posted; ${summary.alreadyExisting} already entered in Tally; ${summary.needsCheck} need review`;
  if (summary.pending) return `${progress}. ${summary.pending} still processing.${summary.failed ? ` ${summary.failed} couldn't be posted.` : ""}`;
  if (summary.needsCheck) return `${progress}.${summary.failed ? ` ${summary.failed} couldn't be posted.` : ""}`;
  if (summary.failed) return `${progress}. ${summary.failed} couldn't be posted.`;
  if (summary.alreadyExisting === summary.total && summary.total > 0) return `${summary.alreadyExisting} ${summary.alreadyExisting === 1 ? "entry was" : "entries were"} already entered in Tally. No new entries were posted.`;
  if (summary.alreadyExisting > 0) {
    const posted = summary.confirmed - summary.alreadyExisting;
    return `${posted} ${posted === 1 ? "entry" : "entries"} posted and confirmed in Tally. ${summary.alreadyExisting} already entered in Tally; skipped.`;
  }
  return `${summary.confirmed} entries posted and confirmed in Tally.`;
}
