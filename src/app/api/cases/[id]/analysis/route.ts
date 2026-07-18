import { NextResponse } from "next/server";

import {
  getCaseCategoryFromProcessingMeta,
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
import type { CaseDoc, FieldKey, Mismatch } from "@/types/pipeline";

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
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error ?? "Unknown error");

  const record = error as Record<string, unknown>;
  const combined =
    [record.message, record.details, record.hint, record.error]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ") || JSON.stringify(error);

  if (/packet_cases_status_check|violates check constraint/i.test(combined)) {
    return `${combined} Run the case draft migration in Supabase using supabase/packet_case_draft_backend_v5.sql, then retry.`;
  }

  return combined;
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

function mapCaseRow(row: {
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
}) {
  const category = resolveCaseCategoryLabel({
    receiverName: row.buyer_name,
    storedCategory: getCaseCategoryFromProcessingMeta(row.processing_meta, row.status),
    status: row.status,
  });

  return {
    id: row.id,
    slug: row.slug,
    displayName: resolveStoredCaseDisplayName({
      storedDisplayName: row.display_name,
      receiverName: row.buyer_name,
      invoiceNumber: row.invoice_number,
      poNumber: row.po_number,
      category,
      status: row.status,
    }),
    buyerName: row.buyer_name,
    receiverName: row.buyer_name,
    category,
    poNumber: row.po_number,
    invoiceNumber: row.invoice_number,
    status: row.status,
    riskScore: row.risk_score,
    uploadCount: row.upload_count,
    documentCount: row.document_count,
    mismatchCount: row.mismatch_count,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? getRecycleBinDeletedAt(row.processing_meta),
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const authClient = await createSupabaseServerClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();
    const fieldConfiguration = await getPersistedPacketFieldConfiguration();
    const formData = await request.formData();
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

    let existing:
      | {
          id: string;
          processing_meta?: unknown;
          deleted_at?: string | null;
        }
      | null = null;

    try {
      const result = await supabase
        .from("packet_cases")
        .select("id, processing_meta, deleted_at")
        .eq("id", id)
        .eq("owner_user_id", user.id)
        .single();

      if (result.error) {
        if (result.error.code === "PGRST116") {
          return NextResponse.json({ error: "Case not found." }, { status: 404 });
        }
        throw result.error;
      }

      existing = result.data;
    } catch (error) {
      if (!isRecycleBinSchemaMissing(error)) {
        throw error;
      }

      const fallback = await supabase
        .from("packet_cases")
        .select("id, processing_meta")
        .eq("id", id)
        .eq("owner_user_id", user.id)
        .single();

      if (fallback.error) {
        if (fallback.error.code === "PGRST116") {
          return NextResponse.json({ error: "Case not found." }, { status: 404 });
        }
        throw fallback.error;
      }

      existing = fallback.data;
    }

    if ((existing.deleted_at ?? null) || isCaseRecycled(existing.processing_meta)) {
      return NextResponse.json({ error: "Case not found." }, { status: 404 });
    }

    const [
      { count: uploadCount, error: fileCountError },
      { error: documentDeleteError },
      { error: mismatchDeleteError },
    ] = await Promise.all([
      supabase
        .from("packet_case_files")
        .select("id", { count: "exact", head: true })
        .eq("case_id", id),
      supabase.from("packet_documents").delete().eq("case_id", id),
      supabase.from("packet_mismatches").delete().eq("case_id", id),
    ]);

    if (fileCountError) throw fileCountError;
    if (documentDeleteError) throw documentDeleteError;
    if (mismatchDeleteError) throw mismatchDeleteError;

    const documentRows = documents.map((document) => ({
      case_id: id,
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
    if (documentInsertError) throw documentInsertError;

    if (mismatches.length) {
      const mismatchRows = mismatches.map((mismatch) => ({
        case_id: id,
        client_mismatch_id: mismatch.id,
        field_name: mismatch.field,
        values_json: mismatch.values ?? [],
        analysis: mismatch.analysis ?? null,
        fix_plan: mismatch.fixPlan ?? null,
      }));

      const { error: mismatchInsertError } = await supabase.from("packet_mismatches").insert(mismatchRows);
      if (mismatchInsertError) throw mismatchInsertError;
    }

    const summary = summarizeCase(documents, mismatches, fieldConfiguration);
    const existingMeta =
      existing.processing_meta && typeof existing.processing_meta === "object"
        ? (existing.processing_meta as Record<string, unknown>)
        : {};
    const nextCasePayload = {
      slug: summary.slug,
      display_name: summary.displayName,
      buyer_name: summary.buyerName || null,
      po_number: summary.poNumber || null,
      invoice_number: summary.invoiceNumber || null,
      status: "completed",
      risk_score: summary.riskScore,
      upload_count: uploadCount ?? documents.length,
      document_count: documents.length,
      mismatch_count: mismatches.length,
      processing_meta: {
        ...existingMeta,
        draft: false,
        analyzedAt: new Date().toISOString(),
        caseCategory: summary.category,
        packetCategory: summary.packetCategory,
        documentTypes: summary.documentTypes,
        missingDocumentGroups: summary.missingDocTypes,
        paymentGap: summary.paymentGap,
        comparisonOptions,
      },
    };

    let updatedCase:
      | {
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
        }
      | null = null;

    try {
      const result = await supabase
        .from("packet_cases")
        .update(nextCasePayload)
        .eq("id", id)
        .eq("owner_user_id", user.id)
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
        )
        .single();

      if (result.error) throw result.error;
      updatedCase = result.data;
    } catch (error) {
      if (!isRecycleBinSchemaMissing(error)) {
        throw error;
      }

      const fallback = await supabase
        .from("packet_cases")
        .update(nextCasePayload)
        .eq("id", id)
        .eq("owner_user_id", user.id)
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .single();

      if (fallback.error) throw fallback.error;
      updatedCase = fallback.data;
    }

    return NextResponse.json({ case: mapCaseRow(updatedCase) });
  } catch (error) {
    return NextResponse.json({ error: serializeError(error) }, { status: 500 });
  }
}
