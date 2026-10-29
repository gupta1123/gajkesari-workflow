import assert from "node:assert/strict";
import test from "node:test";
import { invoiceListLine, reminderMessageValues, templateForRow } from "./messages.ts";

const inv = (n, date, amount) => ({ invoice: `INV/${n}`, invoice_date: date, outstanding: amount });

test("the invoice line lists oldest first on one line", () => {
  const line = invoiceListLine([
    inv(7, "2026-09-07", 700), inv(1, "2026-08-01", 60000), inv(2, "2026-08-02", 45000),
    inv(3, "2026-08-03", 300), inv(4, "2026-08-04", 400), inv(5, "2026-08-05", 500), inv(6, "2026-08-06", 600),
  ]);
  assert.ok(line.startsWith("INV/1 ₹60,000 (1 Aug); INV/2 ₹45,000 (2 Aug)"));
  assert.ok(line.endsWith("INV/7 ₹700 (7 Sept)"));
  assert.ok(!/[\n\t]| {5,}/.test(line));
});

test("a long list stops at 20 invoices and stays within the message budget", () => {
  const many = Array.from({ length: 30 }, (_, i) => inv(`GST/25-26/${String(i + 1).padStart(4, "0")}`, `2026-08-${String((i % 28) + 1).padStart(2, "0")}`, 100000 + i));
  const line = invoiceListLine(many);
  assert.match(line, /; and \d+ more$/);
  assert.ok(line.length <= 700, String(line.length));
  assert.ok(line.split("; ").length <= 21);
});

test("two or more invoices use the summary message, one falls back to the stage's own", () => {
  assert.equal(templateForRow({ invoices: [inv(1, null, 1), inv(2, null, 2)] }, "payment_reminder_v2"), "payment_reminder_summary");
  assert.equal(templateForRow({ invoices: [inv(1, null, 1)] }, "payment_reminder_v2"), "payment_reminder_v2");
  assert.equal(templateForRow({ invoices: null }, "payment_reminder_v2"), "payment_reminder_v2");
});

test("summary values carry the count and the total", () => {
  const values = reminderMessageValues({
    customer: "Shree", company_name: "Acme", invoice: "2 invoices", outstanding: 480000,
    invoices: [inv(1, "2026-08-01", 300000), inv(2, "2026-08-02", 180000)],
  });
  assert.equal(values.invoice_count, "2");
  assert.equal(values.outstanding, "4,80,000.00");
});
