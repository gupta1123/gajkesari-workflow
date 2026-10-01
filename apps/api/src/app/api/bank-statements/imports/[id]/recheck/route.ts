import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { browserDatasetIds, resolveTallyTarget } from "@/lib/tally/browser-scope";
import { queueTallyCommandAndWake } from "@/lib/tally/queue-command";
import { recheckEvidence } from "@/lib/bank-statement-recheck";
import { refreshBankStatementQueueJobStatus } from "@/lib/bank-statement-tally-queue-status";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
class RecheckError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function recheckErrorResponse(request: Request, error: unknown) {
  if (error instanceof RecheckError) return jsonWithCors(request, { error: error.message }, { status: error.status });
  console.error("Bank statement recheck failed", error);
  return jsonWithCors(request, { error: "We couldn't finish checking. Please try again." }, { status: 500 });
}

async function scope(request: Request, context: Context) {
  const user = await requireRequestUser(request);
  if (!user) throw new RecheckError("Please sign in to check your statement.", 401);
  const { id } = await context.params;
  const db = createSupabaseAdminClient();
  const { data: statement, error } = await db.from("bank_statement_imports")
    .select("id,company_dataset_id,processing_meta")
    .eq("id", id).eq("owner_user_id", user.id)
    .in("company_dataset_id", await browserDatasetIds(request, user.id)).single();
  if (error || !statement) throw new RecheckError("This statement isn't available for the selected company.", 404);
  return { db, user, statement };
}

export function OPTIONS(request: Request) { return optionsWithCors(request); }

// Rechecking always queues a read-only command using the original approved
// posting payload. The browser cannot supply a replacement amount or company.
export async function POST(request: Request, context: Context) {
  try {
    const { db, user, statement } = await scope(request, context);
    const { data: transactions, error } = await db.from("bank_transactions")
      .select("id,fingerprint").eq("statement_import_id", statement.id)
      .eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
      .eq("tally_status", "needs_tally_review").limit(100);
    if (error) throw error;
    const commandIds: string[] = [];
    let connectionId = "";
    for (const transaction of transactions ?? []) {
      const { data: log, error: logError } = await db.from("bank_transaction_posting_log")
        .select("command_id,status,result").eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
        .eq("fingerprint", transaction.fingerprint).in("status", ["needs_tally_review", "verified"]).single();
      if (logError) throw logError;
      const { data: original, error: commandError } = await db.from("tally_bridge_commands")
        .select("id,connection_id,payload").eq("id", log.command_id)
        .eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
        .eq("command_type", "post_bank_voucher").single();
      if (commandError) throw commandError;
      connectionId = original.connection_id;
      // A previous PATCH may have saved the durable log before a transient
      // failure updating the snapshot row. Reuse its read-only evidence.
      if (log.status === "verified" && log.result?.recheck?.commandId) {
        commandIds.push(String(log.result.recheck.commandId));
        continue;
      }
      const target = await resolveTallyTarget(request, user.id, connectionId, original.payload.companyName)
        .catch(() => { throw new RecheckError("Keep Tally and the connector open, select the original company, then check again.", 409); });
      if (target.companyDatasetId !== statement.company_dataset_id) {
        throw new RecheckError("Select the original company in Tally, then check again.", 409);
      }
      const { data: active, error: activeError } = await db.from("tally_bridge_commands")
        .select("id").eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
        .eq("connection_id", connectionId).eq("command_type", "verify_bank_transaction")
        .contains("payload", { recheckPostingCommandId: original.id, recheckImportId: statement.id })
        .in("status", ["queued", "claimed"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (activeError) throw activeError;
      if (active) { commandIds.push(active.id); continue; }
      const queued = await queueTallyCommandAndWake<{ id: string }>({
        supabase: db, connectionId, ownerUserId: user.id, companyDatasetId: statement.company_dataset_id,
        commandType: "verify_bank_transaction", priority: 5, select: "id",
        payload: {
          target, companyName: target.companyName, bankLedgerName: original.payload.bankLedgerName,
          includeBalanceProof: false, transactions: [original.payload],
          recheckPostingCommandId: original.id, recheckImportId: statement.id,
        },
      });
      commandIds.push(queued.command.id);
    }
    return jsonWithCors(request, { commandIds, connectionId });
  } catch (error) {
    return recheckErrorResponse(request, error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { db, user, statement } = await scope(request, context);
    const body = await request.json();
    const ids = Array.isArray(body.commandIds) ? body.commandIds.filter((id: unknown) => typeof id === "string").slice(0, 100) : [];
    if (!ids.length) return jsonWithCors(request, { confirmed: 0 });
    const { data: commands, error } = await db.from("tally_bridge_commands")
      .select("id,status,payload,result").in("id", ids).eq("owner_user_id", user.id)
      .eq("company_dataset_id", statement.company_dataset_id).eq("command_type", "verify_bank_transaction")
      .contains("payload", { recheckImportId: statement.id });
    if (error) throw error;
    let confirmed = 0;
    for (const command of commands ?? []) {
      const { data: original, error: originalError } = await db.from("tally_bridge_commands")
        .select("payload,queue_job_id").eq("id", command.payload.recheckPostingCommandId)
        .eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
        .eq("command_type", "post_bank_voucher").single();
      if (originalError) throw originalError;
      const evidence = recheckEvidence(command, original.payload);
      if (!evidence) continue;
      const { data: transaction, error: transactionError } = await db.from("bank_transactions")
        .select("id").eq("id", evidence.transactionId).eq("statement_import_id", statement.id)
        .eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id).single();
      if (transactionError) throw transactionError;
      const { data: log, error: logError } = await db.from("bank_transaction_posting_log")
        .select("id,result,tally_posted_at").eq("command_id", command.payload.recheckPostingCommandId)
        .eq("source_transaction_id", transaction.id).eq("owner_user_id", user.id)
        .eq("company_dataset_id", statement.company_dataset_id).in("status", ["needs_tally_review", "verified"]).single();
      if (logError) throw logError;
      const postedAt = log.tally_posted_at || new Date().toISOString();
      const { error: saveError } = await db.from("bank_transaction_posting_log").update({
        status: "verified", error: null, verification_status: "verified", uncertainty_reason: null,
        tally_voucher_id: evidence.voucherId, tally_posted_at: postedAt,
        result: { ...log.result, verificationStatus: "verified", voucherId: evidence.voucherId,
          voucherNumber: evidence.voucherNumber, recheck: { commandId: command.id, ...evidence } },
      }).eq("id", log.id).in("status", ["needs_tally_review", "verified"]);
      if (saveError) throw saveError;
      // Idempotent: if the second update fails, another PATCH can finish it
      // using the durable confirmed log without ever creating another voucher.
      const { error: rowError } = await db.from("bank_transactions").update({
        tally_status: "verified", tally_voucher_id: evidence.voucherId, tally_posted_at: postedAt,
      }).eq("id", transaction.id).eq("owner_user_id", user.id).in("tally_status", ["needs_tally_review", "verified"]);
      if (rowError) throw rowError;
      if (original.queue_job_id) await refreshBankStatementQueueJobStatus(db, original.queue_job_id);
      confirmed++;
    }
    return jsonWithCors(request, { confirmed });
  } catch (error) {
    return recheckErrorResponse(request, error);
  }
}
