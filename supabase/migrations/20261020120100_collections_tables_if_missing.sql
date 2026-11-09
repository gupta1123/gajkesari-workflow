-- Collections & cash-discount tables, created ONLY IF MISSING.
--
-- The Gajkesari code already reads cash_discount_rules, debit_note_proposals and
-- collections_analysis_cache, but no earlier Gajkesari migration creates them.
-- Production may already have them (an earlier migration here expects
-- debit_note_proposals to exist). Run docs/payment-followups/phase1-readonly-db-check.sql
-- first: if all three tables exist, you do not need this file. Every statement is
-- `if not exists`, so running it on a database that has them changes nothing.
--
-- Unlike Kalika's original migration this file does NOT touch the Tally command
-- queue or its command-type constraint, and it keeps no foreign key into any
-- bank-statement table (source_transaction_id is a plain uuid).
begin;

create table if not exists public.cash_discount_rules (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  connection_id uuid references public.tally_connections(id) on delete cascade,
  rule_name text not null,
  scope_type text not null default 'company'
    check (scope_type in ('company', 'customer_group', 'customer', 'invoice', 'sales_order')),
  scope_key text,
  scope_label text,
  discount_type text not null default 'percentage'
    check (discount_type in ('percentage', 'fixed_amount')),
  discount_value numeric(14, 2) not null default 0,
  calculation_base text not null default 'invoice_total'
    check (calculation_base in ('taxable_value', 'invoice_total', 'product_value')),
  eligibility_days integer not null default 0,
  grace_days integer not null default 0,
  payment_condition text not null default 'full_payment'
    check (payment_condition in ('full_payment', 'pro_rata', 'manual_review')),
  accounting_treatment text not null default 'finance_review'
    check (accounting_treatment in ('credit_note', 'commercial_credit_note', 'pre_discounted_invoice', 'finance_review')),
  missed_cd_treatment text not null default 'finance_review'
    check (missed_cd_treatment in ('no_action', 'debit_note_proposal', 'follow_up_only', 'finance_review')),
  approval_required boolean not null default true,
  label text not null default 'Cash Discount',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cash_discount_rules_owner_connection_idx
  on public.cash_discount_rules(owner_user_id, connection_id, is_active);

create table if not exists public.debit_note_proposals (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  connection_id uuid references public.tally_connections(id) on delete cascade,
  company_dataset_id uuid,
  company_name text,
  financial_year text,
  source_transaction_id uuid,
  party_ledger_name text not null,
  party_gstin text,
  party_email text,
  party_phone text,
  party_contact_person text,
  party_address text,
  linked_invoice_number text,
  linked_invoice_date date,
  original_invoice_amount numeric(14, 2),
  cash_discount_rule_id uuid references public.cash_discount_rules(id) on delete set null,
  cash_discount_rule_name text,
  discount_deadline date,
  receipt_date date,
  amount_received numeric(14, 2),
  recoverable_amount numeric(14, 2) not null default 0,
  remaining_recoverable_amount numeric(14, 2),
  reason_code text not null default 'cash_discount_expired',
  narration text,
  gst_mode text not null default 'finance_review',
  debit_note_date date not null default current_date,
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'approved', 'queued_in_tally', 'created_in_tally', 'rejected', 'failed')),
  approval_by uuid,
  approved_at timestamptz,
  tally_command_id uuid,
  tally_voucher_guid text,
  tally_voucher_id text,
  tally_voucher_number text,
  tally_voucher_date date,
  tally_open_reference_name text,
  tally_pdf_reference text,
  created_in_tally_at timestamptz,
  last_synced_from_tally_at timestamptz,
  communication_status text,
  communication_channel text,
  communication_recipient text,
  communication_sent_at timestamptz,
  customer_snapshot jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_user_id, company_dataset_id)
    references public.tally_company_datasets(owner_user_id, id)
);
create index if not exists debit_note_proposals_owner_connection_status_idx
  on public.debit_note_proposals(owner_user_id, connection_id, status, created_at desc);
create index if not exists debit_note_proposals_dataset_idx
  on public.debit_note_proposals(company_dataset_id);

create table if not exists public.collections_analysis_cache (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  connection_id uuid references public.tally_connections(id) on delete cascade,
  cache_key text not null,
  company_name text,
  financial_year text,
  period_start date,
  period_end date,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (owner_user_id, connection_id, cache_key)
);
create index if not exists collections_analysis_cache_expiry_idx
  on public.collections_analysis_cache(expires_at);

-- Lock down only tables that have no row-level security yet (i.e. ones this file
-- just created), so tables that already existed keep whatever setup they have.
do $lock$
declare t text;
begin
  foreach t in array array['cash_discount_rules', 'debit_note_proposals', 'collections_analysis_cache'] loop
    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and not c.relrowsecurity
    ) then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on public.%I from public, anon, authenticated', t);
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end if;
  end loop;
end $lock$;

commit;
