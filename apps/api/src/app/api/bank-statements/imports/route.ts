import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  BANK_STATEMENT_BUCKET,
  buildStoragePath,
  type BankAccountInput,
} from "@/lib/bank-statements";
import { createBankStatementJobResult } from "@/lib/bank-statement-worker-pool";
import { PdfSecurityError, unlockPdfIfNeeded } from "@/lib/pdf-security";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createHash } from "node:crypto";
import { browserDatasetIds, resolveBankStatementUploadTarget } from "@/lib/tally/browser-scope";
import { queueTallyCommandAndWake } from "@/lib/tally/queue-command";

export const runtime = "nodejs";
const BANK_STATEMENT_EXTRACTION_VERSION = 2;
const BANK_STATEMENT_MAX_UPLOAD_BYTES = Math.max(
  1,
  Number(process.env.BANK_STATEMENT_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024)
);

function readJsonField<T>(value: FormDataEntryValue | null, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readTextField(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function isPdfUpload(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}


function getEffectiveImportStatus(row: Record<string, unknown>) {
  const rawStatus = String(row.status ?? "");
  const meta = readRecord(row.processing_meta);
  const analysis = readRecord(meta.analysis);
  const analysisStatus = typeof analysis.status === "string" ? analysis.status : "";
  const jobStatus = typeof meta.jobStatus === "string" ? meta.jobStatus : "";

  if (
    rawStatus === "processing" &&
    (analysisStatus === "completed" || jobStatus === "completed")
  ) {
    const previewTransactionCount = Number(meta.previewTransactionCount ?? 0);
    return previewTransactionCount > 0 ? "ready_to_review" : "manual_review_required";
  }

  return rawStatus;
}

function serializeImport(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : null,
    originalFileName: String(row.original_file_name ?? ""),
    status: getEffectiveImportStatus(row),
    extractedBankName: row.extracted_bank_name ? String(row.extracted_bank_name) : null,
    extractedAccountNumber: row.extracted_account_number ? String(row.extracted_account_number) : null,
    extractedAccountHolderName: row.extracted_account_holder_name
      ? String(row.extracted_account_holder_name)
      : null,
    extractedIfscCode: row.extracted_ifsc_code ? String(row.extracted_ifsc_code) : null,
    statementPeriodStart: row.statement_period_start ? String(row.statement_period_start) : null,
    statementPeriodEnd: row.statement_period_end ? String(row.statement_period_end) : null,
    importedTransactionCount: Number(row.imported_transaction_count ?? 0),
    duplicateTransactionCount: Number(row.duplicate_transaction_count ?? 0),
    sourceSha256: row.source_sha256 ? String(row.source_sha256) : null,
    createdAt: String(row.created_at ?? ""),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function serializePreviewFromMeta(row: Record<string, unknown>) {
  const meta = readRecord(row.processing_meta);
  const preview = readRecord(meta.preview);
  const analysis = readRecord(meta.analysis);

  return {
    import: serializeImport(row),
    account: readRecord(preview.account),
    candidates: Array.isArray(preview.candidates) ? preview.candidates : [],
    transactions: Array.isArray(preview.transactions) ? preview.transactions : [],
    requiresManualExtraction: Boolean(preview.requiresManualExtraction),
    extractionSource: preview.extractionSource ?? null,
    extractionError: preview.extractionError ?? null,
    extractionDiagnostics: preview.extractionDiagnostics ?? null,
    processing: analysis.status === "processing" || analysis.status === "queued",
    job: {
      id: String(row.id),
      status: String(analysis.status ?? "completed"),
      progress: Number(analysis.progress ?? 100),
      stage: typeof analysis.stage === "string" ? analysis.stage : null,
      error: typeof analysis.error === "string" ? analysis.error : null,
    },
  };
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("bank_statement_imports")
      .select("id,bank_account_id,original_file_name,status,extracted_bank_name,extracted_account_number,extracted_account_holder_name,extracted_ifsc_code,statement_period_start,statement_period_end,imported_transaction_count,duplicate_transaction_count,source_sha256,created_at")
      .eq("owner_user_id", user.id)
      .in("company_dataset_id", await browserDatasetIds(request, user.id))
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    return jsonWithCors(request, {
      imports: (data ?? []).map((row) => serializeImport(row as Record<string, unknown>)),
    });
  } catch (error) {
    console.error("Error in GET /api/bank-statements/imports:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return jsonWithCors(request, { error: "Upload a bank statement file." }, { status: 400 });
    }
    if (file.size <= 0) {
      return jsonWithCors(request, { error: "The bank statement file is empty." }, { status: 400 });
    }
    if (file.size > BANK_STATEMENT_MAX_UPLOAD_BYTES) {
      return jsonWithCors(
        request,
        { error: `The bank statement is larger than the ${Math.round(BANK_STATEMENT_MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.` },
        { status: 413 }
      );
    }

    const manualAccount = readJsonField<BankAccountInput>(formData.get("account"), {});
    const connectionId = readTextField(formData.get("connectionId"));
    const companyName = readTextField(formData.get("companyName"));
    const financialYear = readTextField(formData.get("financialYear"));
    const bankLedgerName = readTextField(formData.get("bankLedgerName"));
    const syncBeforeAnalysis = readTextField(formData.get("syncBeforeAnalysis")) !== "false";
    const statementPasswordValue = formData.get("statementPassword");
    const statementPassword = typeof statementPasswordValue === "string" ? statementPasswordValue : "";

    if (!connectionId) {
      return jsonWithCors(request, { error: "Select a Tally company before upload." }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const [target, uploadBytes] = await Promise.all([
      resolveBankStatementUploadTarget(request, user.id, connectionId, companyName),
      isPdfUpload(file) ? unlockPdfIfNeeded(bytes, statementPassword) : Promise.resolve(bytes),
    ]);
    const supabase = createSupabaseAdminClient();
    const sourceSha256 = createHash("sha256").update(uploadBytes).digest("hex");

    const storagePath = buildStoragePath(user.id, file.name || "bank-statement");

    const upload = await supabase.storage.from(BANK_STATEMENT_BUCKET).upload(storagePath, uploadBytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (upload.error) throw upload.error;

    const insertPayload = {
      owner_user_id: user.id,
      company_dataset_id: target.companyDatasetId,
      // Connector-first analysis owns the live ledger catalogue locally. A
      // per-import cloud snapshot would duplicate thousands of ledger names.
      catalogue_snapshot_id: null,
      bank_account_id: null,
      original_file_name: file.name || "bank-statement",
      storage_bucket: BANK_STATEMENT_BUCKET,
      storage_path: storagePath,
      mime_type: file.type || null,
      size_bytes: file.size,
      source_sha256: sourceSha256,
      status: "processing",
      statement_period_start: null,
      statement_period_end: null,
      processing_meta: {
        source: "bank_statement_upload",
        extractionVersion: BANK_STATEMENT_EXTRACTION_VERSION,
        tallyLedgerName: bankLedgerName,
        selectedContext: {
          target,
          connectionId,
          companyName,
          financialYear,
          bankLedgerName,
          syncBeforeAnalysis,
        },
        analysis: {
          status: "queued",
          progress: 5,
          stage: "Statement uploaded",
          error: null,
          connectionId,
          companyName,
          financialYear,
          bankLedgerName,
          syncBeforeAnalysis,
          manualAccount,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    };

    const { data: createdImport, error: insertError } = await supabase
      .from("bank_statement_imports")
      .insert(insertPayload)
      .select("*")
      .single();

    if (insertError) {
      await supabase.storage.from(BANK_STATEMENT_BUCKET).remove([storagePath]).catch(() => undefined);
      throw insertError;
    }

    // Start local parsing/vector retrieval immediately after storage succeeds.
    // The extraction worker is queued afterwards, so connector execution can
    // overlap the worker's claim and setup instead of waiting behind it.
    let prequeuedConnectorCommandId: string | null = null;
    let connectorQueuedAt: string | null = null;
    if (isPdfUpload(file)) {
      try {
        const { data: signed, error: signedUrlError } = await supabase.storage
          .from(BANK_STATEMENT_BUCKET)
          .createSignedUrl(storagePath, 5 * 60);
        if (signedUrlError || !signed?.signedUrl) throw signedUrlError ?? new Error("Signed URL unavailable.");

        const queued = await queueTallyCommandAndWake<{ id: string }>({
          supabase,
          connectionId,
          ownerUserId: user.id,
          commandType: "parse_and_suggest",
          priority: 5,
          companyDatasetId: target.companyDatasetId,
          select: "id",
          payload: {
            documentUrl: signed.signedUrl,
            fileName: "bank-statement.pdf",
            output: "json",
            companyName,
            companyGuid: target.companyGuid,
            topK: 10,
            importId: createdImport.id,
            target,
          },
        });
        prequeuedConnectorCommandId = queued.command.id;
        connectorQueuedAt = new Date().toISOString();
      } catch (connectorError) {
        // The worker retains the authoritative retry/fallback path. A failed
        // eager dispatch must never make the upload itself fail.
        console.warn(
          "Could not prequeue connector preprocessing; the worker will retry it.",
          connectorError instanceof Error ? connectorError.message : connectorError
        );
      }
    }

    const { error: jobInsertError } = await supabase.from("bank_statement_extraction_jobs").insert({
      import_id: createdImport.id,
      owner_user_id: user.id,
      status: "queued",
      progress: 5,
      stage: "Statement uploaded",
      result: {
        ...createBankStatementJobResult(),
        connectorCommandId: prequeuedConnectorCommandId,
        connectorQueuedAt,
      },
    });

    if (jobInsertError) {
      if (prequeuedConnectorCommandId) {
        await supabase
          .from("tally_bridge_commands")
          .delete()
          .eq("id", prequeuedConnectorCommandId)
          .eq("owner_user_id", user.id);
      }
      await supabase.from("bank_statement_imports").delete().eq("id", createdImport.id);
      await supabase.storage.from(BANK_STATEMENT_BUCKET).remove([storagePath]);
      throw jobInsertError;
    }

    return jsonWithCors(request, serializePreviewFromMeta(createdImport as Record<string, unknown>));
  } catch (error) {
    if (error instanceof PdfSecurityError) {
      const status =
        error.code === "BANK_STATEMENT_PASSWORD_REQUIRED"
          ? 423
          : error.code === "BANK_STATEMENT_PDF_SERVICE_UNAVAILABLE"
            ? 503
            : 400;
      return jsonWithCors(
        request,
        { error: error.message, code: error.code },
        { status }
      );
    }
    console.error("Error in POST /api/bank-statements/imports:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
