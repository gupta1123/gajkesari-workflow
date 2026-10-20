import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { followupsEnabledFor } from "@/lib/followups/access";
import { firstDueAt, validateReminderPlan, verificationOutcome, VERIFICATION_TTL_MS, type OpenBill } from "@/lib/followups/pipeline";
import { classifyPaymentNarration, collectionPaymentRequirement } from "@/lib/followups/payment-terms";
import { readReminderBills } from "@/lib/followups/live-read";
import { reminderMessages } from "@/lib/followups/messages";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { browserDatasetIds, resolveTallyTarget } from "@/lib/tally/browser-scope";

const MAX_INVOICES = 50;

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

function tenDigitPhone(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}

/** Pipelines for the company datasets paired to this browser. */
export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    if (!followupsEnabledFor(user.id)) return jsonWithCors(request, { error: "Not found." }, { status: 404 });
    const datasetIds = await browserDatasetIds(request, user.id);
    if (!datasetIds.length) return jsonWithCors(request, { pipelines: [], messages: [] });

    const status = new URL(request.url).searchParams.get("status");
    let query = createSupabaseAdminClient()
      .from("invoice_followup_pipelines")
      .select("*")
      .eq("owner_user_id", user.id)
      .in("company_dataset_id", datasetIds)
      .order("next_due_at", { ascending: true, nullsFirst: false })
      .limit(500);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;

    return jsonWithCors(request, {
      pipelines: data ?? [],
      messages: reminderMessages().map(({ key, name, text }) => ({ key, name, text })),
    });
  } catch (error) {
    console.error("GET /api/collections/follow-ups/pipelines", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}

type InvoiceInput = { customer?: string; invoice?: string; invoiceDate?: string; recipient?: string; narration?: string };

/**
 * The first reminder is due after the stage delay, but never before the
 * agreed payment deadline (RTGS narrations) has passed.
 */
function firstReminderDue(stages: Parameters<typeof firstDueAt>[0], narration: string, invoiceDate: string | null, now: number) {
  const byPlan = firstDueAt(stages, now);
  if (!narration || !invoiceDate) return byPlan;
  const requirement = classifyPaymentNarration(narration).category
    ? collectionPaymentRequirement(narration, invoiceDate)
    : null;
  return requirement && requirement.followUpStartsAt > byPlan ? requirement.followUpStartsAt : byPlan;
}

/**
 * Starts reminders for operator-selected invoices. Each invoice is verified
 * against live Tally first; nothing is stored for a bill that is not open.
 */
export async function POST(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    if (!followupsEnabledFor(user.id)) return jsonWithCors(request, { error: "Not found." }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const connectionId = String(body.connectionId ?? "").trim();
    const companyName = String(body.companyName ?? "").trim();
    const financialYear = String(body.financialYear ?? "").trim();
    if (!connectionId || !companyName) {
      return jsonWithCors(request, { error: "Select a connected Tally company first." }, { status: 400 });
    }
    const plan = validateReminderPlan(body.plan);
    const known = new Set(reminderMessages().map((m) => m.key));
    if (!plan.stages.every((s) => known.has(s.template))) {
      return jsonWithCors(request, { error: "Select a configured WhatsApp reminder template." }, { status: 400 });
    }
    const invoices: InvoiceInput[] = Array.isArray(body.invoices) ? body.invoices : [];
    if (!invoices.length || invoices.length > MAX_INVOICES) {
      return jsonWithCors(request, { error: `Select between 1 and ${MAX_INVOICES} invoices.` }, { status: 400 });
    }

    const target = await resolveTallyTarget(request, user.id, connectionId, companyName);
    const scope = { connectionId, companyName, financialYear, companyDatasetId: target.companyDatasetId };

    const customers = [...new Set(invoices.map((i) => String(i.customer ?? "").trim()).filter(Boolean))];
    const read = await readReminderBills(request, scope, customers);
    const byLedger = (read.byLedger ?? {}) as Record<string, { openBills?: OpenBill[] }>;

    const db = createSupabaseAdminClient();
    const created: string[] = [];
    const skipped: Array<{ invoice: string; reason: string }> = [];
    const now = Date.now();

    for (const input of invoices) {
      const customer = String(input.customer ?? "").trim();
      const invoice = String(input.invoice ?? "").trim();
      const invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.invoiceDate ?? "")) ? String(input.invoiceDate) : null;
      const phone = tenDigitPhone(input.recipient);
      if (!customer || !invoice) { skipped.push({ invoice: invoice || "(blank)", reason: "Customer and invoice are required." }); continue; }
      if (!phone) { skipped.push({ invoice, reason: "Enter a valid 10-digit WhatsApp number." }); continue; }

      const outcome = verificationOutcome(byLedger[customer]?.openBills ?? [], invoice, invoiceDate);
      if (outcome.status !== "active" || !outcome.outstanding) {
        skipped.push({ invoice, reason: outcome.note ?? "Not outstanding in Tally." });
        continue;
      }

      const { data, error } = await db.from("invoice_followup_pipelines").insert({
        owner_user_id: user.id,
        company_dataset_id: target.companyDatasetId,
        installation_id: target.installationId,
        session_generation: target.sessionGeneration,
        company_guid: target.companyGuid,
        company_name: companyName,
        financial_year: financialYear,
        invoice_key: `${customer.toLowerCase()}|${invoice.toLowerCase()}|${invoiceDate ?? ""}`,
        customer, invoice, invoice_date: invoiceDate,
        recipient: `91${phone}`,
        plan_name: plan.name, stages: plan.stages,
        outstanding: outcome.outstanding,
        next_due_at: firstReminderDue(plan.stages, String(input.narration ?? "").slice(0, 500), invoiceDate, now),
        verified_at: new Date(now).toISOString(),
        verification_expires_at: new Date(now + VERIFICATION_TTL_MS).toISOString(),
        note: outcome.note,
      }).select("id").single();
      if (error) {
        // 23505: an unfinished reminder already exists for this invoice.
        skipped.push({ invoice, reason: error.code === "23505" ? "Reminders are already running for this invoice." : "Could not save this reminder." });
        continue;
      }
      created.push(String(data.id));
    }

    return jsonWithCors(request, { created, skipped });
  } catch (error) {
    console.error("POST /api/collections/follow-ups/pipelines", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}
