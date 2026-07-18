import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { pairLocalTallyConnection } from "@/lib/local/tally-store";
import {
  createBridgeToken,
  hashSecret,
  serializeTallyConnection,
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

function normalizeMetadata(value: unknown, fallback: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  return value.trim().slice(0, 160);
}

function readPairingCode(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function toNullableText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

function toNullableBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const pairingCode = readPairingCode(body.pairingCode);

    if (!pairingCode) {
      return jsonWithCors(request, { error: "Pairing code is required." }, { status: 400 });
    }

    if (isLocalDbMode()) {
      const result = await pairLocalTallyConnection({
        connectionId: id,
        pairingCode,
        bridgeName: normalizeMetadata(body.bridgeName, "Tally Bridge"),
        bridgeVersion: normalizeMetadata(body.bridgeVersion, "unknown"),
        bridgeMachineId: normalizeMetadata(body.bridgeMachineId, "unknown"),
      });

      if ("error" in result) {
        return jsonWithCors(request, { error: result.error }, { status: result.status });
      }

      return jsonWithCors(request, {
        connection: serializeTallyConnection(result.connection),
        bridgeToken: result.bridgeToken,
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(CONNECTION_SELECT)
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }

    const connection = data as unknown as TallyConnectionRow;
    const now = Date.now();
    const expiresAt = connection.pairing_code_expires_at
      ? new Date(connection.pairing_code_expires_at).getTime()
      : 0;

    if (!connection.pairing_code_hash || !expiresAt) {
      await logConnectionEvent(
        connection.id,
        connection.owner_user_id,
        "pairing_rejected",
        "Bridge pairing rejected because no active pairing code exists.",
        { reason: "missing_pairing_code" }
      );

      return jsonWithCors(
        request,
        { error: "This connection does not have an active pairing code." },
        { status: 409 }
      );
    }

    if (expiresAt <= now) {
      await supabase
        .from("tally_connections")
        .update({
          pairing_code_hash: null,
          pairing_code_expires_at: null,
          status: "waiting_for_bridge",
          last_error: "Pairing code expired. Create a new Tally connection or regenerate the code.",
        })
        .eq("id", connection.id);

      await logConnectionEvent(
        connection.id,
        connection.owner_user_id,
        "pairing_expired",
        "Bridge pairing rejected because the pairing code expired.",
        { expiredAt: connection.pairing_code_expires_at }
      );

      return jsonWithCors(request, { error: "Pairing code expired." }, { status: 410 });
    }

    if (hashSecret(pairingCode) !== connection.pairing_code_hash) {
      await logConnectionEvent(
        connection.id,
        connection.owner_user_id,
        "pairing_rejected",
        "Bridge pairing rejected because the pairing code was invalid.",
        { reason: "invalid_pairing_code" }
      );

      return jsonWithCors(request, { error: "Invalid pairing code." }, { status: 401 });
    }

    const bridgeToken = createBridgeToken();
    const companyName = toNullableText(body.companyName);
    const tallyReachable = toNullableBoolean(body.tallyReachable);
    const companyLoaded = toNullableBoolean(body.companyLoaded);
    const { data: updatedData, error: updateError } = await supabase
      .from("tally_connections")
      .update({
        status: "bridge_connected",
        pairing_code_hash: null,
        pairing_code_expires_at: null,
        paired_at: new Date().toISOString(),
        bridge_token_hash: hashSecret(bridgeToken),
        bridge_name: normalizeMetadata(body.bridgeName, "Tally Bridge"),
        bridge_version: normalizeMetadata(body.bridgeVersion, "unknown"),
        bridge_machine_id: normalizeMetadata(body.bridgeMachineId, "unknown"),
        last_heartbeat_at: new Date().toISOString(),
        last_tally_reachable: tallyReachable ?? connection.last_tally_reachable,
        last_company_loaded: companyLoaded ?? connection.last_company_loaded,
        last_company_name: companyName ?? connection.last_company_name,
        last_error: null,
      })
      .eq("id", connection.id)
      .select(CONNECTION_SELECT)
      .single();

    if (updateError) {
      throw updateError;
    }

    const updatedConnection = updatedData as unknown as TallyConnectionRow;

    await logConnectionEvent(
      updatedConnection.id,
      updatedConnection.owner_user_id,
      "bridge_paired",
      "Tally bridge paired successfully.",
      {
        bridgeName: updatedConnection.bridge_name,
        bridgeVersion: updatedConnection.bridge_version,
        bridgeMachineId: updatedConnection.bridge_machine_id,
        companyName,
        tallyReachable,
        companyLoaded,
      }
    );

    return jsonWithCors(request, {
      connection: serializeTallyConnection(updatedConnection),
      bridgeToken,
    });
  } catch (error) {
    console.error("Error in POST /api/tally/connections/[id]/pair:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
