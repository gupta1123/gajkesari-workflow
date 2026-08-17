drop function if exists public.claim_bank_statement_extraction_job(text, interval);

create function public.claim_bank_statement_extraction_job(
  worker_name text default 'worker',
  stale_after interval default interval '20 minutes',
  worker_pool text default null
)
returns public.bank_statement_extraction_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.bank_statement_extraction_jobs;
  effective_worker_pool text := case
    when lower(coalesce(worker_pool, '')) in ('local', 'remote')
      then lower(worker_pool)
    when lower(coalesce(worker_name, '')) like 'local-%'
      then 'local'
    else 'remote'
  end;
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
    and coalesce(nullif(lower(result ->> 'workerPool'), ''), 'remote') = effective_worker_pool
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

revoke all on function public.claim_bank_statement_extraction_job(text, interval, text)
from public, anon, authenticated;
grant execute on function public.claim_bank_statement_extraction_job(text, interval, text)
to service_role;
