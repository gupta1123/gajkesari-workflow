import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { serializeAccount } from "@/lib/bank-statements";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const query = url.searchParams.get("query")?.trim();
    const supabase = createSupabaseAdminClient();
    let requestBuilder = supabase
      .from("bank_accounts")
      .select("*")
      .eq("owner_user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(50);

    if (query) {
      requestBuilder = requestBuilder.or(
        `bank_name.ilike.%${query}%,account_holder_name.ilike.%${query}%,account_number_masked.ilike.%${query}%`
      );
    }

    const { data, error } = await requestBuilder;
    if (error) throw error;

    return jsonWithCors(request, {
      accounts: (data ?? []).map(serializeAccount),
    });
  } catch (error) {
    console.error("Error in GET /api/bank-statements/accounts:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
