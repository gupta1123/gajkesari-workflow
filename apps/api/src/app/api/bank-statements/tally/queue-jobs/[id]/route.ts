import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function serializeQueueJob(row: Record<string, unknown>) {
  return {
    id: row.id,
    status: row.status,
    totalCount: row.total_count,
    processedCount: row.processed_count,
    result: row.result ?? {},
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const supabase = createSupabaseAdminClient();
    const { data: job, error } = await supabase
      .from("bank_statement_tally_queue_jobs")
      .select("*")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (!job) {
      return jsonWithCors(request, { error: "Tally queue job not found." }, { status: 404 });
    }

    return jsonWithCors(request, {
      job: serializeQueueJob(job as Record<string, unknown>),
      result: job.status === "succeeded" ? job.result ?? null : null,
    });
  } catch (error) {
    console.error("Error in GET /api/bank-statements/tally/queue-jobs/[id]:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
