import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { hashSecret } from "@/lib/tally/connections";

export const OPTIONS = optionsWithCors;
export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (!body.connectionId || !Array.isArray(body.claims) || body.claims.length > 100) {
    return jsonWithCors(request, { error: "Invalid lease renewal" }, { status: 400 });
  }
  const { data, error } = await createSupabaseAdminClient().rpc("renew_tally_command_leases", {
    p_connection_id: body.connectionId, p_token_hash: hashSecret(token), p_claims: body.claims,
  });
  if (error) return jsonWithCors(request, { error: "Lease renewal failed" }, { status: 409 });
  return jsonWithCors(request, { renewed: data });
}
