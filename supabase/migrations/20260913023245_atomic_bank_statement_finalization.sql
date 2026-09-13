-- Collapse bank-statement completion into one transaction and keep connector
-- acknowledgements small. These functions are intentionally service-role-only.

begin;

create or replace function public.complete_bank_statement_analysis(
  p_job uuid,
  p_import uuid,
  p_owner uuid,
  p_preview_rows jsonb,
  p_import_patch jsonb,
  p_job_result jsonb,
  p_job_stage text,
  p_finished_at timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  preview_count integer := 0;
begin
  if jsonb_typeof(coalesce(p_preview_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'Preview rows must be a JSON array';
  end if;
  if jsonb_typeof(coalesce(p_import_patch, '{}'::jsonb)) <> 'object' then
    raise exception 'Import patch must be a JSON object';
  end if;
  if jsonb_typeof(coalesce(p_job_result, '{}'::jsonb)) <> 'object' then
    raise exception 'Job result must be a JSON object';
  end if;

  perform 1
  from public.bank_statement_imports
  where id = p_import and owner_user_id = p_owner
  for update;
  if not found then
    raise exception 'Bank statement import not found';
  end if;

  perform 1
  from public.bank_statement_extraction_jobs
  where id = p_job and import_id = p_import and owner_user_id = p_owner
  for update;
  if not found then
    raise exception 'Bank statement extraction job not found';
  end if;

  delete from public.bank_statement_import_preview_transactions
  where import_id = p_import and owner_user_id = p_owner;

  insert into public.bank_statement_import_preview_transactions (
    import_id,
    owner_user_id,
    row_index,
    transaction_date,
    value_date,
    description,
    reference_number,
    debit_amount,
    credit_amount,
    balance_amount,
    transaction_type,
    category,
    counterparty_name,
    suggested_ledger_name,
    suggestion_confidence,
    suggestion_reason,
    confirmed_ledger_name,
    additional_charges,
    confidence,
    raw_payload
  )
  select
    p_import,
    p_owner,
    row_data.row_index,
    row_data.transaction_date,
    row_data.value_date,
    row_data.description,
    row_data.reference_number,
    row_data.debit_amount,
    row_data.credit_amount,
    row_data.balance_amount,
    coalesce(row_data.transaction_type, 'unknown'),
    coalesce(row_data.category, 'unknown'),
    row_data.counterparty_name,
    row_data.suggested_ledger_name,
    row_data.suggestion_confidence,
    row_data.suggestion_reason,
    row_data.confirmed_ledger_name,
    coalesce(row_data.additional_charges, '[]'::jsonb),
    row_data.confidence,
    coalesce(row_data.raw_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_preview_rows, '[]'::jsonb)) as row_data(
    row_index integer,
    transaction_date date,
    value_date date,
    description text,
    reference_number text,
    debit_amount numeric,
    credit_amount numeric,
    balance_amount numeric,
    transaction_type text,
    category text,
    counterparty_name text,
    suggested_ledger_name text,
    suggestion_confidence numeric,
    suggestion_reason text,
    confirmed_ledger_name text,
    additional_charges jsonb,
    confidence numeric,
    raw_payload jsonb
  );
  get diagnostics preview_count = row_count;

  update public.bank_statement_imports
  set bank_account_id = nullif(p_import_patch->>'bankAccountId', '')::uuid,
      statement_period_start = nullif(p_import_patch->>'statementPeriodStart', '')::date,
      statement_period_end = nullif(p_import_patch->>'statementPeriodEnd', '')::date,
      extracted_bank_name = nullif(p_import_patch->>'extractedBankName', ''),
      extracted_account_number = nullif(p_import_patch->>'extractedAccountNumber', ''),
      extracted_account_holder_name = nullif(p_import_patch->>'extractedAccountHolderName', ''),
      extracted_ifsc_code = nullif(p_import_patch->>'extractedIfscCode', ''),
      status = p_import_patch->>'status',
      processing_meta = coalesce(p_import_patch->'processingMeta', '{}'::jsonb)
  where id = p_import and owner_user_id = p_owner;
  if not found then
    raise exception 'Bank statement import changed during completion';
  end if;

  update public.bank_statement_extraction_jobs
  set status = 'succeeded',
      progress = 100,
      stage = p_job_stage,
      error = null,
      result = coalesce(p_job_result, '{}'::jsonb),
      locked_at = null,
      locked_by = null,
      finished_at = p_finished_at
  where id = p_job and import_id = p_import and owner_user_id = p_owner;
  if not found then
    raise exception 'Bank statement extraction job changed during completion';
  end if;

  return jsonb_build_object(
    'jobId', p_job,
    'importId', p_import,
    'status', 'succeeded',
    'previewTransactionCount', preview_count
  );
end
$$;

revoke all on function public.complete_bank_statement_analysis(
  uuid, uuid, uuid, jsonb, jsonb, jsonb, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_bank_statement_analysis(
  uuid, uuid, uuid, jsonb, jsonb, jsonb, text, timestamptz
) to service_role;

create or replace function public.complete_tally_command_compact(
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
  completed jsonb;
begin
  completed := public.complete_tally_command(
    p_connection,
    p_token_hash,
    p_command,
    p_claim,
    p_success,
    p_result,
    p_error,
    p_payload
  );

  insert into public.tally_connection_events (
    connection_id,
    owner_user_id,
    event_type,
    message,
    payload
  )
  select
    connection.id,
    connection.owner_user_id,
    case when p_success then 'command_succeeded' else 'command_failed' end,
    case when p_success then 'Tally command completed.' else 'Tally command failed.' end,
    jsonb_build_object(
      'commandId', p_command,
      'commandType', completed->>'command_type',
      'error', p_error
    )
  from public.tally_connections as connection
  where connection.id = p_connection;

  return jsonb_build_object(
    'id', completed->>'id',
    'status', completed->>'status'
  );
end
$$;

revoke all on function public.complete_tally_command_compact(
  uuid, text, uuid, uuid, boolean, jsonb, text, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_tally_command_compact(
  uuid, text, uuid, uuid, boolean, jsonb, text, jsonb
) to service_role;

create or replace function public.resolve_bank_statement_upload_target(
  p_owner uuid,
  p_connection uuid,
  p_binding_hash text,
  p_company_name text,
  p_selected_dataset uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  connection_row public.tally_connections;
  dataset_row public.tally_company_datasets;
  matching_company jsonb;
  matching_count integer;
  normalized_guid text;
begin
  select connection.*
  into connection_row
  from public.tally_connections as connection
  where connection.id = p_connection
    and connection.owner_user_id = p_owner
    and connection.control_token_hash = p_binding_hash
    and connection.revoked_at is null
    and exists (
      select 1
      from public.tally_browser_bindings as binding
      where binding.owner_user_id = p_owner
        and binding.installation_id = connection.installation_ref
        and binding.credential_hash = p_binding_hash
        and binding.revoked_at is null
        and binding.expires_at > now()
    )
  for share;
  if not found then
    raise exception 'Pair this browser with its local connector first.';
  end if;

  if connection_row.last_heartbeat_at is null
    or connection_row.last_heartbeat_at < now() - interval '45 seconds' then
    raise exception 'The paired connector is offline.';
  end if;

  select count(*), jsonb_agg(company.value)->0
  into matching_count, matching_company
  from jsonb_array_elements(coalesce(connection_row.last_companies_snapshot, '[]'::jsonb)) as company(value)
  where company.value->>'companyName' = p_company_name
    and nullif(trim(company.value->>'guid'), '') is not null;
  if matching_count <> 1 then
    raise exception 'The company GUID is missing or ambiguous. Refresh Tally companies.';
  end if;

  normalized_guid := lower(trim(matching_company->>'guid'));
  select dataset.*
  into dataset_row
  from public.tally_company_datasets as dataset
  where dataset.owner_user_id = p_owner
    and dataset.installation_id = connection_row.installation_ref
    and dataset.company_guid = normalized_guid;
  if not found then
    raise exception 'The selected Tally company dataset was not found.';
  end if;

  if p_selected_dataset is not null and p_selected_dataset <> dataset_row.id then
    raise exception 'The selected company identity changed. Refresh and select the company again.';
  end if;

  return jsonb_build_object(
    'installationId', connection_row.installation_ref,
    'companyDatasetId', dataset_row.id,
    'connectionId', connection_row.id,
    'sessionGeneration', connection_row.session_generation,
    'companyGuid', normalized_guid,
    'companyName', p_company_name
  );
end
$$;

revoke all on function public.resolve_bank_statement_upload_target(
  uuid, uuid, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.resolve_bank_statement_upload_target(
  uuid, uuid, text, text, uuid
) to service_role;

commit;
