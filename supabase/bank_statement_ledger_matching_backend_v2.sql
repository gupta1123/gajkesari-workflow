alter table public.bank_accounts
add column if not exists ifsc_code text;

alter table public.bank_statement_imports
add column if not exists extracted_ifsc_code text;

alter table public.bank_transactions
add column if not exists counterparty_name text,
add column if not exists suggested_ledger_name text,
add column if not exists suggestion_confidence numeric,
add column if not exists suggestion_reason text,
add column if not exists confirmed_ledger_name text,
add column if not exists ledger_mapping_source text;

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.tally_mapping_settings'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%mapping_type%';

  if constraint_name is not null then
    execute format('alter table public.tally_mapping_settings drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.tally_mapping_settings
add constraint tally_mapping_settings_mapping_type_check
check (
  mapping_type in (
    'supplier_gstin',
    'buyer_gstin',
    'item_hsn',
    'item_description',
    'gst_rate',
    'freight_ledger',
    'round_off_ledger',
    'voucher_type',
    'bank_account_ledger',
    'bank_narration_ledger',
    'bank_category_ledger'
  )
);

create index if not exists bank_accounts_owner_ifsc_idx
on public.bank_accounts (owner_user_id, ifsc_code);

create index if not exists bank_transactions_account_confirmed_ledger_idx
on public.bank_transactions (bank_account_id, confirmed_ledger_name);
