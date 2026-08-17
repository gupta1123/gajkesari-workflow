import { NextResponse } from "next/server";

import {
  getCaseCategoryFromProcessingMeta,
  isGeneratedCaptureDisplayName,
  resolveCaseCategoryLabel,
  resolveStoredCaseDisplayName,
  summarizeCase,
} from "@/lib/case-summary";
import {
  DEFAULT_COMPARISON_OPTIONS,
  getComparableFieldValue,
  isPrimaryComparisonField,
  readComparisonOptions,
} from "@/lib/comparison";
import {
  sanitizeFieldsForDocType,
  shouldConsiderFieldKey,
  type PacketFieldConfiguration,
} from "@/lib/document-schema";
import { getPersistedPacketFieldConfiguration } from "@/lib/field-settings-service";
import { getRecycleBinDeletedAt, isCaseRecycled } from "@/lib/recycle-bin";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readUploadGroupMeta } from "@/lib/upload-groups";
import type { CaseDoc, FieldKey, Mismatch } from "@/types/pipeline";

const STORAGE_BUCKET = "packet-files";

function isRecycleBinSchemaMissing(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const message = [
    record.message,
    record.error,
    record.details,
    record.hint,
    record.error_description,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  const mentionsRecycleColumns = /deleted_at|deleted_by_user_id/i.test(message);
  const isMissingColumnError =
    /schema cache|could not find|column .* does not exist|42703|PGRST/i.test(`${code} ${message}`);

  return mentionsRecycleColumns && isMissingColumnError;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts: string[] = [];

    const message = [record.message, record.error_description, record.error].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );

    if (message) {
      parts.push(message);
    }
    if (typeof record.details === "string" && record.details.trim().length > 0) {
      parts.push(record.details);
    }
    if (typeof record.hint === "string" && record.hint.trim().length > 0) {
      parts.push(`Hint: ${record.hint}`);
    }
    if (typeof record.code === "string" && record.code.trim().length > 0) {
      parts.push(`Code: ${record.code}`);
    }

    const combined = parts.join(" ");
    if (combined) {
      if (/owner_user_id|schema cache/i.test(combined)) {
        return `${combined} Run the auth migration in Supabase using supabase/packet_auth_backend_v2.sql, then retry.`;
      }
      if (/deleted_at|deleted_by_user_id/i.test(combined)) {
        return `${combined} Run the recycle bin migration in Supabase using supabase/packet_recycle_bin_backend_v3.sql, then retry.`;
      }
      if (/packet_cases_status_check|violates check constraint/i.test(combined)) {
        return `${combined} Run the case draft migration in Supabase using supabase/packet_case_draft_backend_v5.sql, then retry.`;
      }
      return combined;
    }

    return JSON.stringify(error);
  }

  return String(error ?? "Unknown error");
}

function parseJsonField<T>(value: FormDataEntryValue | null, fieldName: string): T {
  if (typeof value !== "string") {
    throw new Error(`Missing ${fieldName} payload.`);
  }
  return JSON.parse(value) as T;
}

function parseComparisonOptions(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return DEFAULT_COMPARISON_OPTIONS;
  }

  return readComparisonOptions(JSON.parse(value));
}

function parseUploadGroups(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return [];
  }

  try {
    return readUploadGroupMeta(JSON.parse(value));
  } catch {
    return [];
  }
}

function sanitizeFileName(fileName: string) {
  const cleaned = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || "upload";
}

function inferContentType(file: File) {
  if (file.type) {
    return file.type;
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  return "application/octet-stream";
}

function formatDraftName(fileName: string) {
  const cleaned = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (isGeneratedCaptureDisplayName(cleaned)) {
    return "Receiver pending";
  }

  return cleaned || "New packet case";
}

function slugifyDraftName(value: string, fallback: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || fallback;
}

function isFileEntry(entry: FormDataEntryValue): entry is File {
  return typeof entry !== "string";
}

function sanitizeDocumentsForStorage(
  documents: CaseDoc[],
  fieldConfiguration: PacketFieldConfiguration
): CaseDoc[] {
  return documents.map((document) => ({
    ...document,
    fields: sanitizeFieldsForDocType(
      document.type,
      document.fields ?? {},
      fieldConfiguration
    ) as CaseDoc["fields"],
  }));
}

function hasMeaningfulDocumentFieldValue(value: unknown) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}

function sanitizeMismatchesForStorage(
  mismatches: Mismatch[],
  documents: CaseDoc[],
  fieldConfiguration: PacketFieldConfiguration
): Mismatch[] {
  return mismatches.filter((mismatch) => {
    if (
      !shouldConsiderFieldKey(mismatch.field, undefined, fieldConfiguration) ||
      !isPrimaryComparisonField(mismatch.field)
    ) {
      return false;
    }

    const supportingDocuments = documents.filter((document) =>
      hasMeaningfulDocumentFieldValue(getComparableFieldValue(document, mismatch.field as FieldKey))
    );

    return supportingDocuments.length >= 2;
  });
}

function mapDocumentRowForCaseSummary(row: {
  id: string;
  client_document_id: string | null;
  source_file_name: string | null;
  source_hint: string | null;
  document_type: string;
  title: string | null;
  page_count: number | null;
  extracted_fields: unknown;
}, fieldConfiguration: PacketFieldConfiguration): CaseDoc {
  const extractedFields =
    row.extracted_fields && typeof row.extracted_fields === "object" && !Array.isArray(row.extracted_fields)
      ? sanitizeFieldsForDocType(
          row.document_type,
          Object.fromEntries(
            Object.entries(row.extracted_fields).flatMap(([key, value]) => {
              if (typeof value === "string" || typeof value === "number") {
                return [[key, String(value)]];
              }
              return [];
            })
          ),
          fieldConfiguration
        )
      : {};

  return {
    id: row.client_document_id || row.id,
    type: row.document_type as CaseDoc["type"],
    title: row.title || row.document_type,
    pages: row.page_count || 1,
    fields: extractedFields as CaseDoc["fields"],
    md: "",
    sourceHint: row.source_hint || row.source_file_name || undefined,
    sourceFileName: row.source_file_name || undefined,
  };
}

async function fetchCaseDocumentsForSummary(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  caseIds: string[],
  fieldConfiguration: PacketFieldConfiguration
) {
  const documentsByCaseId = new Map<string, CaseDoc[]>();

  if (caseIds.length === 0) {
    return documentsByCaseId;
  }

  const { data, error } = await supabase
    .from("packet_documents")
    .select("case_id, id, client_document_id, source_file_name, source_hint, document_type, title, page_count, extracted_fields")
    .in("case_id", caseIds)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  for (const row of data ?? []) {
    const current = documentsByCaseId.get(row.case_id) ?? [];
    current.push(mapDocumentRowForCaseSummary(row, fieldConfiguration));
    documentsByCaseId.set(row.case_id, current);
  }

  return documentsByCaseId;
}

async function fetchCaseMismatchCountsForSummary(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  caseIds: string[],
  documentsByCaseId: Map<string, CaseDoc[]>,
  fieldConfiguration: PacketFieldConfiguration
) {
  const mismatchCountsByCaseId = new Map<string, number>();

  if (caseIds.length === 0) {
    return mismatchCountsByCaseId;
  }

  const { data, error } = await supabase
    .from("packet_mismatches")
    .select("case_id, field_name")
    .in("case_id", caseIds);

  if (error) {
    throw error;
  }

  for (const row of data ?? []) {
    if (
      !shouldConsiderFieldKey(row.field_name, undefined, fieldConfiguration) ||
      !isPrimaryComparisonField(row.field_name)
    ) {
      continue;
    }

    const supportingDocuments = (documentsByCaseId.get(row.case_id) ?? []).filter((document) =>
      hasMeaningfulDocumentFieldValue(getComparableFieldValue(document, row.field_name as FieldKey))
    );

    if (supportingDocuments.length < 2) {
      continue;
    }

    mismatchCountsByCaseId.set(
      row.case_id,
      (mismatchCountsByCaseId.get(row.case_id) ?? 0) + 1
    );
  }

  return mismatchCountsByCaseId;
}

function mapCaseRow(
  row: {
    id: string;
    slug: string;
    display_name: string;
    buyer_name: string | null;
    po_number: string | null;
    invoice_number: string | null;
    status: string;
    risk_score: number;
    upload_count: number;
    document_count: number;
    mismatch_count: number;
    created_at: string;
    processing_meta?: unknown;
    deleted_at?: string | null;
  },
  documents: CaseDoc[] = [],
  mismatchCountOverride?: number,
  fieldConfiguration?: PacketFieldConfiguration
) {
  const derivedSummary =
    documents.length > 0 ? summarizeCase(documents, [], fieldConfiguration) : null;
  const receiverName = derivedSummary ? derivedSummary.buyerName : row.buyer_name;
  const category =
    derivedSummary?.category ||
    resolveCaseCategoryLabel({
      receiverName,
      storedCategory: getCaseCategoryFromProcessingMeta(
        row.processing_meta,
        row.status,
        documents.map((document) => document.type),
        fieldConfiguration
      ),
      status: row.status,
    });
  const displayName =
    derivedSummary?.displayName ||
    resolveStoredCaseDisplayName({
      storedDisplayName: row.display_name,
      receiverName,
      invoiceNumber: row.invoice_number,
      poNumber: row.po_number,
      category,
      status: row.status,
    });

  return {
    id: row.id,
    slug: row.slug,
    displayName,
    buyerName: receiverName,
    receiverName,
    category,
    poNumber: row.po_number,
    invoiceNumber: row.invoice_number,
    status: row.status,
    riskScore: row.risk_score,
    uploadCount: row.upload_count,
    documentCount: row.document_count,
    mismatchCount: mismatchCountOverride ?? row.mismatch_count,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? getRecycleBinDeletedAt(row.processing_meta),
  };
}

export async function GET(request: Request) {
  try {
    const authClient = await createSupabaseServerClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();
    const fieldConfiguration = await getPersistedPacketFieldConfiguration();
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "12");
    const requestedScope = url.searchParams.get("scope");
    const scope = requestedScope === "deleted" ? "deleted" : "active";
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 200)
        : 12;

    let data:
      | Array<{
          id: string;
          slug: string;
          display_name: string;
          buyer_name: string | null;
          po_number: string | null;
          invoice_number: string | null;
          status: string;
          risk_score: number;
          upload_count: number;
          document_count: number;
          mismatch_count: number;
          created_at: string;
          processing_meta?: unknown;
          deleted_at?: string | null;
        }>
      | null = null;

    try {
      let query = supabase
        .from("packet_cases")
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
        )
        .eq("owner_user_id", user.id)
        .limit(limit);

      query =
        scope === "deleted"
          ? query.not("deleted_at", "is", null).order("deleted_at", { ascending: false })
          : query.is("deleted_at", null).order("created_at", { ascending: false });

      const result = await query;
      if (result.error) {
        throw result.error;
      }
      data = result.data;
    } catch (error) {
      if (!isRecycleBinSchemaMissing(error)) {
        throw error;
      }

      const fallback = await supabase
        .from("packet_cases")
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .eq("owner_user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (fallback.error) {
        throw fallback.error;
      }

      const rows = (fallback.data ?? []).map((row) => ({
        ...row,
        deleted_at: getRecycleBinDeletedAt(row.processing_meta),
      }));

      data =
        scope === "deleted"
          ? rows
              .filter((row) => isCaseRecycled(row.processing_meta))
              .sort((a, b) => {
                const aTime = new Date(a.deleted_at ?? 0).getTime();
                const bTime = new Date(b.deleted_at ?? 0).getTime();
                return bTime - aTime;
              })
          : rows.filter((row) => !isCaseRecycled(row.processing_meta));
    }

    const documentsByCaseId = await fetchCaseDocumentsForSummary(
      supabase,
      (data ?? []).map((row) => row.id),
      fieldConfiguration
    );
    const mismatchCountsByCaseId = await fetchCaseMismatchCountsForSummary(
      supabase,
      (data ?? []).map((row) => row.id),
      documentsByCaseId,
      fieldConfiguration
    );

    return NextResponse.json({
      cases: (data ?? []).map((row) =>
        mapCaseRow(
          row,
          documentsByCaseId.get(row.id) ?? [],
          mismatchCountsByCaseId.get(row.id) ?? 0,
          fieldConfiguration
        )
      ),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: serializeError(error),
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  let supabase: ReturnType<typeof createSupabaseAdminClient> | null = null;
  const uploadedPaths: string[] = [];
  let caseId = "";

  try {
    const authClient = await createSupabaseServerClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    supabase = createSupabaseAdminClient();
    const fieldConfiguration = await getPersistedPacketFieldConfiguration();
    const formData = await request.formData();
    const mode = typeof formData.get("mode") === "string" ? formData.get("mode") : null;
    const files = formData.getAll("files").filter(isFileEntry);
    const uploadGroups = parseUploadGroups(formData.get("uploadGroups"));

    if (mode === "draft") {
      if (!files.length) {
        return NextResponse.json(
          { error: "Upload at least one file to create a case." },
          { status: 400 }
        );
      }

      caseId = crypto.randomUUID();
      const firstFileName = uploadGroups[0]?.name ?? files[0]?.name ?? "New packet case";
      const displayName = formatDraftName(firstFileName);
      const slug = `${slugifyDraftName(displayName, "draft-case")}-${caseId.slice(0, 8)}`;

      const fileRows = [];
      for (const file of files) {
        const storagePath = `${caseId}/${Date.now()}-${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
        const binary = new Uint8Array(await file.arrayBuffer());
        const contentType = inferContentType(file);
        const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, binary, {
          contentType,
          upsert: false,
        });

        if (uploadError) {
          throw uploadError;
        }

        uploadedPaths.push(storagePath);
        fileRows.push({
          case_id: caseId,
          original_name: file.name,
          storage_bucket: STORAGE_BUCKET,
          storage_path: storagePath,
          mime_type: contentType,
          size_bytes: file.size,
        });
      }

      const caseRow = {
        id: caseId,
        owner_user_id: user.id,
        slug,
        display_name: displayName,
        buyer_name: null,
        po_number: null,
        invoice_number: null,
        status: "draft",
        risk_score: 0,
        upload_count: files.length,
        document_count: 0,
        mismatch_count: 0,
        processing_meta: {
          draft: true,
          draftCreatedAt: new Date().toISOString(),
          caseCategory: "Draft case",
          packetCategory: "Draft case",
          documentTypes: [],
          missingDocumentGroups: [],
          paymentGap: 0,
          uploadGroups,
        },
      };

      const { data: insertedCase, error: caseError } = await supabase
        .from("packet_cases")
        .insert(caseRow)
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .single();

      if (caseError) {
        throw caseError;
      }

      const { error: fileInsertError } = await supabase.from("packet_case_files").insert(fileRows);
      if (fileInsertError) {
        throw fileInsertError;
      }

      return NextResponse.json(
        {
          case: mapCaseRow(insertedCase),
        },
        { status: 201 }
      );
    }

    const documents = sanitizeDocumentsForStorage(
      parseJsonField<CaseDoc[]>(formData.get("documents"), "documents"),
      fieldConfiguration
    );
    const mismatches = sanitizeMismatchesForStorage(
      parseJsonField<Mismatch[]>(formData.get("mismatches"), "mismatches"),
      documents,
      fieldConfiguration
    );
    const comparisonOptions = parseComparisonOptions(formData.get("comparisonOptions"));
    if (!documents.length) {
      return NextResponse.json(
        { error: "No processed documents were provided to save." },
        { status: 400 }
      );
    }

    const summary = summarizeCase(documents, mismatches, fieldConfiguration);
    caseId = crypto.randomUUID();

    const fileRows = [];
    for (const file of files) {
      const storagePath = `${caseId}/${Date.now()}-${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
      const binary = new Uint8Array(await file.arrayBuffer());
      const contentType = inferContentType(file);
      const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, binary, {
        contentType,
        upsert: false,
      });

      if (uploadError) {
        throw uploadError;
      }

      uploadedPaths.push(storagePath);
      fileRows.push({
        case_id: caseId,
        original_name: file.name,
        storage_bucket: STORAGE_BUCKET,
        storage_path: storagePath,
        mime_type: contentType,
        size_bytes: file.size,
      });
    }

    const caseRow = {
      id: caseId,
      owner_user_id: user.id,
      slug: summary.slug,
      display_name: summary.displayName,
      buyer_name: summary.buyerName || null,
      po_number: summary.poNumber || null,
      invoice_number: summary.invoiceNumber || null,
      status: "completed",
      risk_score: summary.riskScore,
      upload_count: files.length,
      document_count: documents.length,
      mismatch_count: mismatches.length,
      processing_meta: {
        documentTypes: summary.documentTypes,
        caseCategory: summary.category,
        packetCategory: summary.packetCategory,
        missingDocumentGroups: summary.missingDocTypes,
        paymentGap: summary.paymentGap,
        comparisonOptions,
        uploadGroups,
      },
    };

    const { data: insertedCase, error: caseError } = await supabase
      .from("packet_cases")
      .insert(caseRow)
      .select(
        "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
      )
      .single();

    if (caseError) {
      throw caseError;
    }

    if (fileRows.length) {
      const { error: fileInsertError } = await supabase.from("packet_case_files").insert(fileRows);
      if (fileInsertError) {
        throw fileInsertError;
      }
    }

    const documentRows = documents.map((document) => ({
      case_id: caseId,
      client_document_id: document.id,
      source_file_name: document.sourceFileName ?? document.sourceHint ?? null,
      source_hint: document.sourceHint ?? null,
      document_type: document.type,
      title: document.title,
      page_count: document.pages,
      extracted_fields: document.fields ?? {},
      markdown: document.md ?? "",
    }));

    const { error: documentInsertError } = await supabase.from("packet_documents").insert(documentRows);
    if (documentInsertError) {
      throw documentInsertError;
    }

    if (mismatches.length) {
      const mismatchRows = mismatches.map((mismatch) => ({
        case_id: caseId,
        client_mismatch_id: mismatch.id,
        field_name: mismatch.field,
        values_json: mismatch.values ?? [],
        analysis: mismatch.analysis ?? null,
        fix_plan: mismatch.fixPlan ?? null,
      }));

      const { error: mismatchInsertError } = await supabase.from("packet_mismatches").insert(mismatchRows);
      if (mismatchInsertError) {
        throw mismatchInsertError;
      }
    }

    return NextResponse.json(
      {
        case: mapCaseRow(insertedCase),
      },
      { status: 201 }
    );
  } catch (error) {
    if (supabase && uploadedPaths.length > 0) {
      await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths);
    }

    if (supabase && caseId) {
      await supabase.from("packet_cases").delete().eq("id", caseId);
    }

    return NextResponse.json(
      {
        error: serializeError(error),
      },
      { status: 500 }
    );
  }
}
