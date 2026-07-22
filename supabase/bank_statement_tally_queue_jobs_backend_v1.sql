create table if not exists public.bank_statement_tally_queue_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  connection_id uuid references public.tally_connections(id) on delete cascade,
  bank_account_id uuid references public.bank_accounts(id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  request_payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  total_count integer not null default 0,
  processed_count integer not null default 0,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bank_statement_tally_queue_jobs_owner_status_idx
  on public.bank_statement_tally_queue_jobs(owner_user_id, status, created_at desc);

create index if not exists bank_statement_tally_queue_jobs_connection_idx
  on public.bank_statement_tally_queue_jobs(connection_id, created_at desc);
