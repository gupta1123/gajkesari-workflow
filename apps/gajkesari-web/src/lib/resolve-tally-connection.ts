import { apiFetch } from "@/lib/api-client";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";

/**
 * The connector this browser is working with: the one picked on the Tally page
 * or in Bank Statements, otherwise the most recently active paired connector.
 */
export async function resolveTallyConnectionId() {
  const preferred = readPreferredTallyConnectionId();
  if (preferred) return preferred;
  const response = await apiFetch("/api/tally/connections", { cache: "no-store" });
  if (!response.ok) return "";
  const payload = (await response.json()) as { connections?: Array<{ id: string; pairedAt: string | null; lastHeartbeatAt: string | null }> };
  const paired = (payload.connections ?? []).filter((connection) => connection.pairedAt);
  paired.sort((left, right) => String(right.lastHeartbeatAt ?? "").localeCompare(String(left.lastHeartbeatAt ?? "")));
  return paired[0]?.id ?? "";
}
