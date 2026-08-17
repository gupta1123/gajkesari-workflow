alter table public.bank_statement_tally_queue_jobs
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text;

create index if not exists bank_statement_tally_queue_jobs_lock_idx
  on public.bank_statement_tally_queue_jobs(status, locked_at);
