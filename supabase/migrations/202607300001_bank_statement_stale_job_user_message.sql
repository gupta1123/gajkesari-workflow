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
  stale_message text := 'Analysis could not be completed. Please retry. If this continues, contact helpdesk.';
begin
  update public.bank_statement_extraction_jobs
  set status = 'queued',
      progress = 0,
      stage = 'Queued after stale worker run',
      error = stale_message,
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
      error = stale_message,
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
