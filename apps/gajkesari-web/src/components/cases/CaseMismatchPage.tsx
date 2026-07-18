"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getComparisonDisplayLabel,
  isPrimaryComparisonField,
} from "@/lib/comparison";
import {
  ACTIVE_FIELD_DEFINITIONS,
  shouldConsiderFieldKey,
} from "@/lib/document-schema";
import { isLineItemMismatchField } from "@/lib/line-items";
import {
  fetchCaseDetail,
  updateCaseMismatchDecisions,
  updateCaseMismatchDecision,
  type MismatchDecision,
  type SavedCaseDetail,
} from "@/lib/case-persistence";
import {
  DEFAULT_COMPARISON_FIELD_GROUPS,
  fetchComparisonGroups,
  type ComparisonFieldGroup,
} from "@/lib/comparison-groups";

type LoadState = "loading" | "ready" | "error";
type MismatchRecord = SavedCaseDetail["mismatches"][number];

const FIELD_LABEL_LOOKUP = ACTIVE_FIELD_DEFINITIONS.reduce(
  (acc, field) => {
    acc[field.key] = field.label;
    return acc;
  },
  {} as Record<string, string>
);

const LINE_ITEM_FIELD_LABELS: Record<string, string> = {
  "lineItems.unmatchedDocumentLine": "Document line item",
  "lineItems.unmatchedInvoiceLine": "Invoice line item",
  "lineItems.uninvoicedPoLine": "PO line item",
  "lineItems.quantityExceeded": "Line item quantity",
  "lineItems.quantityMismatch": "Line item quantity",
  "lineItems.rateMismatch": "Line item rate",
  "lineItems.unitMismatch": "Line item unit",
  "lineItems.hsnSacMismatch": "Line item HSN/SAC",
  "lineItems.amountMismatch": "Line item amount",
};
const TERMS_COMPLIANCE_FIELD = "termsAndConditions";

function getFieldLabel(fieldName: string) {
  if (LINE_ITEM_FIELD_LABELS[fieldName]) {
    return LINE_ITEM_FIELD_LABELS[fieldName];
  }
  return getComparisonDisplayLabel(fieldName, FIELD_LABEL_LOOKUP[fieldName]);
}

function getValueCount(mismatch: MismatchRecord) {
  return (mismatch.values ?? []).filter(
    (entry) => entry.value !== null && entry.value !== undefined && String(entry.value).trim().length > 0
  ).length;
}

function getMismatchResolutionLabel(status: MismatchRecord["resolutionStatus"]) {
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  return "Pending";
}

function getMismatchResolutionClassName(status: MismatchRecord["resolutionStatus"]) {
  if (status === "accepted") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (status === "rejected") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400 italic font-normal">Missing</span>;
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function getIssueDescription(fieldName: string) {
  switch (fieldName) {
    case "lineItems.unitMismatch":
      return "The item was matched, but the PO and invoice use different units. Confirm whether these units mean the same thing before approving.";
    case "lineItems.rateMismatch":
      return "The item was matched, but the invoice rate is different from the effective PO rate.";
    case "lineItems.hsnSacMismatch":
      return "The item was matched, but the HSN/SAC code differs between the documents.";
    case "lineItems.amountMismatch":
      return "The item was matched, but the line amount differs between the documents.";
    case "lineItems.uninvoicedPoLine":
      return "This PO line was ordered but was not found on the invoice.";
    case "lineItems.unmatchedDocumentLine":
      return "This document line could not be confidently matched to the reference document line.";
    case "lineItems.unmatchedInvoiceLine":
      return "This invoice line could not be matched to a PO line.";
    case "lineItems.quantityExceeded":
      return "The invoice quantity is greater than the matching PO quantity.";
    case "lineItems.quantityMismatch":
      return "The matched line quantity differs between the documents.";
    case TERMS_COMPLIANCE_FIELD:
      return "A visible terms and conditions clause was assessed against the packet and needs correction or review.";
    case "taxAmount":
      return "The document failed a GST tax calculation check. Review expected tax against the extracted taxable and tax amounts.";
    case "totalAmount":
      return "The invoice total and PO total do not match.";
    default:
      return "Review the values below and decide whether this issue needs correction.";
  }
}

function formatMismatchValue(fieldName: string, value: unknown, documentTitle: string) {
  if (typeof value !== "string") {
    return displayValue(value);
  }

  const unitMatch = value.match(/^([^:]+): invoice unit (.+) differs from PO unit (.+)$/i);
  if (fieldName === "lineItems.unitMismatch" && unitMatch) {
    const [, , invoiceUnit, poUnit] = unitMatch;
    const isPo = /purchase order|po\b/i.test(documentTitle);
    return isPo ? poUnit : invoiceUnit;
  }

  const rateMatch = value.match(/^([^:]+): invoice rate (.+) differs from PO rate (.+)$/i);
  if (fieldName === "lineItems.rateMismatch" && rateMatch) {
    const [, , invoiceRate, poRate] = rateMatch;
    const isPo = /purchase order|po\b/i.test(documentTitle);
    return isPo ? poRate : invoiceRate;
  }

  const quantityMatch = value.match(/^([^:]+): invoice quantity (.+) exceeds PO quantity (.+)$/i);
  if (fieldName === "lineItems.quantityExceeded" && quantityMatch) {
    const [, , invoiceQuantity, poQuantity] = quantityMatch;
    const isPo = /purchase order|po\b/i.test(documentTitle);
    return isPo ? poQuantity : invoiceQuantity;
  }

  const detailMatch = value.match(/^[^:]+:\s*(.+)$/);
  const detail = detailMatch?.[1]?.trim();
  if (detail) {
    if (fieldName === "lineItems.unitMismatch") {
      const unitValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+unit\s+(.+)$/i);
      if (unitValue?.[1]) return unitValue[1];
    }

    if (fieldName === "lineItems.rateMismatch") {
      const rateValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+(?:net\s+)?rate\s+(.+)$/i);
      if (rateValue?.[1]) return rateValue[1];
    }

    if (fieldName === "lineItems.quantityExceeded" || fieldName === "lineItems.quantityMismatch") {
      const quantityValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+quantity\s+(.+)$/i);
      if (quantityValue?.[1]) return quantityValue[1];
    }

    if (fieldName === "lineItems.hsnSacMismatch") {
      const hsnValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+HSN\/SAC\s+(.+)$/i);
      if (hsnValue?.[1]) return hsnValue[1];
    }

    if (fieldName === "lineItems.amountMismatch") {
      const amountValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+line amount\s+(.+)$/i);
      if (amountValue?.[1]) return amountValue[1];
    }
  }

  return displayValue(value);
}

const BASE_CONTEXT_FIELDS = [
  "poNumber",
  "referencePoNumber",
  "invoiceNumber",
  "referenceInvoiceNumber",
  "eWayBillNumber",
  "lorryReceiptNumber",
  "documentDate",
];

const CONTEXT_FIELDS_BY_MISMATCH: Array<{ fields: string[]; context: string[] }> = [
  {
    fields: ["vendorName", "supplierGstin", "buyerName", "buyerGstin"],
    context: ["vendorName", "supplierGstin", "buyerName", "buyerGstin"],
  },
  {
    fields: ["vehicleNumber", "registrationNumber", "lorryReceiptNumber", "fastagReference", "eWayBillNumber"],
    context: ["vehicleNumber", "registrationNumber", "lorryReceiptNumber", "eWayBillNumber", "fastagReference"],
  },
  {
    fields: ["grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit"],
    context: ["weighmentNumber", "vehicleNumber", "grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit"],
  },
  {
    fields: ["subtotal", "taxAmount", "totalAmount", "paidAmount", "statementAmount", "currency"],
    context: ["currency", "subtotal", "taxAmount", "totalAmount", "paidAmount", "statementAmount"],
  },
  {
    fields: [TERMS_COMPLIANCE_FIELD],
    context: [
      "termsAndConditions",
      "paymentTerms",
      "deliveryTerms",
      "freightTerms",
      "packingForwardingTerms",
      "priceBasis",
      "taxTerms",
      "inspectionTerms",
      "warrantyTerms",
      "hasAuthorizedSignature",
      "hasVendorStamp",
      "hasStoreStamp",
      "hasStoreSignature",
      "hasGateStamp",
    ],
  },
  {
    fields: ["lineItems.unmatchedDocumentLine", "lineItems.unmatchedInvoiceLine", "lineItems.uninvoicedPoLine", "lineItems.quantityExceeded", "lineItems.quantityMismatch", "lineItems.rateMismatch", "lineItems.unitMismatch", "lineItems.hsnSacMismatch", "lineItems.amountMismatch"],
    context: ["invoiceNumber", "referenceInvoiceNumber", "poNumber", "referencePoNumber", "eWayBillNumber", "itemQuantity", "unit", "subtotal", "taxAmount", "totalAmount"],
  },
];

type DocumentContextRow = {
  key: string;
  label: string;
  value: unknown;
  emphasis?: boolean;
};

type MismatchEvidence = {
  key: string;
  docId?: string;
  document?: SavedCaseDetail["documents"][number];
  value: unknown;
  contextRows: DocumentContextRow[];
};

type ParsedTaxValidationIssue = {
  lineLabel: string | null;
  condition: string | null;
  rule: string | null;
  taxableAmount: number | null;
  expectedTax: number | null;
  actualTax: number | null;
  difference: number | null;
  summary: string;
};

type MismatchGroupSection = {
  key: string;
  label: string;
  mismatches: MismatchRecord[];
  pending: number;
  accepted: number;
  rejected: number;
};

const LINE_ITEM_GROUP_KEY = "line_items";
const TERMS_GROUP_KEY = "terms_compliance";
const OTHER_GROUP_KEY = "other";

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getResolutionCounts(mismatches: MismatchRecord[]) {
  return {
    pending: mismatches.filter((mismatch) => mismatch.resolutionStatus === "pending").length,
    accepted: mismatches.filter((mismatch) => mismatch.resolutionStatus === "accepted").length,
    rejected: mismatches.filter((mismatch) => mismatch.resolutionStatus === "rejected").length,
  };
}

function getGroupKeyForMismatch(fieldName: string, comparisonGroups: ComparisonFieldGroup[]) {
  if (isLineItemMismatchField(fieldName)) return LINE_ITEM_GROUP_KEY;
  if (fieldName === TERMS_COMPLIANCE_FIELD) return TERMS_GROUP_KEY;

  const group = comparisonGroups.find(
    (entry) => entry.enabled !== false && entry.fields.includes(fieldName)
  );
  return group?.groupKey ?? OTHER_GROUP_KEY;
}

function buildMismatchGroupSections(
  mismatches: MismatchRecord[],
  comparisonGroups: ComparisonFieldGroup[]
): MismatchGroupSection[] {
  const configuredGroups: Array<{ key: string; label: string; sortOrder: number }> = [
    { key: LINE_ITEM_GROUP_KEY, label: "Line items", sortOrder: 0 },
    ...comparisonGroups
      .filter((group) => group.enabled !== false)
      .map((group) => ({ key: group.groupKey, label: group.label, sortOrder: group.sortOrder })),
    { key: TERMS_GROUP_KEY, label: "Terms compliance", sortOrder: 900 },
    { key: OTHER_GROUP_KEY, label: "Other fields", sortOrder: 1000 },
  ];

  const byKey = new Map<string, MismatchRecord[]>();
  for (const mismatch of mismatches) {
    const key = getGroupKeyForMismatch(mismatch.fieldName, comparisonGroups);
    byKey.set(key, [...(byKey.get(key) ?? []), mismatch]);
  }

  return configuredGroups
    .map((group) => {
      const groupMismatches = byKey.get(group.key) ?? [];
      const counts = getResolutionCounts(groupMismatches);
      return {
        key: group.key,
        label: group.label,
        mismatches: groupMismatches,
        ...counts,
      };
    })
    .filter((group) => group.mismatches.length > 0)
    .sort((a, b) => {
      const sortA = configuredGroups.find((group) => group.key === a.key)?.sortOrder ?? 999;
      const sortB = configuredGroups.find((group) => group.key === b.key)?.sortOrder ?? 999;
      return sortA - sortB;
    });
}

function getLineItemLabel(mismatch: MismatchRecord) {
  if (!isLineItemMismatchField(mismatch.fieldName)) return getFieldLabel(mismatch.fieldName);
  const firstValue = mismatch.values?.find((entry) => hasDisplayableValue(entry.value))?.value;
  const valueText = typeof firstValue === "string" ? firstValue : "";
  const lineMatch = valueText.match(/^([^:]{1,40}):/);
  if (lineMatch?.[1]) {
    const prefix = lineMatch[1].trim();
    if (/^\d+$/.test(prefix)) return `Line ${prefix}`;
    return prefix.replace(/\*+/g, "").trim();
  }
  return "Line item";
}

function parseAmountFromText(value: string, label: string) {
  const pattern = new RegExp(`${label}\\s+(?:INR\\s*)?(-?[\\d,]+(?:\\.\\d+)?)`, "i");
  const match = value.match(pattern);
  if (!match?.[1]) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTaxAmount(value: number | null) {
  if (value === null) return "-";
  return `INR ${value.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  })}`;
}

function parseTaxValidationIssue(value: unknown): ParsedTaxValidationIssue | null {
  if (typeof value !== "string" || !/expected tax|actual tax/i.test(value)) {
    return null;
  }

  const text = value.replace(/\s+/g, " ").trim();
  const lineMatch = text.match(/^Line\s+(\d+):/i);
  const segments = text
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const expectedSegment =
    segments.find((segment) => /\bexpected\b/i.test(segment) && !/expected tax/i.test(segment)) ?? null;
  const conditionSegment =
    segments.find((segment) => segment !== expectedSegment && !/taxable|expected tax|actual tax/i.test(segment)) ??
    null;
  const ruleText = expectedSegment?.replace(/^Line\s+\d+:\s*/i, "").match(/expected\s+(.+)$/i)?.[1] ?? null;
  const taxableAmount = parseAmountFromText(text, "taxable");
  const expectedTax = parseAmountFromText(text, "expected tax");
  const actualTax = parseAmountFromText(text, "actual tax");
  const difference = expectedTax !== null && actualTax !== null ? actualTax - expectedTax : null;
  const lineLabel = lineMatch?.[1] ? `Line ${lineMatch[1]}` : null;
  const differenceText =
    difference === null || Math.abs(difference) < 0.005
      ? ""
      : ` ${formatTaxAmount(Math.abs(difference))} ${difference < 0 ? "short" : "extra"}.`;

  return {
    lineLabel,
    condition: conditionSegment?.replace(/^Line\s+\d+:\s*/i, "") ?? null,
    rule: ruleText,
    taxableAmount,
    expectedTax,
    actualTax,
    difference,
    summary:
      expectedTax !== null && actualTax !== null
        ? `${lineLabel ? `${lineLabel}: ` : ""}tax should be ${formatTaxAmount(expectedTax)}, but extracted tax is ${formatTaxAmount(actualTax)}.${differenceText}`
        : text,
  };
}

function getIssueDisplayTitle(mismatch: MismatchRecord, evidence: MismatchEvidence[]) {
  if (mismatch.fieldName === "taxAmount" && isSingleDocumentIssue(mismatch, evidence)) {
    const parsed = parseTaxValidationIssue(evidence[0]?.value);
    if (parsed?.actualTax === 0 && parsed.lineLabel) return "Line tax missing";
    if (parsed?.difference != null && parsed.difference < 0) return "Tax shortfall";
    if (parsed?.difference != null && parsed.difference > 0) return "Tax excess";
    return "Tax validation";
  }

  return getFieldLabel(mismatch.fieldName);
}

function isSingleDocumentIssue(mismatch: MismatchRecord, evidence: MismatchEvidence[]) {
  const documentIds = uniqueStrings(
    evidence.map((entry) => entry.docId || entry.document?.id || entry.document?.clientDocumentId || "")
  );
  return evidence.length <= 1 || getValueCount(mismatch) <= 1 || documentIds.length <= 1;
}

function getIssueModeLabel(mismatch: MismatchRecord, evidence: MismatchEvidence[]) {
  if (isSingleDocumentIssue(mismatch, evidence)) {
    return isLineItemMismatchField(mismatch.fieldName) ? "Line exception" : "Validation issue";
  }
  return "Document mismatch";
}

function getReviewerHint(mismatch: MismatchRecord, evidence?: MismatchEvidence[]) {
  if (evidence && isSingleDocumentIssue(mismatch, evidence)) {
    if (mismatch.fieldName === "taxAmount") {
      return "This is a tax validation issue inside one document, not a mismatch between documents. Check taxable amount, GST rate, and extracted tax before deciding.";
    }
    if (isLineItemMismatchField(mismatch.fieldName)) {
      return "This line needs attention because the system could not fully reconcile it with the related document line.";
    }
    return "This issue was found inside one document. Use the source/page and context below to decide whether it is a real problem or extraction noise.";
  }

  const values = (mismatch.values ?? [])
    .map((entry) => String(entry.value ?? "").trim())
    .filter(Boolean);
  const uniqueValues = uniqueStrings(values);

  if (
    uniqueValues.length === 2 &&
    uniqueValues[0].length === uniqueValues[1].length &&
    uniqueValues[0].length <= 24
  ) {
    const diffCount = uniqueValues[0]
      .split("")
      .filter((char, index) => char !== uniqueValues[1][index]).length;
    if (diffCount > 0 && diffCount <= 2) {
      return `Only ${diffCount === 1 ? "one character differs" : `${diffCount} characters differ`} - likely OCR, typing, or formatting. Check the source before treating it as a business mismatch.`;
    }
  }

  if (mismatch.fieldName === "lineItems.unmatchedInvoiceLine") {
    return "Invoice has a line that was not matched to the order. Check whether it is an extra charge, duplicate extraction, or missing PO line.";
  }
  if (mismatch.fieldName === "lineItems.unmatchedDocumentLine" || mismatch.fieldName === "lineItems.uninvoicedPoLine") {
    return "A line exists in one document but not the other. This is usually more important than a small field typo.";
  }
  if (mismatch.fieldName === "lineItems.rateMismatch" || mismatch.fieldName === "lineItems.amountMismatch") {
    return "Commercial value differs between documents. Confirm rate, quantity, and tax basis before approving.";
  }
  if (mismatch.fieldName === "lineItems.unitMismatch") {
    return "Matched item, but units differ. Confirm whether the units are equivalent or if extraction used the wrong unit.";
  }
  if (mismatch.fieldName === "taxAmount") {
    return "Tax discrepancy can come from GST type, rate, taxable value, or OCR. Verify tax calculation first.";
  }
  if (mismatch.fieldName === "vehicleNumber") {
    return "Vehicle number differences are often OCR-sensitive, but they affect dispatch traceability.";
  }

  return mismatch.analysis || getIssueDescription(mismatch.fieldName);
}

function getContextFieldsForMismatch(fieldName: string) {
  const configured = CONTEXT_FIELDS_BY_MISMATCH.find((entry) => entry.fields.includes(fieldName));
  return uniqueStrings([fieldName, ...(configured?.context ?? []), ...BASE_CONTEXT_FIELDS]);
}

function hasDisplayableValue(value: unknown) {
  return value !== null && value !== undefined && String(value).trim().length > 0;
}

function getDocumentSourceLabel(document?: SavedCaseDetail["documents"][number]) {
  if (!document) return "Document not found";
  const sourceHint = document.sourceHint?.trim();
  const sourceFileName = document.sourceFileName?.trim();
  if (sourceHint && sourceFileName && sourceHint.includes(sourceFileName)) {
    return sourceHint;
  }

  return [sourceHint, sourceFileName]
    .filter((value): value is string => Boolean(value && value.trim()))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" - ") || "Uploaded document";
}

function getCompactSourceLabel(document?: SavedCaseDetail["documents"][number]) {
  if (!document) return "Document not found";
  const sourceLabel = getDocumentSourceLabel(document);
  const pageMatch = sourceLabel.match(/\bpages?\s+\d+(?:\s*-\s*\d+)?/i);
  const fileName = document.sourceFileName?.trim();

  if (fileName && pageMatch?.[0]) {
    return `${fileName} (${pageMatch[0].toLowerCase()})`;
  }

  return fileName || document.title || sourceLabel;
}

function getEvidenceDocumentRole(document?: SavedCaseDetail["documents"][number]) {
  return document?.documentType || "Document";
}

function getFieldValueFromDocument(
  document: SavedCaseDetail["documents"][number] | undefined,
  fieldName: string
) {
  if (!document) return undefined;
  return (document.extractedFields as Record<string, unknown> | undefined)?.[fieldName];
}

function buildDocumentContextRows(
  document: SavedCaseDetail["documents"][number] | undefined,
  fieldName: string,
  mismatchValue: unknown
) {
  const rows: DocumentContextRow[] = [];
  const primaryValue = getFieldValueFromDocument(document, fieldName);

  if (isLineItemMismatchField(fieldName) || fieldName === TERMS_COMPLIANCE_FIELD) {
    rows.push({
      key: "issueDetail",
      label: fieldName === TERMS_COMPLIANCE_FIELD ? "Terms assessment" : "Issue detail",
      value: mismatchValue,
      emphasis: true,
    });
  } else {
    rows.push({
      key: fieldName,
      label: getFieldLabel(fieldName),
      value: hasDisplayableValue(primaryValue) ? primaryValue : mismatchValue,
      emphasis: true,
    });
  }

  for (const contextField of getContextFieldsForMismatch(fieldName)) {
    if (contextField === fieldName) continue;
    const value = getFieldValueFromDocument(document, contextField);
    if (!hasDisplayableValue(value)) continue;
    rows.push({
      key: contextField,
      label: getFieldLabel(contextField),
      value,
    });
  }

  const lineItemCount = document?.lineItems?.length ?? 0;
  if (isLineItemMismatchField(fieldName) && lineItemCount > 0) {
    rows.push({
      key: "lineItemCount",
      label: "Extracted line items",
      value: lineItemCount,
    });
  }

  return rows.slice(0, 8);
}

function buildMismatchEvidence(
  mismatch: MismatchRecord,
  documentLookup: Map<string, SavedCaseDetail["documents"][number]>
): MismatchEvidence[] {
  return (mismatch.values ?? []).map((entry, index) => {
    const document = entry.docId ? documentLookup.get(entry.docId) : undefined;
    return {
      key: `${mismatch.id}-${entry.docId ?? "missing"}-${index}`,
      docId: entry.docId,
      document,
      value: entry.value,
      contextRows: buildDocumentContextRows(document, mismatch.fieldName, entry.value),
    };
  });
}

function getIssueListDetail(mismatch: MismatchRecord, evidence: MismatchEvidence[]) {
  if (isSingleDocumentIssue(mismatch, evidence)) {
    const sourceLabel = getCompactSourceLabel(evidence[0]?.document);
    const issueType = getIssueModeLabel(mismatch, evidence);
    const parsedTaxIssue =
      mismatch.fieldName === "taxAmount" ? parseTaxValidationIssue(evidence[0]?.value) : null;
    if (parsedTaxIssue && parsedTaxIssue.expectedTax !== null && parsedTaxIssue.actualTax !== null) {
      return `${formatTaxAmount(parsedTaxIssue.actualTax)} vs ${formatTaxAmount(parsedTaxIssue.expectedTax)} - ${sourceLabel}`;
    }
    return sourceLabel ? `${issueType} - ${sourceLabel}` : issueType;
  }

  const count = getValueCount(mismatch);
  return `${count} value${count === 1 ? "" : "s"} disagree`;
}

function getDocumentRoleSummary(evidence: MismatchEvidence[]) {
  return uniqueStrings(evidence.map((entry) => getEvidenceDocumentRole(entry.document))).join(" vs ");
}

function getSingleIssueRows(evidence: MismatchEvidence[], fieldName: string) {
  return (
    evidence[0]?.contextRows.filter((row) => !row.emphasis && row.key !== fieldName).slice(0, 6) ?? []
  );
}

function MismatchReviewSkeleton() {
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden lg:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-slate-200 bg-white lg:w-80 lg:border-b-0 lg:border-r">
        <div className="hidden border-b border-slate-100 p-5 lg:block">
          <div className="mb-4 flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded bg-slate-100" />
            <Skeleton className="h-4 w-28 bg-slate-100" />
          </div>
          <div className="space-y-3">
            <div className="space-y-2">
              <Skeleton className="h-3 w-16 bg-slate-100" />
              <Skeleton className="h-4 w-40 bg-slate-100" />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-3 w-20 bg-slate-100" />
                <Skeleton className="h-4 w-8 bg-slate-100" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-16 bg-amber-100" />
                <Skeleton className="h-4 w-8 bg-amber-100" />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden bg-slate-50/50 lg:bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 bg-white px-4 py-3 lg:px-5 lg:py-4">
            <Skeleton className="h-4 w-32 bg-slate-100" />
          </div>
          <div className="flex gap-2 overflow-x-auto p-3 lg:block lg:space-y-0 lg:overflow-y-hidden lg:p-0">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className="shrink-0 rounded-full border border-slate-200 bg-white px-4 py-2 lg:w-full lg:rounded-none lg:border-0 lg:border-l-[3px] lg:border-transparent lg:px-5 lg:py-3"
              >
                <Skeleton className="h-4 w-28 bg-slate-100" />
                <Skeleton className="mt-2 hidden h-3 w-20 bg-slate-100 lg:block" />
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="space-y-2">
            <Skeleton className="h-7 w-52 bg-slate-200/70" />
            <Skeleton className="h-4 w-80 max-w-full bg-slate-200/70" />
          </div>
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Skeleton className="h-4 w-4 rounded bg-slate-100" />
              <Skeleton className="h-4 w-32 bg-slate-100" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <Skeleton className="mb-3 h-3 w-32 bg-slate-100" />
                  <Skeleton className="h-4 w-44 bg-slate-100" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-4 sm:p-5">
            <Skeleton className="mb-4 h-4 w-36 bg-slate-200/70" />
            <div className="space-y-3">
              <Skeleton className="h-3.5 w-full bg-slate-200/70" />
              <Skeleton className="h-3.5 w-5/6 bg-slate-200/70" />
              <Skeleton className="h-3.5 w-4/6 bg-slate-200/70" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function CaseMismatchPage({ caseId }: { caseId: string }) {
  const [detail, setDetail] = useState<SavedCaseDetail | null>(null);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [activeMismatchId, setActiveMismatchId] = useState<string | null>(null);
  const [decisionStatus, setDecisionStatus] = useState<"idle" | "updating" | "error">("idle");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [selectedMismatchIds, setSelectedMismatchIds] = useState<Set<string>>(() => new Set());
  const [comparisonGroups, setComparisonGroups] = useState<ComparisonFieldGroup[]>(
    () => DEFAULT_COMPARISON_FIELD_GROUPS
  );
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(
    () => new Set([LINE_ITEM_GROUP_KEY])
  );

  useEffect(() => {
    let active = true;

    fetchCaseDetail(caseId)
      .then((payload) => {
        if (!active) return;
        setDetail(payload);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load mismatch review.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [caseId]);

  useEffect(() => {
    let active = true;

    fetchComparisonGroups()
      .then((groups) => {
        if (active) {
          setComparisonGroups(groups);
        }
      })
      .catch(() => {
        if (active) {
          setComparisonGroups(DEFAULT_COMPARISON_FIELD_GROUPS);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const visibleMismatches = useMemo(
    () =>
      detail?.mismatches.filter(
        (mismatch) =>
          mismatch.fieldName === TERMS_COMPLIANCE_FIELD ||
          isLineItemMismatchField(mismatch.fieldName) ||
          (shouldConsiderFieldKey(mismatch.fieldName) && isPrimaryComparisonField(mismatch.fieldName))
      ) ?? [],
    [detail]
  );

  useEffect(() => {
    setActiveMismatchId((current) => {
      if (current && visibleMismatches.some((mismatch) => mismatch.id === current)) {
        return current;
      }
      return visibleMismatches[0]?.id ?? null;
    });
  }, [visibleMismatches]);

  const documentLookup = useMemo(() => {
    const map = new Map<string, SavedCaseDetail["documents"][number]>();
    detail?.documents.forEach((document) => {
      map.set(document.id, document);
      if (document.clientDocumentId) {
        map.set(document.clientDocumentId, document);
      }
    });
    return map;
  }, [detail]);

  const activeMismatch = useMemo(() => {
    if (!activeMismatchId) return visibleMismatches[0] ?? null;
    return visibleMismatches.find((mismatch) => mismatch.id === activeMismatchId) ?? null;
  }, [activeMismatchId, visibleMismatches]);

  const mismatchGroups = useMemo(
    () => buildMismatchGroupSections(visibleMismatches, comparisonGroups),
    [visibleMismatches, comparisonGroups]
  );
  const activeGroupKey = activeMismatch
    ? getGroupKeyForMismatch(activeMismatch.fieldName, comparisonGroups)
    : null;
  const activeGroup = activeGroupKey
    ? mismatchGroups.find((group) => group.key === activeGroupKey) ?? null
    : null;

  const activeFieldLabel = activeMismatch ? getFieldLabel(activeMismatch.fieldName) : "";
  const activeEvidence = useMemo(
    () => (activeMismatch ? buildMismatchEvidence(activeMismatch, documentLookup) : []),
    [activeMismatch, documentLookup]
  );
  const activeIsSingleDocumentIssue = activeMismatch
    ? isSingleDocumentIssue(activeMismatch, activeEvidence)
    : false;
  const activeIssueDisplayTitle = activeMismatch ? getIssueDisplayTitle(activeMismatch, activeEvidence) : "";
  const activeTaxValidationIssue =
    activeMismatch?.fieldName === "taxAmount" && activeIsSingleDocumentIssue
      ? parseTaxValidationIssue(activeEvidence[0]?.value)
      : null;
  const activeIssueModeLabel = activeMismatch ? getIssueModeLabel(activeMismatch, activeEvidence) : "";
  const activeIssueHint = activeMismatch ? getReviewerHint(activeMismatch, activeEvidence) : "";
  const activeDocumentSummary = activeEvidence.length > 0 ? getDocumentRoleSummary(activeEvidence) : "";
  const activeSingleIssueRows = activeMismatch
    ? getSingleIssueRows(activeEvidence, activeMismatch.fieldName)
    : [];
  const isCaseFinal = detail?.case.status === "accepted" || detail?.case.status === "rejected";
  const isActiveMismatchPending = activeMismatch?.resolutionStatus === "pending";
  const pendingMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "pending"
  ).length;
  const acceptedMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "accepted"
  ).length;
  const rejectedMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "rejected"
  ).length;
  const pendingVisibleMismatchIds = useMemo(
    () =>
      visibleMismatches
        .filter((mismatch) => mismatch.resolutionStatus === "pending")
        .map((mismatch) => mismatch.id),
    [visibleMismatches]
  );
  const selectedPendingMismatchIds = pendingVisibleMismatchIds.filter((id) =>
    selectedMismatchIds.has(id)
  );

  useEffect(() => {
    setSelectedMismatchIds((current) => {
      const allowed = new Set(pendingVisibleMismatchIds);
      const next = new Set(Array.from(current).filter((id) => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [pendingVisibleMismatchIds]);

  useEffect(() => {
    if (!activeGroupKey) return;
    setExpandedGroupKeys((current) => {
      if (current.has(activeGroupKey)) return current;
      const next = new Set(current);
      next.add(activeGroupKey);
      return next;
    });
  }, [activeGroupKey]);

  function handleToggleGroup(groupKey: string) {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  function handleToggleSelectedMismatch(mismatchId: string) {
    setSelectedMismatchIds((current) => {
      const next = new Set(current);
      if (next.has(mismatchId)) {
        next.delete(mismatchId);
      } else {
        next.add(mismatchId);
      }
      return next;
    });
  }

  function handleSelectAllPending() {
    setSelectedMismatchIds(new Set(pendingVisibleMismatchIds));
  }

  function handleClearSelected() {
    setSelectedMismatchIds(new Set());
  }

  async function handleMismatchDecisionFor(mismatch: MismatchRecord, decision: MismatchDecision) {
    if (!detail) return;

    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      await updateCaseMismatchDecision(caseId, mismatch.id, decision);
      const refreshed = await fetchCaseDetail(caseId);
      setDetail(refreshed);
      setSelectedMismatchIds((current) => {
        const next = new Set(current);
        next.delete(mismatch.id);
        return next;
      });
      setDecisionStatus("idle");
    } catch (decisionFailure) {
      setDecisionError(
        decisionFailure instanceof Error
          ? decisionFailure.message
          : `Failed to ${decision === "accepted" ? "accept" : "reject"} issue.`
      );
      setDecisionStatus("error");
    }
  }

  async function handleMismatchDecision(decision: MismatchDecision) {
    if (!activeMismatch) return;
    await handleMismatchDecisionFor(activeMismatch, decision);
  }

  async function handleBulkMismatchDecision(decision: MismatchDecision) {
    if (!detail || selectedPendingMismatchIds.length === 0) return;

    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      await updateCaseMismatchDecisions(caseId, selectedPendingMismatchIds, decision);
      const refreshed = await fetchCaseDetail(caseId);
      setDetail(refreshed);
      setSelectedMismatchIds(new Set());
      setDecisionStatus("idle");
    } catch (decisionFailure) {
      setDecisionError(
        decisionFailure instanceof Error
          ? decisionFailure.message
          : `Failed to ${decision === "accepted" ? "accept" : "reject"} selected issues.`
      );
      setDecisionStatus("error");
    }
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col bg-slate-50 animate-in fade-in duration-500">

        {/* Header */}
        <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 shadow-sm">
          <div className="flex min-w-0 items-center gap-3 w-full">
            <Link
              href={`/cases/${caseId}`}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>

            <div className="flex min-w-0 flex-1 items-center gap-3">
              {status === "loading" ? (
                <Skeleton className="h-5 w-52 max-w-[55vw] bg-slate-100" />
              ) : (
                <h1 className="truncate text-lg font-medium tracking-tight text-slate-900">
                  {detail?.case.displayName}
                </h1>
              )}
              {detail && (
                <div className="hidden items-center gap-2 sm:flex shrink-0">
                  <Badge
                    variant="secondary"
                    className="bg-amber-100 text-amber-800 hover:bg-amber-100 border-transparent rounded-md px-2 py-0.5"
                  >
                    {visibleMismatches.length} Issue{visibleMismatches.length === 1 ? "" : "s"}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={`rounded-md px-2 py-0.5 ${detail.case.status === "accepted"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : detail.case.status === "rejected"
                          ? "border-rose-200 bg-rose-50 text-rose-700"
                          : "border-slate-200 bg-slate-50 text-slate-600"
                      }`}
                  >
                    {detail.case.status === "accepted"
                      ? "Case accepted"
                      : detail.case.status === "rejected"
                        ? "Case rejected"
                        : "Pending decision"}
                  </Badge>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Loading State */}
        {status === "loading" && (
          <MismatchReviewSkeleton />
        )}

        {/* Error State */}
        {status === "error" && (
          <div className="p-4 sm:p-8 flex-1">
            <div className="mx-auto flex max-w-2xl items-start gap-4 rounded-xl border border-red-200 bg-white p-6 shadow-sm">
              <ShieldAlert className="h-6 w-6 shrink-0 text-red-500" />
              <div>
                <h3 className="text-lg font-medium text-slate-900">Unable to load review</h3>
                <p className="mt-1 text-sm text-slate-500">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Main Content Layout */}
        {status === "ready" && detail && (
          <div className="flex flex-1 flex-col lg:flex-row min-h-0 overflow-hidden">

            {/* Grouped issue navigation */}
            <aside className="flex shrink-0 flex-col border-b border-slate-200 bg-white lg:w-[340px] lg:border-b-0 lg:border-r">

              {/* Desktop Only: Case Meta Summary */}
              <div className="hidden">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-sm font-medium text-slate-800">Case Summary</h2>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-medium text-slate-500">Receiver</p>
                    <p className="text-sm font-medium text-slate-900 truncate" title={detail.case.receiverName || "—"}>
                      {detail.case.receiverName || "—"}
                    </p>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-slate-500">Documents</p>
                      <p className="text-sm font-medium text-slate-900">{detail.documents.length}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-amber-600">Pending</p>
                      <p className="text-sm font-medium text-amber-700">{pendingMismatchCount}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-hidden bg-white">
                <div className="border-b border-slate-100 px-4 py-3 lg:px-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium text-slate-900">Review groups</h3>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {detail.documents.length} documents - {visibleMismatches.length} issues
                      </p>
                    </div>
                    <div className="text-right text-xs text-slate-500">
                      <div>Pending {pendingMismatchCount}</div>
                      <div>
                        Accepted {acceptedMismatchCount} - Rejected {rejectedMismatchCount}
                      </div>
                    </div>
                  </div>
                </div>

                {visibleMismatches.length === 0 ? (
                  <div className="p-5 text-sm text-slate-500">No conflicting values found.</div>
                ) : (
                  <div className="flex h-full gap-2 overflow-x-auto p-3 lg:block lg:space-y-1 lg:overflow-y-auto lg:p-4">
                    {mismatchGroups.map((group) => {
                      const isExpanded = expandedGroupKeys.has(group.key);
                      const isActiveGroup = activeGroupKey === group.key;

                      return (
                        <section key={group.key} className="min-w-[260px] shrink-0 lg:min-w-0">
                          <button
                            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                              isActiveGroup ? "bg-slate-100" : "hover:bg-slate-50"
                            }`}
                            onClick={() => handleToggleGroup(group.key)}
                            type="button"
                          >
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${
                                group.pending > 0 ? "bg-amber-500" : "bg-emerald-500"
                              }`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-slate-950">
                                {group.label}
                              </span>
                              <span className="mt-0.5 block text-xs text-slate-500">
                                {group.pending > 0 ? `${group.pending} to review` : "All matched"}
                              </span>
                            </span>
                            <span className="shrink-0 text-xs text-slate-500">
                              {group.mismatches.length}
                            </span>
                            <ChevronDown
                              className={`h-4 w-4 shrink-0 text-slate-400 transition ${
                                isExpanded ? "rotate-180" : ""
                              }`}
                            />
                          </button>

                          {isExpanded ? (
                            <div className="mt-1 space-y-1 pl-5">
                              {group.mismatches.map((mismatch) => {
                                const isActive = activeMismatchId === mismatch.id;
                                const isPending = mismatch.resolutionStatus === "pending";
                                const isSelected = selectedMismatchIds.has(mismatch.id);
                                const itemLabel = isLineItemMismatchField(mismatch.fieldName)
                                  ? getLineItemLabel(mismatch)
                                  : null;
                                const mismatchEvidence = buildMismatchEvidence(mismatch, documentLookup);
                                const issueLabel = getIssueDisplayTitle(mismatch, mismatchEvidence);
                                const issueDetail = getIssueListDetail(mismatch, mismatchEvidence);

                                return (
                                  <div
                                    key={mismatch.id}
                                    className={`flex items-center gap-2 rounded-lg px-2.5 py-2 transition ${
                                      isActive ? "bg-[#eef2ff]" : "hover:bg-slate-50"
                                    }`}
                                  >
                                    {isPending && !isCaseFinal ? (
                                      <input
                                        aria-label={`Select ${issueLabel}`}
                                        checked={isSelected}
                                        className="h-4 w-4 shrink-0 rounded border-slate-300 accent-emerald-600"
                                        onChange={(event) => {
                                          event.stopPropagation();
                                          handleToggleSelectedMismatch(mismatch.id);
                                        }}
                                        onClick={(event) => event.stopPropagation()}
                                        type="checkbox"
                                      />
                                    ) : (
                                      <span
                                        className={`h-2 w-2 shrink-0 rounded-full ${
                                          mismatch.resolutionStatus === "accepted"
                                            ? "bg-emerald-500"
                                            : "bg-rose-500"
                                        }`}
                                      />
                                    )}
                                    <button
                                      className="min-w-0 flex-1 text-left"
                                      onClick={() => setActiveMismatchId(mismatch.id)}
                                      type="button"
                                    >
                                      {itemLabel ? (
                                        <span className="block truncate text-xs text-slate-500">
                                          {itemLabel}
                                        </span>
                                      ) : null}
                                      <span className="block truncate text-sm font-medium text-slate-900">
                                        {issueLabel}
                                      </span>
                                      <span className="block truncate text-xs text-slate-500">
                                        {issueDetail}
                                      </span>
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                        </section>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>

            {/* Main Detail Content */}
            <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-4xl p-3 sm:p-4 lg:p-5">
                  {visibleMismatches.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-2xl bg-white border border-slate-200 p-12 text-center shadow-sm mt-8">
                      <div className="h-16 w-16 rounded-full bg-emerald-100 flex items-center justify-center mb-4">
                        <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                      </div>
                      <h2 className="text-2xl font-medium text-slate-900">All clear</h2>
                      <p className="mt-2 text-slate-500">
                        No value conflicts were found across the documents in this case.
                      </p>
                    </div>
                  ) : activeMismatch ? (
                    <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                      <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                              <span>{activeGroup?.label ?? "Review group"}</span>
                              <span className="text-slate-300">/</span>
                              <span>{activeIssueModeLabel}</span>
                              {activeDocumentSummary ? (
                                <>
                                  <span className="text-slate-300">/</span>
                                  <span>{activeDocumentSummary}</span>
                                </>
                              ) : null}
                              <span className="hidden">
                                {activeEvidence
                                  .map((evidence) => getEvidenceDocumentRole(evidence.document))
                                  .filter((value, index, values) => values.indexOf(value) === index)
                                  .join(" ↔ ") || "Documents involved"}
                              </span>
                            </div>
                            <h2 className="text-lg font-medium tracking-tight text-slate-950 sm:text-xl">
                              {activeIssueDisplayTitle}
                            </h2>
                          </div>
                          <Badge
                            variant="outline"
                            className={`w-fit rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${getMismatchResolutionClassName(activeMismatch.resolutionStatus)}`}
                          >
                            {getMismatchResolutionLabel(activeMismatch.resolutionStatus)}
                          </Badge>
                        </div>

                        {activeIssueHint ? (
                          <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700">
                            {activeIssueHint}
                          </div>
                        ) : null}
                      </div>

                      {activeIsSingleDocumentIssue ? (
                        <div className="space-y-3 p-4 sm:p-5">
                          <div className="rounded-lg border border-red-100 bg-red-50/70 p-3">
                            <div className="text-xs font-medium text-red-700">
                              {activeTaxValidationIssue ? "Tax check failed" : "Issue found"}
                            </div>
                            <div className="mt-1.5 text-sm leading-5 text-red-950">
                              {activeTaxValidationIssue
                                ? activeTaxValidationIssue.summary
                                : formatMismatchValue(
                                    activeMismatch.fieldName,
                                    activeEvidence[0]?.value,
                                    getEvidenceDocumentRole(activeEvidence[0]?.document)
                                  )}
                            </div>
                            {activeTaxValidationIssue ? (
                              <>
                                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                                  <div className="rounded-md bg-white/80 px-2.5 py-2">
                                    <div className="text-[10px] font-medium text-red-700/70">Taxable</div>
                                    <div className="mt-0.5 text-sm text-red-950">
                                      {formatTaxAmount(activeTaxValidationIssue.taxableAmount)}
                                    </div>
                                  </div>
                                  <div className="rounded-md bg-white/80 px-2.5 py-2">
                                    <div className="text-[10px] font-medium text-red-700/70">Expected tax</div>
                                    <div className="mt-0.5 text-sm text-red-950">
                                      {formatTaxAmount(activeTaxValidationIssue.expectedTax)}
                                    </div>
                                  </div>
                                  <div className="rounded-md bg-white/80 px-2.5 py-2">
                                    <div className="text-[10px] font-medium text-red-700/70">Extracted tax</div>
                                    <div className="mt-0.5 text-sm text-red-950">
                                      {formatTaxAmount(activeTaxValidationIssue.actualTax)}
                                    </div>
                                  </div>
                                  <div className="rounded-md bg-white/80 px-2.5 py-2">
                                    <div className="text-[10px] font-medium text-red-700/70">Difference</div>
                                    <div className="mt-0.5 text-sm text-red-950">
                                      {activeTaxValidationIssue.difference === null
                                        ? "-"
                                        : `${formatTaxAmount(Math.abs(activeTaxValidationIssue.difference))} ${
                                            activeTaxValidationIssue.difference < 0 ? "short" : "extra"
                                          }`}
                                    </div>
                                  </div>
                                </div>
                                {(activeTaxValidationIssue.rule || activeTaxValidationIssue.condition) && (
                                  <div className="mt-2 rounded-md bg-white/70 px-2.5 py-1.5 text-[11px] leading-4 text-red-900/80">
                                    {activeTaxValidationIssue.condition ? (
                                      <span>{activeTaxValidationIssue.condition}. </span>
                                    ) : null}
                                    {activeTaxValidationIssue.rule ? (
                                      <span>Expected rule: {activeTaxValidationIssue.rule}.</span>
                                    ) : null}
                                  </div>
                                )}
                              </>
                            ) : null}
                          </div>

                          <div className="grid gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm sm:grid-cols-2">
                            <div className="min-w-0">
                              <span className="mr-2 text-xs font-medium text-slate-500">Document</span>
                              <span className="text-slate-900">
                                {getEvidenceDocumentRole(activeEvidence[0]?.document)}
                              </span>
                            </div>
                            <div className="min-w-0">
                              <span className="mr-2 text-xs font-medium text-slate-500">Source</span>
                              <span
                                className="inline-block max-w-full truncate align-bottom text-slate-900"
                                title={getDocumentSourceLabel(activeEvidence[0]?.document)}
                              >
                                {getCompactSourceLabel(activeEvidence[0]?.document)}
                              </span>
                            </div>
                          </div>

                          {activeSingleIssueRows.length > 0 ? (
                            <div className="rounded-lg border border-slate-200 bg-white">
                              <div className="border-b border-slate-100 px-3 py-2 text-xs font-medium text-slate-500">
                                Useful context
                              </div>
                              <div className="divide-y divide-slate-100">
                                {activeSingleIssueRows.map((row) => (
                                  <div key={row.key} className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-[180px_1fr]">
                                    <div className="text-slate-500">{row.label}</div>
                                    <div className="text-slate-900">{displayValue(row.value)}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="overflow-x-auto p-5 sm:p-6">
                          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                            <thead>
                              <tr className="border-b border-slate-200 text-xs font-medium tracking-wide text-slate-500">
                                <th className="w-44 px-3 py-3">Field</th>
                                {activeEvidence.map((evidence) => (
                                  <th key={evidence.key} className="px-3 py-3">
                                    <div className="max-w-[220px] truncate">
                                      {getEvidenceDocumentRole(evidence.document)}
                                    </div>
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              <tr className="border-b border-red-100 bg-red-50/70">
                                <td className="border-l-4 border-red-500 px-3 py-3 font-medium text-slate-700">
                                  {activeFieldLabel}
                                </td>
                                {activeEvidence.map((evidence) => (
                                  <td key={evidence.key} className="px-3 py-3 font-medium text-red-900">
                                    {formatMismatchValue(
                                      activeMismatch.fieldName,
                                      evidence.value,
                                      getEvidenceDocumentRole(evidence.document)
                                    )}
                                    <div className="mt-1 max-w-[220px] truncate text-xs font-normal text-red-700/70">
                                      {getDocumentSourceLabel(evidence.document)}
                                    </div>
                                  </td>
                                ))}
                              </tr>
                              {uniqueStrings(
                                activeEvidence.flatMap((evidence) =>
                                  evidence.contextRows
                                    .filter((row) => !row.emphasis && row.key !== activeMismatch.fieldName)
                                    .map((row) => row.key)
                                )
                              )
                                .slice(0, 5)
                                .map((contextKey) => {
                                  const label =
                                    activeEvidence
                                      .flatMap((evidence) => evidence.contextRows)
                                      .find((row) => row.key === contextKey)?.label ?? getFieldLabel(contextKey);

                                  return (
                                    <tr key={contextKey} className="border-b border-slate-100">
                                      <td className="px-3 py-3 font-medium text-slate-600">{label}</td>
                                      {activeEvidence.map((evidence) => {
                                        const row = evidence.contextRows.find((entry) => entry.key === contextKey);
                                        return (
                                          <td key={`${evidence.key}-${contextKey}`} className="px-3 py-3 text-slate-800">
                                            {row ? displayValue(row.value) : <span className="text-slate-300">-</span>}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      <div className="border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500 sm:px-5">
                        Deciding: <span className="font-medium text-slate-800">{activeIssueDisplayTitle}</span>
                      </div>
                    </article>
                  ) : (
                    <div className="flex h-[400px] items-center justify-center text-center text-sm text-slate-500">
                      Select an issue from the list to review conflicting values.
                    </div>
                  )}
                </div>
              </div>

              {visibleMismatches.length > 0 && activeMismatch && (
                <footer className="z-20 shrink-0 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur sm:px-6 lg:px-8">
                  <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
	                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
	                        <span>
	                          Pending <span className="font-medium text-slate-800">{pendingMismatchCount}</span>
                        </span>
                        <span>
                          Accepted <span className="font-medium text-emerald-700">{acceptedMismatchCount}</span>
                        </span>
	                        <span>
	                          Rejected <span className="font-medium text-rose-700">{rejectedMismatchCount}</span>
	                        </span>
	                        <span>
	                          Selected <span className="font-medium text-slate-800">{selectedPendingMismatchIds.length}</span>
	                        </span>
	                      </div>
                      {decisionStatus === "error" && decisionError && (
                        <div className="mt-1 text-xs font-medium text-rose-700">{decisionError}</div>
                      )}
                      {detail.case.status === "accepted" && (
                        <div className="mt-1 text-xs font-medium text-emerald-700">
                          All issues are accepted. This case has been accepted automatically.
                        </div>
                      )}
                      {!isActiveMismatchPending && (
                        <div
                          className={`mt-1 text-xs font-medium ${activeMismatch.resolutionStatus === "accepted" ? "text-emerald-700" : "text-rose-700"}`}
                        >
                          {activeMismatch.resolutionStatus === "accepted"
                            ? "This issue is accepted."
                            : "This issue is rejected."}
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                      {selectedPendingMismatchIds.length > 0 && !isCaseFinal ? (
                        <>
                          <Button
                            className="border-slate-200 text-slate-600 hover:bg-slate-50"
                            disabled={decisionStatus === "updating"}
                            onClick={handleClearSelected}
                            variant="outline"
                          >
                            Clear
                          </Button>
                          <Button
                            variant="outline"
                            className="border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                            disabled={decisionStatus === "updating"}
                            onClick={() => {
                              void handleBulkMismatchDecision("rejected");
                            }}
                          >
                            {decisionStatus === "updating" ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <X className="mr-2 h-4 w-4" />
                            )}
                            Reject Selected
                          </Button>
                          <Button
                            className="bg-emerald-600 text-white hover:bg-emerald-700"
                            disabled={decisionStatus === "updating"}
                            onClick={() => {
                              void handleBulkMismatchDecision("accepted");
                            }}
                          >
                            {decisionStatus === "updating" ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="mr-2 h-4 w-4" />
                            )}
                            Accept Selected
                          </Button>
                        </>
                      ) : isActiveMismatchPending && !isCaseFinal ? (
	                        <>
                          <Button
                            className="border-slate-200 text-slate-600 hover:bg-slate-50"
                            disabled={decisionStatus === "updating" || pendingVisibleMismatchIds.length === 0}
                            onClick={handleSelectAllPending}
                            variant="outline"
                          >
                            Select all
                          </Button>
	                          <Button
                            variant="outline"
                            className="border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                            disabled={decisionStatus === "updating"}
                            onClick={() => handleMismatchDecision("rejected")}
                          >
                            {decisionStatus === "updating" ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <X className="mr-2 h-4 w-4" />
                            )}
                            Reject Issue
                          </Button>
                          <Button
                            className="bg-emerald-600 text-white hover:bg-emerald-700"
                            disabled={decisionStatus === "updating"}
                            onClick={() => handleMismatchDecision("accepted")}
                          >
                            {decisionStatus === "updating" ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="mr-2 h-4 w-4" />
                            )}
                            Accept Issue
                          </Button>
                        </>
                      ) : (
                        <Badge
                          variant="outline"
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ${getMismatchResolutionClassName(activeMismatch.resolutionStatus)}`}
                        >
                          {getMismatchResolutionLabel(activeMismatch.resolutionStatus)}
                        </Badge>
                      )}
                    </div>
                  </div>
                </footer>
              )}
            </main>
          </div>
        )}
      </div>
    </AppShell>
  );
}
