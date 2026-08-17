-- Move Tally queue preparation out of browser requests and onto the durable worker.
-- Apply this migration in Supabase before deploying the corresponding worker code.

alter table public.bank_statement_tally_queue_jobs
  add column if not exists attempt_count integer not null default 0,
  add column if not exists max_attempts integer not null default 5,
  add column if not exists next_run_at timestamptz not null default now();

create index if not exists bank_statement_tally_queue_jobs_claim_idx
  on public.bank_statement_tally_queue_jobs (next_run_at, created_at)
  where status in ('queued', 'running');

create index if not exists bank_transactions_queueable_import_idx
  on public.bank_transactions
    (owner_user_id, bank_account_id, statement_import_id, transaction_date, id)
  where tally_status in ('pending', 'failed', 'missing_in_tally', 'verification_failed');

alter table public.bank_statement_tally_queue_jobs enable row level security;
revoke all on table public.bank_statement_tally_queue_jobs from anon, authenticated;
grant all on table public.bank_statement_tally_queue_jobs to service_role;

create or replace function public.claim_bank_statement_tally_queue_job(
  worker_name text,
  stale_after interval default interval '5 minutes'
)
returns setof public.bank_statement_tally_queue_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select job.id
    from public.bank_statement_tally_queue_jobs as job
    where job.attempt_count < job.max_attempts
      and job.next_run_at <= now()
      and (
        job.status = 'queued'
        or (
          job.status = 'running'
          and coalesce(job.locked_at, job.updated_at, job.created_at) < now() - stale_after
        )
      )
    order by job.next_run_at, job.created_at
    for update skip locked
    limit 1
  )
  update public.bank_statement_tally_queue_jobs as job
  set status = 'running',
      locked_at = now(),
      locked_by = worker_name,
      started_at = coalesce(job.started_at, now()),
      attempt_count = job.attempt_count + 1,
      updated_at = now(),
      error = null
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

revoke all on function public.claim_bank_statement_tally_queue_job(text, interval) from public, anon, authenticated;
grant execute on function public.claim_bank_statement_tally_queue_job(text, interval) to service_role;
