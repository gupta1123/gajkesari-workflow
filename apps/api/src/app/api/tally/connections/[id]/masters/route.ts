import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { classifyPartyLedgerFromGroups } from "@/lib/bank-statement-ledger-safety";
import {
  MASTER_TYPES,
  serializeTallyMaster,
  type TallyMasterRow,
  type TallyMasterType,
} from "@/lib/tally/masters";

function parseMasterType(value: string | null): TallyMasterType | null {
  if (!value) return null;
  return MASTER_TYPES.includes(value as TallyMasterType) ? (value as TallyMasterType) : null;
}

const MASTER_LIST_SELECT = [
  "id",
  "connection_id",
  "company_name",
  "master_type",
  "master_key",
  "tally_guid",
  "tally_name",
  "parent_name",
  "gstin",
  "hsn_code",
  "unit_name",
  "tax_rate",
  "is_active",
  "last_synced_at",
].join(", ");

const MASTER_METADATA_SELECT = `${MASTER_LIST_SELECT}, raw_payload`;

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const url = new URL(request.url);
    const type = parseMasterType(url.searchParams.get("type"));
    const query = url.searchParams.get("q")?.trim() ?? "";
    const limit = Math.min(Number(url.searchParams.get("limit") || 100), 5000);
    const fetchAll = url.searchParams.get("all") === "true";
    const includeRawMetadata = url.searchParams.get("includeRawMetadata") === "true";

    const supabase = createSupabaseAdminClient();
    const { data: connection, error: connectionError } = await supabase
      .from("tally_connections")
      .select("id, owner_user_id, last_company_name")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (connectionError) {
      throw connectionError;
    }

    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }

    const buildMasterQuery = () => {
      let builder = supabase
        .from("tally_masters")
        .select(includeRawMetadata ? MASTER_METADATA_SELECT : MASTER_LIST_SELECT)
        .eq("connection_id", id)
        .eq("owner_user_id", user.id)
        .eq("company_name", connection.last_company_name ?? "Unknown company")
        .eq("is_active", true)
        .order("master_type", { ascending: true })
        .order("tally_name", { ascending: true });
      if (type) builder = builder.eq("master_type", type);
      if (query) builder = builder.ilike("tally_name", `%${query}%`);
      return builder;
    };

    const masters: TallyMasterRow[] = [];
    if (fetchAll) {
      const pageSize = 1000;
      for (let from = 0; from < 20000; from += pageSize) {
        const { data, error } = await buildMasterQuery().range(from, from + pageSize - 1);
        if (error) throw error;
        const page = (data ?? []) as unknown as TallyMasterRow[];
        masters.push(...page);
        if (page.length < pageSize) break;
        if (from + pageSize >= 20000) {
          throw new Error("Tally master list exceeds the supported 20,000-master safety limit.");
        }
      }
    } else {
      const { data, error } = await buildMasterQuery().limit(limit);
      if (error) throw error;
      masters.push(...((data ?? []) as unknown as TallyMasterRow[]));
    }

    const { data: runData, error: runError } = await supabase
      .from("tally_master_sync_runs")
      .select("id, status, company_name, totals, error, completed_at")
      .eq("connection_id", id)
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runError) {
      throw runError;
    }

    const groupRows: TallyMasterRow[] = [];
    if (type === "ledger") {
      const pageSize = 1000;
      for (let from = 0; from < 20000; from += pageSize) {
        const { data, error } = await supabase
          .from("tally_masters")
          .select(MASTER_LIST_SELECT)
          .eq("connection_id", id)
          .eq("owner_user_id", user.id)
          .eq("company_name", connection.last_company_name ?? "Unknown company")
          .eq("master_type", "group")
          .eq("is_active", true)
          .order("tally_name", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const page = (data ?? []) as unknown as TallyMasterRow[];
        groupRows.push(...page);
        if (page.length < pageSize) break;
        if (from + pageSize >= 20000) {
          throw new Error("Tally group list exceeds the supported 20,000-master safety limit.");
        }
      }
    }

    const groupIdentities = groupRows.map((group) => ({
      name: group.tally_name,
      parent: group.parent_name,
    }));

    return jsonWithCors(request, {
      masters: masters.map((master) => {
        const serialized = serializeTallyMaster(master);
        if (master.master_type !== "ledger" || groupIdentities.length === 0) return serialized;
        return {
          ...serialized,
          ledgerType: classifyPartyLedgerFromGroups(
            { name: master.tally_name, parent: master.parent_name },
            groupIdentities
          ),
        };
      }),
      masterCount: masters.length,
      latestSync: runData ?? null,
    });
  } catch (error) {
    console.error("Error in GET /api/tally/connections/[id]/masters:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
