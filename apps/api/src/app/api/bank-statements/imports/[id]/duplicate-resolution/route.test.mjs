import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import * as helpers from '@gajkesari/shared/lib/bank-duplicate-resolution';
function fixture(){
 const row={id:'second',import_id:'statement',owner_user_id:'owner',transaction_date:'2026-10-25',description:'Payment to Deccan',debit_amount:8643.25,credit_amount:null,balance_amount:1000,reference_number:null};
 const state={user:{id:'owner'},datasets:['dataset'],writes:[],race:false,tables:{
  bank_statement_imports:[{id:'statement',owner_user_id:'owner',company_dataset_id:'dataset',processing_meta:{previewTransactionCount:2}}],
  bank_statement_import_preview_transactions:[{...row,id:'first',balance_amount:9643.25},row],
 }};
 const db={from(table){const filters=[];let values,single=false;const q={
  select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},order(){return q},limit(){return q},single(){single=true;return q},
  filter(k,op,v){filters.push(r=>op==='is'?r[k]==null:JSON.stringify(r[k])===v);return q},update(v){values=v;return q},
  then(resolve,reject){return Promise.resolve().then(()=>{
   if(values&&state.race)state.tables[table][0].processing_meta={...state.tables[table][0].processing_meta,changed:true};
   const rows=state.tables[table].filter(r=>filters.every(f=>f(r)));
   if(values){state.writes.push({table,ids:rows.map(r=>r.id),values});rows.forEach(r=>Object.assign(r,values));}
   return {data:single?rows[0]||null:rows,error:null};
  }).then(resolve,reject)},
 };return q}};
 const mocks={
  '@/lib/api/cors':{jsonWithCors:(_r,body,init)=>Response.json(body,init),optionsWithCors:()=>new Response(null)},
  '@/lib/api/request-auth':{requireRequestUser:async()=>state.user},
  '@/lib/supabase/admin':{createSupabaseAdminClient:()=>db},
  '@/lib/tally/browser-scope':{browserDatasetIds:async()=>state.datasets},
  '@gajkesari/shared/lib/bank-duplicate-resolution':helpers,
 };
 const filename=fileURLToPath(new URL('./route.ts',import.meta.url)),mod=new Module(filename);
 mod.require=id=>{if(!(id in mocks))throw Error('Unexpected import '+id);return mocks[id]};
 mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
 const body={action:'separate',confirmed:true,transactionId:row.id,rowKey:helpers.duplicateRowKey(row),bankLedgerName:'ICICI',counterpartyLedgerName:'Deccan',
  matches:[{masterId:'28793',voucherNumber:'5322',date:'2026-10-25',amount:8643.25,bankLedgerName:'ICICI',partyLedgerName:'Deccan',direction:'outgoing',reference:'PMT-ICICI-0BF8EA4652030502EE99',bankReferences:[]}]};
 const call=(changes={})=>mod.exports.POST(new Request('http://local/api',{method:'POST',body:JSON.stringify({...body,...changes})}),{params:Promise.resolve({id:'statement'})});
 return {state,body,call};
}
test('explicit skip and separate decisions are durable, actor stamped, auditable and reversible',async()=>{
 const f=fixture();
 for(const action of ['skip','separate']){
  const response=await f.call({action,decidedBy:'forged-user'});assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.decision.action,action);assert.equal(data.decision.decidedBy,'owner');
  assert.equal(data.decision.rowKey,f.body.rowKey);assert.equal(data.decision.candidates[0].masterId,'28793');
 }
 const cleared=await f.call({action:'clear'});assert.equal(cleared.status,200);
 const data=await cleared.json();assert.equal(data.decision,null);assert.deepEqual(data.duplicateResolutions,{});
 assert.equal(f.state.tables.bank_statement_imports[0].processing_meta.duplicateResolutionHistory.length,3);
 assert.equal(f.state.tables.bank_statement_imports[0].processing_meta.previewTransactionCount,2);
 assert.ok(f.state.writes.every(w=>w.table==='bank_statement_imports'));
});
test('owner and browser company boundaries prevent reading or resolving another statement',async()=>{
 for(const change of [f=>f.state.user=null,f=>f.state.user={id:'other'},f=>f.state.datasets=['other']]){
  const f=fixture();change(f);const response=await f.call();assert.ok([401,404].includes(response.status));assert.equal(f.state.writes.length,0);
 }
});
test('changed rows, bank UTRs, unmatched parties and missing confirmation cannot be overridden',async()=>{
 for(const changes of [{rowKey:'edited'},{confirmed:false},{matches:[]},{matches:[{masterId:'1',reference:'UTR123456'}]},
   {matches:[{masterId:'1',date:'2026-10-25',amount:8643.25,bankLedgerName:'ICICI',partyLedgerName:'Other',direction:'outgoing'}]}]){
  const f=fixture();assert.equal((await f.call(changes)).status,409);assert.equal(f.state.writes.length,0);
 }
 const f=fixture();f.state.tables.bank_statement_import_preview_transactions[1].reference_number='UTR123456';
 f.body.rowKey=helpers.duplicateRowKey(f.state.tables.bank_statement_import_preview_transactions[1]);
 assert.equal((await f.call()).status,409);assert.equal(f.state.writes.length,0);
});
test('a concurrent statement update is not overwritten by a review decision',async()=>{
 const f=fixture();f.state.race=true;assert.equal((await f.call()).status,409);
 assert.equal(f.state.tables.bank_statement_imports[0].processing_meta.changed,true);
 assert.equal(f.state.tables.bank_statement_imports[0].processing_meta.duplicateResolutions,undefined);
});
