import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashSecret } from "@/lib/tally/connections";
import { getCashDiscountCustomerScopeOrDefault } from "@/lib/cash-discount-customer-scope";
import { readCompleteHistory } from "@/lib/collections-history";

export const db = () => createSupabaseAdminClient();
export const operations = [
  "diagnose",
  "reconnect",
  "logs",
  "followups",
  "discount",
  "statement",
  "parse",
  "match",
  "verify",
  "update",
];
export const fields =
  "id,operator_id,financial_year,company_guid,operation,status,parameters,progress,result,error,created_at,updated_at,expires_at,company_dataset_id";
export const connectionFields =
  "id,installation_ref,session_generation,owner_user_id,bridge_version,last_company_name,last_heartbeat_at";
export async function granted(operator: string, installation: string) {
  const { data, error } = await db()
    .from("connector_operator_grants")
    .select("installation_id")
    .eq("operator_id", operator)
    .eq("installation_id", installation)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
export async function expire(connection: string) {
  const { error } = await db()
    .from("connector_operator_jobs")
    .update({
      status: "expired",
      progress: null,
      updated_at: new Date().toISOString(),
    })
    .eq("connection_id", connection)
    .in("status", ["queued", "running", "restart_pending"])
    .lt("expires_at", new Date().toISOString());
  if (error) throw error;
}
export async function device(request: Request, id: string) {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return null;
  const { data, error } = await db()
    .from("tally_connections")
    .select(connectionFields)
    .eq("id", id)
    .eq("bridge_token_hash", hashSecret(token))
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  return data;
}
export async function readStatement(
  owner: string,
  dataset: string,
  id: string,
  year: string,
) {
  const { data, error } = await db()
    .from("bank_statement_imports")
    .select(
      "id,original_file_name,status,created_at,imported_transaction_count,duplicate_transaction_count,statement_period_start,statement_period_end,storage_path,storage_bucket,processing_meta",
    )
    .eq("id", id)
    .eq("company_dataset_id", dataset)
    .eq("owner_user_id", owner)
    .single();
  if (error) throw error;
  const storedYear = data.processing_meta?.selectedContext?.financialYear;
  if (storedYear && storedYear !== year)
    throw Error("The upload belongs to another financial year.");
  return data;
}
export async function statementTrace(
  owner: string,
  dataset: string,
  id: string,
  year: string,
  transactionId?: string,
) {
  const statement = await readStatement(owner, dataset, id, year);
  const rows = await readCompleteHistory((from, to) =>
    db()
      .from("bank_transactions")
      .select("id,transaction_date,reference_number,tally_status")
      .eq("owner_user_id", owner)
      .eq("company_dataset_id", dataset)
      .eq("statement_import_id", id)
      .order("id")
      .range(from, to),
  );
  const { data: extraction, error } = await db()
    .from("bank_statement_extraction_jobs")
    .select("status,stage,progress,attempt_count,error,created_at,finished_at")
    .eq("owner_user_id", owner)
    .eq("import_id", id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const tally: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row.tally_status || "unposted");
    tally[key] = (tally[key] || 0) + 1;
  }
  const selected = transactionId
    ? rows.filter((r) => r.id === transactionId)
    : rows.slice(0, 100);
  if (transactionId && !selected.length)
    throw Error("Transaction does not belong to this upload.");
  const logs = selected.length
    ? await db()
        .from("bank_transaction_posting_log")
        .select(
          "source_transaction_id,status,error,created_at,tally_voucher_id",
        )
        .eq("owner_user_id", owner)
        .eq("company_dataset_id", dataset)
        .in(
          "source_transaction_id",
          selected.map((r) => r.id),
        )
        .order("created_at", { ascending: false })
        .limit(100)
    : { data: [], error: null };
  if (logs.error) throw logs.error;
  return {
    source: "Saved import history",
    file: statement.original_file_name,
    uploadTime: statement.created_at,
    status: statement.status,
    extraction: extraction?.[0],
    imported: statement.imported_transaction_count,
    duplicates: statement.duplicate_transaction_count,
    posting: tally,
    recentPostingEvents: logs.data,
    transactions: selected,
    totalTransactions: rows.length,
    shownTransactions: selected.length,
  };
}
export async function jobContext(
  operation: string,
  parameters: Record<string, string>,
  owner: string,
  connection: string,
  dataset: { id: string; company_name: string; financial_year: string },
) {
  if (operation === "followups" || operation === "discount") {
    const scope = await getCashDiscountCustomerScopeOrDefault({
      ownerUserId: owner,
      connectionId: connection,
      companyName: dataset.company_name,
    });
    if (operation === "followups") return { scope, proposals: [] };
    const proposals = await readCompleteHistory((a, b) =>
      db()
        .from("debit_note_proposals")
        .select(
          "id,company_name,financial_year,party_ledger_name,linked_invoice_number,recoverable_amount,reason_code,status,created_at",
        )
        .eq("owner_user_id", owner)
        .or(
          "company_dataset_id.eq." +
            dataset.id +
            ",and(company_dataset_id.is.null,connection_id.eq." +
            connection +
            ")",
        )
        .eq("company_name", dataset.company_name)
        .eq("status", "created_in_tally")
        .order("id")
        .range(a, b),
    );
    return {
      scope,
      proposals: proposals.filter(
        (r) => !r.financial_year || r.financial_year === dataset.financial_year,
      ),
    };
  }
  if (["parse", "match", "verify"].includes(operation)) {
    const stmt = await readStatement(
      owner,
      dataset.id,
      parameters.statementId,
      dataset.financial_year,
    );
    if (operation === "verify") {
      const { data: r, error } = await db()
        .from("bank_transactions")
        .select(
          "transaction_date,reference_number,debit_amount,credit_amount,description",
        )
        .eq("id", parameters.transactionId)
        .eq("statement_import_id", stmt.id)
        .eq("company_dataset_id", dataset.id)
        .eq("owner_user_id", owner)
        .single();
      if (error) throw error;
      return {
        bankLedgerName:
          stmt.processing_meta?.selectedContext?.bankLedgerName ||
          stmt.processing_meta?.tallyLedgerName,
        voucherDate: r.transaction_date,
        referenceNumber: r.reference_number,
        narration: r.description,
        amount: Number(r.credit_amount) || Number(r.debit_amount),
        expectedDirection:
          Number(r.credit_amount) > 0 ? "incoming" : "outgoing",
      };
    }
    if (
      stmt.storage_bucket !== "bank-statement-files" ||
      !stmt.original_file_name.toLowerCase().endsWith(".pdf")
    )
      throw Error("Choose a PDF statement.");
    const { data, error } = await db()
      .storage.from(stmt.storage_bucket)
      .createSignedUrl(stmt.storage_path, 180);
    if (error) throw error;
    return { documentUrl: data.signedUrl, fileName: "statement.pdf" };
  }
  return {};
}
