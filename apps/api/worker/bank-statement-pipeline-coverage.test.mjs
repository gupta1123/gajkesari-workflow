import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {extractBankStatementMarkdownAmounts,reconcileBankStatementMarkdownAmounts} from './bank-statement-markdown-amounts.mjs';
import {recoverSourceCoverage,sourceDate} from './bank-statement-source-coverage.mjs';
const file=await readFile(new URL('./process-packet-jobs.mjs',import.meta.url),'utf8');
const start=file.indexOf('async function extractBankStatementAdaptive(');
const end=file.indexOf('\nasync function updateBankJob(',start);
assert.ok(start>=0&&end>start);
const code=file.slice(start,end).trim();
const markdown=`|Transaction Date|Reference No.|Debit|Credit|Balance|
|---|---|---|---|---|
|03-Sep-2026|A||100|1100|
|03-Sep-2026|B|50||1050|`;
const rows=extractBankStatementMarkdownAmounts(markdown,{includeSourceDetails:true}).rows;
const tx=r=>({reference_number:r.reference,transaction_date:sourceDate(r.sourceDate),debit_amount:r.debitAmount,credit_amount:r.creditAmount,balance_amount:r.balanceAmount});
function setup(fail=false){
  const calls=[],stages=[];
  const scope={BANK_STATEMENT_BATCH_PAGE_SIZE:1,BANK_STATEMENT_BATCH_CONCURRENCY:4,BANK_STATEMENT_ANYDOC_ENABLED:true,
    OPENROUTER_ANYDOC_MODEL:'fixture',OPENROUTER_ANYDOC_REASONING_TOKENS:0,OPENROUTER_ANYDOC_MAX_OUTPUT_TOKENS:1000,
    readBankStatementPdfPageCount:async()=>2,updateBankJob:async(_,s)=>stages.push(s.stage),
    parseWithAnydoc:async()=>({success:true,markdownText:markdown,executionTimeMs:1,tableCount:1}),
    hasUsableBankStatementText:()=>true,combinedLedgerCatalogueDecision:()=>({useCombined:true}),
    extractAndMatchBankStatementFromMarkdown:()=>{throw Error('Must not match ledgers before coverage');},
    extractBankStatementFromText:async(_file,pages)=>{calls.push(pages[0].text);return {account:{},transactions:calls.length===1?[tx(rows[0])]:fail?[]:[tx(rows[1])]};},
    extractAccountFromBankStatementMarkdown:()=>({}),mergeBankStatementAccount:()=>({}),bankStatementAccountDiagnostics:()=>({}),
    extractBankStatementMarkdownAmounts,reconcileBankStatementMarkdownAmounts,recoverSourceCoverage,
    addBankStatementPageProvenance:r=>r,diagnosticError:()=> 'fixture-error',console,
  };
  return {run:vm.runInNewContext(`(${code})`,scope),calls,stages};
}
test('actual adaptive Markdown path recovers before returning complete',async()=>{
  const s=setup();const r=await s.run({fileName:'test.pdf',isPdf:true,bytes:new Uint8Array(),jobId:'fixture'});
  assert.equal(r.diagnostics.coverageComplete,true);assert.equal(r.parsed.transactions.length,2);
  assert.equal(s.calls.length,2);assert.doesNotMatch(s.calls[1],/\|A\|/);
  assert.ok(s.stages.includes('Recovering missing statement rows'));
});
test('failed targeted recovery returns an incomplete preview, not a whole-document retry',async()=>{
  const s=setup(true);const r=await s.run({fileName:'test.pdf',isPdf:true,bytes:new Uint8Array(),jobId:'fixture'});
  assert.equal(r.diagnostics.coverageComplete,false);assert.equal(r.parsed.transactions.length,1);
  assert.equal(s.calls.length,2);assert.match(r.extractionError,/coverage/);
});
