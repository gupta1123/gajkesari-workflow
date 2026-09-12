import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { getLocalConnectionForBridge } from "@/lib/local/tally-store";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashSecret, TALLY_CONNECTION_SELECT, type TallyConnectionRow } from "@/lib/tally/connections";

const MODEL = "openai/text-embedding-3-small";
const DIMENSIONS = 512;

function bridgeToken(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? request.headers.get("x-bridge-token") ?? "";
}

async function isAuthorized(connectionId: string, token: string) {
  if (isLocalDbMode()) return Boolean(await getLocalConnectionForBridge(connectionId, token));
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("tally_connections").select(TALLY_CONNECTION_SELECT).eq("id", connectionId).maybeSingle();
  if (error) throw error;
  const connection = data as unknown as TallyConnectionRow | null;
  return Boolean(connection && !connection.revoked_at && connection.bridge_token_hash && hashSecret(token) === connection.bridge_token_hash);
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const connectionId = new URL(request.url).searchParams.get("connectionId")?.trim() ?? "";
    const token = bridgeToken(request);
    if (!connectionId || !token) return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    if (!(await isAuthorized(connectionId, token))) return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return jsonWithCors(request, { error: "Direct semantic search is not configured." }, { status: 503 });
    return jsonWithCors(request, {
      endpoint: "https://openrouter.ai/api/v1/embeddings",
      apiKey,
      model: MODEL,
      dimensions: DIMENSIONS,
      maxInputs: 256,
    }, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    console.error("Error in GET /api/tally/bridge/direct-embedding-config:", error);
    return jsonWithCors(request, { error: "Could not configure direct semantic search." }, { status: 500 });
  }
}
