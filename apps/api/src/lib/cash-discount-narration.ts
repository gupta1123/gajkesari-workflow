import { classifyPaymentNarration, paymentRequirement, validPaymentDate, type PaymentCategory } from '@/lib/payment-terms';

export type CashDiscountTerm = {
  ratePercent: 1 | 1.5;
  eligibilityDays: number;
  periodSource: "explicit" | "default";
  paymentCategory?: PaymentCategory;
};

export type CurrentCashDiscountEligibility = {
  ratePercent: number;
  eligibilityDays: number;
  periodSource: "explicit" | "default";
  discountDeadline: string;
  discountAmount: number;
};

export type CashDiscountDeterministicStatus =
  | "no_cash_discount_context"
  | "cash_discount_rate_missing"
  | "unsupported_cash_discount_rate"
  | "missing_invoice_date"
  | "within_eligibility_window"
  | "unpaid_discount_tier_expired"
  | "late_payment_discount_expired"
  | "invoice_unpaid"
  | "receipt_date_not_found"
  | "discount_taken_within_window"
  | "receipt_amount_unverified"
  | "balance_does_not_match_narrated_discount"
  | "existing_balance_due"
  | "late_short_payment";

export type CashDiscountReversalPlan = {
  /** The Tally invoice is treated as the amount after this best narrated discount. */
  initialDiscount: CurrentCashDiscountEligibility;
  grossInvoiceAmount: number;
  activeDiscount: CurrentCashDiscountEligibility | null;
  currentPayableAmount: number;
  totalReversalRequired: number;
};

export type CashDiscountNarrationAnalysis = {
  paymentCategory: PaymentCategory | null;
  sourceNarration: string;
  matchedCashDiscountContext: string | null;
  terms: CashDiscountTerm[];
  termsLabel: string | null;
  finalEligibilityDays: number | null;
  discountDeadline: string | null;
  receiptDate: string | null;
  matchedReceiptAmount: number | null;
  expectedDiscounts: Array<{ ratePercent: number; amount: number }>;
  matchedDiscount: { ratePercent: number; amount: number } | null;
  reversalPlan: CashDiscountReversalPlan | null;
  deterministicStatus: CashDiscountDeterministicStatus;
  deterministicReason: string;
};

const SUPPORTED_CASH_DISCOUNT_RATES = [1.5, 1] as const;

type ParsedCashDiscountNarration = {
  matchedCashDiscountContext: string | null;
  hasCashDiscountContext: boolean;
  supportedRates: Array<1 | 1.5>;
  unsupportedRates: number[];
  terms: CashDiscountTerm[];
};

function asMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function moneyClose(left: number, right: number) {
  return Math.abs(left - right) <= 1;
}

export function isCashDiscountRecoveryStatus(status: string) {
  return status === 'unpaid_discount_tier_expired' || status === 'late_payment_discount_expired';
}

function addDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isAfterDate(left: string, right: string) {
  return Date.parse(`${left}T00:00:00.000Z`) > Date.parse(`${right}T00:00:00.000Z`);
}

function normalizeTerms(terms: CashDiscountTerm[]) {
  const byRate = new Map<number, CashDiscountTerm>();
  for (const term of terms) {
    const ratePercent = Number(term.ratePercent);
    const eligibilityDays = Math.trunc(Number(term.eligibilityDays));
    if (!Number.isFinite(ratePercent) || !Number.isFinite(eligibilityDays)) continue;
    if (!isSupportedCashDiscountRate(ratePercent) || eligibilityDays < (term.paymentCategory === 'advance_rtgs' ? -1 : 0) || eligibilityDays > 365) continue;
    const existing = byRate.get(ratePercent);
    if (!existing || (existing.periodSource === "default" && term.periodSource === "explicit")) {
      byRate.set(ratePercent, {
        ratePercent,
        eligibilityDays,
        periodSource: term.periodSource,
        paymentCategory: term.paymentCategory,
      });
    }
  }
  return Array.from(byRate.values()).sort(
    (left, right) => left.eligibilityDays - right.eligibilityDays || right.ratePercent - left.ratePercent
  );
}

function isSupportedCashDiscountRate(value: number): value is 1 | 1.5 {
  return SUPPORTED_CASH_DISCOUNT_RATES.some((rate) => Math.abs(rate - value) < 0.0001);
}

export function formatCashDiscountTerms(terms: CashDiscountTerm[]) {
  return terms
    .map((term) => term.paymentCategory === 'advance_rtgs' ? '1.5% — payment before invoice date' : term.paymentCategory === 'same_day_rtgs' ? '1% — payment on invoice date' : `${Number(term.ratePercent).toLocaleString("en-IN", { maximumFractionDigits: 2 })}% within ${term.eligibilityDays} days`)
    .join("; ");
}

/**
 * Returns the best narrated discount that is still available today. This is
 * used for collection follow-ups only; it never authorizes a debit note.
 */
export function currentCashDiscountEligibility(input: {
  terms: CashDiscountTerm[];
  invoiceDate: string | null | undefined;
  originalAmount: number;
  today: string;
}): CurrentCashDiscountEligibility | null {
  const invoiceDate = validPaymentDate(input.invoiceDate);
  if (!invoiceDate || !Number.isFinite(input.originalAmount) || input.originalAmount <= 0) return null;

  const eligible = normalizeTerms(input.terms)
    .map((term) => ({
      term,
      discountDeadline: addDays(invoiceDate, term.eligibilityDays),
    }))
    .filter((entry): entry is { term: CashDiscountTerm; discountDeadline: string } => Boolean(entry.discountDeadline))
    .filter((entry) => !isAfterDate(input.today, entry.discountDeadline));
  if (eligible.length === 0) return null;

  const best = eligible.reduce((current, entry) =>
    entry.term.ratePercent > current.term.ratePercent ||
    (entry.term.ratePercent === current.term.ratePercent && entry.term.eligibilityDays < current.term.eligibilityDays)
      ? entry
      : current
  );
  return {
    ratePercent: best.term.ratePercent,
    eligibilityDays: best.term.eligibilityDays,
    periodSource: best.term.periodSource,
    discountDeadline: best.discountDeadline,
    discountAmount: asMoney((input.originalAmount * best.term.ratePercent) / 100),
  };
}

function initialCashDiscountEligibility(input: {
  terms: CashDiscountTerm[];
  invoiceDate: string | null | undefined;
  grossInvoiceAmount: number;
}): CurrentCashDiscountEligibility | null {
  const invoiceDate = String(input.invoiceDate ?? "").slice(0, 10);
  if (!invoiceDate || !Number.isFinite(input.grossInvoiceAmount) || input.grossInvoiceAmount <= 0) return null;
  const terms = normalizeTerms(input.terms);
  if (terms.length === 0) return null;
  const best = terms.reduce((current, term) =>
    term.ratePercent > current.ratePercent ||
    (term.ratePercent === current.ratePercent && term.eligibilityDays < current.eligibilityDays)
      ? term
      : current
  );
  const discountDeadline = addDays(invoiceDate, best.eligibilityDays);
  if (!discountDeadline) return null;
  return {
    ratePercent: best.ratePercent,
    eligibilityDays: best.eligibilityDays,
    periodSource: best.periodSource,
    discountDeadline,
    discountAmount: asMoney((input.grossInvoiceAmount * best.ratePercent) / 100),
  };
}

function createUnpaidReversalPlan(input: {
  terms: CashDiscountTerm[];
  invoiceDate: string | null | undefined;
  invoiceNetAmount: number;
  today: string;
}): CashDiscountReversalPlan | null {
  const terms = normalizeTerms(input.terms);
  const highestRate = terms.reduce((maximum, term) => Math.max(maximum, term.ratePercent), 0);
  if (!Number.isFinite(input.invoiceNetAmount) || input.invoiceNetAmount <= 0 || highestRate <= 0 || highestRate >= 100) {
    return null;
  }
  const grossInvoiceAmount = asMoney(input.invoiceNetAmount / (1 - highestRate / 100));
  const initialDiscount = initialCashDiscountEligibility({
    terms,
    invoiceDate: input.invoiceDate,
    grossInvoiceAmount,
  });
  if (!initialDiscount) return null;
  const activeDiscount = currentCashDiscountEligibility({
    terms,
    invoiceDate: input.invoiceDate,
    originalAmount: grossInvoiceAmount,
    today: input.today,
  });
  const currentPayableAmount = asMoney(grossInvoiceAmount - (activeDiscount?.discountAmount ?? 0));
  return {
    initialDiscount,
    grossInvoiceAmount,
    activeDiscount,
    currentPayableAmount,
    totalReversalRequired: asMoney(Math.max(currentPayableAmount - input.invoiceNetAmount, 0)),
  };
}

/** Classify only the two client-approved RTGS narration patterns. */
export function parseCashDiscountNarration(sourceNarration: string | null | undefined): ParsedCashDiscountNarration {
  const parsed = classifyPaymentNarration(sourceNarration);
  const category = parsed.category;
  const ratePercent = category === 'advance_rtgs' ? 1.5 : 1;
  const terms: CashDiscountTerm[] = category ? [{ ratePercent, eligibilityDays: category === 'advance_rtgs' ? -1 : 0, periodSource: 'explicit', paymentCategory: category }] : [];
  return {
    matchedCashDiscountContext: category === 'advance_rtgs' ? 'ADVANCE RTGS' : category === 'same_day_rtgs' ? 'SAME DAY RTGS' : parsed.ambiguous ? 'Conflicting RTGS terms' : null,
    hasCashDiscountContext: Boolean(category) || parsed.ambiguous,
    supportedRates: category ? [ratePercent] : [],
    unsupportedRates: [],
    terms,
  };
}

export function parseCashDiscountTerms(sourceNarration: string | null | undefined) {
  return parseCashDiscountNarration(sourceNarration).terms;
}

export function analyseCashDiscountNarration(input: {
  narration: string | null | undefined;
  invoiceDate: string | null | undefined;
  originalAmount: number;
  pendingAmount: number;
  receiptDate?: string | null | undefined;
  matchedReceiptAmount?: number | null | undefined;
  invoiceEvidenceAmbiguous?: boolean;
  today: string;
}): CashDiscountNarrationAnalysis {
  const sourceNarration = String(input.narration ?? '').trim();
  const parsed = classifyPaymentNarration(sourceNarration);
  const terms = parseCashDiscountTerms(sourceNarration);
  const requirement = parsed.category ? paymentRequirement(parsed.category, input.invoiceDate) : null;
  const receiptDate = validPaymentDate(input.receiptDate);
  const matchedReceiptAmount = input.matchedReceiptAmount != null && Number.isFinite(Number(input.matchedReceiptAmount))
    ? asMoney(Number(input.matchedReceiptAmount)) : null;
  const reversalPlan = requirement ? createUnpaidReversalPlan({ terms, invoiceDate: input.invoiceDate, invoiceNetAmount: input.originalAmount, today: input.today }) : null;
  const expectedDiscounts = terms.map(term => ({ ratePercent: term.ratePercent, amount: asMoney((reversalPlan?.grossInvoiceAmount ?? input.originalAmount) * term.ratePercent / 100) }));
  const base = {
    paymentCategory: parsed.category,
    sourceNarration,
    matchedCashDiscountContext: parseCashDiscountNarration(sourceNarration).matchedCashDiscountContext,
    terms,
    termsLabel: terms.length ? formatCashDiscountTerms(terms) : null,
    finalEligibilityDays: requirement?.eligibilityDays ?? null,
    discountDeadline: requirement?.deadline ?? null,
    receiptDate,
    matchedReceiptAmount,
    expectedDiscounts,
    matchedDiscount: expectedDiscounts.find(term => moneyClose(input.pendingAmount, term.amount)) ?? null,
    reversalPlan,
  };
  const result = (deterministicStatus: CashDiscountDeterministicStatus, deterministicReason: string): CashDiscountNarrationAnalysis => ({ ...base, deterministicStatus, deterministicReason });
  if (parsed.ambiguous) return result('cash_discount_rate_missing', 'Both ADVANCE RTGS and SAME DAY RTGS are present. Review the agreed payment category.');
  if (!parsed.category) return result('no_cash_discount_context', 'Neither ADVANCE RTGS nor SAME DAY RTGS was found in the invoice narration.');
  if (!requirement || !validPaymentDate(input.today)) return result('missing_invoice_date', 'A valid invoice date and business date are required to check RTGS payment terms.');
  if (input.invoiceEvidenceAmbiguous) return result('receipt_amount_unverified', 'Invoice or allocation evidence is ambiguous. Review it in Tally before recovering CD.');
  if (!Number.isFinite(input.originalAmount) || input.originalAmount <= 0 || !Number.isFinite(input.pendingAmount) || input.pendingAmount < 0 || input.pendingAmount > input.originalAmount + 1) {
    return result('receipt_amount_unverified', 'The invoice balance cannot be verified. Review it in Tally before recovering CD.');
  }
  // Outstanding money means full payment has not met the requirement. A small
  // balance equal to a CD percentage is not proof that another discount is due.
  if (input.pendingAmount <= 0.005) {
    if (!receiptDate) return result('receipt_date_not_found', 'No linked receipt date proves payment against this invoice.');
    if (matchedReceiptAmount === null || !moneyClose(matchedReceiptAmount, input.originalAmount)) return result('receipt_amount_unverified', 'Linked receipts do not prove full payment of this invoice.');
    if (receiptDate <= requirement.deadline) return {...result('discount_taken_within_window', 'Full payment met the agreed RTGS requirement.'), reversalPlan: reversalPlan ? {...reversalPlan,activeDiscount:reversalPlan.initialDiscount,currentPayableAmount:input.originalAmount,totalReversalRequired:0} : null};
    return result('late_payment_discount_expired', 'Full payment arrived after the RTGS deadline. Recover the category CD separately from the settled invoice.');
  }
  if (input.today <= requirement.deadline) return result('within_eligibility_window', `Payment is required by ${requirement.deadline} (IST).`);
  return result('unpaid_discount_tier_expired', `The ${requirement.category === 'advance_rtgs' ? 'advance' : 'same-day'} payment requirement was missed. Recover the full ${requirement.ratePercent}% category discount and follow up for the remaining Tally balance.`);
}
