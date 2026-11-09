import assert from "node:assert/strict";
import test from "node:test";
import { buildFollowUpCandidates, ledgersOutsideScope, normalizeLedgerNames } from "./candidates.ts";

test("ledger names are trimmed, de-duplicated case-insensitively and bounded", () => {
  assert.deepEqual(normalizeLedgerNames([" Acme  Ltd ", "acme ltd", "", null, "Beta"], 10), ["Acme Ltd", "Beta"]);
  assert.deepEqual(normalizeLedgerNames(["a", "b", "c"], 2), ["a", "b"]);
  assert.deepEqual(normalizeLedgerNames("not a list", 5), []);
});

test("a request outside the saved scope is detected regardless of case", () => {
  assert.deepEqual(ledgersOutsideScope(["ACME ltd", "Gamma"], ["Acme Ltd", "Beta"]), ["Gamma"]);
});

test("candidates skip advances and paid bills, then sort oldest first", () => {
  const rows = buildFollowUpCandidates({
    Acme: { openBills: [
      { kind: "bill", referenceName: "A-1", invoiceDate: "2026-10-01", pendingAmount: 500, originalAmount: 500, narration: "SAME DAY RTGS" },
      { kind: "advance", referenceName: "ADV-1", pendingAdvanceAmount: 90 },
      { kind: "bill", referenceName: "A-2", invoiceDate: "2026-10-01", pendingAmount: 0 },
    ] },
    Beta: { openBills: [{ kind: "bill", referenceName: "B-1", invoiceDate: "2026-10-08", pendingAmount: 900, narration: "" }] },
    Empty: undefined,
  }, "2026-10-20");
  assert.deepEqual(rows.map((r) => r.invoice), ["A-1", "B-1"]);
  assert.equal(rows[0].paymentCategory, "same_day_rtgs");
  assert.equal(rows[0].ageDays, 19);
  assert.equal(rows[0].eligible, true);
  assert.equal(rows[1].paymentCategory, null);
});

test("an invoice still inside its payment window is not yet eligible", () => {
  const [row] = buildFollowUpCandidates(
    { Acme: { openBills: [{ kind: "bill", referenceName: "A-9", invoiceDate: "2026-10-20", pendingAmount: 100, narration: "ADVANCE RTGS" }] } },
    "2026-10-20"
  );
  assert.equal(row.eligible, true); // advance RTGS was due the day before the invoice
  const [fresh] = buildFollowUpCandidates(
    { Acme: { openBills: [{ kind: "bill", referenceName: "A-8", invoiceDate: "2026-10-20", pendingAmount: 100, narration: "SAME DAY RTGS" }] } },
    "2026-10-20"
  );
  assert.equal(fresh.eligible, false);
});
