import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  MAPPING_TYPES,
  serializeTallyMapping,
  toNullableText,
  toRequiredText,
  type TallyMappingRow,
  type TallyMappingType,
} from "@/lib/tally/masters";

function parseMappingType(value: unknown): TallyMappingType | null {
  if (typeof value !== "string") return null;
  return MAPPING_TYPES.includes(value as TallyMappingType) ? (value as TallyMappingType) : null;
}

async function requireConnection(ownerUserId: string, connectionId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("tally_connections")
    .select("id, owner_user_id")
    .eq("id", connectionId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

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
    const connection = await requireConnection(user.id, id);
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_mapping_settings")
      .select("*")
      .eq("connection_id", id)
      .eq("owner_user_id", user.id)
      .order("updated_at", { ascending: false });

    if (error) {
      throw error;
    }

    return jsonWithCors(request, {
      mappings: ((data ?? []) as unknown as TallyMappingRow[]).map(serializeTallyMapping),
    });
  } catch (error) {
    console.error("Error in GET /api/tally/connections/[id]/mappings:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const connection = await requireConnection(user.id, id);
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const mappingType = parseMappingType(body.mappingType);
    const sourceKey = toRequiredText(body.sourceKey).slice(0, 240);
    const sourceLabel = toRequiredText(body.sourceLabel || body.sourceKey).slice(0, 500);
    const targetMasterType = toRequiredText(body.targetMasterType).slice(0, 80);
    const targetMasterKey = toRequiredText(body.targetMasterKey).slice(0, 500);
    const targetMasterName = toRequiredText(body.targetMasterName).slice(0, 500);

    if (!mappingType || !sourceKey || !sourceLabel || !targetMasterType || !targetMasterKey || !targetMasterName) {
      return jsonWithCors(request, { error: "Mapping type, source, and target master are required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_mapping_settings")
      .upsert(
        {
          connection_id: id,
          owner_user_id: user.id,
          mapping_type: mappingType,
          source_key: sourceKey,
          source_label: sourceLabel,
          target_master_type: targetMasterType,
          target_master_key: targetMasterKey,
          target_master_name: targetMasterName,
          status: body.status === "inactive" ? "inactive" : "active",
          notes: toNullableText(body.notes, 1000),
        },
        {
          onConflict: "connection_id,mapping_type,source_key",
        }
      )
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    await supabase.from("tally_connection_events").insert({
      connection_id: id,
      owner_user_id: user.id,
      event_type: "mapping_saved",
      message: "Tally mapping saved.",
      payload: {
        mappingType,
        sourceKey,
        targetMasterType,
        targetMasterName,
      },
    });

    return jsonWithCors(request, {
      mapping: serializeTallyMapping(data as unknown as TallyMappingRow),
    });
  } catch (error) {
    console.error("Error in POST /api/tally/connections/[id]/mappings:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
