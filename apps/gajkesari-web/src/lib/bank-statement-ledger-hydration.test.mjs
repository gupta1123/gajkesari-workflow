import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {resolveBankBillReference} from '@gajkesari/shared/lib/bank-bill-reference';
const source=fs.readFileSync(new URL('../components/bank-statements/BankStatementsPage.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=new Set(['normalizeName','masterParentDescendsFromGroupMap','normalizeLiveLedgerMasters','connectorCandidateMasters','parseNumber','isSuspenseLedgerName','findLedgerByNormalizedName','getSelectedLedger','getPartyBillMatchContext','findNarrationBill','sortOpenBills','allocateBillsForTransaction','isOutgoingPaymentRow']);
const declarations=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.has(n.name?.text)).map(n=>n.getText(ast)).join('\n');
const merge=source.match(/const effectiveLedgerMasters = ([\s\S]*?);/)[1];
const js=ts.transpileModule(`const ledgerMasterIndexCache=new WeakMap();\n${declarations}\nthis.api={normalizeLiveLedgerMasters,connectorCandidateMasters,getPartyBillMatchContext,findNarrationBill,allocateBillsForTransaction,merge:(ledgerMastersForReview,candidateMasters)=>(${merge})};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const scope={resolveBankBillReference};vm.createContext(scope);vm.runInContext(js,scope);const api=scope.api;
const transaction={selectedLedgerName:'Customer',creditAmount:48500,debitAmount:null,description:'NEFT-INV 70211',transactionType:'neft',category:'receipt',referenceNumber:'UTR0001'};
test('preview candidates preserve customer ancestry, bill-wise flags and authoritative identity',()=>{
 const live=api.normalizeLiveLedgerMasters([{name:'Customer',guid:'live-guid',parent:'Nested Customers',billWiseEnabled:true},{name:'Non bill party',parent:'Nested Customers',billWiseEnabled:false}], [{name:'Nested Customers',parent:'Sundry Debtors'}]);
 const candidates=api.connectorCandidateMasters([{rawPayload:{vectorLedgerCandidates:[{ledgerName:'Customer',tallyGuid:'live-guid',parentGroup:'Nested Customers'},{ledgerName:'Candidate only',parentGroup:'Other'}]}}]);
 const hydrated=api.merge(live,candidates);
 assert.equal(api.getPartyBillMatchContext(transaction,hydrated).eligible,true);
 assert.equal(hydrated.find(x=>x.name==='Customer').ledgerType,'customer');
 assert.equal(hydrated.find(x=>x.name==='Customer').billWiseEnabled,true);
 assert.equal(hydrated.find(x=>x.name==='Non bill party').billWiseEnabled,false);
 assert.equal(hydrated.filter(x=>x.name==='Customer').length,1);
 assert.ok(hydrated.some(x=>x.name==='Candidate only'));
});
test('frontend uses the shared short-reference matcher and holds ambiguous or unknown references',()=>{
 const bills=[{referenceName:'INV/26-27/70201',pendingAmount:48500},{referenceName:'INV/26-27/70211',pendingAmount:48500}];
 assert.equal(api.findNarrationBill(bills,transaction).referenceName,'INV/26-27/70211');
 for(const [extra,description] of [[[{referenceName:'INV/25-26/70211',pendingAmount:48500}],'INV70211'],[[],'INV99999']]) {
  const draft=api.allocateBillsForTransaction({...transaction,description},[...bills,...extra],[]);
  assert.equal(draft.isEligibleForPosting,false);assert.equal(draft.requiresUserReview,true);assert.equal(draft.allocations.length,0);
 }
});
