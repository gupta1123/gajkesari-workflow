import type { CaseDoc, DocType, FieldKey, Mismatch } from "@/types/pipeline";
import {
  ACTIVE_FIELD_DEFINITIONS,
  FIELD_LABELS,
  getFieldKeysForDocType,
  omitIgnoredFields,
} from "@/lib/document-schema";

let aiUnavailableReason: string | null = null;
const CLIENT_MAX_RETRIES = Number(
  process.env.NEXT_PUBLIC_OPENROUTER_MAX_RETRIES ??
    process.env.NEXT_PUBLIC_GEMINI_MAX_RETRIES ??
    1
);
const CLIENT_RETRY_BASE_MS = Number(
  process.env.NEXT_PUBLIC_OPENROUTER_RETRY_BASE_MS ??
    process.env.NEXT_PUBLIC_GEMINI_RETRY_BASE_MS ??
    900
);

type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
};

const SUPPORTED_DOC_TYPES: DocType[] = [
  "Purchase Order",
  "Amended Purchase Order",
  "Invoice",
  "Tax Invoice",
  "E-Way Bill",
  "Weighment Slip",
  "Lorry Receipt",
  "Vehicle Registration Certificate",
  "Driving Licence",
  "PAN Card",
  "FASTag Toll Proof",
  "Material Test Certificate",
  "Photo Evidence",
  "Transport Permit",
  "Receipt",
  "Delivery Note",
  "Delivery Challan",
  "Bank Statement",
  "Map Printout",
  "Payment Screenshot",
  "Unknown",
];

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function isQuotaOrRateLimitError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("quota exceeded") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("billing") ||
    message.includes("free tier") ||
    message.includes("limit: 0")
  );
}

function isRetryableProviderError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("quota exceeded") || message.includes("billing") || message.includes("limit: 0")) {
    return false;
  }
  return (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("network")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markAiUnavailable(error: unknown) {
  aiUnavailableReason = errorMessage(error);
  console.warn(
    "OpenRouter temporarily unavailable. Falling back to local/sample mode.",
    aiUnavailableReason
  );
}

async function callOpenRouter(messages: OpenRouterMessage[], label: string, expectJson = false) {
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= CLIENT_MAX_RETRIES) {
    try {
      const response = await fetch("/api/ai/openrouter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          expectJson,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `OpenRouter request failed (${response.status})`);
      }
      return String(payload?.content || "");
    } catch (error) {
      lastError = error;
      if (!isRetryableProviderError(error) || attempt === CLIENT_MAX_RETRIES) {
        throw error;
      }
      const delayMs = CLIENT_RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(
        `OpenRouter ${label} failed on attempt ${attempt + 1}. Retrying in ${delayMs}ms.`,
        errorMessage(error)
      );
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`OpenRouter ${label} failed`);
}

const ALL_ALLOWED_FIELD_KEYS = ACTIVE_FIELD_DEFINITIONS.map((field) => field.key);

const FIELD_MAPPINGS: Partial<Record<FieldKey, string[]>> = {
  vendorName: [
    "vendorName",
    "sellerName",
    "supplierName",
    "vendor",
    "seller",
    "supplier",
    "consignorName",
    "issuerName",
  ],
  supplierGstin: ["supplierGstin", "vendorGstin", "sellerGstin", "gstin", "gstinUin"],
  buyerName: [
    "buyerName",
    "customerName",
    "consigneeName",
    "buyer",
    "customer",
    "consignee",
    "billToName",
    "shipToName",
    "recipientName",
    "purchaserName",
  ],
  buyerGstin: [
    "buyerGstin",
    "customerGstin",
    "consigneeGstin",
    "shipToGstin",
    "billToGstin",
    "recipientGstin",
    "purchaserGstin",
  ],
  poNumber: ["poNumber", "purchaseOrderNumber"],
  poAmendmentNumber: ["poAmendmentNumber", "amendmentNumber", "poVersion", "revisionNumber"],
  invoiceNumber: ["invoiceNumber", "billNumber"],
  receiptNumber: ["receiptNumber"],
  deliveryNoteNumber: ["deliveryNoteNumber", "challanNumber"],
  referencePoNumber: ["referencePoNumber", "poReference", "purchaseOrderReference"],
  referenceInvoiceNumber: ["referenceInvoiceNumber", "invoiceReference"],
  eWayBillNumber: ["eWayBillNumber", "ewayBillNumber", "ewayNumber"],
  weighmentNumber: ["weighmentNumber", "weighmentReceiptNumber", "weighmentSlipNumber"],
  weighbridgeName: ["weighbridgeName", "weighBridgeName", "weightBridgeName"],
  lorryReceiptNumber: ["lorryReceiptNumber", "lrNumber", "lorryNumber", "transportReceiptNumber", "consignmentNumber"],
  certificateNumber: ["certificateNumber", "testCertificateNumber", "mtcNumber", "mtrNumber"],
  certificateDate: ["certificateDate", "testCertificateDate", "mtcDate", "certificateIssuedDate"],
  permitNumber: ["permitNumber", "authorisationNumber", "authorizationNumber"],
  permitType: ["permitType", "authorizationType", "permitClass"],
  licenseNumber: ["licenseNumber", "licenceNumber", "drivingLicenseNumber", "drivingLicenceNumber"],
  chassisNumber: ["chassisNumber", "vin", "vehicleIdentificationNumber"],
  engineNumber: ["engineNumber", "motorNumber"],
  vehicleClass: ["vehicleClass", "vehicleType"],
  documentDate: ["documentDate", "invoiceDate", "poDate", "receiptDate", "deliveryDate"],
  ackDate: ["ackDate", "acknowledgementDate", "acknowledgmentDate"],
  transactionDate: ["transactionDate", "transactionTime", "transactionDateTime", "paymentDate", "statementDate"],
  validityDate: ["validityDate", "permitValidityDate", "licenseValidityDate", "licenceValidityDate", "registrationValidityDate"],
  dateOfBirth: ["dateOfBirth", "dob", "birthDate"],
  currency: ["currency"],
  subtotal: ["subtotal", "subTotal", "taxableAmount"],
  taxAmount: ["taxAmount", "tax", "gstAmount"],
  totalAmount: ["totalAmount", "grandTotal", "documentTotal"],
  paidAmount: ["paidAmount", "amountPaid", "paidTollAmount", "tollAmount", "amountReceived", "receivedAmount"],
  statementAmount: ["statementAmount", "availableBalance", "availableBal", "avblBal", "balance", "debitAmount", "creditAmount", "transactionAmount"],
  freightAmount: ["freightAmount", "freight", "transportCharge"],
  advanceAmount: ["advanceAmount", "advancePaid"],
  toPayAmount: ["toPayAmount", "toPay", "ttbAmount"],
  itemDescription: ["itemDescription", "description", "productDescription"],
  materialGrade: ["materialGrade", "grade", "steelGrade"],
  itemQuantity: ["itemQuantity", "quantity", "qty"],
  unit: ["unit", "uom"],
  hsnSac: ["hsnSac", "hsn", "sac", "hsnCode"],
  batchNumber: ["batchNumber", "batchNo", "lotNumber"],
  heatNumber: ["heatNumber", "heatNo", "castLotNo"],
  vehicleNumber: ["vehicleNumber", "truckNumber", "lorryNumber", "vehicleNo", "truckNo"],
  registrationNumber: ["registrationNumber", "registrationNo", "rcNumber", "regnNumber"],
  ownerName: ["ownerName", "registeredOwnerName"],
  transporterName: ["transporterName", "transporter", "transportName", "carrierName"],
  driverName: ["driverName", "licenceHolderName", "licenseHolderName"],
  holderName: ["holderName", "nameOnCard", "panHolderName"],
  fatherName: ["fatherName", "fatherOrSpouseName"],
  panNumber: ["panNumber", "panNo"],
  fuelType: ["fuelType"],
  grossWeight: ["grossWeight", "grossWt"],
  tareWeight: ["tareWeight", "tareWt"],
  netWeight: ["netWeight", "netWt"],
  bankName: ["bankName"],
  accountNumber: ["accountNumber", "accountNo"],
  irnNumber: ["irnNumber", "irn"],
  ackNumber: ["ackNumber", "acknowledgementNumber", "acknowledgmentNumber"],
  transactionReference: ["transactionReference", "utrNumber", "referenceNumber", "paymentReference"],
  fastagReference: ["fastagReference", "fastagId", "tagId", "tagNumber", "tag", "transactionId"],
  fastagStatementReference: ["fastagStatementReference", "statementReferenceNumber", "statementReference"],
  fastagCustomerId: ["fastagCustomerId", "customerId", "customerID"],
  fastagCustomerName: ["fastagCustomerName", "customerName", "tagCustomerName"],
  statementPeriod: ["statementPeriod", "period"],
  statementDate: ["statementDate"],
  openingBalance: ["openingBalance", "openingBal"],
  creditAmount: ["creditAmount", "credit", "totalCredit"],
  debitAmount: ["debitAmount", "debit", "totalDebit"],
  closingBalance: ["closingBalance", "closingBal"],
  tripCount: ["tripCount", "totalTrips"],
  tollTransactionSummary: ["tollTransactionSummary", "transactionSummary", "tripSummary"],
  tollPlaza: ["tollPlaza", "plazaName", "tollLocation"],
  dispatchFrom: ["dispatchFrom", "originAddress", "dispatchAddress"],
  shipTo: ["shipTo", "deliveryAddress", "consigneeAddress"],
  routeFrom: ["routeFrom", "origin", "fromLocation"],
  routeTo: ["routeTo", "destination", "toLocation"],
  mapLocation: ["mapLocation", "address", "registeredAddress", "holderAddress"],
  photoTimestamp: ["photoTimestamp", "captureTimestamp", "evidenceTimestamp"],
  evidenceDescription: ["evidenceDescription", "photoDescription", "observation"],
};

function normaliseDocType(raw?: string): DocType {
  if (!raw) return "Unknown";
  const value = raw.toLowerCase();
  if (value.includes("amended purchase order")) return "Amended Purchase Order";
  if (value.includes("material test") || value.includes("test certificate") || value.includes("quality certificate") || value.includes("mill test")) {
    return "Material Test Certificate";
  }
  if (value.includes("driving licence") || value.includes("driving license") || value.includes("licence")) {
    return "Driving Licence";
  }
  if (value.includes("transport permit") || value.includes("authorisation") || value.includes("authorization") || value.includes("permit")) {
    return "Transport Permit";
  }
  if (value.includes("photo") || value.includes("camera") || value.includes("loading") || value.includes("unloading")) {
    return "Photo Evidence";
  }
  if (value.includes("tax invoice")) return "Tax Invoice";
  if (value.includes("e-way") || value.includes("eway")) return "E-Way Bill";
  if (value.includes("weighment") || value.includes("weighbridge")) return "Weighment Slip";
  if (
    value.includes("lorry receipt") ||
    value.includes("lr copy") ||
    value.includes("transport receipt") ||
    value.includes("consignment") ||
    value.includes("transport challan")
  ) {
    return "Lorry Receipt";
  }
  if (value.includes("vehicle registration") || value.includes("registration certificate") || value.includes("rc book")) {
    return "Vehicle Registration Certificate";
  }
  if (value.includes("pan card") || value === "pan") return "PAN Card";
  if (value.includes("fastag") || value.includes("toll")) return "FASTag Toll Proof";
  if (value.includes("bank statement")) return "Bank Statement";
  if (value.includes("map") || value.includes("location print")) return "Map Printout";
  if (value.includes("payment screenshot") || value.includes("payment proof") || value.includes("sms")) {
    return "Payment Screenshot";
  }
  if (value.includes("purchase order") || value === "po") return "Purchase Order";
  if (value.includes("invoice")) return "Invoice";
  if (value.includes("receipt")) return "Receipt";
  if (value.includes("delivery challan") || value.includes("challan")) return "Delivery Challan";
  if (value.includes("delivery")) return "Delivery Note";
  return "Unknown";
}

function inferDocTypeFromFilename(fileName: string): DocType {
  const lower = fileName.toLowerCase();
  if (lower.includes("amended") && lower.includes("po")) return "Amended Purchase Order";
  if (lower.includes("test") || lower.includes("mtc") || lower.includes("mtr")) return "Material Test Certificate";
  if (lower.includes("licence") || lower.includes("license") || lower.includes("dl")) return "Driving Licence";
  if (lower.includes("permit") || lower.includes("authorisation") || lower.includes("authorization")) {
    return "Transport Permit";
  }
  if (lower.includes("photo") || lower.includes("camera")) return "Photo Evidence";
  if (lower.includes("tax") && lower.includes("invoice")) return "Tax Invoice";
  if (lower.includes("eway") || lower.includes("e-way")) return "E-Way Bill";
  if (lower.includes("weighment") || lower.includes("weight")) return "Weighment Slip";
  if (lower.includes("lorry") || lower.includes("consignment") || lower.includes("challan") || lower.includes("lr")) {
    return "Lorry Receipt";
  }
  if (lower.includes("rc") || lower.includes("registration")) return "Vehicle Registration Certificate";
  if (lower.includes("pan")) return "PAN Card";
  if (lower.includes("fastag") || lower.includes("toll")) return "FASTag Toll Proof";
  if (lower.includes("bank") && lower.includes("statement")) return "Bank Statement";
  if (lower.includes("map")) return "Map Printout";
  if (lower.includes("payment") || lower.includes("sms")) return "Payment Screenshot";
  if (lower.includes("purchase-order") || lower.includes("purchase_order") || lower.includes("po")) {
    return "Purchase Order";
  }
  if (lower.includes("inv no") || lower.includes(" inv.") || lower.includes("invoice")) {
    return "Tax Invoice";
  }
  if (lower.includes("receipt")) return "Receipt";
  if (lower.includes("delivery-note") || lower.includes("delivery_note") || lower.includes("delivery note")) {
    return "Delivery Note";
  }
  if (lower.includes("challan")) return "Delivery Challan";
  if (lower.includes("delivery")) return "Delivery Note";
  return "Unknown";
}

function formatDocType(docType: DocType): string {
  return docType === "Unknown" ? "Document" : docType;
}

function getAllowedFieldKeysForDocType(docType: DocType) {
  const docTypeFieldKeys = getFieldKeysForDocType(docType);
  return docTypeFieldKeys.length > 0 ? docTypeFieldKeys : ALL_ALLOWED_FIELD_KEYS;
}

function getOrderedFieldKeysForDocument(doc: CaseDoc): FieldKey[] {
  const orderedKeys = [...getAllowedFieldKeysForDocType(doc.type)];
  const seen = new Set<FieldKey>(orderedKeys);

  for (const { key } of ACTIVE_FIELD_DEFINITIONS) {
    if (doc.fields[key] && !seen.has(key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }

  return orderedKeys;
}

function mapFields(
  fields: Record<string, unknown>,
  docType?: DocType
): Partial<Record<FieldKey, string>> {
  const result: Partial<Record<FieldKey, string>> = {};
  const allowedFieldKeys = docType
    ? getAllowedFieldKeysForDocType(docType)
    : ALL_ALLOWED_FIELD_KEYS;

  allowedFieldKeys.forEach((fieldKey) => {
    const aliases = FIELD_MAPPINGS[fieldKey] ?? [];
    for (const alias of aliases) {
      const value = fields[alias];
      const normalizedValue = normalizeFieldValue(value);
      if (normalizedValue) {
        result[fieldKey] = normalizedValue;
        break;
      }
    }
  });
  return result;
}

function normalizeFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => {
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const parts = [
            normalizeFieldValue(record.date ?? record.dateTime ?? record.transactionDate),
            normalizeFieldValue(record.plaza ?? record.tollPlaza ?? record.location),
            normalizeFieldValue(record.amount ?? record.debitAmount ?? record.paidAmount),
          ].filter(Boolean);
          return parts.length ? parts.join(" - ") : normalizeFieldValue(record.description ?? record.summary);
        }
        return normalizeFieldValue(entry);
      })
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = normalizeFieldValue(record.value ?? record.text ?? record.summary ?? record.description);
    if (text) return text;
    const fallback = Object.entries(record)
      .map(([key, entry]) => `${key}: ${normalizeFieldValue(entry) ?? ""}`.trim())
      .filter((entry) => !entry.endsWith(":"))
      .join(", ");
    return fallback || undefined;
  }
  const text = String(value).trim();
  return text || undefined;
}

function cleanEWayAddress(value?: string) {
  const cleaned = value
    ?.replace(/\s+/g, " ")
    .replace(/\b(Address\s+Details|Dispatch\s+From|Ship\s+To|GSTIN|State|Pin\s*Code)\b\s*:*/gi, " ")
    .replace(/^[\s:;,\-.]+/, "")
    .replace(/[\s,.;:-]+$/, "")
    .trim();
  return cleaned || undefined;
}

function extractEWayBillAddresses(visibleText: string): Partial<Record<FieldKey, string>> {
  const text = visibleText.replace(/\s+/g, " ").trim();
  const match = text.match(/(?:Address\s+Details\s*)?(?:[:：]\s*)?(?:Dispatch\s+From|Dispatched\s+From)\s*[:：]?\s*(.+?)\s*(?:Ship\s+To|Ship-to)\s*[:：]?\s*(.+?)(?=\s*(?:Vehicle\s+Details|Part\s+B|Item\s+Details|Total|$))/i);
  if (!match) return {};
  return {
    dispatchFrom: cleanEWayAddress(match[1]),
    shipTo: cleanEWayAddress(match[2]),
  };
}

function applyEWayBillAddressFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string
) {
  if (docType !== "E-Way Bill" || !visibleText.trim()) return fields;
  const addresses = extractEWayBillAddresses(visibleText);
  return {
    ...fields,
    ...(fields.dispatchFrom || !addresses.dispatchFrom ? {} : { dispatchFrom: addresses.dispatchFrom }),
    ...(fields.shipTo || !addresses.shipTo ? {} : { shipTo: addresses.shipTo }),
  };
}

function extractFirstMatch(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

function extractFastagTransactions(visibleText: string) {
  const lines = visibleText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const entries: Array<{ dateTime: string; plaza: string; lane?: string; amount: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const dateTime = lines[index].match(/\d{2}[-/]\d{2}[-/]\d{4}\s+\d{2}:\d{2}:\d{2}/)?.[0];
    if (!dateTime) continue;

    const block: string[] = [lines[index]];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/\d{2}[-/]\d{2}[-/]\d{4}\s+\d{2}:\d{2}:\d{2}/.test(lines[next])) break;
      block.push(lines[next]);
    }

    const blockText = block.join(" ");
    if (!/Plaza\s+Name/i.test(blockText)) continue;

    const plaza = blockText
      .match(/Plaza\s+Name\s*:?\s*([A-Za-z][A-Za-z0-9 ()]+?)(?=\s*-\s*Lane|\s+Lane\s+ID|\s+0\.00|\s+\/?\d{8,}|$)/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    if (!plaza) continue;

    const lane = blockText.match(/Lane\s+ID\s*:?\s*([A-Z0-9 ]+?)(?=\s+0\.00|\s+\d{1,3}(?:,\d{3})*(?:\.\d{2})|$)/i)?.[1]?.replace(/\s+/g, " ").trim();
    const amounts = [...blockText.matchAll(/\b\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/g)].map((match) => match[0]);
    const amount = amounts.at(-1);
    if (!amount) continue;

    entries.push({ dateTime, plaza, lane, amount });
  }

  return entries;
}

function extractFastagDetails(visibleText: string): Partial<Record<FieldKey, string>> {
  const compact = visibleText.replace(/\s+/g, " ").trim();
  if (!compact) return {};

  const summaryMatch = compact.match(
    /(\d{6,})\s+([A-Z]{2}\d{2}[A-Z]{1,3}\d{4})\s+\S+\s+(\d+)\s+([\d,.]+)\s+([\d,.]+)\s+-?\s*([\d,.]+)\s+([\d,.]+)/i
  );
  const tagVehicleBlock = compact.match(/Tag\s+Account\s+No\.\s+Licence\s+Plate\s+No\..*?(\d{6,})\s+([A-Z]{2}\d{2}[A-Z]{1,3}\d{4})/i);
  const vehicleTagMatch = compact.match(/\b([A-Z]{2}\d{2}[A-Z0-9]{1,4}\d{3,4})\s*[-–]\s*(\d{6,})\b/i);
  const paymentMatch = compact.match(/\bPayment\b.*?([\d,]+\.\d{2})\s+0\.00/i);
  const transactionRows = extractFastagTransactions(visibleText);
  const transactionSummary = transactionRows
    .slice(0, 12)
    .map((entry) => {
      const lane = entry.lane ? ` Lane ID:${entry.lane}` : "";
      return `${entry.dateTime} Plaza Name: ${entry.plaza}${lane} Amount (DR) ${entry.amount}`;
    })
    .join("\n");
  const statementDate = extractFirstMatch(compact, /Statement\s+Date\s*:?\s*(\d{2}[-/]\d{2}[-/]\d{4})/i);
  const statementReference = (
    extractFirstMatch(compact, /Statement\s+Reference\s+Number\s+([A-Z0-9/.-]+)/i) ??
    extractFirstMatch(compact, /Statement\s+Reference\s+(?:Number\s+)?([A-Z0-9/.-]+)/i)
  )?.replace(/t/gi, "/");
  const customerId = extractFirstMatch(compact, /Customer\s+[Il1]?D\s*:?\s*(?:[A-Z0-9/.-]+\s+)?(\d{7,})/i);
  const customerName = [...compact.matchAll(/Name\s*:\s*([A-Z][A-Z .'-]+?)(?=\s+(?:Branch|Statement\s+Period|Bill\s+From|GSTIN|Address:|supply:))/gi)]
    .map((match) => match[1].replace(/\s+/g, " ").trim())
    .find((name) => !/ICICI|BANK|BRANCH/i.test(name)) ??
    extractFirstMatch(compact, /Address\s*:\s*([A-Z][A-Z .'-]+?)\s+\d{1,5}[,\s]/i);

  return {
    fastagStatementReference: statementReference,
    fastagCustomerId: customerId,
    fastagCustomerName: customerName,
    statementPeriod: extractFirstMatch(compact, /Statement\s+Period\s*:?\s*(\d{2}[-/]\d{2}[-/]\d{4}\s+to\s+\d{2}[-/]\d{2}[-/]\d{4})/i),
    statementDate,
    transactionDate: statementDate,
    ...(summaryMatch
      ? {
          fastagReference: summaryMatch[1],
          vehicleNumber: summaryMatch[2],
          tripCount: summaryMatch[3],
          openingBalance: summaryMatch[4],
          creditAmount: summaryMatch[5],
          debitAmount: summaryMatch[6].replace(/^-/, ""),
          closingBalance: summaryMatch[7],
          statementAmount: summaryMatch[7],
        }
      : {}),
    ...(!summaryMatch && tagVehicleBlock ? { fastagReference: tagVehicleBlock[1], vehicleNumber: tagVehicleBlock[2] } : {}),
    ...(!summaryMatch && !tagVehicleBlock && vehicleTagMatch ? { vehicleNumber: vehicleTagMatch[1], fastagReference: vehicleTagMatch[2] } : {}),
    ...(paymentMatch?.[1] ? { paidAmount: paymentMatch[1] } : {}),
    ...(transactionRows[0]?.plaza ? { tollPlaza: transactionRows[0].plaza } : {}),
    ...(transactionSummary ? { tollTransactionSummary: transactionSummary } : {}),
  };
}

function applyFastagDetailsFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string
) {
  if (docType !== "FASTag Toll Proof" || !visibleText.trim()) return fields;
  const details = extractFastagDetails(visibleText);
  return Object.entries(details).reduce(
    (acc, [key, value]) => {
      if (value) acc[key as FieldKey] = value;
      return acc;
    },
    { ...fields } as Partial<Record<FieldKey, string>>
  );
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => toText(entry))
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    return Object.values(value)
      .map((entry) => toText(entry))
      .filter(Boolean)
      .join("\n");
  }
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function buildMarkdown(doc: CaseDoc, visibleTextPages: string[] = []): string {
  const lines = [`# ${doc.title}`, "", `Source: **${doc.sourceHint ?? "uploaded"}**`, ""];
  let hasFields = false;

  for (const key of getOrderedFieldKeysForDocument(doc)) {
    const value = doc.fields[key];
    if (value) {
      if (!hasFields) {
        lines.push("## Extracted Fields", "");
        hasFields = true;
      }
      lines.push(`- **${FIELD_LABELS[key]}**: ${value}`);
    }
  }

  const visibleText = visibleTextPages.map((text) => text.trim()).filter(Boolean);
  if (visibleText.length) {
    if (hasFields) lines.push("");
    lines.push("## Visible Text", "");
    visibleText.forEach((text, index) => {
      if (visibleText.length > 1) {
        lines.push(`### Page ${index + 1}`, "");
      }
      lines.push(text);
      if (index < visibleText.length - 1) {
        lines.push("");
      }
    });
  }

  return lines.join("\n");
}

function fallbackDoc(fileName: string, docType?: DocType): CaseDoc {
  const resolvedType =
    docType && docType !== "Unknown" ? docType : inferDocTypeFromFilename(fileName);

  const fallback: CaseDoc = {
    id: `fallback_${resolvedType.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${Date.now()}`,
    type: resolvedType,
    title: `${formatDocType(resolvedType)} — ${fileName}`,
    pages: 1,
    fields: omitIgnoredFields({}) as Partial<Record<FieldKey, string>>,
    md: "",
    sourceHint: fileName,
  };
  fallback.md = buildMarkdown(fallback);
  return fallback;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    const jsonString =
      start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
    return JSON.parse(jsonString) as T;
  } catch {
    return fallback;
  }
}

export async function classifyDocumentFromImage(image: string, fileName = ""): Promise<DocType> {
  const inferred = inferDocTypeFromFilename(fileName);
  if (!image || !image.startsWith("data:image/")) {
    return inferred;
  }

  if (aiUnavailableReason) {
    return inferred;
  }

  try {
    const raw = await callOpenRouter(
      [
        {
          role: "system",
          content:
            `Classify procurement packet pages. Return only JSON like {"documentType":"Purchase Order"} using one of: ${SUPPORTED_DOC_TYPES.join(", ")}.`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Classify this file: ${fileName}` },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      "classification",
      true
    );
    const parsed = safeJsonParse<{ documentType?: string }>(raw, {});
    const classified = normaliseDocType(parsed.documentType);
    return classified === "Unknown" ? inferred : classified;
  } catch (error) {
    if (isQuotaOrRateLimitError(error)) {
      markAiUnavailable(error);
    } else {
      console.warn("Failed to classify document with OpenRouter", error);
    }
    return inferred;
  }
}

export async function extractDataFromImages(params: {
  fileName: string;
  pageImages: string[];
  documentType: DocType;
}): Promise<{ doc: CaseDoc; extractedDocuments: Array<{ documentType: DocType; fields: Record<string, unknown> }> }> {
  const { fileName, pageImages, documentType } = params;
  const allowedFieldKeys = getAllowedFieldKeysForDocType(documentType);
  const allowedFieldKeysText = allowedFieldKeys.join(", ");

  if (!pageImages.length || pageImages.some((image) => !image.startsWith("data:image/"))) {
    return { doc: fallbackDoc(fileName, documentType), extractedDocuments: [] };
  }

  if (aiUnavailableReason) {
    return { doc: fallbackDoc(fileName, documentType), extractedDocuments: [] };
  }

  try {
    const extracted: Array<{ fields: Record<string, unknown>; visibleText: string }> = [];

    for (const image of pageImages) {
      const raw = await callOpenRouter(
        [
            {
              role: "system",
              content:
              `Extract structured fields and visible text from procurement, logistics, transport, vehicle KYC, FASTag, quality certificate, and photo-evidence documents and return only JSON with keys "fields" and "visibleText". ` +
              `This document is a ${documentType}. Use only these field keys for this document type: ${allowedFieldKeysText}. ` +
              "visibleText must be a raw OCR-style transcription of the important visible text on the page, preserving line breaks where useful. " +
              "For FASTag Toll Proof documents, extract statement reference, customer ID/name, statement period/date, vehicle number, tag account number, trip count, opening/credit/debit/closing balances, recharge/payment amount, toll plaza, and a compact toll transaction summary using the canonical FASTag keys. " +
              "For party roles on seller-issued documents, vendorName is the issuing supplier/seller/consignor and buyerName is the receiving buyer, bill-to party, ship-to party, consignee, customer, or purchaser. " +
              "For Purchase Order or Amended Purchase Order documents, vendorName is the supplier/vendor receiving the order and buyerName is the purchaser issuing the order. Never swap these roles. " +
              "Omit any field that is not visible or not applicable to this document type. If structured fields are hard to identify, still return visibleText. Do not hallucinate.",
            },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `This upload is likely a ${documentType}. ` +
                  "Pages may include invoices, purchase orders, e-way bills, weighment slips, lorry receipts, RC/DL/PAN cards, FASTag toll proofs, test certificates, permits, or photo evidence. " +
                  `Extract only clearly visible ${documentType}-specific fields from this allowed schema: ${allowedFieldKeysText}. ` +
                  "Also transcribe the visible text into visibleText even if the structured fields object is empty. " +
                  "If both supplier and receiver are visible, map seller-issued documents as seller/consignor to vendorName and receiving buyer/bill-to/ship-to/consignee to buyerName. For purchase orders, map the supplier/vendor receiving the order to vendorName. " +
                  "Preserve exact document numbers, vehicle ids, GSTINs, weights, dates, and financial totals.",
              },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
        "extraction",
        true
      );

      const parsed = safeJsonParse<{
        fields?: Record<string, unknown>;
        visibleText?: unknown;
        text?: unknown;
        ocrText?: unknown;
        markdown?: unknown;
      }>(raw, {});
      extracted.push({
        fields: parsed.fields ?? {},
        visibleText:
          toText(parsed.visibleText) ||
          toText(parsed.ocrText) ||
          toText(parsed.text) ||
          toText(parsed.markdown),
      });
    }

    const combinedFields = extracted.reduce(
      (acc, current) => ({ ...acc, ...current.fields }),
      {}
    );
    const visibleTextPages = extracted.map((page) => page.visibleText).filter(Boolean);
    const visibleText = visibleTextPages.join("\n");
    const fields = applyFastagDetailsFallback(
      applyEWayBillAddressFallback(
        mapFields(combinedFields, documentType),
        documentType,
        visibleText
      ),
      documentType,
      visibleText
    );

    const caseDoc: CaseDoc = {
      id: `${fileName}-${Date.now()}`,
      type: documentType,
      title: `${formatDocType(documentType)} — ${fileName}`,
      pages: pageImages.length,
      fields,
      md: "",
      sourceHint: fileName,
    };
    caseDoc.md = buildMarkdown(caseDoc, visibleTextPages);

    return { doc: caseDoc, extractedDocuments: [] };
  } catch (error) {
    if (isQuotaOrRateLimitError(error)) {
      markAiUnavailable(error);
    } else {
      console.warn("Failed to analyze document with OpenRouter", error);
    }
    return { doc: fallbackDoc(fileName, documentType), extractedDocuments: [] };
  }
}

export async function generateMismatchAnalysis(
  mismatches: Omit<Mismatch, "analysis" | "fixPlan">[],
  documents: CaseDoc[]
): Promise<Mismatch[]> {
  if (aiUnavailableReason || mismatches.length === 0) {
    return mismatches.map((mismatch) => ({
      ...mismatch,
      analysis: aiUnavailableReason
        ? "OpenRouter quota or rate limit reached. Automated analysis was skipped for this run."
        : "Automated analysis pending. Configure OpenRouter to enable risk insights.",
      fixPlan: "Review the conflicting procurement documents and align the source records.",
    }));
  }

  const documentLookup = new Map<string, CaseDoc>(documents.map((doc) => [doc.id, doc]));

  const buildRuleBasedMismatchCopy = (mismatch: Omit<Mismatch, "analysis" | "fixPlan">) => {
    const values = mismatch.values
      .map((entry) => {
        const doc = documentLookup.get(entry.docId);
        return {
          docTitle: doc?.title ?? entry.docId,
          docType: doc?.type ?? "Document",
          value: entry.value == null ? "—" : String(entry.value),
        };
      });

    const observed = values
      .map((entry) => `${entry.docType}: ${entry.value}`)
      .join("; ");

    switch (mismatch.field) {
      case "poNumber":
        return {
          analysis:
            `PO reference mismatch detected. Observed values: ${observed}. ` +
            "If the invoice or delivery note points to a different PO than the approved purchase order, finance may hold payment, receiving may book goods against the wrong order, and audit traceability breaks.",
          fixPlan:
            `1. Confirm the approved PO number with procurement.\n` +
            `2. Update the incorrect invoice or delivery note references.\n` +
            `3. Reissue any supplier document that still references the wrong PO.\n` +
            `4. Reconcile the packet again before approval.`,
        };
      case "invoiceNumber":
        return {
          analysis:
            `Invoice reference mismatch detected. Observed values: ${observed}. ` +
            "This can break receipt-to-invoice matching, cause duplicate-payment risk, and make it unclear which bill the receipt settles.",
          fixPlan:
            `1. Verify the supplier's correct invoice number.\n` +
            `2. Correct the receipt or linked document reference.\n` +
            `3. Ensure only one invoice id is used across the packet.\n` +
            `4. Re-run the comparison before posting payment.`,
        };
      case "currency":
        return {
          analysis:
            `Currency mismatch detected. Observed values: ${observed}. ` +
            "Mixed currencies can invalidate amount comparisons, tax calculations, and settlement values. A payment could be approved in the wrong currency or converted incorrectly.",
          fixPlan:
            `1. Confirm the contractual billing currency.\n` +
            `2. Correct the document using the wrong currency code.\n` +
            `3. Recalculate totals and taxes if any document was converted incorrectly.\n` +
            `4. Only approve the packet once all documents use the same intended currency.`,
        };
      case "eWayBillNumber":
        return {
          analysis:
            `E-Way Bill mismatch detected. Observed values: ${observed}. ` +
            "If transport documents point to different e-way references, dispatch compliance and shipment traceability break. This can block movement validation and create audit issues.",
          fixPlan:
            `1. Confirm the correct e-way bill from the transport record.\n` +
            `2. Correct the invoice, challan, or logistics document carrying the wrong e-way reference.\n` +
            `3. Revalidate vehicle and shipment details against the final e-way bill.`,
        };
      case "weighmentNumber":
      case "grossWeight":
      case "tareWeight":
      case "netWeight":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Weight discrepancies typically mean the weighbridge slip, challan, and invoiced quantity are not aligned. That creates receiving disputes and billing risk.",
          fixPlan:
            `1. Confirm the weighbridge slip used for settlement.\n` +
            `2. Reconcile gross, tare, and net weights with the challan and invoice quantity.\n` +
            `3. Correct the source logistics or billing document before approval.`,
        };
      case "lorryReceiptNumber":
      case "vehicleNumber":
      case "registrationNumber":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Transport identity mismatches make it unclear which vehicle and carriage record belongs to the shipment. This weakens dispatch control and proof-of-movement.",
          fixPlan:
            `1. Confirm the actual vehicle and LR used for the shipment.\n` +
            `2. Correct the incorrect logistics document.\n` +
            `3. Ensure e-way bill, LR, weighment slip, and registration copy all reference the same vehicle.`,
        };
      case "panNumber":
      case "ownerName":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Identity inconsistencies across PAN, RC, and commercial documents can point to master-data errors or incorrect supporting paperwork.",
          fixPlan:
            `1. Confirm the legal identity detail from the source document.\n` +
            `2. Update the incorrect supporting document.\n` +
            `3. Re-run comparison after standardizing the identity fields.`,
        };
      case "transactionReference":
      case "statementAmount":
      case "transactionDate":
      case "bankName":
      case "accountNumber":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Payment-supporting documents do not reconcile cleanly. That creates settlement ambiguity and increases the risk of posting or matching the wrong payment entry.",
          fixPlan:
            `1. Confirm the bank transaction or payment proof used for settlement.\n` +
            `2. Correct the payment record or supporting screenshot.\n` +
            `3. Reconcile amount, reference, and date before marking the packet paid.`,
        };
      case "routeFrom":
      case "routeTo":
      case "mapLocation":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Route and location support documents disagree, which can weaken dispatch traceability and delivery proof.",
          fixPlan:
            `1. Confirm the actual origin, destination, and mapped delivery point.\n` +
            `2. Correct the support document carrying the wrong route/location.\n` +
            `3. Keep the packet aligned before final review.`,
        };
      case "totalAmount":
        return {
          analysis:
            `Total amount mismatch detected. Observed values: ${observed}. ` +
            "This directly affects payment accuracy. It may indicate quantity differences, tax inconsistencies, or a receipt recorded against the wrong amount.",
          fixPlan:
            `1. Compare line quantities, subtotal, and tax across PO, invoice, receipt, and delivery note.\n` +
            `2. Confirm the supplier's final billable amount.\n` +
            `3. Correct the document with the wrong total.\n` +
            `4. Reconcile payment only after the packet totals align.`,
        };
      case "taxAmount":
        return {
          analysis:
            `Tax amount mismatch detected. Observed values: ${observed}. ` +
            "GST amount differences usually mean the taxable value, tax breakup, or document basis is not aligned across the packet. That can create compliance issues and distort the final payable amount.",
          fixPlan:
            `1. Confirm the correct GST amount from the final billing document.\n` +
            `2. Reconcile taxable value and tax treatment across invoice and e-way bill.\n` +
            `3. Correct the document carrying the wrong tax amount.\n` +
            `4. Re-run the comparison before approval.`,
        };
      case "itemQuantity":
        return {
          analysis:
            `Item quantity mismatch detected. Observed values: ${observed}. ` +
            "This usually means goods receipt and billing are out of sync. Paying against a higher quantity than delivered creates overpayment risk, while a lower quantity may signal partial delivery or under-billing.",
          fixPlan:
            `1. Confirm delivered quantity with receiving or warehouse records.\n` +
            `2. Update the delivery note or invoice if one is incorrect.\n` +
            `3. If the delivery was partial, document the remaining balance clearly.\n` +
            `4. Reconcile quantity before releasing payment.`,
        };
      case "vendorName":
      case "buyerName":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Entity-name inconsistencies create vendor master and audit issues, and can cause approval or payment to be routed to the wrong party.",
          fixPlan:
            `1. Confirm the legal entity name from the source system or master record.\n` +
            `2. Correct the inconsistent documents.\n` +
            `3. Standardize the exact naming convention used across the packet.\n` +
            `4. Re-run the comparison after correction.`,
        };
      default:
        return null;
    }
  };

  const tasks = mismatches.map(async (mismatch) => {
    const ruleBased = buildRuleBasedMismatchCopy(mismatch);
    if (ruleBased) {
      return {
        ...mismatch,
        analysis: ruleBased.analysis,
        fixPlan: ruleBased.fixPlan,
      };
    }

    const context = mismatch.values
      .map((value) => {
        const doc = documentLookup.get(value.docId);
        return `- Document: ${doc?.title ?? value.docId} (type: ${doc?.type ?? "unknown"}) -> value: "${value.value}"`;
      })
      .join("\n");

    const prompt =
      `A discrepancy was detected for the field "${mismatch.field}" in a procurement document packet.\n` +
      `${context}\n\n` +
      "Provide:\n## Analysis\nExplain only the risks specific to this field mismatch. Avoid generic boilerplate and avoid discussing unrelated controls.\n" +
      "## Fix Plan\nGive a short field-specific checklist to resolve this exact mismatch across PO, invoice, receipt, and delivery note records.";

    try {
      const markdown = await callOpenRouter(
        [{ role: "user", content: prompt }],
        "mismatch-analysis",
        false
      );

      const [analysisPart, fixPart] = markdown.split("## Fix Plan");

      return {
        ...mismatch,
        analysis: analysisPart?.replace("## Analysis", "").trim() || markdown.trim(),
        fixPlan: fixPart?.trim() ?? "Please review the documents manually to plan remediation.",
      };
    } catch (error) {
      if (isQuotaOrRateLimitError(error)) {
        markAiUnavailable(error);
      } else {
        console.warn("Failed to generate mismatch analysis with OpenRouter", error);
      }
      return {
        ...mismatch,
        analysis: "AI analysis unavailable. Please review the mismatch manually.",
        fixPlan: "Validate the source documents and correct the inconsistent procurement records.",
      };
    }
  });

  return Promise.all(tasks);
}

export function mockMismatchAnalysis(mismatches: Mismatch[]): Mismatch[] {
  return mismatches.map((mismatch) => ({
    ...mismatch,
    analysis: mismatch.analysis ?? "Automated analysis pending.",
    fixPlan: mismatch.fixPlan ?? "Review the conflicting documents manually.",
  }));
}
