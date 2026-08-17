import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { isLocalDbMode, LOCAL_USER_ID } from "@/lib/local/mode";
import { getLocalTallyConnection } from "@/lib/local/tally-store";
import {
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const localMode = isLocalDbMode();
    const user = localMode ? { id: LOCAL_USER_ID } : await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    if (localMode) {
      const connection = await getLocalTallyConnection(id, user.id);
      if (!connection) {
        return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
      }

      return jsonWithCors(request, {
        connection: serializeTallyConnectionStatus(connection),
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }

    return jsonWithCors(request, {
      connection: serializeTallyConnectionStatus(data as unknown as TallyConnectionRow),
    });
  } catch (error) {
    console.error("Error in GET /api/tally/connections/[id]/status:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
