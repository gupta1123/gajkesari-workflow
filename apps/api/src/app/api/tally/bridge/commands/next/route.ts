import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { claimNextLocalTallyCommand } from "@/lib/local/tally-store";
import { hashSecret, type TallyConnectionRow } from "@/lib/tally/connections";
import {
  serializeTallyBridgeCommand,
  type TallyBridgeCommandRow,
} from "@/lib/tally/commands";

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

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const bridgeVersion = url.searchParams.get("bridgeVersion") ?? null;
    const token = getBridgeToken(request);

    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    if (isLocalDbMode()) {
      const result = await claimNextLocalTallyCommand({
        connectionId,
        token,
        bridgeVersion,
      });

      if (result.unauthorized) {
        return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
      }

      return jsonWithCors(request, {
        command: result.command ? serializeTallyBridgeCommand(result.command) : null,
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(`${CONNECTION_SELECT}, bridge_token_hash`)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) throw error;

    const connection = data as unknown as (TallyConnectionRow & { bridge_token_hash: string | null }) | null;
    if (!connection?.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    const now = new Date().toISOString();
    const staleClaimedBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { error: exhaustedClaimError } = await supabase
      .from("tally_bridge_commands")
      .update({
        status: "failed",
        completed_at: now,
        error: "Bridge claimed this command but did not report a result before the retry limit.",
      })
      .eq("connection_id", connection.id)
      .eq("status", "claimed")
      .lt("claimed_at", staleClaimedBefore)
      .gte("attempts", 3);

    if (exhaustedClaimError) throw exhaustedClaimError;

    const { error: staleClaimError } = await supabase
      .from("tally_bridge_commands")
      .update({
        status: "queued",
        claimed_at: null,
        error: "Requeued after the bridge claimed this command but did not report a result.",
      })
      .eq("connection_id", connection.id)
      .eq("status", "claimed")
      .lt("claimed_at", staleClaimedBefore)
      .lt("attempts", 3);

    if (staleClaimError) throw staleClaimError;

    const { data: commandData, error: commandError } = await supabase
      .from("tally_bridge_commands")
      .select("*")
      .eq("connection_id", connection.id)
      .eq("status", "queued")
      .lte("available_at", now)
      .lt("attempts", 3)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (commandError) throw commandError;
    if (!commandData) {
      return jsonWithCors(request, { command: null });
    }

    const command = commandData as unknown as TallyBridgeCommandRow;
    const { data: claimedData, error: claimError } = await supabase
      .from("tally_bridge_commands")
      .update({
        status: "claimed",
        claimed_at: now,
        attempts: command.attempts + 1,
        bridge_version: bridgeVersion,
      })
      .eq("id", command.id)
      .eq("status", "queued")
      .select("*")
      .maybeSingle();

    if (claimError) throw claimError;
    if (!claimedData) {
      return jsonWithCors(request, { command: null });
    }

    return jsonWithCors(request, {
      command: serializeTallyBridgeCommand(claimedData as unknown as TallyBridgeCommandRow),
    });
  } catch (error) {
    console.error("Error in GET /api/tally/bridge/commands/next:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
