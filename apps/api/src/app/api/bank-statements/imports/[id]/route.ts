import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { suggestBankLedgerForTransaction } from "@/lib/bank-statement-ledger-matching";
import { getBankLedgerMatchingModel } from "@/lib/processing/openrouter";
import {
  findBankAccountCandidates,
  maskAccountNumber,
  serializeAccount,
} from "@/lib/bank-statements";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBankAccountNumber(value: unknown) {
  return String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function isBankLedgerMaster(row: Record<string, unknown>) {
  const raw = readRecord(row.raw_payload);
  const parentName = String(row.parent_name ?? "").toLowerCase();
  return (
    /\bbank\s+accounts?\b/.test(parentName) ||
    Boolean(String(raw.bankName ?? raw.bank_name ?? "").trim()) ||
    Boolean(String(raw.bankAccountNumber ?? raw.accountNumber ?? raw.account_number ?? "").trim())
  );
}

function bankLedgerAccountNumber(row: Record<string, unknown>) {
  const raw = readRecord(row.raw_payload);
  const explicitAccountNumber = normalizeBankAccountNumber(
    raw.bankAccountNumber ?? raw.accountNumber ?? raw.account_number
  );
  if (explicitAccountNumber) return explicitAccountNumber;

  const accountNumbersInName = Array.from(
    new Set(
      (String(row.tally_name ?? "").match(/\d{6,18}/g) ?? [])
        .map(normalizeBankAccountNumber)
        .filter(Boolean)
    )
  );
  return accountNumbersInName.length === 1 ? accountNumbersInName[0] : "";
}

async function resolveStatementBankLedger(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  ownerUserId: string,
  connectionId: string | null,
  accountNumber: string | null,
  savedCandidates: Array<{ accountNumber?: string | null; tallyLedgerName?: string | null }>,
  legacyProvidedLedgerName: string | null | undefined
) {
  const legacyProvidedLedger = String(legacyProvidedLedgerName ?? "").trim();
  const normalizedAccountNumber = normalizeBankAccountNumber(accountNumber);

  // A saved mapping is safe only for the exact account extracted from this statement.
  // Matching on the holder alone can route a different company account to its ledger.
  const savedLedgers = Array.from(
    new Set(
      savedCandidates
        .filter(
          (candidate) =>
            normalizedAccountNumber &&
            normalizeBankAccountNumber(candidate.accountNumber) === normalizedAccountNumber
        )
        .map((candidate) => String(candidate.tallyLedgerName ?? "").trim())
        .filter(Boolean)
    )
  );
  if (savedLedgers.length === 1) {
    return { ledgerName: savedLedgers[0], source: "saved_bank_account_mapping", requiresSelection: false, verified: true };
  }
  if (savedLedgers.length > 1) {
    return { ledgerName: null, source: "ambiguous_saved_bank_account_mapping", requiresSelection: true, verified: false };
  }

  if (!connectionId || !normalizedAccountNumber) {
    return {
      ledgerName: legacyProvidedLedger || null,
      source: legacyProvidedLedger ? "legacy_manual_selection" : connectionId ? "missing_statement_account_number" : "missing_tally_connection",
      requiresSelection: !legacyProvidedLedger,
      verified: false,
    };
  }

  const { data, error } = await supabase
    .from("tally_masters")
    .select("tally_name, parent_name, raw_payload")
    .eq("owner_user_id", ownerUserId)
    .eq("connection_id", connectionId)
    .eq("master_type", "ledger")
    .eq("is_active", true)
    .limit(5000);
  if (error) throw error;

  const exactLedgerNames = Array.from(
    new Set(
      ((data ?? []) as Array<Record<string, unknown>>)
        .filter(isBankLedgerMaster)
        .filter((ledger) => bankLedgerAccountNumber(ledger) === normalizedAccountNumber)
        .map((ledger) => String(ledger.tally_name ?? "").trim())
        .filter(Boolean)
    )
  );

  if (exactLedgerNames.length === 1) {
    return { ledgerName: exactLedgerNames[0], source: "tally_bank_account_number", requiresSelection: false, verified: true };
  }

  return {
    ledgerName: legacyProvidedLedger || null,
    source: legacyProvidedLedger
      ? "legacy_manual_selection"
      : exactLedgerNames.length > 1
        ? "ambiguous_tally_bank_account_number"
        : "no_exact_tally_bank_account_match",
    requiresSelection: !legacyProvidedLedger,
    verified: false,
  };
}function serializeImport(row: Record<string, unknown>) {
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

function serializePreviewTransaction(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    transactionDate: row.transaction_date ? String(row.transaction_date) : null,
    valueDate: row.value_date ? String(row.value_date) : null,
    description: row.description ? String(row.description) : null,
    referenceNumber: row.reference_number ? String(row.reference_number) : null,
    debitAmount: row.debit_amount ?? null,
    creditAmount: row.credit_amount ?? null,
    balanceAmount: row.balance_amount ?? null,
    transactionType: row.transaction_type ? String(row.transaction_type) : null,
    category: row.category ? String(row.category) : null,
    counterpartyName: row.counterparty_name ? String(row.counterparty_name) : null,
    suggestedLedgerName: row.suggested_ledger_name ? String(row.suggested_ledger_name) : null,
    suggestionConfidence:
      typeof row.suggestion_confidence === "number"
        ? row.suggestion_confidence
        : row.suggestion_confidence
          ? Number(row.suggestion_confidence)
          : null,
    suggestionReason: row.suggestion_reason ? String(row.suggestion_reason) : null,
    confirmedLedgerName: row.confirmed_ledger_name ? String(row.confirmed_ledger_name) : null,
  };
}

function isPreviewTransactionArray(value: unknown) {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function toNumber(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function hasAiLedgerRecommendation(row: Record<string, unknown>) {
  const rawPayload = readRecord(row.raw_payload);
  return Boolean(readRecord(rawPayload.aiLedgerRecommendation).model);
}

function readConnectionIdFromMeta(processingMeta: Record<string, unknown>) {
  const selectedContext = readRecord(processingMeta.selectedContext);
  const analysis = readRecord(processingMeta.analysis);
  return typeof selectedContext.connectionId === "string"
    ? selectedContext.connectionId
    : typeof analysis.connectionId === "string"
      ? analysis.connectionId
      : null;
}

async function enrichPreviewRowsWithAiSuggestions(params: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  ownerUserId: string;
  connectionId: string | null;
  importId: string;
  rows: Array<Record<string, unknown>>;
}) {
  if (!params.connectionId || params.rows.length === 0 || params.rows.every(hasAiLedgerRecommendation)) {
    return params.rows;
  }

  const enrichedRows = await Promise.all(
    params.rows.map(async (row) => {
      if (hasAiLedgerRecommendation(row)) return row;

      const suggestion = await suggestBankLedgerForTransaction({
        supabase: params.supabase,
        ownerUserId: params.ownerUserId,
        connectionId: params.connectionId,
        accountId: String(row.bank_account_id ?? ""),
        transaction: {
          transactionDate: row.transaction_date ? String(row.transaction_date) : "",
          valueDate: row.value_date ? String(row.value_date) : null,
          description: String(row.description ?? ""),
          referenceNumber: row.reference_number ? String(row.reference_number) : null,
          debitAmount: toNumber(row.debit_amount),
          creditAmount: toNumber(row.credit_amount),
          balanceAmount: toNumber(row.balance_amount),
          transactionType: row.transaction_type ? String(row.transaction_type) : undefined,
          category: row.category ? String(row.category) : undefined,
          counterpartyName: row.counterparty_name ? String(row.counterparty_name) : null,
        },
      });
      const rawPayload = readRecord(row.raw_payload);
      const aiLedgerRecommendation = {
        matchType: suggestion.matchType ?? (suggestion.ledgerName ? "direct_match" : "suspense"),
        action: suggestion.ledgerName ? "use_existing_ledger" : "use_suspense",
        ledgerName: suggestion.ledgerName,
        candidateLedgerNames: suggestion.candidateLedgerNames ?? [],
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        model: getBankLedgerMatchingModel(),
        source: "import_preview_api",
      };
      const update = {
        suggested_ledger_name: suggestion.ledgerName,
        suggestion_confidence: suggestion.confidence,
        suggestion_reason: suggestion.reason,
        raw_payload: {
          ...rawPayload,
          aiLedgerRecommendation,
        },
      };

      await params.supabase
        .from("bank_statement_import_preview_transactions")
        .update(update)
        .eq("id", row.id)
        .eq("owner_user_id", params.ownerUserId)
        .eq("import_id", params.importId);

      return {
        ...row,
        ...update,
      };
    })
  );

  return enrichedRows;
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const supabase = createSupabaseAdminClient();
    const { data: importRow, error: importError } = await supabase
      .from("bank_statement_imports")
      .select("*")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .single();

    if (importError || !importRow) {
      return jsonWithCors(request, { error: "Bank statement import was not found." }, { status: 404 });
    }

    const { data: latestJobRow, error: jobError } = await supabase
      .from("bank_statement_extraction_jobs")
      .select("*")
      .eq("import_id", id)
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (jobError) throw jobError;
    let jobRow = latestJobRow;

    const { data: previewRows, error: previewError } = await supabase
      .from("bank_statement_import_preview_transactions")
      .select("*")
      .eq("import_id", id)
      .eq("owner_user_id", user.id)
      .order("row_index", { ascending: true });

    if (previewError) throw previewError;

    const processingMeta = readRecord(importRow.processing_meta);
    const previewMeta = readRecord(processingMeta.preview);
    const previewAccount = readRecord(previewMeta.account);
    const storedPreviewTransactions = isPreviewTransactionArray(previewMeta.transactions);
    const tablePreviewTransactions = await enrichPreviewRowsWithAiSuggestions({
      supabase,
      ownerUserId: user.id,
      connectionId: readConnectionIdFromMeta(processingMeta),
      importId: id,
      rows: (previewRows ?? []) as Array<Record<string, unknown>>,
    });
    const transactions =
      tablePreviewTransactions.length > 0
        ? tablePreviewTransactions.map((row) => serializePreviewTransaction(row))
        : storedPreviewTransactions;
    const analysis = readRecord(processingMeta.analysis);
    const analysisStatus = typeof analysis.status === "string" ? analysis.status : "";
    const jobStatus = typeof jobRow?.status === "string" ? jobRow.status : "";
    const jobIsTerminal = ["succeeded", "failed", "cancelled"].includes(jobStatus);
    const processing =
      !jobIsTerminal &&
      (importRow.status === "processing" || analysisStatus === "queued" || analysisStatus === "processing");

    if (!jobRow && processing) {
      const { data: repairedJobRow, error: repairJobError } = await supabase
        .from("bank_statement_extraction_jobs")
        .insert({
          import_id: id,
          owner_user_id: user.id,
          status: "queued",
          progress: Number(analysis.progress ?? 5),
          stage: typeof analysis.stage === "string" ? analysis.stage : "Statement uploaded",
          result: {},
        })
        .select("*")
        .single();

      if (repairJobError) throw repairJobError;
      jobRow = repairedJobRow;
    }

    const requiresManualExtraction =
      importRow.status === "manual_review_required" ||
      importRow.status === "failed" ||
      Boolean(previewMeta.requiresManualExtraction) ||
      (!processing && transactions.length === 0);
    const account = {
      bankName:
        typeof previewAccount.bankName === "string"
          ? previewAccount.bankName
          : importRow.extracted_bank_name ?? null,
      accountNumber:
        typeof previewAccount.accountNumber === "string"
          ? previewAccount.accountNumber
          : importRow.extracted_account_number ?? null,
      accountNumberMasked:
        typeof previewAccount.accountNumberMasked === "string"
          ? previewAccount.accountNumberMasked
          : maskAccountNumber(importRow.extracted_account_number),
      accountHolderName:
        typeof previewAccount.accountHolderName === "string"
          ? previewAccount.accountHolderName
          : importRow.extracted_account_holder_name ?? null,
      ifscCode:
        typeof previewAccount.ifscCode === "string"
          ? previewAccount.ifscCode
          : importRow.extracted_ifsc_code ?? null,
      tallyLedgerName:
        typeof processingMeta.tallyLedgerName === "string" ? processingMeta.tallyLedgerName : null,
    };
    const candidates = Array.isArray(previewMeta.candidates)
      ? previewMeta.candidates
      : ["ready_to_review", "ready_to_confirm", "needs_account_selection"].includes(importRow.status)
      ? await findBankAccountCandidates(supabase, user.id, {
          bankName: account.bankName,
          accountNumber: account.accountNumber,
          accountHolderName: account.accountHolderName,
          ifscCode: account.ifscCode,
        })
      : [];
    const bankLedgerResolution = await resolveStatementBankLedger(
      supabase,
      user.id,
      readConnectionIdFromMeta(processingMeta),
      account.accountNumber,
      candidates,
      account.tallyLedgerName
    );
    account.tallyLedgerName = bankLedgerResolution.ledgerName;

    return jsonWithCors(request, {
      import: serializeImport(importRow as Record<string, unknown>),
      account,
      candidates: Array.isArray(previewMeta.candidates) ? candidates : candidates.map(serializeAccount),
      bankLedgerResolution,
      transactions,
      requiresManualExtraction,
      extractionSource: previewMeta.extractionSource ?? processingMeta.extractionSource ?? null,
      extractionError: previewMeta.extractionError ?? processingMeta.extractionError ?? null,
      extractionDiagnostics: previewMeta.extractionDiagnostics ?? processingMeta.extractionDiagnostics ?? null,
      processing,
      job: jobRow
        ? {
            id: jobRow.id,
            status: jobRow.status,
            progress: jobRow.progress,
            stage: jobRow.stage,
            error: jobRow.error,
          }
        : {
            id: String(importRow.id),
            status: analysisStatus || (processing ? "processing" : "completed"),
            progress: Number(analysis.progress ?? (processing ? 5 : 100)),
            stage: typeof analysis.stage === "string" ? analysis.stage : null,
            error: typeof analysis.error === "string" ? analysis.error : null,
          },
    });
  } catch (error) {
    console.error("Error in GET /api/bank-statements/imports/[id]:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
