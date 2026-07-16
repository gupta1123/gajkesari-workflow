"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  Folder,
  Loader2,
  Plus,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  Database,
  Check,
  X,
  FileSearch,
  Play,
  ZoomIn,
  ZoomOut,
  RotateCw,
  type LucideIcon,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { AnalysisOptionsDialog } from "@/components/workspace/AnalysisOptionsDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getComparisonModeLabel,
  isPrimaryComparisonField,
  readComparisonOptions,
} from "@/lib/comparison";
import {
  ACTIVE_FIELD_DEFINITIONS,
  getFieldDefinitionsByKeys,
  getFieldDefinitionsForDocType,
  shouldConsiderFieldKey,
} from "@/lib/document-schema";
import { isLineItemMismatchField } from "@/lib/line-items";
import {
  appendCaseFiles,
  enqueueCaseAnalysis,
  fetchCaseAnalysisStatus,
  fetchCaseDetail,
  fetchCaseFileSignedUrl,
  updateCaseDecision,
  type CaseDecision,
  type SavedCaseDetail,
} from "@/lib/case-persistence";
import { readUploadGroupMeta } from "@/lib/upload-groups";
import type {
  CaseAnalysisMode,
  CommercialLineItem,
  ComparisonOptions,
  PipelineStageProgress,
  QueuedUpload,
} from "@/types/pipeline";

type LoadState = "loading" | "ready" | "error";
type ActiveTab = "preview" | "data";
type DataViewMode = "fields" | "lineItems";
const PURCHASE_ORDER_DOCUMENT_TYPES = new Set(["Purchase Order", "Amended Purchase Order"]);
const TERMS_CHECKLIST_DEFINITIONS = [
  { key: "paymentTerms", label: "Payment", keywords: ["payment", "advance", "proforma"] },
  { key: "deliveryTerms", label: "Delivery", keywords: ["delivery", "dispatch", "delivered", "schedule"] },
  { key: "freightTerms", label: "Freight", keywords: ["freight", "transport", "godown"] },
  { key: "packingForwardingTerms", label: "Packing / Forwarding", keywords: ["packing", "forwarding", "p&f"] },
  { key: "priceBasis", label: "Price Basis", keywords: ["price", "late", "fee", "basis"] },
  { key: "taxTerms", label: "Tax / GST", keywords: ["tax", "gst", "eway", "e-way"] },
  { key: "inspectionTerms", label: "Inspection / Quality", keywords: ["inspection", "test", "certificate", "quality"] },
  { key: "warrantyTerms", label: "Warranty", keywords: ["warranty", "guarantee"] },
  { key: "termsAndConditions", label: "Other Terms", keywords: ["terms", "conditions", "clause"] },
] as const;
const TERMS_FIELD_KEYS = TERMS_CHECKLIST_DEFINITIONS.map((item) => item.key);
const TERMS_FIELD_KEY_SET = new Set<string>(TERMS_FIELD_KEYS);

const DETAIL_TABS: { id: ActiveTab; label: string; icon: LucideIcon }[] = [
  { id: "preview", label: "Original", icon: Eye },
  { id: "data", label: "Data", icon: Database },
];

const FIELD_LABEL_LOOKUP = ACTIVE_FIELD_DEFINITIONS.reduce(
  (acc, field) => {
    acc[field.key] = field.label;
    return acc;
  },
  {} as Record<string, string>
);
const TERMS_COMPLIANCE_FIELD = "termsAndConditions";

type TermsComplianceChecklistItem = {
  sourceDocId: string;
  sourceClause: string;
  obligation: string;
  category: string;
  status: "fulfilled" | "not_fulfilled" | "unknown" | "not_applicable";
  evidenceDocIds: string[];
  evidence: string;
  reason: string;
  severity: "high" | "medium" | "low" | "none";
};

type CaseDetailDocument = SavedCaseDetail["documents"][number];

type SplitSiblingCase = {
  id: string;
  displayName: string;
  groupIndex: number;
};

type SplitAnalysisMeta = {
  groupCount: number;
  groupIndex: number;
  sourceCaseId: string;
  sourceFileNames: string[];
  groupId: string;
  siblingCases: SplitSiblingCase[];
  note: string;
};

type SellerChainRoleSelectionMeta = {
  primaryDocumentIds: string[];
  contextDocumentIds: string[];
  note: string;
};

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function readSplitAnalysisMeta(processingMeta: unknown): SplitAnalysisMeta | null {
  if (!processingMeta || typeof processingMeta !== "object" || Array.isArray(processingMeta)) {
    return null;
  }

  const raw = (processingMeta as Record<string, unknown>).splitAnalysis;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const groupCount = Number(record.groupCount);
  const groupIndex = Number(record.groupIndex);
  const sourceCaseId = String(record.sourceCaseId ?? "").trim();
  const groupId = String(record.groupId ?? "").trim();
  const note = String(record.note ?? "").trim();
  if (!Number.isFinite(groupCount) || groupCount < 2 || !Number.isFinite(groupIndex) || groupIndex < 1) {
    return null;
  }

  const siblingCases = Array.isArray(record.siblingCases)
    ? record.siblingCases.flatMap((entry): SplitSiblingCase[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const sibling = entry as Record<string, unknown>;
        const id = String(sibling.id ?? "").trim();
        const displayName = String(sibling.displayName ?? "").trim();
        const siblingGroupIndex = Number(sibling.groupIndex);
        if (!id || !displayName || !Number.isFinite(siblingGroupIndex)) return [];
        return [{ id, displayName, groupIndex: siblingGroupIndex }];
      })
    : [];

  return {
    groupCount,
    groupIndex,
    sourceCaseId,
    sourceFileNames: readStringArray(record.sourceFileNames),
    groupId,
    siblingCases,
    note: note || `This uploaded file was split into ${groupCount} separate cases during analysis.`,
  };
}

function readSellerChainRoleSelectionMeta(processingMeta: unknown): SellerChainRoleSelectionMeta | null {
  if (!processingMeta || typeof processingMeta !== "object" || Array.isArray(processingMeta)) {
    return null;
  }

  const rawGroups = (processingMeta as Record<string, unknown>).verificationGroups;
  if (!Array.isArray(rawGroups)) return null;

  for (const group of rawGroups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const roleSelection = (group as Record<string, unknown>).roleSelection;
    if (!roleSelection || typeof roleSelection !== "object" || Array.isArray(roleSelection)) continue;

    const record = roleSelection as Record<string, unknown>;
    if (record.strategy !== "seller_chain") continue;

    const primaryDocumentIds = readStringArray(record.primaryDocumentIds);
    const contextDocumentIds = readStringArray(record.contextDocumentIds);
    if (!primaryDocumentIds.length || !contextDocumentIds.length) continue;

    return {
      primaryDocumentIds,
      contextDocumentIds,
      note:
        String(record.note ?? "").trim() ||
        "Seller-chain role selection applied: Gajkesari-facing invoice was reconciled; upstream seller invoices were kept as context.",
    };
  }

  return null;
}

function readTermsComplianceChecklist(processingMeta: unknown): TermsComplianceChecklistItem[] {
  if (!processingMeta || typeof processingMeta !== "object" || Array.isArray(processingMeta)) {
    return [];
  }

  const raw = (processingMeta as Record<string, unknown>).termsComplianceChecklist;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const sourceDocId = String(record.sourceDocId ?? "").trim();
    const sourceClause = String(record.sourceClause ?? "").trim();
    const obligation = String(record.obligation ?? "").trim();
    const status = String(record.status ?? "").trim() as TermsComplianceChecklistItem["status"];
    if (!sourceDocId || !sourceClause || !obligation) return [];
    if (!["fulfilled", "not_fulfilled", "unknown", "not_applicable"].includes(status)) return [];

    return [
      {
        sourceDocId,
        sourceClause,
        obligation,
        category: String(record.category ?? "Terms compliance").trim() || "Terms compliance",
        status,
        evidenceDocIds: Array.isArray(record.evidenceDocIds)
          ? record.evidenceDocIds.map((value) => String(value ?? "").trim()).filter(Boolean)
          : [],
        evidence: String(record.evidence ?? "").trim(),
        reason: String(record.reason ?? "").trim(),
        severity: String(record.severity ?? "none").trim() as TermsComplianceChecklistItem["severity"],
      },
    ];
  });
}

function getDocumentFieldLabel(documentType: string | undefined, key: string) {
  if (documentType === "E-Way Bill" && key === "subtotal") {
    return "Total Taxable Amount";
  }

  return FIELD_LABEL_LOOKUP[key] || key;
}

function hasExtractedTerms(document: SavedCaseDetail["documents"][number] | null) {
  if (!document || !PURCHASE_ORDER_DOCUMENT_TYPES.has(document.documentType)) {
    return false;
  }

  return TERMS_FIELD_KEYS.some((key) => {
    const value = document.extractedFields[key];
    return value !== null && value !== undefined && String(value).trim().length > 0;
  });
}

function getTermValue(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function isNonRequiredDocumentField(documentType: string, key: string) {
  return PURCHASE_ORDER_DOCUMENT_TYPES.has(documentType) && key === "hasVendorStamp";
}

function getTermsIssueText(mismatch: SavedCaseDetail["mismatches"][number]) {
  return [
    mismatch.analysis ?? "",
    mismatch.fixPlan ?? "",
    ...mismatch.values.map((entry) => String(entry.value ?? "")),
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function termsIssueMatchesDocument(
  mismatch: SavedCaseDetail["mismatches"][number],
  document: SavedCaseDetail["documents"][number] | null
) {
  if (!document || mismatch.fieldName !== TERMS_COMPLIANCE_FIELD) return false;
  const documentIds = new Set(
    [document.id, document.clientDocumentId, document.sourceHint, document.title]
      .filter((value): value is string => Boolean(value))
  );
  return mismatch.values.some((entry) => entry.docId && documentIds.has(entry.docId));
}

function termsIssueMatchesDefinition(
  mismatch: SavedCaseDetail["mismatches"][number],
  definition: (typeof TERMS_CHECKLIST_DEFINITIONS)[number],
  value: string
) {
  const issueText = getTermsIssueText(mismatch).toLowerCase();
  if (definition.key === "termsAndConditions") return false;
  if (definition.keywords.some((keyword) => issueText.includes(keyword))) return true;

  const usefulWords = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 5)
    .slice(0, 8);
  if (usefulWords.length < 2) return false;

  return usefulWords.filter((word) => issueText.includes(word)).length >= 2;
}

function getTermsIssueStatus(mismatch: SavedCaseDetail["mismatches"][number]) {
  const text = getTermsIssueText(mismatch).toLowerCase();
  if (text.includes("not fulfilled")) {
    return {
      label: "Not fulfilled",
      className: "border-rose-200 bg-rose-50 text-rose-700",
      icon: ShieldAlert,
    };
  }

  return {
    label: "Needs review",
    className: "border-amber-200 bg-amber-50 text-amber-700",
    icon: TriangleAlert,
  };
}

function getClearTermsStatus() {
  return {
    label: "No issue flagged",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  };
}

function getChecklistStatus(status: TermsComplianceChecklistItem["status"]) {
  if (status === "not_fulfilled") {
    return {
      label: "Not fulfilled",
      className: "border-rose-200 bg-rose-50 text-rose-700",
      icon: ShieldAlert,
    };
  }

  if (status === "unknown") {
    return {
      label: "Needs review",
      className: "border-amber-200 bg-amber-50 text-amber-700",
      icon: TriangleAlert,
    };
  }

  if (status === "not_applicable") {
    return {
      label: "Not applicable",
      className: "border-slate-200 bg-slate-50 text-slate-600",
      icon: Check,
    };
  }

  return {
    label: "Fulfilled",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  };
}

const LINE_ITEM_COLUMNS: Array<{
  key: keyof CommercialLineItem;
  label: string;
  className?: string;
}> = [
  { key: "lineNumber", label: "#", className: "w-12" },
  { key: "itemCode", label: "Item Code", className: "min-w-32" },
  { key: "description", label: "Description", className: "min-w-60" },
  { key: "hsnSac", label: "HSN/SAC", className: "min-w-24" },
  { key: "quantity", label: "Qty", className: "min-w-20 text-right" },
  { key: "unit", label: "Unit", className: "min-w-16" },
  { key: "rate", label: "Rate", className: "min-w-24 text-right" },
  { key: "taxableAmount", label: "Taxable", className: "min-w-28 text-right" },
  { key: "taxRate", label: "GST %", className: "min-w-20 text-right" },
  { key: "cgstRate", label: "CGST %", className: "min-w-20 text-right" },
  { key: "sgstRate", label: "SGST %", className: "min-w-20 text-right" },
  { key: "igstRate", label: "IGST %", className: "min-w-20 text-right" },
  { key: "taxAmount", label: "Tax", className: "min-w-24 text-right" },
  { key: "lineTotal", label: "Total", className: "min-w-28 text-right" },
];

const DRAFT_STAGE_SEQUENCE: PipelineStageProgress["stage"][] = [
  "upload_received",
  "classifying",
  "ocr",
  "extracting",
  "validating",
  "complete",
];

function buildDraftStages(): PipelineStageProgress[] {
  return DRAFT_STAGE_SEQUENCE.map((stage, index) => ({
    stage,
    status: index === 0 ? "active" : "pending",
    startedAt: index === 0 ? Date.now() : undefined,
  }));
}

function buildDraftUploads(files: File[]): QueuedUpload[] {
  return files.map((file, index) => ({
    id: `${file.name}-${Date.now()}-${index}`,
    name: file.name,
    file,
    files: [file],
    source: "file",
    stages: buildDraftStages(),
  }));
}

function getOrderedDocumentEntries(
  documentType: string,
  extractedFields: Record<string, unknown>
) {
  const visibleEntries = Object.entries(extractedFields).filter(
    ([key, value]) =>
      !isNonRequiredDocumentField(documentType, key) &&
      !(documentType === "E-Way Bill" && key === "subtotal" && extractedFields.totalTaxableAmount) &&
      value !== null &&
      value !== undefined &&
      value !== ""
  );
  const relevantDefinitions = getFieldDefinitionsForDocType(documentType);
  const relevantKeys = relevantDefinitions.map(({ key }) => key);
  const relevantKeySet = new Set(relevantKeys);
  const remainingKeys = visibleEntries
    .map(([key]) => key)
    .filter((key) => !relevantKeySet.has(key as (typeof relevantKeys)[number]));

  return getFieldDefinitionsByKeys([...relevantKeys, ...remainingKeys]).flatMap(({ key }) => {
    const value = extractedFields[key];
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      (documentType === "E-Way Bill" && key === "subtotal" && extractedFields.totalTaxableAmount)
    ) {
      return [];
    }
    return [[key, value] as [string, unknown]];
  });
}

function getCompactDocumentType(documentType: string) {
  if (/purchase order/i.test(documentType)) return "PO";
  if (/tax invoice|invoice/i.test(documentType)) return "Invoice";
  if (/e-?way/i.test(documentType)) return "E-Way";
  return documentType.replace(/\s+document$/i, "");
}

function getPacketDocumentLabels(documents: SavedCaseDetail["documents"]) {
  const labels = documents.map((document) => getCompactDocumentType(document.documentType || "Document"));
  return Array.from(new Set(labels));
}

function getMissingPacketDocumentLabels(documents: SavedCaseDetail["documents"]) {
  const documentTypes = documents.map((document) => document.documentType.toLowerCase());
  const hasPo = documentTypes.some((type) => type.includes("purchase order"));
  const hasInvoice = documentTypes.some((type) => type.includes("invoice"));
  const hasEWay = documentTypes.some((type) => type.includes("e-way") || type.includes("eway"));

  return [
    !hasPo ? "PO" : "",
    !hasInvoice ? "Invoice" : "",
    !hasEWay ? "E-Way" : "",
  ].filter(Boolean);
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeInvoiceCopyValue(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function getStringField(document: CaseDetailDocument, key: string) {
  const value = document.extractedFields[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function isInvoiceDocument(document: CaseDetailDocument) {
  return /^(?:tax\s+)?invoice$/i.test(document.documentType.trim());
}

function getInvoiceDisplayIdentity(document: CaseDetailDocument) {
  return normalizeInvoiceCopyValue(
    getStringField(document, "invoiceNumber") ||
      getStringField(document, "referenceInvoiceNumber")
  );
}

function parseInvoiceAmount(value: unknown) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function getInvoiceAmount(document: CaseDetailDocument) {
  return (
    parseInvoiceAmount(getStringField(document, "totalAmount")) ??
    parseInvoiceAmount(getStringField(document, "totalTaxableAmount")) ??
    parseInvoiceAmount(getStringField(document, "subtotal"))
  );
}

function invoiceAmountsMatch(left: CaseDetailDocument, right: CaseDetailDocument) {
  const leftAmount = getInvoiceAmount(left);
  const rightAmount = getInvoiceAmount(right);
  if (leftAmount === null || rightAmount === null) return false;
  return Math.abs(leftAmount - rightAmount) <= Math.max(1, Math.abs(rightAmount) * 0.001);
}

function normalizedInvoiceField(document: CaseDetailDocument, field: string) {
  return normalizeInvoiceCopyValue(getStringField(document, field));
}

function invoicePartyNameMatches(left: string, right: string) {
  return Boolean(
    left &&
      right &&
      left.length >= 5 &&
      right.length >= 5 &&
      (left === right || left.includes(right) || right.includes(left))
  );
}

function invoicePartySideMatches(
  left: CaseDetailDocument,
  right: CaseDetailDocument,
  gstinField: string,
  nameField: string
) {
  const leftGstin = normalizedInvoiceField(left, gstinField);
  const rightGstin = normalizedInvoiceField(right, gstinField);
  if (leftGstin && rightGstin) return leftGstin === rightGstin;

  const leftName = normalizedInvoiceField(left, nameField);
  const rightName = normalizedInvoiceField(right, nameField);
  if (leftName && rightName) return invoicePartyNameMatches(leftName, rightName);

  return null;
}

function hasInvoicePartySideEvidence(document: CaseDetailDocument, gstinField: string, nameField: string) {
  return Boolean(normalizedInvoiceField(document, gstinField) || normalizedInvoiceField(document, nameField));
}

function invoicePartiesCompatible(left: CaseDetailDocument, right: CaseDetailDocument) {
  const supplierMatch = invoicePartySideMatches(left, right, "supplierGstin", "vendorName");
  if (supplierMatch === false) return false;

  const buyerMatch = invoicePartySideMatches(left, right, "buyerGstin", "buyerName");
  if (buyerMatch === false) return false;

  const hasSupplierEvidence =
    hasInvoicePartySideEvidence(left, "supplierGstin", "vendorName") ||
    hasInvoicePartySideEvidence(right, "supplierGstin", "vendorName");
  if (hasSupplierEvidence) return supplierMatch === true;

  return buyerMatch === true;
}

function areDuplicateInvoiceDisplayCopies(left: CaseDetailDocument, right: CaseDetailDocument) {
  if (!isInvoiceDocument(left) || !isInvoiceDocument(right)) return false;
  const leftInvoice = getInvoiceDisplayIdentity(left);
  const rightInvoice = getInvoiceDisplayIdentity(right);
  if (!leftInvoice || !rightInvoice || leftInvoice !== rightInvoice) return false;

  return invoiceAmountsMatch(left, right) && invoicePartiesCompatible(left, right);
}

function invoiceDisplayText(document: CaseDetailDocument) {
  return [document.title, document.sourceHint, document.sourceFileName, document.markdown]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getInvoiceCopyPreferenceRank(document: CaseDetailDocument) {
  const text = invoiceDisplayText(document);
  if (/\b(?:original|main)\s+copy\b|\b(?:original|main)\b/.test(text)) return 0;
  if (/\b(?:duplicate|extra|copy)\b/.test(text)) return 2;
  return 1;
}

function getInvoiceDisplayCompletenessScore(document: CaseDetailDocument) {
  const fieldScore = Object.values(document.extractedFields).filter((value) => {
    if (value === null || value === undefined) return false;
    return String(value).trim().length > 0;
  }).length;
  const lineScore = (document.lineItems?.length ?? 0) * 5;
  const textScore = Math.min(8, Math.floor((document.markdown?.trim().length ?? 0) / 500));
  return fieldScore + lineScore + textScore;
}

function shouldPreferInvoiceDisplayCopy(candidate: CaseDetailDocument, current: CaseDetailDocument) {
  const candidateRank = getInvoiceCopyPreferenceRank(candidate);
  const currentRank = getInvoiceCopyPreferenceRank(current);
  if (candidateRank !== currentRank) return candidateRank < currentRank;

  const candidateScore = getInvoiceDisplayCompletenessScore(candidate);
  const currentScore = getInvoiceDisplayCompletenessScore(current);
  return candidateScore > currentScore;
}

function getDisplayDocuments(documents: CaseDetailDocument[]) {
  const displayDocuments: CaseDetailDocument[] = [];

  for (const document of documents) {
    if (!isInvoiceDocument(document)) {
      displayDocuments.push(document);
      continue;
    }

    const existingIndex = displayDocuments.findIndex((candidate) =>
      areDuplicateInvoiceDisplayCopies(candidate, document)
    );
    if (existingIndex === -1) {
      displayDocuments.push(document);
      continue;
    }

    if (shouldPreferInvoiceDisplayCopy(document, displayDocuments[existingIndex])) {
      displayDocuments[existingIndex] = document;
    }
  }

  return displayDocuments;
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function getDocumentIndexDetails(document: SavedCaseDetail["documents"][number]) {
  const type = document.documentType || "Document";
  const sourcePage = getDocumentSourcePage(document);
  const fileName =
    document.sourceFileName ||
    document.sourceHint?.replace(/^pages?\s+\d+\s*[-:]\s*/i, "").trim() ||
    document.title ||
    "Source file";

  return {
    type,
    fileName,
    pageLabel: `Page ${sourcePage}`,
  };
}

function parseDisplayNumber(value: unknown) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDisplayNumber(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function formatPercentDisplay(value: unknown) {
  const parsed = parseDisplayNumber(value);
  if (parsed === null) return "";
  return `${formatDisplayNumber(parsed)}%`;
}

function getLineItemValue(item: CommercialLineItem, key: keyof CommercialLineItem) {
  if (key === "rate") {
    return item.netRate || item.rate || "";
  }
  if (key === "taxAmount") {
    if (item.taxAmount) return item.taxAmount;
    if (item.igstAmount) return item.igstAmount;
    const cgstAmount = parseDisplayNumber(item.cgstAmount);
    const sgstAmount = parseDisplayNumber(item.sgstAmount);
    if (cgstAmount !== null && sgstAmount !== null) {
      return formatDisplayNumber(cgstAmount + sgstAmount);
    }
    return item.cgstAmount || item.sgstAmount || "";
  }
  if (key === "taxRate" || key === "cgstRate" || key === "sgstRate" || key === "igstRate") {
    return formatPercentDisplay(item[key]);
  }
  return item[key] ?? "";
}

function getVisibleLineItemColumns(lineItems: CommercialLineItem[]) {
  return LINE_ITEM_COLUMNS.filter(
    (column) =>
      column.key === "lineNumber" ||
      column.key === "description" ||
      lineItems.some((item) => String(getLineItemValue(item, column.key)).trim().length > 0)
  );
}

function getSourceFileLabel(mimeType?: string | null, sourceName?: string | null) {
  if (mimeType?.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "PDF";
  if (sourceName && /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(sourceName)) return "Image";
  if (sourceName && /\.pdf$/i.test(sourceName)) return "PDF";
  return "File";
}

function isImageSourceFile(mimeType?: string | null, sourceName?: string | null) {
  if (mimeType?.startsWith("image/")) return true;
  if (sourceName && /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(sourceName)) return true;
  return false;
}

function getDocumentSourcePage(document?: SavedCaseDetail["documents"][number] | null) {
  const sourceText = [document?.sourceHint, document?.sourceFileName, document?.title]
    .filter(Boolean)
    .join(" ");
  const match = sourceText.match(/\bpages?\s+(\d+)/i);
  if (!match) return 1;
  const page = Number(match[1]);
  return Number.isFinite(page) && page > 0 ? Math.round(page) : 1;
}

function getCaseStatusLabel(status: string) {
  if (status === "draft") return "Draft";
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  if (status === "failed") return "Failed";
  if (status === "processing") return "Processing";
  if (status === "completed") return "Pending decision";
  return "Pending";
}

function getCaseStatusClassName(status: string) {
  if (status === "draft") return "bg-slate-100 text-slate-700 border-slate-200";
  if (status === "accepted") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "rejected") return "bg-rose-50 text-rose-700 border-rose-200";
  if (status === "failed") return "bg-red-50 text-red-700 border-red-200";
  if (status === "processing") return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-slate-50 text-slate-600 border-slate-200";
}

function getFriendlyAnalysisStage(stage: string | null, status: "idle" | "processing" | "error") {
  if (status === "error") {
    return "Analysis failed";
  }

  const normalized = (stage ?? "").trim().toLowerCase();
  if (!normalized) {
    return "Analyzing documents...";
  }
  if (normalized.includes("retry")) {
    return "Retrying analysis...";
  }
  if (normalized.includes("queue")) {
    return "Preparing analysis...";
  }
  if (/\b(file|pdf|document)\s+\d+\s+of\s+\d+\b/.test(normalized)) {
    return stage;
  }
  if (normalized.includes("split") || normalized.includes("organizing")) {
    return "Organizing PDF documents...";
  }
  if (normalized.includes("extract")) {
    return "Extracting fields...";
  }
  if (normalized.includes("compar")) {
    return "Comparing documents...";
  }
  if (normalized.includes("validat")) {
    return "Validating results...";
  }
  if (normalized.includes("final") || normalized.includes("complete")) {
    return "Finalizing results...";
  }
  return stage;
}

function CaseDetailSkeleton() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-1 flex-col overflow-hidden bg-[#fafafa] tracking-normal">
      <header className="flex h-14 sm:h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
          <Skeleton className="h-8 w-8 shrink-0 rounded-lg bg-slate-100" />
          <div className="h-6 w-px shrink-0 bg-slate-200" />
          <Skeleton className="h-4 w-44 max-w-[45vw] bg-slate-100" />
        </div>
        <Skeleton className="hidden h-7 w-24 rounded-full bg-slate-100 md:block" />
        <Skeleton className="h-5 w-16 rounded-full bg-slate-100 md:hidden" />
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="hidden w-80 shrink-0 flex-col border-r border-slate-200 bg-[#fafafa] lg:w-[24rem] md:flex">
          <div className="p-6 space-y-6">
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="space-y-3 bg-slate-50 p-5">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-7 w-7 rounded-full bg-slate-200/70" />
                  <Skeleton className="h-4 w-36 bg-slate-200/70" />
                </div>
                <Skeleton className="h-3.5 w-full bg-slate-200/70" />
                <Skeleton className="h-3.5 w-4/5 bg-slate-200/70" />
              </div>
              <div className="grid grid-cols-2 gap-4 border-t border-slate-100 p-5">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="space-y-2">
                    <Skeleton className="h-3 w-16 bg-slate-100" />
                    <Skeleton className="h-4 w-24 bg-slate-100" />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between px-1">
                <Skeleton className="h-3 w-36 bg-slate-200/70" />
                <Skeleton className="h-5 w-8 rounded-full bg-slate-200/70" />
              </div>
              <div className="space-y-1.5">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="flex items-center gap-3 rounded-xl border border-transparent px-3 py-3">
                    <Skeleton className="h-8 w-8 shrink-0 rounded-lg bg-slate-100" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-4/5 bg-slate-100" />
                      <Skeleton className="h-3 w-1/2 bg-slate-100" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <main className="flex flex-1 min-w-0 flex-col bg-[#fafafa] px-2.5 pb-0 pt-2.5 sm:p-4 md:p-6 lg:p-8">
          <div className="mb-3 rounded-xl border border-[#e5ddd0] bg-white p-1.5 shadow-sm md:hidden">
            <div className="flex gap-2 overflow-hidden">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-12 min-w-[130px] rounded-lg bg-[#f0ece6]" />
              ))}
            </div>
          </div>

          <div className="flex flex-1 flex-col overflow-hidden bg-white shadow-sm sm:rounded-2xl sm:border sm:border-slate-200">
            <div className="flex flex-col justify-between gap-3 border-b border-slate-100 bg-white p-2 sm:flex-row sm:items-center sm:p-4">
              <div className="hidden items-center gap-3 sm:flex">
                <Skeleton className="h-5 w-5 rounded bg-slate-100" />
                <Skeleton className="h-4 w-28 bg-slate-100" />
                <Skeleton className="h-5 w-14 rounded-full bg-slate-100" />
              </div>
              <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
                <div className="flex w-full items-center rounded-xl border border-[#e5ddd0] bg-[#f0ece6] p-1.5 sm:w-auto">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={index} className="mx-1 h-8 flex-1 rounded-lg bg-white/70 sm:w-20" />
                  ))}
                </div>
              </div>
            </div>

            <div className="relative flex-1 bg-[#525659] p-4">
              <div className="mx-auto h-full max-w-3xl rounded-lg bg-white p-6 shadow-2xl">
                <div className="space-y-4">
                  <Skeleton className="h-7 w-3/4 bg-slate-100" />
                  <Skeleton className="h-4 w-1/2 bg-slate-100" />
                  <div className="space-y-3 pt-6">
                    {Array.from({ length: 9 }).map((_, index) => (
                      <Skeleton key={index} className="h-3.5 w-full bg-slate-100" />
                    ))}
                  </div>
                </div>
              </div>
              <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 shadow-2xl">
                <Skeleton className="h-3 w-10 bg-white/20" />
                <Skeleton className="h-6 w-6 rounded-lg bg-white/20" />
                <Skeleton className="h-6 w-6 rounded-lg bg-white/20" />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export function CaseDetailPage({ caseId }: { caseId: string }) {
  const [detail, setDetail] = useState<SavedCaseDetail | null>(null);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "processing" | "error">("idle");
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisStage, setAnalysisStage] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisOptionsOpen, setAnalysisOptionsOpen] = useState(false);
  const [pendingAnalysisMode, setPendingAnalysisMode] = useState<CaseAnalysisMode>("standard");
  const [draftFileStatus, setDraftFileStatus] = useState<"idle" | "saving" | "error">("idle");
  const [draftFileError, setDraftFileError] = useState<string | null>(null);
  const [decisionStatus, setDecisionStatus] = useState<"idle" | "updating" | "error">("idle");
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("preview");
  const [activeDataView, setActiveDataView] = useState<DataViewMode>("fields");
  const [previewPageIndex, setPreviewPageIndex] = useState(0);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [signedFileUrls, setSignedFileUrls] = useState<Record<string, string | null>>({});
  const [loadingPreviewFileId, setLoadingPreviewFileId] = useState<string | null>(null);
  const [previewUrlError, setPreviewUrlError] = useState<string | null>(null);
  const draftFileInputRef = useRef<HTMLInputElement | null>(null);

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
        setError(loadError instanceof Error ? loadError.message : "Failed to load case details.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [caseId]);

  useEffect(() => {
    setSignedFileUrls({});
    setLoadingPreviewFileId(null);
    setPreviewUrlError(null);
  }, [caseId]);

  const displayDocuments = useMemo(
    () => (detail ? getDisplayDocuments(detail.documents) : []),
    [detail]
  );

  useEffect(() => {
    if (!detail) return;
    setActiveDocumentId((current) => {
      if (current && displayDocuments.some((document) => document.id === current)) {
        return current;
      }
      return displayDocuments[0]?.id ?? detail.documents[0]?.id ?? null;
    });
  }, [detail, displayDocuments]);

  useEffect(() => {
    if (!detail || detail.case.status !== "processing") {
      return;
    }

    let active = true;

    const pollStatus = async () => {
      try {
        const nextStatus = await fetchCaseAnalysisStatus(detail.case.id);
        if (!active) return;

        setAnalysisStatus("processing");
        setAnalysisProgress(nextStatus.job?.progress ?? 0);
        setAnalysisStage(nextStatus.job?.stage ?? null);
        setAnalysisError(nextStatus.job?.status === "failed" ? nextStatus.job.error ?? null : null);

        if (nextStatus.caseStatus === "completed" || nextStatus.caseStatus === "accepted" || nextStatus.caseStatus === "rejected") {
          const refreshed = await fetchCaseDetail(detail.case.id);
          if (!active) return;
          setDetail(refreshed);
          setAnalysisStatus("idle");
          setAnalysisProgress(100);
          setAnalysisStage(null);
          setAnalysisError(null);
          return;
        }

        if (nextStatus.caseStatus === "failed") {
          const refreshed = await fetchCaseDetail(detail.case.id);
          if (!active) return;
          setDetail(refreshed);
          setAnalysisStatus("error");
          setAnalysisError(nextStatus.job?.error ?? "Case analysis failed.");
          setAnalysisStage(nextStatus.job?.stage ?? "Failed");
        }
      } catch (statusError) {
        if (!active) return;
        setAnalysisStatus("error");
        setAnalysisError(
          statusError instanceof Error ? statusError.message : "Failed to load analysis progress."
        );
      }
    };

    void pollStatus();
    const intervalId = window.setInterval(() => {
      void pollStatus();
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [detail, detail?.case.id, detail?.case.status]);

  const fileLookup = useMemo(() => {
    const map = new Map<string, SavedCaseDetail["files"][number]>();
    detail?.files.forEach((file) => {
      map.set(normalizeText(file.originalName), file);
    });
    return map;
  }, [detail]);

  const uploadGroups = useMemo(
    () =>
      readUploadGroupMeta(
        detail?.case.processingMeta && typeof detail.case.processingMeta === "object"
          ? (detail.case.processingMeta as Record<string, unknown>).uploadGroups
          : undefined
      ),
    [detail]
  );

  const activeDocument = useMemo(() => {
    if (!detail || !activeDocumentId) return null;
    return (
      detail.documents.find((document) => document.id === activeDocumentId) ??
      displayDocuments[0] ??
      null
    );
  }, [detail, activeDocumentId, displayDocuments]);

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
  const pendingMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "pending"
  ).length;
  const rejectedMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "rejected"
  ).length;
  const reviewSummary = useMemo(() => {
    if (!detail) {
      return null;
    }

    const documentLabel = `${detail.documents.length} document${detail.documents.length === 1 ? "" : "s"}`;
    const documentLabels = getPacketDocumentLabels(detail.documents);
    const missingDocumentLabels = getMissingPacketDocumentLabels(detail.documents);
    const docsFact =
      documentLabels.length > 0
        ? `${detail.documents.length} ${detail.documents.length === 1 ? "document" : "documents"}`
        : "No extracted docs";
    const facts = [
      { label: "Docs", value: docsFact },
      { label: "Receiver", value: detail.case.receiverName || "-" },
    ];

    if (detail.case.status === "processing") {
      return {
        tone: "amber" as const,
        title: "Processing",
        description: `Checking ${documentLabel}.`,
        actionHint: "Wait for extraction and reconciliation to finish.",
        buttonLabel: null,
        action: null,
        badgeLabel: "Running",
        showConfidence: false,
        showBadge: true,
        facts,
      };
    }

    if (detail.case.status === "failed") {
      return {
        tone: "rose" as const,
        title: "Failed",
        description: "Could not complete analysis.",
        actionHint: "Retry analysis after checking the uploaded files.",
        buttonLabel: "Retry Analysis",
        action: "retry" as const,
        badgeLabel: "Failed",
        showConfidence: false,
        showBadge: true,
        facts,
      };
    }

    if (detail.case.status === "accepted") {
      return {
        tone: "emerald" as const,
        title: "Approved",
        description:
          visibleMismatches.length === 0
            ? `${documentLabel} verified. No pending action.`
            : `${visibleMismatches.length} reviewed issue${visibleMismatches.length === 1 ? "" : "s"} accepted.`,
        actionHint: "This case is cleared.",
        buttonLabel:
          visibleMismatches.length > 0
            ? `View ${visibleMismatches.length} Reviewed Issue${visibleMismatches.length === 1 ? "" : "s"}`
            : null,
        action: visibleMismatches.length > 0 ? "review" as const : null,
        badgeLabel: "Accepted",
        showConfidence: false,
        showBadge: false,
        facts,
      };
    }

    if (detail.case.status === "rejected") {
      return {
        tone: "rose" as const,
        title: "Blocked",
        description:
          rejectedMismatchCount > 0
            ? `${rejectedMismatchCount} rejected issue${rejectedMismatchCount === 1 ? "" : "s"} blocked this case.`
            : `Rejected after review across ${documentLabel}.`,
        actionHint: "Open the review trail before taking further action.",
        buttonLabel:
          visibleMismatches.length > 0
            ? `View ${visibleMismatches.length} Reviewed Issue${visibleMismatches.length === 1 ? "" : "s"}`
            : null,
        action: visibleMismatches.length > 0 ? "review" as const : null,
        badgeLabel: "Rejected",
        showConfidence: false,
        showBadge: false,
        facts,
      };
    }

    if (missingDocumentLabels.length > 0 && visibleMismatches.length === 0) {
      return {
        tone: "amber" as const,
        title: "Missing Documents",
        description: `Missing ${missingDocumentLabels.join(", ")} from this packet.`,
        actionHint: "Upload the missing document before approving.",
        buttonLabel: null,
        action: null,
        badgeLabel: "Incomplete",
        showConfidence: false,
        showBadge: true,
        facts: [{ label: "Missing", value: missingDocumentLabels.join(", ") }, ...facts],
      };
    }

    if (visibleMismatches.length === 0) {
      return {
        tone: "emerald" as const,
        title: "Ready to Approve",
        description: `${documentLabel} matched. No issues found.`,
        actionHint: "Approve this case and move on.",
        buttonLabel: "Approve Case",
        action: "approve" as const,
        badgeLabel: "Clear",
        showConfidence: false,
        showBadge: false,
        facts,
      };
    }

    if (pendingMismatchCount < visibleMismatches.length) {
      return {
        tone: "amber" as const,
        title: "Review In Progress",
        description: `${pendingMismatchCount} of ${visibleMismatches.length} issue${visibleMismatches.length === 1 ? "" : "s"} still need review.`,
        actionHint: "Finish the remaining decisions.",
        buttonLabel: `Review ${pendingMismatchCount} Pending Issue${pendingMismatchCount === 1 ? "" : "s"}`,
        action: "review" as const,
        badgeLabel: "Pending",
        showConfidence: false,
        showBadge: true,
        facts,
      };
    }

    return {
      tone: "rose" as const,
      title: "Needs Review",
      description: `${visibleMismatches.length} issue${visibleMismatches.length === 1 ? "" : "s"} found across ${documentLabel}.`,
      actionHint: "Review the mismatches before accepting.",
      buttonLabel: `Review ${visibleMismatches.length} Issue${visibleMismatches.length === 1 ? "" : "s"}`,
      action: "review" as const,
      badgeLabel: "Needs review",
      showConfidence: false,
      showBadge: false,
      facts,
    };
  }, [detail, pendingMismatchCount, rejectedMismatchCount, visibleMismatches.length]);

  const activeDocumentEntries = useMemo(() => {
    if (!activeDocument) return [];
    return getOrderedDocumentEntries(activeDocument.documentType, activeDocument.extractedFields);
  }, [activeDocument]);
  const activeTermsIssues = useMemo(() => {
    if (!detail) return [];
    return detail.mismatches.filter((mismatch) =>
      termsIssueMatchesDocument(mismatch, activeDocument)
    );
  }, [activeDocument, detail]);
  const caseTermsChecklist = useMemo(
    () => readTermsComplianceChecklist(detail?.case.processingMeta),
    [detail?.case.processingMeta]
  );
  const activeTermsChecklistRows = useMemo(() => {
    if (!activeDocument || !PURCHASE_ORDER_DOCUMENT_TYPES.has(activeDocument.documentType)) {
      return [];
    }

    const documentIds = new Set(
      [activeDocument.id, activeDocument.clientDocumentId, activeDocument.sourceHint, activeDocument.title]
        .filter((value): value is string => Boolean(value))
    );
    const assessedRows = caseTermsChecklist.filter((item) => documentIds.has(item.sourceDocId));
    if (assessedRows.length > 0) {
      return assessedRows.map((item, index) => ({
        key: `assessed-${item.sourceDocId}-${index}`,
        label: item.category || "Terms",
        value: item.sourceClause,
        detail: item.obligation,
        evidence: item.evidence || item.reason,
        issue: activeTermsIssues.find((mismatch) => getTermsIssueText(mismatch).includes(item.obligation)),
        status: getChecklistStatus(item.status),
      }));
    }

    return TERMS_CHECKLIST_DEFINITIONS.flatMap((definition) => {
      const value = getTermValue(activeDocument.extractedFields[definition.key]);
      if (!value) return [];

      const issue = activeTermsIssues.find((mismatch) =>
        termsIssueMatchesDefinition(mismatch, definition, value)
      );

      return [
        {
          key: definition.key,
          label: definition.label,
          value,
          detail: "",
          evidence: "",
          issue,
          status: issue ? getTermsIssueStatus(issue) : getClearTermsStatus(),
        },
      ];
    });
  }, [activeDocument, activeTermsIssues, caseTermsChecklist]);
  const unmatchedTermsIssues = useMemo(
    () =>
      activeTermsIssues.filter(
        (issue) => !activeTermsChecklistRows.some((row) => row.issue?.id === issue.id)
      ),
    [activeTermsChecklistRows, activeTermsIssues]
  );
  const activeDocumentFieldEntries = useMemo(() => {
    if (activeTermsChecklistRows.length === 0) {
      return activeDocumentEntries;
    }

    return activeDocumentEntries.filter(([key]) => !TERMS_FIELD_KEY_SET.has(key));
  }, [activeDocumentEntries, activeTermsChecklistRows.length]);
  const activeFieldDataCount =
    activeDocumentFieldEntries.length + activeTermsChecklistRows.length + unmatchedTermsIssues.length;
  const activeDocumentLineItems = useMemo(
    () => activeDocument?.lineItems ?? [],
    [activeDocument]
  );
  const activeDocumentLineItemColumns = useMemo(
    () => getVisibleLineItemColumns(activeDocumentLineItems),
    [activeDocumentLineItems]
  );

  useEffect(() => {
    setActiveDataView(
      hasExtractedTerms(activeDocument) || activeDocumentLineItems.length === 0
        ? "fields"
        : "lineItems"
    );
  }, [activeDocument, activeDocumentId, activeDocumentLineItems.length]);

  const activeDocumentFiles = useMemo(() => {
    if (!detail || !activeDocument) return [];

    const candidates = [activeDocument.sourceFileName, activeDocument.sourceHint]
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeText(value));

    const matchedUploadGroup = uploadGroups.find((group) => {
      const normalizedGroupName = normalizeText(group.name);
      const normalizedPrimaryFileName = normalizeText(group.primaryFileName || "");
      const normalizedFileNames = group.fileNames.map((fileName) => normalizeText(fileName));

      return candidates.some(
        (candidate) =>
          candidate === normalizedGroupName ||
          candidate === normalizedPrimaryFileName ||
          normalizedFileNames.includes(candidate)
      );
    });

    if (matchedUploadGroup) {
      const groupFiles = matchedUploadGroup.fileNames
        .map((fileName) => fileLookup.get(normalizeText(fileName)))
        .filter((file): file is SavedCaseDetail["files"][number] => Boolean(file));

      if (groupFiles.length) {
        return groupFiles;
      }
    }

    for (const candidate of candidates) {
      const exactMatch = fileLookup.get(candidate);
      if (exactMatch) return [exactMatch];
    }

    const partialMatch = detail.files.find((file) =>
      candidates.some((candidate) => normalizeText(file.originalName).includes(candidate))
    );

    if (partialMatch) return [partialMatch];
    return detail.files.length === 1 ? [detail.files[0]] : [];
  }, [activeDocument, detail, fileLookup, uploadGroups]);

  const activePreviewFile =
    activeDocumentFiles[previewPageIndex] ?? activeDocumentFiles[0] ?? null;
  const activeFileUrl = activePreviewFile
    ? signedFileUrls[activePreviewFile.id] ?? activePreviewFile.signedUrl ?? null
    : null;
  const isPreviewUrlLoading =
    Boolean(activePreviewFile) && loadingPreviewFileId === activePreviewFile?.id;
  const previewPageCount = activeDocumentFiles.length || activeDocument?.pageCount || 1;
  const activeSourceLabel = getSourceFileLabel(
    activePreviewFile?.mimeType,
    activePreviewFile?.originalName || activeDocument?.sourceFileName
  );
  const activeSourceIsImage = isImageSourceFile(
    activePreviewFile?.mimeType,
    activePreviewFile?.originalName || activeDocument?.sourceFileName || activeDocument?.sourceHint
  );
  const activeDocumentSourcePage = getDocumentSourcePage(activeDocument);
  const canGoToPreviousPreviewPage = previewPageIndex > 0;
  const canGoToNextPreviewPage =
    activeDocumentFiles.length > 0 && previewPageIndex < activeDocumentFiles.length - 1;
  const canZoomOut = activeSourceIsImage && previewZoom > 0.75;
  const canZoomIn = activeSourceIsImage && previewZoom < 3;

  useEffect(() => {
    setPreviewPageIndex(0);
    setPreviewZoom(1);
  }, [activeDocumentId]);

  useEffect(() => {
    setPreviewPageIndex((current) => Math.min(current, Math.max(activeDocumentFiles.length - 1, 0)));
  }, [activeDocumentFiles.length]);

  useEffect(() => {
    setPreviewZoom(1);
  }, [previewPageIndex]);

  useEffect(() => {
    if (!detail || activeTab !== "preview" || !activePreviewFile) {
      return;
    }

    if (
      activePreviewFile.signedUrl ||
      Object.prototype.hasOwnProperty.call(signedFileUrls, activePreviewFile.id)
    ) {
      return;
    }

    let active = true;
    setLoadingPreviewFileId(activePreviewFile.id);
    setPreviewUrlError(null);

    fetchCaseFileSignedUrl(detail.case.id, activePreviewFile.id)
      .then((payload) => {
        if (!active) return;
        setSignedFileUrls((current) => ({
          ...current,
          [payload.fileId]: payload.signedUrl,
        }));
      })
      .catch((loadError) => {
        if (!active) return;
        setPreviewUrlError(
          loadError instanceof Error ? loadError.message : "Failed to load source preview."
        );
        setSignedFileUrls((current) => ({
          ...current,
          [activePreviewFile.id]: null,
        }));
      })
      .finally(() => {
        if (!active) return;
        setLoadingPreviewFileId((current) =>
          current === activePreviewFile.id ? null : current
        );
      });

    return () => {
      active = false;
    };
  }, [activePreviewFile, activeTab, detail, signedFileUrls]);

  const comparisonOptions = useMemo(
    () =>
      readComparisonOptions(
        detail?.case.processingMeta && typeof detail.case.processingMeta === "object"
          ? (detail.case.processingMeta as Record<string, unknown>).comparisonOptions
          : undefined
      ),
    [detail]
  );

  async function handleAnalyzeDraftCase(
    comparisonOptions: ComparisonOptions,
    analysisMode: CaseAnalysisMode = "standard"
  ) {
    if (!detail || detail.files.length === 0 || draftFileStatus === "saving") return;

    try {
      setAnalysisStatus("processing");
      setAnalysisError(null);
      setAnalysisProgress(0);
      setAnalysisStage(analysisMode === "smart_split" ? "Queued for multi-PDF document analysis" : "Queued for analysis");
      const started = await enqueueCaseAnalysis(detail.case.id, {
        analysisMode,
        comparisonOptions,
      });
      setDetail((current) =>
        current
          ? {
              ...current,
              case: {
                ...current.case,
                ...started.case,
              },
            }
          : current
      );
    } catch (analysisFailure) {
      setAnalysisError(
        analysisFailure instanceof Error ? analysisFailure.message : "Failed to analyze this case."
      );
      setAnalysisStatus("error");
    }
  }

  async function handleDraftFileInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (!detail || selectedFiles.length === 0) {
      return;
    }

    try {
      setDraftFileStatus("saving");
      setDraftFileError(null);
      await appendCaseFiles(detail.case.id, buildDraftUploads(selectedFiles));
      const refreshed = await fetchCaseDetail(detail.case.id);
      setDetail(refreshed);
      setDraftFileStatus("idle");
    } catch (appendError) {
      setDraftFileStatus("error");
      setDraftFileError(
        appendError instanceof Error ? appendError.message : "Failed to add files to case."
      );
    }
  }

  async function handleCaseDecision(decision: CaseDecision) {
    if (!detail) return;

    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      const updated = await updateCaseDecision(detail.case.id, decision);
      setDetail((current) =>
        current
          ? {
            ...current,
            case: {
              ...current.case,
              ...updated.case,
            },
          }
          : current
      );
      setDecisionStatus("idle");
    } catch (decisionFailure) {
      setDecisionError(
        decisionFailure instanceof Error
          ? decisionFailure.message
          : `Failed to ${decision === "accepted" ? "accept" : "reject"} case.`
      );
      setDecisionStatus("error");
    }
  }

  const isFinalDecision = detail?.case.status === "accepted" || detail?.case.status === "rejected";

  if (status === "loading") {
    return (
      <AppShell>
        <CaseDetailSkeleton />
      </AppShell>
    );
  }

  if (status === "error") {
    return (
      <AppShell>
        <div className="flex flex-1 items-center justify-center bg-slate-50/50 p-6 min-h-[calc(100vh-4rem)] tracking-normal">
          <div className="w-full max-w-md flex flex-col items-center text-center bg-white p-8 rounded-3xl shadow-sm border border-slate-200">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-50 mb-4">
              <ShieldAlert className="h-8 w-8 text-red-500" />
            </div>
            <h3 className="text-xl font-medium text-slate-900">Unable to load case</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">{error}</p>
            <Button asChild variant="outline" className="mt-8 rounded-xl w-full">
              <Link href="/cases">Return to Cases</Link>
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  // =========================================
  // DRAFT STATE (Awaiting Analysis)
  // =========================================
  if (
    status === "ready" &&
    detail &&
    (detail.case.status === "draft" ||
      detail.case.status === "processing" ||
      (detail.case.status === "failed" && detail.documents.length === 0))
  ) {
    const isAnalyzing = detail.case.status === "processing" || analysisStatus === "processing";
    const canRetry = detail.case.status === "failed";
    const stageLabel = getFriendlyAnalysisStage(analysisStage, analysisStatus);
    const readyCount = detail.files.length;

    return (
      <AppShell>
        <div className="flex flex-1 flex-col bg-[#f7f7f5] animate-in fade-in duration-500 min-h-[calc(100vh-4rem)] tracking-normal">
          <header className="flex h-14 sm:h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
            <div className="flex items-center gap-3 sm:gap-4 w-full">
              <Link href="/cases" className="text-slate-400 hover:text-slate-800 transition-colors shrink-0">
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <h1 className="text-base sm:text-lg font-medium text-slate-900 truncate pr-2">
                {detail.case.displayName}
              </h1>
              <Badge variant="outline" className={`ml-auto rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0 ${getCaseStatusClassName(detail.case.status)}`}>
                {getCaseStatusLabel(detail.case.status)}
              </Badge>
            </div>
          </header>

          <main className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0 -z-10">
              <div className="absolute left-[12%] top-[14%] h-72 w-72 rounded-full bg-[#e5ddd0]/40 blur-3xl" />
              <div className="absolute right-[12%] bottom-[14%] h-80 w-80 rounded-full bg-[#d4c9b8]/30 blur-3xl" />
            </div>

            <div className="relative z-10 mx-auto flex w-full max-w-4xl flex-col items-center gap-8 px-6 py-12 text-center sm:py-16">
              <div className={`grid h-16 w-16 place-items-center rounded-[1.25rem] shadow-sm border ${canRetry ? "bg-red-50 text-red-700 border-red-200" : "bg-[#eaf0ff] text-[#4f46e5] border-[#d9dcff]"}`}>
                {canRetry ? <TriangleAlert className="h-8 w-8" /> : <CheckCircle2 className="h-8 w-8" />}
              </div>

              <div className="max-w-2xl space-y-4">
                <div className="text-xs font-medium uppercase tracking-[0.3em] text-[#8a7f72]">
                  {canRetry ? "Analysis failed" : "Case created"}
                </div>
                <h2 className="text-4xl font-medium tracking-tight text-[#1a1a1a] sm:text-5xl">
                  {canRetry ? "Analysis failed" : "Ready to analyze"}
                </h2>
                <p className="mx-auto text-base font-medium leading-relaxed text-[#5a5046]">
                  {canRetry
                    ? "The previous analysis run failed. Review the error below, then retry this case analysis."
                    : `This case has ${readyCount} document${readyCount === 1 ? "" : "s"} ready. Add any missing documents, then analyze to extract fields and check mismatches.`}
                </p>

                <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-[#e5ddd0] bg-white px-4 py-2 text-sm font-medium text-[#5a5046] shadow-sm">
                  <Folder className="h-4 w-4 text-[#8a7f72]" />
                  {detail.case.displayName}
                </div>

                {draftFileStatus === "saving" && (
                  <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-[#c9ead2] bg-[#eaf7ee] px-4 py-2 text-sm font-medium text-[#15803d] shadow-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Adding documents to case...
                  </div>
                )}

                {isAnalyzing && (
                  <div className="mx-auto mt-4 w-full max-w-md space-y-3 text-left">
                    <div className="flex items-center justify-between text-sm font-medium text-[#5a5046]">
                      <span>{stageLabel}</span>
                      <span>{analysisProgress}%</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-[#ece8e0]">
                      <div
                        className="h-full rounded-full bg-[#1a1a1a] transition-all duration-300 ease-out"
                        style={{ width: `${analysisProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {((analysisStatus === "error" && analysisError) || draftFileError) && (
                  <div className="mx-auto mt-4 max-w-2xl rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-medium text-red-700 shadow-sm">
                    {draftFileError || analysisError}
                  </div>
                )}
              </div>

              <div className="w-full max-w-3xl rounded-[2rem] border border-[#e5ddd0] bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-left text-base font-medium text-[#1a1a1a]">Documents in this case</h3>
                  <div className="text-[11px] font-medium uppercase tracking-[0.25em] text-[#8a7f72]">
                    {readyCount} document{readyCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap gap-3">
                  {detail.files.map((file, index) => (
                    <div
                      key={file.id}
                      className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-[#e5ddd0] bg-[#faf8f4] text-[#8a7f72] shadow-sm"
                      title={file.originalName}
                    >
                      <FileText className="h-6 w-6" />
                      <span className="absolute -right-1.5 -top-1.5 rounded-full bg-[#1a1a1a] px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {index + 1}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-[#8a7f72]">
                Mode: {getComparisonModeLabel(comparisonOptions)}
              </div>

              {!isAnalyzing && (
                <div className="mt-2 flex w-full max-w-3xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-center">
                  <input
                    ref={draftFileInputRef}
                    type="file"
                    multiple
                    accept=".pdf,image/*"
                    className="hidden"
                    onChange={handleDraftFileInputChange}
                  />

                  <Button
                    variant="outline"
                    disabled={draftFileStatus === "saving"}
                    className="rounded-2xl px-6 py-6 text-base font-medium border-[#e5ddd0] text-[#5a5046] bg-white hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-transform hover:scale-[1.02]"
                    onClick={() => draftFileInputRef.current?.click()}
                  >
                    <Plus className="mr-2 h-5 w-5 text-[#8a7f72]" />
                    Add documents
                  </Button>

                  <Button
                    type="button"
                    disabled={detail.files.length === 0 || draftFileStatus === "saving"}
                    className="flex-1 rounded-2xl bg-[#1a1a1a] px-8 py-6 text-base font-medium text-white shadow-lg shadow-[#1a1a1a]/15 hover:bg-[#2d2d2d] transition-transform hover:scale-[1.02]"
                    onClick={() => {
                      setPendingAnalysisMode("standard");
                      setAnalysisOptionsOpen(true);
                    }}
                  >
                    <Play className="mr-2 h-5 w-5 fill-white" />
                    {canRetry ? "Retry analysis" : "Analyze case"}
                  </Button>

                  <Button
                    type="button"
                    disabled={detail.files.length === 0 || draftFileStatus === "saving"}
                    variant="outline"
                    className="rounded-2xl border-emerald-200 bg-emerald-50 px-6 py-6 text-base font-medium text-emerald-800 shadow-sm transition-transform hover:scale-[1.02] hover:bg-emerald-100 hover:text-emerald-900"
                    onClick={() => {
                      setPendingAnalysisMode("smart_split");
                      setAnalysisOptionsOpen(true);
                    }}
                  >
                    <Sparkles className="mr-2 h-5 w-5" />
                    Analyze multi-doc PDFs
                  </Button>
                </div>
              )}
            </div>
          </main>

          <AnalysisOptionsDialog
            open={analysisOptionsOpen}
            onOpenChange={setAnalysisOptionsOpen}
            onSelect={(nextOptions) => {
              setAnalysisOptionsOpen(false);
              void handleAnalyzeDraftCase(nextOptions, pendingAnalysisMode);
            }}
          />
        </div>
      </AppShell>
    );
  }

  // =========================================
  // ANALYZED STATE (Split Screen View)
  // =========================================
  const showActions = detail && detail.case.status !== "draft" && !isFinalDecision;
  const splitAnalysisMeta = readSplitAnalysisMeta(detail?.case.processingMeta);
  const sellerChainRoleMeta = readSellerChainRoleSelectionMeta(detail?.case.processingMeta);

  return (
    <AppShell>
      <div
        className={`relative flex min-h-[calc(100vh-4rem)] flex-1 flex-col overflow-hidden bg-[#fafafa] tracking-normal animate-in fade-in duration-300 ${
          showActions ? "pb-28 md:pb-0" : ""
        }`}
      >

        {/* Top Navigation Bar */}
        <header className="flex h-14 sm:h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3 sm:px-6 z-20 relative">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
            <Link href="/cases" className="flex items-center justify-center h-8 w-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0">
              <ArrowLeft className="h-4 w-4 sm:h-5 w-5" />
            </Link>
            <div className="w-px h-6 bg-slate-200 shrink-0"></div>
            <div className="min-w-0 flex flex-col justify-center">
              <h1 className="text-xs sm:text-base font-medium text-slate-900 truncate">
                {detail?.case.displayName}
              </h1>
            </div>
          </div>

          {/* Action Area (Desktop) */}
          <div className="hidden md:flex items-center gap-3 shrink-0">
            <Badge variant="outline" className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider ${getCaseStatusClassName(detail?.case.status || "")}`}>
              {getCaseStatusLabel(detail?.case.status || "")}
            </Badge>
            {showActions ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-rose-600 hover:bg-rose-50 hover:text-rose-700 border-slate-200 shadow-sm transition-colors"
                  disabled={decisionStatus === "updating"}
                  onClick={() => handleCaseDecision("rejected")}
                >
                  <X className="h-4 w-4 mr-1.5" />
                  Reject
                </Button>
                <Button
                  size="sm"
                  className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition-colors"
                  disabled={decisionStatus === "updating"}
                  onClick={() => handleCaseDecision("accepted")}
                >
                  {decisionStatus === "updating" ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  ) : (
                    <Check className="h-4 w-4 mr-1.5" />
                  )}
                  Accept Case
                </Button>
              </>
            ) : null}
          </div>

          {/* Mobile Status Badge fallback */}
          <div className="md:hidden shrink-0 ml-2">
            <Badge variant="outline" className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${getCaseStatusClassName(detail?.case.status || "")}`}>
              {getCaseStatusLabel(detail?.case.status || "")}
            </Badge>
          </div>
        </header>

        {decisionStatus === "error" && decisionError && (
          <div className="bg-red-50 text-red-600 text-xs sm:text-sm p-3 text-center border-b border-red-100 font-medium z-10 relative shrink-0">
            {decisionError}
          </div>
        )}

        {splitAnalysisMeta && (
          <div className="relative z-10 shrink-0 border-b border-indigo-100 bg-indigo-50 px-4 py-3 text-indigo-950 sm:px-6">
            <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-indigo-100 bg-white text-indigo-600 shadow-sm">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-5">
                    {splitAnalysisMeta.note}
                  </p>
                  <p className="mt-0.5 text-xs font-medium text-indigo-700">
                    Case {splitAnalysisMeta.groupIndex} of {splitAnalysisMeta.groupCount}
                    {splitAnalysisMeta.sourceFileNames.length
                      ? ` from ${splitAnalysisMeta.sourceFileNames.join(", ")}`
                      : ""}
                  </p>
                </div>
              </div>
              {splitAnalysisMeta.siblingCases.length > 0 && (
                <div className="flex flex-wrap gap-2 pl-11 sm:justify-end sm:pl-0">
                  {splitAnalysisMeta.siblingCases.map((sibling) => (
                    <Button
                      key={sibling.id}
                      asChild
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-lg border-indigo-200 bg-white px-3 text-xs font-medium text-indigo-700 hover:bg-indigo-100 hover:text-indigo-800"
                    >
                      <Link href={`/cases/${sibling.id}`}>
                        Case {sibling.groupIndex}
                      </Link>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {sellerChainRoleMeta && (
          <div className="relative z-10 shrink-0 border-b border-amber-100 bg-amber-50 px-4 py-3 text-amber-950 sm:px-6">
            <div className="mx-auto flex max-w-7xl items-start gap-3">
              <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-amber-100 bg-white text-amber-600 shadow-sm">
                <ShieldAlert className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium leading-5">
                  {sellerChainRoleMeta.note}
                </p>
                <p className="mt-0.5 text-xs font-medium text-amber-700">
                  {sellerChainRoleMeta.primaryDocumentIds.length} reconciliation document
                  {sellerChainRoleMeta.primaryDocumentIds.length === 1 ? "" : "s"};{" "}
                  {sellerChainRoleMeta.contextDocumentIds.length} context document
                  {sellerChainRoleMeta.contextDocumentIds.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Mobile AI Alert Banner (Extremely Compact) */}
        {reviewSummary && (visibleMismatches.length > 0 || detail?.case.status === "accepted" || detail?.case.status === "rejected") && (
          <div
            className={`md:hidden border-b py-2.5 px-4 flex items-center justify-between shrink-0 z-10 relative ${
              reviewSummary.tone === "emerald"
                ? "bg-emerald-50 border-emerald-100"
                : reviewSummary.tone === "amber"
                  ? "bg-amber-50 border-amber-100"
                  : "bg-rose-50 border-rose-100"
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className={`p-1 rounded-full shrink-0 ${
                  reviewSummary.tone === "emerald"
                    ? "bg-emerald-100"
                    : reviewSummary.tone === "amber"
                      ? "bg-amber-100"
                      : "bg-rose-100"
                }`}
              >
                {reviewSummary.tone === "emerald" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <TriangleAlert
                    className={`h-4 w-4 ${
                      reviewSummary.tone === "amber" ? "text-amber-600" : "text-rose-600"
                    }`}
                  />
                )}
              </div>
              <h3
                className={`text-[11px] font-medium uppercase tracking-tight ${
                  reviewSummary.tone === "emerald"
                    ? "text-emerald-900"
                    : reviewSummary.tone === "amber"
                      ? "text-amber-900"
                      : "text-rose-900"
                }`}
              >
                {reviewSummary.title}
              </h3>
            </div>
            {reviewSummary.buttonLabel ? (
              <Button
                asChild
                size="sm"
                variant="ghost"
                className={`h-8 text-[10px] text-white rounded-lg px-4 shrink-0 font-medium uppercase tracking-wider shadow-sm ${
                  reviewSummary.tone === "emerald"
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : reviewSummary.tone === "amber"
                      ? "bg-amber-600 hover:bg-amber-700"
                      : "bg-rose-600 hover:bg-rose-700"
                }`}
              >
                <Link href={`/cases/${caseId}/mismatches`}>Review</Link>
              </Button>
            ) : null}
          </div>
        )}

        {/* Main Content Split */}
        <div className="flex flex-1 min-h-0 relative">

          {/* Left Sidebar (Desktop only) */}
          <aside className="hidden h-full max-h-[calc(100vh-4rem)] min-h-0 w-[20rem] shrink-0 overflow-hidden border-r border-slate-200 bg-[#fafafa] md:flex md:flex-col xl:w-[22rem]">
            <div className="min-w-0 shrink-0 p-5 pb-4">

                {/* Decision Summary Card */}
                {detail && reviewSummary && (
                  <div
                    className={`flex w-full max-w-full flex-col overflow-hidden rounded-2xl border bg-white shadow-sm ${
                      reviewSummary.tone === "emerald"
                        ? "border-emerald-200"
                        : reviewSummary.tone === "amber"
                          ? "border-amber-200"
                          : "border-rose-200"
                    }`}
                  >

                    <div
                      className={`p-5 ${
                        reviewSummary.tone === "emerald"
                          ? "bg-emerald-50/70"
                          : reviewSummary.tone === "amber"
                            ? "bg-amber-50/70"
                            : "bg-rose-50/70"
                      }`}
                    >
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <div
                            className={`rounded-full p-1.5 shadow-sm ${
                              reviewSummary.tone === "emerald"
                                ? "bg-emerald-100 text-emerald-600"
                                : reviewSummary.tone === "amber"
                                  ? "bg-amber-100 text-amber-600"
                                  : "bg-rose-100 text-rose-600"
                            }`}
                          >
                            {reviewSummary.tone === "emerald" ? (
                              <CheckCircle2 className="h-4 w-4" />
                            ) : reviewSummary.title === "Processing" ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <TriangleAlert className="h-4 w-4" />
                            )}
                          </div>
                          <h3
                            className={`truncate text-base font-medium ${
                              reviewSummary.tone === "emerald"
                                ? "text-emerald-950"
                                : reviewSummary.tone === "amber"
                                  ? "text-amber-950"
                                  : "text-rose-950"
                            }`}
                          >
                            {reviewSummary.title}
                          </h3>
                        </div>
                        {reviewSummary.showBadge ? (
                          <span
                            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider ${
                              reviewSummary.tone === "emerald"
                                ? "bg-emerald-100 text-emerald-700"
                                : reviewSummary.tone === "amber"
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-rose-100 text-rose-700"
                            }`}
                          >
                            {reviewSummary.badgeLabel}
                          </span>
                        ) : null}
                      </div>

                      <p
                        className={`text-sm font-medium leading-snug ${
                          reviewSummary.tone === "emerald"
                            ? "text-emerald-800"
                            : reviewSummary.tone === "amber"
                              ? "text-amber-800"
                              : "text-rose-800"
                        }`}
                      >
                        {reviewSummary.description}
                      </p>
                      {reviewSummary.action !== "approve" && reviewSummary.actionHint ? (
                        <p className="mt-2 text-xs font-medium leading-snug text-slate-600">
                          {reviewSummary.actionHint}
                        </p>
                      ) : null}

                      {reviewSummary.buttonLabel && reviewSummary.action === "review" && (
                        <Button
                          asChild
                          className={`mt-4 h-10 w-full text-white shadow-sm font-medium ${
                            reviewSummary.tone === "emerald"
                              ? "bg-emerald-600 hover:bg-emerald-700"
                              : reviewSummary.tone === "amber"
                                ? "bg-amber-600 hover:bg-amber-700"
                                : "bg-rose-600 hover:bg-rose-700"
                          }`}
                        >
                          <Link href={`/cases/${caseId}/mismatches`}>
                            <TriangleAlert className="mr-2 h-4 w-4" />
                            {reviewSummary.buttonLabel}
                          </Link>
                        </Button>
                      )}

                      {reviewSummary.buttonLabel && reviewSummary.action === "approve" && showActions && (
                        <Button
                          className="mt-4 h-10 w-full bg-emerald-600 font-medium text-white shadow-sm hover:bg-emerald-700"
                          disabled={decisionStatus === "updating"}
                          onClick={() => handleCaseDecision("accepted")}
                        >
                          {decisionStatus === "updating" ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="mr-2 h-4 w-4" />
                          )}
                          {reviewSummary.buttonLabel}
                        </Button>
                      )}

                      {reviewSummary.buttonLabel && reviewSummary.action === "retry" && (
                        <Button
                          className="mt-4 h-10 w-full bg-rose-600 font-medium text-white shadow-sm hover:bg-rose-700"
                          onClick={() => {
                            setPendingAnalysisMode("standard");
                            setAnalysisOptionsOpen(true);
                          }}
                        >
                          <Play className="mr-2 h-4 w-4 fill-white" />
                          {reviewSummary.buttonLabel}
                        </Button>
                      )}

                      {reviewSummary.showConfidence && (
                        <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-emerald-100 bg-emerald-100/60 py-2 text-xs font-medium text-emerald-700">
                          <Sparkles className="h-3.5 w-3.5" /> High Confidence
                        </div>
                      )}
                    </div>

                    <div className="border-t border-slate-100 bg-white p-4">
                      <div className="grid grid-cols-1 gap-2">
                        {reviewSummary.facts.map((fact) => (
                          <div
                            key={`${fact.label}-${fact.value}`}
                            className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"
                          >
                            <span className="shrink-0 text-[10px] font-medium uppercase tracking-widest text-slate-400">
                              {fact.label}
                            </span>
                            <span className="min-w-0 truncate text-right text-xs font-medium text-slate-800" title={fact.value}>
                              {fact.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

            </div>

            {/* Documents List */}
            <div className="flex min-h-0 flex-1 flex-col border-t border-slate-200 px-5 pb-5 pt-4">
                  <div className="mb-3 flex shrink-0 items-center justify-between px-1">
                    <h3 className="text-[11px] font-medium text-slate-500 uppercase tracking-widest">Documents in Packet</h3>
                    <span className="rounded-full bg-slate-200/50 px-2 py-0.5 text-[10px] font-medium text-slate-500">{displayDocuments.length}</span>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                    {displayDocuments.map((doc) => {
                      const isActive = activeDocumentId === doc.id;
                      const documentIndex = getDocumentIndexDetails(doc);
                      return (
                        <button
                          key={doc.id}
                          onClick={() => setActiveDocumentId(doc.id)}
                          className={`flex w-full min-w-0 items-start gap-3 rounded-xl px-3 py-3 text-left transition-all ${isActive ? 'bg-white shadow-sm border border-slate-200 ring-1 ring-slate-200' : 'hover:bg-slate-200/50 border border-transparent'
                            }`}
                        >
                          <div className={`mt-0.5 shrink-0 h-8 w-8 rounded-lg flex items-center justify-center ${isActive ? 'bg-indigo-50 text-indigo-600' : 'bg-white text-slate-400 border border-slate-200'}`}>
                            <FileText className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`whitespace-normal text-sm font-medium leading-snug [overflow-wrap:anywhere] ${isActive ? 'text-slate-950' : 'text-slate-700'}`}>
                              {documentIndex.type}
                            </p>
                            <p className={`mt-1 truncate text-xs font-medium leading-snug ${isActive ? 'text-slate-700' : 'text-slate-500'}`} title={documentIndex.fileName}>
                              {documentIndex.fileName}
                            </p>
                            <p className="mt-1 line-clamp-1 text-[10px] font-medium uppercase tracking-wider text-slate-400 [overflow-wrap:anywhere]">
                              {documentIndex.pageLabel}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
            </div>
          </aside>

          {/* Right Main Area (Document Viewer Card) */}
          <main className="flex-1 flex flex-col min-w-0 bg-[#fafafa] pt-2.5 px-2.5 pb-0 sm:p-4 md:p-6 lg:p-8 relative">

            {/* Mobile Document Selector (Horizontal scroll) */}
            <div className="md:hidden bg-white border border-[#e5ddd0] rounded-xl mb-3 p-1.5 shrink-0 z-10 relative overflow-hidden shadow-sm">
              <div className="flex overflow-x-auto gap-2 snap-x scrollbar-hide py-0.5 px-0.5">
                {displayDocuments.map((doc) => {
                  const isActive = activeDocumentId === doc.id;
                  const documentIndex = getDocumentIndexDetails(doc);
                  return (
                      <button
                        key={doc.id}
                      onClick={() => setActiveDocumentId(doc.id)}
                      className={`snap-start shrink-0 flex flex-col items-center justify-center px-4 py-2 rounded-lg text-center transition-all border ${isActive 
                        ? 'bg-[#1a1a1a] border-slate-900 shadow-md text-white' 
                        : 'bg-[#f0ece6] border-[#e5ddd0] text-[#5a5046]'
                        }`}
                      style={{ minWidth: '160px' }}
                    >
                      <p className="w-full truncate text-[11px] font-medium">{documentIndex.type}</p>
                      <p className={`mt-0.5 w-full truncate text-[9px] font-medium opacity-70 ${isActive ? 'text-white' : 'text-[#8a7f72]'}`}>{documentIndex.fileName}</p>
                      <p className={`mt-0.5 w-full truncate text-[8px] font-medium uppercase tracking-wider opacity-60 ${isActive ? 'text-white' : 'text-[#8a7f72]'}`}>{documentIndex.pageLabel}</p>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* The Unified Card Container */}
            <div className="flex flex-col flex-1 bg-white sm:border border-slate-200 sm:rounded-2xl shadow-sm overflow-hidden mb-2 sm:mb-0">

              {/* Card Header (Tabs & Title) */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-2 sm:p-3 border-b border-slate-100 bg-white shrink-0">

                {/* Left Side: Title & Badge (Desktop Only) */}
                <div className="hidden sm:flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    {activeTab === 'preview' ? <Eye className="h-5 w-5 text-slate-500" /> : <Database className="h-5 w-5 text-slate-500" />}
                    <h2 className="text-base font-medium text-slate-900">
                      {activeTab === 'preview' ? 'Preview' : 'Extracted Data'}
                    </h2>
                  </div>
                  <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[10px] uppercase font-medium text-slate-500 bg-slate-50 border-slate-200">
                    {activeTab === 'preview' ? activeSourceLabel : 'View'}
                  </Badge>
                </div>

                {/* Right Side: Segmented Control & Actions */}
                <div className="flex items-center justify-between sm:justify-end w-full sm:w-auto gap-3">

                  {/* Segmented Control */}
                  <div className="flex items-center bg-[#f0ece6] p-1 rounded-xl w-full sm:w-auto border border-[#e5ddd0]">
                    {DETAIL_TABS.map((tab) => {
                      const isActive = activeTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          onClick={() => setActiveTab(tab.id)}
                          className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition-all ${isActive
                              ? 'bg-[#1a1a1a] text-white shadow-md'
                              : 'text-[#5a5046] hover:bg-[#e5ddd0]/30'
                            }`}
                        >
                          <tab.icon className={`h-3.5 w-3.5 ${isActive ? 'text-white' : 'text-[#8a7f72]'}`} />
                          <span>{tab.label}</span>
                        </button>
                      );
                    })}
                  </div>

                </div>
              </div>

              {/* Card Body (The Views) */}
              <div className="flex-1 relative bg-white overflow-hidden">

                {/* 1. Preview View */}
                {activeTab === 'preview' && (
                  <div className="absolute inset-0 flex flex-col bg-[#525659]">

                    {/* PDF/Image Canvas */}
                    <div className="flex-1 relative overflow-hidden">
                      {activeFileUrl ? (
                        activeSourceIsImage ? (
                          <div className="absolute inset-0 overflow-auto">
                            <div className="flex min-h-full min-w-full items-start justify-center px-3 py-5 sm:px-6 sm:py-8">
                              <div
                                className="relative flex w-full max-w-[min(100%,880px)] justify-center transition-transform duration-150 ease-out"
                                style={{ transform: `scale(${previewZoom})`, transformOrigin: "top center" }}
                              >
                                <Image
                                  src={activeFileUrl}
                                  alt={`Document preview page ${previewPageIndex + 1}`}
                                  width={1200}
                                  height={1600}
                                  unoptimized
                                  sizes="(min-width: 1024px) 70vw, 92vw"
                                  className="h-auto max-h-[calc(100vh-13rem)] w-auto max-w-full rounded-sm bg-white object-contain shadow-2xl"
                                  draggable={false}
                                />
                              </div>
                            </div>
                          </div>
                        ) : (
                          <iframe
                            key={`${activeFileUrl}-${activeDocumentSourcePage}`}
                            src={`${activeFileUrl}#page=${activeDocumentSourcePage}&toolbar=0&navpanes=0`}
                            className="absolute inset-0 w-full h-full border-0 bg-white"
                            title="Document Preview"
                          />
                        )
                      ) : isPreviewUrlLoading ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 gap-4 p-6 text-center">
                          <Loader2 className="w-12 h-12 animate-spin opacity-70" />
                          <p className="text-sm font-medium">Loading source preview...</p>
                        </div>
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 gap-4 p-6 text-center">
                          <FileSearch className="w-12 h-12 opacity-50" />
                          <p className="text-sm font-medium">
                            {previewUrlError || "Source preview not available for this document."}
                          </p>
                        </div>
                      )}

                      {/* Floating Dark Toolbar */}
                      {activeFileUrl && (
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-slate-900/80 backdrop-blur-md px-2 py-1.5 rounded-xl border border-white/10 shadow-2xl z-20">
                          {previewPageCount > 1 && (
                            <>
                              <button
                                type="button"
                                disabled={!canGoToPreviousPreviewPage}
                                className="p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                                onClick={() => setPreviewPageIndex((current) => Math.max(0, current - 1))}
                                aria-label="Previous page"
                              >
                                <ChevronLeft className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          <div className="text-white text-[10px] sm:text-xs font-medium px-2 flex items-center gap-1">
                            {Math.min(previewPageIndex + 1, previewPageCount)} <span className="opacity-50">/ {previewPageCount}</span>
                          </div>
                          {previewPageCount > 1 && (
                            <>
                              <button
                                type="button"
                                disabled={!canGoToNextPreviewPage}
                                className="p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                                onClick={() =>
                                  setPreviewPageIndex((current) =>
                                    Math.min(Math.max(activeDocumentFiles.length - 1, 0), current + 1)
                                  )
                                }
                                aria-label="Next page"
                              >
                                <ChevronRight className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          <div className="h-3 w-px bg-white/20 mx-1"></div>
                          <button
                            type="button"
                            disabled={!canZoomOut}
                            className="p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                            onClick={() => setPreviewZoom((current) => Math.max(0.75, Number((current - 0.25).toFixed(2))))}
                            aria-label="Zoom out"
                          >
                            <ZoomOut className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            disabled={!canZoomIn}
                            className="p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                            onClick={() => setPreviewZoom((current) => Math.min(3, Number((current + 0.25).toFixed(2))))}
                            aria-label="Zoom in"
                          >
                            <ZoomIn className="h-4 w-4" />
                          </button>
                          <div className="h-3 w-px bg-white/20 mx-1 hidden sm:block"></div>
                          <button
                            type="button"
                            disabled={!activeSourceIsImage || previewZoom === 1}
                            className="hidden sm:block p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                            onClick={() => setPreviewZoom(1)}
                            aria-label="Reset zoom"
                          >
                            <RotateCw className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 2. Data View */}
                {activeTab === 'data' && (
                  <div className="absolute inset-0 overflow-y-auto">
                    <div className="mx-auto max-w-5xl space-y-3 p-3 pb-5 sm:p-4">
                      {(activeFieldDataCount > 0 || activeDocumentLineItems.length > 0) && (
                        <div className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-white px-3 py-2 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                              Data View
                            </div>
                            <div className="text-xs font-medium text-slate-700">
                              {activeDocument?.title ?? "Selected document"}
                            </div>
                          </div>
                          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                            <button
                              type="button"
                              className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                                activeDataView === "fields"
                                  ? "bg-white text-slate-950 shadow-sm"
                                  : "text-slate-500 hover:text-slate-800"
                              }`}
                              onClick={() => setActiveDataView("fields")}
                            >
                              Fields ({activeFieldDataCount})
                            </button>
                            <button
                              type="button"
                              disabled={activeDocumentLineItems.length === 0}
                              className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                                activeDataView === "lineItems"
                                  ? "bg-white text-slate-950 shadow-sm"
                                  : "text-slate-500 hover:text-slate-800"
                              }`}
                              onClick={() => setActiveDataView("lineItems")}
                            >
                              Line items ({activeDocumentLineItems.length})
                            </button>
                          </div>
                        </div>
                      )}

                      {activeFieldDataCount === 0 && activeDocumentLineItems.length === 0 ? (
                        <div className="py-12 text-center text-sm font-medium text-slate-500">
                          No specific fields extracted for this document type.
                        </div>
                      ) : activeDataView === "fields" && activeFieldDataCount > 0 ? (
                        <div className="space-y-3">
                          {(activeTermsChecklistRows.length > 0 || unmatchedTermsIssues.length > 0) && (
                            <div className="overflow-hidden rounded-xl border border-slate-100 bg-white shadow-sm">
                              <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                  <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                                    Terms & Conditions Compliance Checklist
                                  </div>
                                  <div className="mt-1 text-xs font-medium text-slate-700">
                                    {activeTermsChecklistRows.length} clause{activeTermsChecklistRows.length === 1 ? "" : "s"} extracted from this document.
                                  </div>
                                </div>
                                <div
                                  className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                                    activeTermsIssues.length > 0
                                      ? "border-amber-200 bg-amber-50 text-amber-700"
                                      : "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  }`}
                                >
                                  {activeTermsIssues.length > 0 ? (
                                    <TriangleAlert className="h-3.5 w-3.5" />
                                  ) : (
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                  )}
                                  {activeTermsIssues.length > 0
                                    ? `${activeTermsIssues.length} issue${activeTermsIssues.length === 1 ? "" : "s"} flagged`
                                    : "No issue flagged"}
                                </div>
                              </div>

                              <div className="divide-y divide-slate-100">
                                {activeTermsChecklistRows.map((row) => {
                                  const StatusIcon = row.status.icon;

                                  return (
                                    <div
                                      key={row.key}
                                      className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
                                    >
                                      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                                        {row.label}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="whitespace-pre-wrap break-words text-xs font-medium leading-snug text-slate-900">
                                          {row.value}
                                        </div>
                                        {row.detail ? (
                                          <div className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                                            {row.detail}
                                          </div>
                                        ) : null}
                                        {row.evidence ? (
                                          <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs font-medium leading-relaxed text-slate-700">
                                            {row.evidence}
                                          </div>
                                        ) : null}
                                        {row.issue?.analysis ? (
                                          <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium leading-relaxed text-amber-800">
                                            {row.issue.analysis}
                                          </div>
                                        ) : null}
                                      </div>
                                      <div
                                        className={`inline-flex h-fit w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${row.status.className}`}
                                      >
                                        <StatusIcon className="h-3.5 w-3.5" />
                                        {row.status.label}
                                      </div>
                                    </div>
                                  );
                                })}

                                {unmatchedTermsIssues.map((issue) => {
                                  const status = getTermsIssueStatus(issue);
                                  const StatusIcon = status.icon;
                                  const issueText =
                                    issue.analysis ||
                                    issue.fixPlan ||
                                    getTermsIssueText(issue) ||
                                    "Terms issue requires review.";

                                  return (
                                    <div
                                      key={issue.id}
                                      className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
                                    >
                                      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                                        Review Item
                                      </div>
                                      <div className="min-w-0 whitespace-pre-wrap break-words text-xs font-medium leading-snug text-slate-900">
                                        {issueText}
                                      </div>
                                      <div
                                        className={`inline-flex h-fit w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${status.className}`}
                                      >
                                        <StatusIcon className="h-3.5 w-3.5" />
                                        {status.label}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {activeDocumentFieldEntries.length > 0 ? (
                            <div className="flex flex-col overflow-hidden rounded-xl border border-slate-100 text-sm shadow-sm">
                              {activeDocumentFieldEntries.map(([key, value], index) => {
                                const currentValue = typeof value === "string" ? value : displayValue(value);

                                return (
                                  <div key={key} className={`flex flex-col bg-white px-3 py-2.5 transition-colors hover:bg-slate-50/50 sm:grid sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-start sm:gap-4 sm:px-4 sm:py-3 ${index !== activeDocumentFieldEntries.length - 1 ? 'border-b border-slate-100' : ''}`}>
                                    <div className="mb-1 w-full pr-4 sm:mb-0">
                                      <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500">
                                        {getDocumentFieldLabel(activeDocument?.documentType, key)}
                                      </div>
                                    </div>
                                    <div className="w-full break-words text-sm font-medium leading-snug text-slate-900">
                                      {currentValue || <span className="font-normal italic text-slate-300">Not detected</span>}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          ) : null}
                        </div>
                      ) : activeDataView === "fields" ? (
                        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-medium text-slate-500">
                          No scalar fields were extracted for this document.
                        </div>
                      ) : null}

                      {activeDataView === "lineItems" && activeDocumentLineItems.length > 0 && (
                        <div className="rounded-xl border border-slate-100 bg-white shadow-sm">
                          <div className="flex flex-col gap-1 border-b border-slate-100 px-4 py-2.5">
                            <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                              Line Items
                            </div>
                            <div className="text-xs font-medium text-slate-700">
                              {activeDocumentLineItems.length} row{activeDocumentLineItems.length === 1 ? "" : "s"} extracted from the document table.
                            </div>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full min-w-[760px] border-collapse text-left text-xs sm:text-sm">
                              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                                <tr>
                                  {activeDocumentLineItemColumns.map((column) => (
                                    <th
                                      key={column.key}
                                      className={`border-b border-slate-100 px-3 py-2 font-medium ${column.className ?? ""}`}
                                    >
                                      {column.label}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {activeDocumentLineItems.map((item, itemIndex) => (
                                  <tr key={`${item.lineNumber ?? itemIndex}-${item.description ?? item.rawText ?? ""}`} className="border-b border-slate-100 last:border-0">
                                    {activeDocumentLineItemColumns.map((column) => {
                                      const value =
                                        column.key === "lineNumber"
                                          ? getLineItemValue(item, column.key) || String(itemIndex + 1)
                                          : getLineItemValue(item, column.key);

                                      return (
                                        <td
                                          key={column.key}
                                          className={`align-top px-3 py-3 font-medium text-slate-800 ${column.className ?? ""}`}
                                        >
                                          {value ? String(value) : <span className="text-slate-300">-</span>}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      {activeDataView === "lineItems" && activeDocumentLineItems.length === 0 && (
                        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-medium text-slate-500">
                          No line-item table was extracted for this document.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

          </main>
        </div>

        {/* Mobile Sticky Action Bar */}
        {showActions && (
          <div
            className="fixed left-0 right-0 z-[90] flex items-center gap-3 border-t border-slate-200 bg-white p-3 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] md:hidden"
            style={{ bottom: "calc(5.25rem + env(safe-area-inset-bottom))" }}
          >
            <Button
              variant="outline"
              className="flex-1 rounded-xl text-rose-600 hover:bg-rose-50 hover:text-rose-700 border-slate-200 shadow-sm h-12 font-medium"
              disabled={decisionStatus === "updating"}
              onClick={() => handleCaseDecision("rejected")}
            >
              <X className="h-5 w-5 mr-2" /> Reject
            </Button>
            <Button
              className="flex-1 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm h-12 font-medium"
              disabled={decisionStatus === "updating"}
              onClick={() => handleCaseDecision("accepted")}
            >
              {decisionStatus === "updating" ? (
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
              ) : (
                <Check className="h-5 w-5 mr-2" />
              )}
              Accept
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
