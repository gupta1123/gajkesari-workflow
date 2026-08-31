-- READ ONLY. Run manually AFTER the migration in the staging/release checks.
-- These queries do not apply a schema or modify a voucher.
select source_table, owner_user_id, count(*) as unassigned_rows
from public.tally_scope_reconciliation_report group by source_table, owner_user_id
order by source_table, owner_user_id;

select i.id as installation_id, i.machine_name, i.session_generation,
  d.id as dataset_id, d.company_name, d.company_guid
from public.tally_installations i
left join public.tally_company_datasets d on d.installation_id=i.id and d.owner_user_id=i.owner_user_id
order by i.id,d.company_name;

-- Both queries must return no rows.
select c.id from public.tally_connections c join public.tally_installations i on i.id=c.installation_ref
where c.owner_user_id<>i.owner_user_id;
select q.id from public.tally_bridge_commands q join public.tally_company_datasets d on d.id=q.company_dataset_id
where q.owner_user_id<>d.owner_user_id;

-- Review, never replay these automatically.
select id, connection_id, company_dataset_id, status, lease_expires_at, error
from public.tally_bridge_commands where reconciliation_required order by created_at;

select tablename, policyname, permissive, roles from pg_policies
where schemaname='storage' and policyname='tally_documents_api_only';
select id, public from storage.buckets where id in ('bank-statement-files','debit-note-pdfs');

-- All listed execute privileges for browser roles must be false.
select role_name, routine,
  has_function_privilege(role_name,routine,'EXECUTE') as browser_can_execute
from (values ('anon'),('authenticated')) roles(role_name)
cross join (values
  ('public.claim_tally_commands(uuid,text,text,integer)'),
  ('public.renew_tally_command_leases(uuid,text,jsonb)'),
  ('public.pair_tally_installation(uuid,text,text,text,jsonb)'),
  ('public.enqueue_bank_tally_commands(uuid,uuid,uuid,bigint,jsonb)'),
  ('public.enqueue_debit_note_proposal(uuid,uuid,uuid,jsonb,jsonb)'),
  ('public.complete_tally_command(uuid,text,uuid,uuid,boolean,jsonb,text,jsonb)')
) routines(routine);
