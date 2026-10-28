import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocumentLocal, processBankStatementMarkdownLocal } from "./parser.mjs";

test("recovers statement details and validates a reverse-order HDFC summary against its opening", async () => {
  const markdown = `Account Name: EXAMPLE INDUSTRIES Customer Address: PLOT 18
Statement of Account For Period: 01-Oct-2026 to 24-Oct-2026
|Transaction Date|Description|Reference|Debit|Credit|Balance|
|---|---|---|---|---|---|
|24-Oct-2026|Receipt|REF2||25.00|-925.00|
|23-Oct-2026|Receipt|REF1||50.00|-950.00|

|Opening Balance|Debit Count|Credit Count|Total Debit|Total Credit|Closing Balance|
|---|---|---|---|---|---|
|-1000.00|0|2|0.00|75.00|-925.00|`;
  const result = await processBankStatementMarkdownLocal(markdown);
  assert.equal(result.parsed.account.accountHolderName, "EXAMPLE INDUSTRIES");
  assert.equal(result.parsed.statementPeriodStart, "2026-10-01");
  assert.equal(result.parsed.statementPeriodEnd, "2026-10-24");
  assert.equal(result.parsed.openingBalance, -1000);
  assert.equal(result.diagnostics.balanceValidation.checkedTransitions, 2);
  assert.equal(result.diagnostics.balanceValidation.valid, true);
  assert.deepEqual(result.diagnostics.statementDetails.warnings, []);
});

test("exposes missing statement details separately from valid transaction balances", async () => {
  const result = await processBankStatementMarkdownLocal(`Statement Period: 31/02/2026 to 01/03/2026
|Opening Balance|Debit Count|Credit Count|Closing Balance|
|---|---|---|---|
||1|0|90.00|

|Date|Description|Reference|Debit|Credit|Balance|
|---|---|---|---|---|---|
|24-Oct-2026|Payment|REF1|10.00||90.00|`);
  assert.equal(result.parsed.openingBalance, null);
  assert.equal(result.parsed.statementPeriodStart, null);
  assert.equal(result.diagnostics.statementDetails.warnings.length, 3);
});

test('Bank reference preserves cross-date UTR and numeric Suspense identity in normalized connector output', async () => {
 const markdown = `Opening balance 1000.00\n| Date | Transaction description | Bank reference | Debit (INR) | Credit (INR) | Balance (INR) |\n|---|---|---|---|---|---|\n|08-Oct-26|Payment to Deccan Sponge and Minerals|UTRAX261009006|506.66||493.34|\n|08-Oct-26|Credit from Suspense|123261009001||607.77|1101.11|`;
 const result = await processBankStatementMarkdownLocal(markdown);
 assert.deepEqual(result.parsed.transactions.map(row => row.reference_number), ['UTRAX261009006','123261009001']);
 assert.equal(result.parsed.transactions[0].raw_payload.sourceBankReference, 'UTRAX261009006');
 assert.equal(result.diagnostics.balanceValidation.status, 'verified');
});

test("parses CSV to Markdown by default", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gajkesari-anydoc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, "sales.csv");
  fs.writeFileSync(input, "Invoice,Amount\nINV-1,1250\n", "utf8");
  const result = await parseDocumentLocal({ filePath: input });
  assert.equal(result.outputFormat, "markdown");
  assert.match(result.content, /Invoice/);
  assert.match(result.content, /1250/);
  assert.equal(result.metadata.processing, "local");
  assert.equal(result.metadata.ocrUsed, false);
});

test("returns structured JSON for an RTF document", async () => {
  const bytes = Buffer.from(String.raw`{\rtf1\ansi{\b Quarterly Report}\par Revenue increased.}`);
  const result = await parseDocumentLocal({ bytes, fileName: "report.rtf", output: "json" });
  assert.equal(result.outputFormat, "json");
  assert.equal(result.metadata.structured, true);
  assert.ok(Array.isArray(result.content.blocks));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("rejects unknown output formats", async () => {
  await assert.rejects(
    parseDocumentLocal({ bytes: Buffer.from("a,b\n1,2"), fileName: "test.csv", output: "xml" }),
    /markdown.*json/i
  );
});

test("uses the backend worker logic for normalized bank-statement JSON", async () => {
  const markdown = `| Account Holder | Account Number | Bank Name |
|---|---|---|
| Solution Nyx | 8822014500 | ICICI Bank |

| Opening Balance | 1000.00 |
|---|---|
| Statement | 1000.00 |

| Transaction Date | Description | Reference | Debit | Credit | Balance |
|---|---|---|---|---|---|
| 01 Aug 2026 | NEFT CREDIT-NOVA ALLOY | REF001 | - | 200.00 | 1200.00 |
| 02 Aug 2026 | UPI DEBIT-METRO MART | REF002 | 50.00 | - | 1150.00 |`;
  const result = await processBankStatementMarkdownLocal(markdown, { pageCount: 2 });
  assert.equal(result.parsed.account.accountNumber, "8822014500");
  assert.equal(result.parsed.openingBalance, 1000);
  assert.equal(result.parsed.transactions.length, 2);
  assert.equal(result.parsed.transactions[0].credit_amount, 200);
  assert.equal(result.parsed.transactions[1].debit_amount, 50);
  assert.equal(result.parsed.transactions[0].raw_payload.extractionProvenance.method, "deterministic_anydoc");
  assert.equal(result.parsed.transactions[0].raw_payload.extractionProvenance.endPage, 2);
  assert.equal(result.diagnostics.balanceValidation.status, "verified");
});

test("falls back to canonical physical PDF columns when AnyDoc loses continuation tables", async () => {
  const markdown = `|Txn No.|Txn Date|Description|Dr Amount|Cr Amount|Balance|
|---|---|---|---|---|---|
|T1|03-09-2026|NRTGS DR Supplier|100.00||900.00 Dr.|
Page No 1 -
NRTGS/PUNBR wrapped continuation U123456 03-09-2026 50.00 950.00 Dr.`;
  await assert.rejects(
    () => processBankStatementMarkdownLocal(markdown),
    /could not be normalized deterministically/
  );
});

test('connector rejects a balanced partial extraction when the printed statement count disagrees',async()=>{
 const md='|Date|Description|Reference|Debit|Credit|Balance|\n|---|---|---|---|---|---|\n|24-Oct-2026|ANITA SINGH|REF001||50.00|1050.00|\n\n|Opening Balance|Debit Count|Credit Count|Total Debit|Total Credit|Closing Balance|\n|---|---|---|---|---|---|\n|1000.00|0|2|0.00|100.00|1100.00|';
 await assert.rejects(()=>processBankStatementMarkdownLocal(md),{code:'statement_summary_mismatch'});
});

test('physical date validation rejects invalid calendar dates instead of inventing an ISO date',async()=>{
 const physical={detected:true,layout:'generic_statement',rows:[{sourceDate:'31/02/2026',narration:'ANITA SINGH',reference:'001',creditAmount:50,debitAmount:null,balanceAmount:1050,page:1}],openingBalance:1000};
 await assert.rejects(()=>processBankStatementMarkdownLocal('',{physicalEvidence:physical}),{code:'statement_date_uncertain'});
});

test('image-only PDFs reach OCR and produce a review message rather than a native unsupported-input error',async()=>{
 const stream='q 595 0 0 842 0 0 cm /Im0 Do Q';
 const objects=[
  Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
  Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
  Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'),
  Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n'),Buffer.from([255,255,255]),Buffer.from('\nendstream')]),
  Buffer.from(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
 ];
 const parts=[Buffer.from('%PDF-1.4\n')],offsets=[];
 for(let i=0;i<objects.length;i++) {offsets.push(parts.reduce((n,p)=>n+p.length,0));parts.push(Buffer.from(`${i+1} 0 obj\n`),objects[i],Buffer.from('\nendobj\n'));}
 const xref=parts.reduce((n,p)=>n+p.length,0);
 parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
 await assert.rejects(()=>parseDocumentLocal({bytes:Buffer.concat(parts),fileName:'unreadable-scan.pdf',output:'json'}),{code:process.platform==='win32'?'ocr_review_required':'ocr_unavailable'});
});
