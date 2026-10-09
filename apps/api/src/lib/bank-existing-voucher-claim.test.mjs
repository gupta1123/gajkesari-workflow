import test from 'node:test';
import assert from 'node:assert/strict';
import {protectExistingVoucherClaim, heldExistingVoucherResult} from './bank-existing-voucher-claim.ts';
import {bankPostingOutcome} from '@gajkesari/shared/lib/bank-posting-outcome';

const result={alreadyInTally:true,created:0,voucherId:'28530',voucherNumber:'2721',
  duplicateCheck:{verificationStatus:'found',matchBasis:'date_bank_amount_direction_party',
    matches:[{masterId:'28530',voucherNumber:'2721',partyLedgerName:'Arvind',amount:1101.11}]}};
function fixture(claims){
  const filters=[];
  const db={from(table){assert.equal(table,'bank_transaction_posting_log');const q={
    select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},
    then(resolve,reject){return Promise.resolve({data:claims.filter(r=>filters.every(f=>f(r))),error:null}).then(resolve,reject);}
  };return q;}};
  return db;
}
const scope={ownerId:'owner',companyDatasetId:'company',transactionId:'new-row',commandId:'new-command'};
const claim={owner_user_id:'owner',company_dataset_id:'company',status:'verified',tally_voucher_id:'28530',
  command_id:'old-command',source_transaction_id:'old-row'};

test('voucher already confirmed through a previous upload cannot confirm another manual row',async()=>{
  const protectedResult=await protectExistingVoucherClaim(fixture([claim]),scope,result);
  assert.equal(protectedResult.possibleDuplicateInTally,true);
  assert.equal(protectedResult.alreadyInTally,false);
  assert.equal(protectedResult.duplicateCheck.verificationStatus,'ambiguous');
  assert.match(protectedResult.duplicateCheck.reason,/another statement entry/);
  assert.equal(bankPostingOutcome({status:'failed',result:protectedResult}).status,'needs_check');
  assert.deepEqual(protectedResult.duplicateCheck.matches,result.duplicateCheck.matches);
  assert.equal(result.duplicateCheck.verificationStatus,'found');
});
test('re-delivery for the same transaction remains confirmed',async()=>{
  const protectedResult=await protectExistingVoucherClaim(fixture([{...claim,source_transaction_id:'new-row'}]),scope,result);
  assert.equal(protectedResult,result);
});
test('other owners, companies, vouchers and held claims cannot block a match',async()=>{
  const claims=[{...claim,owner_user_id:'another'},{...claim,company_dataset_id:'another'},
    {...claim,tally_voucher_id:'another'},{...claim,status:'needs_tally_review'}];
  assert.equal(await protectExistingVoucherClaim(fixture(claims),scope,result),result);
});
test('newly created vouchers and exact reference matches keep their existing rules',async()=>{
  const db={from(){throw Error('Unexpected claim lookup');}};
  for(const value of [{...result,alreadyInTally:false,created:1},
    {...result,duplicateCheck:{...result.duplicateCheck,matchBasis:'reference'}}])
    assert.equal(await protectExistingVoucherClaim(db,scope,value),value);
});
test('claim evidence must be available before completion is accepted',async()=>{
  const q={select(){return q;},eq(){return q;},neq(){return q;},then(resolve){return Promise.resolve({error:Error('database unavailable')}).then(resolve);}};
  await assert.rejects(protectExistingVoucherClaim({from:()=>q},scope,result),/database unavailable/);
  assert.equal(heldExistingVoucherResult(result).created,0);
});
