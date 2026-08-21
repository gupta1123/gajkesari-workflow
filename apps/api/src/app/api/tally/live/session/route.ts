import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashSecret, TALLY_CONNECTION_SELECT, type TallyConnectionRow } from "@/lib/tally/connections";

function bearerToken(request: Request) {
  return request.headers.get("x-bridge-token") ??
    request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ??
    "";
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const role = String(body.role ?? "");
    const connectionId = String(body.connectionId ?? "").trim();
    if (!connectionId || !["browser", "connector"].includes(role)) {
      return jsonWithCors(request, { error: "A valid live-session role and connection are required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    if (role === "browser") {
      const user = await requireRequestUser(request);
      if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
      const { data, error } = await supabase
        .from("tally_connections")
        .select("id, owner_user_id, revoked_at")
        .eq("id", connectionId)
        .eq("owner_user_id", user.id)
        .is("revoked_at", null)
        .maybeSingle();
      if (error) throw error;
      if (!data) return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
      return jsonWithCors(request, { authenticated: true, ownerUserId: user.id, connectionId });
    }

    const token = bearerToken(request);
    if (!token) return jsonWithCors(request, { error: "Bridge token is required." }, { status: 401 });
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();
    if (error) throw error;
    const connection = data as unknown as TallyConnectionRow | null;
    if (!connection || connection.revoked_at) {
      return jsonWithCors(request, { error: "This connector session is no longer active." }, { status: 409 });
    }
    if (!connection.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }
    return jsonWithCors(request, {
      authenticated: true,
      ownerUserId: connection.owner_user_id,
      connectionId: connection.id,
    });
  } catch (error) {
    console.error("Error in POST /api/tally/live/session:", error);
    return jsonWithCors(request, { error: "Could not authenticate the live Tally session." }, { status: 500 });
  }
}
