import test from 'node:test';
import assert from 'node:assert/strict';
import {extractPotentialPartyName as party,extractTransferReference as reference,enrichBankStatementTransactions,validatePrintedStatementSummary} from './transaction-details.mjs';

for(const [description,expected] of [
 ['RTGS Dr- ICIC0000229-ACME & SONS PRIVATE LIMITED-CBX Internet-HDFCR52026102312345678','ACME & SONS PRIVATE LIMITED'],
 ['RTGS Cr- UTIB0006109-NOVA REALTORS - RERA DESIGNATED TRANS-EXAMPLE HOLDER-UTIBR52026102312345678','NOVA REALTORS - RERA DESIGNATED TRANS-EXAMPLE HOLDER'],
 ['NEFT_OUT:PUNBY26266915160/T R TRADERS /SBIN0020506/62485931139','T R TRADERS'],
 ['NEFT_IN:35MAHBH00865185578MAHB0002533//MAHBH00865185578/SHREE LAXMI CORPORATI','SHREE LAXMI CORPORATI'],
 ['NRTGS/ICICR42026102300596742/JAGDAMBA STEEL AND CE','JAGDAMBA STEEL AND CE'],
 ['RTGSJSC SEEDS PRIVATE LIKKBKR22026092324937358','JSC SEEDS PRIVATE LI'],
 ['RTGSNOVA TRADERS HDFCR52026102312345678','NOVA TRADERS'],
 ['NEFT ARNAV ENTERPRISES /XUTR/IN42626755388443','ARNAV ENTERPRISES'],
 ['IMPSP2A627445774022 ZEN TRADING','ZEN TRADING'],
 ['IMPS-627411810822-RAVI KUMAR-JPCB-xxxxxxxxxx0017-payment','RAVI KUMAR'],
 ['50200029980431-TPT-Part payment-SHRI HARI TRADING COMPANY','SHRI HARI TRADING COMPANY'],
 ['FT - HDFC000000X - C57265231026181752 - - 50200076795553 - A K TRADERS','A K TRADERS'],
 ['To:XXXX0189:SMEL TER AB BROS LLP','SMEL TER AB BROS LLP'],
 ['UPI/CR/629710673485/ANITA SINGH/anita@bank','ANITA SINGH'],
 ['JAGJEET SINGH SAINI','JAGJEET SINGH SAINI'],
 ['7 STAR BROADBAND','7 STAR BROADBAND'],
 ['D’SOUZA & SONS (INDIA)','D’SOUZA & SONS (INDIA)'],
 ['DEEPAK SINGH S/O RAM','DEEPAK SINGH S/O RAM'],
 ['श्री गणेश ट्रेडर्स','श्री गणेश ट्रेडर्स'],
])test('source party: '+description,()=>assert.equal(party(description).name,expected));

for(const description of ['CHQ DEP CTS CLG2 MODEL COLONY PUNE - CTS','BANK COMMISSION','GST','CIR CHARGE COLLECTION','AUTO INTEREST PAYMENT ON TERM LOAN AGAINST 007LN06240910003','AUTO TERM LOAN LIQUIDATED AGAINST 007LN06240910003','Loan Recovery For - 098100IC00000356','0981008700020850:Int.Coll:01-09-2026 to 30-09-2026','NRTGS/SBINR12026100745332103/586901019USER1','TRANSFER','ATM WITHDRAWAL'])test('unnamed transaction: '+description,()=>assert.equal(party(description).name,null));

test('transfer references exclude IFSC and preserve references distinct from cheque numbers',()=>{
 assert.equal(reference('RTGS Dr- ICIC0000229-ACME PRIVATE LIMITED-CBX Internet-HDFCR52026102312345678-C999999'),'HDFCR52026102312345678');
 assert.equal(reference('RTGSACME HDFCR5202610231234 5678'),'HDFCR52026102312345678');
 assert.equal(reference('NEFT ABC /XUTR/IN42626755388443'),'IN42626755388443');
 assert.equal(reference('IMPSP2A627445774022 ZEN TRADING'),'627445774022');
 const [r]=enrichBankStatementTransactions([{description:'RTGSABC CBINR52026100710032470',reference_number:'047351'}],{physicalLayout:'central_bank',printedReferenceKind:'cheque'});
 assert.equal(r.cheque_number,'047351');assert.equal(r.reference_number,'047351');assert.equal(r.transfer_reference,'CBINR52026100710032470');
 assert.equal(r.raw_payload.sourcePrintedReference,'047351');
 const [numeric]=enrichBankStatementTransactions([{description:'Credit from ACME',reference_number:'123261009001'}],{physicalLayout:'generic_statement',printedReferenceKind:'reference'});
 assert.equal(numeric.cheque_number,null);
});

test('hyphenated names survive account transfers and holder metadata separates incoming parties for any company',()=>{
 assert.equal(party('FT - HDFC000000X - C57265231026181752 - - 50200076795553 - ACME - INDIA').name,'ACME - INDIA');
 assert.equal(party('50200076795553-TPT-Payment-ACME - INDIA').name,'ACME-INDIA');
 assert.equal(party('RTGS Cr- UTIB0006109-NOVA REALTORS - RERA DESIGNATED TRANS-EXAMPLE INDUSTRIES PRIVATE LIMITED-UTIBR52026102312345678',{accountHolderName:'EXAMPLE INDUSTRIES PRIVATE LIMITED'}).name,'NOVA REALTORS - RERA DESIGNATED TRANS');
});

test('PNB transaction IDs remain stable and are not relabelled as UTRs',()=>{
 const [r]=enrichBankStatementTransactions([{description:'NRTGS/ICICR42026102300596742/JAGDAMBA STEEL AND CE',reference_number:'S11451554'}],{physicalLayout:'pnb'});
 assert.equal(r.bank_transaction_id,'S11451554');assert.equal(r.reference_number,'S11451554');assert.equal(r.transfer_reference,'ICICR42026102300596742');
});

test('identical transactions remain separate and source narration is unchanged',()=>{
 const input={description:'NEFT ARNAV ENTERPRISES /XUTR/IN42626755388443',reference_number:null};
 const rows=enrichBankStatementTransactions([input,{...input}]);
 assert.equal(rows.length,2);assert.equal(rows[0].description,input.description);assert.equal(rows[1].counterparty_name,'ARNAV ENTERPRISES');
});

test('printed counts, totals and closing balance independently detect omitted or corrupted rows',()=>{
 const md='|Opening Balance|Debit Count|Credit Count|Total Debit|Total Credit|Closing Balance|\n|---|---|---|---|---|---|\n|1000|1|1|100|250|1150|';
 const rows=[{debit_amount:null,credit_amount:250,balance_amount:1250},{debit_amount:100,credit_amount:null,balance_amount:1150}];
 assert.equal(validatePrintedStatementSummary(md,rows,1000).status,'verified');
 assert.equal(validatePrintedStatementSummary(md,[rows[0]],1000).status,'failed');
 assert.equal(validatePrintedStatementSummary(md,[...rows].reverse(),1000,'reverse').status,'verified');
 assert.equal(validatePrintedStatementSummary(md.replace('|1150|','|1151|'),rows,1000).status,'failed');
});
