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
