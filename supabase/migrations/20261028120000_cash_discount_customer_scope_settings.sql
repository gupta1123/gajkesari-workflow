-- Cash Discount customer scope: which Tally customer groups and ledgers a
-- company's live Cash Discount analysis covers (ported from Kalika).
--
-- ADDITIVE ONLY: one new table, service-role access only like the other
-- collections tables. No scope row means the default scope (Sundry Debtors,
-- automatic mode), so nothing changes until someone saves a scope.
begin;

create table if not exists public.cash_discount_customer_scope_settings (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.tally_connections(id) on delete cascade,
  company_name text not null check (length(btrim(company_name)) between 1 and 240),
  company_name_key text not null check (length(btrim(company_name_key)) between 1 and 240),
  mode text not null default 'automatic' check (mode in ('automatic', 'custom', 'strict')),
  selected_group_names text[] not null default array['Sundry Debtors']::text[],
  include_nested_groups boolean not null default true,
  detect_sales_linked_exceptions boolean not null default true,
  excluded_group_names text[] not null default '{}'::text[],
  excluded_ledger_names text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cash_discount_customer_scope_owner_company_unique
    unique (owner_user_id, connection_id, company_name_key)
);

alter table public.cash_discount_customer_scope_settings enable row level security;
revoke all on public.cash_discount_customer_scope_settings from public, anon, authenticated;
grant select, insert, update, delete on public.cash_discount_customer_scope_settings to service_role;

commit;
