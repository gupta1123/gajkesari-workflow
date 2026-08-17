import assert from "node:assert/strict";
import test from "node:test";
import { correctRowsFromRunningBalance } from "./bank-statement-running-balance.mjs";

test("uses the opening balance to correct the first transaction direction", () => {
  const [row] = correctRowsFromRunningBalance(
    [{ description: "FIRST PAYMENT", debit_amount: null, credit_amount: 10000, balance_amount: 90000, category: "receipt", confidence: 0.7 }],
    { openingBalance: 100000 }
  );
  assert.equal(row.debit_amount, 10000);
  assert.equal(row.credit_amount, null);
  assert.equal(row.category, "payment");
  assert.equal(row.raw_payload.balanceCorrection.previousBalance, 100000);
});

test("does not guess the first-row direction when no opening balance was extracted", () => {
  const original = { description: "FIRST ROW", debit_amount: null, credit_amount: 10000, balance_amount: 90000, category: "receipt" };
  const [row] = correctRowsFromRunningBalance([original]);
  assert.equal(row, original);
});

test("continues validating later rows from the preceding running balance", () => {
  const rows = correctRowsFromRunningBalance([
    { description: "FIRST", debit_amount: 10000, credit_amount: null, balance_amount: 90000 },
    { description: "SECOND", debit_amount: 5000, credit_amount: null, balance_amount: 95000 },
  ]);
  assert.equal(rows[1].debit_amount, null);
  assert.equal(rows[1].credit_amount, 5000);
});
