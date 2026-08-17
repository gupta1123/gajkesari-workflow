import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

type BankTransactionRow = {
  id: string;
  bank_account_id: string;
  statement_import_id: string | null;
  transaction_date: string;
  value_date: string | null;
  description: string;
  reference_number: string | null;
  debit_amount: number | string | null;
  credit_amount: number | string | null;
  balance_amount: number | string | null;
  transaction_type: string;
  category: string;
  counterparty_name: string | null;
  suggested_ledger_name: string | null;
  suggestion_confidence: number | string | null;
  suggestion_reason: string | null;
  confirmed_ledger_name: string | null;
  ledger_mapping_source: string | null;
  tally_status: string;
};

function toNumber(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function hasPostingAmount(row: BankTransactionRow) {
  return Math.max(toNumber(row.debit_amount) ?? 0, toNumber(row.credit_amount) ?? 0) > 0;
}

function normalizeLedgerName(value?: string | null) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSuspenseLedger(value?: string | null) {
  const normalized = normalizeLedgerName(value);
  return normalized === "suspense" || normalized === "suspenseac" || normalized === "suspenseaccount";
}

function serializeTransaction(row: BankTransactionRow) {
  const confirmedLedgerName = row.confirmed_ledger_name || null;
  const storedSuggestedLedgerName = row.suggested_ledger_name || null;
  const suggestedLedgerName = confirmedLedgerName || storedSuggestedLedgerName;
  const suggestionConfidence = toNumber(row.suggestion_confidence);

  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    transactionDate: row.transaction_date,
    valueDate: row.value_date,
    description: row.description,
    referenceNumber: row.reference_number,
    debitAmount: row.debit_amount,
    creditAmount: row.credit_amount,
    balanceAmount: row.balance_amount,
    transactionType: row.transaction_type,
    category: row.category,
    counterpartyName: row.counterparty_name || null,
    suggestedLedgerName,
    suggestionConfidence,
    suggestionReason: row.suggestion_reason || null,
    confirmedLedgerName,
    ledgerMappingSource: row.ledger_mapping_source || null,
    tallyStatus: row.tally_status,
    needsLedgerConfirmation:
      !confirmedLedgerName &&
      (!suggestedLedgerName || isSuspenseLedger(suggestedLedgerName) || (suggestionConfidence ?? 0) < 0.85),
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

    const url = new URL(request.url);
    const accountId = url.searchParams.get("accountId")?.trim();
    const importId = url.searchParams.get("importId")?.trim();
    const status = url.searchParams.get("status")?.trim() || "pending";
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.max(
      1,
      Math.min(500, Number.parseInt(url.searchParams.get("pageSize") || "200", 10) || 200)
    );

    if (!accountId) {
      return jsonWithCors(request, { error: "Bank account is required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data: account, error: accountError } = await supabase
      .from("bank_accounts")
      .select("id")
      .eq("id", accountId)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (accountError) throw accountError;
    if (!account) {
      return jsonWithCors(request, { error: "Bank account not found." }, { status: 404 });
    }

    let builder = supabase
      .from("bank_transactions")
      .select(
        "id, bank_account_id, statement_import_id, transaction_date, value_date, description, reference_number, debit_amount, credit_amount, balance_amount, transaction_type, category, counterparty_name, suggested_ledger_name, suggestion_confidence, suggestion_reason, confirmed_ledger_name, ledger_mapping_source, tally_status",
        { count: "exact" }
      )
      .eq("owner_user_id", user.id)
      .eq("bank_account_id", accountId)
      .order("transaction_date", { ascending: true })
      .order("id", { ascending: true })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (importId) {
      builder = builder.eq("statement_import_id", importId);
    }

    if (status === "queueable") {
      builder = builder
        .in("tally_status", ["pending", "failed", "missing_in_tally", "verification_failed"])
        .or("debit_amount.gt.0,credit_amount.gt.0");
    } else if (status) {
      builder = builder.eq("tally_status", status);
    }

    const { data, error, count } = await builder;
    if (error) throw error;

    const allRows = (data ?? []) as unknown as BankTransactionRow[];
    const rows = status === "queueable" ? allRows.filter(hasPostingAmount) : allRows;
    return jsonWithCors(request, {
      transactions: rows.map((row) => serializeTransaction(row)),
      page,
      pageSize,
      total: count ?? rows.length,
      hasMore: page * pageSize < (count ?? rows.length),
    });
  } catch (error) {
    console.error("Error in GET /api/bank-statements/transactions:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
