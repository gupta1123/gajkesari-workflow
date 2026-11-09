import { derivePaymentFollowUpTiming, sortByFollowUpPriority } from "./payment-follow-up.ts";
import { classifyPaymentNarration } from "./payment-terms.ts";

/** Each live read covers a handful of customers so Tally is never asked for a full export. */
export const MAX_LEDGERS_PER_READ = 10;
export const MAX_SCOPE_LEDGERS = 200;

export type LiveBill = {
  kind?: string;
  referenceName?: string;
  voucherNumber?: string;
  invoiceDate?: string | null;
  dueDate?: string | null;
  originalAmount?: number;
  pendingAmount?: number;
  narration?: string | null;
};

export type FollowUpCandidate = {
  customer: string;
  invoice: string;
  invoiceDate: string | null;
  outstanding: number;
  originalAmount: number | null;
  narration: string;
  paymentCategory: "advance_rtgs" | "same_day_rtgs" | null;
  eligible: boolean;
  ageDays: number | null;
  ageLabel: string;
  dueDate: string | null;
};

/** Clean a requested ledger list: trimmed, unique, case-preserving, bounded. */
export function normalizeLedgerNames(value: unknown, max: number): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const name = String(entry ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.slice(0, max);
}

/** Requested ledgers that are not inside the saved scope (compared case-insensitively). */
export function ledgersOutsideScope(requested: string[], scope: string[]) {
  const allowed = new Set(scope.map((name) => name.toLowerCase()));
  return requested.filter((name) => !allowed.has(name.toLowerCase()));
}

/**
 * Open invoices (never advances) with their payment-terms timing, oldest and
 * largest first. Pure: the caller supplies a live read and today's date.
 */
export function buildFollowUpCandidates(
  byLedger: Record<string, { openBills?: LiveBill[] } | undefined>,
  today: string
): FollowUpCandidate[] {
  const rows: Array<FollowUpCandidate & { partyLedgerName: string; outstandingAmount: number }> = [];
  for (const [customer, bucket] of Object.entries(byLedger)) {
    for (const bill of bucket?.openBills ?? []) {
      if (bill.kind && bill.kind !== "bill") continue;
      const pending = bill.pendingAmount;
      const invoice = String(bill.referenceName || bill.voucherNumber || "").trim();
      if (!invoice || typeof pending !== "number" || !Number.isFinite(pending) || pending <= 0.005) continue;
      const narration = String(bill.narration ?? "").trim().slice(0, 500);
      const timing = derivePaymentFollowUpTiming({ narration, invoiceDate: bill.invoiceDate }, today);
      rows.push({
        customer, invoice,
        invoiceDate: timing.invoiceDate,
        outstanding: Math.round(pending * 100) / 100,
        originalAmount: typeof bill.originalAmount === "number" ? bill.originalAmount : null,
        narration,
        paymentCategory: classifyPaymentNarration(narration).category,
        eligible: timing.eligible,
        ageDays: timing.ageDays,
        ageLabel: timing.ageLabel,
        dueDate: timing.dueDate,
        partyLedgerName: customer,
        outstandingAmount: pending,
      });
    }
  }
  return sortByFollowUpPriority(rows).map(({ partyLedgerName: _p, outstandingAmount: _o, ...candidate }) => candidate);
}
