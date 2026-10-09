import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {extractBankStatementMarkdownAmounts,reconcileBankStatementMarkdownAmounts,restoreSourceBankReferences} from './bank-statement-markdown-amounts.mjs';
import {auditSourceCoverage,recoverSourceCoverage,sourceDate} from './bank-statement-source-coverage.mjs';
import { deterministicTransactionsFromAnydoc } from './bank-statement-deterministic.mjs';
import { validateRunningBalanceContinuity } from './bank-statement-running-balance.mjs';
const file=await readFile(new URL('./process-packet-jobs.mjs',import.meta.url),'utf8');
const start=file.indexOf('async function extractBankStatementAdaptive(');
const end=file.indexOf('\nasync function updateBankJob(',start);
assert.ok(start>=0&&end>start);
const code=file.slice(start,end).trim();
const markdown=`|Transaction Date|Remarks|Reference No.|Debit|Credit|Balance|
|---|---|---|---|---|---|
|03-Sep-2026|First receipt|A||100|1100|
|03-Sep-2026|Second payment|B|50||1050|`;
const rows=extractBankStatementMarkdownAmounts(markdown,{includeSourceDetails:true}).rows;
const tx=r=>({reference_number:r.reference,transaction_date:sourceDate(r.sourceDate),description:r.narration,debit_amount:r.debitAmount,credit_amount:r.creditAmount,balance_amount:r.balanceAmount});
function setup(fail=false, overrides={}){
  const calls=[],stages=[];
  const scope={BANK_STATEMENT_BATCH_PAGE_SIZE:1,BANK_STATEMENT_BATCH_CONCURRENCY:4,BANK_STATEMENT_ANYDOC_ENABLED:true,
    BANK_STATEMENT_SOURCE_COVERAGE_VERIFIER_ENABLED:false,
    BANK_STATEMENT_MAX_TOTAL_PAGES:300,
    OPENROUTER_ANYDOC_MODEL:'fixture',OPENROUTER_ANYDOC_REASONING_TOKENS:0,OPENROUTER_ANYDOC_MAX_OUTPUT_TOKENS:1000,
    readBankStatementPdfPageCount:async()=>2,updateBankJob:async(_,s)=>stages.push(s.stage),
    parseWithAnydoc:async()=>({success:true,markdownText:markdown,executionTimeMs:1,tableCount:1}),
    deterministicTransactionsFromAnydoc:()=>null,
    hasUsableBankStatementText:()=>true,combinedLedgerCatalogueDecision:()=>({useCombined:true}),
    extractAndMatchBankStatementFromMarkdown:()=>{throw Error('Must not match ledgers before coverage');},
    extractBankStatementFromText:async(_file,pages)=>{calls.push(pages[0].text);return {account:{},transactions:calls.length===1?[tx(rows[0])]:fail?[]:[tx(rows[1])]};},
    extractAccountFromBankStatementMarkdown:()=>({}),mergeBankStatementAccount:()=>({}),bankStatementAccountDiagnostics:()=>({}),
    extractBankStatementMarkdownAmounts,reconcileBankStatementMarkdownAmounts,restoreSourceBankReferences,auditSourceCoverage,recoverSourceCoverage,sourceDate,
    normalizeAiBankStatement:value=>({account:{bankName:null,accountNumber:null,accountHolderName:null,ifscCode:null},transactions:[],...value}),
    addBankStatementPageProvenance:r=>r,diagnosticError:error=>error?.message||String(error),lastItem:items=>items.at(-1),console,
    ...overrides,
  };
  return {run:vm.runInNewContext(`(${code})`,scope),calls,stages};
}

test('invalid sparse continuation uses complete physical source rows without AI or lost references', async () => {
 const sparse = `Opening balance 1000.00\n| Date | Transaction description | Bank reference | Debit (INR) | Credit (INR) | Balance (INR) |\n|---|---|---|---|---|---|\n|08-Oct-26|First receipt|UTR123456||100.00|1100.00|\n\n| Date | Transaction description | Bank reference | Balance (INR) | |\n|---|---|---|---|---|\n|09-Oct-26|Second receipt|UTR123457|50.00|1150.00|`;
 const physicalRows = [
  { sourceDate:'08-Oct-26', narration:'First receipt', reference:'UTR123456', debitAmount:null, creditAmount:100, balanceAmount:1100, page:1 },
  { sourceDate:'09-Oct-26', narration:'Second receipt', reference:'UTR123457', debitAmount:null, creditAmount:50, balanceAmount:1150, page:2 },
 ];
 let physicalReads=0;
 const s=setup(false,{ parseWithAnydoc:async()=>({success:true,markdownText:sparse}), deterministicTransactionsFromAnydoc,
  validateRunningBalanceContinuity, PDFJS_WORKER_SRC:null,
  readBankStatementPhysicalColumns:async()=>{physicalReads++;return {detected:true,layout:'generic_statement',rows:physicalRows};} });
 const r=await s.run({fileName:'test.pdf',isPdf:true,bytes:new Uint8Array(),jobId:'fixture'});
 assert.equal(physicalReads,1);
 assert.equal(s.calls.length,0);
 assert.equal(r.diagnostics.coverageComplete,true);
 assert.equal(r.parsed.transactions.length,2);
 assert.equal(r.parsed.transactions[1].credit_amount,50);
 assert.equal(r.parsed.transactions[1].reference_number,'UTR123457');
 assert.equal(r.parsed.transactions[1].transaction_date,'2026-10-09');
});
test('disabled source verifier accepts the AnyDoc extraction without recovery',async()=>{
  const s=setup();const r=await s.run({fileName:'test.pdf',isPdf:true,bytes:new Uint8Array(),jobId:'fixture'});
  assert.equal(r.diagnostics.coverageComplete,true);assert.equal(r.parsed.transactions.length,1);
  assert.equal(s.calls.length,1);
  assert.equal(r.diagnostics.anydoc.sourceCoverage.skipped,true);
  assert.equal(r.diagnostics.anydoc.sourceCoverage.reason,'source_coverage_verifier_disabled');
  assert.ok(!s.stages.includes('Recovering missing statement rows'));
});
test('disabled source verifier does not invoke targeted recovery',async()=>{
  const s=setup(true);const r=await s.run({fileName:'test.pdf',isPdf:true,bytes:new Uint8Array(),jobId:'fixture'});
  assert.equal(r.diagnostics.coverageComplete,true);assert.equal(r.parsed.transactions.length,1);
  assert.equal(s.calls.length,1);assert.equal(r.extractionError,null);
});
