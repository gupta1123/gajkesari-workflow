import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  hashSecret,
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

function getBridgeToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] ?? request.headers.get("x-bridge-token") ?? "";
}

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
    last_company_name: null,
    last_error: "Disconnected by connector.",
  };
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request) {
  try {
    const token = getBridgeToken(request);
    const body = await request.json().catch(() => ({}));
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";

    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(`${CONNECTION_SELECT}, bridge_token_hash`)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) throw error;

    const connection = data as unknown as (TallyConnectionRow & { bridge_token_hash: string | null }) | null;
    if (!connection?.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    const { data: updatedData, error: updateError } = await supabase
      .from("tally_connections")
      .update(disconnectedUpdatePayload())
      .eq("id", connection.id)
      .select(CONNECTION_SELECT)
      .single();

    if (updateError) throw updateError;

    await supabase.from("tally_connection_events").insert({
      connection_id: connection.id,
      owner_user_id: connection.owner_user_id,
      event_type: "bridge_disconnected",
      message: "Tally bridge disconnected by connector.",
      payload: {
        source: "desktop",
      },
    });

    return jsonWithCors(request, {
      connection: serializeTallyConnectionStatus(updatedData as unknown as TallyConnectionRow),
    });
  } catch (error) {
    console.error("Error in POST /api/tally/bridge/disconnect:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
