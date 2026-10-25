import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {allocateReceiptByFifo,applyFifoAllocationsToBills} from './bank-statement-bill-allocation.ts';

const source=await readFile(new URL('../components/bank-statements/BankStatementsPage.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let match;
(function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='matchPendingBills')match=n;ts.forEachChild(n,visit);})(ast);
const code=ts.transpileModule(match.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({priorMissing=false,freshStatus='missing',billsAvailable=true,direction='payment'}={}){
  const rows=[{id:'deleted',selectedLedgerName:'Deccan',date:'2026-10-25',amount:1371.25,direction},
    {id:'existing',selectedLedgerName:'Other supplier',date:'2026-10-25',amount:200,direction},
    {id:'direct',selectedLedgerName:'Bank charges',date:'2026-10-25',amount:10,direction}];
  const oldDraft={status:'ready_to_post',isEligibleForPosting:true};
  const state={allocations:{deleted:oldDraft},requests:[],allocated:[],banner:null,errors:[],matching:false};
  const data={openBills:[{referenceName:'INV-1',pendingAmount:10000}],existingAdvances:[]};
  const context={
    previewExtractionIncomplete:false,commandConnection:{id:'live'},validTransactions:rows,ledgerMasters:[],
    pendingBillEligibleTransactions:priorMissing?[rows[0]]:[],
    matchAbortRef:{current:null},lastLiveTallyCheckAtRef:{current:0},AbortController,
    setBillMatchingRequested:()=>{},showToast:(...args)=>state.errors.push(args),setTallyCheckAttempted:()=>{},
    setTallyPresenceByTransactionId:()=>{},setMatchingBills:v=>{state.matching=v},setBanner:v=>{state.banner=v},
    isBillMatchEligibleTransaction:t=>t.id!=='direct',getEffectiveTransactionDate:t=>t.date,
    normalizeName:s=>s.toLowerCase(),
    isIncomingReceiptRow:t=>t.direction==='receipt',isOutgoingPaymentRow:t=>t.direction==='payment',
    getPartyBillMatchContext:t=>({amount:t.amount}),applyFifoAllocationsToBills,
    verifyBankStatementPresence:async(connection,transactions,options)=>{
      state.requests.push(options);
      return {drafts:{deleted:{status:freshStatus},existing:{status:'found'},direct:{status:'found'}},
        balanceProof:null,connectorBillAllocationPlans:{},
        billDataByLedger:billsAvailable&&options.billEligibleTransactionIds.includes('deleted')?new Map([['Deccan',data]]):new Map()};
    },
    allocateBillsForTransaction:(row,bills)=>{
      state.allocated.push(row.id);
      return {...allocateReceiptByFifo(row.amount,bills,'ADV-test'),status:'ready_to_post',requiresUserReview:false,isEligibleForPosting:true};
    },
    setBillAllocationsByTransactionId:drafts=>{state.allocations=drafts},
  };
  const run=new Function('context',`with(context){${code};return matchPendingBills;}`)(context);
  return {run,state,context};
}

test('first recheck prepares a deleted payment even when every previous voucher was found',async()=>{
  const f=fixture();await f.run();
  assert.deepEqual(f.state.requests[0].billEligibleTransactionIds,['deleted','existing']);
  assert.equal(f.state.requests[0].asOfDate,'2026-10-25');
  assert.deepEqual(f.state.allocated,['deleted']);
  assert.equal(f.state.allocations.deleted.status,'ready_to_post');
  assert.equal(f.state.allocations.deleted.allocations[0].allocatedAmount,1371.25);
  assert.deepEqual(f.state.allocations.deleted.sourceBillState.openBills,[{referenceName:'INV-1',pendingAmount:10000}]);
  assert.match(f.state.banner.text,/1 outgoing payment is ready to post/);
  assert.equal(f.state.matching,false);assert.deepEqual(f.state.errors,[]);
});

test('the same recheck path prepares a newly missing receipt without relying on old results',async()=>{
  const f=fixture({direction:'receipt'});await f.run();
  assert.equal(f.state.allocations.deleted.status,'ready_to_post');
  assert.match(f.state.banner.text,/1 receipt is ready to post/);
});

test('a missing bill response stays blocked instead of becoming an advance',async()=>{
  const f=fixture({billsAvailable:false});await f.run();
  assert.equal(f.state.allocations.deleted.status,'cannot_match_yet');
  assert.equal(f.state.allocations.deleted.isEligibleForPosting,false);
  assert.deepEqual(f.state.allocated,[]);
});

test('found, ambiguous and failed fresh checks clear obsolete allocation drafts',async()=>{
  for(const freshStatus of ['found','ambiguous','failed']){
    const f=fixture({freshStatus});await f.run();
    assert.deepEqual(f.state.allocations,{},freshStatus);
    assert.deepEqual(f.state.allocated,[],freshStatus);
  }
});

test('a row already marked missing is rechecked and allocated normally',async()=>{
  const f=fixture({priorMissing:true});await f.run();
  assert.equal(f.state.allocations.deleted.status,'ready_to_post');
  assert.deepEqual(f.state.errors,[]);
});
