alter table public.bank_accounts
add column if not exists last_imported_transaction_marker jsonb not null default '{}'::jsonb;
