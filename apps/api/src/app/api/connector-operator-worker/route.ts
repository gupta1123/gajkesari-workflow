import { randomUUID } from "node:crypto";
import { db, device, granted, jobContext } from "@/lib/connector-operators";

export async function POST(request: Request) {
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const b = await request.json();
    const c = await device(request, b.connectionId);
    if (!c || c.session_generation !== b.generation)
      return reply({ error: "Invalid connector session." }, 401);
    const client = db(),
      now = new Date().toISOString();
    const scope = () =>
      client
        .from("connector_operator_jobs")
        .select("*")
        .eq("connection_id", c.id)
        .eq("installation_id", c.installation_ref)
        .eq("generation", c.session_generation);
    if (b.action === "poll") {
      const next = await scope()
        .in("status", ["queued", "restart_pending"])
        .gt("expires_at", now)
        .order("created_at")
        .limit(1)
        .maybeSingle();
      if (next.error) throw next.error;
      const j = next.data;
      if (!j || !(await granted(j.operator_id, c.installation_ref)))
        return reply({ job: null });
      if (j.status === "restart_pending") {
        if (
          c.bridge_version === j.parameters.version &&
          Date.parse(c.last_heartbeat_at) > Date.parse(j.updated_at)
        ) {
          const saved = await client
            .from("connector_operator_jobs")
            .update({
              status: "completed",
              updated_at: now,
              progress: "New version confirmed by heartbeat",
              result: {
                version: c.bridge_version,
                heartbeat: c.last_heartbeat_at,
              },
            })
            .eq("id", j.id)
            .eq("status", "restart_pending");
          if (saved.error) throw saved.error;
        }
        return reply({ job: null });
      }
      const claim = randomUUID();
      const { data, error } = await client
        .from("connector_operator_jobs")
        .update({
          claim,
          status: "running",
          updated_at: now,
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          progress: "Preparing request",
        })
        .eq("id", j.id)
        .eq("status", "queued")
        .gt("expires_at", now)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) return reply({ job: null });
      try {
        const ds = await client
          .from("tally_company_datasets")
          .select("id,company_name,company_guid,financial_year")
          .eq("id", j.company_dataset_id)
          .eq("installation_id", c.installation_ref)
          .eq("owner_user_id", c.owner_user_id)
          .eq("company_guid", j.company_guid)
          .eq("financial_year", j.financial_year)
          .single();
        if (ds.error) throw ds.error;
        const context = await jobContext(
          j.operation,
          j.parameters,
          c.owner_user_id,
          c.id,
          ds.data,
        );
        return reply({
          job: {
            id: j.id,
            operation: j.operation,
            parameters: j.parameters,
            claim,
            dataset: ds.data,
            context,
          },
        });
      } catch (e) {
        await client
          .from("connector_operator_jobs")
          .update({
            status: "failed",
            updated_at: now,
            error:
              "Could not load the selected company, statement or analysis settings.",
          })
          .eq("id", j.id)
          .eq("claim", claim);
        throw e;
      }
    }
    const restartAction =
      b.action === "authorize_restart" || b.action === "restart_failed";
    const expectedStatus = restartAction ? "restart_pending" : "running";
    const j = await scope()
      .eq("id", b.id)
      .eq("claim", b.claim)
      .eq("status", expectedStatus)
      .gt("expires_at", now)
      .maybeSingle();
    if (j.error) throw j.error;
    if (!j.data || !(await granted(j.data.operator_id, c.installation_ref)))
      return reply({ error: "Request expired or access removed." }, 409);
    const patch: Record<string, unknown> = { updated_at: now };
    if (restartAction && j.data.operation !== "update")
      return reply({ accepted: false }, 409);
    if (b.action === "authorize_restart") return reply({ accepted: true });
    if (b.action === "restart_failed") {
      patch.status = "failed";
      patch.error =
        "The signed release could not be installed while the connector was idle.";
    } else if (b.action === "progress") {
      patch.progress = String(b.progress || "Working").slice(0, 180);
    } else if (b.action === "finish") {
      if (JSON.stringify(b.result ?? {}).length > 256000)
        return reply({ error: "Result too large." }, 400);
      patch.status = b.error
        ? "failed"
        : j.data.operation === "update"
          ? "restart_pending"
          : "completed";
      patch.progress = null;
      patch.error = b.error ? String(b.error).slice(0, 300) : null;
      patch.result = b.result ?? {};
      if (patch.status === "restart_pending")
        patch.expires_at = new Date(Date.now() + 12 * 60_000).toISOString();
    } else return reply({ error: "Unsupported action." }, 400);
    const saved = await client
      .from("connector_operator_jobs")
      .update(patch)
      .eq("id", b.id)
      .eq("claim", b.claim)
      .eq("status", expectedStatus)
      .gt("expires_at", now)
      .select("id")
      .maybeSingle();
    if (saved.error) throw saved.error;
    return reply({ accepted: Boolean(saved.data) }, saved.data ? 200 : 409);
  } catch {
    return reply({ error: "Support queue unavailable." }, 503);
  }
}
