import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { masterParentDescendsFromGroup } from "@/lib/bank-statement-ledger-safety";
import {
  findBankAccountCandidates,
  maskAccountNumber,
  serializeAccount,
} from "@/lib/bank-statements";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createBankStatementJobResult } from "@/lib/bank-statement-worker-pool";

export const runtime = "nodejs";

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBankAccountNumber(value: unknown) {
  return String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function isBankLedgerMaster(
  row: Record<string, unknown>,
  groups: Array<{ name: string; parent?: string | null }>
) {
  const raw = readRecord(row.raw_payload);
  return (
    masterParentDescendsFromGroup(String(row.parent_name ?? ""), groups, "Bank Accounts") ||
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

  const ledgerRows: Array<Record<string, unknown>> = [];
  const groupRows: Array<Record<string, unknown>> = [];
  const pageSize = 1000;
  for (const [masterType, target] of [
    ["ledger", ledgerRows],
    ["group", groupRows],
  ] as const) {
    for (let from = 0; from < 20000; from += pageSize) {
      const { data, error } = await supabase
        .from("tally_masters")
        .select("tally_name, parent_name, raw_payload")
        .eq("owner_user_id", ownerUserId)
        .eq("connection_id", connectionId)
        .eq("master_type", masterType)
        .eq("is_active", true)
        .order("tally_name", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const page = (data ?? []) as Array<Record<string, unknown>>;
      target.push(...page);
      if (page.length < pageSize) break;
      if (from + pageSize >= 20000) {
        throw new Error(`Tally ${masterType} sync exceeds the supported 20,000-master safety limit.`);
      }
    }
  }
  const groupIdentities = groupRows.map((group) => ({
    name: String(group.tally_name ?? ""),
    parent: group.parent_name ? String(group.parent_name) : null,
  }));

  const exactLedgerNames = Array.from(
    new Set(
      ledgerRows
        .filter((ledger) => isBankLedgerMaster(ledger, groupIdentities))
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
    rawPayload: readRecord(row.raw_payload),
  };
}

function isPreviewTransactionArray(value: unknown) {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
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
    const requestUrl = new URL(request.url);
    const includeTransactions = requestUrl.searchParams.get("includeTransactions") !== "false";
    const transactionsPage = Math.max(1, Number(requestUrl.searchParams.get("transactionsPage") ?? 1) || 1);
    const transactionsPageSize = Math.min(
      500,
      Math.max(1, Number(requestUrl.searchParams.get("transactionsPageSize") ?? 500) || 500)
    );
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

    const processingMeta = readRecord(importRow.processing_meta);
    const effectiveImportStatus = getEffectiveImportStatus(importRow as Record<string, unknown>);
    const previewMeta = readRecord(processingMeta.preview);
    const previewAccount = readRecord(previewMeta.account);
    const storedPreviewTransactions = isPreviewTransactionArray(previewMeta.transactions);
    let tablePreviewTransactions: Array<Record<string, unknown>> = [];
    let tablePreviewTransactionCount = Number(processingMeta.previewTransactionCount ?? 0);
    if (includeTransactions) {
      const rangeStart = (transactionsPage - 1) * transactionsPageSize;
      const { data: previewRows, error: previewError, count } = await supabase
        .from("bank_statement_import_preview_transactions")
        .select("*", { count: "exact" })
        .eq("import_id", id)
        .eq("owner_user_id", user.id)
        .order("row_index", { ascending: true })
        .range(rangeStart, rangeStart + transactionsPageSize - 1);

      if (previewError) throw previewError;
      tablePreviewTransactions = (previewRows ?? []) as Array<Record<string, unknown>>;
      tablePreviewTransactionCount = count ?? tablePreviewTransactions.length;
    }
    const transactions =
      tablePreviewTransactions.length > 0
        ? tablePreviewTransactions.map((row) => serializePreviewTransaction(row))
        : includeTransactions
          ? storedPreviewTransactions
          : [];
    const transactionsTotal =
      tablePreviewTransactionCount > 0
        ? tablePreviewTransactionCount
        : includeTransactions
          ? storedPreviewTransactions.length
          : Number(processingMeta.previewTransactionCount ?? 0);
    const analysis = readRecord(processingMeta.analysis);
    const analysisStatus = typeof analysis.status === "string" ? analysis.status : "";
    const jobStatus = typeof jobRow?.status === "string" ? jobRow.status : "";
    const jobIsTerminal = ["succeeded", "failed", "cancelled"].includes(jobStatus);
    const publicJobStatus =
      jobStatus === "succeeded" && effectiveImportStatus === "manual_review_required"
        ? "partial"
        : jobStatus;
    const processing =
      !jobIsTerminal &&
      (effectiveImportStatus === "processing" || analysisStatus === "queued" || analysisStatus === "processing");

    if (!jobRow && processing) {
      const { data: repairedJobRow, error: repairJobError } = await supabase
        .from("bank_statement_extraction_jobs")
        .insert({
          import_id: id,
          owner_user_id: user.id,
          status: "queued",
          progress: Number(analysis.progress ?? 5),
          stage: typeof analysis.stage === "string" ? analysis.stage : "Statement uploaded",
          result: createBankStatementJobResult(),
        })
        .select("*")
        .single();

      if (repairJobError) throw repairJobError;
      jobRow = repairedJobRow;
    }

    const requiresManualExtraction =
      effectiveImportStatus === "manual_review_required" ||
      effectiveImportStatus === "failed" ||
      Boolean(previewMeta.requiresManualExtraction) ||
      (!processing && transactionsTotal === 0);
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
      : ["ready_to_review", "ready_to_confirm", "needs_account_selection"].includes(effectiveImportStatus)
      ? await findBankAccountCandidates(supabase, user.id, {
          bankName: account.bankName,
          accountNumber: account.accountNumber,
          accountHolderName: account.accountHolderName,
          ifscCode: account.ifscCode,
        })
      : [];
    const bankLedgerResolution = processing
      ? {
          ledgerName: account.tallyLedgerName,
          source: "analysis_processing",
          requiresSelection: !account.tallyLedgerName,
          verified: false,
        }
      : await resolveStatementBankLedger(
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
      transactionsTotal,
      transactionsPage,
      transactionsPageSize,
      requiresManualExtraction,
      extractionSource: previewMeta.extractionSource ?? processingMeta.extractionSource ?? null,
      extractionError: previewMeta.extractionError ?? processingMeta.extractionError ?? null,
      extractionDiagnostics: previewMeta.extractionDiagnostics ?? processingMeta.extractionDiagnostics ?? null,
      ledgerRecommendationError:
        previewMeta.ledgerRecommendationError ?? processingMeta.ledgerRecommendationError ?? null,
      processing,
      job: jobRow
        ? {
            id: jobRow.id,
            status: publicJobStatus,
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
