-- Optional performance index for bank-statement confirmation.
-- This migration is intentionally not applied automatically.
create index if not exists bank_transactions_confirm_queue_idx
on public.bank_transactions (
  owner_user_id,
  bank_account_id,
  statement_import_id,
  tally_status,
  transaction_date,
  id
)
where coalesce(debit_amount, 0) > 0 or coalesce(credit_amount, 0) > 0;
