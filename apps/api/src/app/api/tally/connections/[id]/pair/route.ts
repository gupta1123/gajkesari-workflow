import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { pairLocalTallyConnection } from "@/lib/local/tally-store";
import {
  connectorSupportsReliableActiveCompany,
  createBridgeToken,
  hashSecret,
  isReliableInstallationId,
  serializeTallyConnection,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";

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
    const controlToken = readPairingCode(body.controlToken);
    const bridgeVersion = normalizeMetadata(body.bridgeVersion, "unknown");
    const bridgeMachineId = normalizeMetadata(body.bridgeMachineId, "unknown");
    const bridgeMachineName = normalizeMetadata(body.bridgeMachineName, "This computer");

    if (!pairingCode) {
      return jsonWithCors(request, { error: "Pairing code is required." }, { status: 400 });
    }
    if (!controlToken) {
      return jsonWithCors(request, { error: "Connection control token is required." }, { status: 400 });
    }

    if (
      !connectorSupportsReliableActiveCompany(bridgeVersion) ||
      !isReliableInstallationId(bridgeMachineId)
    ) {
      return jsonWithCors(
        request,
        {
          error:
            "This connector is outdated and cannot be paired safely. Install the latest Gajkesari Tally Connector and try again.",
        },
        { status: 426 }
      );
    }

    if (isLocalDbMode()) {
      const result = await pairLocalTallyConnection({
        connectionId: id,
        pairingCode,
        bridgeName: normalizeMetadata(body.bridgeName, "Tally Bridge"),
        bridgeVersion,
        bridgeMachineId,
        bridgeMachineName,
        controlToken,
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
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", id)
      .is("revoked_at", null)
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
    const reportedCompanyLoaded = toNullableBoolean(body.companyLoaded);
    const companyLoaded =
      tallyReachable === true && reportedCompanyLoaded === true && Boolean(companyName);
    const { data: updatedData, error: updateError } = await supabase.rpc("pair_tally_installation", {
      p_connection_id: connection.id,
      p_pairing_hash: hashSecret(pairingCode),
      p_control_hash: hashSecret(controlToken),
      p_bridge_hash: hashSecret(bridgeToken),
      p_metadata: { installationId: bridgeMachineId, machineName: bridgeMachineName,
        bridgeName: normalizeMetadata(body.bridgeName, "Tally Bridge"), bridgeVersion },
    });
    if (updateError) {
      return jsonWithCors(request, { error: "Pairing expired or belongs to another computer. Start a new connection on this PC." }, { status: 409 });
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
        bridgeMachineName: updatedConnection.bridge_machine_name,
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

