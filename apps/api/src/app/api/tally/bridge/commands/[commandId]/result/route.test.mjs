import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import * as claimHelpers from '../../../../../../../lib/bank-existing-voucher-claim.ts';

function fixture({prior=true,terminal=false}={}){
  const state={completions:[],refreshes:[],tables:{
    tally_connections:[{id:'connection',owner_user_id:'owner',bridge_token_hash:'token',session_generation:1}],
    tally_bridge_commands:[{id:'command',connection_id:'connection',owner_user_id:'owner',company_dataset_id:'company',
      target_session_generation:1,claim_token:'claim',status:terminal?'failed':'claimed',command_type:'post_bank_voucher',
      payload:{transactionId:'new-row'},queue_job_id:'job'}],
    bank_transactions:[{id:'new-row',owner_user_id:'owner',company_dataset_id:'company',tally_status:'pending'}],
    bank_transaction_posting_log:[{id:'new-log',command_id:'command',source_transaction_id:'new-row',
      owner_user_id:'owner',company_dataset_id:'company',status:'queued'},...(prior?[{id:'old-log',command_id:'old-command',
        source_transaction_id:'old-row',owner_user_id:'owner',company_dataset_id:'company',status:'verified',tally_voucher_id:'28530'}]:[])],
  }};
  const db={from(table){let single=false,values;const filters=[];const q={
    select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},
    in(k,values){filters.push(r=>values.includes(r[k]));return q;},
    maybeSingle(){single=true;return q;},update(v){values=v;return q;},
    then(resolve,reject){return Promise.resolve().then(()=>{const rows=(state.tables[table]||[]).filter(r=>filters.every(f=>f(r)));
      if(values)rows.forEach(r=>Object.assign(r,values));return {data:single?rows[0]:rows,error:null};}).then(resolve,reject);}
  };return q;},rpc:async(name,args)=>{state.completions.push({name,args});return {data:{id:'command'},error:null};}};
  const mocks={
    '@/lib/supabase/admin':{createSupabaseAdminClient:()=>db},
    '@/lib/bank-statement-tally-queue-status':{refreshBankStatementQueueJobStatus:async(_db,id)=>state.refreshes.push(id)},
    '@/lib/api/cors':{jsonWithCors:(_req,body,init)=>Response.json(body,init),optionsWithCors:()=>new Response(null)},
    '@/lib/collections':{},'@/lib/debit-notes/pdf':{},'@/lib/local/tally-store':{},
    '@/lib/local/mode':{isLocalDbMode:()=>false},'@/lib/tally/connections':{hashSecret:v=>v},
    '@/lib/tally/commands':{},'@/lib/tally/masters':{toNullableText:v=>v==null?null:String(v)},
    '@/lib/bank-existing-voucher-claim':claimHelpers,
  };
  const filename=fileURLToPath(new URL('./route.ts',import.meta.url));const mod=new Module(filename);
  mod.require=id=>{assert.ok(id in mocks,`unexpected import ${id}`);return mocks[id];};
  mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
  return {state,route:mod.exports};
}
function request(){return new Request('http://localhost/result',{method:'POST',headers:{authorization:'Bearer token','content-type':'application/json'},
  body:JSON.stringify({connectionId:'connection',claimToken:'claim',status:'succeeded',result:{transactionId:'new-row',alreadyInTally:true,
    created:0,voucherId:'28530',voucherNumber:'2721',duplicateCheck:{verificationStatus:'found',matchBasis:'date_bank_amount_direction_party',
      matches:[{voucherNumber:'2721',amount:1101.11}]}}})});}
const context={params:Promise.resolve({commandId:'command'})};
test('completion persists a held result before accepting a previously claimed manual voucher',async()=>{
  const {state,route}=fixture();const response=await route.POST(request(),context);
  assert.equal(response.status,200);
  assert.equal(state.completions[0].args.p_success,false);
  assert.equal(state.completions[0].args.p_result.duplicateCheck.verificationStatus,'ambiguous');
  assert.equal(state.tables.bank_transactions[0].tally_status,'needs_tally_review');
  assert.equal(state.tables.bank_transactions[0].tally_voucher_id,null);
  assert.equal(state.tables.bank_transaction_posting_log[0].status,'needs_tally_review');
  assert.deepEqual(state.refreshes,['job']);
});
test('an unclaimed manual voucher can still complete successfully',async()=>{
  const {state,route}=fixture({prior:false});assert.equal((await route.POST(request(),context)).status,200);
  assert.equal(state.completions[0].args.p_success,true);
  assert.equal(state.tables.bank_transaction_posting_log[0].status,'verified');
});
test('terminal result redelivery is acknowledged without repeating completion or claim writes',async()=>{
  const {state,route}=fixture({terminal:true});assert.equal((await route.POST(request(),context)).status,200);
  assert.equal(state.completions.length,0);assert.equal(state.refreshes.length,0);
  assert.equal(state.tables.bank_transactions[0].tally_status,'pending');
});
