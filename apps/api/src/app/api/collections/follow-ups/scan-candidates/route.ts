import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { followupsEnabledFor } from "@/lib/followups/access";
import { buildFollowUpCandidates, type LiveBill } from "@/lib/followups/candidates";
import { resolveTallyTarget } from "@/lib/tally/browser-scope";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

// Enough to work through in one sitting; the page says how many more there are.
const MAX_RETURNED = 300;
const MAX_CUSTOMERS = 20_000;

/**
 * Ranks follow-up candidates from a whole-company read the browser just took from
 * Tally. Nothing is cached or written; the browser only has to own the connection.
 */
export async function POST(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    if (!followupsEnabledFor(user.id)) return jsonWithCors(request, { error: "Not found." }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const connectionId = String(body.connectionId ?? "").trim();
    const companyName = String(body.companyName ?? "").trim();
    if (!connectionId || !companyName) {
      return jsonWithCors(request, { error: "Select a connected Tally company first." }, { status: 400 });
    }
    const byLedger = body.byLedger;
    if (!byLedger || typeof byLedger !== "object" || Array.isArray(byLedger) || Object.keys(byLedger).length > MAX_CUSTOMERS) {
      return jsonWithCors(request, { error: "Send the customers' open bills read from Tally." }, { status: 400 });
    }
    await resolveTallyTarget(request, user.id, connectionId, companyName);

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const all = buildFollowUpCandidates(byLedger as Record<string, { openBills?: LiveBill[] }>, today);
    const due = all.filter((candidate) => candidate.eligible);
    return jsonWithCors(request, {
      today,
      totalInvoices: all.length,
      dueInvoices: due.length,
      customers: new Set(due.map((candidate) => candidate.customer)).size,
      candidates: due.slice(0, MAX_RETURNED),
    });
  } catch (error) {
    console.error("POST /api/collections/follow-ups/scan-candidates", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}
