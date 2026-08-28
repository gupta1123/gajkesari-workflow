import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { normalizeName } from "@/lib/bank-statements";
import {
  buildBankAccountLedgerSourceKey,
  buildBankNarrationLedgerSourceKey,
  buildLedgerMappingTarget,
} from "@/lib/bank-statement-ledger-matching";
import {
  classifyPartyLedgerFromGroups,
  isSuspenseLedgerIdentity,
  masterParentDescendsFromGroup,
  resolveCompanySuspenseLedgerName,
} from "@/lib/bank-statement-ledger-safety";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { wakeTallyConnector } from "@/lib/tally/command-wake";

export const runtime = "nodejs";

type QueuePayload = {
  async?: boolean;
  connectionId?: string;
  companyName?: string;
  transactionIds?: string[];
  accountId?: string;
  bankLedgerName?: string;
  counterpartyLedgerName?: string;
  outgoingAction?: "verify" | "post";
  transactions?: Array<{
    transactionId?: string;
    counterpartyLedgerName?: string;
    createLedgerName?: string;
    createLedgerParentName?: string;
    billAllocations?: Array<{
      referenceType?: string;
      referenceName?: string;
      amount?: number | string;
    }>;
    billMatchingVerified?: boolean;
    duplicateCheckVerified?: boolean;
    saveMapping?: boolean;
  }>;
};

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
  confirmed_ledger_name: string | null;
  fingerprint: string;
};

type BankAccountRow = {
  id: string;
  bank_name: string | null;
  account_number_masked: string;
  account_holder_name: string | null;
  tally_ledger_name: string | null;
};

type BankStatementImportRow = {
  id: string;
  extracted_bank_name: string | null;
};

type PostingLogRow = {
  fingerprint: string;
  status: string;
  command_id: string | null;
};

type ExistingCommandRow = {
  id: string;
  status: string;
};

type TransactionStatusSummaryRow = {
  tally_status: string;
};

type TallyLedgerRow = {
  tally_name: string;
  parent_name: string | null;
  raw_payload: Record<string, unknown> | null;
};

const MASTER_LOOKUP_CHUNK_SIZE = 100;

function chunkValues<T>(values: T[], size = MASTER_LOOKUP_CHUNK_SIZE) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

type MappingRow = {
  connection_id: string;
  company_name: string;
  owner_user_id: string;
  mapping_type: string;
  source_key: string;
  source_label: string;
  target_master_type: string;
  target_master_key: string;
  target_master_name: string;
  status: string;
  notes: string;
};

function serializeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error ?? "Internal server error");

  const record = error as Record<string, unknown>;
  return [record.message, record.details, record.hint, record.error]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ") || "Internal server error";
}

type TransactionLedgerSelection = {
  counterpartyLedgerName: string;
  createLedgerName: string;
  createLedgerParentName: string;
  billAllocations: Array<{
    referenceType: string;
    referenceName: string;
    amount: number;
  }>;
  billMatchingVerified: boolean;
  duplicateCheckVerified: boolean;
};

type TallyCommandInsert = {
  connection_id: string;
  owner_user_id: string;
  command_type: "create_ledger" | "post_bank_voucher" | "verify_bank_transaction";
  status: "queued";
  priority: number;
  payload: Record<string, unknown>;
};

function serializeQueueJob(row: Record<string, unknown>) {
  return {
    id: row.id,
    status: row.status,
    totalCount: row.total_count,
    processedCount: row.processed_count,
    result: row.result ?? {},
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

function toText(value: unknown, maxLength = 500) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, maxLength);
}

function toNumber(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function readBillAllocations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((allocation) => {
    if (!allocation || typeof allocation !== "object" || Array.isArray(allocation)) return [];
    const row = allocation as Record<string, unknown>;
    const referenceType = toText(row.referenceType, 80) || toText(row.billType, 80);
    const referenceName = toText(row.referenceName, 500) || toText(row.name, 500);
    const amount = toNumber(row.amount ?? row.allocatedAmount);
    if (!referenceType || !referenceName || amount <= 0) return [];
    return [{ referenceType, referenceName, amount }];
  });
}

function billAllocationTotal(allocations: Array<{ amount: number }>) {
  return Number(allocations.reduce((sum, allocation) => sum + allocation.amount, 0).toFixed(2));
}

function isSuspenseLedger(value?: string | null) {
  const normalized = normalizeName(value);
  return normalized.includes("suspense");
}

function isValidTransactionDate(value: unknown) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "").trim());
}

function getVoucherDate(transaction: Pick<BankTransactionRow, "transaction_date" | "value_date">) {
  return isValidTransactionDate(transaction.value_date)
    ? String(transaction.value_date)
    : transaction.transaction_date;
}

function getVoucherType(transaction: BankTransactionRow) {
  const debit = toNumber(transaction.debit_amount);
  const credit = toNumber(transaction.credit_amount);
  if (debit > 0 && credit <= 0) return "Payment";
  if (credit > 0 && debit <= 0) return "Receipt";
  return "Contra";
}

function getTransactionAmount(transaction: BankTransactionRow) {
  return Math.max(toNumber(transaction.debit_amount), toNumber(transaction.credit_amount));
}

function isIncomingReceipt(transaction: BankTransactionRow) {
  return toNumber(transaction.credit_amount) > 0 && toNumber(transaction.debit_amount) <= 0;
}

function isOutgoingPayment(transaction: BankTransactionRow) {
  return toNumber(transaction.debit_amount) > 0 && toNumber(transaction.credit_amount) <= 0;
}

function bankEntryIsDebit(transaction: BankTransactionRow) {
  return toNumber(transaction.credit_amount) > 0 && toNumber(transaction.debit_amount) <= 0;
}

function getVoucherReferencePrefix(transaction: BankTransactionRow) {
  const text = `${transaction.transaction_type} ${transaction.category} ${transaction.description}`.toLowerCase();
  if (/\bcharge|charges|fee|gst\b/.test(text)) return "CHG";
  if (/\binterest\b/.test(text)) return "INT";
  if (/\bupi\b/.test(text)) return "UPI";
  if (/\brtgs\b/.test(text)) return "RTGS";
  if (/\bneft\b/.test(text)) return "NEFT";
  if (/\bimps\b/.test(text)) return "IMPS";
  if (toNumber(transaction.credit_amount) > 0 && toNumber(transaction.debit_amount) <= 0) return "RCT";
  if (toNumber(transaction.debit_amount) > 0 && toNumber(transaction.credit_amount) <= 0) return "PMT";
  return "BNK";
}

function getVoucherReferenceBankCode(value?: string | null) {
  const normalized = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!normalized) return "BNK";
  if (normalized.includes("HDFC")) return "HDFC";
  if (normalized.includes("ICICI")) return "ICICI";
  if (normalized.includes("SBI")) return "SBI";
  if (normalized.includes("AXIS")) return "AXIS";
  return normalized.slice(0, 6);
}

function buildVoucherReference(transaction: BankTransactionRow, bankCode: string) {
  const hashNumber = Number.parseInt(transaction.fingerprint.slice(0, 8), 16);
  const suffix = Number.isFinite(hashNumber)
    ? String(hashNumber % 10_000).padStart(4, "0")
    : transaction.id.replace(/[^0-9]/g, "").slice(0, 4).padStart(4, "0");
  return `${getVoucherReferencePrefix(transaction)}-${bankCode}-${suffix}`;
}

function buildVoucherNarration(description: string, referenceNumber: string) {
  const narration = toText(description, 1600);
  const reference = toText(referenceNumber, 200);
  if (!reference || normalizeName(narration).includes(normalizeName(reference))) return narration;
  return `${narration}${narration ? " | " : ""}UTR/Ref: ${reference}`.slice(0, 1900);
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function resolveQueueUser(request: Request) {
  const suppliedWorkerSecret = request.headers.get("x-worker-secret");
  const workerOwnerId = request.headers.get("x-worker-owner-id")?.trim();
  if (
    suppliedWorkerSecret &&
    process.env.WORKER_SECRET &&
    suppliedWorkerSecret === process.env.WORKER_SECRET &&
    workerOwnerId
  ) {
    return { id: workerOwnerId };
  }
  return requireRequestUser(request);
}

export async function POST(request: Request) {
  try {
    const user = await resolveQueueUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as QueuePayload;
    const outgoingAction = body.outgoingAction === "post" ? "post" : "verify";
    const submittedConnectionId = toText(body.connectionId, 80);
    const requestedTransactionIds = Array.isArray(body.transactionIds)
      ? body.transactionIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const ledgerSelectionByTransactionId = new Map<string, TransactionLedgerSelection>(
      (Array.isArray(body.transactions) ? body.transactions : []).flatMap((transaction) => {
        const transactionId = toText(transaction?.transactionId, 80);
        const counterpartyLedgerName = toText(transaction?.counterpartyLedgerName, 500);
        const createLedgerName = toText(transaction?.createLedgerName, 500);
        const createLedgerParentName = toText(transaction?.createLedgerParentName, 240);
        const billAllocations = readBillAllocations(transaction?.billAllocations);
        if (!transactionId || (!counterpartyLedgerName && !createLedgerName)) return [];

        return [
          [
            transactionId,
            {
              counterpartyLedgerName,
              createLedgerName,
              createLedgerParentName,
              billAllocations,
              billMatchingVerified: transaction?.billMatchingVerified === true,
              duplicateCheckVerified: transaction?.duplicateCheckVerified === true,
            },
          ] as const,
        ];
      })
    );
    const saveMappingTransactionIds = new Set(
      (Array.isArray(body.transactions) ? body.transactions : []).flatMap((transaction) => {
        const transactionId = toText(transaction?.transactionId, 80);
        return transactionId && transaction?.saveMapping === true ? [transactionId] : [];
      })
    );
    const accountId = toText(body.accountId, 80);

    if (!submittedConnectionId) {
      return jsonWithCors(request, { error: "Tally connection is required." }, { status: 400 });
    }
    if (!accountId && requestedTransactionIds.length === 0) {
      return jsonWithCors(
        request,
        { error: "Provide an account or at least one transaction to queue." },
        { status: 400 }
      );
    }

    const supabase = createSupabaseAdminClient();
    const expectedCompanyName = toText(body.companyName, 240);
    if (!expectedCompanyName) {
      return jsonWithCors(request, { error: "Select the Tally company before sending entries." }, { status: 400 });
    }

    const { data: submittedConnection, error: submittedConnectionError } = await supabase
      .from("tally_connections")
      .select("id, owner_user_id, status, last_company_name, last_heartbeat_at, last_tally_reachable")
      .eq("id", submittedConnectionId)
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .maybeSingle();

    if (submittedConnectionError) throw submittedConnectionError;
    if (!submittedConnection) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }

    const heartbeatAgeMs = submittedConnection.last_heartbeat_at
      ? Date.now() - new Date(submittedConnection.last_heartbeat_at).getTime()
      : Number.POSITIVE_INFINITY;
    const connectionIsLive =
      submittedConnection.last_tally_reachable === true &&
      ["company_loaded", "tally_reachable", "bridge_connected"].includes(submittedConnection.status) &&
      heartbeatAgeMs <= 60_000;
    if (!connectionIsLive) {
      return jsonWithCors(
        request,
        { error: "The selected Tally connection is not live. Refresh the connection and try again." },
        { status: 400 }
      );
    }

    const activeCompanyName = toText(submittedConnection.last_company_name, 240);
    if (!activeCompanyName || normalizeName(activeCompanyName) !== normalizeName(expectedCompanyName)) {
      return jsonWithCors(
        request,
        {
          error: `Tally is currently open to "${activeCompanyName || "no company"}". Switch Tally Prime to "${expectedCompanyName}", refresh Gajkesari, then try again.`,
        },
        { status: 409 }
      );
    }

    const connection = submittedConnection;
    const connectionId = connection.id;

    if (body.async === true) {
      const totalCount = requestedTransactionIds.length || (Array.isArray(body.transactions) ? body.transactions.length : 0) || 1;
      const { data: job, error: jobError } = await supabase
        .from("bank_statement_tally_queue_jobs")
        .insert({
          owner_user_id: user.id,
          connection_id: connectionId,
          bank_account_id: accountId || null,
          status: "queued",
          request_payload: {
            ...body,
            async: false,
            connectionId,
          },
          result: {
            queuedCount: 0,
            verificationCount: 0,
            commandCount: 0,
            commands: [],
          },
          total_count: totalCount,
          processed_count: 0,
        })
        .select("*")
        .single();

      if (jobError) throw jobError;

      return jsonWithCors(
        request,
        {
          async: true,
          jobId: job.id,
          job: serializeQueueJob(job as Record<string, unknown>),
        },
        { status: 202 }
      );
    }

    let query = supabase
      .from("bank_transactions")
      .select("*")
      .eq("owner_user_id", user.id)
      .in("tally_status", ["pending", "failed", "missing_in_tally", "verification_failed"])
      .order("transaction_date", { ascending: true })
      .limit(100);

    if (requestedTransactionIds.length) {
      query = query.in("id", requestedTransactionIds);
    } else {
      query = query.eq("bank_account_id", accountId);
    }

    const { data: transactionRows, error: transactionError } = await query;
    if (transactionError) throw transactionError;

    const transactions = (transactionRows ?? []) as unknown as BankTransactionRow[];
    if (transactions.length === 0) {
      let summaryQuery = supabase
        .from("bank_transactions")
        .select("tally_status")
        .eq("owner_user_id", user.id);

      if (requestedTransactionIds.length) {
        summaryQuery = summaryQuery.in("id", requestedTransactionIds);
      } else {
        summaryQuery = summaryQuery.eq("bank_account_id", accountId);
      }

      const { data: summaryRows, error: summaryError } = await summaryQuery;
      if (summaryError) throw summaryError;

      const statusCounts = ((summaryRows ?? []) as unknown as TransactionStatusSummaryRow[]).reduce(
        (counts, row) => {
          const status = row.tally_status || "unknown";
          counts[status] = (counts[status] ?? 0) + 1;
          return counts;
        },
        {} as Record<string, number>
      );

      return jsonWithCors(
        request,
        {
          error:
            (summaryRows ?? []).length === 0
              ? "No transactions were found for the selected bank account."
              : "No pending, failed, or missing transactions were found to queue.",
          queuedCount: 0,
          commands: [],
          diagnostics: {
            selectedAccountId: accountId || null,
            requestedTransactionCount: requestedTransactionIds.length,
            transactionCount: (summaryRows ?? []).length,
            statusCounts,
          },
        },
        { status: 400 }
      );
    }

    const accountIds = Array.from(new Set(transactions.map((transaction) => transaction.bank_account_id)));
    const { data: accountRows, error: accountError } = await supabase
      .from("bank_accounts")
      .select("id, bank_name, account_number_masked, account_holder_name, tally_ledger_name")
      .eq("owner_user_id", user.id)
      .in("id", accountIds);

    if (accountError) throw accountError;
    const accountsById = new Map(
      ((accountRows ?? []) as unknown as BankAccountRow[]).map((account) => [account.id, account])
    );
    const importIds = Array.from(
      new Set(
        transactions
          .map((transaction) => transaction.statement_import_id)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
      )
    );
    const { data: importRows, error: importRowsError } = importIds.length
      ? await supabase
          .from("bank_statement_imports")
          .select("id, extracted_bank_name")
          .eq("owner_user_id", user.id)
          .in("id", importIds)
      : { data: [], error: null };

    if (importRowsError) throw importRowsError;

    const importsById = new Map(
      ((importRows ?? []) as unknown as BankStatementImportRow[]).map((importRow) => [
        importRow.id,
        importRow,
      ])
    );

    const fingerprints = transactions.map((transaction) => transaction.fingerprint);
    const { data: postingLogRows, error: postingLogError } = await supabase
      .from("bank_transaction_posting_log")
      .select("fingerprint, status, command_id")
      .eq("owner_user_id", user.id)
      .in("bank_account_id", accountIds)
      .in("fingerprint", fingerprints)
      .in("status", ["queued", "posted", "verified"]);

    if (postingLogError) throw postingLogError;

    const postingLogs = (postingLogRows ?? []) as unknown as PostingLogRow[];
    const queuedCommandIds = postingLogs
      .filter((row) => row.status === "queued" && row.command_id)
      .map((row) => row.command_id as string);
    const { data: existingCommandRows, error: existingCommandError } = queuedCommandIds.length
      ? await supabase
          .from("tally_bridge_commands")
          .select("id, status")
          .in("id", queuedCommandIds)
      : { data: [], error: null };

    if (existingCommandError) throw existingCommandError;

    const activeCommandIds = new Set(
      ((existingCommandRows ?? []) as unknown as ExistingCommandRow[])
        .filter((row) => row.status === "queued" || row.status === "claimed")
        .map((row) => row.id)
    );
    const blockedFingerprints = new Set(
      postingLogs
        .filter((row) => row.status === "posted" || row.status === "verified" || (row.command_id && activeCommandIds.has(row.command_id)))
        .map((row) => row.fingerprint)
    );

    const skipped = {
      alreadyPostedOrActive: 0,
      missingAccount: 0,
      missingBankLedger: 0,
      missingCounterpartyLedger: 0,
      ledgerNotSynced: 0,
      bankLedgerNotSynced: 0,
      counterpartyLedgerNotSynced: 0,
      invalidDate: 0,
      invalidAmount: 0,
      invalidDirection: 0,
      invalidBillAllocation: 0,
      billMatchingNotVerified: 0,
      duplicateCheckNotVerified: 0,
      sameContraLedger: 0,
    };
    type SkippedReason = keyof typeof skipped;
    const skippedRows: Array<{
      transactionId: string;
      description: string;
      reason: SkippedReason;
    }> = [];
    function skipTransaction(transaction: BankTransactionRow, reason: SkippedReason) {
      skipped[reason] += 1;
      skippedRows.push({
        transactionId: transaction.id,
        description: transaction.description,
        reason,
      });
      return [] as TallyCommandInsert[];
    }

    // Posting only needs the ledgers referenced by these rows. Loading every
    // synced ledger (including raw_payload) made a four-row post download the
    // entire 12k+ master catalogue before it could create any commands.
    const requestedLedgerNames = new Set<string>();
    for (const transaction of transactions) {
      const account = accountsById.get(transaction.bank_account_id);
      const selection = ledgerSelectionByTransactionId.get(transaction.id);
      const bankLedger = toText(body.bankLedgerName, 500) || account?.tally_ledger_name || "";
      const legacyFallback = requestedTransactionIds.length === 1 ? toText(body.counterpartyLedgerName, 500) : "";
      [
        bankLedger,
        selection?.counterpartyLedgerName,
        selection?.createLedgerName,
        transaction.confirmed_ledger_name,
        Number(transaction.suggestion_confidence ?? 0) >= 0.85 ? transaction.suggested_ledger_name : "",
        legacyFallback,
      ].forEach((name) => {
        const value = toText(name, 500);
        if (value) requestedLedgerNames.add(value);
      });
    }

    const ledgerQueries = chunkValues(Array.from(requestedLedgerNames)).map((names) =>
      supabase
        .from("tally_masters")
        .select("tally_name, parent_name, raw_payload")
        .eq("owner_user_id", user.id)
        .eq("connection_id", connectionId)
        .eq("master_type", "ledger")
        .eq("is_active", true)
        .in("tally_name", names)
    );
    const [ledgerQueryResults, suspenseResult] = await Promise.all([
      Promise.all(ledgerQueries),
      supabase
        .from("tally_masters")
        .select("tally_name, parent_name, raw_payload")
        .eq("owner_user_id", user.id)
        .eq("connection_id", connectionId)
        .eq("master_type", "ledger")
        .eq("is_active", true)
        .or("tally_name.ilike.%suspense%,parent_name.ilike.%suspense%")
        .limit(100),
    ]);
    for (const result of ledgerQueryResults) {
      if (result.error) throw result.error;
    }
    if (suspenseResult.error) throw suspenseResult.error;
    const activeLedgers = Array.from(
      new Map(
        [
          ...ledgerQueryResults.flatMap((result) => (result.data ?? []) as unknown as TallyLedgerRow[]),
          ...((suspenseResult.data ?? []) as unknown as TallyLedgerRow[]),
        ].map((ledger) => [normalizeName(ledger.tally_name), ledger] as const)
      ).values()
    );
    const companySuspenseLedgerName = resolveCompanySuspenseLedgerName(
      activeLedgers.map((ledger) => ({ name: ledger.tally_name, parent: ledger.parent_name }))
    ) || "";

    // Resolve only the ancestor chains needed to classify selected ledgers.
    // Tally group trees are shallow, so this is normally one or two compact
    // requests instead of another paginated full-master scan.
    const activeGroups: TallyLedgerRow[] = [];
    const loadedGroupNames = new Set<string>();
    let pendingGroupNames = Array.from(
      new Set(
        [
          ...activeLedgers.map((ledger) => ledger.parent_name || ""),
          ...Array.from(ledgerSelectionByTransactionId.values()).map((selection) => selection.createLedgerParentName),
        ].filter(Boolean)
      )
    );
    for (let depth = 0; pendingGroupNames.length > 0 && depth < 20; depth += 1) {
      const names = pendingGroupNames.filter((name) => !loadedGroupNames.has(normalizeName(name)));
      if (names.length === 0) break;
      const results = await Promise.all(
        chunkValues(names).map((nameChunk) =>
          supabase
            .from("tally_masters")
            .select("tally_name, parent_name")
            .eq("owner_user_id", user.id)
            .eq("connection_id", connectionId)
            .eq("master_type", "group")
            .eq("is_active", true)
            .in("tally_name", nameChunk)
        )
      );
      for (const result of results) {
        if (result.error) throw result.error;
      }
      const rows = results.flatMap((result) => (result.data ?? []) as unknown as TallyLedgerRow[]);
      for (const row of rows) {
        loadedGroupNames.add(normalizeName(row.tally_name));
        activeGroups.push(row);
      }
      pendingGroupNames = rows.map((row) => row.parent_name || "").filter(Boolean);
    }
    const groupIdentities = activeGroups.map((group) => ({
      name: group.tally_name,
      parent: group.parent_name,
    }));

    const syncedLedgerNames = new Set(
      activeLedgers.map((ledger) => normalizeName(ledger.tally_name))
    );
    const ledgerParentByName = new Map(
      activeLedgers.map((ledger) => [
        normalizeName(ledger.tally_name),
        ledger.parent_name ?? "",
      ])
    );
    const ledgerBillWiseEnabledByName = new Map(
      activeLedgers.map((ledger) => {
        const value = ledger.raw_payload?.billWiseEnabled;
        return [normalizeName(ledger.tally_name), typeof value === "boolean" ? value : null] as const;
      })
    );

    function ledgerExists(ledgerName: string) {
      return syncedLedgerNames.has(normalizeName(ledgerName));
    }

    function isPartyParent(parentName: string) {
      return (
        masterParentDescendsFromGroup(parentName, groupIdentities, "Sundry Debtors") ||
        masterParentDescendsFromGroup(parentName, groupIdentities, "Sundry Creditors")
      );
    }

    function isPartyLedger(ledgerName: string) {
      return classifyPartyLedgerFromGroups(
        {
          name: ledgerName,
          parent: ledgerParentByName.get(normalizeName(ledgerName)) || "",
        },
        groupIdentities
      ) !== "other";
    }

    function isBankOrCashLedger(ledgerName: string) {
      const parentName = ledgerParentByName.get(normalizeName(ledgerName)) || "";
      return ["Bank Accounts", "Bank OD A/c", "Cash-in-Hand"].some(
        (rootGroupName) =>
          normalizeName(parentName) === normalizeName(rootGroupName) ||
          masterParentDescendsFromGroup(parentName, groupIdentities, rootGroupName)
      );
    }

    const commandInputs = transactions.map((transaction) => {
      const selectedLedger = ledgerSelectionByTransactionId.get(transaction.id);
      const createLedgerName = selectedLedger?.createLedgerName || "";
      const legacyFallback = requestedTransactionIds.length === 1 ? toText(body.counterpartyLedgerName, 500) : "";
      const confirmedLedgerName = transaction.confirmed_ledger_name || "";
      const storedSuggestedLedgerName = transaction.suggested_ledger_name || "";
      const selectedCounterpartyLedgerName =
        createLedgerName ||
        selectedLedger?.counterpartyLedgerName ||
        confirmedLedgerName ||
        (Number(transaction.suggestion_confidence ?? 0) >= 0.85 && !isSuspenseLedger(storedSuggestedLedgerName)
          ? storedSuggestedLedgerName
          : "") ||
        legacyFallback;
      const counterpartyLedgerName =
        isSuspenseLedger(selectedCounterpartyLedgerName) && companySuspenseLedgerName
          ? companySuspenseLedgerName
          : selectedCounterpartyLedgerName;

      return {
        transaction,
        counterpartyLedgerName,
        createLedgerName,
        createLedgerParentName: selectedLedger?.createLedgerParentName || "Sundry Creditors",
      };
    });

    const queuedCreateLedgerKeys = new Set<string>();
    const commands: TallyCommandInsert[] = commandInputs.flatMap(
      ({ transaction, counterpartyLedgerName, createLedgerName, createLedgerParentName }) => {
        if (blockedFingerprints.has(transaction.fingerprint)) {
          return skipTransaction(transaction, "alreadyPostedOrActive");
        }
        const account = accountsById.get(transaction.bank_account_id);
        const amount = getTransactionAmount(transaction);
        const voucherDate = getVoucherDate(transaction);
        const bankLedgerName = toText(body.bankLedgerName, 500) || account?.tally_ledger_name || "";
        if (!account) {
          return skipTransaction(transaction, "missingAccount");
        }
        if (!isValidTransactionDate(voucherDate)) {
          return skipTransaction(transaction, "invalidDate");
        }
        if (!bankLedgerName) {
          return skipTransaction(transaction, "missingBankLedger");
        }
        const shouldCreateCounterpartyLedger = Boolean(createLedgerName) && !ledgerExists(createLedgerName);
        const bankLedgerIsSynced = ledgerExists(bankLedgerName);
        if (!bankLedgerIsSynced) {
          skipped.bankLedgerNotSynced += 1;
          skipped.ledgerNotSynced += 1;
          skippedRows.push({ transactionId: transaction.id, description: transaction.description, reason: "bankLedgerNotSynced" });
          return [];
        }
        if (amount <= 0) {
          return skipTransaction(transaction, "invalidAmount");
        }
        const outgoingPayment = isOutgoingPayment(transaction);
        const incomingReceipt = isIncomingReceipt(transaction);
        if (!outgoingPayment && !incomingReceipt) {
          return skipTransaction(transaction, "invalidDirection");
        }
        const billAllocations = ledgerSelectionByTransactionId.get(transaction.id)?.billAllocations ?? [];
        const billMatchingVerified = ledgerSelectionByTransactionId.get(transaction.id)?.billMatchingVerified === true;
        const originalVoucherType = getVoucherType(transaction);
        const statementImport = transaction.statement_import_id
          ? importsById.get(transaction.statement_import_id)
          : null;
        const referenceBankCode = getVoucherReferenceBankCode(
          statementImport?.extracted_bank_name || account.bank_name
        );
        const referenceNumber =
          transaction.reference_number || buildVoucherReference(transaction, referenceBankCode);

        if (outgoingPayment && outgoingAction === "verify") {
          const nextCommands: TallyCommandInsert[] = [];
          nextCommands.push({
            connection_id: connectionId,
            owner_user_id: user.id,
            command_type: "verify_bank_transaction",
            status: "queued",
            priority: 20,
            payload: {
              transactionId: transaction.id,
              bankAccountId: account.id,
              fingerprint: transaction.fingerprint,
              companyName: expectedCompanyName,
              voucherDate,
              bankLedgerName,
              counterpartyLedgerName: counterpartyLedgerName || null,
              matchedLedgerName: counterpartyLedgerName || null,
              amount,
              narration: transaction.description,
              referenceNumber,
              transactionType: transaction.transaction_type,
              category: transaction.category,
              counterpartyName: transaction.counterparty_name,
              accountNumberMasked: account.account_number_masked,
              expectedDirection: "outgoing",
            },
          });
          return nextCommands;
        }

        // The connector performs an authoritative live duplicate preflight immediately
        // before import. The browser-side statement check is useful review context, but
        // it is not required in order to queue a safely guarded voucher.
        if (!counterpartyLedgerName) {
          return skipTransaction(transaction, "missingCounterpartyLedger");
        }
        const counterpartyLedgerIsReady = shouldCreateCounterpartyLedger || ledgerExists(counterpartyLedgerName);
        if (!counterpartyLedgerIsReady) {
          skipped.counterpartyLedgerNotSynced += 1;
          skipped.ledgerNotSynced += 1;
          skippedRows.push({ transactionId: transaction.id, description: transaction.description, reason: "counterpartyLedgerNotSynced" });
          return [];
        }
        const counterpartyIsPartyLedger = shouldCreateCounterpartyLedger
          ? isPartyParent(createLedgerParentName)
          : isPartyLedger(counterpartyLedgerName);
        const counterpartyRequiresBillMatching = counterpartyIsPartyLedger && (
          shouldCreateCounterpartyLedger ||
          ledgerBillWiseEnabledByName.get(normalizeName(counterpartyLedgerName)) !== false
        );
        if (counterpartyRequiresBillMatching && !billMatchingVerified) {
          return skipTransaction(transaction, "billMatchingNotVerified");
        }
        if (
          (counterpartyIsPartyLedger && billAllocations.length > 0 && Math.abs(billAllocationTotal(billAllocations) - amount) >= 0.005) ||
          (!counterpartyIsPartyLedger && billAllocations.length > 0)
        ) {
          return skipTransaction(transaction, "invalidBillAllocation");
        }
        const counterpartyIsBankOrCashLedger = shouldCreateCounterpartyLedger
          ? ["Bank Accounts", "Bank OD A/c", "Cash-in-Hand"].some(
              (rootGroupName) =>
                normalizeName(createLedgerParentName) === normalizeName(rootGroupName) ||
                masterParentDescendsFromGroup(createLedgerParentName, groupIdentities, rootGroupName)
            )
          : isBankOrCashLedger(counterpartyLedgerName);
        if (
          counterpartyIsBankOrCashLedger &&
          normalizeName(counterpartyLedgerName) === normalizeName(bankLedgerName)
        ) {
          return skipTransaction(transaction, "sameContraLedger");
        }
        const nextCommands: TallyCommandInsert[] = [];
        const createLedgerKey = normalizeName(createLedgerName);
        if (shouldCreateCounterpartyLedger && createLedgerKey && !queuedCreateLedgerKeys.has(createLedgerKey)) {
          queuedCreateLedgerKeys.add(createLedgerKey);
          nextCommands.push({
            connection_id: connectionId,
            owner_user_id: user.id,
            command_type: "create_ledger",
            status: "queued",
            priority: 30,
            payload: {
              name: createLedgerName,
              parentName: createLedgerParentName,
              companyName: expectedCompanyName,
              source: "bank_statement_queue",
            },
          });
        }

        nextCommands.push({
          connection_id: connectionId,
          owner_user_id: user.id,
          command_type: "post_bank_voucher",
          status: "queued",
          priority: 20,
          payload: {
            transactionId: transaction.id,
            bankAccountId: account.id,
            fingerprint: transaction.fingerprint,
            companyName: expectedCompanyName,
            voucherType: counterpartyIsBankOrCashLedger ? "Contra" : originalVoucherType,
            voucherDate,
            bankLedgerName,
            counterpartyLedgerName,
            matchedLedgerName: counterpartyLedgerName,
            counterpartyIsPartyLedger,
            postingFallbackReason: isSuspenseLedger(counterpartyLedgerName) ? "unresolved_counterparty" : null,
            bankLedgerEntryIsDebit: bankEntryIsDebit(transaction),
            amount,
            narration: buildVoucherNarration(transaction.description, referenceNumber),
            referenceNumber,
            transactionType: transaction.transaction_type,
            category: transaction.category,
            counterpartyName: transaction.counterparty_name,
            accountNumberMasked: account.account_number_masked,
            billAllocations,
            expectedDirection: outgoingPayment ? "outgoing" : "incoming",
            preflightVerifyExisting: true,
          },
        });

        return nextCommands;
      }
    );

    const voucherCommands = commands.filter((command) => command.command_type === "post_bank_voucher");
    const verificationCommands = commands.filter((command) => command.command_type === "verify_bank_transaction");
    const expectedReceiptCount = transactions.filter(isIncomingReceipt).length;
    const outgoingTransactionCount = transactions.filter(isOutgoingPayment).length;
    const expectedPaymentCheckCount = outgoingAction === "verify" ? outgoingTransactionCount : 0;
    const expectedPaymentPostCount = outgoingAction === "post" ? outgoingTransactionCount : 0;
    if (voucherCommands.length === 0 && verificationCommands.length === 0) {
      return jsonWithCors(
        request,
        {
          error: "No transactions could be queued. Check diagnostics for the skipped reason.",
          queuedCount: 0,
          commands: [],
          diagnostics: {
            eligibleTransactionCount: transactions.length,
            expectedReceiptCount,
            expectedPaymentPostCount,
            expectedPaymentCheckCount,
            companySuspenseLedgerName: companySuspenseLedgerName || null,
            skipped,
            skippedRows,
          },
        },
        { status: 400 }
      );
    }

    // Persist company-scoped mappings before releasing commands to the bridge.
    // A mapping/schema failure must not leave the queue job marked failed after
    // Tally vouchers have already started executing.
    const mappingRows = commands.flatMap((command) => {
      const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
      const transaction = transactions.find((row) => row.id === payload.transactionId);
      const account = transaction ? accountsById.get(transaction.bank_account_id) : null;
      const bankLedger = typeof payload.bankLedgerName === "string" ? payload.bankLedgerName.trim() : "";
      const counterpartyLedger =
        typeof payload.matchedLedgerName === "string"
          ? payload.matchedLedgerName.trim()
          : typeof payload.counterpartyLedgerName === "string"
            ? payload.counterpartyLedgerName.trim()
            : "";
      const rows: MappingRow[] = [];

      if (account && bankLedger) {
        rows.push({
          connection_id: connectionId,
          company_name: expectedCompanyName,
          owner_user_id: user.id,
          mapping_type: "bank_account_ledger",
          source_key: buildBankAccountLedgerSourceKey(account.id),
          source_label: `${account.bank_name || "Bank"} ${account.account_number_masked}`.trim(),
          ...buildLedgerMappingTarget(bankLedger),
          status: "active",
          notes: "Saved from bank voucher queue confirmation.",
        });
      }

      if (
        transaction &&
        counterpartyLedger &&
        saveMappingTransactionIds.has(transaction.id) &&
        !isSuspenseLedgerIdentity({
          name: counterpartyLedger,
          parent: ledgerParentByName.get(normalizeName(counterpartyLedger)) || "",
        })
      ) {
        rows.push({
          connection_id: connectionId,
          company_name: expectedCompanyName,
          owner_user_id: user.id,
          mapping_type: "bank_narration_ledger",
          source_key: buildBankNarrationLedgerSourceKey(transaction.bank_account_id, transaction.description),
          source_label: transaction.description.slice(0, 500),
          ...buildLedgerMappingTarget(counterpartyLedger),
          status: "active",
          notes: "Saved from bank voucher queue confirmation.",
        });
      }

      return rows;
    });
    const uniqueMappingRows = Array.from(
      new Map(
        mappingRows.map((row) => [
          `${row.connection_id}:${row.company_name}:${row.mapping_type}:${row.source_key}`,
          row,
        ])
      ).values()
    );

    if (uniqueMappingRows.length > 0) {
      const { error: mappingError } = await supabase
        .from("tally_mapping_settings")
        .upsert(uniqueMappingRows, {
          onConflict: "connection_id,company_name,mapping_type,source_key",
        });

      if (mappingError) throw mappingError;
    }

    const { data: createdCommands, error: commandError } = await supabase
      .from("tally_bridge_commands")
      .insert(commands)
      .select("*");

    if (commandError) throw commandError;

    const createdCommandRows = (createdCommands ?? []) as Array<{
      id: string;
      command_type: string;
      payload: Record<string, unknown>;
    }>;
    const logRows = createdCommandRows.flatMap((command) => {
      const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
      const transaction = transactions.find((row) => row.id === payload.transactionId);
      const account = transaction ? accountsById.get(transaction.bank_account_id) : null;
      if (!transaction || !account) return [];

      return [
        {
          owner_user_id: user.id,
          bank_account_id: transaction.bank_account_id,
          connection_id: connectionId,
          source_transaction_id: transaction.id,
          fingerprint: transaction.fingerprint,
          transaction_date: transaction.transaction_date,
          reference_number: transaction.reference_number,
          description: transaction.description,
          debit_amount: transaction.debit_amount,
          credit_amount: transaction.credit_amount,
          amount: getTransactionAmount(transaction),
          voucher_type: getVoucherType(transaction),
          bank_ledger_name: payload.bankLedgerName,
          counterparty_ledger_name: payload.counterpartyLedgerName,
          command_id: command.id,
          status: "queued",
          error: null,
          result: {},
        },
      ];
    });

    if (logRows.length > 0) {
      const { error: logError } = await supabase
        .from("bank_transaction_posting_log")
        .upsert(logRows, {
          onConflict: "owner_user_id,bank_account_id,fingerprint",
        });

      if (logError) throw logError;
    }

    const queuedTransactionIds = voucherCommands
      .map((command) => command.payload.transactionId)
      .filter((value): value is string => typeof value === "string");
    const verificationTransactionIds = verificationCommands
      .map((command) => command.payload.transactionId)
      .filter((value): value is string => typeof value === "string");

    if (queuedTransactionIds.length > 0) {
      const { error: queuedStatusError } = await supabase
        .from("bank_transactions")
        .update({ tally_status: "pending" })
        .eq("owner_user_id", user.id)
        .in("id", queuedTransactionIds);

      if (queuedStatusError) throw queuedStatusError;
    }

    if (verificationTransactionIds.length > 0) {
      const { error: verificationStatusError } = await supabase
        .from("bank_transactions")
        .update({ tally_status: "checking_in_tally" })
        .eq("owner_user_id", user.id)
        .in("id", verificationTransactionIds);

      if (verificationStatusError) throw verificationStatusError;
    }

    const transactionUpdates = createdCommandRows.flatMap((command) => {
      const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
      const transactionId = typeof payload.transactionId === "string" ? payload.transactionId : "";
      const counterpartyLedgerName =
        typeof payload.matchedLedgerName === "string"
          ? payload.matchedLedgerName
          : typeof payload.counterpartyLedgerName === "string"
            ? payload.counterpartyLedgerName
            : "";
      if (!transactionId || !counterpartyLedgerName) return [];
      return [{ transactionId, counterpartyLedgerName }];
    });

    await Promise.all(
      transactionUpdates.map((update) =>
        supabase
          .from("bank_transactions")
          .update({
            confirmed_ledger_name: update.counterpartyLedgerName,
            ledger_mapping_source: "queue_confirmation",
          })
          .eq("owner_user_id", user.id)
          .eq("id", update.transactionId)
      )
    );

    const bankLedgerByAccountId = new Map(
      createdCommandRows.flatMap((command) => {
        const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
        const bankAccountId = typeof payload.bankAccountId === "string" ? payload.bankAccountId : "";
        const ledgerName = typeof payload.bankLedgerName === "string" ? payload.bankLedgerName : "";
        return bankAccountId && ledgerName ? [[bankAccountId, ledgerName] as const] : [];
      })
    );

    await Promise.all(
      Array.from(bankLedgerByAccountId.entries()).map(([bankAccountId, ledgerName]) =>
        supabase
          .from("bank_accounts")
          .update({ tally_connection_id: connectionId, tally_ledger_name: ledgerName })
          .eq("owner_user_id", user.id)
          .eq("id", bankAccountId)
      )
    );

    await supabase.from("tally_connection_events").insert({
      connection_id: connectionId,
      owner_user_id: user.id,
      event_type: "command_queued",
      message: "Bank statement Tally actions queued for bridge.",
      payload: {
        commandType: "bank_statement_tally_actions",
        queuedCount: voucherCommands.length,
        verificationCount: verificationCommands.length,
        commandCount: commands.length,
        transactionIds: [...queuedTransactionIds, ...verificationTransactionIds],
        savedMappingCount: uniqueMappingRows.length,
      },
    });

    // Wake only after the posting logs and transaction checkpoints are ready;
    // otherwise a very fast connector could finish before this route records
    // the queued state and have its success overwritten.
    await wakeTallyConnector(connectionId);

    return jsonWithCors(request, {
      queuedCount: voucherCommands.length,
      verificationCount: verificationCommands.length,
      commandCount: commands.length,
      commands: createdCommands ?? [],
      diagnostics: {
        eligibleTransactionCount: transactions.length,
        expectedReceiptCount,
        expectedPaymentPostCount,
        expectedPaymentCheckCount,
        companySuspenseLedgerName: companySuspenseLedgerName || null,
        skipped,
        skippedRows,
      },
    });
  } catch (error) {
    console.error("Error in POST /api/bank-statements/tally/queue:", error);
    return jsonWithCors(
      request,
      { error: serializeError(error) },
      { status: 500 }
    );
  }
}
