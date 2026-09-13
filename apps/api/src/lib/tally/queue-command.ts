import type { SupabaseClient } from "@supabase/supabase-js";

import { wakeTallyConnector } from "./command-wake.ts";

type QueueTallyCommandInput = {
  supabase: SupabaseClient;
  connectionId: string;
  ownerUserId: string;
  commandType: string;
  payload: Record<string, unknown>;
  priority?: number;
  companyDatasetId?: string | null;
  select?: string;
};

/**
 * Persist first, then publish a best-effort wake notification. The database is
 * authoritative; if Realtime is unavailable, the connector's recovery poll
 * will still claim the queued command.
 */
export async function queueTallyCommandAndWake<T extends Record<string, unknown> = Record<string, unknown>>(
  input: QueueTallyCommandInput
) {
  const insert = {
    connection_id: input.connectionId,
    owner_user_id: input.ownerUserId,
    command_type: input.commandType,
    status: "queued",
    priority: input.priority ?? 100,
    payload: input.payload,
    ...(input.companyDatasetId ? { company_dataset_id: input.companyDatasetId } : {}),
  };
  const { data, error } = await input.supabase
    .from("tally_bridge_commands")
    .insert(insert)
    .select(input.select ?? "*")
    .single();
  if (error) throw error;

  const wakeDelivered = await wakeTallyConnector(input.connectionId);
  return { command: data as unknown as T, wakeDelivered };
}
