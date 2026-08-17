import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import {
  createLocalTallyConnection,
  listLocalTallyConnections,
} from "@/lib/local/tally-store";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  createBridgeToken,
  createPairingCode,
  createPairingExpiry,
  hashSecret,
  serializeTallyConnection,
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
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

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return [record.message, record.details, record.hint]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ");
  }
  return String(error ?? "").trim();
}

function tallyConnectionErrorPayload(error: unknown) {
  const message = errorText(error);
  if (/tally_connections|tally_connection_events|relation .*does not exist|schema cache/i.test(message)) {
    return {
      error: "Tally Connector setup is not ready.",
      userAction: "Run the latest Tally connector database migration, then try again.",
    };
  }
  return {
    error: message || "Could not load Tally connections.",
    userAction: "Check the API server logs if this continues.",
  };
}

function connectionSortTime(connection: ReturnType<typeof serializeTallyConnectionStatus>) {
  const heartbeatTime = connection.lastHeartbeatAt
    ? new Date(connection.lastHeartbeatAt).getTime()
    : 0;
  if (heartbeatTime) return heartbeatTime;
  return new Date(connection.updatedAt ?? connection.createdAt ?? 0).getTime();
}

function pickRelevantConnections(rows: TallyConnectionRow[]) {
  const serialized = rows
    // A connection attempt is not a workstation. Only a connector that
    // completed pairing and supplied its durable installation identity belongs
    // in the workstation list.
    .filter(
      (row) =>
        Boolean(row.bridge_token_hash) &&
        Boolean(row.installation_id) &&
        Boolean(row.paired_at) &&
        !row.revoked_at
    )
    .map(serializeTallyConnectionStatus);
  // A user can legitimately have connectors on multiple Tally machines.
  // Returning only the latest live row made a newly paired browser silently
  // jump back to another machine's connector during its next refresh.
  return [...serialized]
    .sort((left, right) => connectionSortTime(right) - connectionSortTime(left))
    .slice(0, 12);
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
      .select(TALLY_CONNECTION_SELECT)
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .order("updated_at", { ascending: false });

    if (error) {
      throw error;
    }

    const rows = (data ?? []) as unknown as TallyConnectionRow[];
    const now = new Date();
    const expiredPendingIds = rows
      .filter(
        (row) =>
          !row.bridge_token_hash &&
          (!row.pairing_code_expires_at ||
            new Date(row.pairing_code_expires_at).getTime() <= now.getTime())
      )
      .map((row) => row.id);

    if (expiredPendingIds.length > 0) {
      const retiredAt = now.toISOString();
      const { error: cleanupError } = await supabase
        .from("tally_connections")
        .update({
          revoked_at: retiredAt,
          revoked_reason: "Expired connector pairing attempt.",
          pairing_code_hash: null,
          pairing_code_expires_at: null,
          last_error: "Pairing attempt expired. Start a new connection when ready.",
          updated_at: retiredAt,
        })
        .in("id", expiredPendingIds)
        .eq("owner_user_id", user.id)
        .is("revoked_at", null);

      if (cleanupError) {
        console.warn("Could not retire expired Tally pairing attempts:", cleanupError);
      }
    }

    return jsonWithCors(request, {
      connections: pickRelevantConnections(rows),
    });
  } catch (error) {
    console.error("Error in GET /api/tally/connections:", error);
    return jsonWithCors(request, tallyConnectionErrorPayload(error), { status: 500 });
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
          controlToken: local.controlToken,
        },
        { status: 201 }
      );
    }

    const pairingCode = createPairingCode();
    const controlToken = createBridgeToken();
    const supabase = createSupabaseAdminClient();
    const retiredAt = new Date().toISOString();
    const { error: retirePendingError } = await supabase
      .from("tally_connections")
      .update({
        revoked_at: retiredAt,
        revoked_reason: "Superseded by a newer connector pairing attempt.",
        pairing_code_hash: null,
        pairing_code_expires_at: null,
        last_error: "Superseded by a newer connection attempt.",
        updated_at: retiredAt,
      })
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .is("bridge_token_hash", null);

    if (retirePendingError) {
      throw retirePendingError;
    }

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
      .select(TALLY_CONNECTION_SELECT)
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
        controlToken,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error in POST /api/tally/connections:", error);
    return jsonWithCors(request, tallyConnectionErrorPayload(error), { status: 500 });
  }
}
