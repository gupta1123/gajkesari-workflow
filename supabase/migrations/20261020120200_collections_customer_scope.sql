-- Customer scope for collections: which Tally customer ledgers a company's
-- follow-up and live analysis reads are allowed to cover.
--
-- ADDITIVE ONLY: one new table. It references only the dataset table and touches no
-- bank-statement object or the Tally command queue. No scope row means "no
-- customers selected yet", so live reads require customers to be named explicitly.
begin;

create table if not exists public.collections_customer_scopes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  company_dataset_id uuid not null,
  ledger_names text[] not null default '{}'
    check (cardinality(ledger_names) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, company_dataset_id),
  foreign key (owner_user_id, company_dataset_id)
    references public.tally_company_datasets (owner_user_id, id)
);

alter table public.collections_customer_scopes enable row level security;
revoke all on public.collections_customer_scopes from public, anon, authenticated;
grant select, insert, update, delete on public.collections_customer_scopes to service_role;

commit;
