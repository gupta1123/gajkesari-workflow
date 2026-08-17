-- Bank statement analysis must use masters from the company currently open in Tally.
-- This is intentionally bank-only: it scopes existing master and mapping rows without
-- introducing purchase-invoice tables or other workflows.

alter table public.tally_masters
  add column if not exists company_name text;

update public.tally_masters as master
set company_name = coalesce(
  (
    select sync_run.company_name
    from public.tally_master_sync_runs as sync_run
    where sync_run.id = master.sync_run_id
  ),
  connection.last_company_name,
  'Unknown company'
)
from public.tally_connections as connection
where connection.id = master.connection_id
  and (master.company_name is null or btrim(master.company_name) = '');

update public.tally_masters
set company_name = 'Unknown company'
where company_name is null or btrim(company_name) = '';

alter table public.tally_masters
  alter column company_name set default 'Unknown company',
  alter column company_name set not null;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.tally_masters'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%connection_id%master_type%master_key%'
  loop
    execute format('alter table public.tally_masters drop constraint %I', constraint_name);
  end loop;
end
$$;

alter table public.tally_masters
  drop constraint if exists tally_masters_connection_company_type_key_unique;

alter table public.tally_masters
  add constraint tally_masters_connection_company_type_key_unique
  unique (connection_id, company_name, master_type, master_key);

create index if not exists tally_masters_connection_company_active_idx
  on public.tally_masters(connection_id, company_name, master_type, is_active);

alter table public.tally_mapping_settings
  add column if not exists company_name text;

update public.tally_mapping_settings as mapping
set company_name = coalesce(connection.last_company_name, 'Unknown company')
from public.tally_connections as connection
where connection.id = mapping.connection_id
  and (mapping.company_name is null or btrim(mapping.company_name) = '');

update public.tally_mapping_settings
set company_name = 'Unknown company'
where company_name is null or btrim(company_name) = '';

alter table public.tally_mapping_settings
  alter column company_name set default 'Unknown company',
  alter column company_name set not null;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.tally_mapping_settings'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%connection_id%mapping_type%source_key%'
  loop
    execute format('alter table public.tally_mapping_settings drop constraint %I', constraint_name);
  end loop;
end
$$;

alter table public.tally_mapping_settings
  drop constraint if exists tally_mapping_settings_mapping_type_check,
  drop constraint if exists tally_mapping_settings_connection_company_type_source_unique;

alter table public.tally_mapping_settings
  add constraint tally_mapping_settings_mapping_type_check
  check (
    mapping_type in (
      'supplier_gstin',
      'buyer_gstin',
      'item_hsn',
      'item_description',
      'gst_rate',
      'freight_ledger',
      'round_off_ledger',
      'voucher_type',
      'bank_account_ledger',
      'bank_narration_ledger',
      'bank_category_ledger'
    )
  ),
  add constraint tally_mapping_settings_connection_company_type_source_unique
  unique (connection_id, company_name, mapping_type, source_key);

