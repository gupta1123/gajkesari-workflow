import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import {
  createLocalTallyConnection,
  listLocalTallyConnections,
} from "@/lib/local/tally-store";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  createPairingCode,
  createPairingExpiry,
  hashSecret,
  serializeTallyConnection,
  serializeTallyConnectionStatus,
  type TallyConnectionRow,
} from "@/lib/tally/connections";

const DEFAULT_TALLY_URL = "http://localhost:9000";

function normalizeTallyUrl(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_TALLY_URL;
  }

  return value.trim().replace(/\/+$/, "");
}

function normalizeDisplayName(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Tally Prime";
  }

  return value.trim().slice(0, 120);
}

function connectionSortTime(connection: ReturnType<typeof serializeTallyConnectionStatus>) {
  const heartbeatTime = connection.lastHeartbeatAt
    ? new Date(connection.lastHeartbeatAt).getTime()
    : 0;
  if (heartbeatTime) return heartbeatTime;
  return new Date(connection.updatedAt ?? connection.createdAt ?? 0).getTime();
}

function pickRelevantConnections(rows: TallyConnectionRow[]) {
  const serialized = rows.map(serializeTallyConnectionStatus);
  const liveConnections = serialized.filter(
    (connection) =>
      connection.bridgeConnected &&
      (connection.status === "company_loaded" ||
        connection.status === "tally_reachable" ||
        connection.status === "bridge_connected")
  );
  const source = liveConnections.length > 0 ? liveConnections : serialized;

  return [...source]
    .sort((left, right) => connectionSortTime(right) - connectionSortTime(left))
    .slice(0, 1);
}

async function logConnectionEvent(
  connectionId: string,
  ownerUserId: string,
  eventType: string,
  message: string,
  payload: Record<string, unknown> = {}
) {
  const supabase = createSupabaseAdminClient();
  await supabase.from("tally_connection_events").insert({
    connection_id: connectionId,
    owner_user_id: ownerUserId,
    event_type: eventType,
    message,
    payload,
  });
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const localMode = isLocalDbMode();
    const user = localMode ? { id: "local-dev-user" } : await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    if (localMode) {
      return jsonWithCors(request, {
        connections: pickRelevantConnections(await listLocalTallyConnections(user.id)),
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(
        [
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
        ].join(", ")
      )
      .eq("owner_user_id", user.id)
      .order("updated_at", { ascending: false });

    if (error) {
      throw error;
    }

    const rows = (data ?? []) as unknown as TallyConnectionRow[];

    return jsonWithCors(request, {
      connections: pickRelevantConnections(rows),
    });
  } catch (error) {
    console.error("Error in GET /api/tally/connections:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const localMode = isLocalDbMode();
    const user = localMode ? { id: "local-dev-user" } : await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));

    if (localMode) {
      const local = await createLocalTallyConnection({
        ownerUserId: user.id,
        displayName: normalizeDisplayName(body.displayName),
        tallyUrl: normalizeTallyUrl(body.tallyUrl),
      });
      return jsonWithCors(
        request,
        {
          connection: serializeTallyConnection(local.connection),
          pairingCode: local.pairingCode,
        },
        { status: 201 }
      );
    }

    const pairingCode = createPairingCode();
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .insert({
        owner_user_id: user.id,
        display_name: normalizeDisplayName(body.displayName),
        status: "waiting_for_bridge",
        tally_url: normalizeTallyUrl(body.tallyUrl),
        pairing_code_hash: hashSecret(pairingCode),
        pairing_code_expires_at: createPairingExpiry(),
        last_error: null,
      })
      .select(
        [
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
        ].join(", ")
      )
      .single();

    if (error) {
      throw error;
    }

    const row = data as unknown as TallyConnectionRow;

    await logConnectionEvent(
      row.id,
      user.id,
      "connection_created",
      "Tally connection created and waiting for bridge pairing.",
      { tallyUrl: row.tally_url }
    );

    return jsonWithCors(
      request,
      {
        connection: serializeTallyConnection(row),
        pairingCode,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error in POST /api/tally/connections:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
