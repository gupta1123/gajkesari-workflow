import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { loadProfile } from "./support-profile.mjs";

const actions = [
  "diagnose",
  "dues",
  "followups",
  "discount",
  "logs",
  "reconnect",
  "statement",
  "parse",
  "match",
  "verify",
  "update",
];
const {
  positionals: [command],
  values,
} = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    [
      "pc",
      "dataset",
      "customer",
      "invoice",
      "statement",
      "transaction",
      "version",
      "job",
    ].map((key) => [key, { type: "string" }]),
  ),
});
if (!command || command === "help") {
  console.log(
    "list | errors --pc ID | inspect --pc ID | history --pc ID --dataset ID | wait --pc ID --dataset ID --job ID",
  );
  console.log(
    actions.join(" | "),
    "--pc ID --dataset ID [--customer NAME] [--invoice REF] [--statement ID] [--transaction ID] [--version X.Y.Z]",
  );
  process.exit(0);
}
if (
  !["list", "inspect", "history", "errors", "wait", ...actions].includes(
    command,
  )
)
  throw Error("Unknown support command.");
if (command !== "list" && !values.pc)
  throw Error("Select the exact --pc from list.");
if (!["inspect", "list", "errors"].includes(command) && !values.dataset)
  throw Error("Select --dataset from inspect.");
const profile = loadProfile();
const auth = createClient(profile.url, profile.key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await auth.auth.signInWithPassword({
  email: profile.email,
  password: profile.password,
});
if (error) throw Error("Operator sign-in failed: " + error.message);
const endpoint =
  "https://gajkesari-workflow-b626b81159b6.herokuapp.com/api/operator-support";
async function api(query, body) {
  const response = await fetch(endpoint + query, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(35000),
    headers: {
      Authorization: "Bearer " + data.session.access_token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok)
    throw Error(
      response.status + " " + (payload.error || "Support request failed"),
    );
  return payload;
}
const print = (value) => console.log(JSON.stringify(value, null, 2));
const selection =
  "?" +
  new URLSearchParams({
    connectionId: values.pc || "",
    datasetId: values.dataset || "",
  });
if (command === "list") print((await api("")).connections);
else if (command === "errors")
  print((await api(selection + "&view=errors")).errors);
else if (command === "inspect" || command === "history") {
  const state = await api(selection);
  print(
    command === "inspect"
      ? {
          connection: state.connection,
          datasets: state.datasets,
          statements: state.statements,
        }
      : state.jobs,
  );
} else {
  let id = values.job;
  if (command === "wait" && !id) throw Error("Supply --job ID.");
  if (command !== "wait") {
    const job = (
      await api("", {
        operation: command === "dues" ? "diagnose" : command,
        refreshDues: command === "dues",
        connectionId: values.pc,
        datasetId: values.dataset,
        customer: values.customer,
        invoice: values.invoice,
        statementId: values.statement,
        transactionId: values.transaction,
        version: values.version,
      })
    ).job;
    if (command === "dues" && job.parameters?.refreshDues !== "true")
      throw Error("Backend does not support dues refresh yet.");
    id = job.id;
    console.error("Request", id);
  }
  let last;
  for (;;) {
    const job = (await api(selection + "&jobId=" + encodeURIComponent(id))).job;
    if (!job)
      throw Error(
        "Request unavailable in this selection's recent history: " + id,
      );
    const phase = job.progress || job.status;
    if (last !== phase) {
      console.error(phase);
      last = phase;
    }
    if (["completed", "failed", "expired"].includes(job.status)) {
      print(job);
      if (job.status !== "completed") process.exitCode = 1;
      break;
    }
    await delay(5000);
  }
}
