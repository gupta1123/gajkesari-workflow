import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import {
  createLocalTallyConnection,
  listLocalTallyConnections,
} from "@/lib/local/tally-store";
import { requireRequestUser } from "@/lib/api/request-auth";
import { browserOwnsConnection } from "@/lib/tally/browser-scope";
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
        Boolean(row.installation_id) &&
        !row.revoked_at &&
        (Boolean(row.bridge_token_hash) || row.status === "waiting_for_bridge")
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
    const binding = request.headers.get("x-tally-browser-binding") || "";
    if (!binding) return jsonWithCors(request, { connections: [] });
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("owner_user_id", user.id)
      .eq("control_token_hash", hashSecret(binding))
      .is("revoked_at", null)
      .order("updated_at", { ascending: false });

    if (error) {
      throw error;
    }

    const candidateRows = (data ?? []) as unknown as TallyConnectionRow[];
    const allowed = await Promise.all(candidateRows.map((row) => browserOwnsConnection(request, user.id, row.id)));
    const rows = candidateRows.filter((_row, index) => allowed[index]);
    // Listing is read-only. Paused installations are not expired challenges.

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
    const reuseConnectionId =
      typeof body.reuseConnectionId === "string" && body.reuseConnectionId.trim()
        ? body.reuseConnectionId.trim()
        : null;

    if (reuseConnectionId) {
      const { data: existing, error: existingError } = await supabase
        .from("tally_connections")
        .select(TALLY_CONNECTION_SELECT)
        .eq("id", reuseConnectionId)
        .eq("owner_user_id", user.id)
        .is("revoked_at", null)
        .is("bridge_token_hash", null)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existing) {
        const prior = existing as unknown as TallyConnectionRow;
        if (!prior.control_token_hash || hashSecret(String(body.controlToken || "")) !== prior.control_token_hash) {
          return jsonWithCors(request, { error: "Reconnect from the browser paired to this computer." }, { status: 403 });
        }
        const { data: resumed, error: resumeError } = await supabase
          .from("tally_connections")
          .update({
            status: "waiting_for_bridge",
            tally_url: normalizeTallyUrl(body.tallyUrl),
            display_name: normalizeDisplayName(body.displayName),
            pairing_code_hash: hashSecret(pairingCode),
            pairing_code_expires_at: createPairingExpiry(),
            control_token_hash: hashSecret(controlToken),
            paired_at: null,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", reuseConnectionId)
          .eq("control_token_hash", prior.control_token_hash)
          .is("bridge_token_hash", null)
          .is("revoked_at", null)
          .select(TALLY_CONNECTION_SELECT)
          .single();
        if (resumeError) throw resumeError;
        await logConnectionEvent(
          reuseConnectionId,
          user.id,
          "connection_resume_requested",
          "Temporary Tally connection resume requested.",
          { reused: true },
        );
        return jsonWithCors(request, {
          connection: serializeTallyConnection(resumed as unknown as TallyConnectionRow),
          pairingCode,
          controlToken,
          reused: true,
        });
      }
    }
    // Another browser's pending pairing belongs to that PC; never retire it here.

    const { data, error } = await supabase
      .from("tally_connections")
      .insert({
        owner_user_id: user.id,
        display_name: normalizeDisplayName(body.displayName),
        status: "waiting_for_bridge",
        tally_url: normalizeTallyUrl(body.tallyUrl),
        pairing_code_hash: hashSecret(pairingCode),
        control_token_hash: hashSecret(controlToken),
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
