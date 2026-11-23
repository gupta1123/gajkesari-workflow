-- Run once in the Gajkesari project. Grants are explicit per named operator and installation.
begin;
create table public.connector_operator_grants (
  operator_id uuid references auth.users(id) on delete cascade,
  installation_id uuid references public.tally_installations(id) on delete cascade,
  primary key(operator_id, installation_id)
);
create table public.connector_operator_jobs (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references auth.users(id),
  installation_id uuid not null references public.tally_installations(id),
  connection_id uuid not null references public.tally_connections(id),
  company_dataset_id uuid not null references public.tally_company_datasets(id),
  generation bigint not null,
  company_guid text not null,
  financial_year text not null,
  operation text not null check(operation in ('diagnose','reconnect','logs','followups','discount','statement','parse','match','verify','update')),
  parameters jsonb not null default '{}',
  status text not null default 'queued' check(status in ('queued','running','restart_pending','completed','failed','expired')),
  progress text, result jsonb, error text, claim uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 minutes'
);
create unique index connector_operator_active_job on public.connector_operator_jobs(connection_id)
 where status in ('queued','running','restart_pending');
create index connector_operator_history on public.connector_operator_jobs(installation_id,created_at desc);
alter table public.connector_operator_jobs enable row level security;
alter table public.connector_operator_grants enable row level security;
revoke all on public.connector_operator_jobs, public.connector_operator_grants from public, anon, authenticated;
grant select,insert,update on public.connector_operator_jobs to service_role;
grant select,insert,delete on public.connector_operator_grants to service_role;
commit;
