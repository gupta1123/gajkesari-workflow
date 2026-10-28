import assert from "node:assert/strict";
import test from "node:test";
import { chunk, resolveScopedLedgers } from "./cash-discount-scope-ledgers.ts";

const groups = [
  { name: "Sundry Debtors", parent: "Current Assets" },
  { name: "Export Debtors", parent: "Sundry Debtors" },
  { name: "Staff Debtors", parent: "Sundry Debtors" },
  { name: "Sundry Creditors", parent: "Current Liabilities" },
];
const ledgers = [
  { name: "Alpha Traders", parent: "Sundry Debtors" },
  { name: "Beta Exports", parent: "Export Debtors" },
  { name: "Gamma Staff", parent: "Staff Debtors" },
  { name: "Supplier One", parent: "Sundry Creditors" },
  { name: "alpha   traders", parent: "Sundry Debtors" },
];
const scope = { mode: "automatic", selectedGroupNames: ["Sundry Debtors"], includeNestedGroups: true, excludedGroupNames: [], excludedLedgerNames: [] };
const names = (value) => value.map((ledger) => ledger.name);

test("includes nested debtor groups, drops creditors and duplicate names", () => {
  assert.deepEqual(names(resolveScopedLedgers({ groups, ledgers }, scope)), ["Alpha Traders", "Beta Exports", "Gamma Staff"]);
});
test("nested groups can be switched off", () => {
  assert.deepEqual(names(resolveScopedLedgers({ groups, ledgers }, { ...scope, includeNestedGroups: false })), ["Alpha Traders"]);
});
test("excluded groups and ledgers are removed", () => {
  const out = resolveScopedLedgers({ groups, ledgers }, { ...scope, excludedGroupNames: ["Staff Debtors"], excludedLedgerNames: ["Beta Exports"] });
  assert.deepEqual(names(out), ["Alpha Traders"]);
});
test("chunk splits into batches", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
