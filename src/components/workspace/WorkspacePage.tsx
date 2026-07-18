"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AppShell } from "@/components/dashboard/AppShell";
import { AnalysisOptionsDialog } from "@/components/workspace/AnalysisOptionsDialog";
import { DuplicateUploadDialog } from "@/components/workspace/DuplicateUploadDialog";
import { summarizeCase } from "@/lib/case-summary";
import {
  constrainImageDimensions,
  normalizeUploadFiles,
} from "@/lib/client-image-upload";
import {
  areComparableValuesEqual,
  DEFAULT_COMPARISON_OPTIONS,
  getCommercialAmountValue,
  getComparableFieldValue,
  getComparisonDisplayLabel,
  getComparisonModeLabel,
  getPaymentEvidenceAmountValue,
  pickCanonicalComparableValue,
  PRIMARY_COMPARISON_FIELDS,
} from "@/lib/comparison";
import {
  appendCaseFiles,
  createDraftCase,
  updateCaseDecision,
  type CaseDecision,
} from "@/lib/case-persistence";
import {
  CAMERA_SCAN_SOURCE,
  getQueuedUploadFiles,
  getQueuedUploadPageCount,
  getQueuedUploadPrimaryFile,
} from "@/lib/upload-groups";
import { useDocumentPipeline, type DuplicateUploadConflict, type DuplicateUploadStrategy } from "@/hooks/useDocumentPipeline";
import {
  Camera,
  CheckCircle2,
  Eye,
  FileText,
  Folder,
  FolderPlus,
  GitCompare,
  ImagePlus,
  Loader2,
  Play,
  Sparkles,
  TriangleAlert,
  Trash2,
  Plus,
  ArrowLeft,
  UploadCloud,
  Database
} from "lucide-react";
import type {
  CaseDoc,
  ComparisonOptions,
  DocType,
  FieldKey,
  PipelineStageId,
  QueuedUpload,
} from "@/types/pipeline";
import {
  ACTIVE_FIELD_DEFINITIONS,
  getEnabledCorePacketGroups,
  getFieldDefinitionsByKeys,
  getFieldDefinitionsForDocType,
  getFieldKeysForDocType,
  shouldConsiderFieldKey,
} from "@/lib/document-schema";
import { SAMPLE_DOCS, matchSampleByIndex } from "@/services/templates";

// ------------------------------------------------------------
// Dummy data & types
// ------------------------------------------------------------

type FieldSummary = {
  canonical: string;
  values: Record<string, string>;
  mismatchingDocs: string[];
};

type FieldMismatch = {
  field: FieldKey;
  label: string;
  canonical: string;
  mismatchingDocs: string[];
  values: Array<{ docId: string; value: string | number | null | undefined }>;
};

const DUMMY_DOCS: CaseDoc[] = SAMPLE_DOCS;
const ALL_FIELDS = ACTIVE_FIELD_DEFINITIONS;
const DOCUMENT_UPLOAD_ACCEPT = "application/pdf,image/*";
const IMAGE_UPLOAD_ACCEPT = "image/*";

const FIELD_LABEL_LOOKUP: Record<string, string> = ACTIVE_FIELD_DEFINITIONS.reduce(
  (acc, { key, label }) => {
    acc[key] = label;
    return acc;
  },
  {} as Record<string, string>
);

// ------------------------------------------------------------
// Utility helpers
// ------------------------------------------------------------

const STAGE_META: Record<PipelineStageId, { label: string; description: string }> = {
  upload_received: {
    label: "Upload received",
    description: "File added to processing queue.",
  },
  classifying: {
    label: "Classifying document type",
    description: "Matching against procurement document templates.",
  },
  ocr: {
    label: "Digitizing page images",
    description: "Running OCR and layout detection on every page.",
  },
  extracting: {
    label: "Extracting key fields",
    description: "Parsing document numbers, vendors, buyers, quantities, and amounts.",
  },
  validating: {
    label: "Reconciling & validating",
    description: "Cross-checking values across documents and business rules.",
  },
  complete: {
    label: "Complete",
    description: "Document passed validation.",
  },
  failed: {
    label: "Failed",
    description: "Processing stopped due to an error.",
  },
};

const PIPELINE_STAGES: Array<{
  id: PipelineStageId;
  label: string;
  description: string;
  start: number;
  end: number;
}> = [
    {
      id: "classifying",
      label: STAGE_META.classifying.label,
      description: STAGE_META.classifying.description,
      start: 0,
      end: 0.25,
    },
    {
      id: "ocr",
      label: STAGE_META.ocr.label,
      description: STAGE_META.ocr.description,
      start: 0.25,
      end: 0.55,
    },
    {
      id: "extracting",
      label: STAGE_META.extracting.label,
      description: STAGE_META.extracting.description,
      start: 0.55,
      end: 0.85,
    },
    {
      id: "validating",
      label: STAGE_META.validating.label,
      description: STAGE_META.validating.description,
      start: 0.85,
      end: 1,
    },
  ];

function currencyishToNumber(v?: string) {
  if (!v) return undefined;
  const n = Number(v.replace(/[₹,\s]/g, ""));
  return isNaN(n) ? undefined : n;
}

function getDocumentFieldDefinitions(doc: CaseDoc) {
  const relevantKeys = getFieldKeysForDocType(doc.type);
  const presentKeys = ALL_FIELDS.filter(({ key }) => Boolean(doc.fields[key])).map(
    ({ key }) => key
  );
  const orderedKeys = [...new Set<FieldKey>([...relevantKeys, ...presentKeys])];

  if (orderedKeys.length === 0) {
    return getFieldDefinitionsForDocType(doc.type);
  }

  return getFieldDefinitionsByKeys(orderedKeys);
}

function getSourceFileLabel(mimeType?: string | null, sourceName?: string) {
  if (mimeType?.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "PDF";
  if (sourceName && /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(sourceName)) return "Image";
  if (sourceName && /\.pdf$/i.test(sourceName)) return "PDF";
  return "File";
}

function isImageSource(mimeType?: string | null, sourceName?: string | null) {
  return (
    Boolean(mimeType?.startsWith("image/")) ||
    Boolean(sourceName && /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(sourceName))
  );
}

function createCameraSessionStamp() {
  return new Date().toISOString();
}

function getCameraDocumentName(stamp: string, pageCount: number) {
  const readableStamp = stamp.slice(0, 16).replace("T", " ");
  const pageLabel = `${pageCount} page${pageCount === 1 ? "" : "s"}`;
  return `Camera document ${readableStamp} (${pageLabel})`;
}

function getCameraPageFileName(stamp: string, pageNumber: number) {
  return `camera-document-${stamp.replace(/[:.]/g, "-")}-page-${pageNumber}.jpg`;
}

function getComparisonFieldDefinitions(docs: CaseDoc[]) {
  const orderedKeys: FieldKey[] = [];
  const seen = new Set<FieldKey>();

  const pushKey = (key: FieldKey) => {
    if (!seen.has(key)) {
      seen.add(key);
      orderedKeys.push(key);
    }
  };

  docs.forEach((doc) => {
    getFieldKeysForDocType(doc.type).forEach(pushKey);
  });

  docs.forEach((doc) => {
    ALL_FIELDS.forEach(({ key }) => {
      if (doc.fields[key]) {
        pushKey(key);
      }
    });
  });

  if (orderedKeys.length === 0) {
    ALL_FIELDS.filter(({ important }) => important).forEach(({ key }) => pushKey(key));
  }

  return getFieldDefinitionsByKeys(orderedKeys);
}

// Compute mismatches across documents per field
function useMismatchReport(docs: CaseDoc[], comparisonOptions: ComparisonOptions) {
  return useMemo(() => {
    const byField = ALL_FIELDS.reduce(
      (acc, { key }) => {
        acc[key] = {
          canonical: "",
          values: {} as Record<string, string>,
          mismatchingDocs: [],
        };
        return acc;
      },
      {} as Record<FieldKey, FieldSummary>
    );

    for (const { id, fields } of docs) {
      for (const { key } of ALL_FIELDS) {
        const current = fields[key];
        if (current) byField[key].values[id] = current;
      }
    }

    for (const { key } of ALL_FIELDS) {
      const values = docs
        .map((doc) => getComparableFieldValue(doc, key))
        .filter(
          (value): value is string =>
            value !== undefined && value !== null && String(value).trim() !== ""
        );
      const canonical = pickCanonicalComparableValue(values, comparisonOptions);
      byField[key].canonical = canonical;
      const mismatchingDocs: string[] = [];
      for (const [docId, v] of Object.entries(byField[key].values)) {
        if (v && canonical && !areComparableValuesEqual(v, canonical, comparisonOptions)) {
          mismatchingDocs.push(docId);
        }
      }
      byField[key].mismatchingDocs = mismatchingDocs;
    }

    const allMismatches: FieldMismatch[] = [];
    for (const key of PRIMARY_COMPARISON_FIELDS) {
      const shouldCheck = docs.some(
        (doc) =>
          shouldConsiderFieldKey(key, doc.type) &&
          getFieldKeysForDocType(doc.type).includes(key)
      );

      if (!shouldCheck) {
        continue;
      }

      const values = docs
        .map((doc) => ({
          docId: doc.id,
          value: getComparableFieldValue(doc, key),
        }))
        .filter((entry) => entry.value !== undefined && entry.value !== null && String(entry.value).trim() !== "");

      if (values.length < 2) {
        continue;
      }

      const canonical = pickCanonicalComparableValue(
        values.map((entry) => entry.value as string),
        comparisonOptions
      );

      const mismatchingDocs = values
        .filter((entry) => canonical && !areComparableValuesEqual(entry.value, canonical, comparisonOptions))
        .map((entry) => entry.docId);

      if (mismatchingDocs.length === 0) {
        continue;
      }

      allMismatches.push({
        field: key,
        label: getComparisonDisplayLabel(key, FIELD_LABEL_LOOKUP[key]),
        canonical,
        mismatchingDocs,
        values,
      });
    }

    const hasAnyType = (targets: DocType[]) => docs.some((doc) => targets.includes(doc.type));

    const missingDocTypes = getEnabledCorePacketGroups()
      .filter((group) => !hasAnyType(group.types))
      .map((group) => group.label);
    const amountA = currencyishToNumber(
      pickCanonicalComparableValue(
        docs
          .map((doc) => getCommercialAmountValue(doc))
          .filter(
            (value): value is string =>
              value !== undefined && value !== null && String(value).trim() !== ""
          ),
        comparisonOptions
      )
    );
    const amountB = currencyishToNumber(
      pickCanonicalComparableValue(
        docs
          .map((doc) => getPaymentEvidenceAmountValue(doc))
          .filter(
            (value): value is string =>
              value !== undefined && value !== null && String(value).trim() !== ""
          ),
        comparisonOptions
      )
    );
    const paymentGap = amountA && amountB ? Math.abs(amountA - amountB) : 0;
    const risk = Math.min(100, allMismatches.length * 10 + missingDocTypes.length * 12 + (paymentGap > 0 ? 10 : 0));

    return {
      byField,
      allMismatches,
      missingDocTypes,
      paymentGap,
      risk,
    };
  }, [docs, comparisonOptions]);
}

// ------------------------------------------------------------
// UI Components
// ------------------------------------------------------------

function ValueBadge({ ok, value }: { ok: boolean; value?: string }) {
  if (!value) {
    return null;
  }
  return (
    <Badge variant={ok ? "default" : "destructive"} className="rounded-full">
      {ok ? "Match" : "Mismatch"}
    </Badge>
  );
}

function FieldValue({ value }: { value?: string }) {
  return (
    <span className="font-mono text-xs">{value || <em className="opacity-60">—</em>}</span>
  );
}

function caseStatusLabel(status?: string) {
  if (status === "draft") return "Draft";
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  if (status === "failed") return "Failed";
  if (status === "processing") return "Processing";
  return "Pending decision";
}

function caseStatusClassName(status?: string) {
  if (status === "draft") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "accepted") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "rejected") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  if (status === "processing") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

export function WorkspacePage() {
  const router = useRouter();
  const {
    status: pipelineStatus,
    queuedUploads,
    documents,
    mismatches: pipelineMismatches,
    progress: pipelineProgress,
    error: pipelineError,
    activeUploadId,
    persistence,
    queueFiles,
    queueUploadGroup,
    removeUpload,
    startProcessing,
    updateSavedCase,
    reset: resetPipeline,
  } = useDocumentPipeline();
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [activeMismatchId, setActiveMismatchId] = useState<string | null>(null);
  const [duplicateUploadConflicts, setDuplicateUploadConflicts] = useState<DuplicateUploadConflict[]>([]);
  const [caseDraftCreated, setCaseDraftCreated] = useState(false);
  const [draftCaseStatus, setDraftCaseStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [draftCaseError, setDraftCaseError] = useState<string | null>(null);
  const [caseDecisionStatus, setCaseDecisionStatus] = useState<"idle" | "updating" | "error">("idle");
  const [caseDecisionError, setCaseDecisionError] = useState<string | null>(null);
  const [analysisOptionsOpen, setAnalysisOptionsOpen] = useState(false);
  const [comparisonOptions, setComparisonOptions] = useState<ComparisonOptions>(
    DEFAULT_COMPARISON_OPTIONS
  );
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<"idle" | "opening" | "ready" | "error">("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraPageFiles, setCameraPageFiles] = useState<File[]>([]);
  const [imagePreviewUploadId, setImagePreviewUploadId] = useState<string | null>(null);

  const cameraSessionRef = useRef(createCameraSessionStamp());
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraFallbackInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const docs = documents.length ? documents : DUMMY_DOCS;
  const docTitleLookup = useMemo(() => new Map(docs.map((doc) => [doc.id, doc])), [docs]);
  const showAiMismatches = pipelineMismatches.length > 0;

  const { byField, allMismatches, paymentGap, risk } = useMismatchReport(docs, comparisonOptions);

  const activeDoc = activeDocId ? docs.find((d) => d.id === activeDocId) : undefined;
  const activeDocFieldDefinitions = useMemo(
    () => (activeDoc ? getDocumentFieldDefinitions(activeDoc) : []),
    [activeDoc]
  );
  const comparisonFieldDefinitions = useMemo(() => getComparisonFieldDefinitions(docs), [docs]);

  const activeDocIndex = useMemo(() => {
    if (!activeDoc) return -1;
    return docs.findIndex((d) => d.id === activeDoc.id);
  }, [activeDoc, docs]);

  const activeFileUrl = useMemo(() => {
    if (activeDocIndex === -1 || documents.length === 0) return null;
    const upload = queuedUploads[activeDocIndex];
    const file = upload ? getQueuedUploadPrimaryFile(upload) : undefined;
    if (file) {
      return URL.createObjectURL(file);
    }
    return null;
  }, [activeDocIndex, queuedUploads, documents]);
  const activeUpload = activeDocIndex >= 0 ? queuedUploads[activeDocIndex] : undefined;
  const activeUploadFile = activeUpload ? getQueuedUploadPrimaryFile(activeUpload) : undefined;
  const activeSourceFileType = activeUploadFile?.type;
  const activeSourceFileLabel = getSourceFileLabel(activeSourceFileType, activeDoc?.sourceHint);
  const activeSourceIsImage = isImageSource(activeSourceFileType, activeDoc?.sourceHint);
  const imagePreviewUrls = useMemo(() => {
    const urls = new Map<string, string[]>();

    queuedUploads.forEach((upload) => {
      const imageFiles = getQueuedUploadFiles(upload).filter((file) => isImageSource(file.type, file.name));
      if (imageFiles.length) {
        urls.set(
          upload.id,
          imageFiles.map((file) => URL.createObjectURL(file))
        );
      }
    });

    return urls;
  }, [queuedUploads]);
  const cameraPagePreviewUrls = useMemo(
    () => cameraPageFiles.map((file) => URL.createObjectURL(file)),
    [cameraPageFiles]
  );
  const imagePreviewUpload = imagePreviewUploadId
    ? queuedUploads.find((upload) => upload.id === imagePreviewUploadId)
    : undefined;
  const imagePreviewPageUrls = imagePreviewUpload ? imagePreviewUrls.get(imagePreviewUpload.id) ?? [] : [];

  const activeMismatch = useMemo(() => {
    if (!activeMismatchId) return null;
    if (showAiMismatches) {
      return pipelineMismatches.find((m) => m.id === activeMismatchId);
    }
    const nonAi = allMismatches.find((m) => m.field === activeMismatchId);
    if (nonAi) {
      return {
        ...nonAi,
        id: nonAi.field,
        values: Array.isArray(nonAi.values) ? nonAi.values : [],
      };
    }
    return null;
  }, [activeMismatchId, pipelineMismatches, allMismatches, showAiMismatches]);

  useEffect(() => {
    if (showAiMismatches && pipelineMismatches.length > 0) {
      setActiveMismatchId(pipelineMismatches[0].id);
    } else if (allMismatches.length > 0) {
      setActiveMismatchId(allMismatches[0].field);
    } else {
      setActiveMismatchId(null);
    }
  }, [pipelineMismatches, allMismatches, showAiMismatches]);

  const caseSummary = useMemo(
    () => summarizeCase(documents.length ? documents : docs, pipelineMismatches), [documents, docs, pipelineMismatches]
  );
  const caseName = caseSummary.displayName;
  const hasUploads = queuedUploads.length > 0;
  const queuedUploadLabel = `${queuedUploads.length} document${queuedUploads.length === 1 ? "" : "s"}`;
  const renderWithSidebar = (content: React.ReactNode) => <AppShell>{content}</AppShell>;

  const persistDraftUploads = async (
    acceptedUploads: QueuedUpload[],
    strategy: Exclude<DuplicateUploadStrategy, "prompt"> | "append" = "append"
  ) => {
    if (!persistence.savedCase || persistence.savedCase.status !== "draft" || acceptedUploads.length === 0) {
      return;
    }

    try {
      setDraftCaseStatus("saving");
      setDraftCaseError(null);
      const updated = await appendCaseFiles(
        persistence.savedCase.id,
        acceptedUploads,
        strategy === "overwrite" ? "overwrite" : "append"
      );
      updateSavedCase(updated.case);
      setDraftCaseStatus("saved");
    } catch (appendError) {
      setDraftCaseError(appendError instanceof Error ? appendError.message : "Failed to add files to case.");
      setDraftCaseStatus("error");
    }
  };

  const handleQueueFiles = async (files?: FileList | File[] | null) => {
    const preparedFiles = await normalizeUploadFiles(files);
    const result = queueFiles(preparedFiles);
    if (result?.conflicts.length) {
      setDuplicateUploadConflicts(result.conflicts);
    }
    if (result?.acceptedUploads.length) {
      void persistDraftUploads(result.acceptedUploads);
    }
  };

  const queueCameraDocument = (files: File[]) => {
    if (!files.length) return;

    const result = queueUploadGroup(files, {
      name: getCameraDocumentName(cameraSessionRef.current, files.length),
      source: CAMERA_SCAN_SOURCE,
    });

    if (result?.acceptedUploads.length) {
      void persistDraftUploads(result.acceptedUploads);
    }
  };

  const stopCameraStream = (stream: MediaStream | null = cameraStream) => {
    stream?.getTracks().forEach((track) => track.stop());
  };

  const closeCameraCapture = () => {
    stopCameraStream();
    setCameraStream(null);
    setCameraOpen(false);
    setCameraStatus("idle");
    setCameraError(null);
    setCameraPageFiles([]);
  };

  const handleUploadInputChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    if (event.currentTarget.value) event.currentTarget.value = "";
    await handleQueueFiles(files);
  };

  const handleCameraFallbackInputChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = await normalizeUploadFiles(event.currentTarget.files);
    if (event.currentTarget.value) event.currentTarget.value = "";
    if (!files.length) return;

    if (cameraOpen) {
      setCameraPageFiles((prev) => [...prev, ...files]);
      return;
    }

    cameraSessionRef.current = createCameraSessionStamp();
    queueCameraDocument(files);
  };

  const handleCameraInputFallback = () => {
    cameraFallbackInputRef.current?.click();
  };

  const handleCameraCaptureRequest = async () => {
    setCameraError(null);
    cameraSessionRef.current = createCameraSessionStamp();
    setCameraPageFiles([]);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      handleCameraInputFallback();
      return;
    }

    try {
      setCameraOpen(true);
      setCameraStatus("opening");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
        },
      });
      setCameraStream(stream);
      setCameraStatus("ready");
    } catch (error) {
      setCameraOpen(false);
      setCameraStatus("idle");
      setCameraError(error instanceof Error ? error.message : "Camera is not available on this device.");
      handleCameraInputFallback();
    }
  };

  const handleCaptureCameraFrame = () => {
    const video = cameraVideoRef.current;

    if (!video) {
      setCameraError("Camera preview is not ready yet.");
      return;
    }

    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const { width, height } = constrainImageDimensions(sourceWidth, sourceHeight);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      setCameraError("Unable to capture this camera frame.");
      return;
    }

    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setCameraError("Unable to capture this camera frame.");
          return;
        }

        setCameraPageFiles((prev) => {
          const pageNumber = prev.length + 1;
          const file = new File([blob], getCameraPageFileName(cameraSessionRef.current, pageNumber), {
            type: "image/jpeg",
            lastModified: Date.now(),
          });
          return [...prev, file];
        });
      },
      "image/jpeg",
      0.92
    );
  };

  const handleRemoveCameraPage = (pageIndex: number) => {
    setCameraPageFiles((prev) => prev.filter((_, index) => index !== pageIndex));
  };

  const handleFinishCameraDocument = () => {
    if (!cameraPageFiles.length) {
      setCameraError("Capture at least one page before finishing this document.");
      return;
    }

    queueCameraDocument(cameraPageFiles);
    closeCameraCapture();
  };

  const resolveDuplicateUploads = (strategy: Exclude<DuplicateUploadStrategy, "prompt">) => {
    if (duplicateUploadConflicts.length === 0) return;
    const result = queueFiles(
      duplicateUploadConflicts.map((conflict) => conflict.file),
      strategy
    );
    if (result?.acceptedUploads.length) {
      void persistDraftUploads(result.acceptedUploads, strategy);
    }
    setDuplicateUploadConflicts([]);
  };

  const duplicateUploadDialog = (
    <DuplicateUploadDialog
      open={duplicateUploadConflicts.length > 0}
      conflicts={duplicateUploadConflicts}
      onOpenChange={(open) => {
        if (!open) setDuplicateUploadConflicts([]);
      }}
      onOverwrite={() => resolveDuplicateUploads("overwrite")}
      onDuplicate={() => resolveDuplicateUploads("duplicate")}
    />
  );

  const cameraFallbackInput = (
    <input
      ref={cameraFallbackInputRef}
      type="file"
      accept={IMAGE_UPLOAD_ACCEPT}
      capture="environment"
      multiple
      className="hidden"
      onChange={handleCameraFallbackInputChange}
    />
  );

  const cameraCaptureDialog = cameraOpen ? (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/90 px-4 pb-24 pt-6 sm:py-6 backdrop-blur-md">
      <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-950 shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4 text-white">
          <div>
            <div className="text-sm font-bold">Scan one document</div>
            <div className="text-xs text-slate-400">
              Capture every page, then finish once this document is complete.
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={closeCameraCapture}
          >
            {cameraPageFiles.length ? "Discard" : "Close"}
          </Button>
        </div>
        <div className="relative aspect-[3/4] max-h-[72vh] bg-black sm:aspect-video">
          <video
            ref={cameraVideoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-contain"
          />
          {cameraStatus === "opening" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-white">
              <Loader2 className="h-8 w-8 animate-spin" />
              <div className="text-sm font-semibold">Opening camera...</div>
            </div>
          )}
        </div>
        {cameraError && (
          <div className="border-t border-amber-400/20 bg-amber-500/10 px-5 py-3 text-sm text-amber-100">
            {cameraError}
          </div>
        )}
        {cameraPagePreviewUrls.length > 0 && (
          <div className="border-t border-white/10 bg-slate-900/95 px-5 py-4">
            <div className="mb-3 flex items-center justify-between gap-3 text-white">
              <div className="text-sm font-bold">
                {cameraPagePreviewUrls.length} page{cameraPagePreviewUrls.length === 1 ? "" : "s"} captured
              </div>
              <div className="text-xs font-medium text-slate-400">Tap trash to remove a page.</div>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {cameraPagePreviewUrls.map((url, index) => (
                <div key={`${url}-${index}`} className="relative h-20 w-16 shrink-0 overflow-hidden rounded-xl border border-white/15 bg-black">
                  <Image
                    src={url}
                    alt={`Captured page ${index + 1}`}
                    fill
                    unoptimized
                    sizes="64px"
                    className="object-cover"
                  />
                  <span className="absolute left-1 top-1 rounded-full bg-slate-950/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {index + 1}
                  </span>
                  <button
                    type="button"
                    className="absolute bottom-1 right-1 grid h-5 w-5 place-items-center rounded-full bg-white text-red-600 shadow"
                    onClick={() => handleRemoveCameraPage(index)}
                    aria-label={`Remove captured page ${index + 1}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-3 border-t border-white/10 bg-slate-900 px-5 py-4 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={handleCameraInputFallback}
          >
            Open phone camera
          </Button>
          <Button
            type="button"
            disabled={cameraStatus !== "ready"}
            variant="outline"
            className="border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={handleCaptureCameraFrame}
          >
            Capture page
          </Button>
          <Button
            type="button"
            disabled={cameraPageFiles.length === 0}
            className="bg-white text-slate-950 hover:bg-slate-100"
            onClick={handleFinishCameraDocument}
          >
            Finish document
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  const imagePreviewDialog = imagePreviewUpload && imagePreviewPageUrls.length > 0 ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-6 backdrop-blur-sm">
      <div className="flex w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-950 shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4 text-white">
          <div className="min-w-0">
            <div className="text-sm font-bold">Selected document</div>
            <div className="truncate text-xs text-slate-400">
              {imagePreviewUpload.name} · {imagePreviewPageUrls.length} page{imagePreviewPageUrls.length === 1 ? "" : "s"}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={() => setImagePreviewUploadId(null)}
          >
            Close
          </Button>
        </div>
        <div className="max-h-[76vh] overflow-y-auto bg-black p-4">
          <div className={imagePreviewPageUrls.length === 1 ? "relative h-[70vh] min-h-[320px]" : "grid gap-4 sm:grid-cols-2"}>
            {imagePreviewPageUrls.map((url, index) => (
              <div
                key={`${url}-${index}`}
                className={imagePreviewPageUrls.length === 1 ? "relative h-full" : "relative aspect-[3/4] overflow-hidden rounded-2xl border border-white/10 bg-slate-900"}
              >
                <Image
                  src={url}
                  alt={`${imagePreviewUpload.name} page ${index + 1}`}
                  fill
                  unoptimized
                  sizes={imagePreviewPageUrls.length === 1 ? "100vw" : "(min-width: 640px) 50vw, 100vw"}
                  className="object-contain"
                />
                {imagePreviewPageUrls.length > 1 && (
                  <span className="absolute left-3 top-3 rounded-full bg-slate-950/80 px-2 py-1 text-xs font-bold text-white">
                    Page {index + 1}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const analysisOptionsDialog = (
    <AnalysisOptionsDialog
      open={analysisOptionsOpen}
      onOpenChange={setAnalysisOptionsOpen}
      onSelect={(nextOptions) => {
        setComparisonOptions(nextOptions);
        setAnalysisOptionsOpen(false);
        void startProcessing(nextOptions);
      }}
    />
  );

  const resetWorkspace = () => {
    setCaseDraftCreated(false);
    setDuplicateUploadConflicts([]);
    setImagePreviewUploadId(null);
    setDraftCaseStatus("idle");
    setDraftCaseError(null);
    setCaseDecisionStatus("idle");
    setCaseDecisionError(null);
    setAnalysisOptionsOpen(false);
    closeCameraCapture();
    setComparisonOptions(DEFAULT_COMPARISON_OPTIONS);
    resetPipeline();
  };

  const handleCreateCaseDraft = async () => {
    if (!hasUploads) return;

    if (persistence.savedCase) {
      setCaseDraftCreated(true);
      return;
    }

    try {
      setDraftCaseStatus("saving");
      setDraftCaseError(null);
      const created = await createDraftCase({ uploads: queuedUploads });
      updateSavedCase(created.case);
      setCaseDraftCreated(true);
      setDraftCaseStatus("saved");
    } catch (createError) {
      setDraftCaseError(createError instanceof Error ? createError.message : "Failed to create case.");
      setDraftCaseStatus("error");
    }
  };

  const handleCaseDecision = async (decision: CaseDecision) => {
    if (!persistence.savedCase) return;

    try {
      setCaseDecisionStatus("updating");
      setCaseDecisionError(null);
      const updated = await updateCaseDecision(persistence.savedCase.id, decision);
      updateSavedCase(updated.case);
      setCaseDecisionStatus("idle");
    } catch (decisionError) {
      setCaseDecisionError(
        decisionError instanceof Error
          ? decisionError.message
          : `Failed to ${decision === "accepted" ? "accept" : "reject"} case.`
      );
      setCaseDecisionStatus("error");
    }
  };

  const handleAnalyzeRequest = () => {
    if (!hasUploads) return;
    setAnalysisOptionsOpen(true);
  };

  const queuedUploadRail = hasUploads ? (
    <div className="w-full max-w-3xl space-y-3 text-left">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-[#1a1a1a]">Documents in this case</div>
        <div className="text-xs font-bold uppercase tracking-[0.2em] text-[#8a7f72]">
          {queuedUploadLabel}
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="flex items-center gap-3 pb-1">
          {queuedUploads.map((upload, index) => {
            const fallbackTemplate = matchSampleByIndex(index);
            const inferredType = upload.resultDoc?.type ?? upload.classifiedType ?? fallbackTemplate.type;
            const imageUrls = imagePreviewUrls.get(upload.id);
            const pageCount = getQueuedUploadPageCount(upload);

            if (imageUrls?.length) {
              return (
                <div key={upload.id} className="group relative h-14 w-14 shrink-0">
                  <button
                    type="button"
                    className="relative h-full w-full overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white shadow-sm transition hover:border-[#8a7f72]"
                    onClick={() => setImagePreviewUploadId(upload.id)}
                    aria-label={`Preview ${upload.name}`}
                  >
                    <Image
                      src={imageUrls[0]}
                      alt={upload.name}
                      fill
                      unoptimized
                      sizes="56px"
                      className="object-cover"
                    />
                    <span className="absolute -right-1 -top-1 z-10 grid h-5 w-5 place-items-center rounded-full bg-[#1a1a1a] text-[11px] font-bold text-white shadow-sm">
                      {index + 1}
                    </span>
                    {pageCount > 1 && (
                      <span className="absolute bottom-1 left-1 z-10 rounded-full bg-white/95 px-1.5 py-0.5 text-[10px] font-bold text-[#1a1a1a] shadow-sm">
                        {pageCount}p
                      </span>
                    )}
                  </button>
                  {!persistence.savedCase && (
                    <button
                      type="button"
                      className="absolute -bottom-1 -right-1 z-10 grid h-6 w-6 place-items-center rounded-full border border-red-100 bg-white text-red-500 shadow-sm transition hover:bg-red-50"
                      onClick={() => removeUpload(upload.id)}
                      aria-label="Remove image"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            }

            return (
              <Popover key={upload.id}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="group relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-[#e5ddd0] bg-white text-[#5a5046] shadow-sm transition hover:border-[#8a7f72] hover:bg-[#faf8f4] hover:text-[#1a1a1a]"
                  >
                    <FileText className="h-6 w-6" />
                    <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-[#1a1a1a] text-[11px] font-bold text-white shadow-sm">
                      {index + 1}
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="center" side="top" className="w-64 text-left border-[#e5ddd0] shadow-xl rounded-2xl p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-[#1a1a1a]">
                        {upload.name}
                      </div>
                      <div className="text-xs font-medium text-slate-500 mt-0.5">
                        Slot {index + 1} · {inferredType}
                        {pageCount > 1 ? ` · ${pageCount} pages` : ""}
                      </div>
                    </div>
                    {!persistence.savedCase && (
                      <button
                        type="button"
                        className="shrink-0 rounded-full border border-slate-200 bg-slate-50 p-1.5 text-slate-400 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                        onClick={() => removeUpload(upload.id)}
                        aria-label="Remove file"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5 text-xs font-medium text-slate-600 leading-relaxed">
                    These documents are saved in this case. Analysis starts when you choose Analyze case.
                  </div>
                </PopoverContent>
              </Popover>
            );
          })}
        </div>
      </div>
    </div>
  ) : null;

  useEffect(() => {
    if (
      pipelineStatus === "ready" &&
      persistence.status === "saved" &&
      persistence.savedCase?.id
    ) {
      router.replace(`/cases/${persistence.savedCase.id}`);
    }
  }, [persistence.savedCase?.id, persistence.status, pipelineStatus, router]);

  useEffect(() => {
    if (pipelineStatus === "ready" && documents.length) {
      setActiveDocId((prev) => prev ?? documents[0].id);
    }
    if (pipelineStatus === "idle") {
      setActiveDocId(null);
    }
  }, [pipelineStatus, documents]);

  useEffect(() => {
    if (pipelineStatus === "idle" && queuedUploads.length === 0 && caseDraftCreated) {
      setCaseDraftCreated(false);
    }
  }, [caseDraftCreated, pipelineStatus, queuedUploads.length]);

  useEffect(() => {
    const video = cameraVideoRef.current;

    if (!cameraOpen || !cameraStream || !video) {
      return;
    }

    video.srcObject = cameraStream;
    void video.play().catch((error) => {
      setCameraError(error instanceof Error ? error.message : "Unable to start camera preview.");
      setCameraStatus("error");
    });
  }, [cameraOpen, cameraStream]);

  useEffect(() => {
    if (activeFileUrl) {
      const url = activeFileUrl;
      return () => {
        URL.revokeObjectURL(url);
      };
    }
  }, [activeFileUrl]);

  useEffect(() => {
    return () => {
      imagePreviewUrls.forEach((urls) => {
        urls.forEach((url) => URL.revokeObjectURL(url));
      });
    };
  }, [imagePreviewUrls]);

  useEffect(() => {
    return () => {
      cameraPagePreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [cameraPagePreviewUrls]);

  useEffect(() => {
    if (imagePreviewUploadId && !queuedUploads.some((upload) => upload.id === imagePreviewUploadId)) {
      setImagePreviewUploadId(null);
    }
  }, [imagePreviewUploadId, queuedUploads]);

  useEffect(() => {
    return () => {
      cameraStream?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraStream]);

  // =========================================================================
  // STATE 1: IDLE / UPLOAD SCREEN
  // =========================================================================
  if (pipelineStatus === "idle" && !caseDraftCreated) {
    return renderWithSidebar(
      <div className="flex min-h-screen flex-col bg-[#f7f7f5] px-4 pb-20 text-[#1a1a1a] sm:px-6 md:pb-8">
        {/* Header Section */}
        <div className="mx-auto w-full max-w-2xl pt-5 mb-5 border-b border-[#e5ddd0] pb-4">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="hidden sm:flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#f0ece6] text-[#1a1a1a] border border-[#e5ddd0] shadow-sm">
              <UploadCloud className="h-6 w-6" />
            </div>
            <div className="flex flex-col min-w-0">
              <h1 className="text-lg sm:text-xl font-bold text-[#1a1a1a]">Add case documents</h1>
              <p className="text-xs sm:text-sm font-medium text-[#8a7f72] mt-0.5 leading-snug">Upload or scan the documents for one case.</p>
            </div>
          </div>
        </div>

        {/* Centered Upload Card */}
        <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-2xl">
          <div className="w-full rounded-[2rem] border-2 border-dashed border-[#e5ddd0] bg-white px-5 py-7 text-center shadow-sm transition-all hover:border-[#d4c9b8] hover:shadow-md sm:px-8 sm:py-8">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-[1.25rem] border border-[#e5ddd0] bg-[#f0ece6] text-[#1a1a1a] shadow-sm">
              <UploadCloud className="h-7 w-7" />
            </div>

            <h2 className="text-2xl font-extrabold text-[#1a1a1a] sm:text-3xl">Upload case packet</h2>
            <p className="mt-2 text-base font-medium text-[#5a5046]">
              or{" "}
              <label className="cursor-pointer font-bold text-[#15803d] hover:text-[#166534] hover:underline">
                click to browse
                <input type="file" multiple accept={DOCUMENT_UPLOAD_ACCEPT} className="hidden" onChange={handleUploadInputChange} />
              </label>
              {" "}PDFs and images
            </p>

            {/* Pills */}
            <div className="mx-auto mt-5 flex max-w-2xl flex-wrap justify-center gap-2">
              {[
                { label: "PDF", accent: true },
                { label: "JPG" },
                { label: "PNG" },
                { label: "WEBP" },
                { label: "HEIC" },
                { label: "Invoice", accent: true },
                { label: "PO" },
                { label: "E-Way Bill" },
                { label: "Receipt" },
                { label: "Delivery Note" },
              ].map((pill) => (
                <span
                  key={pill.label}
                  className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider ${
                    pill.accent
                      ? "border-[#c9ead2] bg-[#eaf7ee] text-[#15803d]"
                      : "border-[#e5ddd0] bg-[#faf8f4] text-[#5a5046]"
                  }`}
                >
                  {pill.label}
                </span>
              ))}
            </div>



            {/* Action Buttons */}
            <div className="mx-auto mt-6 flex flex-wrap justify-center gap-3">
              <Button className="rounded-xl bg-[#1a1a1a] px-5 py-5 text-base font-bold text-white shadow-lg shadow-[#1a1a1a]/15 hover:bg-[#2d2d2d] transition-transform hover:scale-[1.02]" onClick={() => fileInputRef.current?.click()}>
                <UploadCloud className="mr-2 h-5 w-5" /> Upload PDF/Image
                <input ref={fileInputRef} type="file" multiple accept={DOCUMENT_UPLOAD_ACCEPT} className="hidden" onChange={handleUploadInputChange} />
              </Button>
              <Button variant="outline" className="rounded-xl border-[#e5ddd0] bg-white px-5 py-5 text-base font-bold text-[#5a5046] shadow-sm hover:bg-[#faf8f4] hover:text-[#1a1a1a] transition-transform hover:scale-[1.02]" onClick={() => galleryInputRef.current?.click()}>
                <ImagePlus className="mr-2 h-5 w-5 text-[#8a7f72]" /> Choose from gallery
                <input ref={galleryInputRef} type="file" multiple accept={IMAGE_UPLOAD_ACCEPT} className="hidden" onChange={handleUploadInputChange} />
              </Button>
              <Button variant="outline" className="rounded-xl border-[#e5ddd0] bg-white px-5 py-5 text-base font-bold text-[#5a5046] shadow-sm hover:bg-[#faf8f4] hover:text-[#1a1a1a] transition-transform hover:scale-[1.02]" onClick={handleCameraCaptureRequest}>
                <Camera className="mr-2 h-5 w-5 text-[#8a7f72]" /> Scan document
              </Button>
            </div>


          </div>

          {/* Draft Error & Queue Overlays */}
          {draftCaseStatus === "error" && draftCaseError && (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-bold text-red-700 shadow-sm text-center">
              {draftCaseError}
            </div>
          )}

          {hasUploads && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-5 flex flex-col items-center"
            >
              <div className="w-full rounded-[1.5rem] border border-[#e5ddd0] bg-white p-4 shadow-sm">
                {queuedUploadRail}
              </div>
              <div className="mt-4 w-full max-w-md">
                <Button
                  size="lg"
                  disabled={draftCaseStatus === "saving"}
                  className="w-full rounded-2xl bg-[#1a1a1a] px-8 py-6 text-base font-bold text-white shadow-lg shadow-[#1a1a1a]/15 hover:bg-[#2d2d2d] disabled:opacity-60 transition-transform hover:scale-[1.02]"
                  onClick={handleCreateCaseDraft}
                >
                  {draftCaseStatus === "saving" ? (
                    <span className="flex items-center justify-center gap-3"><Loader2 className="h-5 w-5 animate-spin" /> Creating case...</span>
                  ) : (
                    <span className="flex items-center justify-center gap-3"><FolderPlus className="h-5 w-5" /> Create case</span>
                  )}
                </Button>
              </div>
            </motion.div>
          )}

        </div>
        </div>
        {cameraFallbackInput}
        {duplicateUploadDialog}
        {cameraCaptureDialog}
        {imagePreviewDialog}
        {analysisOptionsDialog}
      </div>
    );
  }

  // =========================================================================
  // STATE 2: DRAFT CREATED (Ready to Analyze)
  // =========================================================================
  if (pipelineStatus === "idle" && caseDraftCreated) {
    return renderWithSidebar(
      <>
        <section className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f7f7f5]">
          <div className="absolute inset-0 -z-10">
            <div className="absolute left-[12%] top-[14%] h-72 w-72 rounded-full bg-[#e5ddd0]/40 blur-3xl" />
            <div className="absolute right-[12%] bottom-[14%] h-80 w-80 rounded-full bg-[#d4c9b8]/30 blur-3xl" />
          </div>
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="relative z-10 mx-auto flex w-full max-w-4xl flex-col items-center gap-8 px-6 py-16 text-center"
          >
            <div className="grid h-16 w-16 place-items-center rounded-[1.25rem] bg-[#eaf7ee] text-[#15803d] shadow-sm border border-[#c9ead2]">
              <CheckCircle2 className="h-8 w-8" />
            </div>

            <div className="space-y-4 max-w-2xl">
              <div className="text-xs font-bold uppercase tracking-[0.3em] text-[#8a7f72]">Case created</div>
              <h1 className="text-4xl font-extrabold tracking-tight text-[#1a1a1a] sm:text-5xl">
                Ready to analyze
              </h1>
              <p className="mx-auto text-base font-medium leading-relaxed text-[#5a5046]">
                This case has {queuedUploadLabel} ready. Add any missing documents, then analyze to extract fields and check mismatches.
              </p>

              {persistence.savedCase && (
                <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-[#e5ddd0] bg-white px-4 py-2 text-sm font-bold text-[#5a5046] shadow-sm">
                  <Folder className="h-4 w-4 text-[#8a7f72]" /> {persistence.savedCase.displayName}
                </div>
              )}
              {draftCaseStatus === "saving" && (
                <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-[#c9ead2] bg-[#eaf7ee] px-4 py-2 text-sm font-bold text-[#15803d] shadow-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Adding documents to case...
                </div>
              )}
              {draftCaseStatus === "error" && draftCaseError && (
                <div className="mx-auto mt-4 max-w-2xl rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-bold text-red-700 shadow-sm">
                  {draftCaseError}
                </div>
              )}
            </div>

            <div className="w-full max-w-3xl rounded-[2rem] border border-[#e5ddd0] bg-white p-6 shadow-sm">
              {queuedUploadRail}
            </div>

            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8a7f72]">
              Mode: {getComparisonModeLabel(comparisonOptions)}
            </div>

            {/* ACTION ROW */}
            <div className="flex w-full max-w-3xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-center mt-2">

              {/* HIDDEN INPUTS FOR POPOVER */}
              <input ref={fileInputRef} type="file" multiple accept={DOCUMENT_UPLOAD_ACCEPT} className="hidden" onChange={handleUploadInputChange} />
              <input ref={galleryInputRef} type="file" multiple accept={IMAGE_UPLOAD_ACCEPT} className="hidden" onChange={handleUploadInputChange} />

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" disabled={draftCaseStatus === "saving"} className="rounded-2xl px-6 py-6 text-base font-bold border-[#e5ddd0] text-[#5a5046] bg-white hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-transform hover:scale-[1.02]">
                    <Plus className="mr-2 h-5 w-5 text-[#8a7f72]" /> Add documents
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="center" side="bottom" className="w-56 p-2 rounded-2xl border-[#e5ddd0] shadow-xl bg-white">
                  <button onClick={() => fileInputRef.current?.click()} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] transition-colors">
                    <FolderPlus className="h-4 w-4 text-[#8a7f72]" /> Upload PDF/Image
                  </button>
                  <button onClick={() => galleryInputRef.current?.click()} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] transition-colors">
                    <ImagePlus className="h-4 w-4 text-[#8a7f72]" /> Choose from gallery
                  </button>
                  <button onClick={handleCameraCaptureRequest} disabled={cameraStatus === "opening"} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] transition-colors disabled:opacity-50">
                    {cameraStatus === "opening" ? <Loader2 className="h-4 w-4 animate-spin text-[#8a7f72]" /> : <Camera className="h-4 w-4 text-[#8a7f72]" />} Scan document
                  </button>
                </PopoverContent>
              </Popover>

              <Button
                type="button"
                disabled={!hasUploads}
                className="flex-1 rounded-2xl bg-[#1a1a1a] px-8 py-6 text-base font-bold text-white shadow-lg shadow-[#1a1a1a]/15 hover:bg-[#2d2d2d] transition-transform hover:scale-[1.02]"
                onClick={handleAnalyzeRequest}
              >
                <Play className="mr-2 h-5 w-5 fill-white" />
                Analyze case
              </Button>

            </div>
          </motion.div>
        </section>
        {cameraFallbackInput}
        {duplicateUploadDialog}
        {cameraCaptureDialog}
        {imagePreviewDialog}
        {analysisOptionsDialog}
      </>
    );
  }

  // =========================================================================
  // STATE 3: PROCESSING SCREEN
  // =========================================================================
  if (pipelineStatus === "processing") {
    const totalDocs = queuedUploads.length || SAMPLE_DOCS.length;
    const activeIndex = activeUploadId
      ? queuedUploads.findIndex((upload) => upload.id === activeUploadId)
      : queuedUploads.findIndex((upload) =>
        upload.stages.some((stage) => stage.status === "active")
      );
    const fallbackIndex = activeIndex >= 0 ? activeIndex : Math.max(0, Math.min(totalDocs - 1, queuedUploads.length - 1));
    const currentUpload = queuedUploads[fallbackIndex] ?? queuedUploads[queuedUploads.length - 1];
    const fallbackDoc = SAMPLE_DOCS[fallbackIndex % SAMPLE_DOCS.length];
    const currentDoc = currentUpload?.resultDoc ?? fallbackDoc;
    const stageCount = currentUpload?.stages.length ?? 1;
    const completedStages = currentUpload
      ? currentUpload.stages.filter((stage) => stage.status === "done" || stage.status === "complete").length
      : 0;
    const docProgress = Math.min(1, Math.max(0, completedStages / stageCount));
    const secondsElapsed = Math.min(15, Math.round(pipelineProgress * 15));
    const activeStageEntry = currentUpload?.stages.find((stage) => stage.status === "active");
    const nextStageEntry = currentUpload?.stages.find((stage) => stage.status === "pending");
    const currentStageMeta = activeStageEntry
      ? STAGE_META[activeStageEntry.stage] ?? STAGE_META.classifying
      : currentUpload?.stages.some(
        (stage) => stage.stage === "complete" && (stage.status === "done" || stage.status === "complete")
      )
        ? STAGE_META.complete
        : nextStageEntry
          ? STAGE_META[nextStageEntry.stage] ?? STAGE_META.classifying
          : STAGE_META.upload_received;
    const classificationComplete = currentUpload
      ? currentUpload.stages.some(
        (stage) => stage.stage === "classifying" && (stage.status === "done" || stage.status === "complete")
      )
      : false;
    const sourceName = currentUpload?.name || currentDoc.sourceHint || `${currentDoc.id}.pdf`;
    const processedCount = queuedUploads.filter((upload) =>
      upload.stages.some(
        (stage) => stage.stage === "complete" && (stage.status === "done" || stage.status === "complete")
      )
    ).length;
    const currentOrdinal = currentUpload
      ? Math.max(1, queuedUploads.findIndex((upload) => upload.id === currentUpload.id) + 1)
      : Math.min(totalDocs, processedCount + 1);

    function stageStatus(stage: (typeof PIPELINE_STAGES)[number]) {
      if (docProgress >= stage.end) return "done";
      if (docProgress >= stage.start && docProgress < stage.end) return "active";
      return "pending";
    }

    return renderWithSidebar(
      <section className="relative flex min-h-[calc(100vh-2rem)] items-center justify-center overflow-hidden bg-[#f7f7f5] text-slate-900">
        <div className="absolute inset-0 -z-10">
          <div className="absolute left-[12%] top-[8%] h-72 w-72 rounded-full bg-[#e5ddd0]/40 blur-3xl" />
          <div className="absolute right-[10%] bottom-[12%] h-80 w-80 rounded-full bg-[#d4c9b8]/30 blur-3xl" />
        </div>
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="relative z-10 mx-auto flex w-full max-w-5xl flex-col gap-5 sm:gap-8 px-4 sm:px-6 py-8 sm:py-12"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <span className="text-xs font-bold uppercase tracking-[0.3em] text-[#8a7f72]">
                Document intake pipeline
              </span>
              <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
                Classifying, digitizing, and validating uploads…
              </h1>
            </div>
            <div className="rounded-xl border border-[#e5ddd0] bg-white px-4 py-2.5 sm:px-5 sm:py-4 text-left sm:text-right shadow-sm shrink-0 self-start sm:self-auto min-w-[100px]">
              <div className="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-[#8a7f72]">Elapsed</div>
              <div className="text-lg sm:text-xl font-bold text-slate-900 leading-tight">{secondsElapsed}s</div>
            </div>
          </div>

          <div className="rounded-2xl sm:rounded-3xl border border-[#e5ddd0] bg-white/95 px-5 py-6 sm:px-8 sm:py-8 shadow-md backdrop-blur">
            <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[#f0ece6] text-[#5a5046] shadow-inner">
                  <Sparkles className="h-6 w-6 animate-pulse text-[#5a5046]" />
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8a7f72]">
                    Global progress
                  </div>
                  <div className="text-3xl font-extrabold text-slate-900">
                    {Math.round(pipelineProgress * 100)}%
                  </div>
                </div>
              </div>
              <div className="text-sm font-medium text-slate-600">
                Analyzing{" "}
                <span className="font-bold text-slate-900">{currentOrdinal}</span>{" "}
                of {totalDocs} documents
              </div>
            </div>
            <div className="relative h-3 w-full overflow-hidden rounded-full bg-[#f0ece6]">
              <motion.div
                className="absolute inset-y-0 left-0 rounded-full bg-slate-900"
                animate={{ width: `${pipelineProgress * 100}%` }}
                transition={{ ease: "easeInOut", duration: 0.3 }}
              />
            </div>
          </div>

          <div>
            <motion.div
              key={currentDoc.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="flex h-full flex-col rounded-3xl border border-[#e5ddd0] bg-white p-8 shadow-md"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8a7f72]">
                    Current document
                  </div>
                  <div className="mt-3 min-h-[56px]">
                    <AnimatePresence mode="wait">
                      {classificationComplete ? (
                        <motion.div
                          key="identified"
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          transition={{ duration: 0.25 }}
                        >
                          <h2 className="text-xl font-bold leading-tight text-slate-900">
                            {currentDoc.title}
                          </h2>
                          <div className="mt-1 text-sm font-semibold text-slate-500">{currentDoc.type}</div>
                        </motion.div>
                      ) : (
                        <motion.div
                          key="upload"
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          transition={{ duration: 0.25 }}
                        >
                          <h2 className="text-xl font-bold leading-tight text-slate-900">
                            {sourceName}
                          </h2>
                          <div className="mt-1 text-sm font-semibold text-slate-500">
                            Identifying document type
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                  <div className="text-xs font-semibold text-[#8a7f72] mt-2">Source file · {sourceName}</div>
                </div>
                <div className="flex items-center gap-2 rounded-full border border-[#e5ddd0] bg-[#f0ece6] px-4 py-1.5 text-xs font-bold text-[#5a5046]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {currentStageMeta.label}
                </div>
              </div>

              <div className="mt-8 space-y-4">
                {PIPELINE_STAGES.map((stage) => {
                  const status = stageStatus(stage);
                  const dotClass =
                    status === "done"
                      ? "bg-emerald-500"
                      : status === "active"
                        ? "bg-slate-900 animate-pulse"
                        : "bg-[#e5ddd0]";
                  const textClass =
                    status === "pending" ? "text-[#8a7f72]" : "text-slate-900";
                  return (
                    <div key={stage.id} className="flex items-center gap-4">
                      <div className={`flex h-6 w-6 items-center justify-center rounded-full ${status === 'done' ? 'bg-emerald-100 text-emerald-600' : status === 'active' ? 'bg-slate-100 text-slate-900 animate-pulse' : 'bg-[#f0ece6] text-[#8a7f72]'}`}>
                        {status === 'done' ? <CheckCircle2 className="h-4 w-4" /> : status === 'active' ? <Loader2 className="h-4 w-4 animate-spin" /> : <div className="h-2 w-2 rounded-full bg-current" />}
                      </div>
                      <div className={`text-sm font-bold ${textClass}`}>
                        {stage.label}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-8 pt-6 border-t border-[#e5ddd0]">
                <div className="mb-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.2em] text-[#8a7f72]">
                  <span>Document progress</span>
                  <span>{Math.round(docProgress * 100)}%</span>
                </div>
                <div className="relative h-2 overflow-hidden rounded-full bg-[#f0ece6]">
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-full bg-slate-900"
                    animate={{ width: `${docProgress * 100}%` }}
                    transition={{ ease: "easeInOut", duration: 0.25 }}
                  />
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </section>
    );
  }

  if (pipelineStatus === "error") {
    return renderWithSidebar(
      <section className="flex min-h-[calc(100vh-2rem)] flex-col items-center justify-center gap-6 bg-[#f7f7f5] text-center text-slate-700">
        <div className="h-20 w-20 bg-red-50 rounded-full flex items-center justify-center mb-2 shadow-sm border border-red-100">
          <TriangleAlert className="h-10 w-10 text-red-500" />
        </div>
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900">Processing Failed</h2>
          <p className="text-[#5a5046] mt-3 max-w-md font-medium">An unexpected error occurred while analyzing the documents in the pipeline.</p>
        </div>
        <div className="bg-red-50 border border-red-100 rounded-2xl p-5 max-w-md w-full text-left font-mono text-xs text-red-800 break-words shadow-sm">
          {pipelineError || "Unknown pipeline error."}
        </div>
        <Button onClick={resetPipeline} size="lg" className="rounded-2xl mt-4 font-bold bg-slate-900 hover:bg-slate-800 text-white px-8">
          Try again
        </Button>
      </section>
    );
  }

  if (pipelineStatus === "ready") {
    const hasSaveError = persistence.status === "error";
    const savedCaseId = persistence.savedCase?.id;

    return renderWithSidebar(
      <section className="flex min-h-[calc(100vh-2rem)] flex-col items-center justify-center gap-5 bg-[#f7f7f5] px-6 text-center text-[#5a5046]">
        <div className="grid h-16 w-16 place-items-center rounded-2xl border border-[#e5ddd0] bg-white shadow-sm">
          {hasSaveError ? (
            <TriangleAlert className="h-8 w-8 text-red-500" />
          ) : (
            <Loader2 className="h-8 w-8 animate-spin text-[#8a7f72]" />
          )}
        </div>
        <div>
          <h2 className="text-2xl font-extrabold text-[#1a1a1a]">
            {hasSaveError
              ? "Case analysis could not be saved"
              : savedCaseId
                ? "Opening case detail"
                : "Saving analyzed case"}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm font-medium leading-6">
            {hasSaveError
              ? "The documents were analyzed, but saving the results failed. Please try again so the case detail page can be created."
              : savedCaseId
                ? "The case is ready. Redirecting you to the detail page now."
                : "Analysis is complete. We are saving the case before opening the detail page."}
          </p>
        </div>
        {hasSaveError && persistence.error && (
          <div className="max-w-lg rounded-2xl border border-red-100 bg-red-50 p-4 text-left font-mono text-xs text-red-700 shadow-sm">
            {persistence.error}
          </div>
        )}
        {savedCaseId && (
          <Button
            type="button"
            className="rounded-2xl bg-[#1a1a1a] px-6 py-5 font-bold text-white hover:bg-[#2d2d2d]"
            onClick={() => router.replace(`/cases/${savedCaseId}`)}
          >
            Open case detail
          </Button>
        )}
        {hasSaveError && (
          <Button
            type="button"
            variant="outline"
            className="rounded-2xl border-[#e5ddd0] bg-white px-6 py-5 font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a]"
            onClick={resetWorkspace}
          >
            Start again
          </Button>
        )}
      </section>
    );
  }

  // Safety check for activeDoc
  if (!activeDoc) {
    return renderWithSidebar(
      <section className="flex min-h-[calc(100vh-2rem)] items-center justify-center bg-[#f7f7f5]">
        <p className="text-[#8a7f72] font-medium">No document selected</p>
      </section>
    );
  }
}
