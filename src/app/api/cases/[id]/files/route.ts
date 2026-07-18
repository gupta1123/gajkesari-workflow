import { NextResponse } from "next/server";

import {
  getCaseCategoryFromProcessingMeta,
  resolveCaseCategoryLabel,
  resolveStoredCaseDisplayName,
} from "@/lib/case-summary";
import { getRecycleBinDeletedAt, isCaseRecycled } from "@/lib/recycle-bin";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mergeUploadGroupMeta, readUploadGroupMeta } from "@/lib/upload-groups";

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

function isFileEntry(entry: FormDataEntryValue): entry is File {
  return typeof entry !== "string";
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

function serializeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error ?? "Unknown error");

  const record = error as Record<string, unknown>;
  return [record.message, record.details, record.hint, record.error]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ") || JSON.stringify(error);
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
  const uploadedPaths: string[] = [];
  const supabase = createSupabaseAdminClient();

  try {
    const { id } = await context.params;
    const authClient = await createSupabaseServerClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const mode = formData.get("mode") === "overwrite" ? "overwrite" : "append";
    const files = formData.getAll("files").filter(isFileEntry);
    const uploadGroups = parseUploadGroups(formData.get("uploadGroups"));

    if (!files.length) {
      return NextResponse.json({ error: "Upload at least one file." }, { status: 400 });
    }

    let existing:
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
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
        )
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
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
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

    if (mode === "overwrite") {
      const names = files.map((file) => file.name);
      const { data: oldFiles, error: oldFilesError } = await supabase
        .from("packet_case_files")
        .select("id, storage_bucket, storage_path")
        .eq("case_id", id)
        .in("original_name", names);

      if (oldFilesError) throw oldFilesError;

      const pathsByBucket = new Map<string, string[]>();
      for (const file of oldFiles ?? []) {
        const bucket = file.storage_bucket || STORAGE_BUCKET;
        pathsByBucket.set(bucket, [...(pathsByBucket.get(bucket) ?? []), file.storage_path]);
      }

      for (const [bucket, paths] of pathsByBucket.entries()) {
        if (paths.length) {
          const { error: removeError } = await supabase.storage.from(bucket).remove(paths);
          if (removeError) throw removeError;
        }
      }

      if (oldFiles?.length) {
        const { error: deleteRowsError } = await supabase
          .from("packet_case_files")
          .delete()
          .in(
            "id",
            oldFiles.map((file) => file.id)
          );

        if (deleteRowsError) throw deleteRowsError;
      }
    }

    const fileRows = [];
    for (const file of files) {
      const storagePath = `${id}/${Date.now()}-${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
      const binary = new Uint8Array(await file.arrayBuffer());
      const contentType = inferContentType(file);
      const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, binary, {
        contentType,
        upsert: false,
      });

      if (uploadError) throw uploadError;

      uploadedPaths.push(storagePath);
      fileRows.push({
        case_id: id,
        original_name: file.name,
        storage_bucket: STORAGE_BUCKET,
        storage_path: storagePath,
        mime_type: contentType,
        size_bytes: file.size,
      });
    }

    const { error: fileInsertError } = await supabase.from("packet_case_files").insert(fileRows);
    if (fileInsertError) throw fileInsertError;

    const { count, error: countError } = await supabase
      .from("packet_case_files")
      .select("id", { count: "exact", head: true })
      .eq("case_id", id);

    if (countError) throw countError;

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
      const existingMeta =
        existing.processing_meta && typeof existing.processing_meta === "object"
          ? (existing.processing_meta as Record<string, unknown>)
          : {};
      const existingUploadGroups = readUploadGroupMeta(existingMeta.uploadGroups);
      const nextPayload: Record<string, unknown> = {
        upload_count: count ?? existing.upload_count + files.length,
      };

      if (uploadGroups.length) {
        nextPayload.processing_meta = {
          ...existingMeta,
          uploadGroups: mergeUploadGroupMeta(existingUploadGroups, uploadGroups),
        };
      }

      const result = await supabase
        .from("packet_cases")
        .update(nextPayload)
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

      const existingMeta =
        existing.processing_meta && typeof existing.processing_meta === "object"
          ? (existing.processing_meta as Record<string, unknown>)
          : {};
      const existingUploadGroups = readUploadGroupMeta(existingMeta.uploadGroups);
      const nextPayload: Record<string, unknown> = {
        upload_count: count ?? existing.upload_count + files.length,
      };

      if (uploadGroups.length) {
        nextPayload.processing_meta = {
          ...existingMeta,
          uploadGroups: mergeUploadGroupMeta(existingUploadGroups, uploadGroups),
        };
      }

      const fallback = await supabase
        .from("packet_cases")
        .update(nextPayload)
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
    if (uploadedPaths.length > 0) {
      await supabase.storage.from(STORAGE_BUCKET).remove(uploadedPaths);
    }

    return NextResponse.json({ error: serializeError(error) }, { status: 500 });
  }
}
