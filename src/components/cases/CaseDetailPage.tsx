"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  Loader2,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  Database,
  Check,
  X,
  FileDigit,
  FileSearch,
  ZoomIn,
  ZoomOut,
  RotateCw,
  type LucideIcon,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { AnalysisOptionsDialog } from "@/components/workspace/AnalysisOptionsDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  areComparableValuesEqual,
  getComparableFieldValue,
  isPrimaryComparisonField,
  pickCanonicalComparableValue,
  readComparisonOptions,
} from "@/lib/comparison";
import {
  ACTIVE_FIELD_DEFINITIONS,
  getFieldDefinitionsByKeys,
  getFieldDefinitionsForDocType,
  shouldConsiderFieldKey,
} from "@/lib/document-schema";
import {
  fetchCaseDetail,
  saveCaseAnalysis,
  updateCaseDecision,
  type CaseDecision,
  type SavedCaseDetail,
} from "@/lib/case-persistence";
import { CAMERA_SCAN_SOURCE, readUploadGroupMeta } from "@/lib/upload-groups";
import { orchestrateUploads } from "@/services/orchestration";
import type {
  ComparisonOptions,
  DocType,
  FieldKey,
  PipelineStageId,
  PipelineStageProgress,
  QueuedUpload,
} from "@/types/pipeline";

type LoadState = "loading" | "ready" | "error";
type ActiveTab = "preview" | "data" | "ocr";

const DETAIL_TABS: { id: ActiveTab; label: string; icon: LucideIcon }[] = [
  { id: "preview", label: "Original", icon: Eye },
  { id: "data", label: "Data", icon: Database },
  { id: "ocr", label: "Text", icon: FileDigit },
];

const STAGE_SEQUENCE: PipelineStageId[] = [
  "upload_received",
  "classifying",
  "ocr",
  "extracting",
  "validating",
  "complete",
];

const FIELD_LABEL_LOOKUP = ACTIVE_FIELD_DEFINITIONS.reduce(
  (acc, field) => {
    acc[field.key] = field.label;
    return acc;
  },
  {} as Record<string, string>
);

function getOrderedDocumentEntries(
  documentType: string,
  extractedFields: Record<string, unknown>
) {
  const visibleEntries = Object.entries(extractedFields).filter(
    ([, value]) => value !== null && value !== undefined && value !== ""
  );
  const relevantDefinitions = getFieldDefinitionsForDocType(documentType);
  const relevantKeys = relevantDefinitions.map(({ key }) => key);
  const relevantKeySet = new Set(relevantKeys);
  const remainingKeys = visibleEntries
    .map(([key]) => key)
    .filter((key) => !relevantKeySet.has(key as (typeof relevantKeys)[number]));

  return getFieldDefinitionsByKeys([...relevantKeys, ...remainingKeys]).flatMap(({ key }) => {
    const value = extractedFields[key];
    if (value === null || value === undefined || value === "") {
      return [];
    }
    return [[key, value] as [string, unknown]];
  });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

function formatCaseSubject(category: string) {
  return /packet$/i.test(category.trim()) ? category.trim() : `${category} Packet`;
}

function getCaseStatusLabel(status: string) {
  if (status === "draft") return "Draft";
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  if (status === "failed") return "Failed";
  if (status === "processing") return "Processing";
  if (status === "completed") return "Completed";
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

function buildInitialStages(): PipelineStageProgress[] {
  return STAGE_SEQUENCE.map((stage, index) => ({
    stage,
    status: index === 0 ? "active" : "pending",
    startedAt: index === 0 ? Date.now() : undefined,
  }));
}

async function savedFileToUploadFile(file: SavedCaseDetail["files"][number]) {
  if (!file.signedUrl) {
    throw new Error(`Unable to access ${file.originalName}. Please refresh and try again.`);
  }

  const response = await fetch(file.signedUrl);
  if (!response.ok) {
    throw new Error(`Unable to download ${file.originalName} for analysis.`);
  }

  const blob = await response.blob();
  const uploadFile = new File([blob], file.originalName, {
    type: file.mimeType || blob.type || "application/pdf",
  });

  return uploadFile;
}

async function savedFileToUpload(
  file: SavedCaseDetail["files"][number],
  index: number
): Promise<QueuedUpload> {
  const uploadFile = await savedFileToUploadFile(file);

  return {
    id: `${file.id}-${index}`,
    name: file.originalName,
    file: uploadFile,
    files: [uploadFile],
    source: "file",
    stages: buildInitialStages(),
  };
}

async function savedDetailToUploads(detail: SavedCaseDetail): Promise<QueuedUpload[]> {
  const uploadGroups = readUploadGroupMeta(detail.case.processingMeta?.uploadGroups);
  const uploads: QueuedUpload[] = [];
  const usedFileIds = new Set<string>();

  for (const group of uploadGroups) {
    const groupFiles = group.fileNames
      .map((fileName) => detail.files.find((file) => !usedFileIds.has(file.id) && normalizeText(file.originalName) === normalizeText(fileName)))
      .filter((file): file is SavedCaseDetail["files"][number] => Boolean(file));

    if (!groupFiles.length) {
      continue;
    }

    groupFiles.forEach((file) => usedFileIds.add(file.id));
    const files = await Promise.all(groupFiles.map(savedFileToUploadFile));

    uploads.push({
      id: group.id,
      name: group.name,
      file: files[0],
      files,
      source: group.source ?? CAMERA_SCAN_SOURCE,
      stages: buildInitialStages(),
    });
  }

  const remainingUploads = await Promise.all(
    detail.files
      .filter((file) => !usedFileIds.has(file.id))
      .map((file, index) => savedFileToUpload(file, uploads.length + index))
  );

  return [...uploads, ...remainingUploads];
}

function CaseDetailSkeleton() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-1 flex-col overflow-hidden bg-[#fafafa]">
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
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "processing" | "saving" | "error">("idle");
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisOptionsOpen, setAnalysisOptionsOpen] = useState(false);
  const [decisionStatus, setDecisionStatus] = useState<"idle" | "updating" | "error">("idle");
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("preview");
  const [previewPageIndex, setPreviewPageIndex] = useState(0);
  const [previewZoom, setPreviewZoom] = useState(1);

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
    if (!detail) return;
    setActiveDocumentId((current) => {
      if (current && detail.documents.some((document) => document.id === current)) {
        return current;
      }
      return detail.documents[0]?.id ?? null;
    });
  }, [detail]);

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
    return detail.documents.find((document) => document.id === activeDocumentId) ?? null;
  }, [detail, activeDocumentId]);

  const visibleMismatches = useMemo(
    () =>
      detail?.mismatches.filter(
        (mismatch) =>
          shouldConsiderFieldKey(mismatch.fieldName) && isPrimaryComparisonField(mismatch.fieldName)
      ) ?? [],
    [detail]
  );

  const activeDocumentEntries = useMemo(() => {
    if (!activeDocument) return [];
    return getOrderedDocumentEntries(activeDocument.documentType, activeDocument.extractedFields);
  }, [activeDocument]);

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
  const activeFileUrl = activePreviewFile?.signedUrl ?? null;
  const previewPageCount = activeDocumentFiles.length || activeDocument?.pageCount || 1;
  const activeSourceLabel = getSourceFileLabel(
    activePreviewFile?.mimeType,
    activePreviewFile?.originalName || activeDocument?.sourceFileName
  );
  const activeSourceIsImage = isImageSourceFile(
    activePreviewFile?.mimeType,
    activePreviewFile?.originalName || activeDocument?.sourceFileName || activeDocument?.sourceHint
  );
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

  async function handleAnalyzeDraftCase(comparisonOptions: ComparisonOptions) {
    if (!detail || detail.files.length === 0) return;

    try {
      setAnalysisStatus("processing");
      setAnalysisError(null);
      setAnalysisProgress(5);

      const uploads = await savedDetailToUploads(detail);
      const totalStageEvents = Math.max(1, uploads.length * STAGE_SEQUENCE.length);
      let stageEvents = 0;

      const result = await orchestrateUploads(
        uploads,
        () => {
          stageEvents += 1;
          setAnalysisProgress(Math.min(90, Math.round((stageEvents / totalStageEvents) * 90)));
        },
        comparisonOptions
      );

      setAnalysisStatus("saving");
      setAnalysisProgress(95);
      await saveCaseAnalysis(detail.case.id, {
        ...result,
        comparisonOptions,
      });
      const refreshed = await fetchCaseDetail(detail.case.id);
      setDetail(refreshed);
      setAnalysisProgress(100);
      setAnalysisStatus("idle");
    } catch (analysisFailure) {
      setAnalysisError(
        analysisFailure instanceof Error ? analysisFailure.message : "Failed to analyze this case."
      );
      setAnalysisStatus("error");
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
        <div className="flex flex-1 items-center justify-center bg-slate-50/50 p-6 min-h-[calc(100vh-4rem)]">
          <div className="w-full max-w-md flex flex-col items-center text-center bg-white p-8 rounded-3xl shadow-sm border border-slate-200">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-50 mb-4">
              <ShieldAlert className="h-8 w-8 text-red-500" />
            </div>
            <h3 className="text-xl font-semibold text-slate-900">Unable to load case</h3>
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
  if (status === "ready" && detail?.case.status === "draft") {
    const isAnalyzing = analysisStatus === "processing" || analysisStatus === "saving";

    return (
      <AppShell>
        <div className="flex flex-1 flex-col bg-[#fafafa] animate-in fade-in duration-500 min-h-[calc(100vh-4rem)]">
          <header className="flex h-14 sm:h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
            <div className="flex items-center gap-3 sm:gap-4 w-full">
              <Link href="/cases" className="text-slate-400 hover:text-slate-800 transition-colors shrink-0">
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <h1 className="text-base sm:text-lg font-semibold text-slate-900 truncate pr-2">
                {detail.case.displayName}
              </h1>
              <Badge variant="outline" className={`ml-auto rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider shrink-0 ${getCaseStatusClassName(detail.case.status)}`}>
                {getCaseStatusLabel(detail.case.status)}
              </Badge>
            </div>
          </header>

          <main className="flex-1 flex flex-col items-center justify-center p-4 py-8 sm:p-6 sm:py-24">
            <div className="w-full max-w-2xl bg-white rounded-3xl shadow-sm border border-slate-200 p-6 sm:p-12 text-center">
              <div className="mx-auto flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-full bg-indigo-50 mb-5 sm:mb-6">
                <FileSearch className="h-8 w-8 sm:h-10 sm:w-10 text-indigo-600" />
              </div>
              <h2 className="text-xl sm:text-3xl font-bold tracking-tight text-slate-900 mb-3 sm:mb-4">
                Ready for AI Analysis
              </h2>
              <p className="text-sm sm:text-base text-slate-600 mb-6 sm:mb-8 max-w-lg mx-auto leading-relaxed">
                {detail.files.length} document{detail.files.length !== 1 && 's'} securely uploaded. Run the analysis engine to extract critical fields, reconcile data, and highlight discrepancies.
              </p>

              {isAnalyzing ? (
                <div className="w-full max-w-md mx-auto space-y-3 text-left">
                  <div className="flex items-center justify-between text-xs sm:text-sm font-semibold text-slate-700">
                    <span>{analysisStatus === "saving" ? "Finalizing results..." : "Analyzing documents..."}</span>
                    <span>{analysisProgress}%</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-indigo-600 transition-all duration-300 ease-out" style={{ width: `${analysisProgress}%` }} />
                  </div>
                </div>
              ) : (
                <Button
                  size="lg"
                  disabled={detail.files.length === 0}
                  className="rounded-xl w-full sm:w-auto bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-6 text-base font-semibold shadow-md shadow-indigo-600/20 transition-transform hover:scale-[1.02]"
                  onClick={() => setAnalysisOptionsOpen(true)}
                >
                  <Sparkles className="mr-2 h-5 w-5" /> Analyze Case
                </Button>
              )}

              {analysisStatus === "error" && analysisError && (
                <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700 text-left">
                  {analysisError}
                </div>
              )}
            </div>

            {/* Document list minimal view */}
            {!isAnalyzing && detail.files.length > 0 && (
              <div className="w-full max-w-2xl mt-8">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 px-1">Uploaded Files ({detail.files.length})</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
                  {detail.files.map((file) => (
                    <div key={file.id} className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
                      <div className="h-8 w-8 rounded-lg bg-slate-100 text-slate-400 flex items-center justify-center shrink-0">
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">{file.originalName}</p>
                        <p className="text-xs text-slate-500">{file.sizeBytes ? `${Math.round(file.sizeBytes / 1024)} KB` : "File"}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </main>

          <AnalysisOptionsDialog
            open={analysisOptionsOpen}
            onOpenChange={setAnalysisOptionsOpen}
            onSelect={(nextOptions) => {
              setAnalysisOptionsOpen(false);
              void handleAnalyzeDraftCase(nextOptions);
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

  return (
    <AppShell>
      <div
        className={`relative flex min-h-[calc(100vh-4rem)] flex-1 flex-col overflow-hidden bg-[#fafafa] animate-in fade-in duration-300 ${
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
              <h1 className="text-xs sm:text-base font-bold text-slate-900 truncate">
                {detail?.case.displayName}
              </h1>
            </div>
          </div>

          {/* Action Area (Desktop) */}
          <div className="hidden md:flex items-center gap-3 shrink-0">
            <Badge variant="outline" className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${getCaseStatusClassName(detail?.case.status || "")}`}>
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

        {/* Mobile AI Alert Banner (Extremely Compact) */}
        {visibleMismatches.length > 0 && (
          <div className="md:hidden bg-rose-50 border-b border-rose-100 py-2.5 px-4 flex items-center justify-between shrink-0 z-10 relative">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="bg-rose-100 p-1 rounded-full shrink-0">
                <TriangleAlert className="h-4 w-4 text-rose-600" />
              </div>
              <h3 className="text-[11px] font-extrabold text-rose-900 uppercase tracking-tight">{visibleMismatches.length} Issues Found</h3>
            </div>
            <Button asChild size="sm" variant="ghost" className="h-8 text-[10px] bg-rose-600 hover:bg-rose-700 text-white rounded-lg px-4 shrink-0 font-bold uppercase tracking-wider shadow-sm">
              <Link href={`/cases/${caseId}/mismatches`}>Review</Link>
            </Button>
          </div>
        )}

        {/* Main Content Split */}
        <div className="flex flex-1 min-h-0 relative">

          {/* Left Sidebar (Desktop only) */}
          <aside className="hidden w-[20rem] shrink-0 overflow-hidden border-r border-slate-200 bg-[#fafafa] md:flex md:flex-col xl:w-[22rem]">
            <ScrollArea className="min-w-0 flex-1">
              <div className="min-w-0 space-y-5 p-5">

                {/* Unified AI Summary & Metadata Card */}
                {detail && (
                  <div className={`flex w-full max-w-full flex-col overflow-hidden rounded-2xl border shadow-sm ${visibleMismatches.length === 0 ? 'border-emerald-200' : 'border-rose-200'}`}>

                    {/* Status Header Area */}
                    <div className={`p-5 ${visibleMismatches.length === 0 ? 'bg-emerald-50/50' : 'bg-rose-50/50'}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <div className={`rounded-full p-1.5 shadow-sm ${visibleMismatches.length === 0 ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600'}`}>
                          {visibleMismatches.length === 0 ? <CheckCircle2 className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
                        </div>
                        <h3 className={`text-sm font-bold ${visibleMismatches.length === 0 ? 'text-emerald-900' : 'text-rose-900'}`}>
                          {visibleMismatches.length === 0 ? 'Data Reconciled' : 'Discrepancies Found'}
                        </h3>
                      </div>

                      <p className={`text-sm leading-relaxed break-words ${visibleMismatches.length === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {visibleMismatches.length === 0
                          ? `${detail.documents.length} document${detail.documents.length === 1 ? "" : "s"} checked. Key extracted values match across this case.`
                          : `${visibleMismatches.length} issue${visibleMismatches.length === 1 ? "" : "s"} found across ${detail.documents.length} document${detail.documents.length === 1 ? "" : "s"}. Review is recommended.`}
                      </p>

                      {/* Mismatches Action Button */}
                      {visibleMismatches.length > 0 && (
                        <Button asChild className="w-full mt-4 bg-rose-600 hover:bg-rose-700 text-white shadow-sm font-semibold h-10">
                          <Link href={`/cases/${caseId}/mismatches`}>
                            <TriangleAlert className="h-4 w-4 mr-2" />
                            Review {visibleMismatches.length} Issue{visibleMismatches.length !== 1 && 's'}
                          </Link>
                        </Button>
                      )}

                      {visibleMismatches.length === 0 && (
                        <div className="mt-4 flex items-center justify-center gap-2 text-xs font-semibold text-emerald-600 bg-emerald-100/50 py-2 rounded-lg border border-emerald-100">
                          <Sparkles className="h-3.5 w-3.5" /> High Confidence
                        </div>
                      )}
                    </div>

                    {/* Metadata Grid */}
                    <div className="border-t border-slate-100 bg-white p-5">
                      <div className="grid grid-cols-1 gap-4 text-sm">
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 block mb-1">Subject</span>
                          <span className="text-slate-900 font-medium leading-snug break-words">{formatCaseSubject(detail.case.category)}</span>
                        </div>
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 block mb-1">Uploaded</span>
                          <span className="text-slate-900 font-medium leading-snug break-words">{formatDateTime(detail.case.createdAt)}</span>
                        </div>

                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 block mb-1">Receiver</span>
                          <span className="text-slate-900 font-medium leading-snug break-words">{detail.case.receiverName || "—"}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Documents List */}
                <div>
                  <div className="flex items-center justify-between mb-3 px-1">
                    <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Documents in Packet</h3>
                    <span className="rounded-full bg-slate-200/50 px-2 py-0.5 text-[10px] font-bold text-slate-500">{detail?.documents.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {detail?.documents.map((doc) => {
                      const isActive = activeDocumentId === doc.id;
                      return (
                        <button
                          key={doc.id}
                          onClick={() => setActiveDocumentId(doc.id)}
                          className={`flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-xl px-3 py-3 text-left transition-all ${isActive ? 'bg-white shadow-sm border border-slate-200 ring-1 ring-slate-200' : 'hover:bg-slate-200/50 border border-transparent'
                            }`}
                        >
                          <div className={`shrink-0 h-8 w-8 rounded-lg flex items-center justify-center ${isActive ? 'bg-indigo-50 text-indigo-600' : 'bg-white text-slate-400 border border-slate-200'}`}>
                            <FileText className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <p className={`line-clamp-2 break-words text-sm font-bold leading-snug ${isActive ? 'text-slate-900' : 'text-slate-600'}`}>
                              {doc.title}
                            </p>
                            <p className="mt-1 truncate text-[10px] font-medium uppercase tracking-wider text-slate-400">
                              {doc.documentType}{doc.pageCount && doc.pageCount > 1 ? ` · ${doc.pageCount} pages` : ""}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

              </div>
            </ScrollArea>
          </aside>

          {/* Right Main Area (Document Viewer Card) */}
          <main className="flex-1 flex flex-col min-w-0 bg-[#fafafa] pt-2.5 px-2.5 pb-0 sm:p-4 md:p-6 lg:p-8 relative">

            {/* Mobile Document Selector (Horizontal scroll) */}
            <div className="md:hidden bg-white border border-[#e5ddd0] rounded-xl mb-3 p-1.5 shrink-0 z-10 relative overflow-hidden shadow-sm">
              <div className="flex overflow-x-auto gap-2 snap-x scrollbar-hide py-0.5 px-0.5">
                {detail?.documents.map((doc) => {
                  const isActive = activeDocumentId === doc.id;
                  return (
                    <button
                      key={doc.id}
                      onClick={() => setActiveDocumentId(doc.id)}
                      className={`snap-start shrink-0 flex flex-col items-center justify-center px-4 py-2 rounded-lg text-center transition-all border ${isActive 
                        ? 'bg-[#1a1a1a] border-slate-900 shadow-md text-white' 
                        : 'bg-[#f0ece6] border-[#e5ddd0] text-[#5a5046]'
                        }`}
                      style={{ minWidth: '130px' }}
                    >
                      <p className="font-bold text-[11px] truncate w-full">{doc.title}</p>
                      <p className={`text-[9px] font-bold opacity-60 truncate w-full uppercase tracking-tighter mt-0.5 ${isActive ? 'text-white' : 'text-[#8a7f72]'}`}>{doc.documentType}{doc.pageCount && doc.pageCount > 1 ? ` · ${doc.pageCount}p` : ""}</p>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* The Unified Card Container */}
            <div className="flex flex-col flex-1 bg-white sm:border border-slate-200 sm:rounded-2xl shadow-sm overflow-hidden mb-2 sm:mb-0">

              {/* Card Header (Tabs & Title) */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-2 sm:p-4 border-b border-slate-100 bg-white shrink-0">

                {/* Left Side: Title & Badge (Desktop Only) */}
                <div className="hidden sm:flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    {activeTab === 'preview' ? <Eye className="h-5 w-5 text-slate-500" /> : activeTab === 'data' ? <Database className="h-5 w-5 text-slate-500" /> : <FileDigit className="h-5 w-5 text-slate-500" />}
                    <h2 className="text-base font-bold text-slate-900">
                      {activeTab === 'preview' ? 'Preview' : activeTab === 'data' ? 'Extracted Data' : 'Raw Text'}
                    </h2>
                  </div>
                  <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[10px] uppercase font-bold text-slate-500 bg-slate-50 border-slate-200">
                    {activeTab === 'preview' ? activeSourceLabel : 'View'}
                  </Badge>
                </div>

                {/* Right Side: Segmented Control & Actions */}
                <div className="flex items-center justify-between sm:justify-end w-full sm:w-auto gap-3">

                  {/* Segmented Control */}
                  <div className="flex items-center bg-[#f0ece6] p-1.5 rounded-xl w-full sm:w-auto border border-[#e5ddd0]">
                    {DETAIL_TABS.map((tab) => {
                      const isActive = activeTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          onClick={() => setActiveTab(tab.id)}
                          className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-[11px] sm:text-sm font-bold transition-all ${isActive
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
                            src={`${activeFileUrl}#toolbar=0&navpanes=0`}
                            className="absolute inset-0 w-full h-full border-0 bg-white"
                            title="Document Preview"
                          />
                        )
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 gap-4 p-6 text-center">
                          <FileSearch className="w-12 h-12 opacity-50" />
                          <p className="text-sm font-medium">Source preview not available for this document.</p>
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
                          <div className="text-white text-[10px] sm:text-xs font-semibold px-2 flex items-center gap-1">
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
                    <div className="p-4 sm:p-8 max-w-4xl mx-auto pb-8">
                      {activeDocumentEntries.length === 0 ? (
                        <div className="py-12 text-center text-sm font-medium text-slate-500">
                          No specific fields extracted for this document type.
                        </div>
                      ) : (
                        <div className="flex flex-col text-sm border border-slate-100 rounded-xl overflow-hidden shadow-sm">
                          {activeDocumentEntries.map(([key, value], index) => {
                            const currentValue = typeof value === "string" ? value : displayValue(value);
                            const canonical = fieldCanonicalValues[key];
                            const ok = !canonical || areComparableValuesEqual(currentValue, canonical, comparisonOptions);

                            return (
                              <div key={key} className={`flex flex-col sm:flex-row sm:items-start p-3 sm:p-5 ${index !== activeDocumentEntries.length - 1 ? 'border-b border-slate-100' : ''} hover:bg-slate-50/50 transition-colors bg-white`}>
                                <div className="w-full sm:w-1/3 mb-1 sm:mb-0 pr-4">
                                  <div className="font-semibold text-slate-500 text-xs sm:text-sm uppercase sm:normal-case tracking-wider sm:tracking-normal flex items-center gap-2">
                                    {FIELD_LABEL_LOOKUP[key] || key}
                                    {!ok && (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-bold bg-rose-100 text-rose-700 uppercase tracking-wider shrink-0">
                                        Conflict
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="w-full sm:w-2/3 text-slate-900 font-medium sm:text-sm text-base break-words">
                                  {currentValue || <span className="text-slate-300 font-normal italic">Not detected</span>}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 3. OCR View */}
                {activeTab === 'ocr' && (
                  <div className="absolute inset-0 overflow-y-auto bg-slate-50 text-slate-800">
                    <div className="p-4 sm:p-8 max-w-4xl mx-auto font-mono text-[11px] sm:text-sm leading-relaxed whitespace-pre-wrap break-words">
                      <ReactMarkdown>
                        {activeDocument?.markdown || "No OCR transcription available."}
                      </ReactMarkdown>
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
              className="flex-1 rounded-xl text-rose-600 hover:bg-rose-50 hover:text-rose-700 border-slate-200 shadow-sm h-12 font-semibold"
              disabled={decisionStatus === "updating"}
              onClick={() => handleCaseDecision("rejected")}
            >
              <X className="h-5 w-5 mr-2" /> Reject
            </Button>
            <Button
              className="flex-1 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm h-12 font-semibold"
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
