import assert from "node:assert/strict";
import test from "node:test";

import {
  bankStatementAccountDiagnostics,
  combinedLedgerCatalogueDecision,
  extractAccountFromBankStatementMarkdown,
  mergeBankStatementAccount,
} from "./bank-statement-account.mjs";

test("recovers the latest Axis statement identity from AnyDoc Markdown", () => {
  const markdown = `# AXIS BANK ONE DAY STATEMENT

|Account statement-generated for bank statement workflow testing||
|---|---|
|Account holder|Statement account|
|Solution Nyx|Axis Bank - 7440012233|

|DATE|TRANSACTION DETAILS|REFERENCE|WITHDRAWAL|DEPOSIT|BALANCE|`;

  assert.deepEqual(extractAccountFromBankStatementMarkdown(markdown), {
    bankName: "Axis Bank",
    accountNumber: "7440012233",
    accountHolderName: "Solution Nyx",
    ifscCode: "",
  });
});

test("recovers explicit account and IFSC fields from a key-value table", () => {
  const markdown = `|Bank Name|Account No.|Account Holder Name|IFSC Code|
|---|---|---|---|
|State Bank of India|4286 1007 319|GAJKESARI STEELS|SBIN0001234|`;
  assert.deepEqual(extractAccountFromBankStatementMarkdown(markdown), {
    bankName: "State Bank of India",
    accountNumber: "42861007319",
    accountHolderName: "GAJKESARI STEELS",
    ifscCode: "SBIN0001234",
  });
});

test("keeps AI values and fills only missing account fields from Markdown", () => {
  assert.deepEqual(
    mergeBankStatementAccount(
      { bankName: "AXIS BANK", accountNumber: null, accountHolderName: null, ifscCode: null },
      { bankName: "Axis Bank", accountNumber: "7440012233", accountHolderName: "Solution Nyx", ifscCode: "" }
    ),
    { bankName: "AXIS BANK", accountNumber: "7440012233", accountHolderName: "Solution Nyx", ifscCode: null }
  );
});

test("routes oversized ledger catalogues away from combined extraction", () => {
  assert.equal(combinedLedgerCatalogueDecision(["Cash", "Sales"]).useCombined, true);
  const largeCatalogue = Array.from({ length: 1_001 }, (_, index) => `Ledger ${index}`);
  const decision = combinedLedgerCatalogueDecision(largeCatalogue);
  assert.equal(decision.useCombined, false);
  assert.equal(decision.reason, "ledger_catalogue_too_large");
});

test("reports missing identity separately from optional holder and IFSC fields", () => {
  assert.deepEqual(bankStatementAccountDiagnostics({ bankName: null, accountNumber: null }), {
    fields: { bankName: false, accountNumber: false, accountHolderName: false, ifscCode: false },
    hasIdentity: false,
    hasAccountNumber: false,
    recoveredFromMarkdown: false,
  });
});

test("extracts identity from same-row AnyDoc key/value cells", () => {
  const markdown = `# STATE BANK OF INDIA
|Account holder|Solution Nyx|Statement date|16 Aug 2026|
|Account number|42861007319|Statement period|16 Aug 2026 to 16 Aug 2026|
|Account type|Current Account|Branch / IFSC|Nagpur MIDC / SBIN0000456|
|Txn date|Description|Debit|Credit|Balance|`;
  const result = extractAccountFromBankStatementMarkdown(markdown);
  assert.equal(result.bankName, "State Bank of India");
  assert.equal(result.accountNumber, "42861007319");
  assert.equal(result.accountHolderName, "Solution Nyx");
});

test("extracts bank title and a bare Account label", () => {
  const markdown = `## State Bank of India - Current Account Statement
Account holder: Solution Nyx Account: 42861007319 IFSC: SBIN0000456 Page 1 of 1`;
  const result = extractAccountFromBankStatementMarkdown(markdown);
  assert.equal(result.bankName, "State Bank of India");
  assert.equal(result.accountNumber, "42861007319");
});

test("prefers an explicit ledger over a mimicked layout name", () => {
  const markdown = `# PNB-STYLE LAYOUT | SYNTHETIC TEST STATEMENT
Bank / Tally Ledger: Axis Bank - 7440012233
Account Statement for Account Number 7440012233`;
  const result = extractAccountFromBankStatementMarkdown(markdown);
  assert.equal(result.bankName, "Axis Bank");
  assert.equal(result.accountNumber, "7440012233");
});

test("uses the IFSC prefix when the logo name is absent from Markdown", () => {
  const markdown = `# Account Statement for Account Number 0981008700020850
Branch Name: AURANGABAD IFSC Code: PUNB0098100
|Txn Date|Description|Dr Amount|Cr Amount|Balance|`;
  const result = extractAccountFromBankStatementMarkdown(markdown);
  assert.equal(result.bankName, "Punjab National Bank");
  assert.equal(result.accountNumber, "0981008700020850");
});
