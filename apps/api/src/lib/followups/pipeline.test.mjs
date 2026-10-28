import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceReminder, customerOutcome, firstDueAt, validateReminderPlan, verificationOutcome,
} from "./pipeline.ts";

const stage = (over = {}) => ({ name: "Gentle", template: "payment_reminder", delay: 1, every: 2, unit: "days", limit: 2, ...over });

test("a valid plan is trimmed and an invalid one is rejected", () => {
  const plan = validateReminderPlan({ name: " Standard ", stages: [stage()] });
  assert.equal(plan.name, "Standard");
  assert.throws(() => validateReminderPlan({ name: "x", stages: [] }));
  assert.throws(() => validateReminderPlan({ name: "x", stages: [stage({ unit: "weeks" })] }));
  assert.throws(() => validateReminderPlan({ name: "x", stages: [stage({ limit: 0 })] }));
  assert.throws(() => validateReminderPlan({ name: "x", stages: [stage({ unit: "toString" })] }));
});

test("advancing repeats a stage, then moves on, then finishes", () => {
  const stages = [stage(), stage({ name: "Firm", delay: 3, limit: 1 })];
  const now = Date.UTC(2026, 0, 1);
  const first = advanceReminder(stages, 0, 0, now);
  assert.deepEqual([first.stage_index, first.stage_sent, first.status], [0, 1, "active"]);
  assert.equal(first.next_due_at, new Date(now + 2 * 86_400_000).toISOString());
  const second = advanceReminder(stages, 0, 1, now);
  assert.deepEqual([second.stage_index, second.stage_sent], [1, 0]);
  assert.equal(second.next_due_at, new Date(now + 3 * 86_400_000).toISOString());
  const last = advanceReminder(stages, 1, 0, now);
  assert.deepEqual([last.status, last.next_due_at], ["finished", null]);
});

test("the first reminder is due after the first stage delay", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(firstDueAt([stage({ delay: 0 })], now), new Date(now).toISOString());
});

test("an open bill with a balance stays active and reports the pending amount", () => {
  const out = verificationOutcome(
    [{ referenceName: "INV-1", invoiceDate: "2026-01-01", pendingAmount: 400, originalAmount: 1000 }],
    "INV-1", "2026-01-01"
  );
  assert.equal(out.status, "active");
  assert.equal(out.outstanding, 400);
  assert.match(out.note, /Part payment/);
});

test("a zero pending amount is settled", () => {
  const out = verificationOutcome([{ voucherNumber: "INV-2", invoiceDate: "2026-01-01", pendingAmount: 0 }], "INV-2", "2026-01-01");
  assert.equal(out.status, "settled");
});

test("a missing bill is never treated as paid", () => {
  const out = verificationOutcome([], "INV-3", "2026-01-01");
  assert.equal(out.status, "review");
  assert.equal(out.outstanding, null);
});

test("duplicate matching bills need review and a corrupt amount throws", () => {
  const bill = { referenceName: "INV-4", invoiceDate: "2026-01-01", pendingAmount: 10 };
  assert.equal(verificationOutcome([bill, bill], "INV-4", "2026-01-01").status, "review");
  assert.throws(() => verificationOutcome([{ ...bill, pendingAmount: -5 }], "INV-4", "2026-01-01"));
  assert.throws(() => verificationOutcome([{ ...bill, pendingAmount: Number.NaN }], "INV-4", "2026-01-01"));
});

test("a customer reminder lists only the invoices still open, with fresh balances", () => {
  const bills = [
    { referenceName: "A1", invoiceDate: "2026-08-01", pendingAmount: 400, originalAmount: 1000 },
    { referenceName: "A2", invoiceDate: "2026-08-05", pendingAmount: 0, originalAmount: 500 },
  ];
  const tracked = [
    { invoice: "A1", invoice_date: "2026-08-01", outstanding: 1000 },
    { invoice: "A2", invoice_date: "2026-08-05", outstanding: 500 },
    { invoice: "A3", invoice_date: "2026-08-09", outstanding: 700 },
  ];
  const result = customerOutcome(bills, tracked);
  assert.equal(result.status, "active");
  assert.equal(result.outstanding, 400);
  assert.deepEqual(result.invoices.map((i) => i.invoice), ["A1"]);
  assert.match(result.note, /2 invoices left out/);
});

test("a customer reminder settles when every invoice is paid and parks when they cannot be found", () => {
  const paid = [{ referenceName: "A1", invoiceDate: "2026-08-01", pendingAmount: 0 }];
  assert.equal(customerOutcome(paid, [{ invoice: "A1", invoice_date: "2026-08-01", outstanding: 10 }]).status, "settled");
  assert.equal(customerOutcome([], [{ invoice: "A1", invoice_date: "2026-08-01", outstanding: 10 }]).status, "review");
});
