-- Durable extraction/review identities and fail-closed bank-voucher completion.
-- This migration is intentionally additive so existing imports and queued work
-- remain readable by older application builds during rollout.

begin;

alter table public.bank_statement_imports
  add column if not exists extraction_version integer not null default 1,
  add column if not exists source_manifest jsonb not null default '[]'::jsonb,
  add column if not exists source_digest text,
  add column if not exists reviewed_revision bigint not null default 0,
  add column if not exists review_digest text;

alter table public.bank_transaction_posting_log
  add column if not exists verification_status text,
  add column if not exists uncertainty_reason text,
  add column if not exists tally_voucher_guid text;

alter table public.tally_bridge_commands
  add column if not exists progress_stage text,
  add column if not exists progress jsonb not null default '{}'::jsonb;

create or replace function public.complete_tally_command(
  p_connection uuid,
  p_token_hash text,
  p_command uuid,
  p_claim uuid,
  p_success boolean,
  p_result jsonb,
  p_error text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c public.tally_connections;
  q public.tally_bridge_commands;
  next_status text;
  voucher_id text;
  bank_verified boolean;
  needs_reconciliation boolean;
  bank_verification_status text;
begin
  select * into c
  from public.tally_connections
  where id=p_connection and bridge_token_hash=p_token_hash and revoked_at is null
  for share;
  if not found then raise exception 'Connector session changed'; end if;

  select * into q
  from public.tally_bridge_commands
  where id=p_command and connection_id=c.id and owner_user_id=c.owner_user_id
    and claim_token=p_claim and target_session_generation=c.session_generation
  for update;
  if not found then raise exception 'Stale command claim'; end if;

  if q.status in ('succeeded','failed') then
    if q.result is distinct from p_result or (q.status='succeeded') is distinct from p_success then
      raise exception 'Conflicting command result';
    end if;
    return to_jsonb(q);
  end if;
  if q.status <> 'claimed' then raise exception 'Command is not claimed'; end if;

  needs_reconciliation :=
    coalesce((p_result->>'reconciliationRequired')::boolean,false) or
    coalesce((p_result->>'possibleDuplicateInTally')::boolean,false) or
    coalesce((p_result->>'voucherCreatedButVerificationFailed')::boolean,false);

  if q.command_type='post_bank_voucher' then
    bank_verification_status := coalesce(
      nullif(p_result->>'verificationStatus',''),
      nullif(p_result#>>'{duplicateCheck,verificationStatus}','')
    );
    bank_verified := p_success and bank_verification_status in ('verified','found','matched');
    -- A success acknowledgement from an older connector without read-back is
    -- quarantined. It is never treated as a completed posting.
    needs_reconciliation := needs_reconciliation or (p_success and not bank_verified);
    next_status := case
      when bank_verified then 'verified'
      when needs_reconciliation then 'needs_tally_review'
      else 'failed'
    end;
    voucher_id := coalesce(
      nullif(p_result->>'voucherId',''),
      nullif(p_result#>>'{duplicateCheck,voucherId}',''),
      nullif(p_result->>'masterId',''),
      nullif(p_result->>'lastVchId','')
    );

    update public.bank_transactions
    set tally_status=next_status,
        tally_posted_at=case when bank_verified then now() else null end,
        tally_voucher_id=case when bank_verified then voucher_id else null end
    where id=(q.payload->>'transactionId')::uuid
      and owner_user_id=q.owner_user_id
      and company_dataset_id=q.company_dataset_id;
    if not found then raise exception 'Missing transaction checkpoint'; end if;

    update public.bank_transaction_posting_log
    set status=next_status,
        result=p_result,
        error=case when bank_verified then null else p_error end,
        tally_posted_at=case when bank_verified then now() else null end,
        tally_voucher_id=case when bank_verified then voucher_id else null end,
        verification_status=bank_verification_status,
        uncertainty_reason=nullif(p_result->>'uncertaintyReason',''),
        tally_voucher_guid=nullif(p_result->>'guid','')
    where command_id=q.id and owner_user_id=q.owner_user_id
      and company_dataset_id=q.company_dataset_id;
    if not found then raise exception 'Missing posting log checkpoint'; end if;
  end if;

  if q.command_type='create_debit_note'
    and coalesce(q.payload->>'operation','')<>'export_native_pdf'
    and nullif(q.payload->>'proposalId','') is not null then
    if to_regclass('public.debit_note_proposals') is null then
      raise exception 'Missing proposal schema; retain this command for reconciliation'
        using errcode='55000';
    end if;
    update public.debit_note_proposals
    set status=case when p_success then 'created_in_tally' else 'failed' end,
        tally_voucher_id=case when p_success then coalesce(p_result->>'voucherId',p_result->>'masterId',q.id::text) else null end,
        tally_voucher_guid=case when p_success then coalesce(p_result->>'voucherGuid',p_result->>'guid') else null end,
        tally_voucher_number=case when p_success then coalesce(p_result->>'voucherNumber',q.payload->>'referenceNumber',q.id::text) else null end,
        tally_voucher_date=case when p_success then coalesce(p_result->>'voucherDate',q.payload->>'voucherDate')::date else null end,
        last_error=case when p_success then null else p_error end
    where id=(q.payload->>'proposalId')::uuid and owner_user_id=q.owner_user_id
      and company_dataset_id=q.company_dataset_id and tally_command_id=q.id;
    if not found then raise exception 'Missing proposal checkpoint'; end if;
  end if;

  update public.tally_bridge_commands
  set status=case when p_success then 'succeeded' else 'failed' end,
      result=p_result,
      error=p_error,
      payload=p_payload,
      completed_at=now(),
      lease_expires_at=null,
      reconciliation_required=needs_reconciliation
  where id=q.id
  returning * into q;
  return to_jsonb(q);
end
$$;

revoke all on function public.complete_tally_command(uuid,text,uuid,uuid,boolean,jsonb,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_tally_command(uuid,text,uuid,uuid,boolean,jsonb,text,jsonb)
  to service_role;

commit;
