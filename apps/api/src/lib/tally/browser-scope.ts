import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashSecret } from "@/lib/tally/connections";

export type TallyTarget = {
  installationId: string;
  companyDatasetId: string;
  connectionId: string;
  sessionGeneration: number;
};

export function browserBindingToken(request: Request) {
  return request.headers.get("x-tally-browser-binding")?.trim() || "";
}

const datasetReads = new WeakMap<Request, Map<string, Promise<string[]>>>();
async function workerTarget(request: Request, ownerUserId: string): Promise<TallyTarget | null> {
  const jobId = request.headers.get("x-tally-queue-job-id");
  if (!jobId || !process.env.WORKER_SECRET || request.headers.get("x-worker-secret") !== process.env.WORKER_SECRET) return null;
  const { data, error } = await createSupabaseAdminClient().from("bank_statement_tally_queue_jobs")
    .select("request_payload").eq("id", jobId).eq("owner_user_id", ownerUserId).single();
  if (error) throw error;
  return data.request_payload?.target || null;
}
export function browserDatasetIds(request: Request, ownerUserId: string): Promise<string[]> {
  let users = datasetReads.get(request);
  if (!users) { users = new Map(); datasetReads.set(request, users); }
  const existing = users.get(ownerUserId);
  if (existing) return existing;
  const read = (async () => {
    const target = await workerTarget(request, ownerUserId);
    if (target) return [target.companyDatasetId];
    const token = browserBindingToken(request);
    if (!token) return [];
    const db = createSupabaseAdminClient();
    const { data: binding, error } = await db.from("tally_browser_bindings")
      .select("installation_id").eq("owner_user_id", ownerUserId).eq("credential_hash", hashSecret(token))
      .is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (error) throw error;
    if (!binding) return [];
    let datasets = db.from("tally_company_datasets")
      .select("id").eq("owner_user_id", ownerUserId).eq("installation_id", binding.installation_id);
    const selected = request.headers.get("x-tally-dataset-id");
    if (selected) datasets = datasets.eq("id", selected);
    const { data, error: datasetError } = await datasets;
    if (datasetError) throw datasetError;
    return (data || []).map((row) => String(row.id));
  })();
  users.set(ownerUserId, read);
  return read;
}

export async function browserOwnsConnection(request: Request, ownerUserId: string, connectionId: string) {
  const token = browserBindingToken(request);
  if (!token) return false;
  const db = createSupabaseAdminClient();
  const { data: connection, error } = await db.from("tally_connections")
    .select("id, installation_ref, control_token_hash, paired_at, pairing_code_expires_at")
    .eq("id", connectionId).eq("owner_user_id", ownerUserId)
    .eq("control_token_hash", hashSecret(token)).is("revoked_at", null).maybeSingle();
  if (error) throw error;
  if (!connection) return false;
  // Allow status polling of this browser's own not-yet-paired challenge.
  if (!connection.paired_at && Date.parse(connection.pairing_code_expires_at || "") > Date.now()) return true;
  const { data: binding, error: bindingError } = await db.from("tally_browser_bindings")
    .select("id").eq("owner_user_id", ownerUserId).eq("installation_id", connection.installation_ref)
    .eq("credential_hash", hashSecret(token)).is("revoked_at", null)
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (bindingError) throw bindingError;
  return Boolean(binding);
}

export async function resolveTallyTarget(request: Request, ownerUserId: string, connectionId: string, companyName: string) {
  const pinned = await workerTarget(request, ownerUserId);
  if (!pinned && !await browserOwnsConnection(request, ownerUserId, connectionId)) throw new Error("Pair this browser with its local connector first.");
  const db = createSupabaseAdminClient();
  const { data: c, error } = await db.from("tally_connections")
    .select("id, installation_ref, session_generation, last_companies_snapshot, last_heartbeat_at")
    .eq("id", connectionId).eq("owner_user_id", ownerUserId).is("revoked_at", null).single();
  if (error) throw error;
  if (!c.last_heartbeat_at || Date.now() - Date.parse(c.last_heartbeat_at) > 45_000) throw new Error("The paired connector is offline.");
  const matching = (Array.isArray(c.last_companies_snapshot) ? c.last_companies_snapshot : [])
    .filter((company: { companyName?: string; guid?: string }) => company.companyName === companyName && company.guid);
  if (matching.length !== 1) throw new Error("The company GUID is missing or ambiguous. Refresh Tally companies.");
  const companyGuid = String(matching[0].guid).trim().toLowerCase();
  const { data: dataset, error: datasetError } = await db.from("tally_company_datasets")
    .select("id").eq("owner_user_id", ownerUserId).eq("installation_id", c.installation_ref)
    .eq("company_guid", companyGuid).single();
  if (datasetError) throw datasetError;
  const selectedDatasetId = request.headers.get("x-tally-dataset-id");
  if (selectedDatasetId && selectedDatasetId !== dataset.id) throw new Error("The selected company identity changed. Refresh and select the company again.");
  if (pinned && (pinned.connectionId !== connectionId || pinned.sessionGeneration !== c.session_generation ||
      pinned.installationId !== c.installation_ref || pinned.companyDatasetId !== dataset.id)) {
    throw new Error("The queued target changed. Review the statement and submit it again.");
  }
  return { installationId: c.installation_ref as string, companyDatasetId: dataset.id as string,
    connectionId, sessionGeneration: c.session_generation as number, companyGuid, companyName };
}

// Reconnection changes a session, never the installation/company owning a row.
export async function targetForDataset(request: Request, ownerUserId: string, datasetId: string) {
  if (!(await browserDatasetIds(request, ownerUserId)).includes(datasetId)) {
    throw new Error("This company belongs to a different connector installation.");
  }
  const db = createSupabaseAdminClient();
  const { data: dataset, error } = await db.from("tally_company_datasets")
    .select("installation_id, company_name").eq("id", datasetId).eq("owner_user_id", ownerUserId).single();
  if (error) throw error;
  const { data: connection, error: connectionError } = await db.from("tally_connections")
    .select("id").eq("owner_user_id", ownerUserId).eq("installation_ref", dataset.installation_id)
    .eq("control_token_hash", hashSecret(browserBindingToken(request))).is("revoked_at", null).single();
  if (connectionError) throw connectionError;
  const target = await resolveTallyTarget(request, ownerUserId, connection.id, dataset.company_name);
  if (target.companyDatasetId !== datasetId) throw new Error("The company identity changed. Select the original company.");
  return target;
}
