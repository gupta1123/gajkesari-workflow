-- Combined all-in-one Supabase migration for Gajkesari workflow.
-- Generated from existing migration files in dependency order.
-- Run this once in Supabase SQL Editor on a fresh/empty Gajkesari Supabase project.
-- If Supabase warns about potential issues, choose Run without RLS; RLS is handled explicitly inside these migrations.

-- ============================================================
-- 01. packet_processing_backend_v1.sql
-- ============================================================
create or replace function public.set_packet_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.packet_cases (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  display_name text not null,
  buyer_name text,
  po_number text,
  invoice_number text,
  status text not null default 'completed' check (status in ('processing', 'completed', 'failed')),
  risk_score integer not null default 0 check (risk_score between 0 and 100),
  upload_count integer not null default 0,
  document_count integer not null default 0,
  mismatch_count integer not null default 0,
  processing_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.packet_case_files (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  original_name text not null,
  storage_bucket text not null default 'packet-files',
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.packet_documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  client_document_id text,
  source_file_name text,
  source_hint text,
  document_type text not null,
  title text not null,
  page_count integer not null default 0,
  extracted_fields jsonb not null default '{}'::jsonb,
  markdown text not null default '',
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.packet_mismatches (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  client_mismatch_id text,
  field_name text not null,
  values_json jsonb not null default '[]'::jsonb,
  analysis text,
  fix_plan text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists packet_cases_created_at_idx on public.packet_cases (created_at desc);
create index if not exists packet_cases_slug_idx on public.packet_cases (slug);
create index if not exists packet_case_files_case_id_idx on public.packet_case_files (case_id);
create index if not exists packet_documents_case_id_idx on public.packet_documents (case_id);
create index if not exists packet_documents_document_type_idx on public.packet_documents (document_type);
create index if not exists packet_mismatches_case_id_idx on public.packet_mismatches (case_id);

alter table public.packet_cases enable row level security;
alter table public.packet_case_files enable row level security;
alter table public.packet_documents enable row level security;
alter table public.packet_mismatches enable row level security;

drop trigger if exists set_packet_cases_updated_at on public.packet_cases;
create trigger set_packet_cases_updated_at
before update on public.packet_cases
for each row
execute function public.set_packet_updated_at();

insert into storage.buckets (id, name, public)
values ('packet-files', 'packet-files', false)
on conflict (id) do update
set public = excluded.public;

-- ============================================================
-- 02. tally_connections_backend_v1.sql
-- ============================================================
create extension if not exists pgcrypto;

create or replace function public.set_packet_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.tally_connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Tally Prime',
  status text not null default 'waiting_for_bridge'
    check (
      status in (
        'not_connected',
        'waiting_for_bridge',
        'bridge_connected',
        'tally_reachable',
        'company_loaded',
        'connection_error'
      )
    ),
  tally_url text not null default 'http://localhost:9000',
  pairing_code_hash text,
  pairing_code_expires_at timestamptz,
  paired_at timestamptz,
  bridge_token_hash text,
  bridge_name text,
  bridge_version text,
  bridge_machine_id text,
  last_heartbeat_at timestamptz,
  last_tested_at timestamptz,
  last_tally_reachable boolean,
  last_company_loaded boolean,
  last_company_name text,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tally_connection_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists tally_connections_owner_status_idx
on public.tally_connections (owner_user_id, status);

create index if not exists tally_connections_owner_updated_idx
on public.tally_connections (owner_user_id, updated_at desc);

create index if not exists tally_connections_pairing_expiry_idx
on public.tally_connections (pairing_code_expires_at)
where pairing_code_hash is not null;

create index if not exists tally_connections_last_heartbeat_idx
on public.tally_connections (last_heartbeat_at desc)
where bridge_token_hash is not null;

create index if not exists tally_connection_events_connection_created_idx
on public.tally_connection_events (connection_id, created_at desc);

create index if not exists tally_connection_events_owner_created_idx
on public.tally_connection_events (owner_user_id, created_at desc);

alter table public.tally_connections enable row level security;
alter table public.tally_connection_events enable row level security;

drop trigger if exists set_tally_connections_updated_at on public.tally_connections;
create trigger set_tally_connections_updated_at
before update on public.tally_connections
for each row
execute function public.set_packet_updated_at();

drop policy if exists "tally_connections_owner_select" on public.tally_connections;
create policy "tally_connections_owner_select"
on public.tally_connections
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_connections_owner_insert" on public.tally_connections;
create policy "tally_connections_owner_insert"
on public.tally_connections
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "tally_connections_owner_update" on public.tally_connections;
create policy "tally_connections_owner_update"
on public.tally_connections
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "tally_connections_owner_delete" on public.tally_connections;
create policy "tally_connections_owner_delete"
on public.tally_connections
for delete
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_connection_events_owner_select" on public.tally_connection_events;
create policy "tally_connection_events_owner_select"
on public.tally_connection_events
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_connection_events_owner_insert" on public.tally_connection_events;
create policy "tally_connection_events_owner_insert"
on public.tally_connection_events
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  and exists (
    select 1
    from public.tally_connections
    where public.tally_connections.id = tally_connection_events.connection_id
      and public.tally_connections.owner_user_id = auth.uid()
  )
);

-- ============================================================
-- 03. tally_master_sync_backend_v2.sql
-- ============================================================
create table if not exists public.tally_master_sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'completed'
    check (status in ('completed', 'failed')),
  company_name text,
  bridge_version text,
  totals jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tally_masters (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  sync_run_id uuid references public.tally_master_sync_runs(id) on delete set null,
  master_type text not null
    check (
      master_type in (
        'ledger',
        'group',
        'stock_item',
        'unit',
        'voucher_type',
        'gst_ledger',
        'tax_ledger'
      )
    ),
  master_key text not null,
  tally_guid text,
  tally_name text not null,
  parent_name text,
  gstin text,
  hsn_code text,
  unit_name text,
  tax_rate numeric,
  raw_payload jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  last_synced_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (connection_id, master_type, master_key)
);

create table if not exists public.tally_mapping_settings (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  mapping_type text not null
    check (
      mapping_type in (
        'supplier_gstin',
        'buyer_gstin',
        'item_hsn',
        'item_description',
        'gst_rate',
        'freight_ledger',
        'round_off_ledger',
        'voucher_type'
      )
    ),
  source_key text not null,
  source_label text not null,
  target_master_type text not null,
  target_master_key text not null,
  target_master_name text not null,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (connection_id, mapping_type, source_key)
);

create index if not exists tally_master_sync_runs_connection_created_idx
on public.tally_master_sync_runs (connection_id, created_at desc);

create index if not exists tally_masters_connection_type_name_idx
on public.tally_masters (connection_id, master_type, tally_name);

create index if not exists tally_masters_connection_type_active_idx
on public.tally_masters (connection_id, master_type, is_active);

create index if not exists tally_masters_owner_updated_idx
on public.tally_masters (owner_user_id, updated_at desc);

create index if not exists tally_mapping_settings_connection_type_idx
on public.tally_mapping_settings (connection_id, mapping_type, updated_at desc);

alter table public.tally_master_sync_runs enable row level security;
alter table public.tally_masters enable row level security;
alter table public.tally_mapping_settings enable row level security;

drop trigger if exists set_tally_masters_updated_at on public.tally_masters;
create trigger set_tally_masters_updated_at
before update on public.tally_masters
for each row
execute function public.set_packet_updated_at();

drop trigger if exists set_tally_mapping_settings_updated_at on public.tally_mapping_settings;
create trigger set_tally_mapping_settings_updated_at
before update on public.tally_mapping_settings
for each row
execute function public.set_packet_updated_at();

drop policy if exists "tally_master_sync_runs_owner_select" on public.tally_master_sync_runs;
create policy "tally_master_sync_runs_owner_select"
on public.tally_master_sync_runs
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_masters_owner_select" on public.tally_masters;
create policy "tally_masters_owner_select"
on public.tally_masters
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_mapping_settings_owner_select" on public.tally_mapping_settings;
create policy "tally_mapping_settings_owner_select"
on public.tally_mapping_settings
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_mapping_settings_owner_insert" on public.tally_mapping_settings;
create policy "tally_mapping_settings_owner_insert"
on public.tally_mapping_settings
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  and exists (
    select 1
    from public.tally_connections
    where public.tally_connections.id = tally_mapping_settings.connection_id
      and public.tally_connections.owner_user_id = auth.uid()
  )
);

drop policy if exists "tally_mapping_settings_owner_update" on public.tally_mapping_settings;
create policy "tally_mapping_settings_owner_update"
on public.tally_mapping_settings
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "tally_mapping_settings_owner_delete" on public.tally_mapping_settings;
create policy "tally_mapping_settings_owner_delete"
on public.tally_mapping_settings
for delete
to authenticated
using (owner_user_id = auth.uid());

-- ============================================================
-- 04. tally_bridge_commands_backend_v3.sql
-- ============================================================
create table if not exists public.tally_bridge_commands (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  command_type text not null
    check (
      command_type in (
        'alter_ledger'
      )
    ),
  status text not null default 'queued'
    check (
      status in (
        'queued',
        'claimed',
        'succeeded',
        'failed',
        'canceled'
      )
    ),
  priority integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default timezone('utc', now()),
  claimed_at timestamptz,
  completed_at timestamptz,
  bridge_version text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists tally_bridge_commands_connection_status_idx
on public.tally_bridge_commands (connection_id, status, available_at, created_at);

create index if not exists tally_bridge_commands_owner_created_idx
on public.tally_bridge_commands (owner_user_id, created_at desc);

alter table public.tally_bridge_commands enable row level security;

drop trigger if exists set_tally_bridge_commands_updated_at on public.tally_bridge_commands;
create trigger set_tally_bridge_commands_updated_at
before update on public.tally_bridge_commands
for each row
execute function public.set_packet_updated_at();

drop policy if exists "tally_bridge_commands_owner_select" on public.tally_bridge_commands;
create policy "tally_bridge_commands_owner_select"
on public.tally_bridge_commands
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "tally_bridge_commands_owner_insert" on public.tally_bridge_commands;
create policy "tally_bridge_commands_owner_insert"
on public.tally_bridge_commands
for insert
to authenticated
with check (
  owner_user_id = auth.uid()
  and exists (
    select 1
    from public.tally_connections
    where public.tally_connections.id = tally_bridge_commands.connection_id
      and public.tally_connections.owner_user_id = auth.uid()
  )
);

drop policy if exists "tally_bridge_commands_owner_update_cancel" on public.tally_bridge_commands;
create policy "tally_bridge_commands_owner_update_cancel"
on public.tally_bridge_commands
for update
to authenticated
using (owner_user_id = auth.uid())
with check (
  owner_user_id = auth.uid()
  and status in ('queued', 'canceled')
);

-- ============================================================
-- 05. bank_statement_imports_backend_v1.sql
-- ============================================================
create extension if not exists pgcrypto;

create or replace function public.set_packet_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  bank_name text,
  account_number_normalized text not null,
  account_number_masked text not null,
  account_holder_name text,
  tally_connection_id uuid references public.tally_connections(id) on delete set null,
  tally_master_id uuid references public.tally_masters(id) on delete set null,
  tally_ledger_name text,
  last_imported_transaction_at timestamptz,
  last_imported_transaction_marker jsonb not null default '{}'::jsonb,
  last_tally_posted_transaction_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (owner_user_id, account_number_normalized)
);

create table if not exists public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  original_file_name text not null,
  storage_bucket text not null default 'bank-statement-files',
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint,
  statement_period_start date,
  statement_period_end date,
  extracted_bank_name text,
  extracted_account_number text,
  extracted_account_holder_name text,
  status text not null default 'extracted'
    check (
      status in (
        'extracted',
        'needs_account_selection',
        'ready_to_confirm',
        'imported',
        'failed'
      )
    ),
  imported_transaction_count integer not null default 0,
  duplicate_transaction_count integer not null default 0,
  processing_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  statement_import_id uuid references public.bank_statement_imports(id) on delete set null,
  transaction_date date not null,
  value_date date,
  description text not null,
  reference_number text,
  debit_amount numeric,
  credit_amount numeric,
  balance_amount numeric,
  transaction_type text not null default 'unknown',
  category text not null default 'unknown',
  additional_charges jsonb not null default '[]'::jsonb,
  confidence numeric,
  raw_payload jsonb not null default '{}'::jsonb,
  fingerprint text not null,
  tally_status text not null default 'not_ready'
    check (tally_status in ('not_ready', 'pending', 'posted', 'failed', 'skipped')),
  tally_posted_at timestamptz,
  tally_voucher_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (owner_user_id, bank_account_id, fingerprint)
);

create table if not exists public.bank_transaction_posting_log (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  connection_id uuid references public.tally_connections(id) on delete set null,
  source_transaction_id uuid,
  fingerprint text not null,
  transaction_date date not null,
  reference_number text,
  description text not null,
  debit_amount numeric,
  credit_amount numeric,
  amount numeric,
  voucher_type text,
  bank_ledger_name text,
  counterparty_ledger_name text,
  command_id uuid references public.tally_bridge_commands(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'posted', 'failed', 'canceled')),
  tally_voucher_id text,
  tally_posted_at timestamptz,
  error text,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (owner_user_id, bank_account_id, fingerprint)
);

create index if not exists bank_accounts_owner_updated_idx
on public.bank_accounts (owner_user_id, updated_at desc);

create index if not exists bank_accounts_owner_holder_idx
on public.bank_accounts (owner_user_id, lower(coalesce(account_holder_name, '')));

create index if not exists bank_statement_imports_owner_created_idx
on public.bank_statement_imports (owner_user_id, created_at desc);

create index if not exists bank_statement_imports_account_created_idx
on public.bank_statement_imports (bank_account_id, created_at desc);

create index if not exists bank_transactions_account_date_idx
on public.bank_transactions (bank_account_id, transaction_date desc, created_at desc);

create index if not exists bank_transactions_owner_tally_idx
on public.bank_transactions (owner_user_id, tally_status, transaction_date desc);

create index if not exists bank_transaction_posting_log_account_status_idx
on public.bank_transaction_posting_log (bank_account_id, status, transaction_date desc);

create index if not exists bank_transaction_posting_log_owner_posted_idx
on public.bank_transaction_posting_log (owner_user_id, status, tally_posted_at desc);

drop trigger if exists set_bank_accounts_updated_at on public.bank_accounts;
create trigger set_bank_accounts_updated_at
before update on public.bank_accounts
for each row
execute function public.set_packet_updated_at();

drop trigger if exists set_bank_statement_imports_updated_at on public.bank_statement_imports;
create trigger set_bank_statement_imports_updated_at
before update on public.bank_statement_imports
for each row
execute function public.set_packet_updated_at();

drop trigger if exists set_bank_transactions_updated_at on public.bank_transactions;
create trigger set_bank_transactions_updated_at
before update on public.bank_transactions
for each row
execute function public.set_packet_updated_at();

drop trigger if exists set_bank_transaction_posting_log_updated_at on public.bank_transaction_posting_log;
create trigger set_bank_transaction_posting_log_updated_at
before update on public.bank_transaction_posting_log
for each row
execute function public.set_packet_updated_at();

insert into storage.buckets (id, name, public)
values ('bank-statement-files', 'bank-statement-files', false)
on conflict (id) do update
set public = excluded.public;

alter table public.bank_accounts enable row level security;
alter table public.bank_statement_imports enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.bank_transaction_posting_log enable row level security;

drop policy if exists "bank_accounts_owner_select" on public.bank_accounts;
create policy "bank_accounts_owner_select"
on public.bank_accounts
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "bank_accounts_owner_insert" on public.bank_accounts;
create policy "bank_accounts_owner_insert"
on public.bank_accounts
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "bank_accounts_owner_update" on public.bank_accounts;
create policy "bank_accounts_owner_update"
on public.bank_accounts
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "bank_statement_imports_owner_select" on public.bank_statement_imports;
create policy "bank_statement_imports_owner_select"
on public.bank_statement_imports
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "bank_statement_imports_owner_insert" on public.bank_statement_imports;
create policy "bank_statement_imports_owner_insert"
on public.bank_statement_imports
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "bank_statement_imports_owner_update" on public.bank_statement_imports;
create policy "bank_statement_imports_owner_update"
on public.bank_statement_imports
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "bank_transactions_owner_select" on public.bank_transactions;
create policy "bank_transactions_owner_select"
on public.bank_transactions
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "bank_transactions_owner_insert" on public.bank_transactions;
create policy "bank_transactions_owner_insert"
on public.bank_transactions
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "bank_transactions_owner_update" on public.bank_transactions;
create policy "bank_transactions_owner_update"
on public.bank_transactions
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "bank_transaction_posting_log_owner_select" on public.bank_transaction_posting_log;
create policy "bank_transaction_posting_log_owner_select"
on public.bank_transaction_posting_log
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "bank_transaction_posting_log_owner_insert" on public.bank_transaction_posting_log;
create policy "bank_transaction_posting_log_owner_insert"
on public.bank_transaction_posting_log
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "bank_transaction_posting_log_owner_update" on public.bank_transaction_posting_log;
create policy "bank_transaction_posting_log_owner_update"
on public.bank_transaction_posting_log
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

-- ============================================================
-- 06. packet_auth_backend_v2.sql
-- ============================================================
alter table public.packet_cases
add column if not exists owner_user_id uuid references auth.users(id) on delete cascade;

create index if not exists packet_cases_owner_user_id_idx
on public.packet_cases (owner_user_id);

drop policy if exists "packet_cases_owner_select" on public.packet_cases;
create policy "packet_cases_owner_select"
on public.packet_cases
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "packet_cases_owner_insert" on public.packet_cases;
create policy "packet_cases_owner_insert"
on public.packet_cases
for insert
to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists "packet_cases_owner_update" on public.packet_cases;
create policy "packet_cases_owner_update"
on public.packet_cases
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "packet_cases_owner_delete" on public.packet_cases;
create policy "packet_cases_owner_delete"
on public.packet_cases
for delete
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "packet_case_files_owner_select" on public.packet_case_files;
create policy "packet_case_files_owner_select"
on public.packet_case_files
for select
to authenticated
using (
  exists (
    select 1
    from public.packet_cases
    where public.packet_cases.id = packet_case_files.case_id
      and public.packet_cases.owner_user_id = auth.uid()
  )
);

drop policy if exists "packet_documents_owner_select" on public.packet_documents;
create policy "packet_documents_owner_select"
on public.packet_documents
for select
to authenticated
using (
  exists (
    select 1
    from public.packet_cases
    where public.packet_cases.id = packet_documents.case_id
      and public.packet_cases.owner_user_id = auth.uid()
  )
);

drop policy if exists "packet_mismatches_owner_select" on public.packet_mismatches;
create policy "packet_mismatches_owner_select"
on public.packet_mismatches
for select
to authenticated
using (
  exists (
    select 1
    from public.packet_cases
    where public.packet_cases.id = packet_mismatches.case_id
      and public.packet_cases.owner_user_id = auth.uid()
  )
);

-- ============================================================
-- 07. packet_index_performance_v1.sql
-- ============================================================
-- Index-only performance migration for the current packet workflow.
-- This file is additive only: no table changes, no policy changes, no data changes.
--
-- Rationale:
-- 1. packet case listing queries filter by owner_user_id and sort by created_at desc
-- 2. case detail queries load child rows by case_id and sort by created_at
-- 3. recycle-bin deleted-case queries are already covered by packet_recycle_bin_backend_v3.sql

create index if not exists packet_cases_owner_user_created_at_idx
on public.packet_cases (owner_user_id, created_at desc);

create index if not exists packet_case_files_case_id_created_at_idx
on public.packet_case_files (case_id, created_at);

create index if not exists packet_documents_case_id_created_at_idx
on public.packet_documents (case_id, created_at);

create index if not exists packet_mismatches_case_id_created_at_idx
on public.packet_mismatches (case_id, created_at);

-- ============================================================
-- 08. bank_statement_ledger_matching_backend_v2.sql
-- ============================================================
alter table public.bank_accounts
add column if not exists ifsc_code text;

alter table public.bank_statement_imports
add column if not exists extracted_ifsc_code text;

alter table public.bank_transactions
add column if not exists counterparty_name text,
add column if not exists suggested_ledger_name text,
add column if not exists suggestion_confidence numeric,
add column if not exists suggestion_reason text,
add column if not exists confirmed_ledger_name text,
add column if not exists ledger_mapping_source text;

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.tally_mapping_settings'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%mapping_type%';

  if constraint_name is not null then
    execute format('alter table public.tally_mapping_settings drop constraint %I', constraint_name);
  end if;
end $$;

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
);

create index if not exists bank_accounts_owner_ifsc_idx
on public.bank_accounts (owner_user_id, ifsc_code);

create index if not exists bank_transactions_account_confirmed_ledger_idx
on public.bank_transactions (bank_account_id, confirmed_ledger_name);

-- ============================================================
-- 09. packet_recycle_bin_backend_v3.sql
-- ============================================================
alter table public.packet_cases
add column if not exists deleted_at timestamptz;

alter table public.packet_cases
add column if not exists deleted_by_user_id uuid references auth.users(id) on delete set null;

create index if not exists packet_cases_deleted_at_idx
on public.packet_cases (deleted_at desc);

create index if not exists packet_cases_owner_user_deleted_at_idx
on public.packet_cases (owner_user_id, deleted_at);

-- ============================================================
-- 10. bank_statement_async_extraction_backend_v3.sql
-- ============================================================
do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.bank_statement_imports'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%status%';

  if constraint_name is not null then
    execute format('alter table public.bank_statement_imports drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.bank_statement_imports
add constraint bank_statement_imports_status_check
check (
  status in (
    'processing',
    'ready_to_review',
    'manual_review_required',
    'extracted',
    'needs_account_selection',
    'ready_to_confirm',
    'imported',
    'failed'
  )
);

create table if not exists public.bank_statement_import_preview_transactions (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.bank_statement_imports(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  row_index integer not null,
  transaction_date date not null,
  value_date date,
  description text not null,
  reference_number text,
  debit_amount numeric,
  credit_amount numeric,
  balance_amount numeric,
  transaction_type text not null default 'unknown',
  category text not null default 'unknown',
  counterparty_name text,
  suggested_ledger_name text,
  suggestion_confidence numeric,
  suggestion_reason text,
  confirmed_ledger_name text,
  additional_charges jsonb not null default '[]'::jsonb,
  confidence numeric,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (import_id, row_index)
);

create table if not exists public.bank_statement_extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.bank_statement_imports(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  progress integer not null default 0,
  stage text,
  error text,
  result jsonb not null default '{}'::jsonb,
  locked_at timestamptz,
  locked_by text,
  next_run_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists bank_statement_preview_import_idx
on public.bank_statement_import_preview_transactions (import_id, row_index);

create index if not exists bank_statement_preview_owner_created_idx
on public.bank_statement_import_preview_transactions (owner_user_id, created_at desc);

create index if not exists bank_statement_extraction_jobs_status_next_run_idx
on public.bank_statement_extraction_jobs (status, next_run_at, created_at);

create index if not exists bank_statement_extraction_jobs_import_created_idx
on public.bank_statement_extraction_jobs (import_id, created_at desc);

create index if not exists bank_statement_extraction_jobs_owner_created_idx
on public.bank_statement_extraction_jobs (owner_user_id, created_at desc);

alter table public.bank_statement_import_preview_transactions enable row level security;
alter table public.bank_statement_extraction_jobs enable row level security;

drop policy if exists "bank_statement_preview_owner_select" on public.bank_statement_import_preview_transactions;
create policy "bank_statement_preview_owner_select"
on public.bank_statement_import_preview_transactions
for select
to authenticated
using (owner_user_id = auth.uid());

drop policy if exists "bank_statement_jobs_owner_select" on public.bank_statement_extraction_jobs;
create policy "bank_statement_jobs_owner_select"
on public.bank_statement_extraction_jobs
for select
to authenticated
using (owner_user_id = auth.uid());

drop trigger if exists set_bank_statement_preview_updated_at on public.bank_statement_import_preview_transactions;
create trigger set_bank_statement_preview_updated_at
before update on public.bank_statement_import_preview_transactions
for each row
execute function public.set_packet_updated_at();

drop trigger if exists set_bank_statement_extraction_jobs_updated_at on public.bank_statement_extraction_jobs;
create trigger set_bank_statement_extraction_jobs_updated_at
before update on public.bank_statement_extraction_jobs
for each row
execute function public.set_packet_updated_at();

create or replace function public.claim_bank_statement_extraction_job(
  worker_name text default 'worker',
  stale_after interval default interval '20 minutes'
)
returns public.bank_statement_extraction_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.bank_statement_extraction_jobs;
begin
  update public.bank_statement_extraction_jobs
  set status = 'queued',
      progress = 0,
      stage = 'Queued after stale worker run',
      error = coalesce(error, 'Worker lock expired before completion.'),
      locked_at = null,
      locked_by = null,
      next_run_at = now(),
      updated_at = now()
  where status = 'running'
    and locked_at < now() - stale_after
    and attempt_count < max_attempts;

  update public.bank_statement_extraction_jobs
  set status = 'failed',
      progress = 100,
      stage = 'Failed',
      error = coalesce(error, 'Worker lock expired before completion.'),
      locked_at = null,
      locked_by = null,
      finished_at = coalesce(finished_at, now()),
      updated_at = now()
  where status = 'running'
    and locked_at < now() - stale_after
    and attempt_count >= max_attempts;

  select *
  into claimed
  from public.bank_statement_extraction_jobs
  where status = 'queued'
    and next_run_at <= now()
  order by created_at asc
  for update skip locked
  limit 1;

  if claimed.id is null then
    return null;
  end if;

  update public.bank_statement_extraction_jobs
  set status = 'running',
      attempt_count = claimed.attempt_count + 1,
      progress = 5,
      stage = 'Starting extraction',
      error = null,
      locked_at = now(),
      locked_by = worker_name,
      started_at = coalesce(claimed.started_at, now()),
      updated_at = now()
  where id = claimed.id
  returning *
  into claimed;

  return claimed;
end;
$$;

-- ============================================================
-- 11. tally_bridge_commands_sync_masters_v4.sql
-- ============================================================
alter table public.tally_bridge_commands
drop constraint if exists tally_bridge_commands_command_type_check;

alter table public.tally_bridge_commands
add constraint tally_bridge_commands_command_type_check
check (
  command_type in (
    'alter_ledger',
    'sync_masters'
  )
);

-- ============================================================
-- 12. packet_case_decision_backend_v4.sql
-- ============================================================
alter table public.packet_cases
drop constraint if exists packet_cases_status_check;

alter table public.packet_cases
add constraint packet_cases_status_check
check (status in ('draft', 'processing', 'completed', 'accepted', 'rejected', 'failed'));

create index if not exists packet_cases_owner_user_status_idx
on public.packet_cases (owner_user_id, status);

-- ============================================================
-- 13. bank_statement_transaction_checkpoint_backend_v4.sql
-- ============================================================
alter table public.bank_accounts
add column if not exists last_imported_transaction_marker jsonb not null default '{}'::jsonb;

-- ============================================================
-- 14. tally_bridge_commands_bank_voucher_v5.sql
-- ============================================================
alter table public.tally_bridge_commands
drop constraint if exists tally_bridge_commands_command_type_check;

alter table public.tally_bridge_commands
add constraint tally_bridge_commands_command_type_check
check (
  command_type in (
    'alter_ledger',
    'sync_masters',
    'post_bank_voucher'
  )
);

-- ============================================================
-- 15. packet_case_draft_backend_v5.sql
-- ============================================================
alter table public.packet_cases
drop constraint if exists packet_cases_status_check;

alter table public.packet_cases
add constraint packet_cases_status_check
check (status in ('draft', 'processing', 'completed', 'accepted', 'rejected', 'failed'));

create index if not exists packet_cases_owner_user_status_idx
on public.packet_cases (owner_user_id, status);

-- ============================================================
-- 16. tally_bridge_commands_create_ledger_v6.sql
-- ============================================================
do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.tally_bridge_commands'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%command_type%';

  if constraint_name is not null then
    execute format('alter table public.tally_bridge_commands drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.tally_bridge_commands
add constraint tally_bridge_commands_command_type_check
check (
  command_type in (
    'alter_ledger',
    'create_ledger',
    'sync_masters',
    'post_bank_voucher'
  )
);

-- ============================================================
-- 17. packet_settings_backend_v6.sql
-- ============================================================
create extension if not exists pgcrypto;

create table if not exists public.field_settings (
  id uuid default gen_random_uuid() primary key,
  organization_id text default 'default',
  doc_type text not null,
  field_key text not null,
  enabled boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (organization_id, doc_type, field_key)
);

create table if not exists public.doc_type_settings (
  id uuid default gen_random_uuid() primary key,
  organization_id text default 'default',
  doc_type text not null,
  enabled boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (organization_id, doc_type)
);

create index if not exists field_settings_org_doc_type_idx
  on public.field_settings (organization_id, doc_type);

create index if not exists doc_type_settings_org_doc_type_idx
  on public.doc_type_settings (organization_id, doc_type);

-- ============================================================
-- 18. packet_processing_jobs_backend_v7.sql
-- ============================================================
create table if not exists public.packet_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.packet_cases(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null default 'case_analysis',
  status text not null default 'queued',
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  progress integer not null default 0,
  stage text,
  error text,
  result jsonb not null default '{}'::jsonb,
  locked_at timestamptz,
  locked_by text,
  next_run_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packet_processing_jobs_status_check
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

create index if not exists packet_processing_jobs_status_next_run_idx
on public.packet_processing_jobs (status, next_run_at);

create index if not exists packet_processing_jobs_case_created_idx
on public.packet_processing_jobs (case_id, created_at desc);

create index if not exists packet_processing_jobs_owner_created_idx
on public.packet_processing_jobs (owner_user_id, created_at desc);

alter table public.packet_processing_jobs enable row level security;

drop policy if exists "packet_processing_jobs_owner_select" on public.packet_processing_jobs;
create policy "packet_processing_jobs_owner_select"
on public.packet_processing_jobs
for select
to authenticated
using (
  exists (
    select 1
    from public.packet_cases
    where public.packet_cases.id = packet_processing_jobs.case_id
      and public.packet_cases.owner_user_id = auth.uid()
  )
);

drop trigger if exists set_packet_processing_jobs_updated_at on public.packet_processing_jobs;
create trigger set_packet_processing_jobs_updated_at
before update on public.packet_processing_jobs
for each row
execute function public.set_packet_updated_at();

create or replace function public.claim_packet_processing_job(worker_name text default 'worker')
returns public.packet_processing_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.packet_processing_jobs;
begin
  select *
  into claimed
  from public.packet_processing_jobs
  where status = 'queued'
    and next_run_at <= now()
  order by created_at asc
  for update skip locked
  limit 1;

  if claimed.id is null then
    return null;
  end if;

  update public.packet_processing_jobs
  set status = 'running',
      attempt_count = claimed.attempt_count + 1,
      locked_at = now(),
      locked_by = worker_name,
      started_at = coalesce(claimed.started_at, now()),
      updated_at = now()
  where id = claimed.id
  returning *
  into claimed;

  return claimed;
end;
$$;

-- ============================================================
-- 19. tally_bridge_commands_customer_open_bills_v7.sql
-- ============================================================
alter table public.tally_bridge_commands
drop constraint if exists tally_bridge_commands_command_type_check;

alter table public.tally_bridge_commands
add constraint tally_bridge_commands_command_type_check
check (
  command_type in (
    'sync_masters',
    'alter_ledger',
    'create_ledger',
    'post_bank_voucher',
    'fetch_customer_open_bills'
  )
);

-- ============================================================
-- 20. tally_bridge_commands_advance_adjustment_v8.sql
-- ============================================================
alter table public.tally_bridge_commands
drop constraint if exists tally_bridge_commands_command_type_check;

alter table public.tally_bridge_commands
add constraint tally_bridge_commands_command_type_check
check (
  command_type in (
    'sync_masters',
    'alter_ledger',
    'create_ledger',
    'post_bank_voucher',
    'fetch_customer_open_bills',
    'adjust_customer_advance'
  )
);

-- ============================================================
-- 21. packet_mismatch_resolution_backend_v8.sql
-- ============================================================
alter table public.packet_mismatches
add column if not exists resolution_status text not null default 'pending';

alter table public.packet_mismatches
add column if not exists resolved_at timestamptz;

update public.packet_mismatches
set resolution_status = 'pending'
where resolution_status is null;

alter table public.packet_mismatches
drop constraint if exists packet_mismatches_resolution_status_check;

alter table public.packet_mismatches
add constraint packet_mismatches_resolution_status_check
check (resolution_status in ('pending', 'accepted', 'rejected'));

create index if not exists packet_mismatches_case_id_resolution_status_idx
on public.packet_mismatches (case_id, resolution_status);

-- ============================================================
-- 22. packet_stamp_signature_fields_v10.sql
-- ============================================================
delete from public.field_settings
where organization_id = 'default'
  and doc_type = 'Lorry Receipt'
  and field_key in ('hasVendorStamp', 'hasStoreStamp', 'hasStoreSignature', 'hasGateStamp');

insert into public.field_settings (organization_id, doc_type, field_key, enabled, updated_at)
values
  ('default', 'Purchase Order', 'hasAuthorizedSignature', true, now()),
  ('default', 'Purchase Order', 'hasVendorStamp', true, now()),
  ('default', 'Amended Purchase Order', 'hasAuthorizedSignature', true, now()),
  ('default', 'Amended Purchase Order', 'hasVendorStamp', true, now()),
  ('default', 'Invoice', 'hasAuthorizedSignature', true, now()),
  ('default', 'Invoice', 'hasVendorStamp', true, now()),
  ('default', 'Invoice', 'hasStoreStamp', true, now()),
  ('default', 'Invoice', 'hasStoreSignature', true, now()),
  ('default', 'Invoice', 'hasGateStamp', true, now()),
  ('default', 'Tax Invoice', 'hasAuthorizedSignature', true, now()),
  ('default', 'Tax Invoice', 'hasVendorStamp', true, now()),
  ('default', 'Tax Invoice', 'hasStoreStamp', true, now()),
  ('default', 'Tax Invoice', 'hasStoreSignature', true, now()),
  ('default', 'Tax Invoice', 'hasGateStamp', true, now()),
  ('default', 'Delivery Note', 'hasAuthorizedSignature', true, now()),
  ('default', 'Delivery Note', 'hasVendorStamp', true, now()),
  ('default', 'Delivery Note', 'hasStoreStamp', true, now()),
  ('default', 'Delivery Note', 'hasStoreSignature', true, now()),
  ('default', 'Delivery Note', 'hasGateStamp', true, now()),
  ('default', 'Delivery Challan', 'hasAuthorizedSignature', true, now()),
  ('default', 'Delivery Challan', 'hasVendorStamp', true, now()),
  ('default', 'Delivery Challan', 'hasStoreStamp', true, now()),
  ('default', 'Delivery Challan', 'hasStoreSignature', true, now()),
  ('default', 'Delivery Challan', 'hasGateStamp', true, now()),
  ('default', 'Weighment Slip', 'hasAuthorizedSignature', true, now()),
  ('default', 'Lorry Receipt', 'hasAuthorizedSignature', true, now())
on conflict (organization_id, doc_type, field_key) do nothing;

-- ============================================================
-- 23. packet_eway_bill_address_fields_v11.sql
-- ============================================================
insert into public.field_settings (
  organization_id,
  doc_type,
  field_key,
  enabled,
  updated_at
)
values
  ('default', 'E-Way Bill', 'dispatchFrom', true, now()),
  ('default', 'E-Way Bill', 'shipTo', true, now())
on conflict (organization_id, doc_type, field_key) do nothing;

-- ============================================================
-- 24. packet_fastag_statement_fields_v12.sql
-- ============================================================
insert into public.field_settings (organization_id, doc_type, field_key, enabled, updated_at)
values
  ('default', 'FASTag Toll Proof', 'fastagStatementReference', true, now()),
  ('default', 'FASTag Toll Proof', 'fastagCustomerId', true, now()),
  ('default', 'FASTag Toll Proof', 'fastagCustomerName', true, now()),
  ('default', 'FASTag Toll Proof', 'statementPeriod', true, now()),
  ('default', 'FASTag Toll Proof', 'statementDate', true, now()),
  ('default', 'FASTag Toll Proof', 'tripCount', true, now()),
  ('default', 'FASTag Toll Proof', 'openingBalance', true, now()),
  ('default', 'FASTag Toll Proof', 'creditAmount', true, now()),
  ('default', 'FASTag Toll Proof', 'debitAmount', true, now()),
  ('default', 'FASTag Toll Proof', 'closingBalance', true, now()),
  ('default', 'FASTag Toll Proof', 'tollTransactionSummary', true, now())
on conflict (organization_id, doc_type, field_key) do update
set
  enabled = excluded.enabled,
  updated_at = excluded.updated_at;

-- ============================================================
-- 25. packet_comparison_groups_backend_v13.sql
-- ============================================================
create extension if not exists pgcrypto;

create table if not exists public.comparison_field_groups (
  id uuid default gen_random_uuid() primary key,
  organization_id text default 'default',
  group_key text not null,
  label text not null,
  fields jsonb not null default '[]'::jsonb,
  enabled boolean default true,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (organization_id, group_key)
);

create index if not exists comparison_field_groups_org_sort_idx
  on public.comparison_field_groups (organization_id, sort_order, label);

insert into public.comparison_field_groups (
  organization_id,
  group_key,
  label,
  fields,
  enabled,
  sort_order,
  updated_at
)
values
  (
    'default',
    'commercial_amounts',
    'Commercial / Amounts',
    '["subtotal", "taxAmount", "totalAmount", "paidAmount", "statementAmount", "currency"]'::jsonb,
    true,
    10,
    now()
  ),
  (
    'default',
    'party_identity',
    'Party / Identity Details',
    '["vendorName", "supplierGstin", "buyerName", "buyerGstin", "ownerName", "driverName", "holderName", "fatherName", "panNumber"]'::jsonb,
    true,
    20,
    now()
  ),
  (
    'default',
    'weight_quantity',
    'Weight / Quantity',
    '["grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit"]'::jsonb,
    true,
    30,
    now()
  ),
  (
    'default',
    'references',
    'Document References',
    '["poNumber", "referencePoNumber", "invoiceNumber", "referenceInvoiceNumber", "receiptNumber"]'::jsonb,
    true,
    40,
    now()
  ),
  (
    'default',
    'vehicle_logistics',
    'Vehicle / Logistics',
    '["vehicleNumber", "registrationNumber", "lorryReceiptNumber", "fastagReference", "eWayBillNumber"]'::jsonb,
    true,
    50,
    now()
  )
on conflict (organization_id, group_key) do nothing;

-- ============================================================
-- 26. packet_analysis_performance_v14.sql
-- ============================================================
-- Speeds up draft append, case detail loads, mismatch review, and worker job claiming.
-- These are additive and safe to run multiple times.

create index if not exists packet_case_files_case_id_original_name_idx
on public.packet_case_files (case_id, original_name);

create index if not exists packet_case_files_case_id_created_id_idx
on public.packet_case_files (case_id, created_at, id);

create index if not exists packet_documents_case_id_source_file_created_idx
on public.packet_documents (case_id, source_file_name, created_at);

create index if not exists packet_documents_case_id_type_created_idx
on public.packet_documents (case_id, document_type, created_at);

create index if not exists packet_mismatches_case_id_field_name_idx
on public.packet_mismatches (case_id, field_name);

create index if not exists packet_processing_jobs_queued_claim_idx
on public.packet_processing_jobs (next_run_at, created_at)
where status = 'queued';

create index if not exists packet_cases_owner_status_created_idx
on public.packet_cases (owner_user_id, status, created_at desc);

-- ============================================================
-- 27. packet_eway_bill_reference_invoice_v15.sql
-- ============================================================
insert into public.field_settings (
  organization_id,
  doc_type,
  field_key,
  enabled,
  updated_at
)
values
  ('default', 'E-Way Bill', 'referenceInvoiceNumber', true, now())
on conflict (organization_id, doc_type, field_key) do nothing;

-- ============================================================
-- 28. packet_case_list_performance_v15.sql
-- ============================================================
-- Fast case directory pagination and search.
-- Additive only: no data deletion and safe to run repeatedly.

create extension if not exists pg_trgm with schema extensions;

alter table public.packet_cases
add column if not exists search_text text generated always as (
  lower(
    coalesce(display_name, '') || ' ' ||
    coalesce(buyer_name, '') || ' ' ||
    coalesce(po_number, '') || ' ' ||
    coalesce(invoice_number, '') || ' ' ||
    coalesce(slug, '')
  )
) stored;

create index if not exists packet_cases_active_owner_created_id_idx
on public.packet_cases (owner_user_id, created_at desc, id desc)
where deleted_at is null;

create index if not exists packet_cases_deleted_owner_deleted_id_idx
on public.packet_cases (owner_user_id, deleted_at desc, id desc)
where deleted_at is not null;

create index if not exists packet_cases_search_text_trgm_idx
on public.packet_cases
using gin (search_text gin_trgm_ops);

-- ============================================================
-- 29. packet_duplicate_cases_guard_v16.sql
-- ============================================================
-- Prevent exact duplicate packet uploads for the same owner.
-- The application writes processing_meta.uploadFingerprint from a sorted SHA-256
-- file-content signature, so file order does not affect duplicate detection.

create unique index if not exists packet_cases_owner_upload_fingerprint_unique_idx
on public.packet_cases (owner_user_id, (processing_meta->>'uploadFingerprint'))
where nullif(processing_meta->>'uploadFingerprint', '') is not null;

-- ============================================================
-- 30. packet_processing_jobs_claim_guard_v17.sql
-- ============================================================
drop function if exists public.claim_packet_processing_job(text);
drop function if exists public.claim_packet_processing_job(text, interval);

create or replace function public.claim_packet_processing_job(
  worker_name text default 'worker',
  stale_after interval default interval '20 minutes'
)
returns public.packet_processing_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.packet_processing_jobs;
begin
  with exhausted as (
    update public.packet_processing_jobs
    set status = 'failed',
        progress = 100,
        stage = 'Failed',
        error = coalesce(error, 'Processing exceeded retry limit.'),
        locked_at = null,
        locked_by = null,
        finished_at = coalesce(finished_at, now()),
        updated_at = now()
    where status = 'queued'
      and attempt_count >= max_attempts
    returning case_id, error
  )
  update public.packet_cases cases
  set status = 'failed',
      processing_meta = coalesce(cases.processing_meta, '{}'::jsonb) || jsonb_build_object(
        'lastProcessingError',
        coalesce(exhausted.error, 'Processing exceeded retry limit.')
      )
  from exhausted
  where cases.id = exhausted.case_id;

  with stale as (
    update public.packet_processing_jobs
    set status = case
          when attempt_count >= max_attempts then 'failed'
          else 'queued'
        end,
        progress = case
          when attempt_count >= max_attempts then 100
          else 0
        end,
        stage = case
          when attempt_count >= max_attempts then 'Failed'
          else 'Queued after stale worker run'
        end,
        error = coalesce(error, 'Processing run became stale.'),
        locked_at = null,
        locked_by = null,
        next_run_at = now(),
        finished_at = case
          when attempt_count >= max_attempts then coalesce(finished_at, now())
          else finished_at
        end,
        updated_at = now()
    where status = 'running'
      and locked_at is not null
      and locked_at < now() - stale_after
    returning case_id, status, error
  )
  update public.packet_cases cases
  set status = 'failed',
      processing_meta = coalesce(cases.processing_meta, '{}'::jsonb) || jsonb_build_object(
        'lastProcessingError',
        coalesce(stale.error, 'Processing run became stale.')
      )
  from stale
  where cases.id = stale.case_id
    and stale.status = 'failed';

  select *
  into claimed
  from public.packet_processing_jobs
  where status = 'queued'
    and attempt_count < max_attempts
    and next_run_at <= now()
  order by created_at asc
  for update skip locked
  limit 1;

  if claimed.id is null then
    return null;
  end if;

  update public.packet_processing_jobs
  set status = 'running',
      attempt_count = claimed.attempt_count + 1,
      locked_at = now(),
      locked_by = worker_name,
      started_at = coalesce(claimed.started_at, now()),
      updated_at = now()
  where id = claimed.id
  returning *
  into claimed;

  return claimed;
end;
$$;
