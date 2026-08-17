do $$
begin
  if to_regclass('public.bank_transactions') is not null then
    alter table public.bank_transactions
      drop constraint if exists bank_transactions_tally_status_check;

    alter table public.bank_transactions
      add constraint bank_transactions_tally_status_check
      check (
        tally_status in (
          'pending',
          'posted',
          'failed',
          'checking_in_tally',
          'verified',
          'missing_in_tally',
          'needs_tally_review',
          'verification_failed'
        )
      );
  end if;

  if to_regclass('public.bank_transaction_posting_log') is not null then
    alter table public.bank_transaction_posting_log
      drop constraint if exists bank_transaction_posting_log_status_check;

    alter table public.bank_transaction_posting_log
      add constraint bank_transaction_posting_log_status_check
      check (
        status in (
          'queued',
          'posted',
          'failed',
          'checking_in_tally',
          'verified',
          'missing_in_tally',
          'needs_tally_review',
          'verification_failed'
        )
      );
  end if;
end
$$;

with verification_commands as (
  select
    id as command_id,
    owner_user_id,
    payload,
    result,
    error,
    completed_at,
    case
      when status = 'succeeded'
        and coalesce(result->>'verificationStatus', '') in ('found', 'matched', 'verified')
        then 'verified'
      when status = 'succeeded'
        and coalesce(result->>'verificationStatus', '') = 'ambiguous'
        then 'needs_tally_review'
      when status = 'succeeded'
        then 'missing_in_tally'
      else 'verification_failed'
    end as next_status,
    coalesce(result->>'voucherId', result->>'masterId', result->>'voucherNumber') as voucher_id
  from public.tally_bridge_commands
  where command_type = 'verify_bank_transaction'
    and status in ('succeeded', 'failed')
    and payload ? 'transactionId'
    and (payload->>'transactionId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
update public.bank_transactions as bank_transaction
set
  tally_status = verification.next_status,
  tally_posted_at = case when verification.next_status = 'verified' then coalesce(verification.completed_at, now()) else null end,
  tally_voucher_id = case when verification.next_status = 'verified' then verification.voucher_id else null end
from verification_commands as verification
where bank_transaction.id = (verification.payload->>'transactionId')::uuid
  and bank_transaction.owner_user_id = verification.owner_user_id;

with verification_commands as (
  select
    id as command_id,
    owner_user_id,
    result,
    error,
    completed_at,
    case
      when status = 'succeeded'
        and coalesce(result->>'verificationStatus', '') in ('found', 'matched', 'verified')
        then 'verified'
      when status = 'succeeded'
        and coalesce(result->>'verificationStatus', '') = 'ambiguous'
        then 'needs_tally_review'
      when status = 'succeeded'
        then 'missing_in_tally'
      else 'verification_failed'
    end as next_status,
    coalesce(result->>'voucherId', result->>'masterId', result->>'voucherNumber') as voucher_id
  from public.tally_bridge_commands
  where command_type = 'verify_bank_transaction'
    and status in ('succeeded', 'failed')
)
update public.bank_transaction_posting_log as log
set
  status = verification.next_status,
  tally_voucher_id = case when verification.next_status = 'verified' then verification.voucher_id else null end,
  tally_posted_at = case when verification.next_status = 'verified' then coalesce(verification.completed_at, now()) else null end,
  error = verification.error,
  result = verification.result
from verification_commands as verification
where log.command_id = verification.command_id
  and log.owner_user_id = verification.owner_user_id;
