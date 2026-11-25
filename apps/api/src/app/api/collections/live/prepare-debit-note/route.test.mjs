import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSync } from "esbuild";
import Module from "node:module";
import { fileURLToPath } from "node:url";

test("live preview does not enqueue and repeated create requests share one scoped queue ID", async () => {
  const commands = new Map();
  const target = { companyDatasetId: "dataset", companyName: "Company" };
  const bill = { referenceName: "INV/1", originalAmount: 100, pendingAmount: 100,
    invoiceDate: "2025-04-01", sourceSalesLedgerName: "Sales" };
  const client = { from(table) {
    let entry;
    const q = {
      select(){return q}, eq(){return q}, is(){return q}, order(){return q},
      range(){return Promise.resolve({data:[],error:null})},
      maybeSingle(){return {data:{id:"pc",last_company_name:"Company",last_company_loaded:true,last_tally_reachable:true}}},
      insert(value){entry=value;return q},
      single(){
        assert.equal(table,"tally_bridge_commands");
        assert.equal("idempotency_key" in entry,false);
        assert.match(entry.id,/^[a-f\d-]{36}$/);
        assert.deepEqual(entry.payload.target,target);
        if(commands.has(entry.id))return {error:{code:"23505"}};
        commands.set(entry.id,entry);return {data:entry};
      },
    };
    return q;
  }};
  const mocks = {
    "@/lib/api/cors":{jsonWithCors:(_req,body,init)=>Response.json(body,init)},
    "@/lib/api/request-auth":{requireRequestUser:async()=>({id:"owner"})},
    "@/lib/supabase/admin":{createSupabaseAdminClient:()=>client},
    "@/lib/tally/browser-scope":{browserOwnsConnection:async()=>true,resolveTallyTarget:async()=>target},
    "@/lib/tally/command-wake":{wakeTallyConnector:async()=>{}},
    "@/lib/tally/commands":{serializeTallyBridgeCommand:row=>({id:row.id})},
    "@/lib/collections-dashboard":{readTallyOpenBills:()=>[{ledgerName:"Buyer",bill}]},
    "@/lib/cash-discount-narration":{isCashDiscountRecoveryStatus:()=>true,analyseCashDiscountNarration:()=>({
      deterministicStatus:"unpaid_discount_tier_expired",reversalPlan:{totalReversalRequired:2,
        initialDiscount:{ratePercent:2},grossInvoiceAmount:102,currentPayableAmount:102}})},
  };
  const file=fileURLToPath(new URL("./route.ts",import.meta.url));
  const bundled=buildSync({entryPoints:[file],bundle:true,write:false,format:"cjs",platform:"node",
    external:Object.keys(mocks),tsconfig:"apps/api/tsconfig.json"}).outputFiles[0].text;
  const mod=new Module(file);
  const original=mod.require.bind(mod);
  mod.require=name=>mocks[name]??original(name);
  mod._compile(bundled,file);
  const call=queue=>mod.exports.POST(new Request("https://example.test/api",{method:"POST",
    body:JSON.stringify({queue,connectionId:"pc",companyName:"Company",proposal:{partyLedgerName:"Buyer",
      linkedInvoiceNumber:"INV/1"},scan:{openBillsResult:{}}})}));
  assert.equal((await call(false)).status,200);assert.equal(commands.size,0);
  const responses=await Promise.all([call(true),call(true)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(commands.size,1);
  target.companyDatasetId="other-dataset";
  assert.equal((await call(true)).status,200);assert.equal(commands.size,2);
});
