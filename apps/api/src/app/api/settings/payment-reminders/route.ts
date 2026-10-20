import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { followupsEnabledFor } from "@/lib/followups/access";
import { reminderMessages } from "@/lib/followups/messages";
import { validateReminderPlan } from "@/lib/followups/pipeline";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function owner(request: Request) {
  const user = await requireRequestUser(request);
  if (!user) return { response: jsonWithCors(request, { error: "Unauthorized" }, { status: 401 }) };
  if (!followupsEnabledFor(user.id)) return { response: jsonWithCors(request, { error: "Not found." }, { status: 404 }) };
  return { user };
}

/** Saved reminder plans (reusable stage lists) plus the configured messages. */
export async function GET(request: Request) {
  try {
    const auth = await owner(request);
    if (!auth.user) return auth.response;
    const { data, error } = await createSupabaseAdminClient()
      .from("followup_pipeline_templates").select("id, name, stages, updated_at")
      .eq("owner_user_id", auth.user.id).order("name").limit(100);
    if (error) throw error;
    return jsonWithCors(request, {
      plans: data ?? [],
      messages: reminderMessages().map(({ key, name, text }) => ({ key, name, text })),
    });
  } catch (error) {
    console.error("GET /api/settings/payment-reminders", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

/** Create or replace a plan by name. */
export async function PUT(request: Request) {
  try {
    const auth = await owner(request);
    if (!auth.user) return auth.response;
    const body = await request.json().catch(() => ({}));
    const plan = validateReminderPlan(body);
    const known = new Set(reminderMessages().map((m) => m.key));
    if (!plan.stages.every((s) => known.has(s.template))) {
      return jsonWithCors(request, { error: "Select a configured WhatsApp reminder template." }, { status: 400 });
    }
    const { data, error } = await createSupabaseAdminClient().from("followup_pipeline_templates")
      .upsert(
        { owner_user_id: auth.user.id, name: plan.name, stages: plan.stages, updated_at: new Date().toISOString() },
        { onConflict: "owner_user_id,name" }
      ).select("id, name, stages, updated_at").single();
    if (error) throw error;
    return jsonWithCors(request, { plan: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    const invalid = /stage|name/i.test(message) && !/relation|schema/i.test(message);
    if (!invalid) console.error("PUT /api/settings/payment-reminders", error);
    return jsonWithCors(request, { error: invalid ? message : "Internal server error" }, { status: invalid ? 400 : 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await owner(request);
    if (!auth.user) return auth.response;
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonWithCors(request, { error: "Choose a plan to delete." }, { status: 400 });
    const { error } = await createSupabaseAdminClient().from("followup_pipeline_templates")
      .delete().eq("id", id).eq("owner_user_id", auth.user.id);
    if (error) throw error;
    return jsonWithCors(request, { ok: true });
  } catch (error) {
    console.error("DELETE /api/settings/payment-reminders", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
