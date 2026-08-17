import type { CaseDoc, ComparisonOptions, DocType, FieldKey } from "@/types/pipeline";

export const DEFAULT_COMPARISON_OPTIONS: ComparisonOptions = {
  considerFormatting: false,
};

const PAYMENT_EVIDENCE_DOC_TYPES = new Set<DocType>([
  "Receipt",
  "FASTag Toll Proof",
  "Bank Statement",
  "Payment Screenshot",
]);

const ROUTE_SOURCE_DOC_TYPES = new Set<DocType>([
  "Delivery Challan",
  "Lorry Receipt",
  "Map Printout",
]);

const PURCHASE_ORDER_DOC_TYPES = new Set<DocType>(["Purchase Order", "Amended Purchase Order"]);
const VEHICLE_REGISTRATION_DOC_TYPES = new Set<DocType>(["Vehicle Registration Certificate"]);

const COMPARISON_FIELD_ALIASES: Partial<Record<FieldKey, FieldKey>> = {
  referencePoNumber: "poNumber",
  referenceInvoiceNumber: "invoiceNumber",
  paidAmount: "totalAmount",
  statementAmount: "totalAmount",
  registrationNumber: "vehicleNumber",
  routeFrom: "dispatchFrom",
  routeTo: "shipTo",
};

const COMPARISON_FIELD_LABELS: Partial<Record<FieldKey, string>> = {
  poNumber: "PO Reference",
  invoiceNumber: "Invoice Reference",
  totalAmount: "Commercial / Payment Amount",
  vehicleNumber: "Vehicle / Registration Number",
  dispatchFrom: "Origin / Dispatch From",
  shipTo: "Destination / Ship To",
};

export const PRIMARY_COMPARISON_FIELDS: FieldKey[] = [
  "vendorName",
  "supplierGstin",
  "buyerName",
  "buyerGstin",
  "poNumber",
  "invoiceNumber",
  "receiptNumber",
  "deliveryNoteNumber",
  "eWayBillNumber",
  "weighmentNumber",
  "lorryReceiptNumber",
  "certificateNumber",
  "permitNumber",
  "permitType",
  "licenseNumber",
  "chassisNumber",
  "engineNumber",
  "vehicleClass",
  "vehicleNumber",
  "fuelType",
  "currency",
  "taxAmount",
  "totalAmount",
  "freightAmount",
  "advanceAmount",
  "toPayAmount",
  "materialGrade",
  "itemQuantity",
  "unit",
  "hsnSac",
  "batchNumber",
  "heatNumber",
  "grossWeight",
  "tareWeight",
  "netWeight",
  "bankName",
  "accountNumber",
  "transactionReference",
  "fastagReference",
  "tollPlaza",
  "mapLocation",
  "ownerName",
  "transporterName",
  "driverName",
  "panNumber",
  "evidenceDescription",
];

const PRIMARY_COMPARISON_FIELD_SET = new Set<string>(PRIMARY_COMPARISON_FIELDS);

type ComparableDoc = Pick<CaseDoc, "type" | "fields">;

function normalizeNumericLikeValue(value: string) {
  const compact = value.replace(/[₹$€£,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(compact)) {
    return null;
  }

  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed.toString() : null;
}

export function normalizeComparableValue(
  value: string | number | null | undefined,
  options: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
) {
  if (value == null) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const lowerCased = raw.toLowerCase();
  const numericNormalized = normalizeNumericLikeValue(lowerCased);

  if (numericNormalized !== null) {
    return numericNormalized;
  }

  if (options.considerFormatting) {
    return lowerCased.replace(/\s+/g, " ").trim();
  }

  return lowerCased.replace(/[^a-z0-9]/g, "");
}

export function areComparableValuesEqual(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
  options: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
) {
  const normalizedLeft = normalizeComparableValue(left, options);
  const normalizedRight = normalizeComparableValue(right, options);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return normalizedLeft === normalizedRight;
}

export function pickCanonicalComparableValue(
  values: Array<string | number>,
  options: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
) {
  const counts = new Map<string, number>();

  for (const value of values) {
    const normalized = normalizeComparableValue(value, options);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;

  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }

  const match =
    values.find((value) => normalizeComparableValue(value, options) === best) ??
    values.find((value) => Boolean(normalizeComparableValue(value, options)));

  return match == null ? "" : String(match);
}

export function getComparisonFieldKey(fieldKey: FieldKey) {
  return COMPARISON_FIELD_ALIASES[fieldKey] ?? fieldKey;
}

export function isPrimaryComparisonField(fieldKey: string) {
  const canonicalField = getComparisonFieldKey(fieldKey as FieldKey);
  return PRIMARY_COMPARISON_FIELD_SET.has(canonicalField);
}

export function getComparisonDisplayLabel(fieldKey: string, fallback?: string) {
  return COMPARISON_FIELD_LABELS[fieldKey as FieldKey] ?? fallback ?? fieldKey;
}

export function getComparableFieldValue(doc: ComparableDoc, fieldKey: FieldKey) {
  const canonicalField = getComparisonFieldKey(fieldKey);

  switch (canonicalField) {
    case "poNumber":
      return PURCHASE_ORDER_DOC_TYPES.has(doc.type)
        ? doc.fields.poNumber ?? doc.fields.referencePoNumber
        : doc.fields.referencePoNumber ?? doc.fields.poNumber;
    case "invoiceNumber":
      return PAYMENT_EVIDENCE_DOC_TYPES.has(doc.type)
        ? doc.fields.referenceInvoiceNumber ?? doc.fields.invoiceNumber
        : doc.fields.invoiceNumber ?? doc.fields.referenceInvoiceNumber;
    case "totalAmount":
      return PAYMENT_EVIDENCE_DOC_TYPES.has(doc.type)
        ? doc.fields.paidAmount ?? doc.fields.statementAmount ?? doc.fields.totalAmount
        : doc.fields.totalAmount ?? doc.fields.paidAmount ?? doc.fields.statementAmount;
    case "vehicleNumber":
      return VEHICLE_REGISTRATION_DOC_TYPES.has(doc.type)
        ? doc.fields.registrationNumber ?? doc.fields.vehicleNumber
        : doc.fields.vehicleNumber ?? doc.fields.registrationNumber;
    case "dispatchFrom":
      return ROUTE_SOURCE_DOC_TYPES.has(doc.type)
        ? doc.fields.routeFrom ?? doc.fields.dispatchFrom
        : doc.fields.dispatchFrom ?? doc.fields.routeFrom;
    case "shipTo":
      return ROUTE_SOURCE_DOC_TYPES.has(doc.type)
        ? doc.fields.routeTo ?? doc.fields.shipTo
        : doc.fields.shipTo ?? doc.fields.routeTo;
    default:
      return doc.fields[canonicalField];
  }
}

export function getCommercialAmountValue(doc: ComparableDoc) {
  return PAYMENT_EVIDENCE_DOC_TYPES.has(doc.type) ? undefined : doc.fields.totalAmount;
}

export function getPaymentEvidenceAmountValue(doc: ComparableDoc) {
  return doc.fields.paidAmount ?? doc.fields.statementAmount;
}

export function readComparisonOptions(value: unknown): ComparisonOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_COMPARISON_OPTIONS };
  }

  const record = value as Record<string, unknown>;
  return {
    considerFormatting: record.considerFormatting === true,
  };
}

export function getComparisonModeLabel(options: ComparisonOptions) {
  return options.considerFormatting ? "Formatting considered" : "Formatting ignored";
}
