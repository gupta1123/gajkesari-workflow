-- MANUAL APPLICATION ONLY. Additive foundation; no voucher or audit deletion.
-- Apply during the coordinated release window, not independently of the app.
begin;

-- Saved debit-note proposals are an optional module, not a prerequisite for
-- bank matching/live cash-discount reads. Never create a placeholder table or
-- bypass a proposal checkpoint when the module is absent.
do $preflight$
declare t text; missing_tables text[] := '{}';
begin
  foreach t in array array['tally_connections','tally_bridge_commands',
    'bank_accounts','bank_statement_imports','bank_transactions',
    'bank_transaction_posting_log','bank_statement_tally_queue_jobs',
    'tally_masters','tally_mapping_settings','tally_master_sync_runs'] loop
    if to_regclass('public.' || t) is null then
      missing_tables := array_append(missing_tables, 'public.' || t);
    end if;
  end loop;
  if cardinality(missing_tables) > 0 then
    raise exception 'Missing prerequisite tables: %', array_to_string(missing_tables, ', ')
      using hint = 'Apply the existing bank/Tally schema prerequisites before this migration.';
  end if;
  if to_regclass('public.debit_note_proposals') is null then
    raise notice 'Saved debit-note proposals are not installed; their approval RPC will remain disabled.';
  end if;
end $preflight$;

create table public.tally_installations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id),
  installation_key text not null,
  machine_name text,
  session_generation bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (owner_user_id, installation_key),
  unique (owner_user_id, id)
);
create table public.tally_company_datasets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  installation_id uuid not null,
  company_guid text not null check (length(trim(company_guid)) > 0),
  company_name text not null,
  financial_year text,
  created_at timestamptz not null default now(),
  foreign key (owner_user_id, installation_id) references public.tally_installations(owner_user_id, id),
  unique (installation_id, company_guid),
  unique (owner_user_id, id)
);
create table public.tally_browser_bindings (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  installation_id uuid not null,
  credential_hash text not null unique check (length(credential_hash) = 64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz,
  foreign key (owner_user_id, installation_id) references public.tally_installations(owner_user_id, id)
);
create index tally_browser_bindings_installation_idx on public.tally_browser_bindings(installation_id);
create table public.tally_catalogue_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  company_dataset_id uuid not null,
  checksum text not null check (length(checksum) = 64),
  revision text,
  catalogue jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (owner_user_id, company_dataset_id) references public.tally_company_datasets(owner_user_id, id),
  unique (company_dataset_id, checksum)
);
alter table public.tally_installations enable row level security;
alter table public.tally_company_datasets enable row level security;
alter table public.tally_browser_bindings enable row level security;
alter table public.tally_catalogue_snapshots enable row level security;
revoke all on public.tally_installations, public.tally_company_datasets, public.tally_browser_bindings, public.tally_catalogue_snapshots from public, anon, authenticated;
grant select, insert, update on public.tally_installations, public.tally_company_datasets, public.tally_browser_bindings to service_role;
grant select, insert on public.tally_catalogue_snapshots to service_role;

alter table public.tally_connections add column installation_ref uuid references public.tally_installations(id);
alter table public.tally_connections add column active_company_guid text;
alter table public.tally_bridge_commands add column company_dataset_id uuid references public.tally_company_datasets(id);
alter table public.tally_bridge_commands add column target_session_generation bigint;
alter table public.tally_bridge_commands add column claim_token uuid;
alter table public.tally_bridge_commands add column lease_expires_at timestamptz;
alter table public.tally_bridge_commands add column reconciliation_required boolean not null default false;
create index tally_commands_claim_queue_idx on public.tally_bridge_commands(connection_id, priority desc, created_at)
  where status = 'queued' and not reconciliation_required;
create index tally_commands_expired_lease_idx on public.tally_bridge_commands(lease_expires_at) where status = 'claimed';

-- Keep legacy identifiers and relationships. Never assign old rows using the
-- connection's CURRENT company name: it may have changed after the transaction.
do $migration$
declare table_name text;
begin
  foreach table_name in array array['bank_accounts','bank_statement_imports','bank_transactions','bank_transaction_posting_log','bank_statement_tally_queue_jobs','tally_masters','tally_mapping_settings','tally_master_sync_runs','debit_note_proposals'] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I add column company_dataset_id uuid references public.tally_company_datasets(id)', table_name);
      execute format('alter table public.%I add foreign key (owner_user_id, company_dataset_id) references public.tally_company_datasets(owner_user_id, id)', table_name);
      execute format('create index %I on public.%I(company_dataset_id)', table_name || '_dataset_idx', table_name);
    end if;
  end loop;
end $migration$;
alter table public.bank_statement_imports add column catalogue_snapshot_id uuid references public.tally_catalogue_snapshots(id);
-- Different Tally datasets may legitimately use the same bank account number.
alter table public.bank_accounts drop constraint bank_accounts_owner_user_id_account_number_normalized_key;
alter table public.bank_accounts add constraint bank_accounts_dataset_number_key
  unique(owner_user_id, company_dataset_id, account_number_normalized);
alter table public.tally_masters drop constraint tally_masters_connection_company_type_key_unique;
alter table public.tally_masters add constraint tally_masters_dataset_type_key_unique
  unique(company_dataset_id, master_type, master_key);
alter table public.tally_mapping_settings drop constraint tally_mapping_settings_connection_company_type_source_unique;
alter table public.tally_mapping_settings add constraint tally_mappings_dataset_type_source_unique
  unique(company_dataset_id, mapping_type, source_key);

-- Only durable installation IDs qualify. Revoked sessions remain revoked.
insert into public.tally_installations(owner_user_id, installation_key, machine_name, session_generation)
select owner_user_id, installation_id, max(bridge_machine_name), max(session_generation)
from public.tally_connections
where installation_id ~* '-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
group by owner_user_id, installation_id;
update public.tally_connections c set installation_ref = i.id
from public.tally_installations i where i.owner_user_id = c.owner_user_id and i.installation_key = c.installation_id;
insert into public.tally_company_datasets(owner_user_id, installation_id, company_guid, company_name, financial_year)
select distinct on (c.installation_ref, lower(trim(s.value->>'guid')))
 c.owner_user_id, c.installation_ref, lower(trim(s.value->>'guid')), s.value->>'companyName', s.value->>'financialYear'
from public.tally_connections c
cross join lateral jsonb_array_elements(coalesce(c.last_companies_snapshot, '[]'::jsonb)) s
where c.installation_ref is not null and nullif(trim(s.value->>'guid'), '') is not null
 and nullif(trim(s.value->>'companyName'), '') is not null
order by c.installation_ref, lower(trim(s.value->>'guid')), c.updated_at desc;

-- Deterministic historical attribution uses the GUID recorded WITH the work,
-- never a present-day company-name match. Ambiguous/old rows stay unassigned.
update public.tally_bridge_commands q set company_dataset_id=d.id
from public.tally_connections c, public.tally_company_datasets d
where q.connection_id=c.id and q.owner_user_id=c.owner_user_id
  and d.installation_id=c.installation_ref and d.owner_user_id=q.owner_user_id
  and d.company_guid=lower(trim(coalesce(q.payload#>>'{target,companyGuid}',q.payload->>'companyGuid')));
update public.bank_statement_imports b set company_dataset_id=d.id
from public.tally_connections c, public.tally_company_datasets d
where b.processing_meta#>>'{selectedContext,connectionId}'=c.id::text
  and b.owner_user_id=c.owner_user_id and d.installation_id=c.installation_ref and d.owner_user_id=b.owner_user_id
  and d.company_guid=lower(trim(coalesce(b.processing_meta#>>'{selectedContext,target,companyGuid}',
    b.processing_meta#>>'{selectedContext,companyGuid}')));
update public.bank_transactions t set company_dataset_id=b.company_dataset_id
from public.bank_statement_imports b where t.statement_import_id=b.id
  and t.owner_user_id=b.owner_user_id and b.company_dataset_id is not null;
update public.bank_transaction_posting_log l set company_dataset_id=q.company_dataset_id
from public.tally_bridge_commands q where l.command_id=q.id
  and l.owner_user_id=q.owner_user_id and q.company_dataset_id is not null;
do $proposal_backfill$
begin
  if to_regclass('public.debit_note_proposals') is not null then
    update public.debit_note_proposals p set company_dataset_id=q.company_dataset_id
    from public.tally_bridge_commands q where p.tally_command_id=q.id
      and p.owner_user_id=q.owner_user_id and q.company_dataset_id is not null;
  end if;
end $proposal_backfill$;
-- An account is assigned only if ALL linked imports/transactions are attributed
-- to exactly one dataset. A shared legacy account needs explicit reconciliation.
with evidence as (
  select owner_user_id,bank_account_id,company_dataset_id from public.bank_statement_imports where bank_account_id is not null
  union all select owner_user_id,bank_account_id,company_dataset_id from public.bank_transactions
), safe as (
  select owner_user_id,bank_account_id,min(company_dataset_id::text)::uuid as dataset_id
  from evidence group by owner_user_id,bank_account_id
  having count(*)=count(company_dataset_id) and count(distinct company_dataset_id)=1
)
update public.bank_accounts a set company_dataset_id=s.dataset_id from safe s
where a.id=s.bank_account_id and a.owner_user_id=s.owner_user_id;

do $report$
declare report_sql text := $view$
create view public.tally_scope_reconciliation_report with (security_invoker=true) as
select 'bank_accounts'::text as source_table,id,owner_user_id,created_at from public.bank_accounts where company_dataset_id is null
union all select 'bank_statement_imports',id,owner_user_id,created_at from public.bank_statement_imports where company_dataset_id is null
union all select 'bank_transactions',id,owner_user_id,created_at from public.bank_transactions where company_dataset_id is null
union all select 'bank_transaction_posting_log',id,owner_user_id,created_at from public.bank_transaction_posting_log where company_dataset_id is null
union all select 'tally_bridge_commands',id,owner_user_id,created_at from public.tally_bridge_commands where company_dataset_id is null
union all select 'tally_masters',id,owner_user_id,created_at from public.tally_masters where company_dataset_id is null
union all select 'tally_mapping_settings',id,owner_user_id,created_at from public.tally_mapping_settings where company_dataset_id is null
$view$;
begin
  if to_regclass('public.debit_note_proposals') is not null then
    report_sql := report_sql || $view$
union all select 'debit_note_proposals',id,owner_user_id,created_at from public.debit_note_proposals where company_dataset_id is null
$view$;
  end if;
  execute report_sql;
end $report$;
revoke all on public.tally_scope_reconciliation_report from public, anon, authenticated;
grant select on public.tally_scope_reconciliation_report to service_role;

-- Atomic claim: no cleanup writes or per-command HTTP round trips on empty polls.
-- Unknown outcomes are never automatically replayed, regardless of attempt count.
create function public.claim_tally_commands(p_connection_id uuid, p_token_hash text, p_bridge_version text, p_limit integer default 1)
returns setof public.tally_bridge_commands language plpgsql security invoker set search_path = public, pg_temp as $$
declare c public.tally_connections;
begin
  select * into c from public.tally_connections where id = p_connection_id
    and bridge_token_hash = p_token_hash and revoked_at is null for share;
  if not found then raise exception 'Invalid connector session' using errcode = '42501'; end if;
  return query
  with candidates as (
    select q.id from public.tally_bridge_commands q
    where q.connection_id = c.id and q.owner_user_id = c.owner_user_id and q.status = 'queued'
      and q.available_at <= now() and q.attempts < q.max_attempts and not q.reconciliation_required
      and q.company_dataset_id is not null and q.target_session_generation = c.session_generation
    order by q.priority desc, q.created_at
    limit least(50, greatest(1, p_limit)) for update skip locked
  )
  update public.tally_bridge_commands q set status = 'claimed', claimed_at = now(),
    attempts = q.attempts + 1, bridge_version = p_bridge_version, claim_token = gen_random_uuid(),
    target_session_generation = c.session_generation, lease_expires_at = now() + interval '120 seconds'
  from candidates where q.id = candidates.id returning q.*;
end $$;
revoke all on function public.claim_tally_commands(uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.claim_tally_commands(uuid,text,text,integer) to service_role;

create function public.renew_tally_command_leases(p_connection_id uuid, p_token_hash text, p_claims jsonb)
returns integer language plpgsql security invoker set search_path = public, pg_temp as $$
declare renewed integer;
begin
  update public.tally_bridge_commands q set lease_expires_at = now() + interval '120 seconds'
  from public.tally_connections c, jsonb_to_recordset(p_claims) as x(id uuid, token uuid)
  where c.id = p_connection_id and c.bridge_token_hash = p_token_hash and c.revoked_at is null
    and q.connection_id = c.id and q.target_session_generation = c.session_generation
    and q.id = x.id and q.claim_token = x.token and q.status = 'claimed' and not q.reconciliation_required;
  get diagnostics renewed = row_count;
  return renewed;
end $$;
revoke all on function public.renew_tally_command_leases(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.renew_tally_command_leases(uuid,text,jsonb) to service_role;

-- Called by a maintenance worker, not by every empty connector poll. Expiry is
-- an unknown result, NOT proof the voucher was never created.
create function public.quarantine_expired_tally_commands()
returns integer language plpgsql security invoker set search_path = public, pg_temp as $$
declare affected integer;
begin
  update public.tally_bridge_commands set reconciliation_required = true,
    error = 'Connector lease expired. Read back Tally before retrying this command.'
  where status = 'claimed' and not reconciliation_required and lease_expires_at < now();
  get diagnostics affected = row_count;
  return affected;
end $$;
revoke all on function public.quarantine_expired_tally_commands() from public, anon, authenticated;
grant execute on function public.quarantine_expired_tally_commands() to service_role;

-- Pairing is one transaction, serialized per installation. A new challenge on
-- another PC is never revoked, and existing installation identity is immutable.
create function public.pair_tally_installation(p_connection_id uuid, p_pairing_hash text, p_control_hash text, p_bridge_hash text, p_metadata jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare c public.tally_connections; i public.tally_installations; requested_installation_key text;
begin
  requested_installation_key := p_metadata->>'installationId';
  if requested_installation_key !~* '-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid installation identity' using errcode = '22023';
  end if;
  select * into c from public.tally_connections where id = p_connection_id for update;
  if not found or c.revoked_at is not null or c.pairing_code_hash is distinct from p_pairing_hash
    or c.control_token_hash is distinct from p_control_hash or c.pairing_code_expires_at <= now()
    or c.pairing_code_expires_at is null then
    raise exception 'Invalid or expired pairing challenge' using errcode = '42501';
  end if;
  if c.installation_id is not null and c.installation_id <> requested_installation_key then
    raise exception 'This connection belongs to another installation' using errcode = '42501';
  end if;
  insert into public.tally_installations(owner_user_id, installation_key, machine_name, session_generation)
    values(c.owner_user_id, requested_installation_key, p_metadata->>'machineName', 1)
    on conflict(owner_user_id, installation_key) do update
      set session_generation = tally_installations.session_generation + 1, machine_name = excluded.machine_name
    returning * into i;
  update public.tally_connections set revoked_at = now(), revoked_reason = 'Superseded by the same installation',
    bridge_token_hash = null, pairing_code_hash = null, pairing_code_expires_at = null
    where owner_user_id = c.owner_user_id and installation_id = requested_installation_key and id <> c.id and revoked_at is null;
  update public.tally_bridge_commands q set status = 'canceled', completed_at = now(), error = 'Session replaced before execution'
    from public.tally_connections old where q.connection_id = old.id and old.installation_ref = i.id and q.status = 'queued';
  update public.tally_bridge_commands q set reconciliation_required = true, error = 'Session changed during execution; read back Tally before retrying'
    from public.tally_connections old where q.connection_id = old.id and old.installation_ref = i.id and q.status = 'claimed';
  update public.tally_browser_bindings set revoked_at = now() where installation_id = i.id and revoked_at is null;
  insert into public.tally_browser_bindings(owner_user_id, installation_id, credential_hash)
    values(c.owner_user_id, i.id, p_control_hash);
  update public.tally_connections set installation_id = requested_installation_key, installation_ref = i.id,
    session_generation = i.session_generation, bridge_token_hash = p_bridge_hash,
    pairing_code_hash = null, pairing_code_expires_at = null, paired_at = now(),
    bridge_name = p_metadata->>'bridgeName', bridge_version = p_metadata->>'bridgeVersion',
    bridge_machine_id = requested_installation_key, bridge_machine_name = p_metadata->>'machineName',
    status = 'bridge_connected', last_heartbeat_at = now(), last_tested_at = null,
    last_tally_reachable = false, last_company_loaded = false, last_company_name = null,
    last_companies_snapshot = '[]'::jsonb, active_company_guid = null, last_error = null
    where id = c.id returning * into c;
  return to_jsonb(c);
end $$;
revoke all on function public.pair_tally_installation(uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.pair_tally_installation(uuid,text,text,text,jsonb) to service_role;

-- New connection-scoped writes carry immutable dataset identity. This does NOT
-- backfill historic rows using today's active company.
create function public.stamp_tally_dataset()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare c public.tally_connections; d public.tally_company_datasets; row_json jsonb;
  requested_name text; matches integer; target jsonb;
begin
  row_json := to_jsonb(new);
  -- Bulk master upload resolves the dataset once in the authenticated endpoint;
  -- the composite FK checks ownership without 12,000 per-row routing queries.
  if tg_table_name = 'tally_masters' and new.company_dataset_id is not null then return new; end if;
  select * into c from public.tally_connections where id = (row_json->>'connection_id')::uuid
    and owner_user_id = (row_json->>'owner_user_id')::uuid and revoked_at is null;
  if not found or c.installation_ref is null then raise exception 'Pair the upgraded connector before writing Tally data'; end if;
  requested_name := coalesce(nullif(row_json->>'company_name',''), nullif(row_json#>>'{payload,companyName}',''), c.last_company_name);
  select count(*) into matches from public.tally_company_datasets where installation_id = c.installation_ref and company_name = requested_name;
  if matches <> 1 then raise exception 'Missing or ambiguous Tally company GUID'; end if;
  select * into d from public.tally_company_datasets where installation_id = c.installation_ref and company_name = requested_name;
  if row_json->>'company_dataset_id' is not null and (row_json->>'company_dataset_id')::uuid <> d.id then
    raise exception 'Dataset does not match this installation and company';
  end if;
  new := jsonb_populate_record(new, jsonb_build_object('company_dataset_id', d.id));
  if tg_table_name = 'tally_bridge_commands' then
    target := jsonb_build_object('installationId', c.installation_ref, 'companyDatasetId', d.id,
      'connectionId', c.id, 'sessionGeneration', c.session_generation, 'companyGuid', d.company_guid, 'companyName', d.company_name);
    if new.payload ? 'target' and new.payload->'target' <> target then raise exception 'The requested Tally session has changed'; end if;
    new.target_session_generation := c.session_generation;
    new.payload := (new.payload - 'tallyUrl') || jsonb_build_object('target', target, 'companyName', d.company_name);
  end if;
  return new;
end $$;
revoke all on function public.stamp_tally_dataset() from public, anon, authenticated;
grant execute on function public.stamp_tally_dataset() to service_role;
do $triggers$
declare t text;
begin
  foreach t in array array['tally_bridge_commands','tally_masters','tally_mapping_settings','tally_master_sync_runs','debit_note_proposals'] loop
    if to_regclass('public.' || t) is not null then
      execute format('create trigger stamp_tally_dataset before insert on public.%I for each row execute function public.stamp_tally_dataset()', t);
    end if;
  end loop;
end $triggers$;

-- The shared login alone must not bypass the scoped HTTP endpoints through
-- Supabase REST. The server checks the browser binding before using service_role.
do $grants$
declare t text;
begin
  foreach t in array array['tally_connections','tally_connection_events','tally_bridge_commands','tally_masters','tally_mapping_settings','tally_master_sync_runs','bank_accounts','bank_statement_imports','bank_transactions','bank_transaction_posting_log','bank_statement_tally_queue_jobs','bank_statement_extraction_jobs','bank_statement_preview_transactions','debit_note_proposals'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on public.%I from public, anon, authenticated', t);
    end if;
  end loop;
end $grants$;

-- Browser roles cannot bypass the bound API through Storage's owner policies.
-- Restrictive policies compose with existing permissive policies; other buckets
-- remain unaffected. Signed URLs are issued by the scoped document endpoints.
create policy tally_documents_api_only on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id not in ('bank-statement-files', 'debit-note-pdfs'))
  with check (bucket_id not in ('bank-statement-files', 'debit-note-pdfs'));
update storage.buckets set public = false where id in ('bank-statement-files', 'debit-note-pdfs');

-- Queue insertion and transaction/log checkpoints become visible together.
create function public.enqueue_bank_tally_commands(p_owner uuid, p_connection uuid, p_dataset uuid,
  p_generation bigint, p_commands jsonb)
returns setof public.tally_bridge_commands language plpgsql security invoker set search_path = public, pg_temp as $$
declare c public.tally_connections; item jsonb; q public.tally_bridge_commands;
  tx public.bank_transactions; previous public.bank_transaction_posting_log;
begin
  select * into c from public.tally_connections where id = p_connection and owner_user_id = p_owner
    and revoked_at is null and session_generation = p_generation for update;
  if not found then raise exception 'Connector session changed'; end if;
  if jsonb_array_length(p_commands) > 1000 then raise exception 'Too many commands'; end if;
  for item in select value from jsonb_array_elements(p_commands) loop
    if item->>'command_type' in ('post_bank_voucher', 'verify_bank_transaction') then
      select * into tx from public.bank_transactions where id = (item#>>'{payload,transactionId}')::uuid
        and owner_user_id = p_owner and company_dataset_id = p_dataset for update;
      if not found then raise exception 'Transaction outside selected company'; end if;
      select * into previous from public.bank_transaction_posting_log
        where owner_user_id = p_owner and bank_account_id = tx.bank_account_id and fingerprint = tx.fingerprint for update;
      if found and previous.status in ('queued','posted','verified','needs_tally_review') then
        raise exception 'Transaction already queued, posted, or awaiting reconciliation';
      end if;
    end if;
    insert into public.tally_bridge_commands(connection_id, owner_user_id, company_dataset_id,
      command_type, status, priority, payload)
    values(c.id,p_owner,p_dataset,item->>'command_type','queued',coalesce((item->>'priority')::integer,100),item->'payload')
    returning * into q;
    if q.command_type in ('post_bank_voucher','verify_bank_transaction') then
      insert into public.bank_transaction_posting_log(owner_user_id,company_dataset_id,bank_account_id,
        connection_id,source_transaction_id,fingerprint,transaction_date,reference_number,description,
        debit_amount,credit_amount,amount,voucher_type,bank_ledger_name,counterparty_ledger_name,command_id,status)
      values(p_owner,p_dataset,tx.bank_account_id,c.id,tx.id,tx.fingerprint,tx.transaction_date,
        tx.reference_number,tx.description,tx.debit_amount,tx.credit_amount,(q.payload->>'amount')::numeric,
        q.payload->>'voucherType',q.payload->>'bankLedgerName',q.payload->>'counterpartyLedgerName',q.id,'queued')
      on conflict(owner_user_id,bank_account_id,fingerprint) do update set
        company_dataset_id=excluded.company_dataset_id, connection_id=excluded.connection_id,
        command_id=excluded.command_id,status='queued',error=null,result='{}'::jsonb;
      update public.bank_transactions set tally_status=case when q.command_type='post_bank_voucher' then 'pending' else 'checking_in_tally' end,
        confirmed_ledger_name=coalesce(q.payload->>'matchedLedgerName',q.payload->>'counterpartyLedgerName',confirmed_ledger_name),
        ledger_mapping_source='queue_confirmation' where id=tx.id;
      update public.bank_accounts set tally_connection_id=c.id,tally_ledger_name=q.payload->>'bankLedgerName'
        where id=tx.bank_account_id and owner_user_id=p_owner and company_dataset_id=p_dataset;
    end if;
    return next q;
  end loop;
end $$;
revoke all on function public.enqueue_bank_tally_commands(uuid,uuid,uuid,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_bank_tally_commands(uuid,uuid,uuid,bigint,jsonb) to service_role;

create function public.enqueue_debit_note_proposal(p_owner uuid,p_proposal uuid,p_connection uuid,p_target jsonb,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare c public.tally_connections; p record; q public.tally_bridge_commands;
begin
  -- A generic record avoids a compile-time dependency on the optional table.
  -- If the module is installed later, require its isolation trigger as well.
  if to_regclass('public.debit_note_proposals') is null or not exists (
    select 1 from pg_trigger where tgrelid=to_regclass('public.debit_note_proposals')
      and tgname='stamp_tally_dataset' and not tgisinternal and tgenabled in ('O','A')
  ) then
    raise exception 'Saved debit-note proposals require schema and dataset isolation setup before approval'
      using errcode='55000';
  end if;
  select * into c from public.tally_connections where id=p_connection and owner_user_id=p_owner
    and revoked_at is null and session_generation=(p_target->>'sessionGeneration')::bigint for update;
  if not found then raise exception 'Connector session changed'; end if;
  select * into p from public.debit_note_proposals where id=p_proposal and owner_user_id=p_owner
    and company_dataset_id=(p_target->>'companyDatasetId')::uuid for update;
  if not found or p.status not in ('draft','pending_approval','failed') then
    raise exception 'Proposal is missing or already approved';
  end if;
  if p.tally_command_id is not null and exists(select 1 from public.tally_bridge_commands
    where id=p.tally_command_id and (reconciliation_required or status in ('queued','claimed','succeeded'))) then
    raise exception 'Read back the previous Tally command before approving again';
  end if;
  insert into public.tally_bridge_commands(connection_id,owner_user_id,company_dataset_id,command_type,status,priority,payload)
    values(c.id,p_owner,p.company_dataset_id,'create_debit_note','queued',35,p_payload||jsonb_build_object('target',p_target))
    returning * into q;
  update public.debit_note_proposals set status='queued_in_tally',connection_id=c.id,
    approval_by=p_owner,approved_at=now(),tally_command_id=q.id,last_error=null where id=p.id returning * into p;
  return jsonb_build_object('command',to_jsonb(q),'proposal',to_jsonb(p));
end $$;
revoke all on function public.enqueue_debit_note_proposal(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_debit_note_proposal(uuid,uuid,uuid,jsonb,jsonb) to service_role;

-- Result acceptance is fenced against a reconnect in the same transaction.
-- Repeated ACKs may complete non-financial follow-up work, never re-import.
create function public.complete_tally_command(p_connection uuid,p_token_hash text,p_command uuid,
  p_claim uuid,p_success boolean,p_result jsonb,p_error text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare c public.tally_connections; q public.tally_bridge_commands; next_status text; voucher_id text;
begin
  select * into c from public.tally_connections where id=p_connection and bridge_token_hash=p_token_hash
    and revoked_at is null for share;
  if not found then raise exception 'Connector session changed'; end if;
  select * into q from public.tally_bridge_commands where id=p_command and connection_id=c.id
    and owner_user_id=c.owner_user_id and claim_token=p_claim and target_session_generation=c.session_generation for update;
  if not found then raise exception 'Stale command claim'; end if;
  if q.status in ('succeeded','failed') then
    if q.result is distinct from p_result or (q.status='succeeded') is distinct from p_success then
      raise exception 'Conflicting command result';
    end if;
    return to_jsonb(q);
  end if;
  if q.status <> 'claimed' then raise exception 'Command is not claimed'; end if;
  if q.command_type='post_bank_voucher' then
    next_status := case when p_success then 'posted'
      when coalesce((p_result->>'possibleDuplicateInTally')::boolean,false)
        or coalesce((p_result->>'reconciliationRequired')::boolean,false) then 'needs_tally_review' else 'failed' end;
    voucher_id := coalesce(nullif(p_result->>'voucherId',''),nullif(p_result->>'masterId',''),q.id::text);
    update public.bank_transactions set tally_status=next_status,
      tally_posted_at=case when p_success then now() else null end,
      tally_voucher_id=case when p_success then voucher_id else null end
      where id=(q.payload->>'transactionId')::uuid and owner_user_id=q.owner_user_id and company_dataset_id=q.company_dataset_id;
    if not found then raise exception 'Missing transaction checkpoint'; end if;
    update public.bank_transaction_posting_log set status=next_status,result=p_result,error=p_error,
      tally_posted_at=case when p_success then now() else null end,
      tally_voucher_id=case when p_success then voucher_id else null end
      where command_id=q.id and owner_user_id=q.owner_user_id and company_dataset_id=q.company_dataset_id;
    if not found then raise exception 'Missing posting log checkpoint'; end if;
  end if;
  if q.command_type='create_debit_note' and coalesce(q.payload->>'operation','')<>'export_native_pdf'
    and nullif(q.payload->>'proposalId','') is not null then
    if to_regclass('public.debit_note_proposals') is null then
      raise exception 'Missing proposal schema; retain this command for reconciliation'
        using errcode='55000';
    end if;
    update public.debit_note_proposals set status=case when p_success then 'created_in_tally' else 'failed' end,
      tally_voucher_id=case when p_success then coalesce(p_result->>'voucherId',p_result->>'masterId',q.id::text) else null end,
      tally_voucher_guid=case when p_success then coalesce(p_result->>'voucherGuid',p_result->>'guid') else null end,
      tally_voucher_number=case when p_success then coalesce(p_result->>'voucherNumber',q.payload->>'referenceNumber',q.id::text) else null end,
      tally_voucher_date=case when p_success then coalesce(p_result->>'voucherDate',q.payload->>'voucherDate')::date else null end,
      last_error=case when p_success then null else p_error end
    where id=(q.payload->>'proposalId')::uuid and owner_user_id=q.owner_user_id
      and company_dataset_id=q.company_dataset_id and tally_command_id=q.id;
    if not found then raise exception 'Missing proposal checkpoint'; end if;
  end if;
  update public.tally_bridge_commands set status=case when p_success then 'succeeded' else 'failed' end,
    result=p_result,error=p_error,payload=p_payload,completed_at=now(),lease_expires_at=null,
    reconciliation_required=coalesce((p_result->>'reconciliationRequired')::boolean,false)
    where id=q.id returning * into q;
  return to_jsonb(q);
end $$;
revoke all on function public.complete_tally_command(uuid,text,uuid,uuid,boolean,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.complete_tally_command(uuid,text,uuid,uuid,boolean,jsonb,text,jsonb) to service_role;

commit;
