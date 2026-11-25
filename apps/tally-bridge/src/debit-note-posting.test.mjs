import assert from "node:assert/strict";
import test from "node:test";
import {postAndVerifyDebitNote,resolveDebitNoteVoucher} from "./bridge.mjs";

const payload={referenceNumber:"DN-1",voucherDate:"2026-11-25",companyName:"Sample",partyLedgerName:"Buyer",amount:10};
const accepted={xml:"<IMPORT/>",outcome:{success:true,result:{created:1,lastVchId:"31435"}}};

test("a rejected import preserves the Tally error and skips verification",async()=>{
  const rejected={xml:"<IMPORT/>",outcome:{success:false,error:"Ledger missing",result:{errors:1}}};
  const result=await postAndVerifyDebitNote("",payload,async()=>rejected,()=>assert.fail("unexpected lookup"));
  assert.equal(result.error,"Ledger missing");
  assert.equal(result.result.errors,1);
});

test("uncertain verification preserves the import receipt and reference",async()=>{
  const result=await postAndVerifyDebitNote("",payload,async()=>accepted,async()=>{throw Error("timeout")});
  assert.equal(result.success,false);
  assert.equal(result.result.lastVchId,"31435");
  assert.equal(result.result.reconciliationRequired,true);
  assert.equal(result.result.verificationError,"timeout");
  assert.match(result.error,/DN-1.*before retrying/);
  assert.equal(result.result.voucherId,undefined);
});

test("verification requests only the voucher day and exact ID, then exact reference if needed",async(t)=>{
  const requests=[];
  t.mock.method(globalThis,"fetch",async(_url,init)=>{
    const xml=Buffer.from(init.body).toString("utf8").replaceAll("\0","");
    requests.push(xml);
    const voucher='<VOUCHER><VOUCHERTYPENAME>Debit Note</VOUCHERTYPENAME><REFERENCE>DN-1</REFERENCE><VOUCHERNUMBER>48</VOUCHERNUMBER><MASTERID>31435</MASTERID><PARTYLEDGERNAME>Buyer</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Buyer</LEDGERNAME><AMOUNT>10</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>';
    return new Response("<ENVELOPE><STATUS>1</STATUS>"+(requests.length===1?"":voucher)+"</ENVELOPE>");
  });
  const result=await postAndVerifyDebitNote("http://localhost",payload,async()=>accepted,resolveDebitNoteVoucher);
  assert.equal(result.result.voucherId,"31435",result.result.verificationError);
  assert.equal(requests.length,2);
  for(const xml of requests){
    assert.match(xml,/<SVFROMDATE[^>]*>20261125</);
    assert.match(xml,/<SVTODATE[^>]*>20261125</);
    assert.match(xml,/<FILTER>GajkesariExactDebitNote</);
  }
  assert.match(requests[0],/\$MasterID = 31435/);
  assert.match(requests[1],/\$Reference:.*DN-1/);
  requests.length=2;
  const exact=await resolveDebitNoteVoucher("http://localhost",{...payload,tallyVoucherId:"31435"},"Sample");
  assert.equal(exact.voucherNumber,"48");
  assert.equal(requests.length,3);
});
