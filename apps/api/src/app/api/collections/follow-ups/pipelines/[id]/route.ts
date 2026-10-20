import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { followupsEnabledFor } from "@/lib/followups/access";
import { readReminderBills } from "@/lib/followups/live-read";
import { reminderPreview, submitReminder, WhatsappRejectedError } from "@/lib/followups/messages";
import { advanceReminder, verificationOutcome, VERIFICATION_TTL_MS, type OpenBill, type ReminderStage } from "@/lib/followups/pipeline";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { browserDatasetIds, resolveTallyTarget } from "@/lib/tally/browser-scope";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

type Pipeline = {
  id: string; owner_user_id: string; company_dataset_id: string; company_name: string; financial_year: string;
  customer: string; invoice: string; invoice_date: string | null; recipient: string; outstanding: number | null;
  stages: ReminderStage[]; stage_index: number; stage_sent: number; status: string; revision: number;
};

const OPERATOR_STATUS: Record<string, { from: string[]; to: string }> = {
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused", "review"], to: "active" },
  stop: { from: ["active", "paused", "review", "uncertain"], to: "stopped" },
};

/**
 * Operator actions on one reminder: pause | resume | stop | check | send.
 * `send` re-reads Tally, then claims the send atomically; there is no
 * background sender, so a reminder only goes out when an operator asks.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    if (!followupsEnabledFor(user.id)) return jsonWithCors(request, { error: "Not found." }, { status: 404 });
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const connectionId = String(body.connectionId ?? "").trim();

    const db = createSupabaseAdminClient();
    const { data, error } = await db.from("invoice_followup_pipelines").select("*")
      .eq("id", id).eq("owner_user_id", user.id)
      .in("company_dataset_id", await browserDatasetIds(request, user.id)).maybeSingle();
    if (error) throw error;
    if (!data) return jsonWithCors(request, { error: "Reminder not found." }, { status: 404 });
    const row = data as unknown as Pipeline;
    if (Number.isInteger(body.revision) && body.revision !== row.revision) {
      return jsonWithCors(request, { error: "This reminder changed. Refresh and try again." }, { status: 409 });
    }

    const simple = OPERATOR_STATUS[action];
    if (simple) {
      if (!simple.from.includes(row.status)) {
        return jsonWithCors(request, { error: `A ${row.status} reminder cannot be ${action}d.` }, { status: 409 });
      }
      const { error: updateError } = await db.from("invoice_followup_pipelines")
        .update({ status: simple.to, revision: row.revision + 1, updated_at: new Date().toISOString() })
        .eq("id", id).eq("owner_user_id", user.id).eq("revision", row.revision);
      if (updateError) throw updateError;
      return jsonWithCors(request, { ok: true, status: simple.to });
    }

    if (action !== "check" && action !== "send") {
      return jsonWithCors(request, { error: "Unknown action." }, { status: 400 });
    }
    if (!connectionId) return jsonWithCors(request, { error: "Select a connected Tally company first." }, { status: 400 });
    if (action === "check" ? !["active", "review", "uncertain"].includes(row.status) : row.status !== "active") {
      return jsonWithCors(request, { error: `A ${row.status} reminder cannot be ${action === "send" ? "sent" : "checked"}.` }, { status: 409 });
    }

    // Live read first. The target must be the very company dataset the row was created for.
    const target = await resolveTallyTarget(request, user.id, connectionId, row.company_name);
    if (target.companyDatasetId !== row.company_dataset_id) {
      return jsonWithCors(request, { error: "This reminder belongs to a different Tally company." }, { status: 409 });
    }
    const read = await readReminderBills(
      request,
      { connectionId, companyName: row.company_name, financialYear: row.financial_year, companyDatasetId: target.companyDatasetId },
      row.customer
    );
    const byLedger = (read.byLedger ?? {}) as Record<string, { openBills?: OpenBill[] }>;
    const outcome = verificationOutcome(byLedger[row.customer]?.openBills ?? [], row.invoice, row.invoice_date);
    const now = Date.now();

    const { error: verifyError } = await db.from("invoice_followup_pipelines").update({
      status: outcome.status,
      outstanding: outcome.outstanding,
      note: outcome.note,
      installation_id: target.installationId,
      session_generation: target.sessionGeneration,
      verified_at: new Date(now).toISOString(),
      verification_expires_at: outcome.status === "active" ? new Date(now + VERIFICATION_TTL_MS).toISOString() : null,
      revision: row.revision + 1,
      updated_at: new Date(now).toISOString(),
    }).eq("id", id).eq("owner_user_id", user.id).eq("revision", row.revision);
    if (verifyError) throw verifyError;

    if (action === "check" || outcome.status !== "active" || !outcome.outstanding) {
      return jsonWithCors(request, { ok: true, status: outcome.status, outstanding: outcome.outstanding, note: outcome.note, sent: false });
    }

    const stage = row.stages[row.stage_index];
    const message = { customer: row.customer, company_name: row.company_name, invoice: row.invoice, invoice_date: row.invoice_date, outstanding: outcome.outstanding };
    reminderPreview(stage.template, message); // fails early if the template is no longer configured

    const { data: claim, error: claimError } = await db.rpc("followup_claim_send", {
      p_id: id, p_revision: row.revision + 1, p_owner: user.id,
      p_installation: target.installationId, p_generation: target.sessionGeneration,
    });
    if (claimError) {
      const stale = claimError.code === "40001";
      return jsonWithCors(request, { error: stale ? claimError.message : "Could not start this reminder." }, { status: stale ? 409 : 500 });
    }
    const attemptId = String((claim as { attempt_id?: string })?.attempt_id ?? "");

    let status: "accepted" | "rejected" | "uncertain" = "accepted";
    let provider = "";
    let failure = "";
    try {
      provider = await submitReminder(stage.template, message, row.recipient);
    } catch (sendError) {
      status = sendError instanceof WhatsappRejectedError ? "rejected" : "uncertain";
      failure = sendError instanceof Error ? sendError.message : "Reminder could not be sent.";
    }
    const next = status === "accepted" ? advanceReminder(row.stages, row.stage_index, row.stage_sent) : null;
    const { error: finishError } = await db.rpc("followup_finish_send", {
      p_id: id, p_attempt: attemptId, p_owner: user.id, p_status: status,
      p_provider: provider || null, p_error: failure || null, p_next: next,
    });
    if (finishError) {
      console.error("followup_finish_send failed after provider call", { id, attemptId, status }, finishError);
      return jsonWithCors(request, { error: "The reminder was sent but its record could not be saved. Check before resending.", sent: status === "accepted" }, { status: 500 });
    }
    return jsonWithCors(request, { ok: status === "accepted", sent: status === "accepted", status, error: failure || undefined }, { status: status === "accepted" ? 200 : 502 });
  } catch (error) {
    console.error("POST /api/collections/follow-ups/pipelines/[id]", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}
