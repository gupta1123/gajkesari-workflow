import type { SupabaseClient } from "@supabase/supabase-js";

type QueueCommand = { status?: string | null };

const TERMINAL_COMMAND_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "canceled",
  "expired",
  "quarantined",
]);

export function summarizeBankStatementQueueCommands(commands: QueueCommand[]) {
  const summary = {
    commandCount: commands.length,
    queuedCount: 0,
    runningCount: 0,
    succeededCount: 0,
    failedCount: 0,
    terminalCount: 0,
  };
  for (const command of commands) {
    const status = String(command.status ?? "").toLowerCase();
    if (status === "succeeded") summary.succeededCount += 1;
    else if (["queued"].includes(status)) summary.queuedCount += 1;
    else if (["claimed", "processing", "running"].includes(status)) summary.runningCount += 1;
    else if (TERMINAL_COMMAND_STATUSES.has(status)) summary.failedCount += 1;
    else summary.runningCount += 1;
    if (TERMINAL_COMMAND_STATUSES.has(status)) summary.terminalCount += 1;
  }
  return summary;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function refreshBankStatementQueueJobStatus(
  supabase: SupabaseClient,
  queueJobId: string
) {
  if (!queueJobId) return null;
  const { data: job, error: jobError } = await supabase
    .from("bank_statement_tally_queue_jobs")
    .select("id,status,result,total_count,processed_count")
    .eq("id", queueJobId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) return null;

  const result = readRecord(job.result);
  const preparationComplete = result.preparationComplete === true;
  const expectedCommandCount = Math.max(0, Number(result.commandCount ?? 0));
  const { data: commands, error: commandError } = await supabase
    .from("tally_bridge_commands")
    .select("status")
    .eq("queue_job_id", queueJobId);
  if (commandError) throw commandError;

  const postingSummary = summarizeBankStatementQueueCommands(commands ?? []);
  const commandSetComplete = postingSummary.commandCount >= expectedCommandCount;
  const postingComplete = preparationComplete && commandSetComplete &&
    postingSummary.terminalCount === postingSummary.commandCount;
  const status = postingComplete
    ? postingSummary.failedCount > 0 ? "failed" : "succeeded"
    : "running";
  const completedAt = postingComplete ? new Date().toISOString() : null;
  const error = postingComplete && postingSummary.failedCount > 0
    ? `${postingSummary.failedCount} of ${postingSummary.commandCount} Tally action${postingSummary.commandCount === 1 ? "" : "s"} failed.`
    : null;
  const nextResult = { ...result, postingComplete, postingSummary };

  const { data: updated, error: updateError } = await supabase
    .from("bank_statement_tally_queue_jobs")
    .update({
      status,
      result: nextResult,
      error,
      completed_at: completedAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueJobId)
    .select("*")
    .single();
  if (updateError) throw updateError;
  return updated;
}
