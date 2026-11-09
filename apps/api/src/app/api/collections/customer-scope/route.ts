import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { followupsEnabledFor } from "@/lib/followups/access";
import { MAX_SCOPE_LEDGERS, normalizeLedgerNames } from "@/lib/followups/candidates";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveTallyTarget } from "@/lib/tally/browser-scope";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function scopeTarget(request: Request, connectionId: string, companyName: string) {
  const user = await requireRequestUser(request);
  if (!user) return { response: jsonWithCors(request, { error: "Unauthorized" }, { status: 401 }) };
  if (!followupsEnabledFor(user.id)) return { response: jsonWithCors(request, { error: "Not found." }, { status: 404 }) };
  if (!connectionId || !companyName) {
    return { response: jsonWithCors(request, { error: "Select a connected Tally company first." }, { status: 400 }) };
  }
  return { user, target: await resolveTallyTarget(request, user.id, connectionId, companyName) };
}

/** The customers this company's live follow-up reads may cover. */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const scope = await scopeTarget(request, params.get("connectionId")?.trim() ?? "", params.get("companyName")?.trim() ?? "");
    if (!scope.user) return scope.response;
    const { data, error } = await createSupabaseAdminClient().from("collections_customer_scopes")
      .select("ledger_names, updated_at").eq("owner_user_id", scope.user.id)
      .eq("company_dataset_id", scope.target.companyDatasetId).maybeSingle();
    if (error) throw error;
    return jsonWithCors(request, { ledgerNames: data?.ledger_names ?? [], updatedAt: data?.updated_at ?? null });
  } catch (error) {
    console.error("GET /api/collections/customer-scope", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const scope = await scopeTarget(request, String(body.connectionId ?? "").trim(), String(body.companyName ?? "").trim());
    if (!scope.user) return scope.response;
    const ledgerNames = normalizeLedgerNames(body.ledgerNames, MAX_SCOPE_LEDGERS);
    const { error } = await createSupabaseAdminClient().from("collections_customer_scopes").upsert({
      owner_user_id: scope.user.id,
      company_dataset_id: scope.target.companyDatasetId,
      ledger_names: ledgerNames,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_user_id,company_dataset_id" });
    if (error) throw error;
    return jsonWithCors(request, { ledgerNames });
  } catch (error) {
    console.error("PUT /api/collections/customer-scope", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}
