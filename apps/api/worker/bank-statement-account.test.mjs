import assert from "node:assert/strict";
import test from "node:test";

import {
  bankStatementAccountDiagnostics,
  combinedLedgerCatalogueDecision,
  extractAccountFromBankStatementMarkdown,
  extractBankStatementPeriodFromMarkdown,
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

test("reads a plain-text customer name without absorbing the address or other fields", () => {
  assert.equal(extractAccountFromBankStatementMarkdown(`Account Name: EXAMPLE STEELS PRIVATE LIMITED Customer Address: PLOT NO 18 MIDC City: JALNA`).accountHolderName, "EXAMPLE STEELS PRIVATE LIMITED");
  assert.equal(extractAccountFromBankStatementMarkdown(`Account holder: Solution Nyx Account: 42861007319 IFSC: SBIN0000456`).accountHolderName, "Solution Nyx");
});

test("reads the holder column in HDFC headers, preserving wrapped names", () => {
  const markdown = `|07352320000222|BRANCH ADDRESS|
|---|---|
|EXAMPLE STEELS AND ALLOYS|SHOPPING CENTRE|
|PVT LTD|BRANCH ROAD|
|ADDRESS|JALNA|
|F-18 ADDITIONAL MIDC|431203|

Account Number: 07352320000222 Currency: INR`;
  assert.equal(extractAccountFromBankStatementMarkdown(markdown).accountHolderName, "EXAMPLE STEELS AND ALLOYS PVT LTD");
});

test("reads Central Bank's explicit downloaded-by name without the timestamp", () => {
  assert.equal(extractAccountFromBankStatementMarkdown(`Central Bank of India Product type: C C General-Corporate
* Statement Downloaded By EXAMPLE STEELS PRIVATE on Sat Oct 24 11:04:18 IST 2026 Unless a constituent notifies the Bank ...`).accountHolderName, "EXAMPLE STEELS PRIVATE");
});

test("does not derive a holder or statement period from transaction narrations", () => {
  const markdown = `|Date|Description|Debit|Credit|Balance|
|---|---|---|---|---|
|24-Oct-26|Account Name: WRONG NAME Statement Period: 01-10-2026 to 24-10-2026|10||90|`;
  assert.equal(extractAccountFromBankStatementMarkdown(markdown).accountHolderName, "");
  assert.deepEqual(extractBankStatementPeriodFromMarkdown(markdown), { statementPeriodStart: null, statementPeriodEnd: null });
});

for (const [header, start, end] of [
  ["Statement of Account For Period: 23-Oct-2026 to 24-Oct-2026", "2026-10-23", "2026-10-24"],
  ["STATEMENT OF ACCOUNT from 23/10/2026 to 24/10/2026", "2026-10-23", "2026-10-24"],
  ["## Nominee : Statement Period : 01-10-2026 to 01-10-2026", "2026-10-01", "2026-10-01"],
  ["|Statement period|01 September 2026 - 30 September 2026|", "2026-09-01", "2026-09-30"],
  ["Period: 2026-10-01 to 2026-10-24", "2026-10-01", "2026-10-24"],
  ["Period: 31/02/2026 to 01/03/2026", null, null],
  ["Period: 24/10/2026 to 23/10/2026", null, null],
  ["Statement date: 24/10/2026", null, null],
]) {
  test(`reads only valid printed periods: ${header}`, () => {
    assert.deepEqual(extractBankStatementPeriodFromMarkdown(header), { statementPeriodStart: start, statementPeriodEnd: end });
  });
}

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
