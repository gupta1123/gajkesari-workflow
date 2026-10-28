// WhatsApp reminder templates. Nothing is built in: a Gajkesari deployment must
// register its own MSG91-approved template(s) through FOLLOWUP_WHATSAPP_TEMPLATES_JSON,
// e.g. [{"key":"payment_reminder","name":"payment_reminder","language":"en",
// "namespace":"<your namespace>","text":"Hello {{customer}}, ...",
// "components":{"body_1":"customer","body_2":"outstanding","body_3":"invoice",
// "body_4":"invoice_date","body_5":"company"}}].

export class WhatsappRejectedError extends Error {}

type Message = {
  key: string;
  name: string;
  language: string;
  namespace: string;
  text: string;
  components: Record<string, string>;
};
type MessageRow = { customer: string; company_name: string; invoice: string; invoice_date?: string | null; outstanding: number };

const FIELDS = ["customer", "company", "invoice", "invoice_date", "outstanding"] as const;
type Field = (typeof FIELDS)[number];

export function reminderMessages(): Message[] {
  let raw: unknown;
  try {
    raw = JSON.parse(process.env.FOLLOWUP_WHATSAPP_TEMPLATES_JSON || "[]");
  } catch {
    throw new Error("Follow-up messages are not configured correctly.");
  }
  if (!Array.isArray(raw)) throw new Error("Follow-up messages are not configured correctly.");
  return raw.filter(
    (m: Message) =>
      m && typeof m.key === "string" && typeof m.name === "string" && typeof m.language === "string" &&
      typeof m.namespace === "string" && typeof m.text === "string" && m.components &&
      Object.values(m.components).every((x) => (FIELDS as readonly string[]).includes(x))
  );
}

export function reminderMessageValues(row: MessageRow): Record<Field, string> {
  const invoiceDate = row.invoice_date
    ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" })
        .format(new Date(`${row.invoice_date}T00:00:00`))
    : "";
  return {
    customer: row.customer,
    company: row.company_name,
    invoice: row.invoice,
    invoice_date: invoiceDate,
    outstanding: new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(row.outstanding),
  };
}

export function reminderPreview(key: string, row: MessageRow) {
  const message = reminderMessages().find((m) => m.key === key);
  if (!message) throw new Error("Select a configured WhatsApp reminder template.");
  const values = reminderMessageValues(row);
  return message.text.replace(/\{\{(customer|company|invoice|invoice_date|outstanding)\}\}/g, (_, field: Field) => values[field]);
}

/**
 * Returns the provider reference on acceptance. Throws WhatsappRejectedError
 * when the provider definitely refused (safe to retry after fixing config) and a
 * plain Error when delivery is uncertain (must NOT be resent automatically).
 */
export async function submitReminder(key: string, row: MessageRow, phone: string) {
  const message = reminderMessages().find((m) => m.key === key);
  const authkey = process.env.MSG91_AUTHKEY;
  const sender = process.env.MSG91_WHATSAPP_NUMBER;
  if (!message || !authkey || !sender) {
    throw new WhatsappRejectedError("Configure a WhatsApp sender and approved reminder template first.");
  }
  const values = reminderMessageValues(row);
  const response = await fetch("https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/", {
    method: "POST",
    headers: { authkey, "content-type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      integrated_number: sender,
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name: message.name,
          namespace: message.namespace,
          language: { code: message.language, policy: "deterministic" },
          to_and_components: [{
            to: [phone],
            components: Object.fromEntries(
              Object.entries(message.components).map(([component, field]) => [component, { type: "text", value: values[field as Field] }])
            ),
          }],
        },
      },
    }),
  });
  const payload = await response.json().catch(() => null);
  if ([400, 401, 403, 404, 422].includes(response.status)) {
    throw new WhatsappRejectedError("WhatsApp rejected the template or recipient. Check configuration before retrying.");
  }
  if (!response.ok || !payload || payload.hasError || !["success", "accepted"].includes(String(payload.type || payload.status || "").toLowerCase())) {
    throw new Error("Provider acknowledgement is uncertain. Verify it before resending.");
  }
  return String(payload.request_id || payload.requestId || payload.message_id || "accepted").slice(0, 200);
}
