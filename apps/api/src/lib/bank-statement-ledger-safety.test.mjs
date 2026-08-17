import assert from "node:assert/strict";
import test from "node:test";

import {
  activeLedgerContains,
  activeLedgerNameSet,
  classifyPartyLedgerFromGroups,
  masterParentDescendsFromGroup,
  resolveCompanySuspenseLedgerName,
} from "./bank-statement-ledger-safety.ts";

test("an exact Suspense ledger wins over a ledger merely grouped under Suspense A/c", () => {
  assert.equal(
    resolveCompanySuspenseLedgerName([
      { name: "Temporary Difference", parent: "Suspense A/c" },
      { name: "Suspense", parent: "Suspense A/c" },
    ]),
    "Suspense"
  );
});

test("ambiguous non-canonical suspense ledgers fail closed", () => {
  assert.equal(
    resolveCompanySuspenseLedgerName([
      { name: "Temporary Difference", parent: "Suspense A/c" },
      { name: "Unidentified Receipts", parent: "Suspense A/c" },
    ]),
    null
  );
});

test("saved mappings can be validated against exact active ledger identities", () => {
  const names = activeLedgerNameSet([
    { name: "QA Electricity Charges", parent: "Indirect Expenses" },
  ]);
  assert.equal(activeLedgerContains(names, "QA Electricity Charges"), true);
  assert.equal(activeLedgerContains(names, "Deleted Electricity Ledger"), false);
});

test("master group ancestry recognizes nested bank and party groups", () => {
  const groups = [
    { name: "Bank Accounts", parent: "Current Assets" },
    { name: "Current Accounts", parent: "Bank Accounts" },
    { name: "Sundry Debtors", parent: "Current Assets" },
    { name: "Western Region Customers", parent: "Sundry Debtors" },
    { name: "Sundry Creditors", parent: "Current Liabilities" },
    { name: "Transport Vendors", parent: "Sundry Creditors" },
  ];

  assert.equal(masterParentDescendsFromGroup("Current Accounts", groups, "Bank Accounts"), true);
  assert.equal(
    classifyPartyLedgerFromGroups({ name: "Pune Steel Buyer", parent: "Western Region Customers" }, groups),
    "customer"
  );
  assert.equal(
    classifyPartyLedgerFromGroups({ name: "Road Carrier", parent: "Transport Vendors" }, groups),
    "supplier"
  );
});

test("master group ancestry fails closed when groups contain a cycle", () => {
  const groups = [
    { name: "Cycle A", parent: "Cycle B" },
    { name: "Cycle B", parent: "Cycle A" },
  ];

  assert.equal(masterParentDescendsFromGroup("Cycle A", groups, "Bank Accounts"), false);
});

