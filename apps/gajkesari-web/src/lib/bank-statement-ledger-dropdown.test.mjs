import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const page = await readFile(
  new URL("../components/bank-statements/BankStatementsPage.tsx", import.meta.url),
  "utf8"
);
const ast = ts.createSourceFile("BankStatementsPage.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function functionSource(name) {
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
  );
  assert.ok(declaration, `${name} should exist`);
  return declaration.getText(ast);
}

test("bank-ledger selection stays in the account mapping row and remains responsive", () => {
  assert.match(page, /Tally Ledger \/ inline bank-ledger selection/);
  assert.match(page, /sm:w-auto sm:min-w-\[300px\] sm:max-w-\[520px\]/);
  assert.match(page, /border-b border-\[#e5ddd0\] bg-transparent px-1 py-1/);
  assert.match(functionSource("LedgerSearchSelect"), /className="h-7 w-full/);
  assert.doesNotMatch(page, /Ledger Selection Mode/);
  assert.doesNotMatch(page, /border-y border-\[#e5ddd0\] bg-transparent px-1 py-2/);
});

test("ledger pickers close urgently without timer delays and defer parent updates", () => {
  const bankPicker = functionSource("LedgerSearchSelect");
  const transactionPicker = functionSource("LedgerReviewSelect");
  assert.doesNotMatch(bankPicker, /setTimeout/);
  assert.doesNotMatch(transactionPicker, /setTimeout/);
  assert.match(bankPicker, /startTransition/);
  assert.match(transactionPicker, /startTransition/);
});

test("transaction ledger picker retains combobox and listbox semantics", () => {
  const picker = functionSource("LedgerReviewSelect");
  for (const marker of [
    'aria-autocomplete="list"',
    'aria-haspopup="listbox"',
    'role="listbox"',
    'role="option"',
    "aria-activedescendant",
    "aria-selected",
  ]) assert.match(picker, new RegExp(marker));
});

test("large ledger lookup structures are cached instead of rebuilt per row", () => {
  assert.match(page, /const ledgerParentIndexCache = new WeakMap/);
  assert.match(page, /const ledgerMasterIndexCache = new WeakMap/);
  assert.match(page, /useDeferredValue\(query\)/);
});

test("opening the top bank-ledger replacement picker loads the full connector catalogue", () => {
  assert.match(page, /\(!bankLedgerChangeMode && editingLedgerIds\.size === 0\)/);
  assert.match(page, /operation: "local_ledger_catalogue"/);
  assert.match(page, /Loading all ledgers from the connector/);
  assert.match(page, /bankLedgerVerified \? "Matched" : bankLedgerManuallyConfirmed \? "Selected" : "Chosen"/);
});
