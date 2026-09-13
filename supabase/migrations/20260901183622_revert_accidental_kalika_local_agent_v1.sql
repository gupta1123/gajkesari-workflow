-- MANUAL APPLICATION ONLY.
--
-- Reverses the Kalika Local Agent v1 migration that was accidentally applied
-- to the Gajkesari Supabase project. This migration is deliberately limited to
-- objects introduced by 202609010001_kalika_local_agent_v1.sql.
--
-- Safety properties:
--   * aborts if any Local Agent dataset or v1 protocol activity exists;
--   * does not use CASCADE;
--   * preserves Gajkesari's installation/dataset/session schema, including
--     tally_installations, tally_company_datasets, installation_ref,
--     active_company_guid, target_session_generation and company_dataset_id;
--   * runs in one transaction, so any dependency/error rolls everything back.

begin;

do $preflight$
declare
  dataset_rows bigint := 0;
  v1_connections bigint := 0;
  v1_commands bigint := 0;
begin
  if to_regclass('public.tally_connections') is null
     or to_regclass('public.tally_bridge_commands') is null then
    raise exception
      'Rollback stopped: required Gajkesari Tally tables are missing.';
  end if;

  if to_regclass('public.tally_agent_datasets') is not null then
    select count(*) into dataset_rows
      from public.tally_agent_datasets;
  end if;

  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'tally_connections'
       and column_name = 'agent_protocol_version'
  ) then
    select count(*) into v1_connections
      from public.tally_connections
     where coalesce(agent_protocol_version, 0) <> 0
        or agent_version is not null
        or agent_last_seen_at is not null
        or tdl_version is not null
        or local_schema_version is not null
        or coalesce(agent_capabilities, '[]'::jsonb) <> '[]'::jsonb
        or coalesce(agent_status, '{}'::jsonb) <> '{}'::jsonb;
  end if;

  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'tally_bridge_commands'
       and column_name = 'protocol_version'
  ) then
    select count(*) into v1_commands
      from public.tally_bridge_commands
     where coalesce(protocol_version, 0) <> 0
        or job_class is not null
        or deadline_at is not null
        or agent_receipt is not null
        or external_result_reference is not null
        or coalesce(compact_progress, '{}'::jsonb) <> '{}'::jsonb;
  end if;

  if dataset_rows <> 0 or v1_connections <> 0 or v1_commands <> 0 then
    raise exception
      'Rollback stopped: Local Agent data/activity now exists (datasets=%, connections=%, commands=%).',
      dataset_rows, v1_connections, v1_commands
      using hint = 'Review and intentionally migrate/archive that data before retrying.';
  end if;

  raise notice
    'Local Agent rollback preflight passed (datasets=%, connections=%, commands=%).',
    dataset_rows, v1_connections, v1_commands;
end
$preflight$;

-- Remove the writer before removing its function or target columns.
drop trigger if exists tally_bridge_commands_agent_identity
  on public.tally_bridge_commands;

drop function if exists public.populate_tally_agent_command_identity();

-- The table was empty when inspected. No CASCADE is used: an unexpected
-- dependency will safely stop and roll back this migration.
drop table if exists public.tally_agent_datasets;

-- Explicit index cleanup keeps the rollback correct even if a partially
-- applied forward migration did not create all columns.
drop index if exists public.tally_connections_agent_identity_idx;
drop index if exists public.tally_bridge_commands_agent_claim_idx;
drop index if exists public.tally_bridge_commands_agent_dataset_idx;

alter table public.tally_bridge_commands
  drop column if exists organization_id,
  drop column if exists installation_id,
  drop column if exists session_generation,
  drop column if exists company_guid,
  drop column if exists company_name,
  drop column if exists financial_year,
  drop column if exists protocol_version,
  drop column if exists job_class,
  drop column if exists deadline_at,
  drop column if exists compact_progress,
  drop column if exists agent_receipt,
  drop column if exists external_result_reference;

alter table public.tally_connections
  drop column if exists organization_id,
  drop column if exists agent_protocol_version,
  drop column if exists agent_version,
  drop column if exists agent_capabilities,
  drop column if exists agent_status,
  drop column if exists agent_last_seen_at,
  drop column if exists tdl_version,
  drop column if exists local_schema_version;

-- Fail closed if any accidental object survived because the migration was
-- edited incorrectly. This also documents the expected post-rollback state.
do $verify$
declare
  leftover text;
begin
  select string_agg(object_name, ', ' order by object_name)
    into leftover
    from (
      select 'table public.tally_agent_datasets' as object_name
       where to_regclass('public.tally_agent_datasets') is not null
      union all
      select 'function public.populate_tally_agent_command_identity()'
       where to_regprocedure('public.populate_tally_agent_command_identity()') is not null
      union all
      select format('column public.%I.%I', table_name, column_name)
        from information_schema.columns
       where table_schema = 'public'
         and (
           (table_name = 'tally_connections' and column_name = any (array[
             'organization_id', 'agent_protocol_version', 'agent_version',
             'agent_capabilities', 'agent_status', 'agent_last_seen_at',
             'tdl_version', 'local_schema_version'
           ]))
           or
           (table_name = 'tally_bridge_commands' and column_name = any (array[
             'organization_id', 'installation_id', 'session_generation',
             'company_guid', 'company_name', 'financial_year',
             'protocol_version', 'job_class', 'deadline_at',
             'compact_progress', 'agent_receipt',
             'external_result_reference'
           ]))
         )
    ) leftovers;

  if leftover is not null then
    raise exception 'Rollback verification failed; accidental objects remain: %', leftover;
  end if;

  raise notice 'Kalika Local Agent v1 objects were removed from Gajkesari.';
end
$verify$;

commit;
