import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { summarizeStatementPostings, resolveStatementPostings, savedPostingPresence,
  savedPostingOutcome, markPreviouslyConfirmedPostings, postingFooterSegments, buildStatementBankBook, mergeCompletedPostingEvidence } from './statement-bank-book.ts';
import { bankPostingMessage, bankPostingTitle } from '@gajkesari/shared/lib/bank-posting-outcome';

const rows = [1371.25,1371.25,1371.25,2382.5,2382.5,3493.75].map((amount,i)=>({
  id:`preview-${i}`,transactionDate:'2026-10-25',description:`Payment ${i}`,debitAmount:amount,
  referenceNumber:i===1||i===2?'':`UTR-${i}`,balanceAmount:100000-i*5000,selectedLedgerName:`Supplier ${i}`,
}));
const existing = new Set([1,3]);
const vouchers = ['5313','5309','5314','5310','5312','5311'];
const saved = rows.flatMap((row,i)=>existing.has(i)?[]:[{
  ...row,id:`db-${i}`,postingStatus:'verified',voucherNumber:vouchers[i],postingResult:{created:1},
}]);
const presence = Object.fromEntries(rows.map((row,i)=>[row.id,{
  status:existing.has(i)?'found':'missing',voucherNumber:existing.has(i)?vouchers[i]:null,
}]));

test('four posted plus two verified manual payments complete all six rows',()=>{
  const summary=summarizeStatementPostings(rows,saved,presence);
  assert.equal(summary.total,6);assert.equal(summary.confirmed,6);
  assert.equal(summary.alreadyExisting,2);assert.equal(summary.pending,0);
  assert.equal(bankPostingTitle(summary),'Entries confirmed in Tally');
  assert.deepEqual(postingFooterSegments(summary,false).map(x=>x.text),['4 posted','2 already entered']);
  assert.doesNotMatch(bankPostingMessage(summary),/processing|not sent/);
  const entries=buildStatementBankBook(rows,resolveStatementPostings(rows,saved,presence));
  assert.deepEqual(entries.map(x=>x.voucherNumber),vouchers);
  assert.equal(entries.length,6);
});

test('a repeat check can confirm all six as existing without any posting results',()=>{
  const checks=Object.fromEntries(rows.map((row,i)=>[row.id,{status:'found',voucherNumber:vouchers[i]}]));
  const summary=summarizeStatementPostings(rows,[],checks);
  assert.equal(summary.confirmed,6);assert.equal(summary.alreadyExisting,6);assert.equal(summary.pending,0);
  assert.equal(summary.confirmed-summary.alreadyExisting,0);
});

test('unverified and failed checks never become confirmations',()=>{
  for(const check of [{status:'missing'},{status:'ambiguous'},{status:'checking'},{status:'failed'},
    {status:'verification_pending'},{status:'found',duplicateInTally:true},
    {status:'found',checkFailed:true},{status:'found',reviewKind:'held'}]) {
    const checks={...presence,[rows[1].id]:check};
    const summary=summarizeStatementPostings(rows,saved,checks);
    assert.equal(summary.confirmed,5);assert.equal(summary.pending,1);
  }
  assert.equal(summarizeStatementPostings(rows,saved).pending,2,'refresh without live evidence must request a check');
});

test('saved held, pending and failed attempts take priority over a separate live match',()=>{
  const checks=Object.fromEntries(rows.map((row,i)=>[row.id,{status:'found',voucherNumber:vouchers[i]}]));
  for(const posting of [
    {postingStatus:'needs_tally_review',postingResult:{possibleDuplicateInTally:true}},
    {postingStatus:'pending'}, {postingStatus:'failed'},
  ]) {
    const unresolved={...rows[1],id:'saved-attempt',...posting};
    const resolved=resolveStatementPostings(rows,[...saved,unresolved],checks);
    assert.equal(resolved[1],unresolved);
    assert.notEqual(savedPostingOutcome(resolved[1]).status,'confirmed');
  }
  const summary=summarizeStatementPostings(rows,[...saved,{...rows[1],postingStatus:'needs_tally_review',postingResult:{possibleDuplicateInTally:true}}],checks);
  assert.equal(summary.held,1);assert.equal(summary.alreadyExisting,1);
});

test('live verification does not relabel a new posted payment as existing',()=>{
  const checks=Object.fromEntries(rows.map((row,i)=>[row.id,{status:'found',alreadyInTally:true,voucherNumber:vouchers[i]}]));
  const summary=summarizeStatementPostings(rows,saved,checks);
  assert.equal(summary.confirmed-summary.alreadyExisting,4);assert.equal(summary.alreadyExisting,2);
  assert.equal(saved.length,4);assert.ok(saved.every(x=>x.postingResult.created===1));
});

const source=await readFile(new URL('../components/bank-statements/BankStatementsPage.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let restore,summaryDeclaration;
(function visit(node){
  if(ts.isFunctionDeclaration(node)&&node.name?.text==='restorePostingState')restore=node;
  if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='postingSummary'&&node.initializer?.getText(ast).includes('summarizeStatementPostings'))summaryDeclaration=node;
  ts.forEachChild(node,visit);
})(ast);
const code=ts.transpileModule(restore.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const summaryCode=summaryDeclaration.initializer.getText(ast);

test('actual restoration and footer remain completed after the final live check refresh',()=>{
  const state={presence:structuredClone(presence),saved:[],done:null,postedIds:new Set()};
  const context={
    validTransactions:rows,preview:{postedTransactions:[]},ledgerMasters:[],
    tallyPresenceByTransactionId:state.presence,markPreviouslyConfirmedPostings,savedPostingPresence,
    summarizeStatementPostings,bankPostingMessage,bankPostingTitle,statementRowKey:()=>{},
    setPersistedPostedTransactions:value=>{state.saved=value},setTransactions:update=>update(rows),
    setTallyPresenceByTransactionId:update=>{state.presence=update(state.presence);context.tallyPresenceByTransactionId=state.presence},
    setPostedTransactionIds:value=>{state.postedIds=value},setTallyCheckAttempted:()=>{},
    setStatementDoneSummary:value=>{state.done=value},setBanner:()=>{},
  };
  const restoreActual=new Function('context',`with(context){${code};return restorePostingState;}`)(context);
  restoreActual(saved);
  assert.equal(state.done.tone,'success');assert.match(state.done.text,/2 already entered/);
  assert.equal(state.postedIds.size,4);assert.equal(state.presence['preview-1'].voucherNumber,'5309');
  Object.assign(context,{tallyPostingInProgress:false,tallyPostingStatus:{finished:true},persistedPostedTransactions:state.saved});
  const footerSummary=new Function('context',`with(context){return ${summaryCode};}`)(context);
  assert.deepEqual(postingFooterSegments(footerSummary,false).map(x=>x.text),['4 posted','2 already entered']);
  context.tallyPresenceByTransactionId={...state.presence,...savedPostingPresence(rows,saved)};
  restoreActual(saved);
  assert.equal(state.done.tone,'success');assert.doesNotMatch(state.done.text,/processing|not sent/);
  assert.equal(state.postedIds.size,4);
});

test('a replacement command for the same transaction remains newly posted after restoring old history',()=>{
  const old={...rows[0],id:'saved-row',postingStatus:'verified',postingCommandId:'old-command',voucherNumber:'5319',postingResult:{created:1}};
  const fresh={...old,postingCommandId:'new-command',voucherNumber:'5320'};
  assert.equal(markPreviouslyConfirmedPostings([fresh],[old])[0].postingResult.alreadyInTally,undefined);
  assert.equal(markPreviouslyConfirmedPostings([old],[old])[0].postingResult.alreadyInTally,true);
  const restored=mergeCompletedPostingEvidence([{...old,postingResult:{alreadyInTally:true}}],[{
    id:'new-command',commandType:'post_bank_voucher',status:'succeeded',
    result:{transactionId:'saved-row',created:1,verificationStatus:'verified',voucherNumber:'5320'},
  }]);
  assert.equal(restored[0].postingCommandId,'new-command');assert.equal(restored[0].postingResult.alreadyInTally,false);
  assert.equal(markPreviouslyConfirmedPostings(restored,[old])[0].postingResult.alreadyInTally,false);
  assert.equal(summarizeStatementPostings([rows[0]],restored).alreadyExisting,0);
});
