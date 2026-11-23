import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { followupsEnabledFor } from "@/lib/followups/access";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  db,
  granted,
  expire,
  connectionFields,
  fields,
  operations,
  statementTrace,
} from "@/lib/connector-operators";
export const OPTIONS = optionsWithCors;
export const dynamic = "force-dynamic";
async function handle(req: Request) {
  const reply = (body: unknown, status = 200) =>
    jsonWithCors(req, body, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  try {
    const user = await requireRequestUser(req);
    if (!user)
      return reply({ error: "Sign in to use connector support." }, 401);
    const client = db();
    const body = req.method === "POST" ? await req.json() : {};
    const url = new URL(req.url);
    const id = String(
      body.connectionId || url.searchParams.get("connectionId") || "",
    );
    if (!id && req.method === "GET") {
      const grants = await client
        .from("connector_operator_grants")
        .select("installation_id")
        .eq("operator_id", user.id);
      if (grants.error) throw grants.error;
      if (!grants.data.length) return reply({ connections: [] });
      const devices = await client
        .from("tally_connections")
        .select(connectionFields)
        .in(
          "installation_ref",
          grants.data.map((g) => g.installation_id),
        )
        .is("revoked_at", null)
        .order("last_heartbeat_at", { ascending: false });
      if (devices.error) throw devices.error;
      return reply({ connections: devices.data });
    }
    const { data: c, error } = await client
      .from("tally_connections")
      .select(connectionFields)
      .eq("id", id)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!c || !(await granted(user.id, c.installation_ref)))
      return reply({ error: "No support grant for this installation." }, 403);
    const ds = await client
      .from("tally_company_datasets")
      .select("id,company_guid,company_name,financial_year")
      .eq("installation_id", c.installation_ref)
      .eq("owner_user_id", c.owner_user_id);
    if (ds.error) throw ds.error;
    const datasetId = body.datasetId || url.searchParams.get("datasetId");
    const d = ds.data.find((row) => row.id === datasetId);
    if (datasetId && !d)
      return reply({ error: "Unknown company for this installation." }, 400);
    await expire(id);
    if (req.method === "GET") {
      let jobs = client
        .from("connector_operator_jobs")
        .select(fields)
        .eq("connection_id", id)
        .eq("installation_id", c.installation_ref);
      if (d) jobs = jobs.eq("company_dataset_id", d.id);
      const history = await jobs
        .order("created_at", { ascending: false })
        .limit(20);
      if (history.error) throw history.error;
      const files = d
        ? await client
            .from("bank_statement_imports")
            .select("id,original_file_name,created_at,status")
            .eq("owner_user_id", c.owner_user_id)
            .eq("company_dataset_id", d.id)
            .order("created_at", { ascending: false })
            .limit(100)
        : { data: [], error: null };
      if (files.error) throw files.error;
      return reply({
        connection: c,
        datasets: ds.data,
        jobs: history.data,
        statements: files.data,
      });
    }
    const op = String(body.operation);
    if (!d || !operations.includes(op))
      return reply({ error: "Select a company and supported operation." }, 400);
    if (!d.company_guid || !d.financial_year)
      return reply(
        { error: "Refresh the company and financial year in Tally first." },
        409,
      );
    if (op === "followups" && !followupsEnabledFor(c.owner_user_id))
      return reply(
        { error: "Payment follow-ups are disabled for this account." },
        403,
      );
    const parameters: Record<string, string> = {};
    const keys =
      op === "discount" || op === "followups"
        ? ["customer", "invoice"]
        : op === "statement" || op === "verify"
          ? ["statementId", "transactionId"]
          : op === "parse" || op === "match"
            ? ["statementId"]
            : op === "update"
              ? ["version"]
              : [];
    for (const key of keys) {
      if (typeof body[key] === "string" && body[key].trim())
        parameters[key] = body[key].trim().slice(0, 240);
    }
    if (
      ["statement", "parse", "match", "verify"].includes(op) &&
      !parameters.statementId
    )
      return reply({ error: "Select a statement." }, 400);
    if (op === "verify" && !parameters.transactionId)
      return reply(
        { error: "Select a transaction from the statement trace." },
        400,
      );
    if (op === "update" && !/^\d+\.\d+\.\d+$/.test(parameters.version || ""))
      return reply({ error: "Enter the published connector version." }, 400);
    if (
      op !== "statement" &&
      (!c.bridge_version ||
        !/^\d+\.\d+\.\d+$/.test(c.bridge_version) ||
        c.bridge_version.localeCompare("0.1.97", "en", { numeric: true }) < 0)
    )
      return reply(
        { error: "Install connector 0.1.97 or later on this PC." },
        409,
      );
    const result =
      op === "statement"
        ? await statementTrace(
            c.owner_user_id,
            d.id,
            parameters.statementId,
            d.financial_year,
            parameters.transactionId,
          )
        : null;
    const insert = await client
      .from("connector_operator_jobs")
      .insert({
        operator_id: user.id,
        installation_id: c.installation_ref,
        connection_id: id,
        generation: c.session_generation,
        company_dataset_id: d.id,
        company_guid: d.company_guid,
        financial_year: d.financial_year,
        operation: op,
        parameters,
        status: result ? "completed" : "queued",
        result,
      })
      .select(fields)
      .single();
    if (insert.error?.code === "23505")
      return reply(
        { error: "This PC already has a support request in progress." },
        409,
      );
    if (insert.error) throw insert.error;
    return reply({ job: insert.data }, 201);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return reply(
      {
        error:
          code === "42P01" || code === "PGRST205"
            ? "Operator support is awaiting the database migration."
            : "Could not complete the support request.",
      },
      503,
    );
  }
}
export const GET = handle;
export const POST = handle;
