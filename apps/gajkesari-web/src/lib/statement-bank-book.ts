import { bankPostingOutcome, summarizeBankPostings } from "@gajkesari/shared/lib/bank-posting-outcome";
import type { BankBookRow } from "./bank-book-csv";

type StatementRow = {
  transactionDate?: string | null;
  description?: string | null;
  referenceNumber?: string | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
  balanceAmount?: string | number | null;
  selectedLedgerName?: string | null;
};
export type SavedPostingRow = StatementRow & {
  id: string;
  ledgerName?: string | null;
  voucherNumber?: string | null;
  postingStatus?: string;
  postingCommandId?: string | null;
  postingResult?: Record<string, unknown> | null;
  voucherType?: string | null;
};

export function statementRowKey(row: StatementRow) {
  return JSON.stringify([row.transactionDate, row.referenceNumber || "", row.description || "",
    Number(row.debitAmount || 0), Number(row.creditAmount || 0),
    row.balanceAmount == null || row.balanceAmount === "" ? null : Number(row.balanceAmount)]);
}

export function savedPostingOutcome(row: SavedPostingRow) {
  if (row.postingStatus === "verified") return { status: "confirmed", accepted: true } as const;
  if (row.postingStatus === "needs_tally_review") return bankPostingOutcome({
    status: "failed", reconciliationRequired: true, result: row.postingResult,
  });
  return bankPostingOutcome({ status: row.postingStatus, result: row.postingResult });
}

export function summarizeSavedPostings(rows: SavedPostingRow[]) {
  return summarizeBankPostings(rows.map(row => ({ status: row.postingStatus === "verified" ? "succeeded" : row.postingStatus,
    reconciliationRequired: row.postingStatus === "needs_tally_review",
    result: row.postingStatus === "verified" ? { ...row.postingResult, verificationStatus: "verified" } : row.postingResult })));
}

export function summarizeStatementPostings(rows: StatementRow[], saved: SavedPostingRow[]) {
  const byKey = new Map(saved.map(row => [statementRowKey(row), row]));
  return summarizeSavedPostings(rows.map((row, index) => byKey.get(statementRowKey(row)) ??
    { ...row, id: `unsubmitted-${index}`, postingStatus: "pending" }));
}

// Results known before this upload's Post action are existing entries, even
// when an identical PDF reuses the original import and transaction IDs.
export function markPreviouslyConfirmedPostings<T extends SavedPostingRow>(saved: T[], previous: SavedPostingRow[]) {
  const existingIds = new Set(previous.filter(row => savedPostingOutcome(row).status === "confirmed").map(row => row.id));
  return saved.map(row => existingIds.has(row.id) && savedPostingOutcome(row).status === "confirmed"
    ? { ...row, postingResult: { ...row.postingResult, alreadyInTally: true } } : row);
}

export function mergeCompletedPostingEvidence<T extends SavedPostingRow>(saved: T[], commands: Array<{
  commandType?: string; command_type?: string; status?: string; result?: Record<string, unknown> | null;
}>) {
  const confirmed = new Map(commands.flatMap(command => {
    const result = command.result;
    return (command.commandType || command.command_type) === "post_bank_voucher" &&
      bankPostingOutcome(command).status === "confirmed" && typeof result?.transactionId === "string"
      ? [[result.transactionId, result] as const] : [];
  }));
  return saved.map(row => {
    const result = confirmed.get(row.id);
    // Read-back belongs to this exact posting command, never to another
    // preview row that merely matched the same voucher during a bulk check.
    return result ? { ...row, postingStatus: "verified", postingResult: { ...row.postingResult, ...result },
      voucherNumber: typeof result.voucherNumber === "string" ? result.voucherNumber : row.voucherNumber } : row;
  });
}

export function postingFooterSegments(summary: ReturnType<typeof summarizeBankPostings>, processing = true) {
  const segments: Array<{ text: string; tone: "success" | "neutral" | "review" | "error" }> = [];
  const newlyPosted = summary.confirmed - summary.alreadyExisting;
  if (newlyPosted > 0) segments.push({ text: `${newlyPosted} posted`, tone: "success" });
  if (summary.alreadyExisting > 0) segments.push({ text: `${summary.alreadyExisting} already entered`, tone: "neutral" });
  if (summary.held > 0) segments.push({ text: `${summary.held} ${summary.held === 1 ? "needs" : "need"} review`, tone: "review" });
  if (summary.confirmationPending > 0) segments.push({ text: `${summary.confirmationPending} awaiting confirmation`, tone: "review" });
  if (summary.outcomeUnknown > 0) segments.push({ text: `${summary.outcomeUnknown} posting ${summary.outcomeUnknown === 1 ? "outcome" : "outcomes"} unknown`, tone: "review" });
  if (summary.failed > 0) segments.push({ text: `${summary.failed} couldn't be posted`, tone: "error" });
  if (summary.pending > 0) segments.push({ text: `${summary.pending} ${processing ? "processing" : "not sent"}`, tone: processing ? "neutral" : "review" });
  return segments;
}

export type PostingMatch = {
  reasons: string[]; ledgerNames: string[]; bankReferences: string[];
  date: string | null; voucherType: string | null; voucherNumber: string | null;
  reference: string | null; partyLedgerName: string | null; masterId: string | null;
  amount?: number | null; bankLedgerName?: string | null; direction?: string | null;
};
export function postingMatches(result?: Record<string, unknown> | null): PostingMatch[] {
  const recheck = result?.recheck as { verification?: Record<string, unknown>; lastSuccessfulVerification?: Record<string, unknown> } | undefined;
  const check = result?.duplicateCheck as Record<string, unknown> | undefined;
  const latest = recheck?.verification;
  const matches = latest && latest.verificationStatus !== "failed" ? latest.matches : recheck?.lastSuccessfulVerification?.matches ?? check?.matches ?? result?.matches;
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return Array.isArray(matches) ? matches.flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const string = (key: string) => typeof row[key] === "string" ? row[key] as string : null;
    return [{ reasons: strings(row.reasons), ledgerNames: strings(row.ledgerNames), bankReferences: strings(row.bankReferences),
      date: string("date"), voucherType: string("voucherType"), voucherNumber: string("voucherNumber"), reference: string("reference"),
      partyLedgerName: string("partyLedgerName"), masterId: string("masterId"),
      amount: typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : null,
      bankLedgerName: string("bankLedgerName"), direction: string("direction") }];
  }) : [];
}

export function heldPostingReason(row: StatementRow, rows: StatementRow[], matches: PostingMatch[]) {
  const normalize = (value?: string | null) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const sameRows = rows.filter(candidate => candidate.transactionDate === row.transactionDate &&
    candidate.description === row.description && !candidate.referenceNumber &&
    Number(candidate.debitAmount || 0) === Number(row.debitAmount || 0) && Number(candidate.creditAmount || 0) === Number(row.creditAmount || 0));
  let reason = "Possible existing entry in Tally. Compare the voucher details before deciding whether this is a separate transaction.";
  if (matches.length > 1) reason = `${matches.length} Tally vouchers could match this transaction. Compare their dates, parties and references to identify the correct voucher.`;
  else if (!row.referenceNumber && sameRows.length > 1 && matches.length === 1) reason = "This statement repeats the same transaction details without a bank reference. One existing Tally voucher cannot confirm both rows. Check whether this row is a separate transaction.";
  else if (matches.length === 1) {
    const match = matches[0];
    const references = [match.reference, ...match.bankReferences].filter(Boolean);
    if (row.referenceNumber && references.length && !references.some(reference => normalize(reference) === normalize(row.referenceNumber))) {
      reason = `A similar Tally voucher has a different reference: this statement shows ${row.referenceNumber}; Tally shows ${references.join(", ")}. Compare them before posting.`;
    } else if (row.selectedLedgerName && match.ledgerNames.length && !match.ledgerNames.some(name => normalize(name) === normalize(row.selectedLedgerName))) {
      reason = `A similar Tally voucher uses a different party ledger: Tally shows ${match.partyLedgerName || match.ledgerNames.join(", ")}; this entry is assigned to ${row.selectedLedgerName}. Compare the party details before posting.`;
    }
  }
  return `${reason} Nothing was posted for this row.`;
}

export function statementCheckMessage(drafts: Array<{ status?: string; reviewKind?: string }>) {
  const checking = drafts.filter(row => row.status === "checking").length;
  const notChecked = drafts.filter(row => !row.status || row.status === "not_checked" || row.status === "cannot_check_yet").length;
  const failed = drafts.filter(row => row.status === "failed").length;
  const review = drafts.filter(row => row.status === "ambiguous" || row.reviewKind === "held").length;
  const uncertain = drafts.filter(row => row.status === "verification_pending" && row.reviewKind !== "held").length;
  if (checking) return `Checking ${checking} ${checking === 1 ? "entry" : "entries"} in Tally`;
  if (notChecked) return `${notChecked} ${notChecked === 1 ? "entry has" : "entries have"} not been checked in Tally`;
  if (failed) return `${failed} ${failed === 1 ? "entry" : "entries"} couldn't be checked in Tally`;
  if (review || uncertain) return `Check complete · ${[review ? `${review} ${review === 1 ? "entry needs" : "entries need"} review` : "", uncertain ? `${uncertain} posting ${uncertain === 1 ? "confirmation needs" : "confirmations need"} checking` : ""].filter(Boolean).join(" · ")}`;
  return "Tally check complete";
}

export function statementBalanceMessage(proof?: { balancesMatch?: boolean | null; statementOpeningBalance?: number | null; tallyOpeningBalance?: number | null; statementClosingBalance?: number | null; tallyClosingBalance?: number | null } | null) {
  if (proof?.balancesMatch !== false) return "";
  const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);
  const comparisons = [["Opening", proof.statementOpeningBalance, proof.tallyOpeningBalance], ["Closing", proof.statementClosingBalance, proof.tallyClosingBalance]] as const;
  const details = comparisons.flatMap(([label, statement, tally]) => typeof statement === "number" && typeof tally === "number" && Number.isFinite(statement) && Number.isFinite(tally)
    ? [`${label} balance: statement ${money(statement)}; Tally ${money(tally)}; difference ${money(Math.abs(statement - tally))}.`] : []);
  return `${details.length ? details.join(" ") : "The statement and Tally balances differ."} Compare the bank ledger for the statement period; entries awaiting review or other Tally entries may explain the difference. Your download keeps the statement balances.`;
}

export function savedPostingPresence(rows: Array<StatementRow & { id: string }>, postings: SavedPostingRow[]) {
  const saved = new Map(postings.map(row => [statementRowKey(row), row]));
  type Presence = { status: "found" | "verification_pending"; label: string; reason: string; voucherNumber: string | null; alreadyInTally?: boolean;
    reviewKind?: "held" | "confirmation_pending" | "outcome_unknown"; matches: PostingMatch[]; voucherDate?: string | null; duplicateInTally?: boolean;
    checkedAt?: string | null; checkFailed?: boolean };
  return Object.fromEntries(rows.flatMap<[string, Presence]>(row => {
    const posting = saved.get(statementRowKey(row));
    if (!posting) return [];
    const outcome = savedPostingOutcome(posting);
    const matches = postingMatches(posting.postingResult);
    const recheck = posting.postingResult?.recheck as { checkedAt?: string; verification?: Record<string, unknown> } | undefined;
    const evidence = { matches, voucherDate: matches[0]?.date || null, checkedAt: recheck?.checkedAt || null,
      checkFailed: recheck?.verification?.verificationStatus === "failed", duplicateInTally: recheck?.verification
        ? recheck.verification.duplicateInTally === true : posting.postingResult?.duplicateInTally === true ||
      (posting.postingResult?.duplicateCheck as Record<string, unknown> | undefined)?.duplicateInTally === true };
    if (outcome.status === "confirmed") return [[row.id, { status: "found" as const,
      label: posting.postingResult?.alreadyInTally === true ? "Already entered in Tally" : "Confirmed in Tally",
      reason: posting.postingResult?.alreadyInTally === true ? "This entry was already in Tally. No new entry was posted." : "This entry was confirmed in Tally.", voucherNumber: posting.voucherNumber || null,
      alreadyInTally: posting.postingResult?.alreadyInTally === true, ...evidence }]];
    if (outcome.status === "needs_check") return [[row.id, { status: "verification_pending" as const,
      label: evidence.checkFailed ? "Couldn't recheck in Tally"
        : posting.postingResult?.possibleDuplicateInTally === true ? recheck?.verification?.verificationStatus === "missing" ? "Still needs review" : "Possible existing entry"
        : outcome.accepted ? "Accepted by Tally; confirmation pending" : "Posting outcome unknown",
      reason: evidence.checkFailed ? "The latest Tally check couldn't finish. Any voucher details below are from the previous check. Keep Tally and the connector open, then recheck."
        : posting.postingResult?.possibleDuplicateInTally === true ? recheck?.verification?.verificationStatus === "missing"
          ? "No matching voucher was found in the latest Tally check. This entry is still held back and was not posted. Check the bank ledger in Tally before deciding how to handle it."
          : typeof recheck?.verification?.reason === "string" && recheck.verification.reason.includes("another statement entry")
            ? `${recheck.verification.reason} Nothing was posted for this row.`
            : heldPostingReason({ ...row, selectedLedgerName: posting.ledgerName || row.selectedLedgerName }, rows, matches)
        : outcome.accepted ? "Tally accepted this entry, but its voucher confirmation is pending. Recheck in Tally; do not post it again."
          : "We couldn't confirm whether this entry was posted. Check Tally before retrying to avoid a duplicate.",
      reviewKind: posting.postingResult?.possibleDuplicateInTally === true ? "held" : outcome.accepted ? "confirmation_pending" : "outcome_unknown",
      voucherNumber: null, ...evidence }]];
    return [];
  }));
}

// Statement balances are source data; Tally confirmation must never remove a
// movement or determine whether these balances are included in a download.
export function statementBalances(rows: StatementRow[]) {
  if (!rows.length || rows.some(row => row.balanceAmount == null || row.balanceAmount === "" || !Number.isFinite(Number(row.balanceAmount)))) return undefined;
  const cents = (value: unknown) => Math.round(Number(value || 0) * 100);
  const check = (ordered: StatementRow[]) => {
    for (let i = 1; i < ordered.length; i++) {
      if (cents(ordered[i - 1].balanceAmount) + cents(ordered[i].creditAmount) - cents(ordered[i].debitAmount) !== cents(ordered[i].balanceAmount)) return undefined;
    }
    const first = ordered[0];
    return { opening: (cents(first.balanceAmount) - cents(first.creditAmount) + cents(first.debitAmount)) / 100,
      closing: cents(ordered.at(-1)!.balanceAmount) / 100 };
  };
  return check(rows) ?? check([...rows].reverse());
}

export function buildStatementBankBook(rows: StatementRow[], postings: SavedPostingRow[]): BankBookRow[] {
  const saved = new Map(postings.map(row => [statementRowKey(row), row]));
  return rows.map(row => {
    const posting = saved.get(statementRowKey(row));
    const outcome = posting ? savedPostingOutcome(posting) : null;
    return {
      date: row.transactionDate || "",
      // Decode display text only; the exact saved ledger identity sent to Tally
      // is left untouched.
      party: (posting?.ledgerName || row.selectedLedgerName || row.description || "")
        .replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
      voucherNumber: outcome?.status === "confirmed" ? posting?.voucherNumber || "" : "",
      receipt: Number(row.creditAmount || 0), payment: Number(row.debitAmount || 0),
      voucherType: posting?.voucherType || undefined,
      postingStatus: outcome?.status === "confirmed" ? "Confirmed in Tally"
        : outcome?.status === "needs_check" ? (outcome.accepted ? "Accepted by Tally - needs checking" : "Needs checking in Tally")
        : outcome?.status === "failed" ? "Couldn't post" : posting?.postingStatus === "queued" ? "Sending to Tally" : "Not sent to Tally",
    };
  });
}
