create or replace function public.notify_bank_statement_worker_wake()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform pg_notify(
    'gajkesari_bank_statement_jobs',
    json_build_object(
      'workerPool',
      coalesce(nullif(lower(new.result ->> 'workerPool'), ''), 'remote')
    )::text
  );
  return new;
end;
$$;

revoke all on function public.notify_bank_statement_worker_wake()
from public, anon, authenticated;
grant execute on function public.notify_bank_statement_worker_wake()
to service_role;

drop trigger if exists notify_bank_statement_worker_wake_after_insert
on public.bank_statement_extraction_jobs;

create trigger notify_bank_statement_worker_wake_after_insert
after insert on public.bank_statement_extraction_jobs
for each row
execute function public.notify_bank_statement_worker_wake();
