import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { browserDatasetIds } from "@/lib/tally/browser-scope";
import { canResolveRepeatedPayment, candidateIdentity, duplicateContext, duplicateRowKey } from "@gajkesari/shared/lib/bank-duplicate-resolution";

export const runtime = "nodejs";
export function OPTIONS(request: Request) { return optionsWithCors(request); }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// A resolution is an explicit owner decision about one immutable preview row.
// It is never a general "ignore duplicates" switch. The connector revalidates
// the approved voucher snapshot before excluding it from a new payment check.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Please sign in." }, { status: 401 });
    const { id } = await context.params;
    const body = record(await request.json());
    if (!["skip", "separate", "clear"].includes(String(body.action)) || typeof body.transactionId !== "string") {
      return jsonWithCors(request, { error: "Choose an entry and a review action." }, { status: 400 });
    }
    const db = createSupabaseAdminClient();
    const { data: statement, error } = await db.from("bank_statement_imports").select("id,company_dataset_id,processing_meta")
      .eq("id", id).eq("owner_user_id", user.id).in("company_dataset_id", await browserDatasetIds(request, user.id)).single();
    if (error || !statement) return jsonWithCors(request, { error: "This statement is unavailable for the selected company." }, { status: 404 });
    const { data: storedRows, error: rowsError } = await db.from("bank_statement_import_preview_transactions").select("id,transaction_date,description,reference_number,debit_amount,credit_amount,balance_amount")
      .eq("import_id", id).eq("owner_user_id", user.id).order("row_index", { ascending: true }).limit(10000);
    if (rowsError) throw rowsError;
    const previewRows = record(record(statement.processing_meta).preview).transactions;
    const rows = storedRows?.length ? storedRows : Array.isArray(previewRows) ? previewRows : [];
    const row = rows.find((value: Record<string, unknown>) => value.id === body.transactionId);
    if (!row || duplicateRowKey(row) !== body.rowKey) {
      return jsonWithCors(request, { error: "The statement entry changed. Refresh and review it again." }, { status: 409 });
    }
    const meta = record(statement.processing_meta), decisions = { ...record(meta.duplicateResolutions) };
    const key = duplicateRowKey(row), previous = decisions[key] || null;
    const bank = String(body.bankLedgerName || "").trim(), ledger = String(body.counterpartyLedgerName || "").trim();
    let decision = null;
    if (body.action !== "clear") {
      const matches = Array.isArray(body.matches) ? body.matches : [];
      if (!bank || !ledger || body.confirmed !== true || !canResolveRepeatedPayment(row, rows, matches, bank, ledger)) {
        return jsonWithCors(request, { error: "Only repeated entries without a bank reference and with one otherwise matching voucher can use this choice. Correct other differences and recheck Tally." }, { status: 409 });
      }
      decision = { action: body.action, rowKey: key, context: duplicateContext(row, bank, ledger),
        candidates: matches.map(candidateIdentity), decidedBy: user.id, decidedAt: new Date().toISOString(), importId: id };
      decisions[key] = decision;
    } else delete decisions[key];
    const history = [...(Array.isArray(meta.duplicateResolutionHistory) ? meta.duplicateResolutionHistory : []),
      { rowKey: key, previous, decision, action: body.action, decidedBy: user.id, decidedAt: new Date().toISOString() }];
    const { data: saved, error: saveError } = await db.from("bank_statement_imports").update({
      processing_meta: { ...meta, duplicateResolutions: decisions, duplicateResolutionHistory: history },
    }).eq("id", id).eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
      .filter("processing_meta", statement.processing_meta == null ? "is" : "eq", statement.processing_meta == null ? "null" : JSON.stringify(statement.processing_meta)).select("id");
    if (saveError) throw saveError;
    if (!saved?.length) return jsonWithCors(request, { error: "The statement changed during review. Refresh and try again." }, { status: 409 });
    return jsonWithCors(request, { decision, duplicateResolutions: decisions });
  } catch (error) {
    console.error("Duplicate resolution could not be saved", error);
    return jsonWithCors(request, { error: "The decision could not be saved. Please try again." }, { status: 500 });
  }
}
