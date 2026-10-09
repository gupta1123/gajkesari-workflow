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

export function savedPostingPresence(rows: Array<StatementRow & { id: string }>, postings: SavedPostingRow[]) {
  const saved = new Map(postings.map(row => [statementRowKey(row), row]));
  type Presence = { status: "found" | "verification_pending"; label: string; reason: string; voucherNumber: string | null; alreadyInTally?: boolean };
  return Object.fromEntries(rows.flatMap<[string, Presence]>(row => {
    const posting = saved.get(statementRowKey(row));
    if (!posting) return [];
    const outcome = savedPostingOutcome(posting);
    if (outcome.status === "confirmed") return [[row.id, { status: "found" as const,
      label: posting.postingResult?.alreadyInTally === true ? "Already entered in Tally" : "Confirmed in Tally",
      reason: posting.postingResult?.alreadyInTally === true ? "This entry was already in Tally. No new entry was posted." : "This entry was confirmed in Tally.", voucherNumber: posting.voucherNumber || null,
      alreadyInTally: posting.postingResult?.alreadyInTally === true }]];
    if (outcome.status === "needs_check") return [[row.id, { status: "verification_pending" as const, label: "Needs checking in Tally",
      reason: posting.postingResult?.possibleDuplicateInTally === true ? "Possible existing entry in Tally. Nothing was posted for this row. Please review."
        : outcome.accepted ? "Tally accepted the entries, but this entry still needs checking. Do not send it again." : "We couldn't confirm this entry in Tally. Check again before sending it again.", voucherNumber: null }]];
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
