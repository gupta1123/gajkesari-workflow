import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadStatementPostingRows,previewPostingFingerprint,isExistingStatementPosting} from './bank-statement-linked-transactions.ts';

function fixture() {
  const owner='owner', company='company', account='bank';
  const preview=[{transaction_date:'2026-10-08',value_date:'2026-10-08',description:'Credit from Arvind',reference_number:null,debit_amount:null,credit_amount:1201.12,balance_amount:10000},
    {transaction_date:'2026-10-08',value_date:'2026-10-08',description:'Credit from Arvind',reference_number:null,debit_amount:null,credit_amount:1201.12,balance_amount:11201.12}];
  const fingerprints=preview.map(r=>previewPostingFingerprint(account,r));
  const statement={id:'new-import',bank_account_id:account,company_dataset_id:company};
  const tables={bank_statement_import_preview_transactions:preview.map(r=>({...r,import_id:statement.id,owner_user_id:owner})),
    bank_transactions:[{id:'old-held',statement_import_id:'old-import',owner_user_id:owner,company_dataset_id:company,bank_account_id:account,fingerprint:fingerprints[0],tally_status:'needs_tally_review'},
      {id:'current-found',statement_import_id:statement.id,owner_user_id:owner,company_dataset_id:company,bank_account_id:account,fingerprint:fingerprints[1],tally_status:'verified'},
      {id:'other-owner',statement_import_id:'other',owner_user_id:'someone-else',company_dataset_id:company,bank_account_id:account,fingerprint:fingerprints[0]},
      {id:'other-company',statement_import_id:'other',owner_user_id:owner,company_dataset_id:'other-company',bank_account_id:account,fingerprint:fingerprints[0]},
      {id:'other-account',statement_import_id:'other',owner_user_id:owner,company_dataset_id:company,bank_account_id:'other-bank',fingerprint:fingerprints[0]}]};
  const db={from(table){const filters=[];const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},order(){return q},range(){return q},limit(){return q},then(resolve){return Promise.resolve({data:tables[table].filter(r=>filters.every(f=>f(r))),error:null}).then(resolve)}};return q}};
  return {db,statement,owner,fingerprints,preview,tables};
}

test('repeat uploads resolve saved held and confirmed rows without moving them or crossing owner/company/account',async()=>{
  const f=fixture();const rows=await loadStatementPostingRows(f.db,f.statement,f.owner);
  assert.deepEqual(rows.map(r=>r.id).sort(),['current-found','old-held']);
  assert.equal(rows.find(r=>r.id==='old-held').statement_import_id,'old-import');
  assert.equal(rows.find(r=>r.id==='old-held').tally_status,'needs_tally_review');
});
test('saved reviewed fingerprints take precedence over subsequent preview changes',async()=>{
  const f=fixture();f.statement.processing_meta={reviewedTransactionFingerprints:f.fingerprints};
  f.tables.bank_statement_import_preview_transactions=[];
  assert.equal((await loadStatementPostingRows(f.db,f.statement,f.owner)).length,2);
});
test('fingerprints preserve the existing ingestion format and distinguish repeated amounts by balance',()=>{
  const f=fixture();assert.equal(f.fingerprints[0],createHash('sha256').update('bank|2026-10-08|2026-10-08||credit from arvind||1201.12|10000').digest('hex'));
  assert.notEqual(f.fingerprints[0],f.fingerprints[1]);
});
test('an old posting stays already entered on a reupload even when it keeps the same source transaction ID',()=>{
  const row={id:'tx',statement_import_id:'first-upload'};const log={status:'verified',source_transaction_id:'tx'};
  assert.equal(isExistingStatementPosting(row,log,'repeat-upload'),true);
  assert.equal(isExistingStatementPosting(row,log,'first-upload'),false);
  assert.equal(isExistingStatementPosting(row,{...log,status:'needs_tally_review'},'repeat-upload'),false);
});
