import { NextResponse } from "next/server";

import { parseDeliveryEvents, secretsMatch, shouldApplyDelivery, type DeliveryStatus } from "@/lib/followups/delivery";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

// MSG91 pauses a webhook that answers 4xx (other than 429), so only a wrong
// secret is refused. Reports for messages we do not track are acknowledged.
export async function POST(request: Request) {
  const expected = String(process.env.MSG91_WEBHOOK_SECRET ?? "").trim();
  if (!expected) {
    console.error("MSG91_WEBHOOK_SECRET is not configured.");
    return NextResponse.json({ error: "Webhook is not configured." }, { status: 503 });
  }
  if (!secretsMatch(request.headers.get("x-gajkesari-webhook-secret"), expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const events = parseDeliveryEvents(body);
  if (!events.length) return NextResponse.json({ ok: true, applied: 0 });

  const db = createSupabaseAdminClient();
  let applied = 0;
  try {
    for (const event of events) {
      const { data: attempt, error } = await db
        .from("invoice_followup_attempts")
        .select("id,delivery_status")
        .eq("provider_reference", event.requestId)
        .maybeSingle();
      if (error) throw error;
      if (!attempt) continue;

      const current = (attempt.delivery_status as DeliveryStatus | null) ?? null;
      if (!shouldApplyDelivery(current, event.status)) continue;

      let update = db
        .from("invoice_followup_attempts")
        .update({
          delivery_status: event.status,
          delivery_reason: event.status === "failed" ? event.reason : null,
          delivery_updated_at: new Date().toISOString(),
        })
        .eq("id", attempt.id);
      // Only write if nobody moved it on since we read it.
      update = current ? update.eq("delivery_status", current) : update.is("delivery_status", null);
      const { error: updateError } = await update;
      if (updateError) throw updateError;
      applied += 1;
    }
  } catch (error) {
    // A 5xx makes MSG91 retry, which is what we want for a database hiccup.
    console.error("POST /api/webhooks/msg91/whatsapp", error);
    return NextResponse.json({ error: "Could not record delivery report." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied });
}
