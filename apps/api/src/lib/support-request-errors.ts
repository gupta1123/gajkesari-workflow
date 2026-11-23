import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashSecret } from "@/lib/tally/connections";
import { followupsEnabledFor } from "@/lib/followups/access";

export async function recordSupportRequestError(
  bindingToken: string,
  pathname: string,
  method: string,
  status: number,
  message: string,
  requestId: string | null,
) {
  const db = createSupabaseAdminClient();
  const hash = hashSecret(bindingToken);
  const binding = await db
    .from("tally_browser_bindings")
    .select("owner_user_id,installation_id")
    .eq("credential_hash", hash)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!binding.data) return;
  const { owner_user_id, installation_id } = binding.data;
  const connection = await db
    .from("tally_connections")
    .select("id")
    .eq("owner_user_id", owner_user_id)
    .eq("installation_ref", installation_id)
    .eq("control_token_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();
  if (!connection.data) return;
  const reason =
    pathname.startsWith("/api/collections/follow-ups/") &&
    status === 404 &&
    message === "Not found." &&
    !followupsEnabledFor(owner_user_id)
      ? "Payment follow-ups disabled for this account"
      : status === 404
        ? "Resource or route unavailable"
        : status === 401
          ? "Authentication required"
          : status === 403
            ? "Permission denied"
            : status === 409
              ? "Request conflicts with current state"
              : status >= 500
                ? "Server error"
                : "Request rejected";
  const result = await db
    .from("tally_connection_events")
    .insert({
      owner_user_id,
      connection_id: connection.data.id,
      event_type: "support_request_error",
      payload: {
        route: pathname,
        method,
        status,
        reason,
        requestId:
          requestId && /^[a-f0-9-]{16,64}$/i.test(requestId) ? requestId : null,
      },
    });
  if (result.error) throw result.error;
}
