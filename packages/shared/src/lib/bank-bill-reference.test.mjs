import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveBankBillReference as resolve} from './bank-bill-reference.mjs';
const bills = ['INV/26-27/70201','INV/26-27/70211'].map(referenceName=>({referenceName}));
for (const narration of ['NEFT-INV70211','NEFT INV 70211','AHMEDABADINV70211','NEFT INV/70211','NEFT INV-70211','NEFT INV00070211','NEFT invoice 70211']) {
  test(`matches the unique party invoice alias: ${narration}`,()=>assert.equal(resolve(bills,{narration}).referenceName,'INV/26-27/70211'));
}
test('prefers a full fiscal-year reference even when its serial is shared',()=>{
  assert.equal(resolve([...bills,{referenceName:'INV/25-26/70211'}],{narration:'INV/26-27/70211'}).referenceName,'INV/26-27/70211');
});
test('holds a serial shared by different years and punctuation-distinct names',()=>{
  assert.equal(resolve([...bills,{referenceName:'INV/25-26/70211'}],{narration:'INV70211'}).status,'ambiguous');
  assert.equal(resolve([...bills,{referenceName:'INV-26-27-70211'}],{narration:'INV/26-27/70211'}).status,'ambiguous');
});
test('holds unknown references and an explicitly different fiscal year',()=>{
  for (const narration of ['INV99999','INV/25-26/70211','INV702110','INV70211 and INV99999']) assert.equal(resolve(bills,{narration}).status,'unresolved');
});
test('holds multiple named invoices and preserves longest full-reference matching',()=>{
  assert.equal(resolve(bills,{narration:'INV70201 and INV70211'}).status,'ambiguous');
  assert.equal(resolve([{referenceName:'GKS-OB-SEP26-01'},{referenceName:'GKS-OB-SEP26-01-01'}],{narration:'GKS-OB-SEP26-01-01'}).referenceName,'GKS-OB-SEP26-01-01');
});
test('does not infer an invoice from a bank UTR, account number or amount alone',()=>{
  assert.equal(resolve(bills,{narration:'NEFT CREDIT 48,500.00 UTR UTIBN2630050005',referenceNumber:'UTIBN2630050005'}).status,'none');
  assert.equal(resolve([{referenceName:'70211'}],{narration:'NEFT UTR12370211999',referenceNumber:'UTR12370211999'}).status,'none');
});
test('preserves full-reference matching before a separate amount, without matching a longer serial',()=>{
  assert.equal(resolve(bills,{narration:'INV/26-27/70211 48500'}).referenceName,'INV/26-27/70211');
  assert.notEqual(resolve(bills,{narration:'INV/26-27/702110'}).status,'matched');
});
