-- Phase 1: READ-ONLY inspection of the Gajkesari Supabase project.
-- Run in the Supabase SQL editor of the project you want to inspect (staging first).
-- Every statement is a SELECT. Nothing here creates, alters or deletes anything.
-- Paste the results back so the follow-up migrations can be written against reality.

-- 1. Which collections objects exist? (NULL = missing)
select
  to_regclass('public.cash_discount_rules')            as cash_discount_rules,
  to_regclass('public.debit_note_proposals')           as debit_note_proposals,
  to_regclass('public.collections_analysis_cache')     as collections_analysis_cache,
  to_regclass('public.invoice_followup_pipelines')     as invoice_followup_pipelines,
  to_regclass('public.tally_company_datasets')         as tally_company_datasets,
  to_regclass('public.tally_installations')            as tally_installations;

-- 2. Which bridge command types does the shared constraint allow today?
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.tally_bridge_commands'::regclass
  and contype = 'c';

-- 3. Which command types are actually in use?
select command_type, status, count(*) as commands
from public.tally_bridge_commands
group by 1, 2
order by 1, 2;

-- 4. Columns the collections code expects on debit_note_proposals
--    (returns no rows if the table is missing).
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'debit_note_proposals'
order by ordinal_position;

-- 5. Columns on cash_discount_rules (returns no rows if missing).
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'cash_discount_rules'
order by ordinal_position;

-- 6. Row counts, to learn whether collections is live for anyone.
--    Run each block only if section 1 showed the table exists.
-- select count(*) as rules from public.cash_discount_rules;
-- select status, count(*) from public.debit_note_proposals group by 1 order by 1;
-- select count(*) as cached from public.collections_analysis_cache;

-- 7. Functions the shared command path and debit notes rely on.
select p.proname, pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'enqueue_debit_note_proposal', 'enqueue_bank_tally_commands',
    'claim_tally_commands', 'complete_tally_command', 'renew_tally_command_leases',
    'stamp_tally_dataset'
  )
order by 1;

-- 8. Is anything named like Kalika's access layer present? (should be empty here)
select table_name
from information_schema.tables
where table_schema = 'public'
  and (table_name like 'access\_%' escape '\' or table_name like 'followup\_%' escape '\');

-- 9. Row-level security state of the tables in play.
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'cash_discount_rules', 'debit_note_proposals', 'collections_analysis_cache',
    'tally_bridge_commands', 'tally_connections', 'tally_company_datasets'
  )
order by 1;
