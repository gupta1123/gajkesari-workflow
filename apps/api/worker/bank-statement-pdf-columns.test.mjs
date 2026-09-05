import test from 'node:test';import assert from 'node:assert/strict';
import {extractPnbPhysicalColumns} from './bank-statement-pdf-columns.mjs';
import {reconcileBankStatementMarkdownAmounts} from './bank-statement-markdown-amounts.mjs';
import {buildBankVoucherXml} from '../../tally-bridge/src/bridge.mjs';
const item=(str,x,y,width=40)=>({str,width,transform:[1,0,0,1,x,y]});
const headers=[item('Txn No.',80,700),item('Txn Date',180,700),item('Dr Amount',680,700),item('Cr Amount',780,700),item('Balance',880,700)];
const row=(ref,y,debit,credit,balance)=>[item(ref,65,y,70),item('03-09-2026',165,y,70),...(debit?[item(debit,660,y,85)]:[]),...(credit?[item(credit,760,y,85)]:[]),item(balance,860,y,85)];
test('headerless continuation preserves physical columns and wrapped decimals through XML',()=>{
 const pages=[{pageNumber:1,width:1000,items:[...headers,...row('T123456',600,'20,98,696.00',null,'9,65,64,682.49Dr.')]},
 {pageNumber:2,width:1000,items:[...row('T29161971',1100,null,null,'9,44,65,986.49Dr.'),item('1,00,00,000.0',660,1108,85),item('0',737,1092,8),...row('T24969455',1020,null,'2,50,000.00','8,44,65,986.49Dr.')]}];
 const physical=extractPnbPhysicalColumns(pages);assert.equal(physical.rows.length,3);
 const parsed={transactions:[{reference_number:'T29161971',credit_amount:10000000,debit_amount:null,category:'receipt'}, {reference_number:'T24969455',credit_amount:null,debit_amount:250000,category:'payment'}]};
 const fixed=reconcileBankStatementMarkdownAmounts(parsed,'',physical);
 assert.deepEqual(fixed.transactions.map(r=>[r.debit_amount,r.credit_amount,r.category]),[[10000000,null,'payment'],[null,250000,'receipt']]);
 for(const tx of fixed.transactions){const type=tx.debit_amount?'Payment':'Receipt';const xml=buildBankVoucherXml({voucherType:type,voucherDate:'2026-09-03',bankLedgerName:'PNB',counterpartyLedgerName:'Party',amount:tx.debit_amount||tx.credit_amount},'Test');
 assert.ok(xml.includes(`<VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>`));
 const bank=xml.match(/<ALLLEDGERENTRIES.LIST><LEDGERNAME>PNB<\/LEDGERNAME>[\s\S]*?<\/ALLLEDGERENTRIES.LIST>/)?.[0];
 assert.ok(bank.includes(`<AMOUNT>${tx.debit_amount?'10000000.00':'-250000.00'}</AMOUNT>`));}
});
test('changed layout, duplicate references and ambiguous amounts fail verification',()=>{
 const first={pageNumber:1,width:1000,items:[...headers,...row('T123456',600,'100.00',null,'1000.00')]};
 assert.throws(()=>extractPnbPhysicalColumns([first,{pageNumber:2,width:900,items:[]}]),/width changed/);
 assert.throws(()=>extractPnbPhysicalColumns([first,{pageNumber:2,width:1000,items:row('T123456',600,'100.00',null,'1000.00')}]),/duplicated/);
 assert.throws(()=>extractPnbPhysicalColumns([{...first,items:[...headers,...row('T123456',600,'100.00','100.00','1000.00')]}]),/incomplete/);
 assert.equal(extractPnbPhysicalColumns([{pageNumber:1,width:1000,items:[]}]).detected,false);
});
