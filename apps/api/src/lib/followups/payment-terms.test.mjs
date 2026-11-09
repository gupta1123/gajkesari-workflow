import assert from "node:assert/strict";
import test from "node:test";
import { classifyPaymentNarration, collectionPaymentRequirement, paymentRequirement } from "./payment-terms.ts";
import { derivePaymentFollowUpTiming, sortByFollowUpPriority } from "./payment-follow-up.ts";

test("only the two agreed phrases classify an invoice", () => {
  assert.equal(classifyPaymentNarration("MH14-KY-5700 ADVANCE RTGS").category, "advance_rtgs");
  assert.equal(classifyPaymentNarration("mh43 same day r.t.g.s").category, "same_day_rtgs");
  for (const text of ["PAYMENT WITHIN 25 DAYS", "Cash discount 1.5% and 1%", "ADVANCE PAYMENT", "NOTADVANCE RTGS", "", null]) {
    assert.equal(classifyPaymentNarration(text).category, null, String(text));
  }
});

test("both phrases together are ambiguous, and a recovery voucher never classifies", () => {
  assert.deepEqual(classifyPaymentNarration("ADVANCE RTGS / SAME DAY RTGS"), { category: null, ambiguous: true });
  assert.equal(classifyPaymentNarration("Cash discount recovery against invoice INV. Source narration: ADVANCE RTGS").category, null);
  assert.equal(collectionPaymentRequirement("ADVANCE RTGS SAME DAY RTGS", "2026-10-12"), null);
});

test("advance RTGS is 1.5% by the day before the invoice, same day is 1% on the invoice date", () => {
  const advance = paymentRequirement("advance_rtgs", "2026-10-12");
  assert.equal(advance.ratePercent, 1.5);
  assert.equal(advance.deadline, "2026-10-11");
  const same = paymentRequirement("same_day_rtgs", "2026-10-12");
  assert.equal(same.ratePercent, 1);
  assert.equal(same.deadline, "2026-10-12");
  assert.equal(same.followUpStartsAt, new Date("2026-10-13T00:00:00+05:30").toISOString());
});

test("an invoice with no RTGS phrase falls back to 30 days and bad dates give no requirement", () => {
  assert.equal(collectionPaymentRequirement("", "2026-10-12").deadline, "2026-11-11");
  assert.equal(paymentRequirement("same_day_rtgs", "2026-02-30"), null);
});

test("follow-up becomes eligible only after the deadline", () => {
  const bill = { narration: "SAME DAY RTGS", invoiceDate: "2026-10-12" };
  assert.equal(derivePaymentFollowUpTiming(bill, "2026-10-12").eligible, false);
  const late = derivePaymentFollowUpTiming(bill, "2026-10-15");
  assert.deepEqual([late.eligible, late.ageDays, late.ageLabel], [true, 3, "3 days overdue"]);
  const unknown = derivePaymentFollowUpTiming({ narration: "ADVANCE RTGS SAME DAY RTGS", invoiceDate: "2026-10-12" }, "2026-10-15");
  assert.deepEqual([unknown.eligible, unknown.ageBasis], [true, "missing_dates"]);
  assert.equal(derivePaymentFollowUpTiming(bill, "garbage").eligible, false);
});

test("priority is oldest, then largest, then name", () => {
  const rows = [
    { ageDays: 5, outstandingAmount: 100, partyLedgerName: "B" },
    { ageDays: 9, outstandingAmount: 10, partyLedgerName: "C" },
    { ageDays: 5, outstandingAmount: 100, partyLedgerName: "A" },
    { ageDays: null, outstandingAmount: 999, partyLedgerName: "D" },
  ];
  assert.deepEqual(sortByFollowUpPriority(rows).map((r) => r.partyLedgerName), ["C", "A", "B", "D"]);
});
