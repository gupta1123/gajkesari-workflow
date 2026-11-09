-- Payment follow-ups (Gajkesari-native; adapted from Kalika's design, not copied).
--
-- ADDITIVE ONLY. Creates three new tables and two new functions. It does not
-- alter or reference any bank-statement object, the Tally command queue, or its
-- command-type constraint. Safe to run before or after any other migration that
-- is already applied; every statement is idempotent.
--
-- Scoping: every row belongs to one owner (owner_user_id) and one Tally company
-- dataset (company_dataset_id -> tally_company_datasets). Access is only through
-- the API using the service role; there are no client policies.
--
-- Sending is operator-initiated only. The attempts table cannot hold an
-- automatic send (check constraint) and a reminder can only be claimed through
-- followup_claim_send, which re-verifies outstanding and the connector session.
begin;

create table if not exists public.followup_pipeline_templates (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  name text not null check (length(name) between 1 and 80),
  stages jsonb not null check (jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) between 1 and 8),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, name)
);

create table if not exists public.invoice_followup_pipelines (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  company_dataset_id uuid not null,
  installation_id uuid not null,
  session_generation bigint not null,
  company_guid text not null check (length(trim(company_guid)) > 0),
  company_name text not null,
  financial_year text not null default '',
  invoice_key text not null check (length(trim(invoice_key)) > 0),
  customer text not null,
  invoice text not null,
  invoice_date date,
  recipient text not null,
  plan_name text not null,
  stages jsonb not null check (jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) between 1 and 8),
  stage_index integer not null default 0 check (stage_index >= 0),
  stage_sent integer not null default 0 check (stage_sent >= 0),
  status text not null default 'active'
    check (status in ('active', 'paused', 'review', 'settled', 'finished', 'stopped', 'sending', 'uncertain')),
  outstanding numeric(18, 2) check (outstanding >= 0),
  next_due_at timestamptz,
  verified_at timestamptz,
  verification_expires_at timestamptz,
  note text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_user_id, company_dataset_id)
    references public.tally_company_datasets (owner_user_id, id)
);

create unique index if not exists invoice_followup_one_unfinished
  on public.invoice_followup_pipelines (owner_user_id, company_dataset_id, invoice_key)
  where status not in ('settled', 'finished', 'stopped');

create index if not exists invoice_followup_due
  on public.invoice_followup_pipelines (owner_user_id, company_dataset_id, status, next_due_at, id);

create table if not exists public.invoice_followup_attempts (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references public.invoice_followup_pipelines (id),
  owner_user_id uuid not null,
  revision integer not null,
  -- An operator confirmed this send. Automatic delivery is structurally impossible.
  automatic boolean not null default false check (automatic = false),
  status text not null check (status in ('submitting', 'accepted', 'rejected', 'uncertain')),
  recipient text not null,
  outstanding numeric(18, 2) not null,
  stage_index integer not null,
  provider_reference text,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (pipeline_id, revision)
);

alter table public.followup_pipeline_templates enable row level security;
alter table public.invoice_followup_pipelines enable row level security;
alter table public.invoice_followup_attempts enable row level security;

revoke all on public.followup_pipeline_templates, public.invoice_followup_pipelines,
  public.invoice_followup_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.followup_pipeline_templates to service_role;
grant select, insert, update on public.invoice_followup_pipelines, public.invoice_followup_attempts to service_role;

-- Claim one due, freshly verified reminder. Fails (40001) if anything changed
-- since the operator reviewed it, so the caller must re-check outstanding.
create or replace function public.followup_claim_send(
  p_id uuid,
  p_revision integer,
  p_owner uuid,
  p_installation uuid,
  p_generation bigint
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  r public.invoice_followup_pipelines;
  attempt uuid;
  inst public.tally_installations;
begin
  select * into r from public.invoice_followup_pipelines
    where id = p_id and owner_user_id = p_owner for update;
  if not found or r.revision <> p_revision or r.status <> 'active'
     or r.next_due_at is null or r.next_due_at > now()
     or r.verification_expires_at is null or r.verification_expires_at <= now()
     or coalesce(r.outstanding, 0) <= 0
     or r.installation_id <> p_installation or r.session_generation <> p_generation
     or r.stage_index >= jsonb_array_length(r.stages)
     or r.stage_sent >= (r.stages -> r.stage_index ->> 'limit')::integer then
    raise exception 'Check outstanding again before sending' using errcode = '40001';
  end if;

  select * into inst from public.tally_installations
    where id = p_installation and owner_user_id = p_owner;
  if not found or inst.session_generation is distinct from p_generation then
    raise exception 'Connector pairing changed' using errcode = '40001';
  end if;

  insert into public.invoice_followup_attempts
    (pipeline_id, owner_user_id, revision, status, recipient, outstanding, stage_index)
  values (r.id, r.owner_user_id, r.revision, 'submitting', r.recipient, r.outstanding, r.stage_index)
  returning id into attempt;

  update public.invoice_followup_pipelines
    set status = 'sending', revision = revision + 1, updated_at = now()
    where id = r.id;

  return jsonb_build_object('attempt_id', attempt);
end $$;

-- Record the provider's answer. 'uncertain' parks the pipeline for a human so a
-- possibly-delivered message is never resent automatically.
create or replace function public.followup_finish_send(
  p_id uuid,
  p_attempt uuid,
  p_owner uuid,
  p_status text,
  p_provider text,
  p_error text,
  p_next jsonb
) returns boolean
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  a public.invoice_followup_attempts;
  r public.invoice_followup_pipelines;
begin
  select * into r from public.invoice_followup_pipelines
    where id = p_id and owner_user_id = p_owner for update;
  if not found then raise exception 'Unknown reminder'; end if;
  select * into a from public.invoice_followup_attempts
    where id = p_attempt and pipeline_id = p_id for update;
  if not found then raise exception 'Unknown reminder attempt'; end if;
  if a.status <> 'submitting' then return a.status = p_status; end if;
  if r.status <> 'sending' or p_status not in ('accepted', 'rejected', 'uncertain') then
    raise exception 'Invalid reminder completion';
  end if;

  update public.invoice_followup_attempts
    set status = p_status, provider_reference = left(p_provider, 200),
        error = left(p_error, 1000), finished_at = now()
    where id = a.id;

  update public.invoice_followup_pipelines set
    status = case when p_status = 'accepted' then p_next ->> 'status'
                  when p_status = 'rejected' then 'active' else 'uncertain' end,
    stage_index = case when p_status = 'accepted' then (p_next ->> 'stage_index')::integer else stage_index end,
    stage_sent = case when p_status = 'accepted' then (p_next ->> 'stage_sent')::integer else stage_sent end,
    next_due_at = case when p_status = 'accepted' then (p_next ->> 'next_due_at')::timestamptz else next_due_at end,
    note = left(p_error, 1000),
    verification_expires_at = null,
    revision = revision + 1,
    updated_at = now()
  where id = r.id;
  return true;
end $$;

revoke all on function public.followup_claim_send(uuid, integer, uuid, uuid, bigint),
  public.followup_finish_send(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.followup_claim_send(uuid, integer, uuid, uuid, bigint),
  public.followup_finish_send(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

commit;
