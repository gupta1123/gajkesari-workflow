import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type Statement = { id: string; company_dataset_id: string; bank_account_id?: string | null; processing_meta?: Record<string, unknown> | null };
type PreviewRow = Record<string, unknown>;
export type StatementPostingRow = {
  id: string; fingerprint: string; statement_import_id: string;
  transaction_date: string | null; description: string | null; reference_number: string | null;
  debit_amount: number | null; credit_amount: number | null; balance_amount: number | null;
  confirmed_ledger_name: string | null; suggested_ledger_name: string | null;
  tally_voucher_id: string | null; tally_posted_at: string | null; tally_status: string;
};

export function isExistingStatementPosting(row: Pick<StatementPostingRow, "id" | "statement_import_id">,
  log: { status: string; source_transaction_id?: string | null } | undefined, importId: string) {
  return log?.status === "verified" && (row.statement_import_id !== importId ||
    Boolean(log.source_transaction_id && log.source_transaction_id !== row.id));
}

// The balance is part of identity: repeated equal payments remain separate rows.
export function previewPostingFingerprint(accountId: string, row: PreviewRow) {
  const field = (snake: string, camel: string) => row[snake] ?? row[camel];
  const date = field("transaction_date", "transactionDate");
  const parts = [accountId, date, field("value_date", "valueDate") ?? date ?? "",
    field("reference_number", "referenceNumber") ?? "",
    String(row.description ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
    field("debit_amount", "debitAmount") ?? "", field("credit_amount", "creditAmount") ?? "",
    field("balance_amount", "balanceAmount") ?? ""];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

// Reuploads reference existing immutable transaction rows rather than moving
// them between imports. Resolve those references within owner/company/account.
export async function loadStatementPostingRows(db: SupabaseClient, statement: Statement, ownerId: string): Promise<StatementPostingRow[]> {
  const columns = "id,fingerprint,statement_import_id,transaction_date,description,reference_number,debit_amount,credit_amount,balance_amount,confirmed_ledger_name,suggested_ledger_name,tally_voucher_id,tally_posted_at,tally_status";
  const { data: current, error } = await db.from("bank_transactions").select(columns)
    .eq("statement_import_id", statement.id).eq("owner_user_id", ownerId).eq("company_dataset_id", statement.company_dataset_id);
  if (error) throw error;
  if (!statement.bank_account_id) return (current ?? []) as StatementPostingRow[];
  const meta = statement.processing_meta ?? {};
  let fingerprints = Array.isArray(meta.reviewedTransactionFingerprints)
    ? meta.reviewedTransactionFingerprints.filter((value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) : [];
  if (!fingerprints.length) {
    const preview: PreviewRow[] = [];
    for (let start = 0; ; start += 500) {
      const { data: page, error: previewError } = await db.from("bank_statement_import_preview_transactions")
        .select("transaction_date,value_date,description,reference_number,debit_amount,credit_amount,balance_amount")
        .eq("import_id", statement.id).eq("owner_user_id", ownerId).order("row_index").range(start, start + 499);
      if (previewError) throw previewError;
      preview.push(...(page ?? []));
      if ((page?.length ?? 0) < 500) break;
    }
    const stored = (meta.preview as { transactions?: PreviewRow[] } | undefined)?.transactions;
    fingerprints = (preview?.length ? preview : Array.isArray(stored) ? stored : [])
      .map(row => previewPostingFingerprint(statement.bank_account_id!, row));
  }
  const rows = new Map((current ?? []).map(row => [row.id, row as StatementPostingRow]));
  // Keep requests below URL limits for large statements.
  for (let start = 0; start < fingerprints.length; start += 100) {
    const { data: linked, error: linkedError } = await db.from("bank_transactions").select(columns)
      .eq("owner_user_id", ownerId).eq("company_dataset_id", statement.company_dataset_id)
      .eq("bank_account_id", statement.bank_account_id).in("fingerprint", fingerprints.slice(start, start + 100));
    if (linkedError) throw linkedError;
    for (const row of linked ?? []) rows.set(row.id, row as StatementPostingRow);
  }
  return [...rows.values()].sort((a, b) => String(a.transaction_date).localeCompare(String(b.transaction_date)));
}
