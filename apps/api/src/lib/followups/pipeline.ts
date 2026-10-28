// Pure reminder-plan logic. No I/O, so every rule here is unit-tested.

export type ReminderUnit = "minutes" | "hours" | "days";
export type ReminderStage = {
  name: string;
  template: string;
  delay: number;
  every: number;
  unit: ReminderUnit;
  limit: number;
};
export type ReminderPlan = { name: string; stages: ReminderStage[] };

export type OpenBill = {
  referenceName?: string;
  voucherNumber?: string;
  invoiceDate?: string;
  pendingAmount?: number;
  originalAmount?: number;
};

export type VerificationOutcome = {
  status: "active" | "settled" | "review";
  outstanding: number | null;
  note: string | null;
};

const UNIT_MS: Record<ReminderUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** How long a live outstanding check stays valid before a send must re-check. */
export const VERIFICATION_TTL_MS = 5 * 60_000;

export function stageMs(stage: ReminderStage, field: "delay" | "every") {
  return stage[field] * UNIT_MS[stage.unit];
}

export function validateReminderPlan(value: unknown): ReminderPlan {
  const plan = value as ReminderPlan;
  if (
    !plan || typeof plan.name !== "string" || !plan.name.trim() || plan.name.length > 80 ||
    !Array.isArray(plan.stages) || !plan.stages.length || plan.stages.length > 8
  ) {
    throw new Error("Enter a name and between 1 and 8 stages.");
  }
  for (const stage of plan.stages) {
    if (
      !stage || typeof stage.name !== "string" || !stage.name.trim() || stage.name.length > 80 ||
      typeof stage.template !== "string" || !stage.template || stage.template.length > 120 ||
      !Object.hasOwn(UNIT_MS, stage.unit) ||
      !Number.isInteger(stage.delay) || stage.delay < 0 || stage.delay > 365 ||
      !Number.isInteger(stage.every) || stage.every < 1 || stage.every > 365 ||
      !Number.isInteger(stage.limit) || stage.limit < 1 || stage.limit > 100
    ) {
      throw new Error("Each stage needs a message, a valid interval, and a limit of 1–100 reminders.");
    }
  }
  return {
    name: plan.name.trim(),
    stages: plan.stages.map((s) => ({
      name: s.name.trim(), template: s.template, delay: s.delay, every: s.every, unit: s.unit, limit: s.limit,
    })),
  };
}

/** State after one accepted send. */
export function advanceReminder(stages: ReminderStage[], index: number, sent: number, now = Date.now()) {
  const stage = stages[index];
  if (!stage) throw new Error("Invalid pipeline stage.");
  if (sent + 1 < stage.limit) {
    return { stage_index: index, stage_sent: sent + 1, status: "active", next_due_at: new Date(now + stageMs(stage, "every")).toISOString() };
  }
  if (index + 1 < stages.length) {
    return { stage_index: index + 1, stage_sent: 0, status: "active", next_due_at: new Date(now + stageMs(stages[index + 1], "delay")).toISOString() };
  }
  return { stage_index: index, stage_sent: sent + 1, status: "finished", next_due_at: null };
}

/** When the first reminder of a new pipeline falls due. */
export function firstDueAt(stages: ReminderStage[], now = Date.now()) {
  return new Date(now + stageMs(stages[0], "delay")).toISOString();
}

/**
 * Decide what a live Tally read says about one invoice.
 *
 * The connector only lists OPEN bills. An invoice that is missing may have been
 * paid, but it may equally have been cancelled, renamed or adjusted, so absence
 * is never treated as settlement: it parks the reminder for a human ("review").
 * Only an open bill whose pending amount reached zero counts as settled.
 */
export function verificationOutcome(bills: OpenBill[], invoice: string, invoiceDate: string | null): VerificationOutcome {
  const matches = bills.filter(
    (b) => (b.referenceName === invoice || b.voucherNumber === invoice) && (!invoiceDate || b.invoiceDate === invoiceDate)
  );
  if (matches.length !== 1) {
    return {
      status: "review",
      outstanding: null,
      note: matches.length
        ? "Multiple matching bills. Review in Tally."
        : "No matching open bill. Check whether it was settled, adjusted or changed.",
    };
  }
  const bill = matches[0];
  const amount = bill.pendingAmount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new Error("Tally returned an invalid outstanding amount.");
  }
  const settled = amount <= 0.005;
  return {
    status: settled ? "settled" : "active",
    outstanding: Math.round(amount * 100) / 100,
    note: settled
      ? "Invoice settled. No further reminders will be sent."
      : typeof bill.originalAmount === "number" && bill.originalAmount > amount + 0.005
        ? "Part payment recorded. Reminders continue for the remaining balance."
        : null,
  };
}
