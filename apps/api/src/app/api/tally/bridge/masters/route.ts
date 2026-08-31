import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import {
  hashSecret,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";
import {
  MASTER_TYPES,
  normalizeMasterInput,
  toNullableText,
  type TallyMasterInput,
  type TallyMasterType,
} from "@/lib/tally/masters";

const MASTER_INPUT_KEYS: Record<string, TallyMasterType> = {
  ledgers: "ledger",
  groups: "group",
  stockItems: "stock_item",
  units: "unit",
  voucherTypes: "voucher_type",
  gstLedgers: "gst_ledger",
  taxLedgers: "tax_ledger",
};

const MASTER_UPSERT_BATCH_SIZE = 500;
const MASTER_UPSERT_CONCURRENCY = 4;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "Master sync failed.");
  }
  return String(error || "Master sync failed.");
}

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
  let syncFailureContext: {
    supabase: ReturnType<typeof createSupabaseAdminClient>;
    syncRunId: string;
  } | null = null;
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

    const mastersPayload = body.masters && typeof body.masters === "object" ? body.masters : {};
    const now = new Date().toISOString();
    const companyName = toNullableText(body.companyName, 240) ?? "Unknown company";
    const companyProfile = body.companyProfile && typeof body.companyProfile === "object"
      ? body.companyProfile as Record<string, unknown>
      : {};
    const companyGstin = toNullableText(companyProfile.gstin, 32);
    const companyStateCode = toNullableText(companyProfile.stateCode, 8);
    const rows: Array<Record<string, unknown>> = [];
    const totals: Record<string, number> = {};
    const syncedTypes = new Set<TallyMasterType>();

    for (const [payloadKey, masterType] of Object.entries(MASTER_INPUT_KEYS)) {
      const items = asMasterInputs((mastersPayload as Record<string, unknown>)[payloadKey]);
      totals[masterType] = items.length;
      if (Array.isArray((mastersPayload as Record<string, unknown>)[payloadKey])) {
        syncedTypes.add(masterType);
      }

      for (const item of items) {
        const normalized = normalizeMasterInput(masterType, item);
        if (!normalized) continue;

        rows.push({
          ...normalized,
          connection_id: connection.id,
          owner_user_id: connection.owner_user_id,
          company_name: companyName,
          is_active: true,
          last_synced_at: now,
        });
      }
    }

    const { data: dataset, error: datasetError } = await supabase.from("tally_company_datasets")
      .select("id").eq("owner_user_id", connection.owner_user_id)
      .eq("installation_id", connection.installation_ref).eq("company_name", companyName).single();
    if (datasetError) throw datasetError;
    const syncRunBase = {
      company_dataset_id: dataset.id,
      connection_id: connection.id,
      owner_user_id: connection.owner_user_id,
      status: "failed",
      company_name: companyName,
      bridge_version: toNullableText(body.bridgeVersion, 80),
      totals,
      error: "Master sync did not complete.",
      completed_at: now,
    };

    let syncRunInsert = await supabase
      .from("tally_master_sync_runs")
      .insert({
        ...syncRunBase,
        company_gstin: companyGstin,
        company_state_code: companyStateCode,
      })
      .select("id")
      .single();

    // Older bank-only installations may not yet have the optional company
    // profile columns. Keep ledger synchronization available while the small
    // compatibility migration is applied separately.
    if (
      syncRunInsert.error?.code === "PGRST204" &&
      /company_(?:gstin|state_code)/i.test(syncRunInsert.error.message)
    ) {
      syncRunInsert = await supabase
        .from("tally_master_sync_runs")
        .insert(syncRunBase)
        .select("id")
        .single();
    }

    const { data: syncRun, error: runError } = syncRunInsert;

    if (runError) {
      throw runError;
    }

    const syncRunId = (syncRun as { id: string }).id;
    syncFailureContext = { supabase, syncRunId };

    // This sync can explicitly read a company that is not currently open in
    // Tally. Do not overwrite the heartbeat's active-company value here; doing
    // so would make the UI believe a different company is live.
    // Master exports are not active-company observations. Only the readiness
    // probe may advance last_tested_at.

    const rowsWithRun = rows.map((row) => ({
      ...row,
      company_dataset_id: dataset.id,
      sync_run_id: syncRunId,
    }));

    const reportedMasterCount = Object.values(totals).reduce((sum, total) => sum + total, 0);
    if (reportedMasterCount > 0 && rowsWithRun.length === 0) {
      throw new Error(
        "Tally reported masters, but none contained a recognizable name. Update the connector and retry."
      );
    }

    if (rowsWithRun.length > 0) {
      const batches = Array.from(
        { length: Math.ceil(rowsWithRun.length / MASTER_UPSERT_BATCH_SIZE) },
        (_, batchIndex) => rowsWithRun.slice(
          batchIndex * MASTER_UPSERT_BATCH_SIZE,
          (batchIndex + 1) * MASTER_UPSERT_BATCH_SIZE
        )
      );

      // Large Tally companies can contain thousands of ledgers. Sequential
      // PostgREST upserts cross Heroku's request deadline, so keep a small,
      // bounded number in flight without overwhelming Supabase.
      for (let start = 0; start < batches.length; start += MASTER_UPSERT_CONCURRENCY) {
        const window = batches.slice(start, start + MASTER_UPSERT_CONCURRENCY);
        const results = await Promise.all(window.map((batch) =>
          supabase
            .from("tally_masters")
            .upsert(batch, {
              onConflict: "company_dataset_id,master_type,master_key",
            })
        ));
        const failedIndex = results.findIndex((result) => result.error);
        if (failedIndex >= 0) {
          const batchNumber = start + failedIndex + 1;
          throw new Error(
            `Could not save Tally masters batch ${batchNumber}: ${errorMessage(results[failedIndex].error)}`
          );
        }
      }
    }

    // Only retire the prior snapshot after the new rows have been written.
    // This prevents a failed upsert from leaving the company with no active
    // masters, and sync_run_id keeps the just-upserted rows active.
    // A workstation can hold several companies. Refresh only this company's
    // snapshot; switching Tally must not invalidate another company's masters.

    if (syncedTypes.size > 0) {
      const { error: priorSnapshotDeactivateError } = await supabase
        .from("tally_masters")
        .update({ is_active: false, last_synced_at: now })
        .eq("company_dataset_id", dataset.id)
        .in("master_type", Array.from(syncedTypes))
        .or(`sync_run_id.is.null,sync_run_id.neq.${syncRunId}`)
        .eq("is_active", true);
      if (priorSnapshotDeactivateError) throw priorSnapshotDeactivateError;
    }

    const { error: completionError } = await supabase
      .from("tally_master_sync_runs")
      .update({
        status: "completed",
        totals,
        error: null,
        completed_at: now,
      })
      .eq("id", syncRunId)
      .eq("connection_id", connection.id);
    if (completionError) throw completionError;
    syncFailureContext = null;

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
      masters: [],
      supportedTypes: MASTER_TYPES,
    });
  } catch (error) {
    if (syncFailureContext) {
      await syncFailureContext.supabase
        .from("tally_master_sync_runs")
        .update({
          status: "failed",
          error: errorMessage(error).slice(0, 1000),
          completed_at: new Date().toISOString(),
        })
        .eq("id", syncFailureContext.syncRunId);
    }
    console.error("Error in POST /api/tally/bridge/masters:", error);
    return jsonWithCors(request, {
      error: `Master sync failed: ${errorMessage(error).slice(0, 500)}`,
    }, { status: 500 });
  }
}

