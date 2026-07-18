import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { updateLocalTallyHeartbeat } from "@/lib/local/tally-store";
import {
  hashSecret,
  serializeTallyConnectionStatus,
  type TallyConnectionRow,
  type TallyConnectionStatus,
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

function toBoolean(value: unknown) {
  return value === true;
}

function toNullableText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

function toCompanyNames(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const names: string[] = [];

  for (const item of value) {
    let name: unknown = item;
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      name = row.companyName ?? row.name;
    }
    const text = toNullableText(name);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(text);
  }

  return names;
}

function resolveStatus(input: {
  tallyReachable: boolean;
  companyLoaded: boolean;
  error: string | null;
}): TallyConnectionStatus {
  if (input.companyLoaded) return "company_loaded";
  if (input.tallyReachable) return "tally_reachable";
  if (input.error) return "connection_error";
  return "bridge_connected";
}

async function getLatestSyncedCompanyName(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  connection: TallyConnectionRow
) {
  try {
    const { data } = await supabase
      .from("tally_master_sync_runs")
      .select("company_name")
      .eq("owner_user_id", connection.owner_user_id)
      .eq("connection_id", connection.id)
      .order("created_at", { ascending: false })
      .limit(10);

    for (const row of data ?? []) {
      const companyName = toNullableText((row as { company_name?: unknown }).company_name);
      if (companyName) return companyName;
    }
  } catch {
    return null;
  }

  return null;
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

    const tallyReachable = toBoolean(body.tallyReachable);
    const companyLoaded = toBoolean(body.companyLoaded);
    const companyName = toNullableText(body.companyName);
    const companyNames = toCompanyNames(body.companies);
    const errorMessage = toNullableText(body.error);
    const status = resolveStatus({
      tallyReachable,
      companyLoaded,
      error: errorMessage,
    });

    if (isLocalDbMode()) {
      const connection = await updateLocalTallyHeartbeat({
        connectionId,
        token,
        status,
        tallyUrl: toNullableText(body.tallyUrl),
        bridgeVersion: toNullableText(body.bridgeVersion),
        tallyReachable,
        companyLoaded,
        companyName,
        error: errorMessage,
      });

      if (!connection) {
        return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
      }

      return jsonWithCors(request, {
        connection: serializeTallyConnectionStatus(connection),
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(`${CONNECTION_SELECT}, bridge_token_hash`)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const connection = data as unknown as (TallyConnectionRow & { bridge_token_hash: string | null }) | null;

    if (!connection?.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    const now = new Date().toISOString();
    const resolvedCompanyName =
      companyName ??
      connection.last_company_name ??
      (companyLoaded ? await getLatestSyncedCompanyName(supabase, connection) : null);

    const { data: updatedData, error: updateError } = await supabase
      .from("tally_connections")
      .update({
        status,
        tally_url: toNullableText(body.tallyUrl) ?? connection.tally_url,
        bridge_version: toNullableText(body.bridgeVersion) ?? connection.bridge_version,
        last_heartbeat_at: now,
        last_tested_at: now,
        last_tally_reachable: tallyReachable,
        last_company_loaded: companyLoaded,
        last_company_name: resolvedCompanyName,
        last_error: errorMessage,
      })
      .eq("id", connection.id)
      .select(CONNECTION_SELECT)
      .single();

    if (updateError) {
      throw updateError;
    }

    await supabase.from("tally_connection_events").insert({
      connection_id: connection.id,
      owner_user_id: connection.owner_user_id,
      event_type: "bridge_heartbeat",
      message: errorMessage ?? "Bridge heartbeat received.",
      payload: {
        status,
        tallyReachable,
        companyLoaded,
        companyName: resolvedCompanyName,
        heartbeatCompanyName: companyName,
        companies: companyNames,
      },
    });

    return jsonWithCors(request, {
      connection: serializeTallyConnectionStatus(updatedData as unknown as TallyConnectionRow),
    });
  } catch (error) {
    console.error("Error in POST /api/tally/bridge/heartbeat:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
