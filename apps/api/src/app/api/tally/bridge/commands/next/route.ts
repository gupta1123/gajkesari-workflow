import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { claimNextLocalTallyCommand } from "@/lib/local/tally-store";
import {
  hashSecret,
  connectorSupportsReliableActiveCompany,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";
import {
  serializeTallyBridgeCommand,
  type TallyBridgeCommandRow,
} from "@/lib/tally/commands";

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
    const requestedLimit = Number(url.searchParams.get("limit") || 1);
    const limit = Math.max(1, Math.min(50, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 1));
    const token = getBridgeToken(request);

    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    if (isLocalDbMode()) {
      const commands = [];
      for (let index = 0; index < limit; index += 1) {
        const result = await claimNextLocalTallyCommand({
          connectionId,
          token,
          bridgeVersion,
        });

        if (result.unauthorized) {
          return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
        }
        if (!result.command) break;
        commands.push(serializeTallyBridgeCommand(result.command));
      }

      return jsonWithCors(request, {
        command: commands[0] ?? null,
        commands,
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) throw error;

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
    if (!connectorSupportsReliableActiveCompany(bridgeVersion)) {
      return jsonWithCors(request, { error: "Install connector 0.1.58 or later and pair this PC again." }, { status: 426 });
    }

    const { data: claimedRows, error: claimError } = await supabase.rpc("claim_tally_commands", {
      p_connection_id: connection.id,
      p_token_hash: hashSecret(token),
      p_bridge_version: bridgeVersion,
      p_limit: limit,
    });
    if (claimError) throw claimError;
    const commands = ((claimedRows ?? []) as TallyBridgeCommandRow[]).map((row) => serializeTallyBridgeCommand(row, true));
    return jsonWithCors(request, {
      command: commands[0] ?? null,
      commands,
    });
  } catch (error) {
    console.error("Error in GET /api/tally/bridge/commands/next:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
