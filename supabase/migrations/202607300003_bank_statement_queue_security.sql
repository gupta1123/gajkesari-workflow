alter table public.bank_statement_tally_queue_jobs
  enable row level security;

revoke all on table public.bank_statement_tally_queue_jobs from anon, authenticated;

create index if not exists bank_statement_tally_queue_jobs_bank_account_idx
  on public.bank_statement_tally_queue_jobs(bank_account_id, created_at desc)
  where bank_account_id is not null;
