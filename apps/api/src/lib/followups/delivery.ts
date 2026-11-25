export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export type DeliveryEvent = {
  requestId: string;
  status: DeliveryStatus;
  reason: string | null;
};

const RANK: Record<DeliveryStatus, number> = { sent: 1, delivered: 2, read: 3, failed: 3 };

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * MSG91 posts one report as an object, or a batch as an array. Anything that is
 * not an outbound report with a request id and a known status is skipped, so an
 * unfamiliar event never turns into an error that would pause the webhook.
 */
export function parseDeliveryEvents(body: unknown): DeliveryEvent[] {
  const list = Array.isArray(body) ? body : [body];
  const events: DeliveryEvent[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.direction !== undefined && String(record.direction) !== "1") continue;
    const requestId = text(record.requestId ?? record.request_id, 200);
    const status = text(record.eventName ?? record.event_name, 40).toLowerCase();
    if (!requestId || !(status in RANK)) continue;
    events.push({ requestId, status: status as DeliveryStatus, reason: status === "failed" ? text(record.reason, 500) || null : null });
  }
  return events;
}

/**
 * Reports can repeat or arrive out of order. A message only moves forward
 * (sent, delivered, read), and a failure never overwrites a delivery.
 */
export function shouldApplyDelivery(current: DeliveryStatus | null, next: DeliveryStatus) {
  if (!current) return true;
  if (current === next) return false;
  if (next === "failed") return current === "sent";
  if (current === "failed") return next !== "sent";
  return RANK[next] > RANK[current];
}

export function secretsMatch(provided: string | null, expected: string) {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
