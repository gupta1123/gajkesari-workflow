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

test("does not rewrite explicit columns from ambiguous unsigned balances without an opening balance", () => {
  const rows = correctRowsFromRunningBalance([
    { description: "FIRST", debit_amount: 10000, credit_amount: null, balance_amount: 90000 },
    { description: "SECOND", debit_amount: 5000, credit_amount: null, balance_amount: 95000 },
  ]);
  assert.equal(rows[1].debit_amount, 5000);
  assert.equal(rows[1].credit_amount, null);
  assert.equal(rows[1].raw_payload, undefined);
});

test("preserves Central Bank DR statement columns when balances are signed", () => {
  const rows = correctRowsFromRunningBalance([
    { description: "FIRST CREDIT", debit_amount: null, credit_amount: 855079, balance_amount: -390562086.57 },
    { description: "SECOND CREDIT", debit_amount: null, credit_amount: 853667, balance_amount: -389708419.57 },
    { description: "FOLLOWING DEBIT", debit_amount: 27500000, credit_amount: null, balance_amount: -414514264.57 },
  ]);
  assert.equal(rows[1].debit_amount, null);
  assert.equal(rows[1].credit_amount, 853667);
  assert.equal(rows[2].debit_amount, 27500000);
  assert.equal(rows[2].credit_amount, null);
});

test("corrects a swapped column when signed DR balances prove the direction", () => {
  const rows = correctRowsFromRunningBalance([
    { description: "FIRST CREDIT", debit_amount: null, credit_amount: 855079, balance_amount: -390562086.57 },
    { description: "SECOND CREDIT", debit_amount: 853667, credit_amount: null, balance_amount: -389708419.57 },
  ]);
  assert.equal(rows[1].debit_amount, null);
  assert.equal(rows[1].credit_amount, 853667);
  assert.equal(rows[1].raw_payload.balanceCorrection.previousBalance, -390562086.57);
});
