import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { followupsEnabledFor } from "@/lib/followups/access";
import {
  buildFollowUpCandidates, ledgersOutsideScope, MAX_LEDGERS_PER_READ, normalizeLedgerNames, type LiveBill,
} from "@/lib/followups/candidates";
import { readReminderBills } from "@/lib/followups/live-read";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveTallyTarget } from "@/lib/tally/browser-scope";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

/**
 * Live-only analysis: read the named customers' open bills straight from Tally
 * (nothing cached, nothing written) and rank them for follow-up. Only customers
 * in the company's saved scope may be read, a few at a time, so Tally is always
 * asked a small, filtered question.
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
    const ledgers = normalizeLedgerNames(body.ledgerNames, MAX_LEDGERS_PER_READ + 1);
    if (!ledgers.length) return jsonWithCors(request, { error: "Choose at least one customer." }, { status: 400 });
    if (ledgers.length > MAX_LEDGERS_PER_READ) {
      return jsonWithCors(request, { error: `Read at most ${MAX_LEDGERS_PER_READ} customers at a time.` }, { status: 400 });
    }

    const target = await resolveTallyTarget(request, user.id, connectionId, companyName);
    const { data: scope, error } = await createSupabaseAdminClient().from("collections_customer_scopes")
      .select("ledger_names").eq("owner_user_id", user.id).eq("company_dataset_id", target.companyDatasetId).maybeSingle();
    if (error) throw error;
    const outside = ledgersOutsideScope(ledgers, scope?.ledger_names ?? []);
    if (outside.length) {
      return jsonWithCors(request, { error: `Add these customers to the customer scope first: ${outside.join(", ")}` }, { status: 403 });
    }

    const read = await readReminderBills(
      request,
      { connectionId, companyName, financialYear, companyDatasetId: target.companyDatasetId },
      ledgers
    );
    const byLedger = (read.byLedger ?? {}) as Record<string, { openBills?: LiveBill[] }>;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return jsonWithCors(request, { today, candidates: buildFollowUpCandidates(byLedger, today) });
  } catch (error) {
    console.error("POST /api/collections/follow-ups/live-candidates", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}
