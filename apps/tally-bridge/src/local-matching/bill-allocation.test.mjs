import test from "node:test";
import assert from "node:assert/strict";
import { planChronologicalBillAllocations } from "./bill-allocation.mjs";

test("plans same-ledger transactions chronologically without reusing consumed bill value", () => {
  const plans = planChronologicalBillAllocations({
    transactions: [
      { transactionId: "later", voucherDate: "2026-05-02", amount: 70, counterpartyLedgerName: "Acme" },
      { transactionId: "first", voucherDate: "2026-05-01", amount: 60, counterpartyLedgerName: "Acme" },
    ],
    verificationRows: [{ transactionId: "first", verificationStatus: "missing" }, { transactionId: "later", verificationStatus: "missing" }],
    openBillsByLedger: { Acme: { complete: true, openBills: [{ referenceName: "A-1", pendingAmount: 100 }], existingAdvances: [] } },
  });
  assert.equal(plans.first.allocations[0].allocatedAmount, 60);
  assert.equal(plans.later.allocations[0].allocatedAmount, 40);
  assert.equal(plans.later.newAdvanceAmount, 30);
});

test("does not auto-plan a ledger with existing advances", () => {
  const plans = planChronologicalBillAllocations({
    transactions: [{ transactionId: "t1", voucherDate: "2026-05-01", amount: 50, counterpartyLedgerName: "Acme" }],
    verificationRows: [{ transactionId: "t1", verificationStatus: "missing" }],
    openBillsByLedger: { Acme: { complete: true, openBills: [], existingAdvances: [{ referenceName: "ADV" }] } },
  });
  assert.deepEqual(plans, {});
});

test("prefers the longest visible bill reference when another bill is its prefix", () => {
  const ledgerName = "Acme";
  const plans = planChronologicalBillAllocations({
    transactions: [{
      transactionId: "t1",
      voucherDate: "2026-09-01",
      amount: 10_000,
      counterpartyLedgerName: ledgerName,
      narration: "AGAINST GKS-OB-SEP26-01-01 NEFT CR FROM ACME",
    }],
    verificationRows: [{ transactionId: "t1", verificationStatus: "missing" }],
    openBillsByLedger: {
      [ledgerName]: {
        complete: true,
        openBills: [
          { referenceName: "OLD-BILL", pendingAmount: 99_000, invoiceDate: "2026-07-01" },
          { referenceName: "GKS-OB-SEP26-01", pendingAmount: 20_000, invoiceDate: "2026-08-31" },
          { referenceName: "GKS-OB-SEP26-01-01", pendingAmount: 10_000, invoiceDate: "2026-08-31" },
        ],
        existingAdvances: [],
      },
    },
  });
  assert.equal(plans.t1.allocations[0].referenceName, "GKS-OB-SEP26-01-01");
});
