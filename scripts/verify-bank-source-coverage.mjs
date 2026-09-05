// Read-only deployed-case replay. Downloads into memory only; never updates an
// import, creates a job, matches ledgers or sends a Tally command.
// --live-recovery explicitly permits bounded source-row AI recovery.
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {toMarkdownBytes} from '@firecrawl/anydoc';
import {extractBankStatementMarkdownAmounts} from '../apps/api/worker/bank-statement-markdown-amounts.mjs';
import {auditSourceCoverage,recoverSourceCoverage,sourceDate} from '../apps/api/worker/bank-statement-source-coverage.mjs';
import {validateRunningBalanceContinuity} from '../apps/api/worker/bank-statement-running-balance.mjs';
const args=process.argv.slice(2),id=args[args.indexOf('--import')+1];
if(!args.includes('--import')||!id)throw Error('Use --import ID [--live-recovery] with protected Gajkesari environment.');
const url=process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL;
if(new URL(url).hostname!=='xojorrtjxmopxjlvvbki.supabase.co')throw Error('Wrong project: Gajkesari only.');
const db=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const imported=await db.from('bank_statement_imports').select('storage_bucket,storage_path').eq('id',id).single();
if(imported.error)throw Error(imported.error.message);
const preview=await db.from('bank_statement_import_preview_transactions').select('*').eq('import_id',id).order('row_index').limit(1000);
if(preview.error)throw Error(preview.error.message);
const file=await db.storage.from(imported.data.storage_bucket).download(imported.data.storage_path);
if(file.error)throw Error(file.error.message);
const markdown=await toMarkdownBytes(new Uint8Array(await file.data.arrayBuffer()),'pdf');
const source=extractBankStatementMarkdownAmounts(markdown,{includeSourceDetails:true});
const before=auditSourceCoverage(preview.data,source.rows);
console.log(JSON.stringify({mode:args.includes('--live-recovery')?'bounded-live-recovery':'fixture-recovery',
  sourceRows:source.rows.length,previewRows:preview.data.length,supported:before.supported,
  missing:before.missing.length,unexpected:before.unexpected.length}));
let live;
if(args.includes('--live-recovery'))live=(await import('../apps/api/worker/process-packet-jobs.mjs')).extractBankStatementFromText;
const started=performance.now();
const result=await recoverSourceCoverage({parsed:{transactions:preview.data,openingBalance:source.openingBalance},sourceRows:source.rows,
  recover: async text=> live ? live('coverage-recovery.pdf',[{pageNumber:1,text}],[],{
    model:process.env.OPENROUTER_ANYDOC_MODEL||'openai/gpt-5.6-luna',
    reasoningTokens:Number(process.env.OPENROUTER_ANYDOC_REASONING_TOKENS??0),
    maxOutputTokens:Number(process.env.OPENROUTER_ANYDOC_MAX_OUTPUT_TOKENS??20_000),
  }) : ({transactions:
    extractBankStatementMarkdownAmounts(text,{includeSourceDetails:true}).rows.map(row=>({
      transaction_date:sourceDate(row.sourceDate),reference_number:row.reference,
      debit_amount:row.debitAmount,credit_amount:row.creditAmount,balance_amount:row.balanceAmount,
      description:'Deterministic test fixture only',
    }))})});
const balance=validateRunningBalanceContinuity(result.parsed.transactions,result.parsed.openingBalance);
console.log(JSON.stringify({recoveryMs:Math.round(performance.now()-started),diagnostics:result.diagnostics,
  outputRows:result.parsed.transactions.length,balanceValid:balance.valid,balanceBreaks:balance.breaks.length,
  cloudWrites:0,tallyWrites:0}));
assert.equal(result.diagnostics.complete,true,'Source coverage unresolved');
assert.equal(balance.valid,true,'Balance remains inconsistent');
