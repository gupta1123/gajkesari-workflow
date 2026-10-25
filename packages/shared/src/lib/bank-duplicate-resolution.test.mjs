import test from 'node:test';
import assert from 'node:assert/strict';
import { canResolveRepeatedPayment, candidateIdentity, duplicateContext, duplicateRowKey, resolutionForRow, applySeparatePaymentDecision } from './bank-duplicate-resolution.mjs';
const row={transactionDate:'2026-10-25',description:'Payment to Deccan',debitAmount:8643.25,creditAmount:null,balanceAmount:10000,selectedLedgerName:'Deccan',referenceNumber:''};
const repeat={...row,balanceAmount:1356.75};
const match={masterId:'28793',voucherNumber:'5322',date:row.transactionDate,amount:8643.25,bankLedgerName:'ICICI',partyLedgerName:'Deccan',direction:'outgoing',reference:'PMT-ICICI-0BF8EA4652030502EE99',bankReferences:[]};
const decision={action:'separate',rowKey:duplicateRowKey(repeat),context:duplicateContext(repeat,'ICICI','Deccan'),candidates:[candidateIdentity(match)],decidedBy:'owner',decidedAt:'2026-10-25T12:00:00Z'};
test('only repeated no-reference rows with exactly matching evidence expose a choice',()=>{
 assert.equal(canResolveRepeatedPayment(repeat,[row,repeat],[match],'ICICI','Deccan'),true);
 for(const changes of [{reference:'UTIBN26300002502'},{amount:8644},{date:'2026-10-24'},{partyLedgerName:'Balaji'},{bankLedgerName:'Other'},{direction:'incoming'},{masterId:''}])
  assert.equal(canResolveRepeatedPayment(repeat,[row,repeat],[{...match,...changes}],'ICICI','Deccan'),false);
 assert.equal(canResolveRepeatedPayment({...repeat,referenceNumber:'UTR123456'},[row,repeat],[match],'ICICI','Deccan'),false);
 assert.equal(canResolveRepeatedPayment(repeat,[repeat],[match],'ICICI','Deccan'),false);
 assert.equal(canResolveRepeatedPayment(repeat,[row,repeat],[match,match],'ICICI','Deccan'),false);
});
test('balance distinguishes repeated rows and snake-case persisted rows retain the same key',()=>{
 assert.notEqual(duplicateRowKey(row),duplicateRowKey(repeat));
 assert.equal(duplicateRowKey(row),duplicateRowKey({transaction_date:row.transactionDate,description:row.description,debit_amount:8643.25,credit_amount:null,balance_amount:10000}));
});
test('saved decisions survive reload and expire on row, ledger or bank changes',()=>{
 const saved=JSON.parse(JSON.stringify({[decision.rowKey]:{...decision,context:Object.fromEntries(Object.entries(decision.context).reverse())}}));
 assert.deepEqual(resolutionForRow(saved,repeat,'ICICI','Deccan').action,decision.action);
 for(const [r,bank,ledger] of [[{...repeat,debitAmount:9000},'ICICI','Deccan'],[repeat,'Other','Deccan'],[repeat,'ICICI','Balaji'],[{...repeat,referenceNumber:'UTR123456'},'ICICI','Deccan']])
  assert.equal(resolutionForRow(saved,r,bank,ledger),null);
});
test('separate choice excludes only the exact reviewed voucher and preserves a new matching payment',()=>{
 const input={voucherDate:row.transactionDate,amount:8643.25,expectedDirection:'outgoing',bankReferenceNumber:null};
 assert.deepEqual(applySeparatePaymentDecision(decision,input,[match],'ICICI','Deccan'),{candidates:[],stale:false});
 const reordered={...decision,context:Object.fromEntries(Object.entries(decision.context).reverse()),candidates:[Object.fromEntries(Object.entries(decision.candidates[0]).reverse())]};
 assert.deepEqual(applySeparatePaymentDecision(reordered,input,[match],'ICICI','Deccan'),{candidates:[],stale:false});
 const newer={...match,masterId:'new',reference:''};
 assert.deepEqual(applySeparatePaymentDecision(decision,input,[match,newer],'ICICI','Deccan'),{candidates:[newer],stale:false});
});
test('changed, deleted and forged approvals do not authorise another payment',()=>{
 const input={voucherDate:row.transactionDate,amount:8643.25,expectedDirection:'outgoing',bankReferenceNumber:null};
 for(const matches of [[],[{...match,amount:8644}],[{...match,reference:'UTR123456'}],[{...match,partyLedgerName:'Balaji'}]])
  assert.equal(applySeparatePaymentDecision(decision,input,matches,'ICICI','Deccan').stale,true);
 assert.equal(applySeparatePaymentDecision({...decision,decidedBy:''},input,[match],'ICICI','Deccan').stale,true);
 assert.equal(applySeparatePaymentDecision(decision,{...input,bankReferenceNumber:'UTR123456'},[match],'ICICI','Deccan').stale,true);
});
