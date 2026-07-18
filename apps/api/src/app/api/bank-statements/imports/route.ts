import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  BANK_STATEMENT_BUCKET,
  buildStoragePath,
  type BankAccountInput,
} from "@/lib/bank-statements";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

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

function serializeImport(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : null,
    originalFileName: String(row.original_file_name ?? ""),
    status: String(row.status ?? ""),
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
      .select("*")
      .eq("owner_user_id", user.id)
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

    const manualAccount = readJsonField<BankAccountInput>(formData.get("account"), {});
    const connectionId = readTextField(formData.get("connectionId"));
    const companyName = readTextField(formData.get("companyName"));
    const financialYear = readTextField(formData.get("financialYear"));
    const bankLedgerName = readTextField(formData.get("bankLedgerName"));
    const syncBeforeAnalysis = readTextField(formData.get("syncBeforeAnalysis")) !== "false";

    if (!connectionId) {
      return jsonWithCors(request, { error: "Select a Tally company before upload." }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const storagePath = buildStoragePath(user.id, file.name || "bank-statement");
    const supabase = createSupabaseAdminClient();

    const upload = await supabase.storage.from(BANK_STATEMENT_BUCKET).upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (upload.error) throw upload.error;

    const insertPayload = {
      owner_user_id: user.id,
      bank_account_id: null,
      original_file_name: file.name || "bank-statement",
      storage_bucket: BANK_STATEMENT_BUCKET,
      storage_path: storagePath,
      mime_type: file.type || null,
      size_bytes: file.size,
      status: "processing",
      statement_period_start: null,
      statement_period_end: null,
      processing_meta: {
        source: "bank_statement_upload",
        tallyLedgerName: bankLedgerName,
        selectedContext: {
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

    if (insertError) throw insertError;

    const { error: jobInsertError } = await supabase.from("bank_statement_extraction_jobs").insert({
      import_id: createdImport.id,
      owner_user_id: user.id,
      status: "queued",
      progress: 5,
      stage: "Statement uploaded",
      result: {},
    });

    if (jobInsertError) throw jobInsertError;

    return jsonWithCors(request, serializePreviewFromMeta(createdImport as Record<string, unknown>));
  } catch (error) {
    console.error("Error in POST /api/bank-statements/imports:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
