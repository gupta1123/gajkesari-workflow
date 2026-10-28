import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const args={};
for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!args.benchmark||!args['pdf-dir']||!args.out)throw new Error('Usage: node scripts/benchmark-bank-statement-connector.mjs --benchmark expected.json --pdf-dir PDFs --out results [--parser-root app]');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=path.resolve(args['parser-root']||path.join(repo,'apps/tally-bridge'));
const out=path.resolve(args.out);await fs.mkdir(out,{recursive:true});
const benchmarkBytes=await fs.readFile(args.benchmark);
const benchmark=JSON.parse(benchmarkBytes);
if(benchmark.status!=='visually_reviewed')throw new Error('A frozen visually reviewed benchmark is required.');
const {parseDocumentLocal}=await import(pathToFileURL(path.join(app,'src/document-parsing/parser.mjs')));
const version=JSON.parse(await fs.readFile(path.join(app,'package.json'))).version;
const normalize=s=>String(s??'').replace(/&amp;/gi,'&').toUpperCase().replace(/[^\p{L}\p{N}]/gu,'');
const whitespace=s=>String(s??'').replace(/\s/g,'');
const sameNumber=(a,b)=>Number(a||0)===Number(b||0);
const counts={pdfs:0,parsedPdfs:0,expectedRows:0,extractedRows:0,correctDates:0,correctDebit:0,correctCredit:0,correctBalance:0,expectedValueDates:0,correctValueDates:0,exactNarrations:0,expectedNamedRows:0,partyNamesPopulated:0,exactPartyNames:0,sourceSupportedPartyFragments:0,expectedUnnamedRows:0,correctUnnamedRows:0,expectedPrintedReferences:0,correctPrintedReferences:0,centralTransferReferences:0};
const documents=[];
for(const doc of benchmark.documents) {
  const started=performance.now(),bytes=await fs.readFile(path.join(args['pdf-dir'],doc.localFile));
  if(createHash('sha256').update(bytes).digest('hex')!==doc.sha256)throw new Error('Source PDF hash mismatch: '+doc.localFile);
  counts.pdfs++;counts.expectedRows+=doc.transactions.length;
  const entry={document:doc.document,file:doc.file,bank:doc.bank,expectedRows:doc.transactions.length,issues:[]};
  let actual=[];
  try {
    const result=await parseDocumentLocal({bytes,fileName:doc.file,output:'json'});
    await fs.writeFile(path.join(out,doc.sha256+'.json'),JSON.stringify(result,null,2));
    actual=result.content.transactions;counts.parsedPdfs++;
    entry.balanceValidation=result.metadata.diagnostics.balanceValidation.status;
    entry.summaryValidation=result.metadata.diagnostics.summaryValidation?.status;
    entry.ocrUsed=result.metadata.ocrUsed;
  } catch(error) {entry.error={code:error.code,message:error.message};}
  entry.extractedRows=actual.length;counts.extractedRows+=actual.length;
  if(actual.length!==doc.transactions.length)entry.issues.push({field:'row_count',expected:doc.transactions.length,actual:actual.length});
  doc.transactions.forEach((expected,index)=>{
    const row=actual[index];
    if(expected.partyText)counts.expectedNamedRows++;else counts.expectedUnnamedRows++;
    if(expected.reference)counts.expectedPrintedReferences++;
    if(expected.valueDate)counts.expectedValueDates++;
    if(!row)return;
    for(const [source,field,counter] of [['date','transaction_date','correctDates'],['debit','debit_amount','correctDebit'],['credit','credit_amount','correctCredit'],['balance','balance_amount','correctBalance']]) {
      const ok=source==='date'?expected[source]===row[field]:sameNumber(expected[source],row[field]);
      if(ok)counts[counter]++;else entry.issues.push({row:index+1,field,expected:expected[source],actual:row[field]});
    }
    if(expected.valueDate===row.value_date&&expected.valueDate)counts.correctValueDates++;
    if(whitespace(expected.description)===whitespace(row.description))counts.exactNarrations++;
    else entry.issues.push({row:index+1,field:'narration',expected:expected.description,actual:row.description});
    const name=normalize(row.counterparty_name),gold=normalize(expected.partyText);
    if(name)counts.partyNamesPopulated++;
    if(gold&&name===gold)counts.exactPartyNames++;
    if(gold&&name.startsWith(gold)&&normalize(expected.description).includes(name))counts.sourceSupportedPartyFragments++;
    if(!gold&&!name)counts.correctUnnamedRows++;
    if(name!==gold)entry.issues.push({row:index+1,field:'party_name',expected:expected.partyText,actual:row.counterparty_name,sourceNarration:expected.description,sourceSupportedExtraText:Boolean(gold&&name.startsWith(gold)&&normalize(expected.description).includes(name))});
    const printed=row.raw_payload?.sourcePrintedReference??row.reference_number;
    if(expected.reference&&whitespace(expected.reference)===whitespace(printed))counts.correctPrintedReferences++;
    else if(expected.reference)entry.issues.push({row:index+1,field:'printed_reference',expected:expected.reference,actual:printed});
    if(doc.bank==='Central Bank of India'&&row.transfer_reference)counts.centralTransferReferences++;
  });
  entry.durationMs=Math.round(performance.now()-started);documents.push(entry);
  console.log(JSON.stringify({document:doc.document,rows:actual.length,expected:entry.expectedRows,issues:entry.issues.length,error:entry.error}));
}
const score=(n,d)=>({correct:n,total:d,percent:d?Number((100*n/d).toFixed(2)):null});
const metrics={pdfSuccess:score(counts.parsedPdfs,counts.pdfs),transactionCoverage:score(counts.extractedRows,counts.expectedRows),dates:score(counts.correctDates,counts.expectedRows),debit:score(counts.correctDebit,counts.expectedRows),credit:score(counts.correctCredit,counts.expectedRows),balance:score(counts.correctBalance,counts.expectedRows),valueDates:score(counts.correctValueDates,counts.expectedValueDates),narration:score(counts.exactNarrations,counts.expectedRows),exactPartyNames:score(counts.exactPartyNames,counts.expectedNamedRows),sourceSupportedPartyFragments:score(counts.sourceSupportedPartyFragments,counts.expectedNamedRows),correctUnnamedRows:score(counts.correctUnnamedRows,counts.expectedUnnamedRows),printedReferences:score(counts.correctPrintedReferences,counts.expectedPrintedReferences)};
const report={version,parserRoot:app,checkedAt:new Date().toISOString(),benchmarkSha256:createHash('sha256').update(benchmarkBytes).digest('hex'),counts,metrics,documents,method:'Direct replay against immutable source PDFs and frozen visually reviewed expected JSON. Whitespace ignored for narration; case, punctuation and whitespace ignored for party-name matching. Source-supported additional party text is reported separately from exact matches. Printed reference columns are distinct from UTRs.',tallyCalls:0,databaseWrites:0};
await fs.writeFile(path.join(out,'benchmark-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({version,counts,metrics}));
process.exitCode=counts.parsedPdfs===counts.pdfs&&counts.extractedRows===counts.expectedRows&&counts.correctDates===counts.expectedRows&&counts.correctDebit===counts.expectedRows&&counts.correctCredit===counts.expectedRows&&counts.correctBalance===counts.expectedRows&&counts.exactNarrations===counts.expectedRows?0:1;
