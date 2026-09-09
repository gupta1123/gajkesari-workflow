-- Make statement uploads idempotent per connector-owned company and keep a
-- durable link from a batch job to every Tally command it created.

alter table public.bank_statement_imports
  add column if not exists source_sha256 text;

alter table public.bank_statement_imports
  drop constraint if exists bank_statement_imports_source_sha256_check;
alter table public.bank_statement_imports
  add constraint bank_statement_imports_source_sha256_check
  check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$');

create unique index if not exists bank_statement_imports_company_source_sha256_key
  on public.bank_statement_imports(owner_user_id, company_dataset_id, source_sha256)
  where source_sha256 is not null;

alter table public.tally_bridge_commands
  add column if not exists queue_job_id uuid
    references public.bank_statement_tally_queue_jobs(id) on delete set null;

create index if not exists tally_bridge_commands_queue_job_status_idx
  on public.tally_bridge_commands(queue_job_id, status)
  where queue_job_id is not null;

create or replace function public.enqueue_bank_tally_commands(
  p_owner uuid,
  p_connection uuid,
  p_dataset uuid,
  p_generation bigint,
  p_commands jsonb
)
returns setof public.tally_bridge_commands
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c public.tally_connections;
  item jsonb;
  q public.tally_bridge_commands;
  tx public.bank_transactions;
  previous public.bank_transaction_posting_log;
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
        raise exception 'Transaction already queued, posted, or awaiting reconciliation';
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
$$;

revoke all on function public.enqueue_bank_tally_commands(uuid,uuid,uuid,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.enqueue_bank_tally_commands(uuid,uuid,uuid,bigint,jsonb)
  to service_role;
