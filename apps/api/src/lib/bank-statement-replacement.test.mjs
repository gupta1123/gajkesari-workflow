import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('./bank-statement-replacement.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.replace(/^import .*;\r?$/gm,''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const payload={transactionId:'tx',fingerprint:'hash',voucherDate:'2026-10-25',amount:1371.25,bankLedgerName:'ICICI',counterpartyLedgerName:'Deccan',expectedDirection:'outgoing',referenceNumber:'PMT-hash',bankReferenceNumber:null};
function fixture({status='succeeded',result,original={},changed={},queued=false}={}){
 const state={queued:[],reads:0};
 const check={id:'proof',status:queued?'queued':status,result:result??{transactions:[{transactionId:'tx',verificationStatus:'missing'}]}};
 const originals=[{id:'old',status:'succeeded',payload,...original}];
 const db={from(name){assert.equal(name,'tally_bridge_commands');const q={
  select(columns){q.kind=columns.includes('result')?'check':'original';return q},in(){return q},eq(){return q},
  single(){state.reads++;return Promise.resolve({data:check,error:null})},
  then(resolve,reject){return Promise.resolve({data:originals,error:null}).then(resolve,reject)},
 };return q}};
 const exports={};new Function('exports','queueTallyCommandAndWake',code)(exports,async input=>{state.queued.push(input);return {command:{id:'proof'}}});
 const commands=[{payload:{...payload,...changed}}];
 const input={db,owner:'owner',dataset:'company',connection:'connection',target:{companyName:'Solution Nyx'},commands,prior:[{fingerprint:'hash',status:'verified',command_id:'old'}],wait:async()=>{}};
 return {state,input,commands,...exports};
}
test('an explicit replacement receives proof only after a fresh missing result',async()=>{
 const f=fixture();await f.verifyBankReplacements(f.input);
 assert.equal(f.state.queued.length,1);assert.equal(f.state.queued[0].commandType,'verify_bank_transaction');
 assert.equal(f.state.queued[0].payload.transactionId,undefined,'read-only verification must not replace transaction checkpoints');
 assert.equal(f.state.queued[0].payload.previousPostingCommands.tx,'old');
 assert.equal(f.commands[0].payload.replacementVerificationCommandId,'proof');
 assert.equal(f.commands[0].payload.replacesPostingCommandId,'old');
});
test('new payments never get replacement permission or an extra verification command',async()=>{
 const f=fixture();f.input.prior=[];await f.verifyBankReplacements(f.input);
 assert.equal(f.state.queued.length,0);assert.equal(f.commands[0].payload.replacementVerificationCommandId,undefined);
});
test('failed, ambiguous, found, duplicate and incomplete results stop replacement',async()=>{
 for(const options of [{status:'failed'},{result:{transactions:[]}},
  ...['found','ambiguous','failed'].map(verificationStatus=>({result:{transactions:[{transactionId:'tx',verificationStatus}]}})),
  {result:{transactions:[{transactionId:'tx',verificationStatus:'missing',duplicateInTally:true}]}},
  {result:{transactions:[{transactionId:'different',verificationStatus:'missing'}]}},
  {result:{transactions:[{transactionId:'tx',verificationStatus:'missing',matchCount:1}]}},
  {result:{transactions:[{transactionId:'tx',verificationStatus:'missing',matches:[{}]}]}},
 ]){
  const f=fixture(options);await assert.rejects(f.verifyBankReplacements(f.input),/Nothing was posted/);
  assert.equal(f.commands[0].payload.replacementVerificationCommandId,undefined);
 }
});
test('replacement cannot change the previously approved payment identity',async()=>{
 for(const changed of [{amount:2000},{counterpartyLedgerName:'Another party'},{bankLedgerName:'Another bank'},
  {voucherDate:'2026-10-26'},{referenceNumber:'Another reference'},{expectedDirection:'incoming'}]){
  const f=fixture({changed});await assert.rejects(f.verifyBankReplacements(f.input),/different details/);
  assert.equal(f.state.queued.length,0);
 }
});
test('active or failed original commands and missing records cannot authorize replacement',async()=>{
 for(const original of [{status:'claimed'},{status:'failed'},{id:'different'}]){
  const f=fixture({original});await assert.rejects(f.verifyBankReplacements(f.input));
  assert.equal(f.state.queued.length,0);
 }
 const f=fixture();f.input.prior[0].command_id=null;await assert.rejects(f.verifyBankReplacements(f.input));
});
test('a timed out read never falls through to posting',async()=>{
 const f=fixture({queued:true});await assert.rejects(f.verifyBankReplacements(f.input),/still checking/);
 assert.equal(f.state.reads,60);assert.equal(f.commands[0].payload.replacementVerificationCommandId,undefined);
});
