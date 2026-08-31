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
    const key = toNullableText(row.guid) || text.toLowerCase();
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
        text.toLowerCase() === activeCompanyName?.trim().toLowerCase() ||
        (row.isActive === true && Boolean(activeCompanyName)),
    });
  }

  if (activeCompanyName && !companies.some((company) => company.companyName.toLowerCase() === activeCompanyName.toLowerCase())) {
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

function snapshotChanged(
  previous: Array<Record<string, unknown>> | null | undefined,
  next: Array<Record<string, unknown>>
) {
  return JSON.stringify(previous ?? []) !== JSON.stringify(next);
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
        companies,
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
    if (body.livenessOnly === true) {
      // A liveness ping says nothing new about Tally or the active company.
      // Persist presence at most once per 30 seconds, without refreshing probes.
      if (Date.now() - Date.parse(connection.last_heartbeat_at || "") >= 30_000 || !connection.last_heartbeat_at) {
        const { error: presenceError } = await supabase.from("tally_connections")
          .update({ last_heartbeat_at: now })
          .eq("id", connection.id).eq("bridge_token_hash", hashSecret(token))
          .eq("session_generation", connection.session_generation).is("revoked_at", null);
        if (presenceError) throw presenceError;
      }
      return jsonWithCors(request, { connection: serializeTallyConnectionStatus({ ...connection, last_heartbeat_at: now }) });
    }
    const resolvedCompanyName = companyLoaded ? companyName : null;
    if (connection.installation_ref && snapshotChanged(connection.last_companies_snapshot, companies) && companies.some((company) => company.guid)) {
      const { error: datasetError } = await supabase.from("tally_company_datasets").upsert(
        companies.filter((company) => company.guid).map((company) => ({
          owner_user_id: connection.owner_user_id, installation_id: connection.installation_ref,
          company_guid: company.guid!.trim().toLowerCase(), company_name: company.companyName,
          financial_year: company.financialYear,
        })), { onConflict: "installation_id,company_guid" });
      if (datasetError) throw datasetError;
    }
    const heartbeatStateChanged =
      connection.status !== status ||
      connection.last_tally_reachable !== tallyReachable ||
      connection.last_company_loaded !== companyLoaded ||
      (connection.last_company_name ?? null) !== resolvedCompanyName ||
      (connection.last_error ?? null) !== errorMessage ||
      snapshotChanged(connection.last_companies_snapshot, companies);

    if (!heartbeatStateChanged && Date.now() - Date.parse(connection.last_heartbeat_at || "") < 30_000) {
      return jsonWithCors(request, { connection: serializeTallyConnectionStatus({
        ...connection, last_heartbeat_at: now,
        last_tested_at: typeof body.observedAt === "string" ? body.observedAt : now,
      }) });
    }

    const { data: updatedData, error: updateError } = await supabase
      .from("tally_connections")
      .update({
        status,
        tally_url: toNullableText(body.tallyUrl) ?? connection.tally_url,
        bridge_version: bridgeVersion,
        bridge_machine_name: bridgeMachineName ?? connection.bridge_machine_name,
        last_heartbeat_at: now,
        last_tested_at: typeof body.observedAt === "string" && Number.isFinite(Date.parse(body.observedAt))
          ? new Date(Math.min(Date.now(), Date.parse(body.observedAt))).toISOString() : now,
        last_tally_reachable: tallyReachable,
        last_company_loaded: companyLoaded,
        last_company_name: resolvedCompanyName,
        active_company_guid: companies.find((company) => company.isActive)?.guid?.trim().toLowerCase() || null,
        last_error: errorMessage,
        last_companies_snapshot: companies,
      })
      .eq("id", connection.id)
      .eq("installation_id", bridgeMachineId)
      .eq("bridge_token_hash", hashSecret(token))
      .eq("session_generation", connection.session_generation)
      .is("revoked_at", null)
      .select(TALLY_CONNECTION_SELECT)
      .single();

    if (updateError) {
      throw updateError;
    }

    if (heartbeatStateChanged) {
      const { error: eventError } = await supabase.from("tally_connection_events").insert({
        connection_id: connection.id,
        owner_user_id: connection.owner_user_id,
        event_type: "bridge_heartbeat",
        message: errorMessage ?? "Bridge heartbeat state changed.",
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
      if (eventError) throw eventError;
    }

    return jsonWithCors(request, {
      connection: serializeTallyConnectionStatus(updatedData as unknown as TallyConnectionRow),
    });
  } catch (error) {
    console.error("Error in POST /api/tally/bridge/heartbeat:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
