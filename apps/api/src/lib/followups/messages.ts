// WhatsApp reminder templates. payment_reminder_v2 is built in; more can be
// registered through FOLLOWUP_WHATSAPP_TEMPLATES_JSON,
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
export type SummaryInvoice = { invoice: string; invoice_date: string | null; outstanding: number };
type MessageRow = {
  customer: string; company_name: string; invoice: string; invoice_date?: string | null; outstanding: number;
  invoices?: SummaryInvoice[] | null;
};

const FIELDS = ["customer", "company", "invoice", "invoice_date", "outstanding", "invoice_count", "invoice_list"] as const;
type Field = (typeof FIELDS)[number];

// Approved MSG91 template on the account Gajkesari already sends debit notes
// from (same namespace as Kalika's). Deployments can add or override templates
// through FOLLOWUP_WHATSAPP_TEMPLATES_JSON.
export const SUMMARY_KEY = "payment_reminder_summary";
const BUILTIN_MESSAGES: Message[] = [{
  key: "payment_reminder_v2",
  name: "payment_reminder_v2",
  language: "en",
  namespace: "2bf6cec8_61b1_4925_8632_49e9ddebff44",
  text: "Hello {{customer}},\n\nThis is a payment reminder for ₹{{outstanding}} pending against invoice {{invoice}} dated {{invoice_date}}.\n\nPlease arrange payment at your earliest convenience. If payment has already been made, please ignore this message.\n\nRegards,\n{{company}} Accounts Team",
  components: { body_1: "customer", body_2: "outstanding", body_3: "invoice", body_4: "invoice_date", body_5: "company" },
}, {
  // One message per customer listing their unpaid invoices on a single line.
  key: SUMMARY_KEY,
  name: SUMMARY_KEY,
  language: "en",
  namespace: "2bf6cec8_61b1_4925_8632_49e9ddebff44",
  text: "Hello {{customer}},\n\nThis is a payment reminder. You have {{invoice_count}} unpaid invoices totalling ₹{{outstanding}}:\n\n{{invoice_list}}\n\nPlease arrange payment at your earliest convenience. If payment has already been made, please ignore this message.\n\nRegards,\n{{company}} Accounts Team",
  components: { body_1: "customer", body_2: "invoice_count", body_3: "outstanding", body_4: "invoice_list", body_5: "company" },
}];

export function reminderMessages(): Message[] {
  let raw: unknown;
  try {
    raw = JSON.parse(process.env.FOLLOWUP_WHATSAPP_TEMPLATES_JSON || "[]");
  } catch {
    throw new Error("Follow-up messages are not configured correctly.");
  }
  if (!Array.isArray(raw)) throw new Error("Follow-up messages are not configured correctly.");
  const configured = raw.filter(
    (m: Message) =>
      m && typeof m.key === "string" && typeof m.name === "string" && typeof m.language === "string" &&
      typeof m.namespace === "string" && typeof m.text === "string" && m.components &&
      Object.values(m.components).every((x) => (FIELDS as readonly string[]).includes(x))
  );
  const byKey = new Map(BUILTIN_MESSAGES.map((m) => [m.key, m]));
  for (const message of configured) byKey.set(message.key, message);
  return [...byKey.values()];
}

const inr = (value: number) => new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const shortDate = (value: string | null | undefined, year = true) =>
  value
    ? new Intl.DateTimeFormat("en-IN", year ? { day: "2-digit", month: "short", year: "numeric" } : { day: "numeric", month: "short" })
        .format(new Date(`${value}T00:00:00`))
    : "";

/**
 * One line for the summary message: the oldest invoices first, then "and N more".
 * WhatsApp variables cannot hold line breaks, so invoices are separated by semicolons.
 */
// Up to 20 invoices, but the list stays within a character budget so the whole message fits WhatsApp's 1,024 limit.
const LIST_MAX = 20;
const LIST_CHARS = 640;
export function invoiceListLine(invoices: SummaryInvoice[], show = LIST_MAX) {
  const sorted = [...invoices].sort((a, b) => String(a.invoice_date ?? "9999").localeCompare(String(b.invoice_date ?? "9999")));
  const entries = sorted.slice(0, show).map((i) => {
    const date = shortDate(i.invoice_date, false);
    return `${i.invoice.replace(/\s+/g, " ")} ₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(i.outstanding)}${date ? ` (${date})` : ""}`;
  });
  const parts: string[] = [];
  let used = 0;
  for (const entry of entries) {
    if (used + entry.length + 2 > LIST_CHARS) break;
    parts.push(entry);
    used += entry.length + 2;
  }
  const rest = sorted.length - parts.length;
  return `${parts.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}`;
}

/** The template to use: the summary for two or more invoices, else the stage's own. */
export function templateForRow(row: { invoices?: unknown[] | null }, stageTemplate: string) {
  return row.invoices && row.invoices.length > 1 ? SUMMARY_KEY : stageTemplate;
}

export function reminderMessageValues(row: MessageRow): Record<Field, string> {
  const invoiceDate = shortDate(row.invoice_date);
  return {
    customer: row.customer,
    company: row.company_name,
    invoice: row.invoice,
    invoice_date: invoiceDate,
    outstanding: inr(row.outstanding),
    invoice_count: String(row.invoices?.length ?? 1),
    invoice_list: row.invoices?.length ? invoiceListLine(row.invoices) : row.invoice,
  };
}

export function reminderPreview(key: string, row: MessageRow) {
  const message = reminderMessages().find((m) => m.key === key);
  if (!message) throw new Error("Select a configured WhatsApp reminder template.");
  const values = reminderMessageValues(row);
  return message.text.replace(/\{\{(customer|company|invoice|invoice_date|outstanding|invoice_count|invoice_list)\}\}/g, (_, field: Field) => values[field]);
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
