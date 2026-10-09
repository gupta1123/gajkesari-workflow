import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { browserDatasetIds, resolveTallyTarget } from "@/lib/tally/browser-scope";
import { queueTallyCommandAndWake } from "@/lib/tally/queue-command";
import { recheckEvidence, recheckObservation, recheckPayload, confirmedRecheckResult } from "@/lib/bank-statement-recheck";
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
    const text = await request.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { throw new RecheckError("The review request couldn't be read. Please try again.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RecheckError("The review request couldn't be read. Please try again.", 400);
    const transactionId = typeof body.transactionId === "string" ? body.transactionId : "";
    const ledgerName = typeof body.ledgerName === "string" ? body.ledgerName : "";
    if (ledgerName && !transactionId) throw new RecheckError("Select an entry before correcting its ledger.", 400);
    let query = db.from("bank_transactions")
      .select("id,fingerprint").eq("statement_import_id", statement.id)
      .eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
      .eq("tally_status", "needs_tally_review").limit(100);
    if (transactionId) query = query.eq("id", transactionId);
    const { data: transactions, error } = await query;
    if (error) throw error;
    if (transactionId && !transactions?.length) throw new RecheckError("This entry no longer needs checking. Refresh the statement.", 409);
    const commandIds: string[] = [];
    let connectionId = "";
    for (const transaction of transactions ?? []) {
      const { data: log, error: logError } = await db.from("bank_transaction_posting_log")
        .select("id,command_id,status,result").eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
        .eq("fingerprint", transaction.fingerprint).in("status", ["needs_tally_review", "verified"]).single();
      if (logError) throw logError;
      if (!log) throw new RecheckError("No saved posting result was found for this entry.", 409);
      const { data: original, error: commandError } = await db.from("tally_bridge_commands")
        .select("id,connection_id,payload").eq("id", log.command_id)
        .eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
        .eq("command_type", "post_bank_voucher").single();
      if (commandError) throw commandError;
      if (!original) throw new RecheckError("The original posting request is unavailable. Refresh the statement.", 409);
      connectionId = original.connection_id;
      // A previous PATCH may have saved the durable log before a transient
      // failure updating the snapshot row. Reuse its read-only evidence.
      if (log.status === "verified" && log.result?.recheck?.commandId) {
        const { data: savedCheck, error: savedCheckError } = await db.from("tally_bridge_commands").select("id")
          .eq("id", String(log.result.recheck.commandId)).eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
          .eq("command_type", "verify_bank_transaction").contains("payload", { recheckImportId: statement.id }).maybeSingle();
        if (savedCheckError) throw savedCheckError;
        if (savedCheck) { commandIds.push(savedCheck.id); continue; }
      }
      const target = await resolveTallyTarget(request, user.id, connectionId, original.payload.companyName)
        .catch(() => { throw new RecheckError("Keep Tally and the connector open, select the original company, then check again.", 409); });
      if (target.companyDatasetId !== statement.company_dataset_id) {
        throw new RecheckError("Select the original company in Tally, then check again.", 409);
      }
      if (ledgerName) {
        if (log.status !== "needs_tally_review" || log.result?.possibleDuplicateInTally !== true) {
          throw new RecheckError("Only an entry held back without posting can have its selected ledger corrected.", 409);
        }
        const { data: ledger, error: ledgerError } = await db.from("tally_masters").select("tally_name")
          .eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
          .eq("master_type", "ledger").eq("is_active", true).eq("tally_name", ledgerName).maybeSingle();
        if (ledgerError) throw ledgerError;
        if (!ledger || ledgerName === original.payload.bankLedgerName) throw new RecheckError("Choose an existing party or expense ledger from this company.", 400);
        const correctedResult = { ...log.result, reviewLedgerName: ledger.tally_name,
          ledgerReview: { previousLedgerName: log.result?.reviewLedgerName || original.payload.counterpartyLedgerName,
            ledgerName: ledger.tally_name, reviewedBy: user.id, reviewedAt: new Date().toISOString() } };
        const { data: saved, error: saveError } = await db.from("bank_transaction_posting_log").update({ result: correctedResult })
          .eq("id", log.id).eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
          .eq("status", "needs_tally_review").filter("result", log.result == null ? "is" : "eq", log.result == null ? "null" : JSON.stringify(log.result)).select("id");
        if (saveError) throw saveError;
        if (!saved?.length) throw new RecheckError("This entry changed during review. Refresh it before correcting the ledger.", 409);
        log.result = correctedResult;
        const { error: rowError } = await db.from("bank_transactions").update({ confirmed_ledger_name: ledger.tally_name })
          .eq("id", transaction.id).eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id).eq("tally_status", "needs_tally_review");
        if (rowError) throw rowError;
      }
      const approved = recheckPayload(original.payload, log.result);
      const { data: active, error: activeError } = await db.from("tally_bridge_commands")
        .select("id").eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
        .eq("connection_id", connectionId).eq("command_type", "verify_bank_transaction")
        .contains("payload", { recheckPostingCommandId: original.id, recheckImportId: statement.id,
          recheckLedgerName: String(approved.counterpartyLedgerName || "") })
        .in("status", ["queued", "claimed"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (activeError) throw activeError;
      if (active) { commandIds.push(active.id); continue; }
      const queued = await queueTallyCommandAndWake<{ id: string }>({
        supabase: db, connectionId, ownerUserId: user.id, companyDatasetId: statement.company_dataset_id,
        commandType: "verify_bank_transaction", priority: 5, select: "id",
        payload: {
          target, companyName: target.companyName, bankLedgerName: original.payload.bankLedgerName,
          includeBalanceProof: false, transactions: [approved],
          recheckLedgerName: String(approved.counterpartyLedgerName || ""),
          recheckTransactionId: transaction.id,
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
    const { data: commands, error } = ids.length ? await db.from("tally_bridge_commands")
      .select("id,status,payload,result,created_at").in("id", ids).eq("owner_user_id", user.id)
      .eq("company_dataset_id", statement.company_dataset_id).eq("command_type", "verify_bank_transaction")
      .contains("payload", { recheckImportId: statement.id }) : { data: [], error: null };
    if (error) throw error;
    let confirmed = 0;
    let checked = 0;
    let checkFailed = 0;
    for (const command of commands ?? []) {
      const { data: original, error: originalError } = await db.from("tally_bridge_commands")
        .select("payload,queue_job_id").eq("id", command.payload.recheckPostingCommandId)
        .eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
        .eq("command_type", "post_bank_voucher").single();
      if (originalError) throw originalError;
      if (!original) continue;
      if (!["succeeded", "failed", "canceled", "cancelled", "expired", "quarantined"].includes(command.status)) continue;
      const transactionId = command.payload.recheckTransactionId || original.payload.transactionId;
      const { data: transaction, error: transactionError } = await db.from("bank_transactions")
        .select("id,fingerprint").eq("id", transactionId).eq("statement_import_id", statement.id)
        .eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id).single();
      if (transactionError) throw transactionError;
      if (!transaction) continue;
      const { data: log, error: logError } = await db.from("bank_transaction_posting_log")
        .select("id,status,result,tally_posted_at,fingerprint").eq("command_id", command.payload.recheckPostingCommandId)
        .eq("source_transaction_id", original.payload.transactionId).eq("fingerprint", transaction.fingerprint).eq("owner_user_id", user.id)
        .eq("company_dataset_id", statement.company_dataset_id).in("status", ["needs_tally_review", "verified"]).single();
      if (logError) throw logError;
      if (!log) continue;
      const approved = recheckPayload(original.payload, log.result);
      const observation = recheckObservation(command, approved);
      if (!observation) continue;
      if (command.created_at && log.result?.recheck?.startedAt && command.created_at < log.result.recheck.startedAt) continue;
      checked++;
      let evidence = recheckEvidence(command, approved);
      // A manual voucher without a matching bank reference must not confirm
      // two indistinguishable statement rows through separate recheck commands.
      if (evidence && observation.matchBasis !== "reference") {
        const { data: claims, error: claimsError } = await db.from("bank_transaction_posting_log")
          .select("id,source_transaction_id").eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
          .eq("status", "verified").eq("tally_voucher_id", evidence.voucherId);
        if (claimsError) throw claimsError;
        if (claims?.some(claim => claim.id !== log.id && claim.source_transaction_id !== original.payload.transactionId)) {
          evidence = null;
          observation.verificationStatus = "ambiguous";
          observation.reason = "This Tally voucher already accounts for another statement entry. Check whether this row is a separate transaction.";
        }
      }
      const previousCheck = log.result?.recheck;
      const lastSuccessfulVerification = observation.verificationStatus !== "failed" ? observation
        : previousCheck?.lastSuccessfulVerification || (previousCheck?.verification?.verificationStatus !== "failed" ? previousCheck?.verification : null);
      const recheck = { commandId: command.id, checkedAt: new Date().toISOString(), startedAt: command.created_at,
        verification: observation, lastSuccessfulVerification };
      if (!evidence) {
        if (log.status === "verified") continue;
        if (observation.verificationStatus === "failed") checkFailed++;
        const { error: saveError } = await db.from("bank_transaction_posting_log").update({ result: { ...log.result, recheck } })
          .eq("id", log.id).eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
          .eq("status", "needs_tally_review").filter("result", log.result == null ? "is" : "eq", log.result == null ? "null" : JSON.stringify(log.result));
        if (saveError) throw saveError;
        continue;
      }
      const postedAt = log.tally_posted_at || new Date().toISOString();
      const { data: saved, error: saveError } = await db.from("bank_transaction_posting_log").update({
        status: "verified", error: null, verification_status: "verified", uncertainty_reason: null,
        tally_voucher_id: evidence.voucherId, tally_posted_at: postedAt,
        result: { ...confirmedRecheckResult(log.result || {}, observation), recheck },
      }).eq("id", log.id).eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
        .in("status", ["needs_tally_review", "verified"]).filter("result", log.result == null ? "is" : "eq", log.result == null ? "null" : JSON.stringify(log.result)).select("id");
      if (saveError) throw saveError;
      if (!saved?.length) continue;
      // Idempotent: if the second update fails, another PATCH can finish it
      // using the durable confirmed log without ever creating another voucher.
      const { error: rowError } = await db.from("bank_transactions").update({
        tally_status: "verified", tally_voucher_id: evidence.voucherId, tally_posted_at: postedAt,
      }).eq("id", transaction.id).eq("owner_user_id", user.id).in("tally_status", ["needs_tally_review", "verified"]);
      if (rowError) throw rowError;
      if (original.queue_job_id) await refreshBankStatementQueueJobStatus(db, original.queue_job_id);
      confirmed++;
    }
    const { data: remainingRows, error: remainingError } = await db.from("bank_transactions").select("id")
      .eq("statement_import_id", statement.id).eq("owner_user_id", user.id).eq("company_dataset_id", statement.company_dataset_id)
      .eq("tally_status", "needs_tally_review");
    if (remainingError) throw remainingError;
    return jsonWithCors(request, { confirmed, checked, checkFailed, remaining: remainingRows?.length || 0 });
  } catch (error) {
    return recheckErrorResponse(request, error);
  }
}
