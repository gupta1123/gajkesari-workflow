import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isLocalDbMode } from "@/lib/local/mode";
import { disconnectLocalTallyConnection } from "@/lib/local/tally-store";
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

function disconnectedUpdatePayload() {
  return {
    status: "waiting_for_bridge",
    pairing_code_hash: null,
    pairing_code_expires_at: null,
    bridge_token_hash: null,
    paired_at: null,
    bridge_name: null,
    bridge_version: null,
    bridge_machine_id: null,
    last_heartbeat_at: null,
    last_tested_at: null,
    last_tally_reachable: null,
    last_company_loaded: null,
    last_error: "Disconnected by user.",
  };
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(
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
      const connection = await disconnectLocalTallyConnection(id, user.id);
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
      .update(disconnectedUpdatePayload())
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .select(CONNECTION_SELECT)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }

    const connection = data as unknown as TallyConnectionRow;
    await supabase.from("tally_connection_events").insert({
      connection_id: connection.id,
      owner_user_id: user.id,
      event_type: "bridge_disconnected",
      message: "Tally bridge disconnected by user.",
      payload: {
        source: "web",
      },
    });

    return jsonWithCors(request, {
      connection: serializeTallyConnectionStatus(connection),
    });
  } catch (error) {
    console.error("Error in POST /api/tally/connections/[id]/disconnect:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
