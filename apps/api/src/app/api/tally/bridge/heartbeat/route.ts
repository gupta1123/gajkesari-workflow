import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { updateLocalTallyHeartbeat } from "@/lib/local/tally-store";
import {
  hashSecret,
  connectorSupportsReliableActiveCompany,
  isReliableInstallationId,
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
  type TallyConnectionStatus,
} from "@/lib/tally/connections";

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

function toCompanies(value: unknown, activeCompanyName: string | null) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const companies: Array<{
    companyName: string;
    guid: string | null;
    financialYear: string | null;
    financialYearStart: string | null;
    booksFrom: string | null;
    currentPeriod: string | null;
    isActive: boolean;
  }> = [];

  for (const item of value) {
    let name: unknown = item;
    let row: Record<string, unknown> = {};
    if (item && typeof item === "object") {
      row = item as Record<string, unknown>;
      name = row.companyName ?? row.name;
    }
    const text = toNullableText(name);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push({
      companyName: text,
      guid: toNullableText(row.guid),
      financialYear: toNullableText(row.financialYear),
      financialYearStart: toNullableText(row.financialYearStart),
      booksFrom: toNullableText(row.booksFrom),
      currentPeriod: toNullableText(row.currentPeriod),
      isActive:
        key === activeCompanyName?.trim().toLowerCase() ||
        (row.isActive === true && Boolean(activeCompanyName)),
    });
  }

  if (activeCompanyName && !seen.has(activeCompanyName.toLowerCase())) {
    companies.unshift({
      companyName: activeCompanyName,
      guid: null,
      financialYear: null,
      financialYearStart: null,
      booksFrom: null,
      currentPeriod: null,
      isActive: true,
    });
  }

  return companies;
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

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request) {
  try {
    const token = getBridgeToken(request);
    const body = await request.json().catch(() => ({}));
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
    const bridgeVersion = toNullableText(body.bridgeVersion);
    const bridgeMachineId = toNullableText(body.bridgeMachineId);
    const bridgeMachineName = toNullableText(body.bridgeMachineName);

    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    if (
      !connectorSupportsReliableActiveCompany(bridgeVersion) ||
      !isReliableInstallationId(bridgeMachineId)
    ) {
      return jsonWithCors(
        request,
        {
          error:
            "Connector update required. Install and reconnect using the latest Gajkesari Tally Connector.",
        },
        { status: 426 }
      );
    }

    const tallyReachable = toBoolean(body.tallyReachable);
    const reportedCompanyLoaded = toBoolean(body.companyLoaded);
    const companyName = toNullableText(body.companyName);
    const companyLoaded = tallyReachable && reportedCompanyLoaded && Boolean(companyName);
    const companies = toCompanies(body.companies, companyLoaded ? companyName : null);
    const errorMessage =
      toNullableText(body.error) ??
      (tallyReachable && reportedCompanyLoaded && !companyName
        ? "Tally responded but did not identify the active company."
        : null);
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
        bridgeVersion,
        bridgeMachineId: bridgeMachineId!,
        bridgeMachineName,
        tallyReachable,
        companyLoaded,
        companyName: companyLoaded ? companyName : null,
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
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const connection = data as unknown as TallyConnectionRow | null;

    if (connection?.revoked_at) {
      return jsonWithCors(
        request,
        { error: "This connector session has been revoked. Reconnect this computer." },
        { status: 409 }
      );
    }

    if (!connection?.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    if (
      !connection.installation_id ||
      connection.installation_id !== bridgeMachineId
    ) {
      await supabase.from("tally_connection_events").insert({
        connection_id: connection.id,
        owner_user_id: connection.owner_user_id,
        event_type: "heartbeat_rejected",
        message: "Heartbeat rejected because it came from a different connector installation.",
        payload: {
          pairedMachineId: connection.installation_id,
          reportedMachineId: bridgeMachineId,
          reportedBridgeVersion: bridgeVersion,
        },
      });
      return jsonWithCors(
        request,
        {
          error:
            "This connection belongs to a different connector installation. Reconnect this machine.",
        },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const resolvedCompanyName = companyLoaded ? companyName : null;

    const { data: updatedData, error: updateError } = await supabase
      .from("tally_connections")
      .update({
        status,
        tally_url: toNullableText(body.tallyUrl) ?? connection.tally_url,
        bridge_version: bridgeVersion,
        bridge_machine_name: bridgeMachineName ?? connection.bridge_machine_name,
        last_heartbeat_at: now,
        last_tested_at: now,
        last_tally_reachable: tallyReachable,
        last_company_loaded: companyLoaded,
        last_company_name: resolvedCompanyName,
        last_error: errorMessage,
      })
      .eq("id", connection.id)
      .eq("installation_id", bridgeMachineId)
      .is("revoked_at", null)
      .select(TALLY_CONNECTION_SELECT)
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
        bridgeVersion,
        bridgeMachineId,
        bridgeMachineName,
        companies,
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

