import { createHash } from "node:crypto";

// UUIDv5 namespace reserved for live cash-discount debit-note queue entries.
const namespace = Buffer.from("b0065e35da924d79bdcd75a2bc7a825c", "hex");

export function liveDebitNoteCommandId(datasetId: string, ledger: string, invoice: string,
  invoiceDate: string | null, reversalTier: string) {
  const name = JSON.stringify([datasetId, ledger, invoice, invoiceDate, reversalTier]
    .map(value => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")));
  const bytes = createHash("sha1").update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
