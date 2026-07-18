import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { isLocalDbMode } from "@/lib/local/mode";
import { getLocalTallyConnection } from "@/lib/local/tally-store";
import {
  serializeTallyConnectionStatus,
  type TallyConnectionRow,
} from "@/lib/tally/connections";

const CONNECTION_SELECT = [
  "id",
  "owner_user_id",
  "display_name",
  "status",
  "tally_url",
  "pairing_code_hash",
  "pairing_code_expires_at",
  "paired_at",
  "bridge_name",
  "bridge_version",
  "bridge_machine_id",
  "last_heartbeat_at",
  "last_tested_at",
  "last_tally_reachable",
  "last_company_loaded",
  "last_company_name",
  "last_error",
  "created_at",
  "updated_at",
].join(", ");

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    if (isLocalDbMode()) {
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
      .select(CONNECTION_SELECT)
      .eq("id", id)
      .eq("owner_user_id", user.id)
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
