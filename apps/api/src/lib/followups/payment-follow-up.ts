import { collectionPaymentRequirement, validPaymentDate } from "./payment-terms.ts";

export type PaymentFollowUpTiming = {
  eligible: boolean;
  ageBasis: "due_date" | "missing_dates";
  ageDays: number | null;
  ageLabel: string;
  dueDate: string | null;
  invoiceDate: string | null;
};

function elapsedDays(fromDate: string, toDate: string) {
  return Math.floor((Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) / 86_400_000);
}

/** Follow-up starts the day after the payment deadline implied by the narration. */
export function derivePaymentFollowUpTiming(
  bill: { narration?: string | null; invoiceDate?: string | null },
  today: string
): PaymentFollowUpTiming {
  const currentDate = validPaymentDate(today);
  const invoiceDate = validPaymentDate(bill.invoiceDate);
  if (!currentDate) {
    return { eligible: false, ageBasis: "missing_dates", ageDays: null, ageLabel: "Current business date unavailable", dueDate: null, invoiceDate };
  }
  const requirement = collectionPaymentRequirement(bill.narration, invoiceDate);
  if (!requirement) {
    return { eligible: true, ageBasis: "missing_dates", ageDays: null, ageLabel: "Invoice date or payment terms need review", dueDate: null, invoiceDate };
  }
  const ageDays = elapsedDays(requirement.deadline, currentDate);
  const shown = Math.max(ageDays, 0);
  return {
    eligible: ageDays > 0,
    ageBasis: "due_date",
    ageDays,
    ageLabel: `${shown} day${shown === 1 ? "" : "s"} overdue`,
    dueDate: requirement.deadline,
    invoiceDate,
  };
}

export function sortByFollowUpPriority<T extends { ageDays: number | null; outstandingAmount: number; partyLedgerName: string }>(rows: T[]) {
  return [...rows].sort(
    (a, b) =>
      (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
      b.outstandingAmount - a.outstandingAmount ||
      a.partyLedgerName.localeCompare(b.partyLedgerName)
  );
}
