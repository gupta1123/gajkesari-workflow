import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { hashSecret, type TallyConnectionRow } from "@/lib/tally/connections";
import {
  MASTER_TYPES,
  normalizeMasterInput,
  serializeTallyMaster,
  toNullableText,
  type TallyMasterInput,
  type TallyMasterRow,
  type TallyMasterType,
} from "@/lib/tally/masters";

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

const MASTER_INPUT_KEYS: Record<string, TallyMasterType> = {
  ledgers: "ledger",
  groups: "group",
  stockItems: "stock_item",
  units: "unit",
  voucherTypes: "voucher_type",
  gstLedgers: "gst_ledger",
  taxLedgers: "tax_ledger",
};

function getBridgeToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] ?? request.headers.get("x-bridge-token") ?? "";
}

function asMasterInputs(value: unknown): TallyMasterInput[] {
  return Array.isArray(value) ? (value as TallyMasterInput[]) : [];
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

    if (error) {
      throw error;
    }

    const connection = data as unknown as (TallyConnectionRow & { bridge_token_hash: string | null }) | null;

    if (!connection?.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    const mastersPayload = body.masters && typeof body.masters === "object" ? body.masters : {};
    const now = new Date().toISOString();
    const companyName = toNullableText(body.companyName, 240);
    const rows: Array<Record<string, unknown>> = [];
    const totals: Record<string, number> = {};
    const syncedTypes = new Set<TallyMasterType>();

    for (const [payloadKey, masterType] of Object.entries(MASTER_INPUT_KEYS)) {
      const items = asMasterInputs((mastersPayload as Record<string, unknown>)[payloadKey]);
      totals[masterType] = items.length;
      if (items.length > 0) {
        syncedTypes.add(masterType);
      }

      for (const item of items) {
        const normalized = normalizeMasterInput(masterType, item);
        if (!normalized) continue;

        rows.push({
          ...normalized,
          connection_id: connection.id,
          owner_user_id: connection.owner_user_id,
          is_active: true,
          last_synced_at: now,
        });
      }
    }

    const { data: syncRun, error: runError } = await supabase
      .from("tally_master_sync_runs")
      .insert({
        connection_id: connection.id,
        owner_user_id: connection.owner_user_id,
        status: "completed",
        company_name: companyName,
        bridge_version: toNullableText(body.bridgeVersion, 80),
        totals,
        completed_at: now,
      })
      .select("id")
      .single();

    if (runError) {
      throw runError;
    }

    const syncRunId = (syncRun as { id: string }).id;

    // This sync can explicitly read a company that is not currently open in
    // Tally. Do not overwrite the heartbeat's active-company value here; doing
    // so would make the UI believe a different company is live.
    await supabase
      .from("tally_connections")
      .update({ last_tested_at: now })
      .eq("id", connection.id);

    if (syncedTypes.size > 0) {
      await supabase
        .from("tally_masters")
        .update({
          is_active: false,
          last_synced_at: now,
          sync_run_id: syncRunId,
        })
        .eq("connection_id", connection.id)
        .in("master_type", Array.from(syncedTypes));
    }

    const rowsWithRun = rows.map((row) => ({
      ...row,
      sync_run_id: syncRunId,
    }));

    let upserted: TallyMasterRow[] = [];
    if (rowsWithRun.length > 0) {
      const { data: masterData, error: upsertError } = await supabase
        .from("tally_masters")
        .upsert(rowsWithRun, {
          onConflict: "connection_id,master_type,master_key",
        })
        .select("*");

      if (upsertError) {
        throw upsertError;
      }

      upserted = (masterData ?? []) as unknown as TallyMasterRow[];
    }

    await supabase.from("tally_connection_events").insert({
      connection_id: connection.id,
      owner_user_id: connection.owner_user_id,
      event_type: "masters_synced",
      message: "Tally masters synced from bridge.",
      payload: {
        totals,
        syncRunId,
        companyName,
      },
    });

    return jsonWithCors(request, {
      syncRunId,
      totals,
      accepted: rowsWithRun.length,
      masters: upserted.slice(0, 50).map(serializeTallyMaster),
      supportedTypes: MASTER_TYPES,
    });
  } catch (error) {
    console.error("Error in POST /api/tally/bridge/masters:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
