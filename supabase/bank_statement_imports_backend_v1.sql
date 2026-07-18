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
