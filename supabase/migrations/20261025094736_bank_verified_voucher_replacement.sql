-- Permit an explicit replacement only after a fresh scoped Tally absence check.
-- Existing active and uncertain posting checkpoints remain non-retryable.
CREATE OR REPLACE FUNCTION public.enqueue_bank_tally_commands(p_owner uuid, p_connection uuid, p_dataset uuid, p_generation bigint, p_commands jsonb)
 RETURNS SETOF tally_bridge_commands
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c public.tally_connections;
  item jsonb;
  q public.tally_bridge_commands;
  tx public.bank_transactions;
  previous public.bank_transaction_posting_log;
  proof public.tally_bridge_commands;
  original public.tally_bridge_commands;
  approved jsonb;
  observation jsonb;
  identity_key text;
begin
  select * into c
  from public.tally_connections
  where id = p_connection
    and owner_user_id = p_owner
    and revoked_at is null
    and session_generation = p_generation
  for update;
  if not found then raise exception 'Connector session changed'; end if;
  if jsonb_array_length(p_commands) > 1000 then raise exception 'Too many commands'; end if;

  for item in select value from jsonb_array_elements(p_commands) loop
    if item->>'command_type' in ('post_bank_voucher', 'verify_bank_transaction') then
      select * into tx
      from public.bank_transactions
      where id = (item#>>'{payload,transactionId}')::uuid
        and owner_user_id = p_owner
        and company_dataset_id = p_dataset
      for update;
      if not found then raise exception 'Transaction outside selected company'; end if;

      select * into previous
      from public.bank_transaction_posting_log
      where owner_user_id = p_owner
        and bank_account_id = tx.bank_account_id
        and fingerprint = tx.fingerprint
      for update;
      if found and previous.status in ('queued','posted','verified','needs_tally_review') then
        -- Only a completed, individually confirmed posting may be replaced.
        -- The caller must have just verified its absence in the same company.
        if previous.status <> 'verified' or item->>'command_type' <> 'post_bank_voucher'
          or item#>>'{payload,replacesPostingCommandId}' is distinct from previous.command_id::text
          or nullif(item#>>'{payload,replacementVerificationCommandId}', '') is null
        then
          raise exception 'Transaction already queued, posted, or awaiting reconciliation';
        end if;
        select * into proof from public.tally_bridge_commands
          where id = (item#>>'{payload,replacementVerificationCommandId}')::uuid
            and owner_user_id = p_owner and company_dataset_id = p_dataset
            and connection_id = p_connection and command_type = 'verify_bank_transaction'
            and status = 'succeeded' and created_at > now() - interval '5 minutes'
            and completed_at is not null
            and payload->>'replacementVerification' = 'true'
            and payload#>>'{target,companyDatasetId}' = p_dataset::text
            and payload#>>'{target,sessionGeneration}' = p_generation::text
            and payload->'previousPostingCommands'->>tx.id::text = previous.command_id::text;
        if not found then raise exception 'Fresh replacement verification is required'; end if;
        select * into original from public.tally_bridge_commands
          where id = previous.command_id and owner_user_id = p_owner
            and company_dataset_id = p_dataset and command_type = 'post_bank_voucher'
            and status = 'succeeded';
        if not found then raise exception 'Previous posting needs review'; end if;
        if jsonb_typeof(proof.payload->'transactions') is distinct from 'array'
          or jsonb_typeof(proof.result->'transactions') is distinct from 'array'
          or (select count(*) from jsonb_array_elements(proof.payload->'transactions') r where r->>'transactionId'=tx.id::text) <> 1
          or (select count(*) from jsonb_array_elements(proof.result->'transactions') r where r->>'transactionId'=tx.id::text) <> 1
        then raise exception 'Replacement verification is incomplete'; end if;
        select r into approved from jsonb_array_elements(proof.payload->'transactions') r where r->>'transactionId'=tx.id::text;
        select r into observation from jsonb_array_elements(proof.result->'transactions') r where r->>'transactionId'=tx.id::text;
        if observation->>'verificationStatus' is distinct from 'missing'
          or coalesce((observation->>'duplicateInTally')::boolean, false)
          or coalesce((observation->>'matchCount')::integer, 0) <> 0
          or (jsonb_typeof(observation->'matches') = 'array' and jsonb_array_length(observation->'matches') > 0)
        then raise exception 'Replacement voucher is not confirmed missing'; end if;
        foreach identity_key in array array['transactionId','fingerprint','voucherDate','amount','bankLedgerName',
          'counterpartyLedgerName','expectedDirection','referenceNumber','bankReferenceNumber'] loop
          if coalesce(approved->identity_key, 'null'::jsonb) is distinct from coalesce(item->'payload'->identity_key, 'null'::jsonb)
            or coalesce(approved->identity_key, 'null'::jsonb) is distinct from coalesce(original.payload->identity_key, 'null'::jsonb)
          then raise exception 'Replacement payment details changed'; end if;
        end loop;
        -- The log remains the current checkpoint. Its entire preceding result
        -- and voucher identity survive in the new command as durable history.
        item = jsonb_set(item, '{payload,replacesPosting}', jsonb_build_object(
          'logId',previous.id,'commandId',previous.command_id,'status',previous.status,
          'voucherId',previous.tally_voucher_id,'postedAt',previous.tally_posted_at,'result',previous.result));
      end if;
    end if;

    insert into public.tally_bridge_commands(
      connection_id, owner_user_id, company_dataset_id, queue_job_id,
      command_type, status, priority, payload
    ) values (
      c.id, p_owner, p_dataset, nullif(item->>'queue_job_id', '')::uuid,
      item->>'command_type', 'queued', coalesce((item->>'priority')::integer, 100), item->'payload'
    ) returning * into q;

    if q.command_type in ('post_bank_voucher','verify_bank_transaction') then
      insert into public.bank_transaction_posting_log(
        owner_user_id, company_dataset_id, bank_account_id, connection_id,
        source_transaction_id, fingerprint, transaction_date, reference_number,
        description, debit_amount, credit_amount, amount, voucher_type,
        bank_ledger_name, counterparty_ledger_name, command_id, status
      ) values (
        p_owner, p_dataset, tx.bank_account_id, c.id, tx.id, tx.fingerprint,
        tx.transaction_date, tx.reference_number, tx.description, tx.debit_amount,
        tx.credit_amount, (q.payload->>'amount')::numeric, q.payload->>'voucherType',
        q.payload->>'bankLedgerName', q.payload->>'counterpartyLedgerName', q.id, 'queued'
      )
      on conflict(owner_user_id,bank_account_id,fingerprint) do update set
        company_dataset_id=excluded.company_dataset_id,
        connection_id=excluded.connection_id,
        command_id=excluded.command_id,
        status='queued',
        error=null,
        result='{}'::jsonb;

      update public.bank_transactions
      set tally_status=case when q.command_type='post_bank_voucher' then 'pending' else 'checking_in_tally' end,
          confirmed_ledger_name=coalesce(q.payload->>'matchedLedgerName',q.payload->>'counterpartyLedgerName',confirmed_ledger_name),
          ledger_mapping_source='queue_confirmation'
      where id=tx.id;

      update public.bank_accounts
      set tally_connection_id=c.id,
          tally_ledger_name=q.payload->>'bankLedgerName'
      where id=tx.bank_account_id
        and owner_user_id=p_owner
        and company_dataset_id=p_dataset;
    end if;
    return next q;
  end loop;
end
$function$
;

revoke all on function public.enqueue_bank_tally_commands(uuid,uuid,uuid,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.enqueue_bank_tally_commands(uuid,uuid,uuid,bigint,jsonb)
  to service_role;
