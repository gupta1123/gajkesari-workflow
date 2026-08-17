"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  FileText,
  Info,
  Lightbulb,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getComparableFieldValue,
  getComparisonDisplayLabel,
  isPrimaryComparisonField,
  pickCanonicalComparableValue,
  readComparisonOptions,
} from "@/lib/comparison";
import {
  ACTIVE_FIELD_DEFINITIONS,
  shouldConsiderFieldKey,
} from "@/lib/document-schema";
import { fetchCaseDetail, type SavedCaseDetail } from "@/lib/case-persistence";
import type { DocType, FieldKey } from "@/types/pipeline";

type LoadState = "loading" | "ready" | "error";
type MismatchRecord = SavedCaseDetail["mismatches"][number];

const FIELD_LABEL_LOOKUP = ACTIVE_FIELD_DEFINITIONS.reduce(
  (acc, field) => {
    acc[field.key] = field.label;
    return acc;
  },
  {} as Record<string, string>
);

const FIELD_GROUPS = {
  weight: ["grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit"],
  party: [
    "vendorName",
    "supplierGstin",
    "buyerName",
    "buyerGstin",
    "ownerName",
    "driverName",
    "holderName",
    "fatherName",
    "panNumber",
  ],
};

function getGroupForField(field: string): string | null {
  for (const [groupName, fields] of Object.entries(FIELD_GROUPS)) {
    if (fields.includes(field)) return groupName;
  }
  return null;
}

function getFieldsInGroup(field: string): string[] {
  const group = getGroupForField(field);
  return group ? FIELD_GROUPS[group as keyof typeof FIELD_GROUPS] : [];
}

const FIELD_GUIDANCE: Array<{
  fields: string[];
  why: string;
  steps: string[];
}> = [
    {
      fields: ["poNumber", "referencePoNumber"],
      why: "These documents may be linked to different purchase orders.",
      steps: [
        "Confirm the approved PO number.",
        "Correct the document that has the wrong PO reference.",
        "Run analysis again after updating the file.",
      ],
    },
    {
      fields: ["invoiceNumber", "referenceInvoiceNumber", "receiptNumber"],
      why: "The invoice or receipt reference may point to the wrong bill.",
      steps: [
        "Confirm the correct invoice number from the supplier invoice.",
        "Correct the receipt or support document using the wrong invoice reference.",
        "Run analysis again before accepting the case.",
      ],
    },
    {
      fields: ["totalAmount", "subtotal", "taxAmount", "paidAmount", "statementAmount", "currency"],
      why: "The amount, tax, payment, or currency does not match across documents.",
      steps: [
        "Confirm the final bill amount and currency.",
        "Check whether tax or payment proof is using a different value.",
        "Correct the wrong document before approval.",
      ],
    },
    {
      fields: ["vehicleNumber", "registrationNumber", "lorryReceiptNumber", "fastagReference", "eWayBillNumber"],
      why: "The vehicle or transport proof may not belong to the same shipment.",
      steps: [
        "Confirm the vehicle actually used for this delivery.",
        "Check the invoice, e-way bill, LR, FASTag, and RC records.",
        "Replace or correct the document with the wrong transport detail.",
      ],
    },
    {
      fields: ["grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit"],
      why: "The quantity or weighment proof does not match the billing document.",
      steps: [
        "Compare the invoice quantity with the delivery and weighment documents.",
        "Confirm which value should be used for billing.",
        "Correct the wrong file and re-run analysis.",
      ],
    },
    {
      fields: [
        "vendorName",
        "supplierGstin",
        "buyerName",
        "buyerGstin",
        "ownerName",
        "driverName",
        "holderName",
        "fatherName",
        "panNumber",
      ],
      why: "One document may have the wrong party, GSTIN, or identity detail.",
      steps: [
        "Confirm the correct sender, receiver, GSTIN, or identity detail.",
        "Check the source document where the value came from.",
        "Correct the document that has the wrong party information.",
      ],
    },
  ];

function getFieldLabel(fieldName: string) {
  return getComparisonDisplayLabel(fieldName, FIELD_LABEL_LOOKUP[fieldName]);
}

function getGuidance(fieldName: string) {
  return (
    FIELD_GUIDANCE.find((item) => item.fields.includes(fieldName)) ?? {
      why: "The same field has different values in different documents.",
      steps: [
        "Open the source documents shown above.",
        "Confirm which value is correct.",
        "Correct or replace the document with the wrong value.",
      ],
    }
  );
}

function getValueCount(mismatch: MismatchRecord) {
  return (mismatch.values ?? []).filter(
    (entry) => entry.value !== null && entry.value !== undefined && String(entry.value).trim().length > 0
  ).length;
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-400 italic font-normal">Missing</span>;
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function getDocumentName(
  documentLookup: Map<string, SavedCaseDetail["documents"][number]>,
  docId: string | undefined,
  fallback: string
) {
  if (!docId) return fallback;
  const document = documentLookup.get(docId);
  return document?.title || document?.sourceFileName || document?.sourceHint || fallback;
}

type GroupedMismatch = {
  groupName: string;
  groupLabel: string;
  fields: Array<{
    fieldName: string;
    fieldLabel: string;
    values: Array<{ docId: string | undefined; value: unknown }>;
  }>;
};

function buildGroupedMismatch(
  activeMismatch: MismatchRecord,
  documentLookup: Map<string, SavedCaseDetail["documents"][number]>
): GroupedMismatch | null {
  const group = getGroupForField(activeMismatch.fieldName);
  if (!group) return null;

  const fields = getFieldsInGroup(activeMismatch.fieldName);
  const groupLabel = group === "weight" ? "Weight / Quantity" : "Party / Identity Details";

  const result: GroupedMismatch = {
    groupName: group,
    groupLabel,
    fields: fields.map((fieldName) => ({
      fieldName,
      fieldLabel: getFieldLabel(fieldName),
      values: [],
    })),
  };

  const docIds = new Set<string>();
  (activeMismatch.values ?? []).forEach((v) => {
    if (v.docId) docIds.add(v.docId);
  });

  result.fields.forEach((field) => {
    field.values = Array.from(docIds).map((docId) => {
      const doc = documentLookup.get(docId);
      const extractedFields = doc?.extractedFields as Record<string, unknown> | undefined;
      return { docId, value: extractedFields?.[field.fieldName] };
    });
  });

  return result;
}

function GroupedMismatchTable({ grouped, documentLookup }: { grouped: GroupedMismatch; documentLookup: Map<string, SavedCaseDetail["documents"][number]> }) {
  const docIds = grouped.fields[0]?.values.map((v) => v.docId) ?? [];

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-900">{grouped.groupLabel}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wider">Field</th>
              {docIds.map((docId) => {
                const doc = documentLookup.get(docId ?? "");
                return (
                  <th key={docId} className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wider">
                    {doc?.title || doc?.sourceFileName || `Doc ${docId}`}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {grouped.fields.map((field) => (
              <tr key={field.fieldName} className="hover:bg-slate-50/50">
                <td className="px-4 py-2.5 font-medium text-slate-700 whitespace-nowrap">{field.fieldLabel}</td>
                {field.values.map((val, idx) => (
                  <td key={idx} className="px-4 py-2.5 text-slate-900">
                    {val.value === null || val.value === undefined || val.value === "" ? (
                      <span className="text-slate-400 italic">Missing</span>
                    ) : (
                      String(val.value)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-4">
            <Skeleton className="h-4 w-36 bg-indigo-100" />
            <Skeleton className="mt-2 h-3 w-64 max-w-full bg-indigo-100" />
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

  const visibleMismatches = useMemo(
    () =>
      detail?.mismatches.filter(
        (mismatch) =>
          shouldConsiderFieldKey(mismatch.fieldName) && isPrimaryComparisonField(mismatch.fieldName)
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

  const comparisonOptions = useMemo(
    () =>
      readComparisonOptions(
        detail?.case.processingMeta && typeof detail.case.processingMeta === "object"
          ? (detail.case.processingMeta as Record<string, unknown>).comparisonOptions
          : undefined
      ),
    [detail]
  );

  const fieldCanonicalValues = useMemo(() => {
    if (!detail) return {} as Record<string, string>;
    const result: Record<string, string> = {};
    const comparableDocuments = detail.documents.map((document) => ({
      type: document.documentType as DocType,
      fields: document.extractedFields as Partial<Record<FieldKey, string>>,
    }));

    ACTIVE_FIELD_DEFINITIONS.forEach(({ key }) => {
      const values = comparableDocuments
        .map((document) => getComparableFieldValue(document, key))
        .filter(
          (value): value is string =>
            value !== undefined && value !== null && String(value).trim().length > 0
        );
      result[key] = pickCanonicalComparableValue(values, comparisonOptions);
    });
    return result;
  }, [comparisonOptions, detail]);

  const activeMismatch = useMemo(() => {
    if (!activeMismatchId) return visibleMismatches[0] ?? null;
    return visibleMismatches.find((mismatch) => mismatch.id === activeMismatchId) ?? null;
  }, [activeMismatchId, visibleMismatches]);

  const groupedMismatch = useMemo(() => {
    if (!activeMismatch || !documentLookup) return null;
    return buildGroupedMismatch(activeMismatch, documentLookup);
  }, [activeMismatch, documentLookup]);

  const activeFieldLabel = activeMismatch ? getFieldLabel(activeMismatch.fieldName) : "";
  const activeGuidance = activeMismatch ? getGuidance(activeMismatch.fieldName) : null;

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
                <h1 className="truncate text-lg font-semibold tracking-tight text-slate-900">
                  {detail?.case.displayName}
                </h1>
              )}
              {detail && (
                <Badge
                  variant="secondary"
                  className="hidden sm:inline-flex bg-amber-100 text-amber-800 hover:bg-amber-100 border-transparent rounded-md px-2 py-0.5 shrink-0"
                >
                  {visibleMismatches.length} Issue{visibleMismatches.length === 1 ? "" : "s"}
                </Badge>
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
                <h3 className="text-lg font-semibold text-slate-900">Unable to load review</h3>
                <p className="mt-1 text-sm text-slate-500">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Main Content Layout */}
        {status === "ready" && detail && (
          <div className="flex flex-1 flex-col lg:flex-row min-h-0 overflow-hidden">

            {/* Sidebar / Mobile Tabs */}
            <aside className="flex flex-col shrink-0 border-b border-slate-200 bg-white lg:w-80 lg:border-b-0 lg:border-r z-0">

              {/* Desktop Only: Case Meta Summary */}
              <div className="hidden lg:block p-5 border-b border-slate-100">
                <div className="flex items-center gap-2 mb-4">
                  <Sparkles className="h-4 w-4 text-slate-400" />
                  <h2 className="text-sm font-semibold text-slate-800">Case Summary</h2>
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
                      <p className="text-xs font-medium text-amber-600">Conflicts</p>
                      <p className="text-sm font-medium text-amber-700">{visibleMismatches.length}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Mismatches List / Tabs */}
              <div className="flex-1 overflow-hidden flex flex-col bg-slate-50/50 lg:bg-white">
                <div className="px-4 py-3 lg:px-5 lg:py-4 border-b border-slate-100 flex items-center justify-between bg-white">
                  <h3 className="text-sm font-semibold text-slate-900">Issues to resolve</h3>
                </div>

                {visibleMismatches.length === 0 ? (
                  <div className="p-5 text-sm text-slate-500">
                    No conflicting values found.
                  </div>
                ) : (
                  <div className="flex gap-2 p-3 overflow-x-auto lg:p-0 lg:flex-col lg:overflow-y-auto lg:block hide-scrollbar [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none][scrollbar-width:none]">
                    {visibleMismatches.map((mismatch) => {
                      const isActive = activeMismatchId === mismatch.id;
                      const fieldLabel = getFieldLabel(mismatch.fieldName);

                      return (
                        <button
                          key={mismatch.id}
                          onClick={() => setActiveMismatchId(mismatch.id)}
                          className={`group relative flex items-center shrink-0 lg:w-full text-left transition-all ${isActive
                              ? "bg-amber-100 text-amber-900 lg:bg-amber-50/50 lg:text-slate-900 lg:border-l-[3px] lg:border-amber-500"
                              : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 lg:bg-transparent lg:border-0 lg:border-l-[3px] lg:border-transparent lg:hover:bg-slate-50"
                            } rounded-full lg:rounded-none px-4 py-2 lg:px-5 lg:py-3`}
                        >
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm truncate ${isActive ? 'font-semibold' : 'font-medium'}`}>
                              {fieldLabel}
                            </p>
                            <p className="hidden lg:block mt-0.5 text-xs text-slate-500 group-hover:text-slate-600">
                              {getValueCount(mismatch)} value{getValueCount(mismatch) === 1 ? "" : "s"} found
                            </p>
                          </div>
                          {isActive && (
                            <ChevronRight className="hidden lg:block h-4 w-4 text-amber-500 shrink-0 ml-3" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>

            {/* Main Detail Content */}
            <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
              <div className="mx-auto max-w-3xl">
                {visibleMismatches.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-2xl bg-white border border-slate-200 p-12 text-center shadow-sm mt-8">
                    <div className="h-16 w-16 rounded-full bg-emerald-100 flex items-center justify-center mb-4">
                      <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                    </div>
                    <h2 className="text-2xl font-bold text-slate-900">All clear</h2>
                    <p className="mt-2 text-slate-500">
                      No value conflicts were found across the documents in this case.
                    </p>
                  </div>
                ) : activeMismatch && activeGuidance ? (
                  <div className="space-y-6">

                    {/* Header for Active Issue */}
                    <div>
                      <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">
                        {activeFieldLabel}
                      </h2>
                      <p className="mt-1 text-sm text-slate-500">
                        Review the conflicting information across documents below.
                      </p>
                    </div>

                    {/* Conflicting Values Grid or Grouped Table */}
                    {groupedMismatch ? (
                      <GroupedMismatchTable grouped={groupedMismatch} documentLookup={documentLookup} />
                    ) : (
                      <div>
                        <h3 className="mb-3 text-sm font-semibold text-slate-900 flex items-center gap-2">
                          <FileText className="h-4 w-4 text-slate-400" />
                          Extracted Values
                        </h3>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {(activeMismatch.values ?? []).map((value, index) => {
                            const title = getDocumentName(documentLookup, value.docId, `Document ${index + 1}`);

                            return (
                              <div
                                key={`${activeMismatch.id}-${value.docId ?? index}`}
                                className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-all hover:shadow-md"
                              >
                                <div className="text-xs font-medium text-slate-500 mb-2 truncate" title={title}>
                                  {title}
                                </div>
                                <div className="text-sm font-semibold text-slate-900 break-words">
                                  {displayValue(value.value)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Canonical Value Suggestion (Compact) */}
                    {fieldCanonicalValues[activeMismatch.fieldName] && (
                      <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-indigo-100 bg-indigo-50/50 p-4">
                        <div className="flex flex-1 items-start gap-2.5">
                          <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
                          <div>
                            <h4 className="text-sm font-semibold text-indigo-900">Suggested Value</h4>
                            <p className="text-xs text-indigo-700/80 mt-0.5">
                              Computed from standard comparison rules. Verify before approval.
                            </p>
                          </div>
                        </div>
                        <div className="inline-flex items-center self-start sm:self-auto rounded-md border border-indigo-200 bg-white px-3 py-1.5 text-sm font-mono font-medium text-indigo-950 shadow-sm">
                          {fieldCanonicalValues[activeMismatch.fieldName]}
                        </div>
                      </div>
                    )}



                  </div>
                ) : (
                  <div className="flex h-[400px] items-center justify-center text-center text-sm text-slate-500">
                    Select an issue from the list to review conflicting values.
                  </div>
                )}
              </div>
            </main>
          </div>
        )}
      </div>
    </AppShell>
  );
}
