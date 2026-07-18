import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  BANK_STATEMENT_BUCKET,
  buildTransactionFingerprint,
  extractCounterpartyName,
  maskAccountNumber,
  normalizeAccountNumber,
  normalizeIfscCode,
  parseAmount,
  parseDate,
  serializeAccount,
  type BankAccountInput,
  type ParsedBankTransaction,
} from "@/lib/bank-statements";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type ConfirmPayload = {
  accountId?: string | null;
  account?: BankAccountInput;
  transactions?: ParsedBankTransaction[];
  reconcileAgainstLiveTally?: boolean;
};

type PostedTransactionRow = {
  id: string;
  owner_user_id: string;
  bank_account_id: string;
  transaction_date: string;
  description: string;
  reference_number: string | null;
  debit_amount: number | string | null;
  credit_amount: number | string | null;
  fingerprint: string;
  tally_voucher_id: string | null;
  tally_posted_at: string | null;
};

type PostedLogRow = {
  fingerprint: string;
  tally_voucher_id: string | null;
  tally_posted_at: string | null;
};

type ExistingTransactionRow = {
  id: string;
  fingerprint: string | null;
  statement_import_id: string | null;
  tally_status: string | null;
};

type TransactionCheckpointMarker = {
  transactionDate: string;
  valueDate: string | null;
  description: string;
  referenceNumber: string | null;
  debitAmount: number | null;
  creditAmount: number | null;
  balanceAmount: number | null;
  transactionType: string;
  category: string;
  counterpartyName: string | null;
  fingerprint: string;
};

type DraftTransactionRow = {
  transaction_date: string;
  value_date: string | null;
  description: string;
  reference_number: string | null;
  debit_amount: number | null | undefined;
  credit_amount: number | null | undefined;
  balance_amount: number | null | undefined;
  transaction_type: string;
  category: string;
  counterparty_name: string | null;
  suggested_ledger_name?: string | null;
  suggestion_confidence?: number | null;
  suggestion_reason?: string | null;
  confirmed_ledger_name?: string | null;
  ledger_mapping_source?: string | null;
  additional_charges?: Array<Record<string, unknown>>;
  confidence?: number | null;
  raw_payload?: Record<string, unknown>;
  fingerprint: string;
  tally_status?: string;
};

function isSupabaseConnectivityError(error: unknown) {
  const text = [
    error instanceof Error ? error.message : "",
    typeof error === "object" && error && "details" in error ? String((error as { details?: unknown }).details ?? "") : "",
    typeof error === "object" && error && "cause" in error ? String((error as { cause?: unknown }).cause ?? "") : "",
  ].join("\n");

  return /fetch failed|ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(text);
}

function serializeImport(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : null,
    originalFileName: String(row.original_file_name ?? ""),
    status: String(row.status ?? ""),
    statementPeriodStart: row.statement_period_start ? String(row.statement_period_start) : null,
    statementPeriodEnd: row.statement_period_end ? String(row.statement_period_end) : null,
    importedTransactionCount: Number(row.imported_transaction_count ?? 0),
    duplicateTransactionCount: Number(row.duplicate_transaction_count ?? 0),
    createdAt: String(row.created_at ?? ""),
  };
}

function toText(value: unknown) {
  return String(value ?? "").trim();
}

function toTransaction(value: unknown): ParsedBankTransaction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const transactionDate = parseDate(row.transactionDate);
  const description = toText(row.description);
  if (!transactionDate || !description) return null;

  const debitAmount = parseAmount(row.debitAmount);
  const creditAmount = parseAmount(row.creditAmount);

  return {
    transactionDate,
    valueDate: parseDate(row.valueDate),
    description,
    referenceNumber: toText(row.referenceNumber) || null,
    debitAmount,
    creditAmount,
    balanceAmount: parseAmount(row.balanceAmount),
    transactionType: toText(row.transactionType) || "unknown",
    category: toText(row.category) || "unknown",
    counterpartyName: toText(row.counterpartyName) || extractCounterpartyName(description),
    suggestedLedgerName: toText(row.suggestedLedgerName) || null,
    suggestionConfidence:
      typeof row.suggestionConfidence === "number" && Number.isFinite(row.suggestionConfidence)
        ? row.suggestionConfidence
        : null,
    suggestionReason: toText(row.suggestionReason) || null,
    confirmedLedgerName: toText(row.confirmedLedgerName) || null,
    additionalCharges: Array.isArray(row.additionalCharges)
      ? row.additionalCharges.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
        )
      : [],
    confidence:
      typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? row.confidence
        : null,
    rawPayload:
      row.rawPayload && typeof row.rawPayload === "object" && !Array.isArray(row.rawPayload)
        ? (row.rawPayload as Record<string, unknown>)
        : {},
  };
}

function latestRowTransactionDate(rows: Array<{ transaction_date: string }>) {
  return rows
    .map((row) => row.transaction_date)
    .sort()
    .at(-1);
}

function checkpointDate(value: unknown) {
  const raw = typeof value === "string" ? value : "";
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function normalizeCheckpointText(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCheckpointAmount(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function checkpointAmountsMatch(
  left: number | string | null | undefined,
  right: number | string | null | undefined
) {
  const normalizedLeft = normalizeCheckpointAmount(left);
  const normalizedRight = normalizeCheckpointAmount(right);
  if (normalizedLeft === null || normalizedRight === null) return normalizedLeft === normalizedRight;
  return Math.abs(normalizedLeft - normalizedRight) < 0.005;
}

function readTransactionCheckpointMarker(value: unknown): TransactionCheckpointMarker | null {
  let row = value;
  if (typeof value === "string") {
    try {
      row = JSON.parse(value || "{}");
    } catch {
      return null;
    }
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const marker = row as Partial<TransactionCheckpointMarker>;
  if (!marker.transactionDate || typeof marker.transactionDate !== "string") return null;
  return {
    transactionDate: marker.transactionDate,
    valueDate: typeof marker.valueDate === "string" ? marker.valueDate : null,
    description: typeof marker.description === "string" ? marker.description : "",
    referenceNumber: typeof marker.referenceNumber === "string" ? marker.referenceNumber : null,
    debitAmount: normalizeCheckpointAmount(marker.debitAmount),
    creditAmount: normalizeCheckpointAmount(marker.creditAmount),
    balanceAmount: normalizeCheckpointAmount(marker.balanceAmount),
    transactionType: typeof marker.transactionType === "string" ? marker.transactionType : "unknown",
    category: typeof marker.category === "string" ? marker.category : "unknown",
    counterpartyName: typeof marker.counterpartyName === "string" ? marker.counterpartyName : null,
    fingerprint: typeof marker.fingerprint === "string" ? marker.fingerprint : "",
  };
}

function buildTransactionCheckpointMarker(row: DraftTransactionRow): TransactionCheckpointMarker {
  return {
    transactionDate: row.transaction_date,
    valueDate: row.value_date,
    description: row.description,
    referenceNumber: row.reference_number,
    debitAmount: normalizeCheckpointAmount(row.debit_amount),
    creditAmount: normalizeCheckpointAmount(row.credit_amount),
    balanceAmount: normalizeCheckpointAmount(row.balance_amount),
    transactionType: row.transaction_type,
    category: row.category,
    counterpartyName: row.counterparty_name,
    fingerprint: row.fingerprint,
  };
}

function transactionMatchesCheckpoint(row: DraftTransactionRow, marker: TransactionCheckpointMarker) {
  if (marker.fingerprint && row.fingerprint === marker.fingerprint) return true;
  if (row.transaction_date !== marker.transactionDate) return false;
  if (!checkpointAmountsMatch(row.debit_amount, marker.debitAmount)) return false;
  if (!checkpointAmountsMatch(row.credit_amount, marker.creditAmount)) return false;
  if (!checkpointAmountsMatch(row.balance_amount, marker.balanceAmount)) return false;
  if (normalizeCheckpointText(row.description) !== normalizeCheckpointText(marker.description)) return false;
  if (marker.referenceNumber && normalizeCheckpointText(row.reference_number) !== normalizeCheckpointText(marker.referenceNumber)) {
    return false;
  }
  return true;
}

function rowsAfterImportCheckpoint(
  rows: DraftTransactionRow[],
  marker: TransactionCheckpointMarker | null,
  legacyCheckpointDate: string | null
) {
  const markerDate = marker?.transactionDate || legacyCheckpointDate;
  if (!markerDate) {
    return {
      markerFound: null as boolean | null,
      rows,
      skippedCount: 0,
    };
  }

  if (!marker) {
    return {
      markerFound: null as boolean | null,
      rows,
      skippedCount: 0,
    };
  }

  if (marker && !hasPostingAmount({ debit_amount: marker.debitAmount, credit_amount: marker.creditAmount })) {
    return {
      markerFound: false,
      rows,
      skippedCount: 0,
    };
  }

  const sameDateRowExists = rows.some((row) => row.transaction_date === markerDate);
  if (!sameDateRowExists) {
    return {
      markerFound: null as boolean | null,
      rows,
      skippedCount: 0,
    };
  }

  const markerIndex = marker ? rows.findIndex((row) => transactionMatchesCheckpoint(row, marker)) : -1;
  if (markerIndex >= 0) {
    const nextRows = rows.filter(
      (row, index) => row.transaction_date > markerDate || (row.transaction_date === markerDate && index > markerIndex)
    );
    return {
      markerFound: true,
      rows: nextRows,
      skippedCount: rows.length - nextRows.length,
    };
  }

  return {
    markerFound: false,
    rows,
    skippedCount: 0,
  };
}

function latestTransactionRow(rows: DraftTransactionRow[]) {
  return rows.reduce<DraftTransactionRow | null>((latest, row) => {
    if (!latest) return row;
    return row.transaction_date >= latest.transaction_date ? row : latest;
  }, null);
}

function getTransactionAmount(row: {
  debit_amount?: number | string | null;
  credit_amount?: number | string | null;
}) {
  return Math.max(normalizeCheckpointAmount(row.debit_amount) ?? 0, normalizeCheckpointAmount(row.credit_amount) ?? 0);
}

function hasPostingAmount(row: {
  debit_amount?: number | string | null;
  credit_amount?: number | string | null;
}) {
  return getTransactionAmount(row) > 0;
}

function getVoucherType(row: {
  debit_amount?: number | string | null;
  credit_amount?: number | string | null;
}) {
  const debit = normalizeCheckpointAmount(row.debit_amount) ?? 0;
  const credit = normalizeCheckpointAmount(row.credit_amount) ?? 0;
  if (debit > 0 && credit <= 0) return "Payment";
  if (credit > 0 && debit <= 0) return "Receipt";
  return "Contra";
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as ConfirmPayload;
    const reconcileAgainstLiveTally = body.reconcileAgainstLiveTally === true;
    const submittedTransactions = (body.transactions ?? []).flatMap((value) => {
      const transaction = toTransaction(value);
      return transaction ? [transaction] : [];
    });
    const transactions = submittedTransactions.filter((transaction) =>
      hasPostingAmount({
        debit_amount: transaction.debitAmount,
        credit_amount: transaction.creditAmount,
      })
    );

    if (transactions.length === 0) {
      return jsonWithCors(
        request,
        { error: "Add at least one valid debit or credit transaction before confirming." },
        { status: 400 }
      );
    }

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

    const accountIdWasProvided = Object.prototype.hasOwnProperty.call(body, "accountId");
    let accountId = accountIdWasProvided
      ? body.accountId || null
      : importRow.bank_account_id || null;
    let accountRow = null;

    if (accountId) {
      const { data, error } = await supabase
        .from("bank_accounts")
        .select("*")
        .eq("id", accountId)
        .eq("owner_user_id", user.id)
        .single();
      if (error || !data) {
        return jsonWithCors(request, { error: "Selected bank account was not found." }, { status: 404 });
      }
      accountRow = data;
    } else {
      const account = body.account ?? {};
      const accountNumber =
        account.accountNumber || importRow.extracted_account_number || "";
      const normalizedAccountNumber = normalizeAccountNumber(accountNumber);
      if (!normalizedAccountNumber) {
        return jsonWithCors(
          request,
          { error: "Account number is required when creating a new bank account." },
          { status: 400 }
        );
      }

      const insertPayload = {
        owner_user_id: user.id,
        bank_name: account.bankName || importRow.extracted_bank_name || null,
        account_number_normalized: normalizedAccountNumber,
        account_number_masked: maskAccountNumber(accountNumber),
        account_holder_name: account.accountHolderName || importRow.extracted_account_holder_name || null,
        ifsc_code: normalizeIfscCode(account.ifscCode || importRow.extracted_ifsc_code || null) || null,
      };

      const { data, error } = await supabase
        .from("bank_accounts")
        .insert(insertPayload)
        .select("*")
        .single();

      if (error) {
        const { data: existing, error: existingError } = await supabase
          .from("bank_accounts")
          .select("*")
          .eq("owner_user_id", user.id)
          .eq("account_number_normalized", normalizedAccountNumber)
          .single();
        if (existingError || !existing) throw error;
        accountRow = existing;
      } else {
        accountRow = data;
      }
      accountId = accountRow.id;
    }

    if (!accountId || !accountRow) {
      return jsonWithCors(request, { error: "Bank account could not be resolved." }, { status: 400 });
    }

    const rowsByFingerprint = new Map(
      transactions.map((transaction) => {
        const fingerprint = buildTransactionFingerprint(accountId, transaction);
        return [
          fingerprint,
          {
            owner_user_id: user.id,
            bank_account_id: accountId,
            statement_import_id: id,
            transaction_date: transaction.transactionDate,
            value_date: transaction.valueDate || transaction.transactionDate,
            description: transaction.description,
            reference_number: transaction.referenceNumber || null,
            debit_amount: transaction.debitAmount,
            credit_amount: transaction.creditAmount,
            balance_amount: transaction.balanceAmount,
            transaction_type: transaction.transactionType || "unknown",
            category: transaction.category || "unknown",
            counterparty_name: transaction.counterpartyName ?? extractCounterpartyName(transaction.description),
            suggested_ledger_name: transaction.suggestedLedgerName ?? null,
            suggestion_confidence: transaction.suggestionConfidence ?? null,
            suggestion_reason: transaction.suggestionReason ?? null,
            confirmed_ledger_name: transaction.confirmedLedgerName ?? null,
            ledger_mapping_source: null,
            additional_charges: transaction.additionalCharges ?? [],
            confidence: transaction.confidence ?? null,
            raw_payload: transaction.rawPayload ?? {},
            fingerprint,
            tally_status: "pending",
          },
        ];
      })
    );
    const rows = Array.from(rowsByFingerprint.values());
    const lastImportedTransactionDate = checkpointDate(accountRow.last_imported_transaction_at);
    const lastImportedTransactionMarker = readTransactionCheckpointMarker(
      accountRow.last_imported_transaction_marker
    );
    const checkpointResult = rowsAfterImportCheckpoint(
      rows,
      lastImportedTransactionMarker,
      lastImportedTransactionDate
    );
    const rowsAfterCheckpoint = reconcileAgainstLiveTally ? rows : checkpointResult.rows;

    const { data: existingPostedRows, error: existingPostedError } = await supabase
      .from("bank_transactions")
      .select(
        "id, owner_user_id, bank_account_id, transaction_date, description, reference_number, debit_amount, credit_amount, fingerprint, tally_voucher_id, tally_posted_at"
      )
      .eq("owner_user_id", user.id)
      .eq("bank_account_id", accountId)
      .eq("tally_status", "posted");

    if (existingPostedError) throw existingPostedError;

    const postedRows = (existingPostedRows ?? []) as unknown as PostedTransactionRow[];
    if (!reconcileAgainstLiveTally && postedRows.length > 0) {
      const postedLogRows = postedRows.map((row) => ({
        owner_user_id: user.id,
        bank_account_id: accountId,
        source_transaction_id: row.id,
        fingerprint: row.fingerprint,
        transaction_date: row.transaction_date,
        reference_number: row.reference_number,
        description: row.description,
        debit_amount: row.debit_amount,
        credit_amount: row.credit_amount,
        amount: getTransactionAmount(row),
        voucher_type: getVoucherType(row),
        status: "posted",
        tally_voucher_id: row.tally_voucher_id,
        tally_posted_at: row.tally_posted_at ?? new Date().toISOString(),
        result: {
          migratedFromSnapshot: true,
          migratedAt: new Date().toISOString(),
        },
      }));

      const { error: postedLogError } = await supabase
        .from("bank_transaction_posting_log")
        .upsert(postedLogRows, {
          onConflict: "owner_user_id,bank_account_id,fingerprint",
        });

      if (postedLogError) throw postedLogError;
    }

    const submittedFingerprints = rows.map((row) => row.fingerprint);
    if (reconcileAgainstLiveTally && submittedFingerprints.length > 0) {
      const { error: stalePostingLogError } = await supabase
        .from("bank_transaction_posting_log")
        .delete()
        .eq("owner_user_id", user.id)
        .eq("bank_account_id", accountId)
        .in("fingerprint", submittedFingerprints);
      if (stalePostingLogError) throw stalePostingLogError;
    }
    const { data: postedLogData, error: postedLogReadError } = submittedFingerprints.length
      ? await supabase
          .from("bank_transaction_posting_log")
          .select("fingerprint, tally_voucher_id, tally_posted_at")
          .eq("owner_user_id", user.id)
          .eq("bank_account_id", accountId)
          .eq("status", "posted")
          .in("fingerprint", submittedFingerprints)
      : { data: [], error: null };

    if (postedLogReadError) throw postedLogReadError;

    const { data: existingTransactionData, error: existingTransactionReadError } = submittedFingerprints.length
      ? await supabase
          .from("bank_transactions")
          .select("id, fingerprint, statement_import_id, tally_status")
          .eq("owner_user_id", user.id)
          .eq("bank_account_id", accountId)
          .in("fingerprint", submittedFingerprints)
      : { data: [], error: null };

    if (existingTransactionReadError) throw existingTransactionReadError;

    const existingFingerprints = new Set(
      ((existingTransactionData ?? []) as ExistingTransactionRow[]).flatMap((row) =>
        row.fingerprint ? [row.fingerprint] : []
      )
    );
    const existingQueueableRows = ((existingTransactionData ?? []) as ExistingTransactionRow[]).filter(
      (row) =>
        row.id &&
        row.fingerprint &&
        (reconcileAgainstLiveTally || row.statement_import_id === id) &&
        (reconcileAgainstLiveTally || ["pending", "failed", "missing_in_tally", "verification_failed"].includes(row.tally_status || ""))
    );
    const submittedRowsByFingerprint = new Map(rows.map((row) => [row.fingerprint, row]));
    const postedByFingerprint = new Map(
      ((postedLogData ?? []) as unknown as PostedLogRow[]).map((row) => [row.fingerprint, row])
    );
    const snapshotRows = rowsAfterCheckpoint.flatMap((row) => {
      if (existingFingerprints.has(row.fingerprint)) return [];
      const postedLog = postedByFingerprint.get(row.fingerprint);
      if (!postedLog) return [row];
      return [
        {
          ...row,
          tally_status: "posted",
          tally_posted_at: postedLog.tally_posted_at,
          tally_voucher_id: postedLog.tally_voucher_id,
        },
      ];
    });

    const rowsToInsert = snapshotRows.map((row) => ({
      owner_user_id: user.id,
      bank_account_id: accountId,
      statement_import_id: id,
      transaction_date: row.transaction_date,
      value_date: row.value_date,
      description: row.description,
      reference_number: row.reference_number,
      debit_amount: row.debit_amount,
      credit_amount: row.credit_amount,
      balance_amount: row.balance_amount,
      transaction_type: row.transaction_type,
      category: row.category,
      counterparty_name: row.counterparty_name,
      suggested_ledger_name: row.suggested_ledger_name,
      suggestion_confidence: row.suggestion_confidence,
      suggestion_reason: row.suggestion_reason,
      confirmed_ledger_name: row.confirmed_ledger_name,
      ledger_mapping_source: row.ledger_mapping_source,
      additional_charges: row.additional_charges,
      confidence: row.confidence,
      raw_payload: row.raw_payload,
      fingerprint: row.fingerprint,
      tally_status: row.tally_status,
      tally_posted_at: "tally_posted_at" in row ? row.tally_posted_at : null,
      tally_voucher_id: "tally_voucher_id" in row ? row.tally_voucher_id : null,
    }));

    if (rowsToInsert.length > 0) {
      const { error: insertError } = await supabase.from("bank_transactions").insert(rowsToInsert);
      if (insertError) throw insertError;
    }

    if (existingQueueableRows.length > 0) {
      const updateResults = await Promise.all(
        existingQueueableRows.map((existingRow) => {
          const matchingRow = existingRow.fingerprint ? submittedRowsByFingerprint.get(existingRow.fingerprint) : null;

          return supabase
            .from("bank_transactions")
            .update({
              statement_import_id: id,
              suggested_ledger_name: matchingRow?.suggested_ledger_name ?? null,
              suggestion_confidence: matchingRow?.suggestion_confidence ?? null,
              suggestion_reason: matchingRow?.suggestion_reason ?? null,
              confirmed_ledger_name: matchingRow?.confirmed_ledger_name ?? null,
              ledger_mapping_source: matchingRow?.ledger_mapping_source ?? null,
              ...(reconcileAgainstLiveTally
                ? {
                    tally_status: "pending",
                    tally_voucher_id: null,
                    tally_posted_at: null,
                  }
                : {}),
            })
            .eq("id", existingRow.id)
            .eq("owner_user_id", user.id);
        })
      );
      const updateError = updateResults.find((result) => result.error)?.error;
      if (updateError) throw updateError;
    }

    const latestAcceptedRow = latestTransactionRow(rowsAfterCheckpoint);
    const latestAcceptedDate = latestAcceptedRow?.transaction_date ?? latestRowTransactionDate(rowsAfterCheckpoint);
    const latestAcceptedMarker = latestAcceptedRow ? buildTransactionCheckpointMarker(latestAcceptedRow) : null;
    const accountUpdate = latestAcceptedDate
      ? {
          last_imported_transaction_at: `${latestAcceptedDate}T00:00:00.000Z`,
          last_imported_transaction_marker: latestAcceptedMarker,
        }
      : {};

    const accountUpdatePromise = latestAcceptedDate
      ? supabase
          .from("bank_accounts")
          .update(accountUpdate)
          .eq("id", accountId)
          .eq("owner_user_id", user.id)
          .select("*")
          .single()
      : supabase
          .from("bank_accounts")
          .select("*")
          .eq("id", accountId)
          .eq("owner_user_id", user.id)
          .single();

    const [{ data: updatedAccount, error: accountUpdateError }, { data: updatedImport, error: importUpdateError }] =
      await Promise.all([
        accountUpdatePromise,
        supabase
          .from("bank_statement_imports")
          .update({
            bank_account_id: accountId,
            status: "imported",
            imported_transaction_count: rowsToInsert.length,
            duplicate_transaction_count: transactions.length - rowsToInsert.length,
            processing_meta: {
              ...(importRow.processing_meta && typeof importRow.processing_meta === "object"
                ? importRow.processing_meta
                : {}),
              confirmedAt: new Date().toISOString(),
              confirmedTransactionCount: transactions.length,
              ignoredNonPostingRowCount: submittedTransactions.length - transactions.length,
              importedAfterTransactionDate: lastImportedTransactionDate,
              importedAfterTransactionMarker: lastImportedTransactionMarker,
              checkpointMarkerFound: checkpointResult.markerFound,
              skippedByCheckpointCount: checkpointResult.skippedCount,
              existingTransactionCount: existingFingerprints.size,
              existingQueueableTransactionCount: existingQueueableRows.length,
              appendCompletedAt: new Date().toISOString(),
              alreadyPostedTransactionCount: postedByFingerprint.size,
              reconciledAgainstLiveTally: reconcileAgainstLiveTally,
            },
          })
          .eq("id", id)
          .eq("owner_user_id", user.id)
          .select("*")
          .single(),
      ]);

    if (accountUpdateError) throw accountUpdateError;
    if (importUpdateError) throw importUpdateError;

    const { data: olderImports, error: olderImportsError } = await supabase
      .from("bank_statement_imports")
      .select("id, storage_path")
      .eq("owner_user_id", user.id)
      .eq("bank_account_id", accountId)
      .neq("id", id);

    if (olderImportsError) throw olderImportsError;

    const olderStoragePaths = (olderImports ?? [])
      .map((row) => (typeof row.storage_path === "string" ? row.storage_path : ""))
      .filter(Boolean);

    if (olderStoragePaths.length > 0) {
      await supabase.storage.from(BANK_STATEMENT_BUCKET).remove(olderStoragePaths);
    }

    if ((olderImports ?? []).length > 0) {
      const { error: deleteOlderImportsError } = await supabase
        .from("bank_statement_imports")
        .delete()
        .eq("owner_user_id", user.id)
        .eq("bank_account_id", accountId)
        .neq("id", id);

      if (deleteOlderImportsError) throw deleteOlderImportsError;
    }

    return jsonWithCors(request, {
      account: serializeAccount(updatedAccount),
      import: serializeImport(updatedImport as Record<string, unknown>),
      importedTransactionCount: rowsToInsert.length,
      duplicateTransactionCount: transactions.length - rowsToInsert.length,
      skippedByCheckpointCount: checkpointResult.skippedCount,
      existingTransactionCount: existingFingerprints.size,
      existingQueueableTransactionCount: existingQueueableRows.length,
      alreadyPostedTransactionCount: postedByFingerprint.size,
    });
  } catch (error) {
    console.error("Error in POST /api/bank-statements/imports/[id]/confirm:", error);
    if (isSupabaseConnectivityError(error)) {
      return jsonWithCors(
        request,
        {
          error:
            "Could not reach Supabase while saving the bank statement. Please retry; existing entries will be handled as duplicates when the connection is back.",
        },
        { status: 503 }
      );
    }
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
