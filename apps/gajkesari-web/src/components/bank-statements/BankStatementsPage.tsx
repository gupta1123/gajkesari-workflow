"use client";

import { tallyBrowserStorage } from "@/lib/tally-browser-storage";


import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Filter,
  Info,
  Landmark,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  UploadCloud,
  X,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";
import { allocateReceiptByFifo } from "@/lib/bank-statement-bill-allocation";
import { isReadyForTallyPosting } from "@/lib/bank-statement-posting-readiness";
import { runCashDiscountLiveRequest } from "@/lib/cash-discount-live";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";
import { pdfToImagePages } from "@/services/pdf";

type BankAccount = {
  id: string;
  bankName: string | null;
  accountNumber: string | null;
  accountNumberMasked: string;
  accountHolderName: string | null;
  ifscCode: string | null;
  tallyLedgerName: string | null;
  lastImportedTransactionAt: string | null;
  lastTallyPostedTransactionAt: string | null;
};

type BankStatementImport = {
  id: string;
  status: string;
  originalFileName: string;
  statementPeriodStart?: string | null;
  statementPeriodEnd?: string | null;
  importedTransactionCount: number;
  duplicateTransactionCount: number;
  createdAt: string;
};

type CompanyOption = {
  id: string;
  connectionId: string;
  companyName: string;
  financialYear: string;
  status: string;
  bridgeConnected: boolean;
  tallyReachable: boolean;
  companyLoaded: boolean;
  bankAccountCount: number | null;
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  bankLedgers?: LocalBankLedger[];
};

type LocalBankLedger = {
  name: string;
  parent?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  closingBalance?: number | null;
  closingBalanceType?: "Dr" | "Cr" | null;
};

type LiveBankLedgerResult = {
  companyName?: string | null;
  companyNames?: string[];
  bankLedgers?: LocalBankLedger[];
  byCompany?: Record<string, LocalBankLedger[]>;
  errors?: Array<{ companyName?: string; error?: string }>;
};

const BANK_STATEMENT_COMPANY_SELECTION_KEY = "gajkesari.bankStatements.selectedCompany.v1";

function uniqueCompanyOptions(options: CompanyOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.companyName.trim().toLowerCase()}::${option.financialYear.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortCompanyOptions(options: CompanyOption[]) {
  return [...options].sort((left, right) => {
    const leftLiveRank = Number(left.bridgeConnected) + Number(left.tallyReachable) + Number(left.companyLoaded);
    const rightLiveRank = Number(right.bridgeConnected) + Number(right.tallyReachable) + Number(right.companyLoaded);
    if (leftLiveRank !== rightLiveRank) return rightLiveRank - leftLiveRank;

    return new Date(right.lastHeartbeatAt ?? right.lastSyncAt ?? 0).getTime() -
      new Date(left.lastHeartbeatAt ?? left.lastSyncAt ?? 0).getTime();
  });
}

function formatCompanyOptionLabel(company: CompanyOption) {
  return [company.companyName, company.financialYear].filter(Boolean).join(" - ");
}

function readStoredCompanySelection(): CompanyOption | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = tallyBrowserStorage.getItem(BANK_STATEMENT_COMPANY_SELECTION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CompanyOption>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const connectionId = typeof value.connectionId === "string" ? value.connectionId.trim() : "";
    const companyName = typeof value.companyName === "string" ? value.companyName.trim() : "";
    const financialYear = typeof value.financialYear === "string" ? value.financialYear.trim() : "Current year";

    if (!id || !connectionId || !companyName) return null;

    return {
      id,
      connectionId,
      companyName,
      financialYear,
      status: typeof value.status === "string" ? value.status : "restoring",
      bridgeConnected: false,
      tallyReachable: false,
      companyLoaded: false,
      bankAccountCount: null,
      lastSyncAt: null,
      lastHeartbeatAt: null,
      lastError: null,
      bankLedgers: [],
    };
  } catch {
    return null;
  }
}

function writeStoredCompanySelection(company: CompanyOption | null) {
  if (typeof window === "undefined") return;

  if (!company) {
    tallyBrowserStorage.removeItem(BANK_STATEMENT_COMPANY_SELECTION_KEY);
    return;
  }

  tallyBrowserStorage.setItem(
    BANK_STATEMENT_COMPANY_SELECTION_KEY,
    JSON.stringify({
      id: company.id,
      connectionId: company.connectionId,
      companyName: company.companyName,
      financialYear: company.financialYear,
      status: company.status,
    })
  );
}

function findStoredCompanySelection(options: CompanyOption[]) {
  const stored = readStoredCompanySelection();
  if (!stored) return null;
  return options.find((company) => company.id === stored.id) ?? null;
}

type TallyConnection = {
  lastHeartbeatAt?: string | null;
  id: string;
  displayName: string;
  status: string;
  lastCompanyName: string | null;
  bridgeConnected?: boolean;
  heartbeatStale?: boolean;
  updatedAt?: string;
};

type TallyCommand = {
  id: string;
  connectionId?: string;
  connection_id?: string;
  commandType?: string;
  command_type?: string;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
  reconciliationRequired?: boolean;
};

type TallyQueueJob = {
  id: string;
  status: string;
  totalCount?: number;
  processedCount?: number;
  result?: TallyQueueResult | null;
  error?: string | null;
};

type TallyQueueJobResponse = {
  async?: boolean;
  jobId?: string;
  job?: TallyQueueJob;
  result?: TallyQueueResult | null;
  error?: string;
};

type TallyQueueResult = {
  queuedCount?: number;
  verificationCount?: number;
  commands?: TallyCommand[];
  diagnostics?: {
    expectedReceiptCount?: number;
    expectedPaymentCheckCount?: number;
    companySuspenseLedgerName?: string | null;
    skippedRows?: Array<{ transactionId?: string; description?: string; reason?: string }>;
  };
};

type BankLedgerFetchResult = {
  companyName?: string | null;
  bankLedgers?: LocalBankLedger[] | null;
  byCompany?: Record<string, LocalBankLedger[] | null> | null;
  errors?: Array<{ companyName?: string | null; error?: string | null }> | null;
};

type DraftAccount = {
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  ifscCode: string;
  tallyLedgerName: string;
};

type PreviewTransaction = {
  id?: string;
  transactionDate?: string | null;
  valueDate?: string | null;
  description?: string | null;
  referenceNumber?: string | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
  balanceAmount?: string | number | null;
  transactionType?: string | null;
  category?: string | null;
  counterpartyName?: string | null;
  suggestedLedgerName?: string | null;
  suggestionConfidence?: number | null;
  suggestionReason?: string | null;
  confirmedLedgerName?: string | null;
  rawPayload?: {
    aiLedgerRecommendation?: LedgerRecommendation | null;
  } | null;
};

type LedgerRecommendationAction =
  | "use_existing_ledger"
  | "create_new_ledger"
  | "use_standard_ledger"
  | "use_suspense"
  | "needs_review";

type LedgerRecommendation = {
  matchType?: "direct_match" | "close_match" | "suspense";
  status?: "completed" | "unavailable" | "deferred";
  action: LedgerRecommendationAction;
  ledgerName: string | null;
  candidateLedgerNames?: string[];
  ledgerGroup: string | null;
  confidence: number;
  requiresUserConfirmation: boolean;
  reason: string | null;
};

type ReviewTransaction = {
  id: string;
  transactionDate: string;
  valueDate: string;
  description: string;
  referenceNumber: string;
  debitAmount: string;
  creditAmount: string;
  balanceAmount: string;
  transactionType: string;
  category: string;
  counterpartyName: string;
  suggestedLedgerName: string;
  suggestionConfidence: number | null;
  suggestionReason: string;
  candidateLedgerNames: string[];
  selectedLedgerName: string;
  ledgerAction: LedgerRecommendationAction;
  ledgerGroup: string;
  requiresUserConfirmation: boolean;
  ledgerSelectionTouched?: boolean;
};

type BankLedgerResolution = {
  ledgerName: string | null;
  source: string;
  requiresSelection: boolean;
  verified: boolean;
};

type PreviewResponse = {
  bankLedgerResolution?: BankLedgerResolution;
  import: BankStatementImport;
  account: {
    bankName: string | null;
    accountNumber: string | null;
    accountNumberMasked: string;
    accountHolderName: string | null;
    ifscCode: string | null;
    tallyLedgerName?: string | null;
  };
  candidates: BankAccount[];
  transactions: PreviewTransaction[];
  transactionsPage?: number;
  transactionsPageSize?: number;
  transactionsTotal?: number;
  requiresManualExtraction?: boolean;
  extractionSource?: string | null;
  extractionError?: string | null;
  extractionDiagnostics?: {
    rawAiTransactionCount?: number;
    normalizedAiTransactionCount?: number;
    coverageComplete?: boolean;
    unresolvedPages?: number[];
  } | null;
  ledgerRecommendationError?: string | null;
  processing?: boolean;
  job?: {
    id: string;
    status: string;
    progress: number;
    stage: string | null;
    error: string | null;
  } | null;
};

type DocumentPreviewKind = "csv" | "text" | "pdf" | "image" | "unsupported";

type DocumentPreviewState = {
  fileName: string;
  kind: DocumentPreviewKind;
  headers: string[];
  rows: string[][];
  totalRows: number;
  textLines: string[];
  objectUrl: string | null;
  error: string | null;
};

type ApiErrorPayload = {
  error?: string;
  code?: string;
  detail?: string;
  userAction?: string;
  diagnostics?: unknown;
};

function ExtractionEngineBadge({ source }: { source?: string | null }) {
  if (!source) return null;
  const isQuick = source === "anydoc_markdown_v1" || source === "csv_text_v1";

  return (
    <span
      aria-label={isQuick ? "Quick AnyDoc extraction" : "Slow extraction path"}
      title={isQuick ? "Quick AnyDoc Markdown extraction" : "Slow PDF/image extraction"}
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full border px-1.5 text-[10px] font-black transition-all ${
        isQuick
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-amber-200 bg-amber-50 text-amber-800"
      }`}
    >
      {isQuick ? "Q" : "S"}
    </span>
  );
}

type TallyMaster = {
  key: string;
  guid?: string | null;
  name: string;
  type: string;
  parent?: string | null;
  billWiseEnabled?: boolean | null;
  ledgerType?: string | null;
  raw?: {
    billWiseEnabled?: boolean | null;
  } | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  ifscCode?: string | null;
  accountHolderName?: string | null;
  closingBalance?: number | null;
  closingBalanceType?: "Dr" | "Cr" | null;
  lastSyncedAt?: string | null;
};

type QueueTransaction = {
  id: string;
  transactionDate: string;
  description: string;
  referenceNumber: string | null;
  debitAmount: string | number | null;
  creditAmount: string | number | null;
  suggestedLedgerName: string | null;
  confirmedLedgerName: string | null;
};

type MessageTone = "success" | "error" | "info";
type ReviewStatusFilter = "all" | "matched" | "needs_review" | "suspense";
type ReviewDirectionFilter = "all" | "debit" | "credit";
type ReviewWorkStatusFilter = "all" | "needs_action" | "ready" | "completed";
type ReviewTallyResultFilter = "all" | "pending" | "found" | "missing" | "review" | "failed";
type ReviewLedgerFilter = "all" | "needs_action" | "automatic" | "manual" | "suspense";
type ReviewAllocationFilter = "all" | "needs_action" | "ready" | "completed" | "not_applicable";
type TallySendMode = "post_all" | "post_receipts" | "post_payments";
type TallyPostingScope = "all" | "receipts" | "payments";

type ToastMessage = {
  id: string;
  tone: MessageTone;
  text: string;
};

type StatementDoneSummary = {
  tone: "success" | "error" | "info";
  title: string;
  text: string;
};

type TallyPostingStatus = {
  connectionId: string;
  commandIds: string[];
  total: number;
  waiting: number;
  sent: number;
  completed: number;
  failed: number;
  canceled: number;
  finished: boolean;
  errors: string[];
  voucherTotal: number;
  voucherWaiting: number;
  voucherCompleted: number;
  voucherFailed: number;
  paymentCheckTotal: number;
  paymentCheckWaiting: number;
  paymentCheckCompleted: number;
  paymentCheckFailed: number;
};

type QueueLedgerContext = {
  name: string;
  parent: string | null;
  billWiseEnabled: boolean | null;
  ledgerType: string | null;
};

function buildQueueLedgerContext(ledgerMasters: TallyMaster[], names: Array<string | null | undefined>) {
  const requestedNames = new Set(names.map(normalizeName).filter(Boolean));
  return ledgerMasters
    .filter((ledger) => requestedNames.has(normalizeName(ledger.name)))
    .slice(0, 100)
    .map((ledger): QueueLedgerContext => ({
      name: ledger.name,
      parent: ledger.parent ?? null,
      billWiseEnabled: typeof ledger.billWiseEnabled === "boolean" ? ledger.billWiseEnabled : null,
      ledgerType: ledger.ledgerType ?? null,
    }));
}

type LedgerSelection = {
  name: string;
  action: LedgerRecommendationAction;
  ledgerGroup?: string;
};

type OpenBillReference = {
  referenceName: string;
  voucherNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  originalAmount?: number | null;
  settledAmount?: number | null;
  pendingAmount: number;
  sourceVoucherType?: string | null;
  status?: string | null;
};

type ExistingAdvanceReference = {
  referenceName: string;
  receiptDate?: string | null;
  pendingAdvanceAmount: number;
  status?: string | null;
};

type BillAllocationLine = {
  referenceType: "Agst Ref" | "Advance";
  referenceName: string;
  voucherNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  previousPendingAmount?: number | null;
  allocatedAmount: number;
  pendingAmountAfterAllocation?: number | null;
  statusAfterAllocation?: string | null;
};

type BillAllocationDraft = {
  status:
    | "not_applicable"
    | "cannot_match_yet"
    | "ready_to_post"
    | "needs_review"
    | "stale_data"
    | "posted"
    | "post_failed";
  caseType: string;
  caseLabel: string;
  reason: string;
  receiptAmount: number;
  totalAllocatedAmount: number;
  newAdvanceAmount: number;
  unallocatedAmount: number;
  allocations: BillAllocationLine[];
  candidateBills: OpenBillReference[];
  existingAdvances: ExistingAdvanceReference[];
  requiresUserReview: boolean;
  isEligibleForPosting: boolean;
};

type OutgoingMatchCandidate = {
  score?: number | null;
  reasons: string[];
  date?: string | null;
  voucherType?: string | null;
  voucherNumber?: string | null;
  reference?: string | null;
  partyLedgerName?: string | null;
  ledgerNames: string[];
  masterId?: string | null;
};

type OutgoingVerificationDraft = {
  status:
    | "not_checked"
    | "checking"
    | "found"
    | "ambiguous"
    | "missing"
    | "failed"
    | "cannot_check_yet";
  label: string;
  reason: string;
  voucherNumber?: string | null;
  voucherDate?: string | null;
  matchCount?: number | null;
  duplicateInTally?: boolean;
  duplicateVoucherCount?: number;
  scannedCount?: number | null;
  matches?: OutgoingMatchCandidate[];
};

type TallyBalanceProof = {
  available?: boolean;
  statementSequenceValid?: boolean;
  statementOpeningBalance?: number | null;
  statementClosingBalance?: number | null;
  tallyOpeningBalance?: number | null;
  tallyClosingBalance?: number | null;
  balancesMatch?: boolean | null;
  warning?: string | null;
};

type LedgerPickerOption = LedgerSelection & {
  key: string;
  label: string;
  helper?: string;
  badge?: string;
  closingBalance?: number | null;
  closingBalanceType?: "Dr" | "Cr" | null;
};

type LedgerPickerGroup = {
  label: string;
  options: LedgerPickerOption[];
};

const EMPTY_ACCOUNT: DraftAccount = {
  bankName: "",
  accountNumber: "",
  accountHolderName: "",
  ifscCode: "",
  tallyLedgerName: "",
};

function normalizeName(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function withoutRecordKey<T>(record: Record<string, T>, key: string) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function masterParentDescendsFromGroupMap(
  parentName: string | null | undefined,
  parentByName: Map<string, string | null>,
  targetGroupName: string
) {
  const target = normalizeName(targetGroupName);
  const visited = new Set<string>();
  let currentName = parentName;

  while (currentName) {
    const normalized = normalizeName(currentName);
    if (!normalized || visited.has(normalized)) return false;
    if (normalized === target) return true;
    visited.add(normalized);
    currentName = parentByName.get(normalized) ?? null;
  }

  return false;
}

function masterParentDescendsFromGroup(
  parentName: string | null | undefined,
  groups: TallyMaster[],
  targetGroupName: string
) {
  const parentByName = new Map(
    groups
      .map((group) => [normalizeName(group.name), group.parent ?? null] as const)
      .filter(([name]) => Boolean(name))
  );
  return masterParentDescendsFromGroupMap(parentName, parentByName, targetGroupName);
}

function normalizeLiveLedgerMasters(ledgers: TallyMaster[], groups: TallyMaster[]) {
  const parentByName = new Map(
    groups
      .map((group) => [normalizeName(group.name), group.parent ?? null] as const)
      .filter(([name]) => Boolean(name))
  );
  return ledgers.map((ledger) => {
    const ledgerType = masterParentDescendsFromGroupMap(ledger.parent, parentByName, "Sundry Debtors")
      ? "customer"
      : masterParentDescendsFromGroupMap(ledger.parent, parentByName, "Sundry Creditors")
        ? "supplier"
        : ledger.ledgerType ?? "other";
    const rawBillWiseEnabled = ledger.raw?.billWiseEnabled;

    return {
      ...ledger,
      key: ledger.key || ledger.guid || normalizeName(ledger.name),
      type: ledger.type || "ledger",
      ledgerType,
      billWiseEnabled:
        typeof ledger.billWiseEnabled === "boolean"
          ? ledger.billWiseEnabled
          : typeof rawBillWiseEnabled === "boolean"
            ? rawBillWiseEnabled
            : null,
    };
  });
}

function ledgerNameTokens(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .map((token) => {
      if (!token) return "";
      if (["pvt", "private", "ltd", "limited", "llp", "inc"].includes(token)) return "";
      if (token === "shri") return "shree";
      if (["ind", "industry", "industries", "industires", "indutries", "indstries"].includes(token)) return "industry";
      if (token === "supply" || token === "supplies" || token === "supplier" || token === "suppliers") return "supply";
      if (token === "enterprise" || token === "enterprises") return "enterprise";
      if (["engr", "engrs", "engg", "engineer", "engineers", "engineering"].includes(token)) return "engineer";
      if (["mech", "mechanical"].includes(token)) return "mech";
      if (token === "co" || token === "company") return "company";
      return token;
    })
    .filter(Boolean);
}

function compactLedgerName(value?: string | null) {
  return ledgerNameTokens(value).join("");
}

const GENERIC_PARTY_SUFFIX_TOKENS = new Set([
  "company",
  "enterprise",
  "firm",
  "group",
  "trader",
  "traders",
  "trading",
]);

function coreLedgerNameTokens(value?: string | null) {
  return ledgerNameTokens(value).filter(
    (token) => token.length > 1 && !GENERIC_PARTY_SUFFIX_TOKENS.has(token)
  );
}

function compactCoreLedgerName(value?: string | null) {
  return coreLedgerNameTokens(value).join("");
}

const LEDGER_PARTY_PREFIXES = new Set([
  "neft",
  "rtgs",
  "imps",
  "upi",
  "ach",
  "ecs",
  "nach",
  "cr",
  "dr",
  "credit",
  "debit",
  "hdfc",
  "icici",
  "sbi",
  "axis",
  "kotak",
  "idfc",
  "indusind",
  "canara",
  "federal",
  "yes",
]);

function cleanLedgerCandidateText(value?: string | null) {
  let cleaned = String(value ?? "")
    .replace(/\b(?:utr|ref|reference|invoice|bill|chq|cheque)\b[\s:#/-]*[a-z0-9-]+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  for (let index = 0; index < 4; index += 1) {
    const match = cleaned.match(/^([a-z0-9]+)(?:\s+|[-:/._]+)(.+)$/i);
    if (!match || !LEDGER_PARTY_PREFIXES.has(match[1].toLowerCase())) break;
    cleaned = match[2].trim();
  }

  return cleaned;
}

function ledgerNameCandidateVariants(...values: Array<string | null | undefined>) {
  const candidates: string[] = [];
  const seen = new Set<string>();

  function addCandidate(value?: string | null) {
    const trimmed = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    const key = normalizeName(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  }

  for (const value of values) {
    const raw = String(value ?? "").trim();
    addCandidate(raw);
    addCandidate(cleanLedgerCandidateText(raw));

    for (const part of raw.split(/\s+\/\s+|\s+\|\s+|\s{2,}/)) {
      addCandidate(part);
      addCandidate(cleanLedgerCandidateText(part));
    }
  }

  return candidates;
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
}

function ledgerNameSimilarity(left: string, right: string) {
  const leftCompact = compactLedgerName(left);
  const rightCompact = compactLedgerName(right);
  if (!leftCompact || !rightCompact) return 0;
  if (leftCompact === rightCompact) return 1;

  const maxLength = Math.max(leftCompact.length, rightCompact.length);
  if (maxLength < 5) return 0;

  const editScore = 1 - levenshteinDistance(leftCompact, rightCompact) / maxLength;
  const substringScore =
    leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact)
      ? 0.82 + (Math.min(leftCompact.length, rightCompact.length) / maxLength) * 0.1
      : 0;
  const leftCoreCompact = compactCoreLedgerName(left);
  const rightCoreCompact = compactCoreLedgerName(right);
  const coreMaxLength = Math.max(leftCoreCompact.length, rightCoreCompact.length);
  const coreScore =
    coreMaxLength >= 5 && leftCoreCompact && rightCoreCompact
      ? leftCoreCompact === rightCoreCompact
        ? 0.96
        : leftCoreCompact.includes(rightCoreCompact) || rightCoreCompact.includes(leftCoreCompact)
          ? 0.88 + (Math.min(leftCoreCompact.length, rightCoreCompact.length) / coreMaxLength) * 0.08
          : 1 - levenshteinDistance(leftCoreCompact, rightCoreCompact) / coreMaxLength
      : 0;
  const leftTokens = new Set(ledgerNameTokens(left));
  const rightTokens = new Set(ledgerNameTokens(right));
  const sharedTokenCount = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  const totalTokenCount = new Set([...leftTokens, ...rightTokens]).size;
  const tokenScore = totalTokenCount > 0 ? sharedTokenCount / totalTokenCount : 0;

  return Math.max(editScore, substringScore, coreScore, tokenScore);
}

function findLedgerByNormalizedName(ledgerMasters: TallyMaster[], ledgerName?: string | null) {
  const normalizedLedgerName = normalizeName(ledgerName);
  if (!normalizedLedgerName) return null;

  return (
    ledgerMasters.find((ledger) => normalizeName(ledger.name) === normalizedLedgerName) ?? null
  );
}

function formatLedgerClosingBalance(
  amount?: number | null,
  type?: "Dr" | "Cr" | null
) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  const inferredType = type || (amount < 0 ? "Dr" : amount > 0 ? "Cr" : null);
  return `Closing balance ${formatCurrencyAmount(Math.abs(amount))}${inferredType ? ` ${inferredType}` : ""}`;
}

function ledgerBalanceFields(ledger?: TallyMaster | LocalBankLedger | null) {
  return {
    closingBalance: ledger?.closingBalance ?? null,
    closingBalanceType: ledger?.closingBalanceType ?? null,
  };
}

function findCompanySuspenseLedger(ledgerMasters: TallyMaster[]) {
  const candidates = ledgerMasters.filter((ledger) => {
    const name = normalizeName(ledger.name);
    const parent = normalizeName(ledger.parent);
    return name.includes("suspense") || parent.includes("suspense");
  });
  const exactSuspense = candidates.filter((ledger) => normalizeName(ledger.name) === "suspense");
  if (exactSuspense.length === 1) return exactSuspense[0];
  const exactBankStatementSuspense = candidates.filter(
    (ledger) => normalizeName(ledger.name) === "bankstatementsuspense"
  );
  if (exactBankStatementSuspense.length === 1) return exactBankStatementSuspense[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function findLedgerByCandidates(ledgerMasters: TallyMaster[], candidates: string[]) {
  for (const candidate of candidates) {
    const ledger = findLedgerByNormalizedName(ledgerMasters, candidate);
    if (ledger) return ledger;
  }
  return null;
}

function getTallyConnectionRank(connection: TallyConnection) {
  if (connection.status === "company_loaded") return 5;
  if (connection.status === "tally_reachable") return 4;
  if (connection.status === "bridge_connected") return 3;
  if (connection.status === "waiting_for_bridge") return 2;
  return 1;
}

function getRelevantTallyConnections(connections: TallyConnection[]) {
  const connectedConnections = connections.filter(
    (connection) =>
      connection.bridgeConnected ||
      connection.status === "company_loaded" ||
      connection.status === "tally_reachable" ||
      connection.status === "bridge_connected"
  );
  const source = connectedConnections.length > 0 ? connectedConnections : connections.slice(0, 1);

  return [...source].sort((left, right) => {
    const rankDiff = getTallyConnectionRank(right) - getTallyConnectionRank(left);
    if (rankDiff !== 0) return rankDiff;
    return new Date(right.updatedAt ?? 0).getTime() - new Date(left.updatedAt ?? 0).getTime();
  });
}

function readRecommendation(transaction: PreviewTransaction): LedgerRecommendation | null {
  return transaction.rawPayload?.aiLedgerRecommendation ?? null;
}

function fallbackReviewLedgerName(transaction: PreviewTransaction) {
  const counterpartyName = String(transaction.counterpartyName ?? "").trim();
  if (counterpartyName) return counterpartyName;

  const text = `${transaction.category ?? ""} ${transaction.transactionType ?? ""} ${transaction.description ?? ""}`.toLowerCase();
  if (/\bbank[_\s-]*charges\b|\bcharge|charges|fee\b/.test(text)) return "Bank Charges";
  if (/\binterest\b/.test(text)) return "Interest Income";
  if (/\batm\b|\bcash\b/.test(text)) return "Cash";

  return "";
}

function standardLedgerNameForTransaction(
  transaction: Pick<PreviewTransaction, "category" | "transactionType" | "description">
) {
  const text = `${transaction.category ?? ""} ${transaction.transactionType ?? ""} ${transaction.description ?? ""}`.toLowerCase();
  if (/\bbank[_\s-]*charges\b|\bcharge|charges|fee\b/.test(text)) return "Bank Charges";
  if (/\binterest\b/.test(text)) return "Interest Income";
  if (/\batm\b|\bcash\b/.test(text)) return "Cash";
  return "";
}

function normalizeReviewTransaction(transaction: PreviewTransaction, ledgerMasters: TallyMaster[]): ReviewTransaction {
  const recommendation = readRecommendation(transaction);
  const suggestedLedgerName = transaction.suggestedLedgerName || "";
  const action = recommendation?.action ?? "needs_review";
  const recommendationUnavailable =
    recommendation?.status === "unavailable" || recommendation?.status === "deferred";
  const aiVetoesDerivedAutoMatch = Boolean(
    recommendation && (action === "use_suspense" || action === "needs_review")
  );
  const aiCandidateLedgerNames = Array.isArray(recommendation?.candidateLedgerNames)
    ? recommendation.candidateLedgerNames
        .map((ledgerName) => String(ledgerName ?? "").trim())
        .filter(Boolean)
    : [];
  const isAiCloseMatch = recommendation?.matchType === "close_match" || aiCandidateLedgerNames.length > 0;
  const recommendedLedgerName = recommendation?.ledgerName || suggestedLedgerName || fallbackReviewLedgerName(transaction);
  const suspenseLedger = findCompanySuspenseLedger(ledgerMasters);
  const suspenseName = suspenseLedger?.name || "Suspense";
  const confirmedLedger = findLedgerByNormalizedName(ledgerMasters, transaction.confirmedLedgerName);
  const confirmedSuspenseLedger = confirmedLedger && isSuspenseLedgerName(confirmedLedger.name) ? confirmedLedger : null;
  const confirmedMappedLedger = confirmedLedger && !isSuspenseLedgerName(confirmedLedger.name) ? confirmedLedger : null;
  const ledgerCandidates = ledgerNameCandidateVariants(
    recommendedLedgerName,
    transaction.counterpartyName,
    transaction.description
  );
  const standardLedger = aiVetoesDerivedAutoMatch
    ? null
    : findLedgerByNormalizedName(ledgerMasters, standardLedgerNameForTransaction(transaction));
  const matchedLedger = aiVetoesDerivedAutoMatch
    ? null
    : findLedgerByCandidates(ledgerMasters, ledgerCandidates);
  const candidateLedgerNames = isAiCloseMatch ? aiCandidateLedgerNames : [];
  const hasCloseMatchCandidates = candidateLedgerNames.length >= 1;
  const reviewSuggestedLedgerName = hasCloseMatchCandidates ? "" : recommendedLedgerName;
  const selectedLedgerName = confirmedMappedLedger?.name ||
    standardLedger?.name ||
    matchedLedger?.name ||
    confirmedSuspenseLedger?.name ||
    (recommendationUnavailable ? "" : suspenseName);
  const ledgerAction: LedgerRecommendationAction = confirmedMappedLedger
    ? "use_existing_ledger"
    : standardLedger
    ? "use_standard_ledger"
    : matchedLedger
    ? action === "use_standard_ledger"
      ? "use_standard_ledger"
      : "use_existing_ledger"
    : recommendationUnavailable
      ? "needs_review"
      : "use_suspense";

  return {
    id: transaction.id || crypto.randomUUID(),
    transactionDate: transaction.transactionDate || "",
    valueDate: transaction.valueDate || transaction.transactionDate || "",
    description: transaction.description || "",
    referenceNumber: transaction.referenceNumber || "",
    debitAmount:
      transaction.debitAmount === null || transaction.debitAmount === undefined
        ? ""
        : String(transaction.debitAmount),
    creditAmount:
      transaction.creditAmount === null || transaction.creditAmount === undefined
        ? ""
        : String(transaction.creditAmount),
    balanceAmount:
      transaction.balanceAmount === null || transaction.balanceAmount === undefined
        ? ""
        : String(transaction.balanceAmount),
    transactionType: transaction.transactionType || "unknown",
    category: transaction.category || "unknown",
    counterpartyName: transaction.counterpartyName || "",
    suggestedLedgerName: reviewSuggestedLedgerName,
    suggestionConfidence: recommendation?.confidence ?? transaction.suggestionConfidence ?? null,
    suggestionReason: hasCloseMatchCandidates
        ? `Close Tally ledger matches found: ${candidateLedgerNames.join(", ")}.`
      : ledgerAction === "needs_review"
        ? recommendation?.reason || transaction.suggestionReason || "Ledger matching needs review."
      : ledgerAction === "use_suspense" && !matchedLedger
        ? "No matching Tally ledger was found. This row will go to Suspense unless changed."
        : recommendation?.reason || transaction.suggestionReason || "",
    candidateLedgerNames,
    selectedLedgerName,
    ledgerAction,
    ledgerGroup: recommendation?.ledgerGroup || "",
    requiresUserConfirmation: hasCloseMatchCandidates,
    ledgerSelectionTouched: false,
  };
}

function autoMatchUntouchedLedgerSelection(transaction: ReviewTransaction, ledgerMasters: TallyMaster[]) {
  if (transaction.ledgerSelectionTouched) return transaction;
  if (transaction.ledgerAction === "use_suspense" || transaction.ledgerAction === "needs_review") {
    return transaction;
  }

  const currentLedger = findLedgerByNormalizedName(ledgerMasters, transaction.selectedLedgerName);
  if (
    currentLedger &&
    !isSuspenseLedgerName(currentLedger.name) &&
    (transaction.ledgerAction === "use_existing_ledger" || transaction.ledgerAction === "use_standard_ledger")
  ) {
    return transaction;
  }

  const standardLedger = findLedgerByNormalizedName(ledgerMasters, standardLedgerNameForTransaction(transaction));
  const matchedLedger =
    standardLedger ||
    findLedgerByNormalizedName(ledgerMasters, transaction.suggestedLedgerName) ||
    findLedgerByNormalizedName(ledgerMasters, transaction.counterpartyName) ||
    findLedgerByNormalizedName(ledgerMasters, fallbackReviewLedgerName(transaction)) ||
    findLedgerByCandidates(
      ledgerMasters,
      ledgerNameCandidateVariants(transaction.suggestedLedgerName, transaction.counterpartyName, transaction.description)
    );

  if (!matchedLedger || isSuspenseLedgerName(matchedLedger.name)) return transaction;

  return {
    ...transaction,
    selectedLedgerName: matchedLedger.name,
    suggestedLedgerName: matchedLedger.name,
    ledgerAction: standardLedger ? "use_standard_ledger" as const : "use_existing_ledger" as const,
    ledgerGroup: matchedLedger.parent || transaction.ledgerGroup,
    suggestionReason: transaction.suggestionReason || "Matched by synced Tally ledger name.",
    requiresUserConfirmation: false,
  };
}

function parseNumber(value: unknown) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function transactionHasPostingAmount(transaction: ReviewTransaction) {
  return Math.max(parseNumber(transaction.debitAmount) ?? 0, parseNumber(transaction.creditAmount) ?? 0) > 0;
}

function hasValidTransactionDate(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const date = new Date(`${trimmed}T00:00:00`);
  return !Number.isNaN(date.getTime());
}

function getEffectiveTransactionDate(transaction: {
  transactionDate: string;
  valueDate?: string | null;
}) {
  return hasValidTransactionDate(transaction.valueDate)
    ? String(transaction.valueDate)
    : transaction.transactionDate;
}

function getEffectiveTransactionDateLabel(transaction: {
  transactionDate: string;
  valueDate?: string | null;
}) {
  return hasValidTransactionDate(transaction.valueDate) ? "Value Date" : "Transaction Date";
}

function transactionIsValid(transaction: ReviewTransaction) {
  return Boolean(
    hasValidTransactionDate(getEffectiveTransactionDate(transaction)) &&
    transaction.description.trim() &&
    transactionHasPostingAmount(transaction)
  );
}

const bankAmountFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const bankCurrencyInputFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const bankShortDateFormatter = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatAmount(value: string | number | null | undefined) {
  const parsed = parseNumber(value) ?? 0;
  if (!Number.isFinite(parsed) || parsed === 0) return "";
  return bankAmountFormatter.format(parsed);
}

function formatCurrencyAmount(value: string | number | null | undefined) {
  const formatted = formatAmount(value);
  return formatted ? `Rs. ${formatted}` : "Rs. 0";
}

function formatCurrencyInputAmount(value: string | number | null | undefined) {
  const parsed = parseNumber(value) ?? 0;
  if (!Number.isFinite(parsed) || parsed === 0) return "";
  return bankCurrencyInputFormatter.format(parsed);
}

function formatDataLabel(value?: string | null) {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getTransactionDirection(transaction: ReviewTransaction) {
  if ((parseNumber(transaction.creditAmount) ?? 0) > 0) return "Credit";
  if ((parseNumber(transaction.debitAmount) ?? 0) > 0) return "Debit";
  return "";
}

function isIncomingReceiptRow(transaction: ReviewTransaction) {
  return (parseNumber(transaction.creditAmount) ?? 0) > 0 && (parseNumber(transaction.debitAmount) ?? 0) <= 0;
}

function isOutgoingPaymentRow(transaction: ReviewTransaction) {
  return (parseNumber(transaction.debitAmount) ?? 0) > 0 && (parseNumber(transaction.creditAmount) ?? 0) <= 0;
}

function getTransactionMode(transaction: ReviewTransaction) {
  const text = `${transaction.transactionType} ${transaction.category} ${transaction.description}`.toLowerCase();
  if (/\bneft\b/.test(text)) return "NEFT";
  if (/\brtgs\b/.test(text)) return "RTGS";
  if (/\bimps\b/.test(text)) return "IMPS";
  if (/\bupi\b|vpa|bharatpe|gpay|googlepay|phonepe|paytm/.test(text)) return "UPI";
  if (/\batm\b/.test(text)) return "ATM";
  if (/\bpos\b|purchase/.test(text)) return "POS";
  if (/\bcheque|chq\b/.test(text)) return "Cheque";
  if (/\bcharge|charges|fee\b/.test(text)) return "Bank charge";
  if (/\binterest\b/.test(text)) return "Interest";
  if (/\bcash\b/.test(text)) return "Cash";
  return transaction.category && transaction.category !== "unknown"
    ? formatDataLabel(transaction.category)
    : "";
}

function getTransactionReference(transaction: ReviewTransaction) {
  const reference = transaction.referenceNumber.trim();
  if (!reference) return "";
  const normalizedReference = normalizeName(reference);
  if (["debit", "credit", "dr", "cr"].includes(normalizedReference)) return "";
  if (normalizedReference === normalizeName(transaction.transactionType)) return "";
  return reference;
}

function getTransactionPartyTitle(transaction: ReviewTransaction) {
  if (transaction.counterpartyName.trim()) return transaction.counterpartyName.trim();

  const mode = getTransactionMode(transaction);
  if (mode === "ATM") return "ATM cash withdrawal";
  if (mode === "Bank charge") return "Bank charges";
  if (mode === "Interest") return "Interest credit";
  const matchedLedgerName = [transaction.selectedLedgerName, transaction.suggestedLedgerName]
    .map((value) => value.trim())
    .find((value) => value && !isSuspenseLedgerName(value));
  if (matchedLedgerName) return matchedLedgerName;
  if (transaction.description.trim()) return transaction.description.trim();
  if (transaction.category && transaction.category !== "unknown") {
    return formatDataLabel(transaction.category);
  }

  return transaction.description || "Unknown transaction";
}

function normalizeBankAccountNumber(value?: string | null) {
  return String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function getTallyBankLedgerAccountNumber(ledger: TallyMaster) {
  const explicitAccountNumber = normalizeBankAccountNumber(ledger.bankAccountNumber);
  if (explicitAccountNumber) return explicitAccountNumber;

  // Some Tally ledgers carry the account identity only in their name, e.g.
  // "Kotak Mahindra Bank - 6713098600". A single full numeric token is
  // deterministic identity data, not a fuzzy/AI match.
  const accountNumbersInName = Array.from(
    new Set((ledger.name.match(/\d{6,18}/g) ?? []).map(normalizeBankAccountNumber).filter(Boolean))
  );
  return accountNumbersInName.length === 1 ? accountNumbersInName[0] : "";
}

function isBankLedgerMaster(ledger: TallyMaster) {
  const parent = String(ledger.parent ?? "").toLowerCase();
  const bankName = String(ledger.bankName ?? "").trim();
  const accountNumber = String(ledger.bankAccountNumber ?? "").trim();

  if (/\bbank\s+accounts?\b/.test(parent)) return true;
  if (bankName || accountNumber) return true;
  return false;
}

function getCommonLedgerOptions(ledgerMasters: TallyMaster[]) {
  const commonNames = [
    "Cash",
    "Bank Charges",
    "Bank Charges GST",
    "Interest Income",
    "Interest Received",
    "Duties & Taxes",
    "Office Supplies",
    "Office Expenses",
    "Transport Vendor",
  ];

  const names = new Set<string>();
  for (const commonName of commonNames) {
    const matched = findLedgerByNormalizedName(ledgerMasters, commonName);
    if (matched) names.add(matched.name);
  }

  return Array.from(names).filter(Boolean);
}

function optionKey(option: LedgerSelection) {
  return `${option.action}:${normalizeName(option.name)}:${normalizeName(option.ledgerGroup)}`;
}

function uniqueLedgerOptions(options: LedgerPickerOption[]) {
  const seen = new Set<string>();
  const uniqueOptions: LedgerPickerOption[] = [];

  for (const option of options) {
    const key = optionKey(option);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueOptions.push(option);
  }

  return uniqueOptions;
}

function buildLedgerPickerGroups(transaction: ReviewTransaction, ledgerMasters: TallyMaster[]): LedgerPickerGroup[] {
  const suspenseLedger = findCompanySuspenseLedger(ledgerMasters);
  const suspenseName = suspenseLedger?.name || "Suspense";
  const currentLedger = findLedgerByNormalizedName(ledgerMasters, transaction.selectedLedgerName);
  const suggestedLedger = findLedgerByNormalizedName(ledgerMasters, transaction.suggestedLedgerName);
  const candidateLedgers = (transaction.candidateLedgerNames ?? [])
    .map((ledgerName) => findLedgerByNormalizedName(ledgerMasters, ledgerName))
    .filter((ledger): ledger is TallyMaster => Boolean(ledger));
  const commonLedgers = getCommonLedgerOptions(ledgerMasters);
  const groups: LedgerPickerGroup[] = [];
  const usedKeys = new Set<string>();

  function makeOption(input: Omit<LedgerPickerOption, "key">): LedgerPickerOption {
    return { ...input, key: optionKey(input) };
  }

  function addGroup(label: string, options: Array<Omit<LedgerPickerOption, "key">>) {
    const nextOptions = uniqueLedgerOptions(options.map(makeOption)).filter((option) => {
      if (!option.name.trim()) return false;
      if (usedKeys.has(option.key)) return false;
      usedKeys.add(option.key);
      return true;
    });

    if (nextOptions.length > 0) groups.push({ label, options: nextOptions });
  }

  if (transaction.ledgerAction === "use_existing_ledger" && transaction.selectedLedgerName) {
    addGroup("Current match", [
      {
        name: currentLedger?.name || transaction.selectedLedgerName,
        action: "use_existing_ledger",
        label: currentLedger?.name || transaction.selectedLedgerName,
        helper: "Use the existing Tally ledger.",
        badge: "Matched",
        ...ledgerBalanceFields(currentLedger),
      },
    ]);
  } else if (transaction.ledgerAction === "use_standard_ledger" && transaction.selectedLedgerName) {
    addGroup("Current match", [
      {
        name: currentLedger?.name || transaction.selectedLedgerName,
        action: "use_standard_ledger",
        label: currentLedger?.name || transaction.selectedLedgerName,
        helper: "Standard ledger chosen from transaction type.",
        badge: "Standard",
        ...ledgerBalanceFields(currentLedger),
      },
    ]);
  } else if (transaction.ledgerAction === "use_suspense") {
    addGroup("Current selection", [
      {
        name: suspenseName,
        action: "use_suspense",
        label: "Put in Suspense",
        helper: "Use when the correct ledger is unclear.",
        badge: "Fallback",
        ...ledgerBalanceFields(suspenseLedger),
      },
    ]);
  }

  if (transaction.ledgerAction === "needs_review" || candidateLedgers.length > 0) {
    addGroup("Suggested matches", [
      ...(suggestedLedger
        ? [
            {
              name: suggestedLedger.name,
              action: "use_existing_ledger" as const,
              label: suggestedLedger.name,
              helper: transaction.requiresUserConfirmation
                ? "Possible Tally ledger match. Review before using."
                : "Matched by extracted counterparty name.",
              badge: "Suggested",
              ...ledgerBalanceFields(suggestedLedger),
            },
          ]
        : []),
      ...candidateLedgers.map((ledger) => ({
        name: ledger.name,
        action: "use_existing_ledger" as const,
        label: ledger.name,
        helper: ledger.parent ? `Group: ${ledger.parent}` : "AI-suggested possible match.",
        badge: "Suggested",
        ...ledgerBalanceFields(ledger),
      })),
    ]);
  }

  // Keep the safe recovery action next to AI suggestions. With hundreds of
  // ledgers, placing it after the complete ledger list makes it too easy to
  // lose after an accidental close-match selection.
  addGroup("Safe fallback", [
    {
      name: suspenseName,
      action: "use_suspense",
      label: "Put in Suspense",
      helper: "Use when the correct ledger is unclear.",
      badge: "Fallback",
      ...ledgerBalanceFields(suspenseLedger),
    },
  ]);

  addGroup(
    "Common ledgers",
    commonLedgers.map((name) => ({
      name,
      action: name === currentLedger?.name && transaction.ledgerAction === "use_standard_ledger"
        ? "use_standard_ledger"
        : "use_existing_ledger",
      label: name,
      helper: "Commonly used Tally ledger.",
      ...ledgerBalanceFields(findLedgerByNormalizedName(ledgerMasters, name)),
    }))
  );

  addGroup(
    "Search Tally ledgers",
    ledgerMasters.map((ledger) => ({
      name: ledger.name,
      action: "use_existing_ledger",
      label: ledger.name,
      helper: ledger.parent ? `Group: ${ledger.parent}` : "Existing Tally ledger.",
      ...ledgerBalanceFields(ledger),
    }))
  );

  return groups;
}

type LedgerSearchGroup = {
  label: string;
  options: Array<{
    name: string;
    helper?: string;
    closingBalance?: number | null;
    closingBalanceType?: "Dr" | "Cr" | null;
  }>;
};

const MAX_BANK_LEDGER_MENU_OPTIONS = 60;

function LedgerSearchSelect({
  value,
  groups,
  placeholder,
  onChange,
  onCommit,
}: {
  value: string;
  groups: LedgerSearchGroup[];
  placeholder: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hasSearchStarted, setHasSearchStarted] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const uniqueGroups = useMemo(() => {
    const seen = new Set<string>();
    return groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => {
          const key = normalizeName(option.name);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      }))
      .filter((group) => group.options.length > 0);
  }, [groups]);
  const optionMetadataByName = useMemo(() => {
    const metadata = new Map<string, { balance: string | null; searchText: string }>();
    uniqueGroups.forEach((group) => {
      group.options.forEach((option) => {
        const balance = formatLedgerClosingBalance(option.closingBalance, option.closingBalanceType);
        metadata.set(normalizeName(option.name), {
          balance,
          searchText: normalizeName(`${option.name} ${option.helper ?? ""} ${balance ?? ""} ${group.label}`),
        });
      });
    });
    return metadata;
  }, [uniqueGroups]);
  const filteredGroups = useMemo(() => {
    const normalizedQuery = hasSearchStarted ? normalizeName(query) : "";
    if (!normalizedQuery) return uniqueGroups;
    return uniqueGroups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) =>
          optionMetadataByName.get(normalizeName(option.name))?.searchText.includes(normalizedQuery)
        ),
      }))
      .filter((group) => group.options.length > 0);
  }, [hasSearchStarted, optionMetadataByName, query, uniqueGroups]);
  const visibleOptions = useMemo(
    () => filteredGroups.flatMap((group) => group.options),
    [filteredGroups]
  );
  const renderedGroups = useMemo(() => {
    let remaining = MAX_BANK_LEDGER_MENU_OPTIONS;
    return filteredGroups
      .map((group) => {
        if (remaining <= 0) return { ...group, options: [] };
        const options = group.options.slice(0, remaining);
        remaining -= options.length;
        return { ...group, options };
      })
      .filter((group) => group.options.length > 0);
  }, [filteredGroups]);
  const menuOptions = useMemo(
    () => renderedGroups.flatMap((group) => group.options),
    [renderedGroups]
  );
  const menuOptionIndexByName = useMemo(
    () => new Map(menuOptions.map((option, index) => [normalizeName(option.name), index])),
    [menuOptions]
  );

  function chooseLedger(name: string, commit = false) {
    if (commit && onCommit) onCommit(name);
    else onChange(name);
    setQuery("");
    setHasSearchStarted(false);
    setOpen(false);
    setActiveOptionIndex(0);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const activeOption = menuRef.current?.querySelector<HTMLElement>(
      `[data-ledger-option-index="${activeOptionIndex}"]`
    );
    activeOption?.scrollIntoView({ block: "nearest" });
  }, [activeOptionIndex, open]);

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9a8d7f]" />
        <input
          aria-activedescendant={open && menuOptions[activeOptionIndex] ? `bank-ledger-option-${activeOptionIndex}` : undefined}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-haspopup="listbox"
          autoFocus
          className="h-8 w-full rounded-md border border-[#d8cbbb] bg-white px-2.5 pl-8 text-[11px] font-semibold text-[#2b241d] outline-none transition placeholder:text-[#9a8d7f] focus:border-[#7c5f3f] focus:ring-2 focus:ring-[#7c5f3f]/10"
          onBlur={() =>
            window.setTimeout(() => {
              setOpen(false);
              setQuery("");
              setHasSearchStarted(false);
            }, 120)
          }
          onChange={(event) => {
            setQuery(event.target.value);
            setHasSearchStarted(true);
            setOpen(true);
            setActiveOptionIndex(0);
          }}
          onFocus={(event) => {
            setOpen(true);
            setActiveOptionIndex(menuOptionIndexByName.get(normalizeName(value)) ?? 0);
            event.currentTarget.select();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              setQuery("");
              setHasSearchStarted(false);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActiveOptionIndex((current) => {
                if (menuOptions.length === 0) return 0;
                return (current + direction + menuOptions.length) % menuOptions.length;
              });
              return;
            }
            if (event.key === "Enter" && open && menuOptions[activeOptionIndex]) {
              event.preventDefault();
              chooseLedger(menuOptions[activeOptionIndex].name, true);
            }
          }}
          placeholder={placeholder}
          value={hasSearchStarted ? query : value}
        />
      </div>

      {open ? (
        <div
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-[#d8cbbb] bg-white p-1 shadow-xl"
          ref={menuRef}
          role="listbox"
        >
          {filteredGroups.length > 0 ? (
            renderedGroups.map((group) => (
              <div className="mb-1 last:mb-0" key={group.label}>
                <div className="px-2.5 pb-0.5 pt-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-[#9a8d7f]">
                  {group.label}
                </div>
                {group.options.map((option) => {
                  const optionIndex = menuOptionIndexByName.get(normalizeName(option.name)) ?? -1;
                  const keyboardActive = optionIndex === activeOptionIndex;
                  const closingBalance = optionMetadataByName.get(normalizeName(option.name))?.balance;
                  return (
                    <button
                      aria-selected={option.name === value}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] font-bold leading-[14px] transition hover:bg-[#fbf4ea] ${
                        option.name === value || keyboardActive
                          ? "bg-[#f6efe6] text-[#4b3828]"
                          : "text-[#2b241d]"
                      }`}
                      data-ledger-option-index={optionIndex}
                      id={`bank-ledger-option-${optionIndex}`}
                      key={option.name}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        chooseLedger(option.name);
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{option.name}</span>
                        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9px] font-semibold leading-[12px] text-[#8a7f72]">
                          {option.helper ? <span className="truncate">{option.helper}</span> : null}
                          {closingBalance ? (
                            <span className="whitespace-nowrap font-bold text-[#6f4e2f]">
                              {closingBalance}
                            </span>
                          ) : (
                            <span className="whitespace-nowrap text-slate-400">Closing balance unavailable</span>
                          )}
                        </span>
                      </span>
                      {option.name === value ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-700" /> : null}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="px-2.5 py-3 text-[10px] font-semibold text-[#8a7f72]">
              No matching ledger found.
            </div>
          )}
          {visibleOptions.length > menuOptions.length ? (
            <div className="sticky bottom-0 border-t border-[#eee7dc] bg-[#fffdf9] px-2.5 py-1.5 text-[9px] font-bold text-[#7a6c5f]">
              Type to search {visibleOptions.length - menuOptions.length} more ledgers
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function getLedgerPickerDisplayValue(transaction: ReviewTransaction) {
  if (transaction.ledgerAction === "use_suspense") return "Put in Suspense";
  if (transaction.ledgerAction === "use_standard_ledger" && transaction.selectedLedgerName) {
    return `Standard: ${transaction.selectedLedgerName}`;
  }
  if (transaction.ledgerAction === "use_existing_ledger" && transaction.selectedLedgerName) {
    return `Use existing: ${transaction.selectedLedgerName}`;
  }
  return transaction.selectedLedgerName;
}

function isSuspenseLedgerName(value: string) {
  return normalizeName(value).includes("suspense");
}

const MAX_INITIAL_LEDGER_MENU_OPTIONS = 60;

function LedgerReviewSelect({
  transaction,
  ledgerMasters,
  onCancel,
  onChange,
}: {
  transaction: ReviewTransaction;
  ledgerMasters: TallyMaster[];
  onCancel: () => void;
  onChange: (selection: LedgerSelection) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const [popoverPosition, setPopoverPosition] = useState<{
    bottom?: number;
    left: number;
    maxHeight: number;
    top?: number;
    width: number;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [hasSearchStarted, setHasSearchStarted] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const groups = useMemo(
    () => buildLedgerPickerGroups(transaction, ledgerMasters),
    [ledgerMasters, transaction]
  );
  const normalizedQuery = normalizeName(query);
  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return groups;

    return groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => {
          const searchable = `${group.label} ${option.label} ${option.name} ${option.helper ?? ""} ${option.badge ?? ""} ${formatLedgerClosingBalance(option.closingBalance, option.closingBalanceType) ?? ""}`;
          return (
            normalizeName(searchable).includes(normalizedQuery) ||
            ledgerNameSimilarity(query, option.name) >= 0.78
          );
        }),
      }))
      .filter((group) => group.options.length > 0);
  }, [groups, normalizedQuery, query]);
  const visibleOptions = useMemo(
    () => filteredGroups.flatMap((group) => group.options),
    [filteredGroups]
  );
  const renderedGroups = useMemo(() => {
    let remaining = MAX_INITIAL_LEDGER_MENU_OPTIONS;
    return filteredGroups
      .map((group) => {
        if (remaining <= 0) return { ...group, options: [] };
        const options = group.options.slice(0, remaining);
        remaining -= options.length;
        return { ...group, options };
      })
      .filter((group) => group.options.length > 0);
  }, [filteredGroups]);
  const menuOptions = useMemo(
    () => renderedGroups.flatMap((group) => group.options),
    [renderedGroups]
  );
  const menuOptionIndexByKey = useMemo(
    () => new Map(menuOptions.map((option, index) => [option.key, index])),
    [menuOptions]
  );
  const displayValue = hasSearchStarted
    ? query
    : transaction.selectedLedgerName || getLedgerPickerDisplayValue(transaction);

  function selectOption(option: LedgerSelection) {
    onChange(option);
    setQuery("");
    setHasSearchStarted(false);
    setOpen(false);
  }

  function openMenu() {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const gutter = 16;
      const width = Math.min(440, window.innerWidth - gutter * 2);
      const left = Math.min(
        Math.max(gutter, rect.right - width),
        Math.max(gutter, window.innerWidth - width - gutter)
      );
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const shouldOpenAbove = spaceBelow < 330 && spaceAbove > spaceBelow;
      const availableHeight = Math.max(220, shouldOpenAbove ? spaceAbove - gutter * 2 : spaceBelow - gutter * 2);
      setPopoverPosition({
        bottom: shouldOpenAbove ? window.innerHeight - rect.top + 8 : undefined,
        left,
        maxHeight: Math.min(390, availableHeight),
        top: shouldOpenAbove ? undefined : rect.bottom + 8,
        width,
      });
    }
    setActiveOptionIndex(0);
    setOpen(true);
  }

  useLayoutEffect(() => {
    const input = inputRef.current;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const gutter = 16;
      const width = Math.min(440, window.innerWidth - gutter * 2);
      const left = Math.min(
        Math.max(gutter, rect.right - width),
        Math.max(gutter, window.innerWidth - width - gutter)
      );
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const shouldOpenAbove = spaceBelow < 330 && spaceAbove > spaceBelow;
      const availableHeight = Math.max(220, shouldOpenAbove ? spaceAbove - gutter * 2 : spaceBelow - gutter * 2);
      setPopoverPosition({
        bottom: shouldOpenAbove ? window.innerHeight - rect.top + 8 : undefined,
        left,
        maxHeight: Math.min(390, availableHeight),
        top: shouldOpenAbove ? undefined : rect.bottom + 8,
        width,
      });
    }
    input?.focus();
    input?.select();
  }, []);

  useEffect(() => {
    if (!open) return;

    function handleOutsidePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest("[data-ledger-editor-toggle]")) return;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;

      setOpen(false);
      onCancel();
    }

    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
  }, [onCancel, open]);

  const popover = open && popoverPosition ? (
    <div
      className="fixed z-[1000] overflow-auto rounded-xl border border-[#d8cbbb] bg-white p-1 shadow-2xl"
      ref={popoverRef}
      style={{
        bottom: popoverPosition.bottom,
        left: popoverPosition.left,
        maxHeight: popoverPosition.maxHeight,
        top: popoverPosition.top,
        width: popoverPosition.width,
      }}
    >
      {filteredGroups.length > 0 ? (
        renderedGroups.map((group) => (
          <div className="mb-0.5 last:mb-0" key={group.label}>
            <div className="px-2.5 pb-0.5 pt-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-[#9a8d7f]">
              {group.label}
            </div>
            {group.options.map((option) => {
              const selected =
                normalizeName(option.name) === normalizeName(transaction.selectedLedgerName) &&
                option.action === transaction.ledgerAction;
              const optionIndex = menuOptionIndexByKey.get(option.key) ?? -1;
              const keyboardActive = optionIndex === activeOptionIndex;
              return (
                <button
                  className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[11px] font-semibold leading-4 transition hover:bg-[#fbf4ea] ${
                    selected || keyboardActive ? "bg-[#f6efe6] text-[#4b3828]" : "text-[#2b241d]"
                  }`}
                  key={option.key}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectOption(option);
                  }}
                  type="button"
                >
                  <span className="min-w-0">
                    <span className="block whitespace-normal break-words">{option.label}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9px] font-medium leading-[13px] text-[#8a7f72]">
                      {option.helper ? <span className="whitespace-normal break-words">{option.helper}</span> : null}
                      {formatLedgerClosingBalance(option.closingBalance, option.closingBalanceType) ? (
                        <span className="whitespace-nowrap font-bold text-[#6f4e2f]">
                          {formatLedgerClosingBalance(option.closingBalance, option.closingBalanceType)}
                        </span>
                      ) : (
                        <span className="whitespace-nowrap text-slate-400">Closing balance unavailable</span>
                      )}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {option.badge ? (
                      <Badge className="h-5 border-[#d8cbbb] bg-white px-2 py-0 text-[8px] font-bold text-[#6f4e2f]" variant="outline">
                        {option.badge}
                      </Badge>
                    ) : null}
                    {selected ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
          ))
      ) : ledgerMasters.length === 0 ? (
        <div className="px-2.5 py-3 text-[10px] font-semibold text-[#8a7f72]">
          Tally ledgers are not loaded. Use Sync above, then search again.
        </div>
      ) : (
        <div className="px-2.5 py-3 text-[10px] font-semibold text-[#8a7f72]">
          No matching ledger found.
        </div>
      )}
      {visibleOptions.length > menuOptions.length ? (
        <div className="sticky bottom-0 border-t border-[#eee7dc] bg-[#fffdf9] px-2.5 py-1.5 text-[9px] font-bold text-[#7a6c5f]">
          Type to search {visibleOptions.length - menuOptions.length} more ledgers
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="relative" ref={rootRef}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9a8d7f]" />
        <input
          className="h-8 w-full rounded-md border border-[#d8cbbb] bg-white px-2.5 pl-8 text-[11px] font-medium text-[#2b241d] outline-none transition placeholder:text-[#9a8d7f] focus:border-[#7c5f3f] focus:ring-2 focus:ring-[#7c5f3f]/10"
          onBlur={() => {
            window.setTimeout(() => {
              const focusedElement = document.activeElement;
              if (
                focusedElement instanceof Node &&
                !rootRef.current?.contains(focusedElement) &&
                !popoverRef.current?.contains(focusedElement)
              ) {
                setOpen(false);
                onCancel();
              }
            }, 0);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setHasSearchStarted(true);
            setActiveOptionIndex(0);
            openMenu();
          }}
          onFocus={(event) => {
            setOpen(true);
            event.currentTarget.select();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              onCancel();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) openMenu();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActiveOptionIndex((current) => {
                if (menuOptions.length === 0) return 0;
                return (current + direction + menuOptions.length) % menuOptions.length;
              });
              return;
            }
            if (event.key === "Enter" && open && menuOptions[activeOptionIndex]) {
              event.preventDefault();
              selectOption(menuOptions[activeOptionIndex]);
            }
          }}
          placeholder="Search or choose action"
          ref={inputRef}
          value={displayValue}
        />
      </div>

      {popover ? createPortal(popover, document.body) : null}
    </div>
  );
}

function CurrencyAmountInput({
  max,
  min = 0,
  onChange,
  value,
}: {
  max?: number;
  min?: number;
  onChange: (value: string) => void;
  value: number;
}) {
  const [focused, setFocused] = useState(false);
  const [draftValue, setDraftValue] = useState(formatCurrencyInputAmount(value));

  useEffect(() => {
    if (!focused) {
      setDraftValue(formatCurrencyInputAmount(value));
    }
  }, [focused, value]);

  return (
    <div className="inline-flex h-8.5 w-36 items-center rounded-xl border border-[#e5ddd0] bg-white px-3 focus-within:border-amber-500">
      <span className="mr-1.5 text-xs font-bold text-slate-400">Rs.</span>
      <input
        className="min-w-0 flex-1 bg-transparent text-right text-xs font-bold text-[#1a1a1a] outline-none"
        inputMode="decimal"
        max={max}
        min={min}
        onBlur={() => {
          setFocused(false);
          setDraftValue(formatCurrencyInputAmount(value));
        }}
        onChange={(event) => {
          setDraftValue(event.target.value);
          onChange(event.target.value);
        }}
        onFocus={() => {
          setFocused(true);
          setDraftValue(value > 0 ? value.toFixed(2) : "");
        }}
        step="0.01"
        type="text"
        value={draftValue}
      />
    </div>
  );
}

function getReviewStatus(transaction: ReviewTransaction): ReviewStatusFilter {
  if (
    transaction.requiresUserConfirmation ||
    (transaction.ledgerAction === "needs_review" && transaction.candidateLedgerNames.length > 0)
  ) {
    return "needs_review";
  }
  if (transaction.ledgerAction === "use_suspense" || isSuspenseLedgerName(transaction.selectedLedgerName)) {
    return "suspense";
  }
  if (
    transaction.selectedLedgerName.trim() &&
    (transaction.ledgerAction === "use_existing_ledger" || transaction.ledgerAction === "use_standard_ledger")
  ) {
    return "matched";
  }
  return "suspense";
}

function getReviewStatusLabel(transaction: ReviewTransaction) {
  const status = getReviewStatus(transaction);
  if (status === "matched") return "Ledger matched";
  if (status === "suspense") return "In Suspense";
  return "Close match";
}

function getLedgerReviewFilterValue(transaction: ReviewTransaction): Exclude<ReviewLedgerFilter, "all"> {
  const status = getReviewStatus(transaction);
  if (status === "needs_review") return "needs_action";
  if (status === "suspense") return "suspense";
  return transaction.ledgerSelectionTouched ? "manual" : "automatic";
}

function getTallyResultFilterValue(
  draft?: OutgoingVerificationDraft | null
): Exclude<ReviewTallyResultFilter, "all"> {
  if (!draft || draft.status === "not_checked" || draft.status === "checking") return "pending";
  if (draft.duplicateInTally || draft.status === "ambiguous") return "review";
  if (draft.status === "found") return "found";
  if (draft.status === "missing") return "missing";
  return "failed";
}

function getReceiptAllocationFilterValue(
  transaction: ReviewTransaction,
  ledgerMasters: TallyMaster[],
  draft?: BillAllocationDraft | null
): Exclude<ReviewAllocationFilter, "all"> {
  if (!isIncomingReceiptRow(transaction) || !isBillMatchEligibleTransaction(transaction, ledgerMasters)) {
    return "not_applicable";
  }
  if (draft?.status === "posted") return "completed";
  if (draft?.status === "ready_to_post") return "ready";
  return "needs_action";
}

function getBillAllocationLabel(draft?: BillAllocationDraft | null) {
  if (!draft) return "Not Checked";
  if (draft.status === "not_applicable") return "Not Applicable";
  if (draft.status === "cannot_match_yet") return "Cannot Match Yet";
  if (draft.status === "ready_to_post") {
    const billCount = draft.allocations.filter((line) => line.referenceType === "Agst Ref").length;
    if (billCount === 0) return "Post As Advance";
    if (draft.newAdvanceAmount > 0) return `${billCount} Bill${billCount === 1 ? "" : "s"} + Advance`;
    return `${billCount} Bill${billCount === 1 ? "" : "s"} Matched`;
  }
  if (draft.status === "needs_review") return "Review Required";
  if (draft.status === "stale_data") return "Re-match Required";
  if (draft.status === "posted") return "Posted";
  if (draft.status === "post_failed") return "Posting Failed";
  return "Not Checked";
}

function getBillAllocationSubtext(
  draft?: BillAllocationDraft | null,
  transaction?: ReviewTransaction,
  ledgerMasters: TallyMaster[] = []
) {
  if (!draft) {
    if (
      transaction &&
      isIncomingReceiptRow(transaction) &&
      transaction.selectedLedgerName.trim() &&
      !isBillMatchEligibleTransaction(transaction, ledgerMasters)
    ) {
      return isSuspenseLedgerName(transaction.selectedLedgerName)
        ? "Will post to Suspense · Bill matching not applicable"
        : "Bill matching not applicable";
    }
    return "";
  }
  if (draft.status === "ready_to_post") {
    const billLines = draft.allocations.filter((line) => line.referenceType === "Agst Ref");
    const billAmount = billLines.reduce((sum, line) => sum + line.allocatedAmount, 0);
    if (billLines.length === 0) {
      return `${formatCurrencyAmount(draft.newAdvanceAmount || draft.receiptAmount)} · No open bill`;
    }
    if (draft.newAdvanceAmount > 0) {
      return `${formatCurrencyAmount(billAmount)} allocated · ${formatCurrencyAmount(draft.newAdvanceAmount)} advance`;
    }
    if (billLines.length === 1) {
      const settlement = Math.abs(Number(billLines[0]?.pendingAmountAfterAllocation ?? 0)) < 0.005
        ? "Full settlement"
        : "Partial settlement";
      return `${formatCurrencyAmount(billAmount)} · ${settlement}`;
    }
    return `${formatCurrencyAmount(billAmount)} allocated`;
  }
  if (draft.status === "needs_review" || draft.status === "cannot_match_yet") {
    return `${formatCurrencyAmount(Math.max(0, draft.unallocatedAmount))} unallocated`;
  }
  if (draft.status === "stale_data") return "Tally bill data changed";
  if (draft.status === "post_failed") return "Open and retry posting";
  return "";
}

function getBillAllocationClass(draft?: BillAllocationDraft | null) {
  if (!draft || draft.status === "not_applicable") return "border-[#e5ddd0] bg-white text-slate-500";
  if (draft.status === "ready_to_post") return "border-emerald-250 bg-emerald-50 text-emerald-800";
  if (draft.status === "cannot_match_yet" || draft.status === "needs_review" || draft.status === "stale_data") {
    return "border-amber-250 bg-amber-50 text-amber-800";
  }
  if (draft.status === "post_failed") return "border-red-250 bg-red-50 text-red-800";
  return "border-blue-200 bg-blue-50 text-blue-800";
}

function getOutgoingVerificationLabel(draft?: OutgoingVerificationDraft | null) {
  return draft?.label || "Check Entry";
}

function getOutgoingVerificationClass(draft?: OutgoingVerificationDraft | null) {
  if (!draft || draft.status === "not_checked") return "border-blue-200 bg-blue-50 text-blue-800";
  if (draft.status === "checking") return "border-blue-200 bg-blue-50 text-blue-800";
  if (draft.status === "found") return "border-emerald-250 bg-emerald-50 text-emerald-800";
  if (draft.status === "ambiguous" || draft.status === "cannot_check_yet") {
    return "border-amber-250 bg-amber-50 text-amber-800";
  }
  return "border-red-250 bg-red-50 text-red-800";
}

function getOutgoingVerificationSubtext(draft?: OutgoingVerificationDraft | null) {
  if (!draft) return "Find existing payment";
  if (draft.status === "checking") return "Checking Tally...";
  if (draft.status === "found") {
    if (draft.duplicateInTally) {
      return `${draft.duplicateVoucherCount || draft.matchCount || 2} duplicate Tally vouchers`;
    }
    const voucher = draft.voucherNumber ? `Voucher ${draft.voucherNumber}` : "Existing voucher found";
    return draft.voucherDate ? `${voucher} - ${formatShortDate(draft.voucherDate)}` : voucher;
  }
  if (draft.status === "ambiguous") return "Review possible vouchers";
  if (draft.status === "missing") return "No existing payment found";
  return draft.reason || "Could not check";
}

function outgoingVerificationFromCommand(command?: TallyCommand | null): OutgoingVerificationDraft {
  if (!command) {
    return {
      status: "failed",
      label: "Check Failed",
      reason: "Tally did not return a result for this row.",
    };
  }

  if (command.status !== "succeeded") {
    return {
      status: "failed",
      label: "Check Failed",
      reason: command.error || `Tally check ${command.status}.`,
    };
  }

  const result = command.result ?? {};
  const verificationStatus = String(result.verificationStatus ?? "").toLowerCase();
  const reason = typeof result.reason === "string" ? result.reason : "";
  const voucherNumber =
    typeof result.voucherNumber === "string"
      ? result.voucherNumber
      : typeof result.voucherId === "string"
        ? result.voucherId
        : null;
  const voucherDate = typeof result.voucherDate === "string" ? result.voucherDate : null;
  const matchCount = typeof result.matchCount === "number" ? result.matchCount : null;
  const duplicateInTally = result.duplicateInTally === true;
  const duplicateVoucherCount = typeof result.duplicateVoucherCount === "number"
    ? result.duplicateVoucherCount
    : duplicateInTally
      ? matchCount || 0
      : 0;
  const scannedCount = typeof result.scannedCount === "number" ? result.scannedCount : null;
  const matches = Array.isArray(result.matches)
    ? result.matches.flatMap((match) => {
        if (!match || typeof match !== "object" || Array.isArray(match)) return [];
        const row = match as Record<string, unknown>;
        return [{
          score: typeof row.score === "number" ? row.score : null,
          reasons: Array.isArray(row.reasons)
            ? row.reasons.filter((reason): reason is string => typeof reason === "string")
            : [],
          date: typeof row.date === "string" ? row.date : null,
          voucherType: typeof row.voucherType === "string" ? row.voucherType : null,
          voucherNumber: typeof row.voucherNumber === "string" ? row.voucherNumber : null,
          reference: typeof row.reference === "string" ? row.reference : null,
          partyLedgerName: typeof row.partyLedgerName === "string" ? row.partyLedgerName : null,
          ledgerNames: Array.isArray(row.ledgerNames)
            ? row.ledgerNames.filter((ledgerName): ledgerName is string => typeof ledgerName === "string")
            : [],
          masterId: typeof row.masterId === "string" ? row.masterId : null,
        }];
      })
    : [];

  if (verificationStatus === "found" || verificationStatus === "matched" || verificationStatus === "verified") {
    return {
      status: "found",
      label: "Found in Tally",
      reason: reason || "Existing outgoing entry was found in Tally.",
      voucherNumber,
      voucherDate,
      matchCount,
      duplicateInTally,
      duplicateVoucherCount,
      scannedCount,
      matches,
    };
  }

  if (verificationStatus === "ambiguous") {
    return {
      status: "ambiguous",
      label: "Possible Match",
      reason: reason || "Multiple Tally vouchers look similar. Review manually.",
      voucherNumber,
      voucherDate,
      matchCount,
      scannedCount,
      matches,
    };
  }

  return {
    status: "missing",
    label: "Missing in Tally",
    reason: reason || "No matching outgoing entry was found in Tally.",
    voucherNumber,
    voucherDate,
    matchCount,
    scannedCount,
    matches,
  };
}

function formatShortDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value || "-";
  return bankShortDateFormatter.format(date);
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getLedgerGroupLabel(
  transaction: ReviewTransaction,
  ledgerMasters: TallyMaster[],
  selectedLedger?: TallyMaster | null
) {
  const ledger = selectedLedger ?? findLedgerByNormalizedName(ledgerMasters, transaction.selectedLedgerName);
  return ledger?.parent || transaction.ledgerGroup || "-";
}

function getSelectedLedger(transaction: ReviewTransaction, ledgerMasters: TallyMaster[]) {
  return findLedgerByNormalizedName(ledgerMasters, transaction.selectedLedgerName);
}

type ProposedBankVoucherType = "Receipt" | "Payment" | "Contra";

function getProposedBankVoucherType(
  transaction: ReviewTransaction,
  ledgerMasters: TallyMaster[],
  selectedLedgerOverride?: TallyMaster | null
): ProposedBankVoucherType | null {
  const selectedLedger = selectedLedgerOverride ?? getSelectedLedger(transaction, ledgerMasters);
  const parentName = selectedLedger?.parent || transaction.ledgerGroup;
  const counterpartyIsBankOrCash = Boolean(
    selectedLedger &&
      (["Bank Accounts", "Bank OD A/c", "Cash-in-Hand"].some(
        (rootGroupName) =>
          normalizeName(parentName) === normalizeName(rootGroupName) ||
          masterParentDescendsFromGroup(parentName, ledgerMasters, rootGroupName)
      ) ||
        isBankLedgerMaster(selectedLedger))
  );

  if (counterpartyIsBankOrCash) return "Contra";
  if (isIncomingReceiptRow(transaction)) return "Receipt";
  if (isOutgoingPaymentRow(transaction)) return "Payment";
  return null;
}

type PartyBillMatchContext = {
  eligible: boolean;
  amount: number;
  direction: "receipt" | "payment" | null;
  partyKind: "customer" | "supplier" | null;
  reason: string;
};

function getPartyBillMatchContext(transaction: ReviewTransaction, ledgerMasters: TallyMaster[]): PartyBillMatchContext {
  const credit = parseNumber(transaction.creditAmount) ?? 0;
  const debit = parseNumber(transaction.debitAmount) ?? 0;
  const amount = Math.max(credit, debit);
  const direction = credit > 0 ? "receipt" : debit > 0 ? "payment" : null;
  if (amount <= 0 || !direction) {
    return { eligible: false, amount: 0, direction: null, partyKind: null, reason: "No receipt or payment amount found." };
  }
  if (!transaction.selectedLedgerName.trim()) {
    return { eligible: false, amount, direction, partyKind: null, reason: "Select the party ledger first." };
  }
  if (isSuspenseLedgerName(transaction.selectedLedgerName)) {
    return { eligible: false, amount, direction, partyKind: null, reason: "Posts directly to Suspense; bill allocation is not applicable." };
  }
  const ledger = getSelectedLedger(transaction, ledgerMasters);
  const parent = ledger?.parent || transaction.ledgerGroup || "";
  const text = `${transaction.transactionType} ${transaction.category} ${transaction.description}`.toLowerCase();
  if (/\breversal|failed|chargeback|internal transfer|self transfer|own account\b/.test(text)) {
    return { eligible: false, amount, direction, partyKind: null, reason: "This looks like a reversal or internal transfer." };
  }
  const isSundryDebtor = /sundry\s+debtors/i.test(parent) || ledger?.ledgerType === "customer";
  const isSundryCreditor = /sundry\s+creditors/i.test(parent) || ledger?.ledgerType === "supplier";
  const partyKind = isSundryDebtor ? "customer" : isSundryCreditor ? "supplier" : null;

  if (!partyKind) {
    return { eligible: false, amount, direction, partyKind: null, reason: "This is not a bill-wise party ledger." };
  }
  if (ledger?.billWiseEnabled === false) {
    return { eligible: false, amount, direction, partyKind, reason: "Selected party ledger is not bill-wise enabled." };
  }
  // Bill matching depends on whether the selected Tally ledger is bill-wise,
  // not whether its Debtor/Creditor classification matches the bank direction.
  // Suppliers can send refunds and customers can receive refunds, so both
  // receipt and payment rows must be allowed to inspect the ledger's open bills.
  return { eligible: true, amount, direction, partyKind, reason: "" };
}

function isBillMatchEligibleTransaction(transaction: ReviewTransaction, ledgerMasters: TallyMaster[]) {
  return getPartyBillMatchContext(transaction, ledgerMasters).eligible;
}

type ReviewPostingAction = "outgoing" | "allocation";

function getReviewPostingAction(
  transaction: ReviewTransaction,
  ledgerMasters: TallyMaster[],
  tallyPresence?: OutgoingVerificationDraft | null
): ReviewPostingAction {
  if (tallyPresence?.status === "found") return "outgoing";

  const outgoingPayment = isOutgoingPaymentRow(transaction);
  const billMatchEligible = isBillMatchEligibleTransaction(transaction, ledgerMasters);
  if (isIncomingReceiptRow(transaction) && !billMatchEligible) return "outgoing";
  const outgoingNeedsBillAllocation = Boolean(
    outgoingPayment &&
      tallyPresence?.status === "missing" &&
      billMatchEligible
  );
  if (outgoingPayment && !outgoingNeedsBillAllocation) return "outgoing";
  return "allocation";
}

function getBillAllocationBadgeText(
  transaction: ReviewTransaction,
  ledgerMasters: TallyMaster[],
  draft?: BillAllocationDraft | null
) {
  if (draft) return getBillAllocationLabel(draft);
  const context = getPartyBillMatchContext(transaction, ledgerMasters);
  if (context.eligible) return "Not Matched";
  if (isOutgoingPaymentRow(transaction)) return "Check Entry";
  if (context.partyKind && context.reason.includes("bill-wise")) return "Needs Bill-Wise";
  if (!transaction.selectedLedgerName.trim()) {
    return "Needs Ledger";
  }
  if (isSuspenseLedgerName(transaction.selectedLedgerName)) return "Post to Suspense";
  if (isIncomingReceiptRow(transaction)) return "Direct Receipt";
  return "Not Applicable";
}

function getBillAllocationBadgeClass(
  transaction: ReviewTransaction,
  ledgerMasters: TallyMaster[],
  draft?: BillAllocationDraft | null
) {
  if (draft) return getBillAllocationClass(draft);
  const context = getPartyBillMatchContext(transaction, ledgerMasters);
  if (context.eligible) return "border-amber-200 bg-amber-50 text-amber-800";
  if (isOutgoingPaymentRow(transaction)) return "border-blue-200 bg-blue-50 text-blue-800";
  if (!transaction.selectedLedgerName.trim()) {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (isIncomingReceiptRow(transaction)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (context.partyKind) return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-[#d8cbbb] bg-white text-[#6f6256]";
}

function normalizeReferenceToken(value?: string | null) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findNarrationBill(openBills: OpenBillReference[], transaction: ReviewTransaction) {
  const narration = normalizeReferenceToken(`${transaction.description} ${transaction.referenceNumber}`);
  const matches = openBills.filter((bill) => {
    const ref = normalizeReferenceToken(bill.referenceName);
    return ref.length >= 5 && narration.includes(ref);
  });
  return matches.length === 1 ? matches[0] : null;
}

function sortOpenBills(openBills: OpenBillReference[]) {
  return [...openBills].sort((left, right) => {
    const leftDate = left.dueDate || left.invoiceDate || "";
    const rightDate = right.dueDate || right.invoiceDate || "";
    return leftDate.localeCompare(rightDate) || left.referenceName.localeCompare(right.referenceName);
  });
}

function buildAdvanceReference(transaction: ReviewTransaction) {
  const date = getEffectiveTransactionDate(transaction).replace(/-/g, "");
  const suffix = normalizeReferenceToken(transaction.referenceNumber || transaction.id).slice(-8) || transaction.id.slice(0, 8);
  return `ADV-${date}-${suffix}`.slice(0, 80);
}

function isAllocationTotalValid(receiptAmount: number, totalAllocatedAmount: number) {
  return Math.abs(receiptAmount - totalAllocatedAmount) < 0.005;
}

function billStateSignature(
  openBills: OpenBillReference[],
  existingAdvances: ExistingAdvanceReference[]
) {
  const bills = openBills
    .map((bill) => `${normalizeReferenceToken(bill.referenceName)}:${Number(bill.pendingAmount ?? 0).toFixed(2)}`)
    .sort();
  const advances = existingAdvances
    .map((advance) => `${normalizeReferenceToken(advance.referenceName)}:${Number(advance.pendingAdvanceAmount ?? 0).toFixed(2)}`)
    .sort();
  return `${bills.join("|")}::${advances.join("|")}`;
}

function validateAllocationAgainstFreshBillState(
  draft: BillAllocationDraft,
  openBills: OpenBillReference[],
  existingAdvances: ExistingAdvanceReference[]
) {
  const freshBillsByReference = new Map(
    openBills.map((bill) => [normalizeReferenceToken(bill.referenceName), bill])
  );
  for (const allocation of draft.allocations) {
    if (allocation.referenceType !== "Agst Ref") continue;
    const freshBill = freshBillsByReference.get(normalizeReferenceToken(allocation.referenceName));
    if (!freshBill) {
      return `Bill ${allocation.referenceName} is no longer open in Tally.`;
    }
    if (Number(freshBill.pendingAmount ?? 0) + 0.005 < allocation.allocatedAmount) {
      return `Bill ${allocation.referenceName} now has only ${formatCurrencyAmount(Number(freshBill.pendingAmount ?? 0))} pending.`;
    }
  }

  const previousSignature = billStateSignature(draft.candidateBills, draft.existingAdvances);
  const freshSignature = billStateSignature(openBills, existingAdvances);
  if (draft.caseType !== "manual_review" && previousSignature !== freshSignature) {
    return "Open bills or advances changed in Tally after the statement was checked.";
  }
  if (
    draft.caseType === "manual_review" &&
    billStateSignature([], draft.existingAdvances) !== billStateSignature([], existingAdvances)
  ) {
    return "Existing advances changed in Tally after the manual allocation was reviewed.";
  }
  return null;
}

function getAllocationCaseLabel(allocations: BillAllocationLine[], newAdvanceAmount: number, manual = false) {
  if (manual) return "Manual Review";
  const billLines = allocations.filter((line) => line.referenceType === "Agst Ref");
  if (billLines.length === 0) return "Post as advance";
  if (newAdvanceAmount > 0) return "Bills + advance";
  if (billLines.length > 1) return `${billLines.length} bills matched`;
  return billLines[0]?.pendingAmountAfterAllocation === 0 ? "Full settlement" : "Partial settlement";
}

function getAllocationCaseType(allocations: BillAllocationLine[], newAdvanceAmount: number, manual = false) {
  if (manual) return "manual_review";
  const billLines = allocations.filter((line) => line.referenceType === "Agst Ref");
  if (billLines.length === 0) return "no_pending_bill_advance";
  if (newAdvanceAmount > 0) return "bills_cleared_plus_advance";
  if (billLines.length > 1) return "split_across_bills";
  return billLines[0]?.pendingAmountAfterAllocation === 0 ? "exact_or_full_bill_match" : "partial_settlement";
}

function buildManualAllocationDraft(
  transaction: ReviewTransaction,
  existingDraft: BillAllocationDraft,
  nextBillAmounts: Record<string, number>,
  nextAdvanceAmount: number
): BillAllocationDraft {
  const receiptAmount =
    Math.max(parseNumber(transaction.creditAmount) ?? 0, parseNumber(transaction.debitAmount) ?? 0) ||
    existingDraft.receiptAmount;
  const allocations: BillAllocationLine[] = [];

  for (const bill of existingDraft.candidateBills) {
    const pendingAmount = Math.max(0, Number(bill.pendingAmount ?? 0));
    const requestedAmount = Math.max(0, Number(nextBillAmounts[bill.referenceName] ?? 0));
    const allocatedAmount = Number(Math.min(requestedAmount, pendingAmount).toFixed(2));
    if (allocatedAmount <= 0) continue;

    allocations.push({
      referenceType: "Agst Ref",
      referenceName: bill.referenceName,
      voucherNumber: bill.voucherNumber,
      invoiceDate: bill.invoiceDate,
      dueDate: bill.dueDate,
      previousPendingAmount: pendingAmount,
      allocatedAmount,
      pendingAmountAfterAllocation: Number((pendingAmount - allocatedAmount).toFixed(2)),
      statusAfterAllocation: pendingAmount - allocatedAmount <= 0 ? "cleared" : "partially_settled",
    });
  }

  const advanceAmount = Number(Math.max(0, nextAdvanceAmount).toFixed(2));
  if (advanceAmount > 0) {
    allocations.push({
      referenceType: "Advance",
      referenceName:
        existingDraft.allocations.find((line) => line.referenceType === "Advance")?.referenceName ||
        buildAdvanceReference(transaction),
      allocatedAmount: advanceAmount,
      pendingAmountAfterAllocation: advanceAmount,
      statusAfterAllocation: "advance",
    });
  }

  const totalAllocatedAmount = Number(allocations.reduce((sum, line) => sum + line.allocatedAmount, 0).toFixed(2));
  const unallocatedAmount = Number((receiptAmount - totalAllocatedAmount).toFixed(2));
  const valid = isAllocationTotalValid(receiptAmount, totalAllocatedAmount);

  return {
    ...existingDraft,
    status: valid ? "ready_to_post" : "needs_review",
    caseType: getAllocationCaseType(allocations, advanceAmount, true),
    caseLabel: getAllocationCaseLabel(allocations, advanceAmount, true),
    reason: valid
      ? "Manual allocation was reviewed and balances to the transaction amount."
      : "Selected bill allocation and advance must equal the transaction amount.",
    receiptAmount,
    totalAllocatedAmount,
    newAdvanceAmount: advanceAmount,
    unallocatedAmount,
    allocations,
    requiresUserReview: !valid,
    isEligibleForPosting: valid,
  };
}

function allocateBillsForTransaction(
  transaction: ReviewTransaction,
  openBills: OpenBillReference[],
  existingAdvances: ExistingAdvanceReference[]
): BillAllocationDraft {
  const receiptAmount = Math.max(parseNumber(transaction.creditAmount) ?? 0, parseNumber(transaction.debitAmount) ?? 0);
  const allocationSubject = isOutgoingPaymentRow(transaction) ? "payment" : "receipt";
  if (receiptAmount <= 0) {
    return {
      status: "not_applicable",
      caseType: "not_applicable",
      caseLabel: "Not Applicable",
      reason: "This row does not have a receipt or payment amount.",
      receiptAmount,
      totalAllocatedAmount: 0,
      newAdvanceAmount: 0,
      unallocatedAmount: 0,
      allocations: [],
      candidateBills: openBills,
      existingAdvances,
      requiresUserReview: false,
      isEligibleForPosting: true,
    };
  }

  const narrationBill = findNarrationBill(openBills, transaction);
  const candidateBills = sortOpenBills(openBills);

  if (openBills.length > 0 && existingAdvances.length > 0) {
    return {
      status: "needs_review",
      caseType: "cannot_match_yet",
      caseLabel: "Needs Review",
      reason: `Existing advances require an explicit allocation review before applying this ${allocationSubject}.`,
      receiptAmount,
      totalAllocatedAmount: 0,
      newAdvanceAmount: 0,
      unallocatedAmount: receiptAmount,
      allocations: [],
      candidateBills,
      existingAdvances,
      requiresUserReview: true,
      isEligibleForPosting: false,
    };
  }

  const automaticAllocation = allocateReceiptByFifo(
    receiptAmount,
    openBills,
    buildAdvanceReference(transaction),
    narrationBill?.referenceName
  );
  const allocations: BillAllocationLine[] = automaticAllocation.allocations;
  const billAllocationCount = allocations.filter((allocation) => allocation.referenceType === "Agst Ref").length;
  const isBalanced = isAllocationTotalValid(receiptAmount, automaticAllocation.totalAllocatedAmount);
  let allocationReason = "Allocated against the oldest open bill using due date, invoice date, then bill reference.";
  if (openBills.length === 0) {
    allocationReason = `No open bill was found. The full ${allocationSubject} will be posted as a new ${isOutgoingPaymentRow(transaction) ? "supplier" : "customer"} advance.`;
  } else if (narrationBill) {
    allocationReason = `Matched the visible bill reference ${narrationBill.referenceName}; any remaining receipt was allocated FIFO.`;
  } else if (automaticAllocation.newAdvanceAmount > 0) {
    allocationReason = `Allocated open bills FIFO; the remaining ${allocationSubject} will be posted as a new advance.`;
  } else if (billAllocationCount > 1) {
    allocationReason = `Allocated across ${billAllocationCount} open bills using FIFO by due date, invoice date, then bill reference.`;
  }

  return {
    status: isBalanced ? "ready_to_post" : "needs_review",
    caseType: getAllocationCaseType(allocations, automaticAllocation.newAdvanceAmount),
    caseLabel: getAllocationCaseLabel(allocations, automaticAllocation.newAdvanceAmount),
    reason: allocationReason,
    receiptAmount,
    totalAllocatedAmount: automaticAllocation.totalAllocatedAmount,
    newAdvanceAmount: automaticAllocation.newAdvanceAmount,
    unallocatedAmount: automaticAllocation.unallocatedAmount,
    allocations,
    candidateBills: openBills.length > 0 ? automaticAllocation.orderedBills : candidateBills,
    existingAdvances,
    requiresUserReview: !isBalanced,
    isEligibleForPosting: isBalanced,
  };
}

function transactionQueueKey(transaction: {
  transactionDate: string;
  valueDate?: string | null;
  description: string;
  referenceNumber?: string | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
}) {
  return [
    getEffectiveTransactionDate(transaction),
    transaction.referenceNumber || "",
    transaction.description,
    String(transaction.debitAmount ?? ""),
    String(transaction.creditAmount ?? ""),
  ].join("|");
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function buildTallyPostingStatus(
  connectionId: string,
  commandIds: string[],
  commands: TallyCommand[]
): TallyPostingStatus {
  const commandById = new Map(commands.map((command) => [command.id, command]));
  let waiting = 0;
  let sent = 0;
  let completed = 0;
  let failed = 0;
  let canceled = 0;
  let voucherTotal = 0;
  let voucherWaiting = 0;
  let voucherCompleted = 0;
  let voucherFailed = 0;
  let paymentCheckTotal = 0;
  let paymentCheckWaiting = 0;
  let paymentCheckCompleted = 0;
  let paymentCheckFailed = 0;
  const errors: string[] = [];

  for (const commandId of commandIds) {
    const command = commandById.get(commandId);
    const status = command?.status ?? "queued";
    const commandType = command?.commandType || command?.command_type || "";
    const isVoucherCommand = commandType === "post_bank_voucher";
    const isPaymentCheckCommand = commandType === "verify_bank_transaction";

    if (isVoucherCommand) voucherTotal += 1;
    if (isPaymentCheckCommand) paymentCheckTotal += 1;

    if (status === "succeeded") {
      completed += 1;
      if (isVoucherCommand) voucherCompleted += 1;
      if (isPaymentCheckCommand) paymentCheckCompleted += 1;
    } else if (status === "failed") {
      failed += 1;
      if (isVoucherCommand) voucherFailed += 1;
      if (isPaymentCheckCommand) paymentCheckFailed += 1;
      if (command?.error) errors.push(command.error);
    } else if (status === "canceled") {
      canceled += 1;
      if (isVoucherCommand) voucherFailed += 1;
      if (isPaymentCheckCommand) paymentCheckFailed += 1;
      if (command?.error) errors.push(command.error);
    } else if (status === "claimed") {
      sent += 1;
      if (isVoucherCommand) voucherWaiting += 1;
      if (isPaymentCheckCommand) paymentCheckWaiting += 1;
    } else {
      waiting += 1;
      if (isVoucherCommand) voucherWaiting += 1;
      if (isPaymentCheckCommand) paymentCheckWaiting += 1;
    }
  }

  return {
    connectionId,
    commandIds,
    total: commandIds.length,
    waiting,
    sent,
    completed,
    failed,
    canceled,
    finished: completed + failed + canceled >= commandIds.length,
    errors: Array.from(new Set(errors)).slice(0, 3),
    voucherTotal,
    voucherWaiting,
    voucherCompleted,
    voucherFailed,
    paymentCheckTotal,
    paymentCheckWaiting,
    paymentCheckCompleted,
    paymentCheckFailed,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isCsvFile(file: File) {
  const name = file.name.toLowerCase();
  return file.type === "text/csv" || name.endsWith(".csv");
}

function isTextFile(file: File) {
  const name = file.name.toLowerCase();
  return file.type.startsWith("text/") || name.endsWith(".txt");
}

function isPdfFile(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isImageFile(file: File) {
  return file.type.startsWith("image/");
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      continue;
    }

    cell += char;
  }

  if (inQuotes) {
    throw new Error("The CSV has an unclosed quoted value.");
  }

  row.push(cell.trim());
  rows.push(row);

  return rows.filter((cells) => cells.some((value) => value.length > 0));
}

async function buildDocumentPreview(file: File): Promise<DocumentPreviewState> {
  const basePreview = {
    fileName: file.name,
    headers: [],
    rows: [],
    totalRows: 0,
    textLines: [],
    objectUrl: null,
  };

  if (!isCsvFile(file)) {
    if (isTextFile(file)) {
      const text = await file.text();
      const textLines = text
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);

      return {
        ...basePreview,
        kind: "text",
        textLines: textLines.slice(0, 20),
        totalRows: textLines.length,
        error: text.trim()
          ? null
          : "This text file is empty. Choose a bank statement file with readable content.",
      };
    }

    if (isPdfFile(file)) {
      return {
        ...basePreview,
        kind: "pdf",
        totalRows: 1,
        error: file.size > 0 ? null : "This PDF is empty. Choose a valid bank statement PDF.",
      };
    }

    if (isImageFile(file)) {
      return {
        ...basePreview,
        kind: "image",
        objectUrl: URL.createObjectURL(file),
        totalRows: 1,
        error: file.size > 0 ? null : "This image is empty. Choose a valid scanned bank statement image.",
      };
    }

    return {
      ...basePreview,
      kind: "unsupported",
      error: "This file type is not supported. Choose CSV, TXT, PDF, or a scanned statement image.",
    };
  }

  const text = await file.text();
  if (!text.trim()) {
    return {
      ...basePreview,
      kind: "csv",
      error: "This CSV is empty. Choose a bank statement CSV with headers and transaction rows.",
    };
  }

  try {
    const parsedRows = parseCsvRows(text);
    const [headerRow, ...dataRows] = parsedRows;
    const headers = (headerRow ?? []).map((header, index) => header || `Column ${index + 1}`);
    const meaningfulRows = dataRows.filter((row) => row.some((value) => value.trim().length > 0));

    if (headers.length < 2 || !headers.some((header) => header.trim().length > 0)) {
      return {
        ...basePreview,
        kind: "csv",
        error: "This CSV does not appear to have readable headers.",
      };
    }

    if (meaningfulRows.length === 0) {
      return {
        ...basePreview,
        kind: "csv",
        error: "This CSV has headers but no transaction rows to preview.",
      };
    }

    return {
      ...basePreview,
      kind: "csv",
      headers: headers.slice(0, 8),
      rows: meaningfulRows.slice(0, 6).map((row) => headers.slice(0, 8).map((_, index) => row[index] ?? "")),
      totalRows: meaningfulRows.length,
      error: null,
    };
  } catch (error) {
    return {
      ...basePreview,
      kind: "csv",
      error: error instanceof Error ? error.message : "This CSV could not be parsed.",
    };
  }
}

function getAnalysisCompleteMessage(payload: PreviewResponse) {
  const extractionIssue = payload.extractionError
    ? payload.extractionError
    : payload.extractionDiagnostics?.rawAiTransactionCount
      ? `AI found ${payload.extractionDiagnostics.rawAiTransactionCount} row(s), but ${payload.extractionDiagnostics.normalizedAiTransactionCount ?? 0} passed validation.`
      : "No transaction rows were extracted.";

  if (payload.requiresManualExtraction || payload.transactions.length === 0) {
    const unresolvedPages = payload.extractionDiagnostics?.unresolvedPages ?? [];
    return {
      tone: "error" as const,
      text: unresolvedPages.length > 0
        ? `Partial extraction: ${payload.transactions.length} row(s) verified, but page${unresolvedPages.length === 1 ? "" : "s"} ${unresolvedPages.join(", ")} could not be completed. Posting is blocked until every page is verified.`
        : `Extraction is incomplete. ${extractionIssue} Posting is blocked until every page is verified.`,
    };
  }

  if (payload.ledgerRecommendationError) {
    return {
      tone: "info" as const,
      text: `Statement analyzed. ${payload.ledgerRecommendationError}`,
    };
  }

  return {
    tone: "success" as const,
    text: "Statement analyzed.",
  };
}

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
  const message = payload.error || `Request failed with status ${response.status}`;
  return [message, payload.detail, payload.userAction].filter(Boolean).join(" ");
}

async function readApiErrorPayload(response: Response): Promise<ApiErrorPayload> {
  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
  return {
    ...payload,
    error: payload.error || `Request failed with status ${response.status}`,
  };
}

function normalizeFetchedBankLedger(value: unknown): LocalBankLedger | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) return null;

  return {
    name,
    parent: typeof row.parent === "string" && row.parent.trim() ? row.parent.trim() : "Bank Accounts",
    bankName: typeof row.bankName === "string" && row.bankName.trim() ? row.bankName.trim() : null,
    bankAccountNumber:
      typeof row.bankAccountNumber === "string" && row.bankAccountNumber.trim()
        ? row.bankAccountNumber.trim()
        : null,
    closingBalance:
      typeof row.closingBalance === "number" && Number.isFinite(row.closingBalance)
        ? row.closingBalance
        : null,
    closingBalanceType:
      row.closingBalanceType === "Dr" || row.closingBalanceType === "Cr"
        ? row.closingBalanceType
        : null,
  };
}

function normalizeFetchedBankLedgers(values: unknown) {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const ledgers: LocalBankLedger[] = [];

  for (const value of values) {
    const ledger = normalizeFetchedBankLedger(value);
    const key = ledger?.name.trim().toLowerCase();
    if (!ledger || !key || seen.has(key)) continue;
    seen.add(key);
    ledgers.push(ledger);
  }

  return ledgers;
}

function normalizeFetchedBankLedgersByCompany(
  result: BankLedgerFetchResult | null | undefined,
  requestedCompanyNames: string[]
) {
  const next: Record<string, LocalBankLedger[]> = {};
  const byCompany = result?.byCompany && typeof result.byCompany === "object" ? result.byCompany : {};

  for (const [companyName, ledgers] of Object.entries(byCompany)) {
    const normalizedName = companyName.trim();
    if (!normalizedName) continue;
    next[normalizedName] = normalizeFetchedBankLedgers(ledgers);
  }

  const fallbackCompanyName = result?.companyName || requestedCompanyNames[0];
  if (fallbackCompanyName && !next[fallbackCompanyName]) {
    next[fallbackCompanyName] = normalizeFetchedBankLedgers(result?.bankLedgers);
  }

  return next;
}

function ScrollablePdfPreview({ objectUrl, fileName }: { objectUrl: string; fileName: string }) {
  const [pages, setPages] = useState<string[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      setPages([]);
      setTotalPages(0);
      try {
        const response = await fetch(objectUrl);
        if (!response.ok) throw new Error("The prepared PDF could not be opened.");
        const blob = await response.blob();
        const previewFile = new File([blob], fileName, { type: "application/pdf" });
        const renderedPages = (await pdfToImagePages(previewFile, {
          scale: 1.2,
          quality: 0.82,
          shouldCancel: () => cancelled,
          onPage: (page, _pageNumber, pageCount) => {
            if (cancelled || !page.startsWith("data:image/")) return;
            setTotalPages(pageCount);
            setPages((current) => [...current, page]);
          },
        })).filter((page) => page.startsWith("data:image/"));
        if (renderedPages.length === 0) throw new Error("The PDF pages could not be rendered.");
      } catch (renderError) {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : "The PDF preview could not be rendered.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fileName, objectUrl]);

  return (
    <div className="bg-[#f3f0e9]">
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-[#ddd6ca] bg-white px-3 py-2 text-[11px] font-semibold text-[#71695f]">
        <span>{loading ? `Rendering PDF pages${totalPages ? ` ${pages.length}/${totalPages}` : ""}…` : error ? "Preview unavailable" : `${pages.length} page${pages.length === 1 ? "" : "s"}`}</span>
        {!loading && !error ? <span>Scroll inside the preview to see every page</span> : null}
      </div>
      <div
        aria-label={`Scrollable preview of ${fileName}`}
        className="h-[min(680px,72vh)] min-h-[420px] overflow-y-auto overscroll-contain bg-[#e9e6df] p-2 [scrollbar-gutter:stable] sm:p-3"
        tabIndex={0}
      >
        {loading && pages.length === 0 ? (
          <div className="flex min-h-full items-center justify-center text-center">
            <div>
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#5a5046]" />
              <p className="mt-3 text-xs font-semibold text-[#71695f]">Preparing a scrollable preview…</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex min-h-full items-center justify-center px-6 text-center">
            <div className="max-w-sm">
              <AlertTriangle className="mx-auto h-6 w-6 text-rose-700" />
              <p className="mt-3 text-sm font-bold text-[#2d2d2d]">Preview could not be displayed</p>
              <p className="mt-1 text-xs font-semibold leading-5 text-[#71695f]">{error}</p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[980px] flex-col gap-3">
            {pages.map((page, index) => (
              <figure className="overflow-hidden rounded-md bg-white shadow-[0_2px_10px_rgba(32,27,20,0.16)] ring-1 ring-black/5" key={`pdf-page-${index + 1}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- PDF pages are rendered as local data URLs. */}
                <img
                  alt={`${fileName}, page ${index + 1}`}
                  className="block h-auto w-full"
                  decoding="async"
                  loading={index === 0 ? "eager" : "lazy"}
                  src={page}
                />
                <figcaption className="sr-only">Page {index + 1} of {pages.length}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatFileSize(size: number | null | undefined) {
  if (!size || size <= 0) return "Size unavailable";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function BankStatementsPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [documentPreview, setDocumentPreview] = useState<DocumentPreviewState | null>(null);
  const [documentPreviewLoading, setDocumentPreviewLoading] = useState(false);
  const [statementPassword, setStatementPassword] = useState("");
  const [statementPasswordRequired, setStatementPasswordRequired] = useState(false);
  const [statementPasswordError, setStatementPasswordError] = useState<string | null>(null);
  const [statementPasswordChecking, setStatementPasswordChecking] = useState(false);
  const [statementPasswordVerified, setStatementPasswordVerified] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [account, setAccount] = useState<DraftAccount>(EMPTY_ACCOUNT);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [analysisEngineSource, setAnalysisEngineSource] = useState<string | null>(null);
  const [, setRecentImports] = useState<BankStatementImport[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [connections, setConnections] = useState<TallyConnection[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [tallyConnectionId, setTallyConnectionId] = useState("");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [bankLedgerName, setBankLedgerName] = useState("");
  const [bankLedgerVerified, setBankLedgerVerified] = useState(false);
  const [bankLedgerManuallyConfirmed, setBankLedgerManuallyConfirmed] = useState(false);
  const [bankLedgerChangeMode, setBankLedgerChangeMode] = useState(false);
  const [pendingBankLedgerName, setPendingBankLedgerName] = useState("");
  const [ledgerMasters, setLedgerMasters] = useState<TallyMaster[]>([]);
  const [tallyBankLedgersByCompany, setTallyBankLedgersByCompany] = useState<Record<string, LocalBankLedger[]>>({});
  const [transactions, setTransactions] = useState<ReviewTransaction[]>([]);
  const [editingLedgerIds, setEditingLedgerIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [sendingMode, setSendingMode] = useState<TallySendMode | null>(null);
  const [tallyPostingScope, setTallyPostingScope] = useState<TallyPostingScope>("all");
  const sending = sendingMode !== null;
  const [matchingBills, setMatchingBills] = useState(false);
  const matchAbortRef = useRef<AbortController | null>(null);
  const [tallyCheckAttempted, setTallyCheckAttempted] = useState(false);
  const [syncingMasters, setSyncingMasters] = useState(false);
  const [loadingBankLedgers, setLoadingBankLedgers] = useState(false);
  const [refreshingConnections, setRefreshingConnections] = useState(false);
  const [banner, setBanner] = useState<{ tone: MessageTone; text: string } | null>(null);
  const [postUploadSyncImportId, setPostUploadSyncImportId] = useState<string | null>(null);
  const [postUploadSyncError, setPostUploadSyncError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [tallyPostingStatus, setTallyPostingStatus] = useState<TallyPostingStatus | null>(null);
  const [statementDoneSummary, setStatementDoneSummary] = useState<StatementDoneSummary | null>(null);
  const [reviewFiltersOpen, setReviewFiltersOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [reviewSearch, setReviewSearch] = useState("");
  const [reviewWorkStatusFilter, setReviewWorkStatusFilter] = useState<ReviewWorkStatusFilter>("all");
  const [reviewTallyResultFilter, setReviewTallyResultFilter] = useState<ReviewTallyResultFilter>("all");
  const [reviewLedgerFilter, setReviewLedgerFilter] = useState<ReviewLedgerFilter>("all");
  const [reviewDirectionFilter, setReviewDirectionFilter] = useState<ReviewDirectionFilter>("all");
  const [reviewAllocationFilter, setReviewAllocationFilter] = useState<ReviewAllocationFilter>("all");
  const [reviewDateFrom, setReviewDateFrom] = useState("");
  const [reviewDateTo, setReviewDateTo] = useState("");
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [reviewPage, setReviewPage] = useState(1);
  const [billAllocationsByTransactionId, setBillAllocationsByTransactionId] = useState<Record<string, BillAllocationDraft>>({});
  const [outgoingVerificationsByTransactionId, setOutgoingVerificationsByTransactionId] = useState<Record<string, OutgoingVerificationDraft>>({});
  const [tallyPresenceByTransactionId, setTallyPresenceByTransactionId] = useState<Record<string, OutgoingVerificationDraft>>({});
  const [postedTransactionIds, setPostedTransactionIds] = useState<Set<string>>(() => new Set());
  const [, setTallyBalanceProof] = useState<TallyBalanceProof | null>(null);
  const [billAllocationReviewTransactionId, setBillAllocationReviewTransactionId] = useState<string | null>(null);
  const [billAllocationSearch, setBillAllocationSearch] = useState("");
  const [confirmFullAdvance, setConfirmFullAdvance] = useState(false);
  const [outgoingReviewTransactionId, setOutgoingReviewTransactionId] = useState<string | null>(null);
  const [reviewActionStage, setReviewActionStage] = useState<"ledger" | "posting">("ledger");
  const [expandedNarrationTransactionId, setExpandedNarrationTransactionId] = useState<string | null>(null);
  const reviewRowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const reviewTableScrollRef = useRef<HTMLDivElement | null>(null);
  const activeReviewTransactionIdRef = useRef<string | null>(null);
  const reviewSearchInputRef = useRef<HTMLInputElement>(null);
  const reviewPeriodInputRef = useRef<HTMLInputElement>(null);
  const ledgerLoadSeqRef = useRef(0);
  const bankLedgerLoadKeyRef = useRef("");
  const initialSummaryLoadStartedRef = useRef(false);
  const tallyStatusStartedAtRef = useRef(Date.now());
  const lastNonEmptyCompaniesRef = useRef<CompanyOption[]>([]);
  const lastLiveTallyCheckAtRef = useRef(0);
  const [checkingLiveTallyCompany, setCheckingLiveTallyCompany] = useState(true);

  useEffect(() => {
    if (!expandedNarrationTransactionId) return;

    function collapseNarrationOnOutsideClick(event: PointerEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-narration-cell]")) return;
      setExpandedNarrationTransactionId(null);
    }

    document.addEventListener("pointerdown", collapseNarrationOnOutsideClick);
    return () => document.removeEventListener("pointerdown", collapseNarrationOnOutsideClick);
  }, [expandedNarrationTransactionId]);

  const selectReviewTransaction = useCallback((transactionId: string | null) => {
    const previousId = activeReviewTransactionIdRef.current;
    if (previousId !== transactionId) setReviewActionStage("ledger");
    if (previousId && previousId !== transactionId) {
      const previousRow = reviewRowRefs.current.get(previousId);
      previousRow?.setAttribute("data-active", "false");
      previousRow?.setAttribute("aria-selected", "false");
    }

    activeReviewTransactionIdRef.current = transactionId;
    if (transactionId) {
      const nextRow = reviewRowRefs.current.get(transactionId);
      nextRow?.setAttribute("data-active", "true");
      nextRow?.setAttribute("aria-selected", "true");
    }
  }, []);

  const scrollReviewTransactionIntoView = useCallback((transactionId: string) => {
    const scrollIfNeeded = () => {
      const row = reviewRowRefs.current.get(transactionId);
      const container = reviewTableScrollRef.current;
      if (!row || !container) return false;

      const rowRect = row.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const visibleTop = containerRect.top + 34;
      if (rowRect.top < visibleTop) {
        container.scrollTop -= visibleTop - rowRect.top;
      } else if (rowRect.bottom > containerRect.bottom) {
        container.scrollTop += rowRect.bottom - containerRect.bottom;
      }
      return true;
    };

    if (!scrollIfNeeded()) {
      window.requestAnimationFrame(() => {
        if (!scrollIfNeeded()) window.requestAnimationFrame(scrollIfNeeded);
      });
    }
  }, []);

  const validTransactions = useMemo(
    () => transactions.filter(transactionIsValid),
    [transactions]
  );
  const ledgerMastersByNormalizedName = useMemo(
    () => new Map(ledgerMasters.map((ledger) => [normalizeName(ledger.name), ledger])),
    [ledgerMasters]
  );
  const ignoredStatementRowCount = Math.max(0, transactions.length - validTransactions.length);

  useEffect(() => {
    const objectUrl = documentPreview?.objectUrl;
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [documentPreview?.objectUrl]);
  const outgoingPaymentTransactions = useMemo(
    () => validTransactions.filter(isOutgoingPaymentRow),
    [validTransactions]
  );
  const visibleConnections = useMemo(
    () => getRelevantTallyConnections(connections),
    [connections]
  );
  useEffect(() => {
    if (companies.length > 0) {
      lastNonEmptyCompaniesRef.current = companies;
    }
  }, [companies]);
  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === tallyConnectionId) ?? null,
    [connections, tallyConnectionId]
  );
  const companyOptions = useMemo(() => {
    if (companies.length > 0) {
      return uniqueCompanyOptions(sortCompanyOptions(companies));
    }

    return uniqueCompanyOptions(sortCompanyOptions(visibleConnections.map((connection) => ({
      id: connection.id,
      connectionId: connection.id,
      companyName: connection.lastCompanyName || connection.displayName,
      financialYear: "Current year",
      status: connection.status,
      bridgeConnected: Boolean(connection.bridgeConnected),
      tallyReachable: connection.status === "company_loaded" || connection.status === "tally_reachable",
      companyLoaded: connection.status === "company_loaded",
      bankAccountCount: null,
      lastSyncAt: null,
      lastHeartbeatAt: connection.updatedAt ?? null,
      lastError: null,
    }))));
  }, [companies, visibleConnections]);
  const selectedCompany = useMemo(
    () => selectedCompanyId
      ? companyOptions.find((company) => company.id === selectedCompanyId) ?? null
      : null,
    [companyOptions, selectedCompanyId]
  );
  useEffect(() => {
    if (selectedCompany) {
      writeStoredCompanySelection(selectedCompany);
    } else if (!selectedCompanyId) {
      writeStoredCompanySelection(null);
    }
  }, [selectedCompany, selectedCompanyId]);
  const commandConnection = useMemo<TallyConnection | null>(() => {
    if (!selectedCompany) return null;
    if (selectedConnection) {
      return {
        ...selectedConnection,
        displayName: selectedCompany.companyName,
        lastCompanyName: selectedCompany.companyName,
        status: selectedCompany.status || selectedConnection.status,
        bridgeConnected: selectedCompany.bridgeConnected || selectedConnection.bridgeConnected,
        heartbeatStale: selectedConnection.heartbeatStale,
        updatedAt: selectedCompany.lastHeartbeatAt ?? selectedConnection.updatedAt,
      };
    }
    return {
      id: selectedCompany.connectionId,
      displayName: selectedCompany.companyName,
      status: selectedCompany.status,
      lastCompanyName: selectedCompany.companyName,
      bridgeConnected: selectedCompany.bridgeConnected,
      heartbeatStale: false,
      updatedAt: selectedCompany.lastHeartbeatAt ?? undefined,
    };
  }, [selectedCompany, selectedConnection]);
  const selectedCompanyName =
    selectedCompany?.companyName || "";
  const selectedFinancialYear = selectedCompany?.financialYear || "Current year";
  const tallyConnected =
    selectedCompany
      ? selectedCompany.companyLoaded || selectedCompany.tallyReachable
      : selectedConnection?.status === "company_loaded" || selectedConnection?.status === "tally_reachable";
  const activeTallyCompanyName = selectedConnection?.lastCompanyName?.trim() || "";
  const activeTallyCompanyFresh = !checkingLiveTallyCompany && Boolean(activeTallyCompanyName);
  const tallyCompanyContextVerified = Boolean(
    tallyConnected &&
      selectedCompanyName &&
      activeTallyCompanyFresh &&
      normalizeName(selectedCompanyName) === normalizeName(activeTallyCompanyName)
  );
  const tallyCompanyContextMismatch = Boolean(
    tallyConnected &&
      selectedCompanyName &&
      activeTallyCompanyFresh &&
      normalizeName(selectedCompanyName) !== normalizeName(activeTallyCompanyName)
  );
  const bankLedgerOptions = useMemo(() => {
    const hasFetchedBankLedgers = selectedCompanyName
      ? Object.prototype.hasOwnProperty.call(tallyBankLedgersByCompany, selectedCompanyName)
      : false;
    const fetchedBankLedgers = selectedCompanyName ? tallyBankLedgersByCompany[selectedCompanyName] : undefined;
    const sourceBankLedgers =
      hasFetchedBankLedgers
        ? fetchedBankLedgers ?? []
        : selectedCompany?.bankLedgers ?? [];
    const localBankLedgers = sourceBankLedgers.map((ledger) => ({
      key: `local-bank-ledger:${selectedCompany?.id ?? ""}:${ledger.name}`,
      name: ledger.name,
      type: "ledger",
      parent: ledger.parent ?? "Bank Accounts",
      bankName: ledger.bankName ?? null,
      bankAccountNumber: ledger.bankAccountNumber ?? null,
      closingBalance: ledger.closingBalance ?? null,
      closingBalanceType: ledger.closingBalanceType ?? null,
      ifscCode: null,
      accountHolderName: null,
      billWiseEnabled: null,
      ledgerType: "other",
    } satisfies TallyMaster));
    const merged = [...localBankLedgers, ...ledgerMasters.filter(isBankLedgerMaster)];
    const seen = new Set<string>();
    return merged.filter((ledger) => {
      const key = ledger.name.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [ledgerMasters, selectedCompany, selectedCompanyName, tallyBankLedgersByCompany]);
  const bankLedgerPickerGroups = useMemo<LedgerSearchGroup[]>(() => {
    const identifiedNames = new Set(bankLedgerOptions.map((ledger) => normalizeName(ledger.name)));
    const identifiedBankLedgers = [...bankLedgerOptions]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((ledger) => ({
        name: ledger.name,
        helper: [
          ledger.bankName || ledger.parent || "Bank Accounts",
          ledger.bankAccountNumber ? `A/c ${ledger.bankAccountNumber}` : null,
        ].filter(Boolean).join(" - "),
        ...ledgerBalanceFields(ledger),
      }));
    const allOtherLedgers = ledgerMasters
      .filter((ledger) => ledger.name.trim() && !identifiedNames.has(normalizeName(ledger.name)))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((ledger) => ({
        name: ledger.name,
        helper: ledger.parent ? `Group: ${ledger.parent}` : "Tally ledger",
        ...ledgerBalanceFields(ledger),
      }));

    return [
      { label: "Identified bank account ledgers", options: identifiedBankLedgers },
      { label: "All other Tally ledgers", options: allOtherLedgers },
    ];
  }, [bankLedgerOptions, ledgerMasters]);
  const exactBankLedgerMatch = useMemo(() => {
    const statementAccountNumber = normalizeBankAccountNumber(account.accountNumber);
    if (!statementAccountNumber) return null;

    const exactNames = Array.from(
      new Set(
        bankLedgerOptions
          .filter((ledger) => getTallyBankLedgerAccountNumber(ledger) === statementAccountNumber)
          .map((ledger) => ledger.name.trim())
          .filter(Boolean)
      )
    );
    return exactNames.length === 1 ? exactNames[0] : null;
  }, [account.accountNumber, bankLedgerOptions]);

  useEffect(() => {
    if (!preview || bankLedgerName || bankLedgerChangeMode || !exactBankLedgerMatch) return;
    setAccount((current) => ({ ...current, tallyLedgerName: exactBankLedgerMatch }));
    setBankLedgerName(exactBankLedgerMatch);
    setBankLedgerVerified(true);
    setBankLedgerManuallyConfirmed(false);
  }, [bankLedgerChangeMode, bankLedgerName, exactBankLedgerMatch, preview]);

  const uploadContextReady = Boolean(selectedCompanyId && tallyCompanyContextVerified);
  const workflowStep = preview ? 3 : documentPreview ? 1 : loading ? 2 : 0;
  const setupErrorMessage = !selectedCompanyId || !selectedCompanyName
    ? "Select the Tally company first."
    : !tallyConnectionId
      ? "Select the Tally company first."
    : !tallyConnected
      ? "Open Tally Prime, load the company, then refresh the connection."
      : !activeTallyCompanyName
        ? "Refresh Gajkesari to confirm the company currently open in Tally."
        : !tallyCompanyContextVerified
          ? `Tally is open to ${activeTallyCompanyName}. Switch Tally Prime to ${selectedCompanyName}, then refresh.`
          : "";
  const syncModeStatus = useMemo(() => {
    const stateLabel = "Fresh Tally sync before analysis";
    const readyText = "The latest ledgers will be fetched from the current Tally company before statement analysis starts.";

    if (!tallyConnectionId || !selectedCompanyName) {
      return {
        tone: "warning" as const,
        title: stateLabel,
        text: "Sync cannot run until you select a Tally company.",
      };
    }

    if (!tallyConnected) {
      return {
        tone: "warning" as const,
        title: stateLabel,
        text: "Sync cannot run because the connector or Tally is not reachable. Open Tally Prime, load the company, then refresh.",
      };
    }

    if (!activeTallyCompanyName) {
      return {
        tone: "warning" as const,
        title: stateLabel,
        text: "Refresh Gajkesari to confirm the company currently open in Tally before upload.",
      };
    }

    if (!tallyCompanyContextVerified) {
      return {
        tone: "warning" as const,
        title: stateLabel,
        text: `Tally is open to ${activeTallyCompanyName}. Switch Tally Prime to ${selectedCompanyName}, then refresh before analysis.`,
      };
    }

    return {
      tone: "success" as const,
      title: stateLabel,
      text: readyText,
    };
  }, [
    activeTallyCompanyName,
    selectedCompanyName,
    tallyCompanyContextVerified,
    tallyConnected,
    tallyConnectionId,
  ]);
  const pendingBillEligibleTransactions = useMemo(
    () => validTransactions.filter(
      (transaction) =>
        isBillMatchEligibleTransaction(transaction, ledgerMasters) &&
        tallyPresenceByTransactionId[transaction.id]?.status !== "found"
    ),
    [ledgerMasters, tallyPresenceByTransactionId, validTransactions]
  );
  const uncheckedTallyPresenceCount = validTransactions.filter((transaction) => {
    const status = tallyPresenceByTransactionId[transaction.id]?.status;
    return status !== "found" && status !== "missing" && status !== "ambiguous";
  }).length;
  const ambiguousTallyPresenceCount = validTransactions.filter(
    (transaction) => tallyPresenceByTransactionId[transaction.id]?.status === "ambiguous"
  ).length;
  const transactionsNeedingTallyWork = useMemo(
    () => validTransactions.filter((transaction) => {
      const status = tallyPresenceByTransactionId[transaction.id]?.status;
      if (status === "found" || status === "ambiguous") return false;
      return tallyCheckAttempted ? status === "missing" : true;
    }),
    [tallyCheckAttempted, tallyPresenceByTransactionId, validTransactions]
  );
  const receiptTransactionsNeedingPost = useMemo(
    () => transactionsNeedingTallyWork.filter(isIncomingReceiptRow),
    [transactionsNeedingTallyWork]
  );
  const outgoingTransactionsNeedingPost = useMemo(
    () => transactionsNeedingTallyWork.filter(isOutgoingPaymentRow),
    [transactionsNeedingTallyWork]
  );
  const readyPostingTransactions = useMemo(() => validTransactions.filter((transaction) =>
    isReadyForTallyPosting({
      ledgerName: transaction.selectedLedgerName,
      ledgerNeedsReview: getReviewStatus(transaction) === "needs_review",
      presence: tallyPresenceByTransactionId[transaction.id],
      billRequired: isBillMatchEligibleTransaction(transaction, ledgerMasters),
      amount: Math.max(parseNumber(transaction.creditAmount) ?? 0, parseNumber(transaction.debitAmount) ?? 0),
      allocation: billAllocationsByTransactionId[transaction.id],
    })
  ), [validTransactions, tallyPresenceByTransactionId, ledgerMasters, billAllocationsByTransactionId]);
  const readyReceiptTransactions = readyPostingTransactions.filter(isIncomingReceiptRow);
  const readyPaymentTransactions = readyPostingTransactions.filter(isOutgoingPaymentRow);
  const readyPostingIds = useMemo(() => new Set(readyPostingTransactions.map((row) => row.id)), [readyPostingTransactions]);
  const newReceiptCount = readyReceiptTransactions.length;
  const missingOutgoingCount = readyPaymentTransactions.length;
  const heldPostingRowCount = validTransactions.filter((transaction) =>
    tallyPresenceByTransactionId[transaction.id]?.status !== "found" &&
    !readyPostingIds.has(transaction.id)
  ).length;
  const statementCompletedCleanly = Boolean(
    statementDoneSummary && statementDoneSummary.tone !== "error"
  );
  const alreadyInTallyCount = validTransactions.filter(
    (transaction) => tallyPresenceByTransactionId[transaction.id]?.status === "found"
  ).length;
  const blockingBillAllocationCount = useMemo(
    () =>
      pendingBillEligibleTransactions.filter((transaction) => {
        const draft = billAllocationsByTransactionId[transaction.id];
        return !draft || draft.status === "cannot_match_yet" || draft.status === "needs_review" || draft.status === "stale_data";
      }).length,
    [billAllocationsByTransactionId, pendingBillEligibleTransactions]
  );
  const blockingReceiptBillAllocationTransactions = useMemo(() => {
    if (!tallyCheckAttempted) return [];
    return receiptTransactionsNeedingPost.filter((transaction) => {
        if (!isBillMatchEligibleTransaction(transaction, ledgerMasters)) return false;
        const draft = billAllocationsByTransactionId[transaction.id];
        return !draft || draft.status === "cannot_match_yet" || draft.status === "needs_review" || draft.status === "stale_data";
      });
  },
    [billAllocationsByTransactionId, ledgerMasters, receiptTransactionsNeedingPost, tallyCheckAttempted]
  );
  const blockingPaymentBillAllocationTransactions = useMemo(() => {
    if (!tallyCheckAttempted) return [];
    return outgoingTransactionsNeedingPost.filter((transaction) => {
        if (!isBillMatchEligibleTransaction(transaction, ledgerMasters)) return false;
        const draft = billAllocationsByTransactionId[transaction.id];
        return !draft || draft.status === "cannot_match_yet" || draft.status === "needs_review" || draft.status === "stale_data";
      });
  },
    [billAllocationsByTransactionId, ledgerMasters, outgoingTransactionsNeedingPost, tallyCheckAttempted]
  );
  const blockingPaymentBillAllocationCount = blockingPaymentBillAllocationTransactions.length;
  const partyBillAllocationReviewTransactions = useMemo(
    () =>
      transactionsNeedingTallyWork.filter((transaction) =>
        isBillMatchEligibleTransaction(transaction, ledgerMasters)
      ),
    [ledgerMasters, transactionsNeedingTallyWork]
  );
  const transactionOutcomeCounts = useMemo(() => {
    const counts = {
      alreadyInTally: 0,
      receiptsToCreate: 0,
      paymentsToCreate: 0,
      needsAttention: 0,
    };

    for (const transaction of validTransactions) {
      const presence = tallyPresenceByTransactionId[transaction.id];
      const isIncoming = isIncomingReceiptRow(transaction);
      const isOutgoing = isOutgoingPaymentRow(transaction);
      if (presence?.status === "found") {
        counts.alreadyInTally += 1;
      } else if (isIncoming && readyPostingIds.has(transaction.id)) {
        counts.receiptsToCreate += 1;
      } else if (isOutgoing && readyPostingIds.has(transaction.id)) {
        counts.paymentsToCreate += 1;
      } else {
        counts.needsAttention += 1;
      }
    }

    return counts;
  }, [
    readyPostingIds,
    tallyPresenceByTransactionId,
    validTransactions,
  ]);
  const reviewWorkStatusCounts = useMemo(() => {
    const counts = { needsAction: 0, ready: 0, completed: 0 };
    for (const transaction of validTransactions) {
      const completed = tallyPresenceByTransactionId[transaction.id]?.status === "found";
      if (completed) counts.completed += 1;
      else if (getReviewStatus(transaction) === "needs_review") counts.needsAction += 1;
      else if (getReviewStatus(transaction) === "matched") counts.ready += 1;
    }
    return counts;
  }, [tallyPresenceByTransactionId, validTransactions]);
  const filteredTransactions = useMemo(() => {
    const normalizedSearch = normalizeName(reviewSearch);
    return validTransactions.filter((transaction) => {
      const ledgerReview = getLedgerReviewFilterValue(transaction);
      const tallyResult = getTallyResultFilterValue(tallyPresenceByTransactionId[transaction.id]);
      const completed = tallyPresenceByTransactionId[transaction.id]?.status === "found";
      const workStatus: Exclude<ReviewWorkStatusFilter, "all"> | null = completed
        ? "completed"
        : getReviewStatus(transaction) === "needs_review"
          ? "needs_action"
          : getReviewStatus(transaction) === "matched"
            ? "ready"
            : null;
      if (reviewWorkStatusFilter !== "all" && workStatus !== reviewWorkStatusFilter) {
        return false;
      }
      if (reviewTallyResultFilter !== "all" && tallyResult !== reviewTallyResultFilter) {
        return false;
      }
      if (reviewLedgerFilter !== "all" && ledgerReview !== reviewLedgerFilter) {
        return false;
      }
      if (reviewDirectionFilter === "debit" && (parseNumber(transaction.debitAmount) ?? 0) <= 0) {
        return false;
      }
      if (reviewDirectionFilter === "credit" && (parseNumber(transaction.creditAmount) ?? 0) <= 0) {
        return false;
      }
      const effectiveDate = getEffectiveTransactionDate(transaction);
      if (reviewDateFrom && effectiveDate < reviewDateFrom) {
        return false;
      }
      if (reviewDateTo && effectiveDate > reviewDateTo) {
        return false;
      }
      if (
        tallyCheckAttempted &&
        reviewAllocationFilter !== "all" &&
        getReceiptAllocationFilterValue(
          transaction,
          ledgerMasters,
          billAllocationsByTransactionId[transaction.id]
        ) !== reviewAllocationFilter
      ) {
        return false;
      }

      if (!normalizedSearch) return true;

      const searchable = [
        effectiveDate,
        transaction.description,
        transaction.referenceNumber,
        transaction.transactionType,
        transaction.category,
        transaction.counterpartyName,
        transaction.suggestedLedgerName,
        transaction.selectedLedgerName,
        transaction.ledgerGroup,
        getLedgerGroupLabel(transaction, ledgerMasters),
        ...transaction.candidateLedgerNames,
        transaction.debitAmount,
        transaction.creditAmount,
        getTransactionPartyTitle(transaction),
      ].join(" ");
      return normalizeName(searchable).includes(normalizedSearch);
    });
  }, [
    billAllocationsByTransactionId,
    ledgerMasters,
    reviewAllocationFilter,
    reviewDateFrom,
    reviewDateTo,
    reviewDirectionFilter,
    reviewLedgerFilter,
    reviewSearch,
    reviewTallyResultFilter,
    reviewWorkStatusFilter,
    tallyCheckAttempted,
    tallyPresenceByTransactionId,
    validTransactions,
  ]);
  const filteredTransactionIndexById = useMemo(
    () => new Map(filteredTransactions.map((transaction, index) => [transaction.id, index])),
    [filteredTransactions]
  );
  const visibleReviewTransactions = useMemo(
    () => {
      const start = (reviewPage - 1) * rowsPerPage;
      return filteredTransactions.filter(transactionIsValid).slice(start, start + rowsPerPage);
    },
    [filteredTransactions, reviewPage, rowsPerPage]
  );
  const reviewPageCount = Math.max(1, Math.ceil(filteredTransactions.length / rowsPerPage));
  const reviewRangeStart =
    visibleReviewTransactions.length === 0 ? 0 : (reviewPage - 1) * rowsPerPage + 1;
  const reviewRangeEnd =
    visibleReviewTransactions.length === 0
      ? 0
      : Math.min(reviewRangeStart + visibleReviewTransactions.length - 1, filteredTransactions.length);
  const tallyPostingInProgress = Boolean(tallyPostingStatus && !tallyPostingStatus.finished);
  const bankPostingCompleted = Boolean(
    statementCompletedCleanly &&
      tallyPostingStatus?.finished &&
      tallyPostingStatus.voucherTotal > 0
  );
  const statementReconciliationCompleted =
    bankPostingCompleted &&
    transactionOutcomeCounts.needsAttention === 0 &&
    transactionOutcomeCounts.receiptsToCreate === 0 &&
    transactionOutcomeCounts.paymentsToCreate === 0;
  const selectedPostingTransactions = tallyPostingScope === "receipts"
    ? readyReceiptTransactions
    : tallyPostingScope === "payments"
      ? readyPaymentTransactions
      : readyPostingTransactions;
  const selectedPostingMissingLedgerCount = selectedPostingTransactions.filter(
    (transaction) => !transaction.selectedLedgerName.trim()
  ).length;
  const selectedPostingSuspenseCount = selectedPostingTransactions.filter(
    (transaction) => isSuspenseLedgerName(transaction.selectedLedgerName)
  ).length;
  const postTallyButtonLabel = sendingMode
    ? "Sending..."
    : `Post to Tally (${selectedPostingTransactions.length})`;
  const statementReviewLocked = Boolean(statementDoneSummary) || tallyPostingInProgress;
  const statementReviewDrawerLocked = tallyPostingInProgress;
  const openPostingReviewAction = useCallback(
    (transaction: ReviewTransaction) => {
      const postingAction = getReviewPostingAction(
        transaction,
        ledgerMasters,
        tallyPresenceByTransactionId[transaction.id]
      );
      if (statementReviewDrawerLocked) return;

      setEditingLedgerIds(new Set());
      if (postingAction === "outgoing") {
        setOutgoingReviewTransactionId(transaction.id);
      } else {
        setBillAllocationReviewTransactionId(transaction.id);
      }
    },
    [ledgerMasters, statementReviewDrawerLocked, tallyPresenceByTransactionId]
  );
  const activeReviewFilterCount = [
    reviewSearch.trim(),
    reviewWorkStatusFilter !== "all" ? reviewWorkStatusFilter : "",
    reviewTallyResultFilter !== "all" ? reviewTallyResultFilter : "",
    reviewLedgerFilter !== "all" ? reviewLedgerFilter : "",
    reviewDirectionFilter !== "all" ? reviewDirectionFilter : "",
    tallyCheckAttempted && reviewAllocationFilter !== "all" ? reviewAllocationFilter : "",
    reviewDateFrom,
    reviewDateTo,
  ].filter(Boolean).length;
  useEffect(() => {
    setReviewPage(1);
  }, [
    reviewAllocationFilter,
    reviewDateFrom,
    reviewDateTo,
    reviewDirectionFilter,
    reviewLedgerFilter,
    reviewSearch,
    reviewTallyResultFilter,
    reviewWorkStatusFilter,
    rowsPerPage,
  ]);

  useEffect(() => {
    setReviewPage((current) => Math.min(current, reviewPageCount));
  }, [reviewPageCount]);

  useEffect(() => {
    if (visibleReviewTransactions.length === 0) {
      selectReviewTransaction(null);
      return;
    }
    const current = activeReviewTransactionIdRef.current;
    selectReviewTransaction(
      current && visibleReviewTransactions.some((transaction) => transaction.id === current)
        ? current
        : visibleReviewTransactions[0].id
    );
  }, [selectReviewTransaction, visibleReviewTransactions]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
      );
    }

    function isInteractiveTarget(target: EventTarget | null) {
      return target instanceof HTMLElement && Boolean(target.closest("button, a, [role='button']"));
    }

    function handleReviewShortcut(event: KeyboardEvent) {
      if (!preview) {
        if (event.key === "Escape" && shortcutsOpen) {
          event.preventDefault();
          setShortcutsOpen(false);
        }
        return;
      }

      if (event.key === "Escape") {
        if (shortcutsOpen) {
          event.preventDefault();
          setShortcutsOpen(false);
        } else if (billAllocationReviewTransactionId) {
          event.preventDefault();
          const draft = billAllocationsByTransactionId[billAllocationReviewTransactionId];
          if (draft && (draft.requiresUserReview || Math.abs(draft.unallocatedAmount) >= 0.01)) {
            const toastId =
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `${Date.now()}-allocation-close`;
            const closeWarning: ToastMessage = {
              id: toastId,
              tone: "info",
              text: "This allocation is incomplete. Choose Close to leave it for later.",
            };
            setToasts((current) => [...current, closeWarning].slice(-3));
            window.setTimeout(
              () => setToasts((current) => current.filter((toast) => toast.id !== toastId)),
              5000
            );
          } else {
            setBillAllocationReviewTransactionId(null);
          }
        } else if (outgoingReviewTransactionId) {
          event.preventDefault();
          setOutgoingReviewTransactionId(null);
        } else if (editingLedgerIds.size > 0) {
          event.preventDefault();
          setEditingLedgerIds(new Set());
        } else if (reviewFiltersOpen) {
          event.preventDefault();
          setReviewFiltersOpen(false);
        } else if (bankLedgerChangeMode) {
          event.preventDefault();
          cancelBankLedgerChange();
        }
        return;
      }

      if (shortcutsOpen || billAllocationReviewTransactionId || outgoingReviewTransactionId) return;

      if (event.altKey && event.key === "F2") {
        event.preventDefault();
        setReviewFiltersOpen(true);
        window.requestAnimationFrame(() => reviewPeriodInputRef.current?.focus());
        return;
      }

      if (event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setReviewFiltersOpen(true);
        window.requestAnimationFrame(() => reviewSearchInputRef.current?.focus());
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setReviewFiltersOpen((current) => !current);
        return;
      }

      if (isTypingTarget(event.target) || isInteractiveTarget(event.target)) return;

      if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) {
        if (filteredTransactions.length === 0) return;
        event.preventDefault();
        const currentIndex = activeReviewTransactionIdRef.current
          ? filteredTransactionIndexById.get(activeReviewTransactionIdRef.current) ?? -1
          : -1;
        let nextIndex = currentIndex < 0 ? 0 : currentIndex;
        if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = filteredTransactions.length - 1;
        else if (event.key === "ArrowDown") nextIndex += 1;
        else if (event.key === "ArrowUp") nextIndex -= 1;
        else if (event.key === "PageDown") nextIndex += rowsPerPage;
        else if (event.key === "PageUp") nextIndex -= rowsPerPage;
        nextIndex = Math.min(Math.max(nextIndex, 0), filteredTransactions.length - 1);
        const nextTransaction = filteredTransactions[nextIndex];
        selectReviewTransaction(nextTransaction.id);
        const nextPage = Math.floor(nextIndex / rowsPerPage) + 1;
        setReviewPage((current) => (current === nextPage ? current : nextPage));
        scrollReviewTransactionIntoView(nextTransaction.id);
        return;
      }

      const activeTransactionId = activeReviewTransactionIdRef.current;
      if (event.key === "Enter" && activeTransactionId) {
        const activeIndex = filteredTransactionIndexById.get(activeTransactionId);
        const activeTransaction = activeIndex === undefined ? null : filteredTransactions[activeIndex];
        if (!activeTransaction) return;
        event.preventDefault();
        setExpandedNarrationTransactionId(null);
        if (event.ctrlKey || event.metaKey) {
          if (!statementReviewLocked) {
            setReviewActionStage("ledger");
            setEditingLedgerIds(new Set([activeTransactionId]));
          }
          return;
        }
        if (reviewActionStage === "ledger") {
          if (!statementReviewLocked) setEditingLedgerIds(new Set([activeTransactionId]));
          return;
        }
        openPostingReviewAction(activeTransaction);
      }
    }

    window.addEventListener("keydown", handleReviewShortcut);
    return () => window.removeEventListener("keydown", handleReviewShortcut);
  }, [
    bankLedgerChangeMode,
    billAllocationsByTransactionId,
    billAllocationReviewTransactionId,
    editingLedgerIds,
    filteredTransactionIndexById,
    filteredTransactions,
    openPostingReviewAction,
    outgoingReviewTransactionId,
    preview,
    reviewFiltersOpen,
    rowsPerPage,
    reviewActionStage,
    scrollReviewTransactionIntoView,
    selectReviewTransaction,
    shortcutsOpen,
    statementReviewLocked,
  ]);
  const billAllocationReviewTransaction = billAllocationReviewTransactionId
    ? validTransactions.find((transaction) => transaction.id === billAllocationReviewTransactionId) ?? null
    : null;
  const billAllocationReviewDraft = billAllocationReviewTransaction
    ? billAllocationsByTransactionId[billAllocationReviewTransaction.id] ?? null
    : null;
  const billAllocationReviewIsPayment = billAllocationReviewTransaction
    ? isOutgoingPaymentRow(billAllocationReviewTransaction)
    : false;
  const billAllocationReviewIndex = billAllocationReviewTransaction
    ? partyBillAllocationReviewTransactions.findIndex(
        (transaction) => transaction.id === billAllocationReviewTransaction.id
      )
    : -1;
  const filteredBillAllocationCandidates = useMemo(() => {
    const bills = billAllocationReviewDraft?.candidateBills ?? [];
    const query = normalizeName(billAllocationSearch);
    if (!query) return bills;
    return bills.filter((bill) =>
      [
        bill.referenceName,
        bill.voucherNumber,
        bill.invoiceDate,
        bill.dueDate,
        bill.originalAmount,
        String(bill.pendingAmount),
      ]
        .filter(Boolean)
        .some((value) => normalizeName(String(value)).includes(query))
    );
  }, [billAllocationReviewDraft, billAllocationSearch]);
  useEffect(() => {
    setBillAllocationSearch("");
    setConfirmFullAdvance(false);
  }, [billAllocationReviewTransactionId]);
  const outgoingReviewTransaction = outgoingReviewTransactionId
    ? validTransactions.find((transaction) => transaction.id === outgoingReviewTransactionId) ?? null
    : null;
  const tallyResultReviewDraft = outgoingReviewTransaction
    ? tallyPresenceByTransactionId[outgoingReviewTransaction.id] ??
      outgoingVerificationsByTransactionId[outgoingReviewTransaction.id] ??
      null
    : null;
  const tallyResultReviewIsIncoming = outgoingReviewTransaction
    ? isIncomingReceiptRow(outgoingReviewTransaction)
    : false;
  const tallyResultReviewIsDirectReceipt = Boolean(
    outgoingReviewTransaction &&
      tallyResultReviewIsIncoming &&
      !isBillMatchEligibleTransaction(outgoingReviewTransaction, ledgerMasters)
  );
  const tallyResultReviewDirection = tallyResultReviewIsIncoming ? "receipt" : "payment";
  const tallyResultReviewAmount = outgoingReviewTransaction
    ? tallyResultReviewIsIncoming
      ? outgoingReviewTransaction.creditAmount
      : outgoingReviewTransaction.debitAmount
    : 0;
  const tallyResultReviewPostingVoucherType = (() => {
    if (!outgoingReviewTransaction) return "Receipt";
    return getProposedBankVoucherType(outgoingReviewTransaction, ledgerMasters) || "Receipt";
  })();
  const tallyResultReviewReason = (() => {
    if (outgoingReviewTransaction && tallyResultReviewIsDirectReceipt) {
      return "Bill matching is not applicable for this ledger. This receipt is ready to post directly as a Receipt voucher.";
    }
    if (!outgoingReviewTransaction || !tallyResultReviewDraft) {
      return `Run Check Tally Matches to verify this ${tallyResultReviewDirection} against Tally.`;
    }
    if (tallyResultReviewDraft.status === "found") {
      const genericOutgoingReason = "Existing outgoing entry was found in Tally.";
      if (!tallyResultReviewDraft.reason || (tallyResultReviewIsIncoming && tallyResultReviewDraft.reason === genericOutgoingReason)) {
        return `This ${tallyResultReviewDirection} matches an existing Tally voucher. No action is required.`;
      }
    }
    return tallyResultReviewDraft.reason;
  })();
  const tallyResultReviewEvidence: OutgoingMatchCandidate[] = tallyResultReviewDraft?.matches?.length
    ? tallyResultReviewDraft.matches
    : tallyResultReviewDraft?.status === "found" &&
        (tallyResultReviewDraft.voucherNumber || tallyResultReviewDraft.voucherDate)
      ? [{
          reasons: [],
          date: tallyResultReviewDraft.voucherDate,
          voucherNumber: tallyResultReviewDraft.voucherNumber,
          partyLedgerName: outgoingReviewTransaction?.selectedLedgerName || null,
          ledgerNames: outgoingReviewTransaction?.selectedLedgerName
            ? [outgoingReviewTransaction.selectedLedgerName]
            : [],
        }]
      : [];

  const loadTallyConnections = useCallback(async () => {
    const response = await apiFetch("/api/tally/connections", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const payload = (await response.json()) as { connections?: TallyConnection[] };
    const loadedConnections = payload.connections ?? [];
    const preferredConnectionId = readPreferredTallyConnectionId();
    const preferredConnection =
      loadedConnections.find((connection) => connection.id === preferredConnectionId) ??
      getRelevantTallyConnections(loadedConnections)[0];
    setConnections(loadedConnections);
    setTallyConnectionId((current) => {
      if (current && loadedConnections.some((connection) => connection.id === current)) {
        return current;
      }
      return preferredConnection?.id || "";
    });
    return loadedConnections;
  }, []);

  const loadCompanyOptions = useCallback(async (requestedConnectionId?: string) => {
    const connectionId =
      requestedConnectionId?.trim() ||
      readPreferredTallyConnectionId() ||
      tallyConnectionId;
    if (!connectionId) {
      setCompanies([]);
      setSelectedCompanyId("");
      return [];
    }

    const response = await apiFetch(
      `/api/tally/companies?connectionId=${encodeURIComponent(connectionId)}`,
      { cache: "no-store" }
    );
    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const payload = (await response.json()) as { companies?: CompanyOption[]; selectedCompanyId?: string | null };
    const fetchedCompanies = uniqueCompanyOptions(payload.companies ?? []);
    const nextCompanies = fetchedCompanies;
    if (fetchedCompanies.length > 0) {
      lastNonEmptyCompaniesRef.current = fetchedCompanies;
    }
    setCompanies(nextCompanies);
    const storedCompany = findStoredCompanySelection(nextCompanies);
    setSelectedCompanyId((current) => {
      if (current && nextCompanies.some((company) => company.id === current)) {
        return current;
      }
      return storedCompany?.id ?? "";
    });
    setTallyConnectionId((current) => {
      const selectedOption =
        nextCompanies.find((company) => company.id === selectedCompanyId) ?? storedCompany ?? null;
      if (selectedOption) return selectedOption.connectionId;
      if (current && nextCompanies.some((company) => company.connectionId === current)) return current;
      return current;
    });
    return nextCompanies;
  }, [selectedCompanyId, tallyConnectionId]);

  const loadLedgerMasters = useCallback(async (connectionId: string) => {
    const loadSeq = ledgerLoadSeqRef.current + 1;
    ledgerLoadSeqRef.current = loadSeq;

    if (!connectionId) {
      if (loadSeq === ledgerLoadSeqRef.current) {
        setLedgerMasters([]);
      }
      return [];
    }

    const connectionCompany = companyOptions.find((option) => option.connectionId === connectionId);
    const payload = await runCashDiscountLiveRequest<{
      ledgers?: TallyMaster[];
      groups?: TallyMaster[];
    }>({
      connectionId,
      companyName: selectedCompanyName || connectionCompany?.companyName || "",
      operation: "ledger_masters",
      payload: {
        requestedMasterTypes: ["ledger", "group"],
        fieldProfile: "bank_statement",
      },
    });
    const masters = normalizeLiveLedgerMasters(payload.ledgers ?? [], payload.groups ?? []);
    if (loadSeq === ledgerLoadSeqRef.current) {
      setLedgerMasters(masters);
    }
    return masters;
  }, [companyOptions, selectedCompanyName]);

  useEffect(() => {
    if (!tallyConnectionId) {
      setCheckingLiveTallyCompany(false);
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let inFlight = false;
    const controller = new AbortController();
    tallyStatusStartedAtRef.current = Date.now();
    setCheckingLiveTallyCompany(true);

    const pollLiveCompany = async () => {
      if (inFlight || cancelled) return false;
      inFlight = true;
      try {
        const response = await apiFetch(`/api/tally/connections/${tallyConnectionId}/status`, { cache: "no-store", signal: controller.signal });
        if (!response.ok || cancelled) return false;
        const payload = (await response.json()) as { connection?: TallyConnection };
        const connection = payload.connection;
        if (!connection) return false;
        setConnections((current) => current.map((item) => (item.id === connection.id ? connection : item)));

        const updatedAt = connection.lastHeartbeatAt ? Date.parse(connection.lastHeartbeatAt) : Number.NaN;
        if (Number.isFinite(updatedAt) && Date.now() - updatedAt < 45_000) {
          setCheckingLiveTallyCompany(false);
          return true;
        }
      } catch {
        // Do not present a stale company as the active Tally company.
      } finally {
        inFlight = false;
      }
      return false;
    };

    void pollLiveCompany();
    const timer = window.setInterval(() => {
      attempts += 1;
      void pollLiveCompany().then((fresh) => {
        if (fresh || attempts >= 5) window.clearInterval(timer);
      });
    }, 3000);
    const deadlineTimer = window.setTimeout(() => {
      if (cancelled) return;
      controller.abort();
      window.clearInterval(timer);
      setCheckingLiveTallyCompany(false);
    }, 15_000);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(deadlineTimer);
      window.clearInterval(timer);
    };
  }, [tallyConnectionId]);
  useEffect(() => () => matchAbortRef.current?.abort(), [tallyConnectionId, selectedCompanyId]);

  const waitForCommand = useCallback(
    async (
      connectionId: string,
      commandId: string,
      options?: { attempts?: number; intervalMs?: number }
    ) => {
    const attempts = options?.attempts ?? 45;
    const intervalMs = options?.intervalMs ?? 2000;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await wait(intervalMs);
      const response = await apiFetch(
        `/api/tally/connections/${connectionId}/commands?${new URLSearchParams({
          ids: commandId,
          limit: "1",
        }).toString()}`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const payload = (await response.json()) as { commands?: TallyCommand[] };
      const command = (payload.commands ?? []).find((item) => item.id === commandId);
      if (!command) continue;
      if (command.reconciliationRequired) {
        throw new Error(command.error || "The Tally result is uncertain. Check Tally before retrying; this command will not be replayed automatically.");
      }
      if (command.status === "succeeded" || command.status === "failed" || command.status === "canceled") {
        return command;
      }
    }

    return null;
  }, []);

  async function fetchTallyBankLedgersForCompanies(
    connectionId: string,
    companyNames: string[],
    options?: { quiet?: boolean }
  ) {
    const cleanCompanyNames = Array.from(
      new Set(companyNames.map((name) => name.trim()).filter(Boolean))
    );
    if (!connectionId || cleanCompanyNames.length === 0) return null;

    try {
      setLoadingBankLedgers(true);
      const requestedCompanyName = selectedCompanyName || cleanCompanyNames[0] || "";
      const payload = await runCashDiscountLiveRequest<LiveBankLedgerResult>({
        connectionId,
        companyName: requestedCompanyName,
        companyNames: [requestedCompanyName],
        operation: "bank_ledgers",
        onProgress: (message) => {
          if (!options?.quiet) setBanner({ tone: "info", text: message });
        },
      });
      const returnedCompanyName = String(payload.companyName || requestedCompanyName).trim();
      const returnedLedgers = payload.byCompany?.[returnedCompanyName] ?? payload.bankLedgers ?? [];
      const byCompany = { [returnedCompanyName]: returnedLedgers } as Record<string, LocalBankLedger[]>;
      const firstError = payload.errors?.find((item) => item.error)?.error;
      if (returnedLedgers.length === 0 && firstError) throw new Error(firstError);
      setTallyBankLedgersByCompany((current) => ({
        ...current,
        ...byCompany,
      }));

      if (!options?.quiet) {
        const count = Object.values(byCompany).reduce((total, ledgers) => total + ledgers.length, 0);
        setBanner({
          tone: "success",
          text: count > 0 ? "Bank accounts refreshed from Tally." : "No Tally bank accounts were returned.",
        });
      }

      return byCompany;
    } catch (error) {
      if (!options?.quiet) {
        setBanner({
          tone: "error",
          text: error instanceof Error ? error.message : "Could not fetch Tally bank accounts.",
        });
      }
      return null;
    } finally {
      setLoadingBankLedgers(false);
    }
  }

  const clearStatementReview = useCallback((options?: { preserveSelectedFile?: boolean }) => {
    setPreview(null);
    setAnalysisEngineSource(null);
    setTransactions([]);
    setReviewPage(1);
    if (!options?.preserveSelectedFile) {
      setFile(null);
      setDocumentPreview(null);
      setDocumentPreviewLoading(false);
    }
    setAccount(EMPTY_ACCOUNT);
    setBankLedgerName("");
    setBankLedgerVerified(false);
    setBankLedgerManuallyConfirmed(false);
    setSelectedAccountId("");
    setBankLedgerChangeMode(false);
    setPendingBankLedgerName("");
    setEditingLedgerIds(new Set());
    setBanner(null);
    setPostUploadSyncImportId(null);
    setPostUploadSyncError(null);
    setTallyPostingStatus(null);
    setStatementDoneSummary(null);
    setBillAllocationsByTransactionId({});
    setOutgoingVerificationsByTransactionId({});
    setTallyPresenceByTransactionId({});
    setPostedTransactionIds(new Set());
    setTallyBalanceProof(null);
    setTallyCheckAttempted(false);
    selectReviewTransaction(null);
    setBillAllocationReviewTransactionId(null);
    setOutgoingReviewTransactionId(null);
  }, [selectReviewTransaction]);
  const pollTallyPostingStatus = useCallback(async (connectionId: string, commandIds: string[]) => {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await wait(2000);

      const commandChunks = await Promise.all(
        chunkValues(commandIds, 80).map(async (chunk) => {
          const response = await apiFetch(
            `/api/tally/connections/${connectionId}/commands?${new URLSearchParams({
              ids: chunk.join(","),
              limit: String(chunk.length),
            }).toString()}`,
            { cache: "no-store" }
          );
          if (!response.ok) {
            throw new Error(await readError(response));
          }
          const payload = (await response.json()) as { commands?: TallyCommand[] };
          return payload.commands ?? [];
        })
      );
      const nextStatus = buildTallyPostingStatus(connectionId, commandIds, commandChunks.flat());
      setTallyPostingStatus(nextStatus);

      if (nextStatus.finished) {
        if (nextStatus.failed > 0 || nextStatus.canceled > 0) {
          setStatementDoneSummary({
            tone: "error",
            title: "Done with issues.",
            text: `${nextStatus.voucherCompleted}/${nextStatus.voucherTotal} bank voucher action(s) and ${nextStatus.paymentCheckCompleted}/${nextStatus.paymentCheckTotal} payment check(s) completed. Review the failed work before retrying.`,
          });
          showToast(
            "error",
            `${nextStatus.failed + nextStatus.canceled} Tally operation(s) failed or were canceled.`
          );
        } else {
          const checksOnly = nextStatus.voucherTotal === 0 && nextStatus.paymentCheckTotal > 0;
          setStatementDoneSummary({
            tone: "success",
            title: checksOnly ? "Payment checks completed." : "Tally work completed.",
            text: checksOnly
              ? `${nextStatus.paymentCheckCompleted} outgoing payment check(s) completed. No Tally vouchers were created.`
              : `${nextStatus.voucherCompleted} bank voucher action(s) and ${nextStatus.paymentCheckCompleted} outgoing payment check(s) completed.`,
          });
          setBanner({
            tone: "success",
            text: checksOnly
              ? `${nextStatus.paymentCheckCompleted} outgoing payment check(s) completed. No Tally entries were created.`
              : `${nextStatus.voucherCompleted} bank voucher action(s) and ${nextStatus.paymentCheckCompleted} payment check(s) completed.`,
          });
          showToast(
            "success",
            checksOnly
              ? `${nextStatus.paymentCheckCompleted} payment check(s) completed; no entries created.`
              : `${nextStatus.voucherCompleted} bank voucher action(s) completed.`
          );
        }
        return nextStatus;
      }
    }

    showToast("info", "Tally work is still running. Keep the connector open.");
    return null;
  }, []);

  const readTallyQueueJob = useCallback(async (jobId: string): Promise<TallyQueueJobResponse> => {
    const response = await apiFetch(`/api/bank-statements/tally/queue-jobs/${jobId}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    return (await response.json()) as TallyQueueJobResponse;
  }, []);

  const pollTallyQueueJob = useCallback(async (jobId: string): Promise<TallyQueueResult> => {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const payload = await readTallyQueueJob(jobId);
      const job = payload.job;
      if (job?.status === "succeeded") {
        return (payload.result ?? job.result ?? { queuedCount: 0, verificationCount: 0, commands: [] }) as TallyQueueResult;
      }
      if (job?.status === "failed" || job?.status === "cancelled") {
        throw new Error(job.error || payload.error || "Tally queue job failed.");
      }

      const processed = Number(job?.processedCount ?? 0);
      const total = Number(job?.totalCount ?? 0);
      setBanner({
        tone: "info",
        text: total > 0 ? `Preparing Tally queue: ${Math.min(processed, total)} of ${total} transaction(s).` : "Preparing Tally queue.",
      });
      await wait(1500);
    }

    throw new Error("Tally queue preparation is still running. Keep the connector open and try refreshing in a moment.");
  }, [readTallyQueueJob]);

  useEffect(() => {
    if (initialSummaryLoadStartedRef.current) return;
    initialSummaryLoadStartedRef.current = true;

    let cancelled = false;

    async function loadSummary() {
      const [importsResponse, accountsResponse, loadedConnections] = await Promise.all([
        apiFetch("/api/bank-statements/imports", { cache: "no-store" }),
        apiFetch("/api/bank-statements/accounts", { cache: "no-store" }),
        loadTallyConnections(),
      ]);

      const preferredConnectionId = readPreferredTallyConnectionId();
      const requestedConnection =
        loadedConnections.find((connection) => connection.id === preferredConnectionId) ??
        loadedConnections.find((connection) => connection.id === tallyConnectionId) ??
        getRelevantTallyConnections(loadedConnections)[0];
      const loadedCompanies = requestedConnection
        ? await loadCompanyOptions(requestedConnection.id)
        : [];

      if (cancelled) return;

      if (importsResponse.ok) {
        const payload = (await importsResponse.json()) as { imports?: BankStatementImport[] };
        setRecentImports(payload.imports ?? []);
      }
      if (accountsResponse.ok) {
        const payload = (await accountsResponse.json()) as { accounts?: BankAccount[] };
        setAccounts(payload.accounts ?? []);
      }
      const preferredConnection = requestedConnection;
      const restoredCompany = findStoredCompanySelection(loadedCompanies);
      const preferredCompany = loadedCompanies.find((company) => company.id === selectedCompanyId) ?? restoredCompany;
      const nextConnectionId = preferredCompany?.connectionId || preferredConnection?.id || "";
      setSelectedCompanyId((current) =>
        current && loadedCompanies.some((company) => company.id === current) ? current : restoredCompany?.id ?? ""
      );
      setTallyConnectionId(nextConnectionId);
    }

    loadSummary().catch(() => {
      if (!cancelled) {
        setBanner({ tone: "error", text: "Could not load bank statement details." });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadCompanyOptions, loadLedgerMasters, loadTallyConnections, selectedCompanyId, tallyConnectionId]);

  useEffect(() => {
    let cancelled = false;

    if (!tallyConnectionId) {
      setLedgerMasters([]);
      return () => {
        cancelled = true;
      };
    }

    if (transactions.length === 0 || ledgerMasters.length > 0) {
      return () => {
        cancelled = true;
      };
    }

    loadLedgerMasters(tallyConnectionId).catch(() => {
      if (!cancelled) setLedgerMasters([]);
    });

    return () => {
      cancelled = true;
    };
  }, [ledgerMasters.length, loadLedgerMasters, tallyConnectionId, transactions.length]);

  useEffect(() => {
    if ((loading || sending || matchingBills || syncingMasters || postUploadSyncImportId) && selectedCompanyId) {
      return;
    }

    if (visibleConnections.length === 0 && companies.length === 0) {
      setTallyConnectionId("");
      setSelectedCompanyId("");
      return;
    }

    const currentExists =
      visibleConnections.some((connection) => connection.id === tallyConnectionId) ||
      companies.some((company) => company.connectionId === tallyConnectionId);
    const currentCompanyExists = !selectedCompanyId || companies.some((company) => company.id === selectedCompanyId);

    if (!currentExists) {
      setSelectedCompanyId("");
      setTallyConnectionId(visibleConnections[0]?.id || "");
    } else if (!currentCompanyExists) {
      setSelectedCompanyId("");
    }
  }, [
    companies,
    loading,
    matchingBills,
    postUploadSyncImportId,
    selectedCompanyId,
    sending,
    syncingMasters,
    tallyConnectionId,
    visibleConnections,
  ]);

  useEffect(() => {
    if (ledgerMasters.length === 0) return;

    setTransactions((current) =>
      current.map((transaction) => {
        const autoMatchedTransaction = autoMatchUntouchedLedgerSelection(transaction, ledgerMasters);
        if (autoMatchedTransaction !== transaction) return autoMatchedTransaction;

        if (transaction.ledgerAction === "use_suspense") {
          const suspenseLedger = findCompanySuspenseLedger(ledgerMasters);
          return suspenseLedger && transaction.selectedLedgerName !== suspenseLedger.name
            ? { ...transaction, selectedLedgerName: suspenseLedger.name, ledgerGroup: suspenseLedger.parent || "Suspense A/c" }
            : transaction;
        }

        if (
          transaction.ledgerAction === "needs_review" ||
          transaction.requiresUserConfirmation
        ) {
          return transaction;
        }

        const matchedLedger =
          findLedgerByNormalizedName(ledgerMasters, transaction.selectedLedgerName) ||
          findLedgerByNormalizedName(ledgerMasters, transaction.suggestedLedgerName);
        return matchedLedger
          ? {
              ...transaction,
              selectedLedgerName: matchedLedger.name,
              ledgerAction:
                transaction.ledgerAction === "use_standard_ledger" ? "use_standard_ledger" : "use_existing_ledger",
              requiresUserConfirmation: false,
            }
          : transaction;
      })
    );
  }, [ledgerMasters]);

  function updateLedgerSelection(id: string, selection: LedgerSelection) {
    const previousTransaction = transactions.find((transaction) => transaction.id === id);
    const ledgerIdentityChanged =
      !previousTransaction ||
      normalizeName(previousTransaction.selectedLedgerName) !== normalizeName(selection.name);

    setTransactions((current) =>
      current.map((transaction) =>
        transaction.id === id
          ? {
              ...transaction,
              selectedLedgerName: selection.name,
              ledgerAction: selection.action,
              ledgerGroup: selection.ledgerGroup || "",
              requiresUserConfirmation: false,
              ledgerSelectionTouched: true,
            }
          : transaction
      )
    );

    // Reconfirming the same ledger is part of the keyboard review flow and must
    // preserve live Tally evidence. A genuine identity change invalidates only
    // this row; other checked rows remain trustworthy and visible.
    if (!ledgerIdentityChanged) return;
    setBillAllocationsByTransactionId((current) => withoutRecordKey(current, id));
    setOutgoingVerificationsByTransactionId((current) => withoutRecordKey(current, id));
    setTallyPresenceByTransactionId((current) => withoutRecordKey(current, id));
    setPostedTransactionIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setTallyBalanceProof(null);
    setBillAllocationReviewTransactionId((current) => (current === id ? null : current));
    setOutgoingReviewTransactionId((current) => (current === id ? null : current));
  }

  function updateManualBillAmount(transaction: ReviewTransaction, referenceName: string, value: string) {
    const currentDraft = billAllocationsByTransactionId[transaction.id];
    if (!currentDraft) return;

    const nextAmount = Math.max(0, parseNumber(value) ?? 0);
    const billAmounts = Object.fromEntries(
      currentDraft.allocations
        .filter((line) => line.referenceType === "Agst Ref")
        .map((line) => [line.referenceName, line.allocatedAmount])
    );
    billAmounts[referenceName] = nextAmount;

    setBillAllocationsByTransactionId((current) => ({
      ...current,
      [transaction.id]: buildManualAllocationDraft(
        transaction,
        currentDraft,
        billAmounts,
        currentDraft.newAdvanceAmount
      ),
    }));
  }

  function updateManualAdvanceAmount(transaction: ReviewTransaction, value: string) {
    const currentDraft = billAllocationsByTransactionId[transaction.id];
    if (!currentDraft) return;

    const nextAdvanceAmount = Math.max(0, parseNumber(value) ?? 0);
    const billAmounts = Object.fromEntries(
      currentDraft.allocations
        .filter((line) => line.referenceType === "Agst Ref")
        .map((line) => [line.referenceName, line.allocatedAmount])
    );

    setBillAllocationsByTransactionId((current) => ({
      ...current,
      [transaction.id]: buildManualAllocationDraft(
        transaction,
        currentDraft,
        billAmounts,
        nextAdvanceAmount
      ),
    }));
  }

  function allocateRemainingToBill(transaction: ReviewTransaction, referenceName: string) {
    const currentDraft = billAllocationsByTransactionId[transaction.id];
    if (!currentDraft) return;

    const otherBillTotal = currentDraft.allocations
      .filter((line) => line.referenceType === "Agst Ref" && line.referenceName !== referenceName)
      .reduce((sum, line) => sum + line.allocatedAmount, 0);
    const availableAmount = Math.max(
      0,
      currentDraft.receiptAmount - otherBillTotal - currentDraft.newAdvanceAmount
    );
    const bill = currentDraft.candidateBills.find((candidate) => candidate.referenceName === referenceName);
    updateManualBillAmount(
      transaction,
      referenceName,
      String(Math.min(availableAmount, Math.max(0, bill?.pendingAmount ?? 0)))
    );
  }

  function clearManualAllocations(transaction: ReviewTransaction) {
    const currentDraft = billAllocationsByTransactionId[transaction.id];
    if (!currentDraft) return;
    setBillAllocationsByTransactionId((current) => ({
      ...current,
      [transaction.id]: buildManualAllocationDraft(transaction, currentDraft, {}, 0),
    }));
  }

  function redistributeAllocationFifo(transaction: ReviewTransaction) {
    const currentDraft = billAllocationsByTransactionId[transaction.id];
    if (!currentDraft) return;
    const preferredBill = findNarrationBill(currentDraft.candidateBills, transaction);
    const suggested = allocateReceiptByFifo(
      currentDraft.receiptAmount,
      currentDraft.candidateBills,
      buildAdvanceReference(transaction),
      preferredBill?.referenceName
    );
    const billAmounts = Object.fromEntries(
      suggested.allocations
        .filter((line) => line.referenceType === "Agst Ref")
        .map((line) => [line.referenceName, line.allocatedAmount])
    );
    setBillAllocationsByTransactionId((current) => ({
      ...current,
      [transaction.id]: buildManualAllocationDraft(
        transaction,
        currentDraft,
        billAmounts,
        suggested.newAdvanceAmount
      ),
    }));
  }

  function recordRemainingAsAdvance(transaction: ReviewTransaction) {
    const currentDraft = billAllocationsByTransactionId[transaction.id];
    if (!currentDraft || currentDraft.unallocatedAmount <= 0) return;
    updateManualAdvanceAmount(
      transaction,
      String(currentDraft.newAdvanceAmount + currentDraft.unallocatedAmount)
    );
  }

  function recordEntireReceiptAsAdvance(transaction: ReviewTransaction) {
    const currentDraft = billAllocationsByTransactionId[transaction.id];
    if (!currentDraft) return;

    setBillAllocationsByTransactionId((current) => ({
      ...current,
      [transaction.id]: buildManualAllocationDraft(
        transaction,
        currentDraft,
        {},
        currentDraft.receiptAmount
      ),
    }));
    setConfirmFullAdvance(false);
  }

  function closeBillAllocationReview(allowIncomplete = false, protectManualEdit = false) {
    if (!billAllocationReviewTransactionId) return;
    const draft = billAllocationsByTransactionId[billAllocationReviewTransactionId];
    const isIncomplete = Boolean(
      draft && (draft.requiresUserReview || Math.abs(draft.unallocatedAmount) >= 0.01)
    );
    const hasManualEdit = draft?.caseType === "manual_review";
    if (!allowIncomplete && (isIncomplete || (protectManualEdit && hasManualEdit))) {
      showToast(
        "info",
        isIncomplete
          ? "This allocation is incomplete. Choose Close to leave it for later."
          : "This allocation was changed. Use Done to keep the reviewed allocation."
      );
      return;
    }
    setBillAllocationReviewTransactionId(null);
  }

  function openAdjacentBillAllocation(direction: -1 | 1) {
    if (billAllocationReviewIndex < 0 || partyBillAllocationReviewTransactions.length === 0) return;
    const nextIndex = billAllocationReviewIndex + direction;
    const next = partyBillAllocationReviewTransactions[nextIndex];
    if (next) setBillAllocationReviewTransactionId(next.id);
  }

  function completePostingReview(transactionId: string) {
    setBillAllocationReviewTransactionId(null);
    setOutgoingReviewTransactionId(null);
    setEditingLedgerIds(new Set());
    setReviewActionStage("ledger");

    const currentIndex = filteredTransactionIndexById.get(transactionId);
    if (currentIndex === undefined) return;
    const nextTransaction = filteredTransactions[currentIndex + 1];
    if (!nextTransaction) return;

    selectReviewTransaction(nextTransaction.id);
    const nextPage = Math.floor((currentIndex + 1) / rowsPerPage) + 1;
    setReviewPage((current) => (current === nextPage ? current : nextPage));
    scrollReviewTransactionIntoView(nextTransaction.id);
  }

  function dismissToast(id: string) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function showToast(tone: MessageTone, text: string) {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;

    setToasts((current) => [...current, { id, tone, text }].slice(-3));
    window.setTimeout(() => dismissToast(id), 5000);
  }

  function requireVerifiedTallyCompany(action: string) {
    if (tallyCompanyContextVerified) return true;
    const detail = tallyCompanyContextMismatch
      ? `Tally is open to ${activeTallyCompanyName}. Switch it to ${selectedCompanyName}, refresh Gajkesari, then ${action}.`
      : "Refresh Gajkesari to verify the company currently open in Tally before continuing.";
    showToast("error", detail);
    return false;
  }
  async function refreshTallyConnectionStatus() {
    try {
      setRefreshingConnections(true);
      const loadedConnections = await loadTallyConnections();
      const preferredConnectionId = readPreferredTallyConnectionId();
      const preferredConnection =
        loadedConnections.find((connection) => connection.id === tallyConnectionId) ??
        loadedConnections.find((connection) => connection.id === preferredConnectionId) ??
        getRelevantTallyConnections(loadedConnections)[0];
      const loadedCompanies = preferredConnection
        ? await loadCompanyOptions(preferredConnection.id)
        : [];
      const restoredCompany = findStoredCompanySelection(loadedCompanies);
      const preferredCompany = loadedCompanies.find((company) => company.id === selectedCompanyId) ?? restoredCompany;
      const nextConnectionId = preferredCompany?.connectionId || preferredConnection?.id || "";
      if (nextConnectionId) {
        setSelectedCompanyId((current) =>
          current && loadedCompanies.some((company) => company.id === current) ? current : restoredCompany?.id ?? ""
        );
        setTallyConnectionId(nextConnectionId);
        bankLedgerLoadKeyRef.current = "";
        ledgerLoadSeqRef.current += 1;
        setLedgerMasters([]);
      }
      showToast("success", "Tally connection refreshed.");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Could not refresh Tally connection.");
    } finally {
      setRefreshingConnections(false);
    }
  }

  function updateStatementContext(nextCompanyId: string) {
    if (!nextCompanyId) {
      if (!selectedCompanyId) return;
      setSelectedCompanyId("");
      setTallyConnectionId(visibleConnections[0]?.id || "");
      setBankLedgerName("");
      setBankLedgerChangeMode(false);
      setPendingBankLedgerName("");
      setSelectedAccountId("");
      setAccount(EMPTY_ACCOUNT);
      setLedgerMasters([]);
      clearStatementReview();
      return;
    }
    const nextCompany = companyOptions.find((company) => company.id === nextCompanyId) ?? null;
    const nextConnectionId = nextCompany?.connectionId || nextCompanyId;
    if (nextCompanyId === selectedCompanyId && nextConnectionId === tallyConnectionId) return;
    setSelectedCompanyId(nextCompanyId);
    setTallyConnectionId(nextConnectionId);
    setBankLedgerName("");
    setBankLedgerChangeMode(false);
    setPendingBankLedgerName("");
    setSelectedAccountId("");
    setAccount(EMPTY_ACCOUNT);
    setLedgerMasters([]);
    clearStatementReview();
  }

  function applyTallyBankLedgerSelection(ledgerName: string) {
    // The statement account remains evidence from the uploaded file. A manual
    // Tally choice must never overwrite it with the ledger's account details.
    setAccount((current) => ({ ...current, tallyLedgerName: ledgerName }));
    setBankLedgerName(ledgerName);
    setBankLedgerVerified(false);
    setBankLedgerManuallyConfirmed(true);
    setBankLedgerChangeMode(false);
    setPendingBankLedgerName("");
  }
  function beginBankLedgerChange() {
    setPendingBankLedgerName(bankLedgerName);
    setBankLedgerChangeMode(true);
  }

  function cancelBankLedgerChange() {
    setPendingBankLedgerName("");
    setBankLedgerChangeMode(false);
  }

  function commitBankLedgerChange(ledgerName: string) {
    if (!ledgerName.trim()) {
      showToast("error", "Choose a Tally bank ledger first.");
      return;
    }

    applyTallyBankLedgerSelection(ledgerName);
    showToast("success", "Bank ledger updated for this statement.");
  }

  function confirmBankLedgerChange() {
    commitBankLedgerChange(pendingBankLedgerName);
  }

  function applyPreviewPayload(
    payload: PreviewResponse,
    fallbackAccount = EMPTY_ACCOUNT,
    ledgerMastersForReview = ledgerMasters
  ) {
    // Only the API's exact-account resolution may automatically select a ledger.
    // In particular, never retain a ledger from the preceding statement.
    const statementAccountNumber = normalizeBankAccountNumber(payload.account.accountNumber);
    const bankLedgersForExactMatch = [...bankLedgerOptions, ...ledgerMastersForReview.filter(isBankLedgerMaster)];
    const exactLiveLedgerNames = Array.from(
      new Set(
        bankLedgersForExactMatch
          .filter(
            (ledger) =>
              statementAccountNumber &&
              getTallyBankLedgerAccountNumber(ledger) === statementAccountNumber
          )
          .map((ledger) => ledger.name.trim())
          .filter(Boolean)
      )
    );
    // The live Tally response is a fallback for local/offline bridge mode. It
    // still requires one exact account-number match; AI never guesses a bank ledger.
    const liveExactLedgerName = exactLiveLedgerNames.length === 1 ? exactLiveLedgerNames[0] : "";
    const nextTallyLedgerName = liveExactLedgerName || payload.account.tallyLedgerName?.trim() || "";
    const nextLedgerVerified = Boolean(
      nextTallyLedgerName && (liveExactLedgerName || payload.bankLedgerResolution?.verified)
    );

    setPreview(payload);
    setAccount({
      bankName: payload.account.bankName ?? fallbackAccount.bankName,
      accountNumber: payload.account.accountNumber ?? fallbackAccount.accountNumber,
      accountHolderName: payload.account.accountHolderName ?? fallbackAccount.accountHolderName,
      ifscCode: payload.account.ifscCode ?? fallbackAccount.ifscCode,
      tallyLedgerName: nextTallyLedgerName,
    });
    setSelectedAccountId("");
    setBankLedgerName(nextTallyLedgerName);
    setBankLedgerVerified(nextLedgerVerified);
    setBankLedgerManuallyConfirmed(false);
    setBankLedgerChangeMode(false);
    setPendingBankLedgerName("");
    setTransactions(
      payload.transactions.map((transaction) => normalizeReviewTransaction(transaction, ledgerMastersForReview))
    );
    setReviewPage(1);
    setEditingLedgerIds(new Set());
    setTallyPostingStatus(null);
    setBillAllocationsByTransactionId({});
    setOutgoingVerificationsByTransactionId({});
    setTallyPresenceByTransactionId({});
    setPostedTransactionIds(new Set());
    setTallyBalanceProof(null);
    setTallyCheckAttempted(false);
    setReviewFiltersOpen(false);
    setReviewSearch("");
    setReviewWorkStatusFilter("all");
    setReviewTallyResultFilter("all");
    setReviewLedgerFilter("all");
    setReviewDirectionFilter("all");
    setReviewAllocationFilter("all");
    setReviewDateFrom("");
    setReviewDateTo("");
    selectReviewTransaction(null);
    setBillAllocationReviewTransactionId(null);
    setOutgoingReviewTransactionId(null);
  }
  async function pollImportUntilReady(importId: string, ledgerMastersForReview = ledgerMasters) {
    const startedAt = Date.now();
    const maximumWaitMs = 15 * 60 * 1000;
    for (let attempt = 0; Date.now() - startedAt < maximumWaitMs; attempt += 1) {
      await wait(attempt < 10 ? 3000 : 5000);
      const payload = await loadImportPreviewMetadata(importId);
      if (payload.processing) {
        setAnalysisEngineSource(payload.extractionSource ?? null);
        setBanner({
          tone: "info",
          text: payload.job?.stage
            ? `Analyzing statement: ${payload.job.stage}`
            : "Analyzing statement...",
        });
        continue;
      }

      if (payload.job?.status === "failed") {
        throw new Error(payload.job.error || "Bank statement analysis failed.");
      }

      const fullPayload = await loadImportPreviewWithPagedTransactions(importId);
      applyPreviewPayload(fullPayload, EMPTY_ACCOUNT, ledgerMastersForReview);
      setAnalysisEngineSource(null);
      setBanner(getAnalysisCompleteMessage(fullPayload));
      return fullPayload;
    }

    throw new Error("Bank statement analysis is still running after 15 minutes. The job remains saved; refresh to check its latest status.");
  }

  async function handleSelectedStatementFile(nextFile: File) {
    if (!selectedCompanyId || !selectedCompanyName) {
      setBanner({ tone: "error", text: "Select the Tally company before uploading a bank statement." });
      return;
    }
    if (!uploadContextReady) {
      setBanner({ tone: "error", text: setupErrorMessage || "Complete the Tally company setup before upload." });
      return;
    }
    setDocumentPreviewLoading(true);
    setBanner(null);
    setStatementDoneSummary(null);
    setTallyPostingStatus(null);
    setStatementPassword("");
    setStatementPasswordRequired(false);
    setStatementPasswordError(null);
    setStatementPasswordChecking(false);
    setStatementPasswordVerified(false);
    setFile(nextFile);
    try {
      const nextPreview = await buildDocumentPreview(nextFile);
      setDocumentPreview(nextPreview);
      if (nextPreview.kind === "pdf" && !nextPreview.error) {
        await unlockStatementPdfPreview(nextFile, "");
      }
    } finally {
      setDocumentPreviewLoading(false);
    }
  }

  async function unlockStatementPdfPreview(nextFile = file, password = statementPassword) {
    if (!nextFile || !isPdfFile(nextFile)) return false;

    setStatementPasswordChecking(true);
    setStatementPasswordError(null);
    setStatementPasswordVerified(false);

    try {
      const formData = new FormData();
      formData.set("file", nextFile);
      if (password) {
        formData.set("statementPassword", password);
      }

      const response = await apiFetch("/api/bank-statements/pdf-preview", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = await readApiErrorPayload(response);
        const isPasswordIssue =
          payload.code === "BANK_STATEMENT_PASSWORD_REQUIRED" ||
          payload.code === "BANK_STATEMENT_PASSWORD_INCORRECT";

        if (isPasswordIssue) {
          const message =
            payload.error ??
            (payload.code === "BANK_STATEMENT_PASSWORD_INCORRECT"
              ? "That password is incorrect. Check it and try again."
              : "This PDF is password protected. Enter its password to continue.");
          setStatementPasswordRequired(true);
          setStatementPasswordError(
            payload.code === "BANK_STATEMENT_PASSWORD_INCORRECT" ? message : null
          );
          if (payload.code === "BANK_STATEMENT_PASSWORD_INCORRECT") {
            setStatementPassword("");
            setBanner({ tone: "error", text: message });
          }
          return false;
        }

        const message = payload.error ?? "This PDF could not be prepared for preview.";
        setStatementPasswordError(message);
        setBanner({ tone: "error", text: message });
        return false;
      }

      const unlockedPdfUrl = URL.createObjectURL(await response.blob());
      setDocumentPreview((current) => {
        if (!current || current.fileName !== nextFile.name) {
          URL.revokeObjectURL(unlockedPdfUrl);
          return current;
        }
        return { ...current, objectUrl: unlockedPdfUrl, error: null };
      });

      if (password) {
        setStatementPasswordRequired(true);
        setStatementPasswordVerified(true);
        setBanner({ tone: "success", text: "PDF unlocked. You can review and analyze it now." });
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "This PDF could not be prepared for preview.";
      setStatementPasswordError(message);
      setBanner({ tone: "error", text: message });
      return false;
    } finally {
      setStatementPasswordChecking(false);
    }
  }

  function clearSelectedStatementFile() {
    setFile(null);
    setDocumentPreview(null);
    setDocumentPreviewLoading(false);
    setStatementPassword("");
    setStatementPasswordRequired(false);
    setStatementPasswordError(null);
    setStatementPasswordChecking(false);
    setStatementPasswordVerified(false);
    setDragActive(false);
    setBanner(null);
    setPostUploadSyncImportId(null);
    setPostUploadSyncError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function loadImportPreviewMetadata(importId: string) {
    const response = await apiFetch(`/api/bank-statements/imports/${importId}?includeTransactions=false`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(await readError(response));
    }

    return (await response.json()) as PreviewResponse;
  }

  async function loadImportPreviewWithPagedTransactions(importId: string) {
    const pageSize = 500;
    const firstResponse = await apiFetch(
      `/api/bank-statements/imports/${importId}?${new URLSearchParams({
        transactionsPage: "1",
        transactionsPageSize: String(pageSize),
      }).toString()}`,
      { cache: "no-store" }
    );
    if (!firstResponse.ok) {
      throw new Error(await readError(firstResponse));
    }

    const firstPayload = (await firstResponse.json()) as PreviewResponse;
    const total = firstPayload.transactionsTotal ?? firstPayload.transactions.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const transactions = [...firstPayload.transactions];

    for (let page = 2; page <= totalPages; page += 1) {
      setBanner({
        tone: "info",
        text: `Loading analyzed transactions ${page}/${totalPages}...`,
      });
      const pageResponse = await apiFetch(
        `/api/bank-statements/imports/${importId}?${new URLSearchParams({
          transactionsPage: String(page),
          transactionsPageSize: String(pageSize),
        }).toString()}`,
        { cache: "no-store" }
      );
      if (!pageResponse.ok) {
        throw new Error(await readError(pageResponse));
      }
      const pagePayload = (await pageResponse.json()) as PreviewResponse;
      transactions.push(...pagePayload.transactions);
    }

    return {
      ...firstPayload,
      transactions,
      transactionsPage: 1,
      transactionsPageSize: pageSize,
      transactionsTotal: total,
    };
  }

  async function fetchQueueableTransactions(params: {
    accountId: string;
    importId: string;
    connectionId: string;
  }) {
    const pageSize = 500;
    const rows: QueueTransaction[] = [];
    for (let page = 1; ; page += 1) {
      const transactionsResponse = await apiFetch(
        `/api/bank-statements/transactions?${new URLSearchParams({
          accountId: params.accountId,
          importId: params.importId,
          status: "queueable",
          connectionId: params.connectionId,
          page: String(page),
          pageSize: String(pageSize),
        }).toString()}`,
        { cache: "no-store" }
      );
      if (!transactionsResponse.ok) {
        throw new Error(await readError(transactionsResponse));
      }

      const queuePayload = (await transactionsResponse.json()) as {
        transactions?: QueueTransaction[];
        total?: number;
      };
      const pageRows = queuePayload.transactions ?? [];
      rows.push(...pageRows);
      const total = queuePayload.total ?? rows.length;
      if (page * pageSize >= total || total === 0) {
        return rows;
      }
    }
  }

  async function analyzeFile(nextFile = file) {
    if (!nextFile) {
      setBanner({ tone: "error", text: "Select a bank statement file." });
      return;
    }
    if (!selectedCompanyId || !tallyConnectionId || !selectedCompanyName) {
      setBanner({ tone: "error", text: "Select the Tally company before upload." });
      return;
    }
    if (!tallyConnected) {
      setBanner({ tone: "error", text: "Tally company is not ready. Open Tally Prime and refresh the connection." });
      return;
    }
    if (!tallyCompanyContextVerified) {
      setBanner({ tone: "error", text: setupErrorMessage || "Refresh Gajkesari to verify the Tally company before upload." });
      return;
    }
    if (
      statementPasswordRequired &&
      isPdfFile(nextFile) &&
      (!statementPassword.trim() || !statementPasswordVerified)
    ) {
      const message = statementPassword.trim()
        ? "Unlock the PDF preview with this password before analysis."
        : "Enter the statement password to continue.";
      setStatementPasswordError(message);
      setBanner({ tone: "error", text: message });
      return;
    }
    try {
      clearStatementReview({ preserveSelectedFile: true });
      setAnalysisEngineSource(null);
      setLoading(true);
      setBanner(null);
      setStatementPasswordError(null);
      setTallyPostingStatus(null);
      setStatementDoneSummary(null);
      setPostUploadSyncImportId(null);
      setPostUploadSyncError(null);
      setFile(nextFile);
      const syncedMasters = await loadLedgerMasters(tallyConnectionId);
      if (!syncedMasters || syncedMasters.length === 0) {
        throw new Error(
          "Could not fetch the latest ledgers from Tally. Keep Tally Prime and the connector open, then retry analysis."
        );
      }
      const ledgerMastersForReview = syncedMasters;

      const formData = new FormData();
      formData.set("file", nextFile);
      formData.set("account", JSON.stringify(EMPTY_ACCOUNT));
      formData.set("connectionId", tallyConnectionId);
      formData.set("companyName", selectedCompanyName);
      formData.set("financialYear", selectedFinancialYear);
      formData.set("bankLedgerName", "");
      formData.set("syncBeforeAnalysis", "true");
      formData.set(
        "liveTallyLedgerNames",
        JSON.stringify(Array.from(new Set(ledgerMastersForReview.map((ledger) => ledger.name.trim()).filter(Boolean))))
      );
      formData.set(
        "liveTallyBankAccountCandidates",
        JSON.stringify(ledgerMastersForReview.flatMap((ledger) => {
          const accountNumber = normalizeBankAccountNumber(ledger.bankAccountNumber);
          return accountNumber ? [{ ledgerName: ledger.name.trim(), accountNumber }] : [];
        }))
      );
      if (isPdfFile(nextFile) && statementPassword.trim()) {
        formData.set("statementPassword", statementPassword);
      }

      const response = await apiFetch("/api/bank-statements/imports", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const payload = await readApiErrorPayload(response);
        if (
          payload.code === "BANK_STATEMENT_PASSWORD_REQUIRED" ||
          payload.code === "BANK_STATEMENT_PASSWORD_INCORRECT"
        ) {
          setStatementPasswordRequired(true);
          setStatementPasswordVerified(false);
          setStatementPasswordError(payload.error ?? "This statement could not be unlocked.");
          if (payload.code === "BANK_STATEMENT_PASSWORD_INCORRECT") {
            setStatementPassword("");
          }
          setBanner({
            tone: "error",
            text: payload.error ?? "This statement could not be unlocked.",
          });
          return;
        }
        throw new Error(payload.error || `Request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as PreviewResponse;
      setStatementPassword("");
      setStatementPasswordRequired(false);
      setStatementPasswordError(null);
      setStatementPasswordVerified(false);
      if (payload.processing) {
        setBanner({
          tone: "info",
          text: payload.job?.stage
            ? `Analyzing statement: ${payload.job.stage}`
            : "Analyzing statement...",
        });
        await pollImportUntilReady(payload.import.id, ledgerMastersForReview);
      } else {
        const latestPayload = await loadImportPreviewMetadata(payload.import.id);
        if (latestPayload.processing) {
          await pollImportUntilReady(payload.import.id, ledgerMastersForReview);
        } else {
          const analyzedPayload = await loadImportPreviewWithPagedTransactions(payload.import.id);
          applyPreviewPayload(analyzedPayload, EMPTY_ACCOUNT, ledgerMastersForReview);
          setBanner(getAnalysisCompleteMessage(analyzedPayload));
        }
      }
      setPostUploadSyncImportId(null);
      setPostUploadSyncError(null);
    } catch (error) {
      setBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Bank statement analysis failed.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function retryPostUploadSync() {
    if (!postUploadSyncImportId) return;

    try {
      setLoading(true);
      setPostUploadSyncError(null);
      setBanner({ tone: "info", text: "Retrying Tally company sync after upload..." });
      const syncedMasters = await loadLedgerMasters(tallyConnectionId);
      if (!syncedMasters || syncedMasters.length === 0) {
        const message = "Tally company sync is still not complete. Keep the connector open, then retry.";
        setPostUploadSyncError(message);
        setBanner({ tone: "error", text: message });
        return;
      }

      const payload = await loadImportPreviewMetadata(postUploadSyncImportId);
      if (payload.processing) {
        await pollImportUntilReady(postUploadSyncImportId, syncedMasters);
      } else {
        const fullPayload = await loadImportPreviewWithPagedTransactions(postUploadSyncImportId);
        applyPreviewPayload(fullPayload, EMPTY_ACCOUNT, syncedMasters);
        setBanner(getAnalysisCompleteMessage(fullPayload));
      }
      setPostUploadSyncImportId(null);
      setPostUploadSyncError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not retry Tally company sync.";
      setPostUploadSyncError(message);
      setBanner({ tone: "error", text: message });
    } finally {
      setLoading(false);
    }
  }

  async function syncCompanyData(options?: { quiet?: boolean; statusText?: string }) {
    const connection = commandConnection;
    if (!connection) {
      setBanner({ tone: "error", text: "Select a Tally connection before syncing ledgers." });
      return false;
    }

    try {
      setSyncingMasters(true);
      setBanner(
        options?.quiet
          ? { tone: "info", text: options.statusText || "Refreshing Tally company data..." }
          : null
      );
      const response = await apiFetch(`/api/tally/connections/${connection.id}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandType: "sync_masters",
          payload: {
            companyName: selectedCompanyName || connection.lastCompanyName,
            requestedMasterTypes: ["ledger", "group"],
          },
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as { command?: TallyCommand };
      const command = payload.command;
      if (!command?.id) {
        throw new Error("Tally ledger sync was queued, but no command id was returned.");
      }
      setBanner({
        tone: "info",
        text: options?.quiet
          ? options.statusText || "Refreshing Tally company data..."
          : "Company data sync is running. Keep the connector open.",
      });
      const completedCommand = await waitForCommand(connection.id, command.id, {
        attempts: 180,
        intervalMs: 2000,
      });
      if (!completedCommand) {
        setBanner({
          tone: "info",
          text: "Company data sync is still pending. Keep the connector running and try again shortly.",
        });
        return false;
      }
      if (completedCommand.status !== "succeeded") {
        throw new Error(completedCommand.error || `Tally ledger sync ${completedCommand.status}.`);
      }

      const masters = await loadLedgerMasters(connection.id);
      const syncTotals = completedCommand.result?.totals;
      const reportedLedgerCount = syncTotals && typeof syncTotals === "object"
        ? Number((syncTotals as Record<string, unknown>).ledger ?? Number.NaN)
        : Number.NaN;
      if (Number.isFinite(reportedLedgerCount) && reportedLedgerCount !== masters.length) {
        throw new Error(
          `Tally returned ${reportedLedgerCount} ledgers, but only ${masters.length} reached ledger matching. Retry the sync before analysis.`
        );
      }
      await loadCompanyOptions(connection.id).catch(() => undefined);
      if (!options?.quiet) {
        setBanner({ tone: "success", text: "Tally company data refreshed." });
      }
      return masters;
    } catch (error) {
      setBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not sync Tally company data.",
      });
      return null;
    } finally {
      setSyncingMasters(false);
    }
  }

  async function handleSyncLedgerMasters() {
    if (tallyConnectionId && companyOptions.length > 0) {
      bankLedgerLoadKeyRef.current = "";
      await fetchTallyBankLedgersForCompanies(
        tallyConnectionId,
        companyOptions.map((company) => company.companyName),
        { quiet: false }
      );
    }
    await syncCompanyData();
  }

  function openBillDataByLedgerFromResult(
    result: Record<string, unknown>,
    ledgerNames: string[],
    resultField = "byLedger"
  ) {
    const requestedLedgerNames = Array.from(
      new Set(ledgerNames.map((ledgerName) => ledgerName.trim()).filter(Boolean))
    );
    if (requestedLedgerNames.length === 0) {
      return new Map<string, { openBills: OpenBillReference[]; existingAdvances: ExistingAdvanceReference[] }>();
    }
    const billDataByLedger = new Map<string, { openBills: OpenBillReference[]; existingAdvances: ExistingAdvanceReference[] }>();
    const rawResult = result[resultField];
    const rawByLedger = rawResult && typeof rawResult === "object"
      ? rawResult as Record<string, unknown>
      : {};

    for (const ledgerName of requestedLedgerNames) {
      const ledgerResult = rawByLedger[ledgerName] && typeof rawByLedger[ledgerName] === "object"
        ? rawByLedger[ledgerName] as Record<string, unknown>
        : null;
      billDataByLedger.set(ledgerName, {
        openBills: ledgerResult && Array.isArray(ledgerResult.openBills)
          ? ledgerResult.openBills as OpenBillReference[]
          : [],
        existingAdvances: ledgerResult && Array.isArray(ledgerResult.existingAdvances)
          ? ledgerResult.existingAdvances as ExistingAdvanceReference[]
          : [],
      });
    }

    if (Object.keys(rawByLedger).length === 0) {
      const legacyLedgerName =
        typeof result.ledgerName === "string" && requestedLedgerNames.includes(result.ledgerName)
          ? result.ledgerName
          : requestedLedgerNames[0];
      billDataByLedger.set(legacyLedgerName, {
        openBills: Array.isArray(result.openBills) ? result.openBills as OpenBillReference[] : [],
        existingAdvances: Array.isArray(result.existingAdvances)
          ? result.existingAdvances as ExistingAdvanceReference[]
          : [],
      });
    }

    return billDataByLedger;
  }

  async function fetchOpenBillsForLedgers(
    connection: TallyConnection,
    ledgerNames: string[],
    asOfDate?: string | null
  ) {
    const requestedLedgerNames = Array.from(
      new Set(ledgerNames.map((ledgerName) => ledgerName.trim()).filter(Boolean))
    );
    if (requestedLedgerNames.length === 0) {
      return new Map<string, { openBills: OpenBillReference[]; existingAdvances: ExistingAdvanceReference[] }>();
    }

    const result = await runCashDiscountLiveRequest<Record<string, unknown>>({
      connectionId: connection.id,
      companyName: selectedCompanyName || connection.lastCompanyName || "",
      operation: "fetch_customer_open_bills",
      payload: {
        ledgerName: requestedLedgerNames[0],
        ledgerNames: requestedLedgerNames,
        companyName: selectedCompanyName || connection.lastCompanyName,
        asOfDate: asOfDate || undefined,
        queryPurpose: "bank_statement_match",
      },
    });
    return openBillDataByLedgerFromResult(result, requestedLedgerNames);
  }

  async function waitForCommands(connectionId: string, commandIds: string[]) {
    if (commandIds.length === 0) return [];

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(2000);
      const chunks = await Promise.all(
        chunkValues(commandIds, 80).map(async (chunk) => {
          const response = await apiFetch(
            `/api/tally/connections/${connectionId}/commands?${new URLSearchParams({
              ids: chunk.join(","),
              limit: String(chunk.length),
            }).toString()}`,
            { cache: "no-store" }
          );
          if (!response.ok) {
            throw new Error(await readError(response));
          }
          const payload = (await response.json()) as { commands?: TallyCommand[] };
          return payload.commands ?? [];
        })
      );
      const commands = chunks.flat();
      const commandById = new Map(commands.map((command) => [command.id, command]));
      const allFinished = commandIds.every((id) => {
        const status = commandById.get(id)?.status;
        return status === "succeeded" || status === "failed" || status === "canceled";
      });
      if (allFinished) return commands;
    }

    return [];
  }

  async function verifyBankStatementPresence(
    connection: TallyConnection,
    rows: ReviewTransaction[],
    options: {
      includeOpenBills?: boolean;
      signal?: AbortSignal;
      billEligibleTransactionIds?: string[];
      asOfDate?: string | null;
    } = {}
  ) {
    if (!bankLedgerName.trim()) {
      throw new Error("Select the Tally bank ledger before checking the statement.");
    }
    const relevantLedgerNames = Array.from(
      new Set(
        [
          bankLedgerName,
          ...rows
            .map((transaction) => transaction.selectedLedgerName)
            .filter((ledgerName) => ledgerName.trim() && !isSuspenseLedgerName(ledgerName)),
        ]
          .map((ledgerName) => ledgerName.trim())
          .filter(Boolean)
      )
    );
    const result = await runCashDiscountLiveRequest<{
      transactions?: Array<Record<string, unknown>>;
      balanceProof?: Record<string, unknown>;
      billLedgerNames?: string[];
      openBillsByLedger?: Record<string, unknown>;
      matchDiagnostics?: Record<string, unknown>;
    }>({
      connectionId: connection.id,
      companyName: selectedCompanyName || connection.lastCompanyName || "",
      operation: options.includeOpenBills ? "match_bank_statement" : "verify_bank_transaction",
      signal: options.signal,
      onProgress: (text) => setBanner({ tone: "info", text }),
      onPartialResult: () => setBanner({ tone: "info", text: "Voucher check complete. Reading outstanding bills; posting remains disabled until all checks finish." }),
      payload: {
        companyName: selectedCompanyName || connection.lastCompanyName,
        bankLedgerName,
        relevantLedgerNames,
        voucherTypes: ["Receipt", "Payment", "Contra", "Journal"],
        // Matching rows must stay interactive. Closing-balance proof is a
        // separate diagnostic and must not block the duplicate check.
        includeBalanceProof: false,
        billEligibleTransactionIds: options.billEligibleTransactionIds,
        asOfDate: options.asOfDate || undefined,
        transactions: rows.map((transaction) => {
            const incoming = isIncomingReceiptRow(transaction);
            const debitAmount = parseNumber(transaction.debitAmount) ?? 0;
            const creditAmount = parseNumber(transaction.creditAmount) ?? 0;
            return {
              transactionId: transaction.id,
              voucherDate: getEffectiveTransactionDate(transaction),
              bankLedgerName,
              amount: incoming ? creditAmount : debitAmount,
              debitAmount,
              creditAmount,
              balanceAmount: parseNumber(transaction.balanceAmount),
              expectedDirection: incoming ? "incoming" : "outgoing",
              counterpartyLedgerName: isSuspenseLedgerName(transaction.selectedLedgerName)
                ? null
                : transaction.selectedLedgerName,
              narration: transaction.description,
              referenceNumber: transaction.referenceNumber || getTransactionReference(transaction),
            };
        }),
      },
    });
    const resultRows = Array.isArray(result.transactions) ? result.transactions : [];
    const drafts = Object.fromEntries(resultRows.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      const transactionId = typeof row.transactionId === "string" ? row.transactionId : "";
      if (!transactionId) return [];
      return [[transactionId, outgoingVerificationFromCommand({
        id: transactionId,
        status: "succeeded",
        error: null,
        result: row,
      } as TallyCommand)]];
    })) as Record<string, OutgoingVerificationDraft>;
    const balanceProof = result.balanceProof && typeof result.balanceProof === "object" && !Array.isArray(result.balanceProof)
      ? result.balanceProof as TallyBalanceProof
      : null;
    const billLedgerNames = Array.isArray(result.billLedgerNames)
      ? result.billLedgerNames.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : [];
    const billDataByLedger = openBillDataByLedgerFromResult(
      result as Record<string, unknown>,
      billLedgerNames,
      "openBillsByLedger"
    );
    setTallyPresenceByTransactionId(drafts);
    setOutgoingVerificationsByTransactionId(Object.fromEntries(
      rows.filter(isOutgoingPaymentRow).flatMap((transaction) => {
        const draft = drafts[transaction.id];
        return draft ? [[transaction.id, draft]] : [];
      })
    ));
    setTallyBalanceProof(balanceProof);
    return { drafts, balanceProof, billDataByLedger, matchDiagnostics: result.matchDiagnostics ?? null };
  }

  async function verifyOutgoingPayments(connection: TallyConnection, rows: ReviewTransaction[]) {
    const nextDrafts: Record<string, OutgoingVerificationDraft> = {};
    const checkableRows: ReviewTransaction[] = [];

    for (const transaction of rows) {
      const amount = parseNumber(transaction.debitAmount) ?? 0;
      if (!bankLedgerName.trim()) {
        nextDrafts[transaction.id] = {
          status: "cannot_check_yet",
          label: "Needs Bank Ledger",
          reason: "Select the Tally bank ledger before checking outgoing payments.",
        };
        continue;
      }
      if (!hasValidTransactionDate(getEffectiveTransactionDate(transaction)) || amount <= 0) {
        nextDrafts[transaction.id] = {
          status: "cannot_check_yet",
          label: "Cannot Check",
          reason: "This debit row is missing a valid date or amount.",
        };
        continue;
      }

      checkableRows.push(transaction);
      nextDrafts[transaction.id] = {
        status: "checking",
        label: "Checking",
        reason: "Looking for an existing outgoing entry in Tally.",
      };
    }

    setOutgoingVerificationsByTransactionId((current) => ({ ...current, ...nextDrafts }));
    if (checkableRows.length === 0) return nextDrafts;

    const queuedCommands = await Promise.all(
      checkableRows.map(async (transaction) => {
        const response = await apiFetch(`/api/tally/connections/${connection.id}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandType: "verify_bank_transaction",
            payload: {
              companyName: selectedCompanyName || connection.lastCompanyName,
              voucherDate: getEffectiveTransactionDate(transaction),
              bankLedgerName,
              amount: parseNumber(transaction.debitAmount) ?? 0,
              counterpartyLedgerName: isSuspenseLedgerName(transaction.selectedLedgerName)
                ? null
                : transaction.selectedLedgerName,
              matchedLedgerName: isSuspenseLedgerName(transaction.selectedLedgerName)
                ? null
                : transaction.selectedLedgerName,
              narration: transaction.description,
              referenceNumber: transaction.referenceNumber || getTransactionReference(transaction),
              transactionType: transaction.transactionType,
              category: transaction.category,
              counterpartyName: transaction.counterpartyName || getTransactionPartyTitle(transaction),
            },
          }),
        });

        if (!response.ok) {
          throw new Error(await readError(response));
        }

        const payload = (await response.json()) as { command?: TallyCommand };
        if (!payload.command?.id) {
          throw new Error("Payment check was queued, but no command id was returned.");
        }
        return { transactionId: transaction.id, command: payload.command };
      })
    );

    const commandIds = queuedCommands.map((item) => item.command.id);
    const completedCommands = await waitForCommands(connection.id, commandIds);
    const commandById = new Map(completedCommands.map((command) => [command.id, command]));
    const completedDrafts = Object.fromEntries(
      queuedCommands.map(({ transactionId, command }) => [
        transactionId,
        outgoingVerificationFromCommand(commandById.get(command.id)),
      ])
    ) as Record<string, OutgoingVerificationDraft>;

    setOutgoingVerificationsByTransactionId((current) => ({ ...current, ...completedDrafts }));
    return { ...nextDrafts, ...completedDrafts };
  }

  async function matchPendingBills() {
    if (preview?.requiresManualExtraction || preview?.extractionDiagnostics?.coverageComplete === false) {
      const unresolvedPages = preview.extractionDiagnostics?.unresolvedPages ?? [];
      showToast(
        "error",
        unresolvedPages.length > 0
          ? `Tally checking is blocked because PDF page${unresolvedPages.length === 1 ? "" : "s"} ${unresolvedPages.join(", ")} are not verified.`
          : "Tally checking is blocked until every statement page is verified."
      );
      return;
    }
    const connection = commandConnection;
    if (!connection) {
      showToast("error", "Select a Tally connection before checking Tally matches.");
      return;
    }
    if (validTransactions.length === 0) {
      showToast("info", "No valid bank statement rows were found to check.");
      return;
    }

    setTallyCheckAttempted(true);
    const matchController = new AbortController();
    matchAbortRef.current?.abort();
    matchAbortRef.current = matchController;
    setTallyPresenceByTransactionId({});
    try {
      setMatchingBills(true);
      setBanner({ tone: "info", text: "Checking the full statement against live Tally vouchers..." });
      const billEligibleTransactionIds = pendingBillEligibleTransactions.map((transaction) => transaction.id);
      const asOfDate = pendingBillEligibleTransactions
        .map(getEffectiveTransactionDate)
        .filter(Boolean)
        .sort()
        .at(-1);
      const {
        drafts: presenceDrafts,
        balanceProof,
        billDataByLedger,
      } = await verifyBankStatementPresence(connection, validTransactions, {
        includeOpenBills: true,
        signal: matchController.signal,
        billEligibleTransactionIds,
        asOfDate,
      });
      const receiptTransactionsToMatch = pendingBillEligibleTransactions.filter(
        (transaction) => presenceDrafts[transaction.id]?.status === "missing"
      );
      const nextDrafts: Record<string, BillAllocationDraft> = {};
      if (receiptTransactionsToMatch.length > 0) {
        for (const transaction of receiptTransactionsToMatch) {
          if (!isBillMatchEligibleTransaction(transaction, ledgerMasters)) {
            const context = getPartyBillMatchContext(transaction, ledgerMasters);
            nextDrafts[transaction.id] = {
              status: "not_applicable",
              caseType: "not_applicable",
              caseLabel: "Not Applicable",
              reason: context.reason || "This row is not eligible for bill matching.",
              receiptAmount: context.amount,
              totalAllocatedAmount: 0,
              newAdvanceAmount: 0,
              unallocatedAmount: 0,
              allocations: [],
              candidateBills: [],
              existingAdvances: [],
              requiresUserReview: false,
              isEligibleForPosting: true,
            };
            continue;
          }

          const data = billDataByLedger.get(transaction.selectedLedgerName);
          if (!data) {
            nextDrafts[transaction.id] = {
              status: "cannot_match_yet",
              caseType: "cannot_match_yet",
              caseLabel: "Cannot Match Yet",
              reason: "Could not fetch open bills for the selected party ledger.",
              receiptAmount: getPartyBillMatchContext(transaction, ledgerMasters).amount,
              totalAllocatedAmount: 0,
              newAdvanceAmount: 0,
              unallocatedAmount: getPartyBillMatchContext(transaction, ledgerMasters).amount,
              allocations: [],
              candidateBills: [],
              existingAdvances: [],
              requiresUserReview: true,
              isEligibleForPosting: false,
            };
            continue;
          }

          nextDrafts[transaction.id] = allocateBillsForTransaction(
            transaction,
            data.openBills,
            data.existingAdvances
          );
        }
      }

      if (receiptTransactionsToMatch.length > 0) {
        setBillAllocationsByTransactionId(nextDrafts);
      }
      lastLiveTallyCheckAtRef.current = Date.now();
      const foundCount = Object.values(presenceDrafts).filter((draft) => draft.status === "found").length;
      const ambiguousCount = Object.values(presenceDrafts).filter((draft) => draft.status === "ambiguous").length;
      const duplicateCount = Object.values(presenceDrafts).filter((draft) => draft.duplicateInTally).length;
      const missingReceiptRows = validTransactions.filter(
        (transaction) => isIncomingReceiptRow(transaction) && presenceDrafts[transaction.id]?.status === "missing"
      ).length;
      const missingOutgoingRows = validTransactions.filter(
        (transaction) => isOutgoingPaymentRow(transaction) && presenceDrafts[transaction.id]?.status === "missing"
      ).length;
      const outgoingBillReviews = validTransactions.filter((transaction) => {
        if (!isOutgoingPaymentRow(transaction) || presenceDrafts[transaction.id]?.status !== "missing") return false;
        if (!isBillMatchEligibleTransaction(transaction, ledgerMasters)) return false;
        const draft = nextDrafts[transaction.id];
        return !draft || draft.requiresUserReview || !draft.isEligibleForPosting;
      }).length;
      const readyOutgoingRows = Math.max(0, missingOutgoingRows - outgoingBillReviews);
      const uncheckedRows = validTransactions.length - foundCount - ambiguousCount - missingReceiptRows - missingOutgoingRows;
      const hasRowReviewIssues =
        duplicateCount > 0 ||
        ambiguousCount > 0 ||
        uncheckedRows > 0;
      setBanner({
        tone: hasRowReviewIssues ? "info" : "success",
        text: `Statement checked. ${missingReceiptRows > 0
          ? `${missingReceiptRows} receipt${missingReceiptRows === 1 ? " is" : "s are"} ready to post.`
          : "No new receipts to post."} ${readyOutgoingRows > 0
            ? `${readyOutgoingRows} outgoing payment${readyOutgoingRows === 1 ? " is" : "s are"} ready to post.`
            : missingOutgoingRows > 0
              ? `${missingOutgoingRows} outgoing payment${missingOutgoingRows === 1 ? " needs" : "s need"} review.`
              : "No new outgoing payments to post."}${hasRowReviewIssues ? " Review the highlighted rows." : ""}${
            balanceProof?.balancesMatch === false
              ? " Balance differs from Tally, but this does not block posting."
              : ""
          }`,
      });
    } catch (error) {
      setBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not check Tally matches.",
      });
    } finally {
      setMatchingBills(false);
      if (matchAbortRef.current === matchController) matchAbortRef.current = null;
    }
  }

  async function sendToTally(mode: TallySendMode) {
    if (!preview) return;
    if (preview.requiresManualExtraction || preview.extractionDiagnostics?.coverageComplete === false) {
      const unresolvedPages = preview.extractionDiagnostics?.unresolvedPages ?? [];
      showToast(
        "error",
        unresolvedPages.length > 0
          ? `Posting is blocked because PDF page${unresolvedPages.length === 1 ? "" : "s"} ${unresolvedPages.join(", ")} are not verified.`
          : "Posting is blocked until every statement page is verified."
      );
      return;
    }
    const selectedTallyWorkTransactions = mode === "post_receipts"
      ? readyReceiptTransactions
      : mode === "post_payments"
        ? readyPaymentTransactions
        : readyPostingTransactions;
    const selectedWorkIds = new Set(selectedTallyWorkTransactions.map((row) => row.id));
    const hasUnselectedStatementRows = validTransactions.some((row) =>
      tallyPresenceByTransactionId[row.id]?.status !== "found" && !selectedWorkIds.has(row.id)
    );
    if (selectedTallyWorkTransactions.length === 0) {
      showToast(
        "info",
        mode === "post_receipts"
          ? "No new receipts to post."
          : mode === "post_payments"
            ? "No new outgoing payments to post."
            : "No ready entries to post. Check Tally matches and resolve the rows needing review."
      );
      return;
    }
    if (!tallyConnectionId) {
      showToast("error", "Select a Tally connection.");
      return;
    }
    if (!bankLedgerName.trim()) {
      showToast("error", "Select the Tally bank ledger.");
      return;
    }
    if (validTransactions.length === 0) {
      showToast("error", "No valid rows are available to send.");
      return;
    }
    const selectedMissingLedgerCount = selectedTallyWorkTransactions.filter(
      (transaction) => !transaction.selectedLedgerName.trim()
    ).length;
    if (selectedMissingLedgerCount > 0) {
      showToast("error", "Select a ledger for every row before sending to Tally.");
      return;
    }
    if (transactionsNeedingTallyWork.length === 0) {
      setStatementDoneSummary({
        tone: "info",
        title: "Nothing new to send.",
        text: "Every statement row already has a unique matching voucher in live Tally.",
      });
      return;
    }
    const connection = commandConnection;
    if (!connection) {
      showToast("error", "The selected Tally connection is not live. Refresh it and try again.");
      return;
    }
    const billEligibleTransactions = selectedTallyWorkTransactions.filter((transaction) => {
      const draft = billAllocationsByTransactionId[transaction.id];
      return (
        isBillMatchEligibleTransaction(transaction, ledgerMasters) &&
        draft?.status === "ready_to_post" &&
        draft.allocations.some((allocation) => allocation.referenceType === "Agst Ref")
      );
    });
    // The match action has just fetched these exact live bills. Reuse that
    // result briefly so an immediate Post click does not make the user wait for
    // the same Tally export twice. Older reviews still get the full revalidation.
    const liveBillCheckIsFresh =
      tallyCheckAttempted && Date.now() - lastLiveTallyCheckAtRef.current < 120_000;
    if (billEligibleTransactions.length > 0 && !liveBillCheckIsFresh) {
      try {
        const ledgerNames = Array.from(new Set(
          billEligibleTransactions.map((transaction) => transaction.selectedLedgerName)
        ));
        const asOfDate = billEligibleTransactions
          .map(getEffectiveTransactionDate)
          .filter(Boolean)
          .sort()
          .at(-1);
        const freshBillData = await fetchOpenBillsForLedgers(connection, ledgerNames, asOfDate);
        const staleAllocations = billEligibleTransactions.flatMap((transaction) => {
          const draft = billAllocationsByTransactionId[transaction.id];
          const fresh = freshBillData.get(transaction.selectedLedgerName);
          if (!draft || draft.status !== "ready_to_post") {
            return [{ transaction, reason: "Bill allocation is no longer ready to post." }];
          }
          if (!fresh) {
            return [{ transaction, reason: "Could not refresh the selected party ledger's open bills." }];
          }
          const reason = validateAllocationAgainstFreshBillState(
            draft,
            fresh.openBills,
            fresh.existingAdvances
          );
          return reason ? [{ transaction, reason }] : [];
        });
        if (staleAllocations.length > 0) {
          setBillAllocationsByTransactionId((current) => {
            const next = { ...current };
            for (const { transaction, reason } of staleAllocations) {
              const draft = next[transaction.id];
              if (!draft) continue;
              next[transaction.id] = {
                ...draft,
                status: "stale_data",
                caseLabel: "Tally Data Changed",
                reason,
                requiresUserReview: true,
                isEligibleForPosting: false,
              };
            }
            return next;
          });
          setOutgoingVerificationsByTransactionId({});
          setTallyPresenceByTransactionId({});
          setTallyBalanceProof(null);
          setTallyCheckAttempted(false);
          setBanner({
            tone: "error",
            text: `Tally bill data changed for ${staleAllocations.length} row(s). Check Tally matches again before posting.`,
          });
          showToast("error", staleAllocations[0].reason);
          return;
        }
      } catch (error) {
        setTallyCheckAttempted(false);
        setBanner({
          tone: "error",
          text: error instanceof Error
            ? `Could not revalidate live Tally bills: ${error.message}`
            : "Could not revalidate live Tally bills. Check Tally matches again.",
        });
        return;
      }
    }
    try {
      setSendingMode(mode);
      setTallyPostingStatus(null);
      setStatementDoneSummary(null);
      setBanner(null);
      const confirmResponse = await apiFetch(`/api/bank-statements/imports/${preview.import.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: selectedAccountId || null,
          account: {
            ...account,
            tallyLedgerName: bankLedgerName,
          },
          reconcileAgainstLiveTally: true,
          transactions: selectedTallyWorkTransactions.map((transaction) => ({
            transactionDate: transaction.transactionDate,
            valueDate: transaction.valueDate || transaction.transactionDate,
            description: transaction.description,
            referenceNumber: transaction.referenceNumber || null,
            debitAmount: parseNumber(transaction.debitAmount),
            creditAmount: parseNumber(transaction.creditAmount),
            balanceAmount: parseNumber(transaction.balanceAmount),
            transactionType: transaction.transactionType,
            category: transaction.category,
            counterpartyName: transaction.counterpartyName || null,
            suggestedLedgerName: transaction.suggestedLedgerName || null,
            suggestionConfidence: transaction.suggestionConfidence,
            suggestionReason: transaction.suggestionReason || null,
            confirmedLedgerName: transaction.selectedLedgerName || null,
          })),
        }),
      });

      if (!confirmResponse.ok) {
        throw new Error(await readError(confirmResponse));
      }

      const confirmPayload = (await confirmResponse.json()) as {
        account: BankAccount;
        import: BankStatementImport;
        importedTransactionCount: number;
        duplicateTransactionCount: number;
        queueableTransactions?: QueueTransaction[];
      };

      const queueableTransactions = Array.isArray(confirmPayload.queueableTransactions)
        ? confirmPayload.queueableTransactions
        : await fetchQueueableTransactions({
            accountId: confirmPayload.account.id,
            importId: confirmPayload.import.id,
            connectionId: tallyConnectionId,
          });
      const selectedQueueKeys = new Set(selectedTallyWorkTransactions.map(transactionQueueKey));
      const queueRows = queueableTransactions.filter((transaction) =>
        selectedQueueKeys.has(transactionQueueKey(transaction))
      );
      const reviewedTransactionsByKey = new Map(
        selectedTallyWorkTransactions.map((transaction) => [transactionQueueKey(transaction), transaction])
      );
      if (queueRows.length === 0) {
        if (confirmPayload.importedTransactionCount <= 0) {
          throw new Error(
            `${confirmPayload.duplicateTransactionCount} row(s) were already imported or skipped. No Tally vouchers were queued.`
          );
        }

        setAccounts((current) => [confirmPayload.account, ...current.filter((item) => item.id !== confirmPayload.account.id)]);
        setRecentImports((current) => [confirmPayload.import, ...current.filter((item) => item.id !== confirmPayload.import.id)]);
        setStatementDoneSummary(hasUnselectedStatementRows ? null : {
          tone: "info",
          title: "Done. Nothing new to send.",
          text: `${confirmPayload.importedTransactionCount} transaction(s) imported. No new row needed Tally posting or payment checking.`,
        });
        if (!hasUnselectedStatementRows) {
          setBillAllocationsByTransactionId({});
          setOutgoingVerificationsByTransactionId({});
        }
        setBillAllocationReviewTransactionId(null);
        setOutgoingReviewTransactionId(null);
        showToast(
          "info",
          `${confirmPayload.importedTransactionCount} transactions imported. No new rows needed Tally work.`
        );
        return;
      }

      const queueResponse = await apiFetch("/api/bank-statements/tally/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: tallyConnectionId,
          companyName: selectedCompanyName,
          async: true,
          accountId: confirmPayload.account.id,
          transactionIds: queueRows.map((transaction) => transaction.id),
          bankLedgerName,
          liveLedgerContext: buildQueueLedgerContext(ledgerMasters, [
            bankLedgerName,
            ...queueRows.flatMap((transaction) => {
              const reviewedTransaction = reviewedTransactionsByKey.get(transactionQueueKey(transaction));
              return [
                reviewedTransaction?.selectedLedgerName,
                transaction.confirmedLedgerName,
                transaction.suggestedLedgerName,
              ];
            }),
          ]),
          outgoingAction: "post",
          transactions: queueRows.map((transaction) => ({
            transactionId: transaction.id,
            ...(() => {
              const reviewedTransaction = reviewedTransactionsByKey.get(transactionQueueKey(transaction));
              const billAllocation = reviewedTransaction
                ? billAllocationsByTransactionId[reviewedTransaction.id]
                : null;
              const reviewedBillAllocations = billAllocation?.status === "ready_to_post"
                ? billAllocation.allocations
                : [];
              const postingBillAllocations = reviewedBillAllocations.length > 0
                ? reviewedBillAllocations
                : [];
              return {
                counterpartyLedgerName:
                  reviewedTransaction?.selectedLedgerName ||
                  transaction.confirmedLedgerName ||
                  transaction.suggestedLedgerName ||
                  "Suspense",
                createLedgerName: "",
                createLedgerParentName: "",
                billMatchingVerified:
                  !reviewedTransaction ||
                  !isBillMatchEligibleTransaction(reviewedTransaction, ledgerMasters) ||
                  postingBillAllocations.length > 0,
                duplicateCheckVerified:
                  reviewedTransaction != null &&
                  tallyPresenceByTransactionId[reviewedTransaction.id]?.status === "missing",
                billAllocations: postingBillAllocations.length > 0
                    ? postingBillAllocations.map((allocation) => ({
                        referenceType: allocation.referenceType,
                        referenceName: allocation.referenceName,
                        amount: allocation.allocatedAmount,
                      }))
                    : [],
              };
            })(),
            saveMapping: (() => {
              const reviewedTransaction = reviewedTransactionsByKey.get(transactionQueueKey(transaction));
              return Boolean(
                reviewedTransaction?.ledgerSelectionTouched &&
                reviewedTransaction.selectedLedgerName &&
                !isSuspenseLedgerName(reviewedTransaction.selectedLedgerName)
              );
            })(),
          })),
        }),
      });

      if (!queueResponse.ok) {
        throw new Error(await readError(queueResponse));
      }

      const queueResponsePayload = (await queueResponse.json()) as TallyQueueJobResponse & TallyQueueResult;
      const queuedPayload = queueResponsePayload.jobId
        ? await pollTallyQueueJob(queueResponsePayload.jobId)
        : {
            queuedCount: queueResponsePayload.queuedCount,
            verificationCount: queueResponsePayload.verificationCount,
            commands: queueResponsePayload.commands,
            diagnostics: queueResponsePayload.diagnostics,
          };
      const queuedCommands = queuedPayload.commands ?? [];
      const commandIds = queuedCommands.map((command) => command.id).filter(Boolean);
      const postingConnectionId =
        queuedCommands[0]?.connectionId || queuedCommands[0]?.connection_id || tallyConnectionId;
      setAccounts((current) => [confirmPayload.account, ...current.filter((item) => item.id !== confirmPayload.account.id)]);
      setRecentImports((current) => [confirmPayload.import, ...current.filter((item) => item.id !== confirmPayload.import.id)]);
      setSelectedAccountId(confirmPayload.account.id);
      if (commandIds.length > 0) {
        setTallyPostingStatus(buildTallyPostingStatus(postingConnectionId, commandIds, queuedCommands));
        const voucherCount = queuedPayload.queuedCount ?? 0;
        const paymentCheckCount = queuedPayload.verificationCount ?? 0;
        setBanner({
          tone: "info",
          text: voucherCount > 0 && paymentCheckCount > 0
            ? `Creating ${voucherCount} bank voucher(s) and checking ${paymentCheckCount} outgoing payment(s). Keep this page open while Tally works.`
            : voucherCount > 0
              ? `Creating ${voucherCount} bank voucher(s). Keep this page open while Tally works.`
              : `Checking ${paymentCheckCount} outgoing payment(s) against Tally.`,
        });
        void pollTallyPostingStatus(postingConnectionId, commandIds)
          .then(async (finalStatus) => {
            if (!finalStatus?.finished || finalStatus.failed > 0 || finalStatus.canceled > 0 || !commandConnection) return;
            setBanner({ tone: "info", text: "Tally actions completed. Verifying the statement against live Tally..." });
            const { drafts, balanceProof } = await verifyBankStatementPresence(commandConnection, validTransactions);
            const selectedIds = new Set(selectedTallyWorkTransactions.map((transaction) => transaction.id));
            if (finalStatus.voucherTotal > 0) {
              setPostedTransactionIds((current) => {
                const next = new Set(current);
                for (const transactionId of selectedIds) {
                  if (drafts[transactionId]?.status === "found") next.add(transactionId);
                }
                return next;
              });
            }
            const remainingPostedRows = validTransactions.filter(
              (transaction) => selectedIds.has(transaction.id) && drafts[transaction.id]?.status !== "found"
            ).length;
            const foundRows = Object.values(drafts).filter((draft) => draft.status === "found").length;
            if (remainingPostedRows > 0) {
              setStatementDoneSummary({
                tone: "error",
                title: "Posting verification failed.",
                text: `${remainingPostedRows} posted transaction(s) are still not present in live Tally. They were not treated as completed.`,
              });
              setBanner({
                tone: "error",
                text: `${remainingPostedRows} transaction(s) are still missing after posting. Review the failed rows before retrying.`,
              });
              return;
            }
            const remainingStatementRows = validTransactions.filter(
              (transaction) => drafts[transaction.id]?.status !== "found"
            ).length;
            if (remainingStatementRows > 0) {
              setStatementDoneSummary(null);
              setBanner({
                tone: "success",
                text: `${selectedTallyWorkTransactions.length} selected transaction(s) were posted and verified. ${remainingStatementRows} statement row(s) remain for another posting action.`,
              });
              return;
            }
            const checksOnly = finalStatus.voucherTotal === 0;
            setStatementDoneSummary({
              tone: "success",
              title: checksOnly ? "Statement verified against Tally." : "Posted and verified in Tally.",
              text: checksOnly
                ? `${finalStatus.paymentCheckCompleted} outgoing payment check(s) completed and no Tally entries were created.`
                : `${selectedTallyWorkTransactions.length} selected transaction(s) were posted and verified. ${foundRows} statement row(s) currently have matching Tally vouchers.`,
            });
            setBanner({
              tone: balanceProof?.balancesMatch === false ? "info" : "success",
              text: `${checksOnly ? "No entries were created." : "All selected bank transactions were verified in live Tally."}${balanceProof?.balancesMatch === false ? " Balance differs from Tally; posting remains allowed." : ""}`,
            });
          })
          .catch((pollError) => {
            showToast(
              "error",
              pollError instanceof Error ? pollError.message : "Could not refresh Tally posting status."
            );
          });
      } else {
        setBanner(null);
      }
      showToast(
        "info",
        (queuedPayload.queuedCount ?? 0) > 0 && (queuedPayload.verificationCount ?? 0) > 0
          ? `${queuedPayload.queuedCount ?? 0} bank voucher(s) will be created; ${queuedPayload.verificationCount ?? 0} outgoing payment(s) will be checked.`
          : (queuedPayload.queuedCount ?? 0) > 0
            ? `${queuedPayload.queuedCount ?? 0} bank voucher(s) will be created.`
            : `${queuedPayload.verificationCount ?? 0} outgoing payment check(s) started.`
      );
    } catch (error) {
      showToast(
        "error",
        error instanceof Error
          ? error.message
          : mode === "post_receipts"
            ? "Could not post receipts to Tally."
            : mode === "post_payments"
              ? "Could not post payments to Tally."
              : "Could not post bank transactions to Tally."
      );
    } finally {
      setSendingMode(null);
    }
  }

  return (
    <AppShell defaultSidebarCollapsed>
      <div className="fixed bottom-6 right-6 z-50 flex w-[min(420px,calc(100vw-2rem))] flex-col gap-3">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm font-semibold shadow-lg ${
              toast.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : toast.tone === "info"
                  ? "border-blue-200 bg-blue-50 text-blue-900"
                  : "border-rose-200 bg-rose-50 text-rose-900"
            }`}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            {toast.tone === "success" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 leading-5">{toast.text}</span>
            <button
              type="button"
              aria-label="Close notification"
              className="-mr-1 rounded-md p-1 opacity-70 transition hover:bg-black/5 hover:opacity-100"
              onClick={() => dismissToast(toast.id)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      {shortcutsOpen ? (
        <div
          aria-labelledby="bank-statement-shortcuts-title"
          aria-modal="true"
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setShortcutsOpen(false);
          }}
          role="dialog"
        >
          <div className="w-full max-w-lg rounded-2xl border border-[#ddd3c5] bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-black text-[#1a1a1a]" id="bank-statement-shortcuts-title">
                  Bank statement shortcuts
                </h2>
                <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">
                  {preview
                    ? "Familiar Tally-style keys for reviewing the analysed statement without leaving the table."
                    : "These Tally-style review shortcuts become active after a statement has been analysed."}
                </p>
              </div>
              <button
                aria-label="Close keyboard shortcuts"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#e5ddd0] text-slate-600 transition hover:bg-[#faf8f4]"
                onClick={() => setShortcutsOpen(false)}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 max-h-[60vh] divide-y divide-[#eee7dc] overflow-auto rounded-xl border border-[#e5ddd0] px-4">
              {[
                ["Up / Down", "Move through the filtered transaction list"],
                ["Home / End", "Move to the first or last filtered transaction"],
                ["PgUp / PgDn", "Move one page through filtered transactions"],
                ["Enter", "Confirm the outlined step, then continue through ledger, posting, and the next row"],
                ["Ctrl + Enter", "Change the highlighted row's Tally ledger"],
                ["Alt + F", "Open Filters and focus transaction search"],
                ["Ctrl + B", "Open or close Filters, including while using them"],
                ["Alt + F2", "Open Filters and focus the statement period"],
                ["Esc", "Close the current popover, editor, drawer, filters, or this window"],
              ].map(([shortcut, description]) => (
                <div className="flex items-center gap-4 py-3" key={shortcut}>
                  <kbd className="inline-flex min-w-20 justify-center rounded-md border border-[#d8cbbb] bg-[#faf8f4] px-2 py-1 text-[11px] font-black text-[#4b3828] shadow-sm">
                    {shortcut}
                  </kbd>
                  <span className="text-sm font-semibold text-slate-600">{description}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs font-semibold text-slate-500">
              {preview
                ? "You can also click any Tally Ledger cell to open the same selector directly."
                : "Upload and analyse a statement first; the highlighted-row and filter shortcuts will then be available."}
            </p>
          </div>
        </div>
      ) : null}
      <div className="bank-statements-workflow flex min-h-full flex-col bg-[#f7f7f5] text-[#1a1a1a]">
        <div className="min-w-0 flex-1 px-0 py-3 sm:py-4">
          <div className="flex w-full max-w-none flex-col gap-2.5">
          <header className={`flex flex-col gap-2 md:flex-row md:items-center md:justify-between ${preview ? "border-b border-[#e5ddd0] pb-2" : ""}`}>
            <div>
              <h1 className="flex shrink-0 items-center gap-2 text-xl font-black tracking-tight text-[#1a1a1a] sm:text-2xl">
                Bank Statements
                {preview && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                      statementDoneSummary
                        ? "border-emerald-250 bg-emerald-50 text-emerald-800"
                        : "border-emerald-250 bg-emerald-50 text-emerald-800"
                    }`}
                  >
                    {statementDoneSummary ? "Completed" : "Analyzed"}
                  </span>
                )}
                <button
                  aria-label="View bank statement keyboard shortcuts"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[#ddd3c5] bg-white text-[#6f6255] shadow-sm transition hover:border-amber-300 hover:bg-amber-50 hover:text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                  onClick={() => setShortcutsOpen(true)}
                  title="Keyboard shortcuts"
                  type="button"
                >
                  <Info className="h-4 w-4" />
                </button>
              </h1>
            </div>
            <div className="inline-flex items-center gap-3 rounded-xl border border-[#e5ddd0] bg-white px-3.5 py-2 shadow-sm">
              <div className="flex min-w-0 items-center gap-2">
                {tallyConnected ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
                )}
                <div className="min-w-0">
                  <div className="text-xs font-bold text-[#1a1a1a]">
                    {!selectedCompanyName
                      ? "Select Tally company"
                      : !tallyConnected
                      ? "Tally unavailable"
                      : checkingLiveTallyCompany
                        ? "Checking Tally company"
                        : tallyCompanyContextVerified
                          ? "Tally company verified"
                          : "Switch company in Tally"}
                  </div>
                  <div className="truncate text-[11px] font-semibold text-slate-400 mt-0.5">
                    Gajkesari: {selectedCompanyName || "Not selected"} - Tally: {checkingLiveTallyCompany ? "Checking..." : activeTallyCompanyName || "Not detected"}
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={refreshTallyConnectionStatus}
                  disabled={refreshingConnections}
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {refreshingConnections ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Refresh
                </button>
                {!tallyCompanyContextVerified ? (
                  <button
                    type="button"
                    onClick={() => {
                      setBanner({
                        tone: "info",
                        text: tallyConnected
                          ? "In Tally Prime: press F3 (Company), select the company for this workflow, then return here and refresh."
                          : "Open Tally Prime, load the company for this workflow, then return here and refresh.",
                      });
                    }}
                    className="inline-flex h-8 items-center rounded-xl bg-[#2d2d2d] px-3.5 text-xs font-bold text-white hover:bg-[#1a1a1a] shadow-sm transition-all"
                  >
                    {tallyConnected ? "Show switch steps" : "Connection steps"}
                  </button>
                ) : null}
              </div>
            </div>
          </header>

          {!preview ? (
            <div className="flex w-full min-w-0 flex-wrap items-center gap-1 rounded-xl border border-[#e5ddd0] bg-white px-2 py-1 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
              {[
                ["Upload", "Upload statement"],
                ["Review", "Review file"],
                ["Analyze", "Analyze"],
                ["Match", "Match transactions"],
              ].map(([label, fullLabel], index) => {
                const complete = workflowStep > index;
                const current = workflowStep === index;
                return (
                  <div
                    aria-label={fullLabel}
                    className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-extrabold ${
                      complete
                        ? "bg-emerald-50 text-emerald-800"
                        : current
                          ? "bg-[#fff7e8] text-amber-900"
                          : "text-slate-400"
                    }`}
                    key={fullLabel}
                    title={fullLabel}
                  >
                    <span
                      className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${
                        complete
                          ? "bg-emerald-600 text-white"
                          : current
                            ? "bg-amber-500 text-white"
                            : "bg-slate-100 text-slate-400"
                      }`}
                    >
                      {complete ? <CheckCircle2 className="h-3 w-3" /> : index + 1}
                    </span>
                    {label}
                  </div>
                );
              })}
            </div>
          ) : null}

          {banner && (!preview || banner.tone === "error") && (
            <div
              className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ${
                banner.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : banner.tone === "info"
                    ? "border-blue-200 bg-blue-50 text-blue-800"
                    : "border-rose-200 bg-rose-50 text-rose-800"
              }`}
            >
              <div className="flex items-center gap-2">
                {banner.tone === "success" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{banner.text}</span>
              </div>
              {loading || preview?.processing ? (
                <ExtractionEngineBadge source={analysisEngineSource || preview?.extractionSource} />
              ) : null}
            </div>
          )}

          {postUploadSyncImportId && (postUploadSyncError || syncingMasters) ? (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-2">
                {syncingMasters ? (
                  <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-700" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                )}
                <div className="min-w-0">
                  <div className="font-extrabold">
                    {syncingMasters ? "Tally sync is running" : "Tally sync needed for ledger matching"}
                  </div>
                  <div className="mt-0.5 text-xs font-semibold leading-5 text-amber-900">
                    {postUploadSyncError ||
                      "Statement analysis can continue. Ledger matching will update after Tally sync completes."}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={retryPostUploadSync}
                disabled={!tallyCompanyContextVerified || loading || syncingMasters}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[#2d2d2d] px-4 text-xs font-bold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading || syncingMasters ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {syncingMasters ? "Syncing..." : "Retry sync"}
              </button>
            </div>
          ) : null}

          {preview && statementDoneSummary ? (
            <div
              className={`rounded-2xl border px-5 py-4 shadow-[0_2px_8px_rgba(0,0,0,0.02)] ${
                statementDoneSummary.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : statementDoneSummary.tone === "info"
                    ? "border-blue-200 bg-blue-50 text-blue-900"
                    : "border-rose-200 bg-rose-50 text-rose-900"
              }`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-bold">{statementDoneSummary.title}</div>
                    <div className="mt-1 text-xs font-semibold opacity-80">{statementDoneSummary.text}</div>
                  </div>
                </div>
                <button
                  className="inline-flex h-9 items-center justify-center rounded-xl bg-white px-4 text-xs font-bold text-[#2d2d2d] shadow-sm ring-1 ring-black/5 transition hover:bg-[#faf8f4]"
                  onClick={() => clearStatementReview()}
                  type="button"
                >
                  Upload Another
                </button>
              </div>
            </div>
          ) : null}

          {!preview ? (
            <section
              className={`grid gap-5 ${
                documentPreview || documentPreviewLoading ? "" : "lg:grid-cols-[0.95fr_1.05fr]"
              }`}
            >
              <div
                className={`rounded-2xl border border-[#e5ddd0] bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.02)] ${
                  documentPreview || documentPreviewLoading ? "hidden" : ""
                }`}
              >
                <div className="space-y-4">
                  <label className="block">
                    <span className="text-xs font-bold text-[#5a5046]">Company</span>
                    <select
                      className="mt-1.5 h-11 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                      onChange={(event) => updateStatementContext(event.target.value)}
                      value={selectedCompanyId}
                    >
                      <option value="" disabled>
                        {companyOptions.length === 0 ? "No connected Tally company" : "Select Tally company"}
                      </option>
                      {companyOptions.map((company) => (
                        <option key={company.id} value={company.id}>
                          {formatCompanyOptionLabel(company)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div
                    className="block rounded-xl border border-amber-250 bg-[#fffaf2] px-4 py-3.5 transition"
                    aria-describedby="bank-statement-sync-mode-status"
                  >
                    <span className="flex items-start justify-between gap-4">
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-extrabold text-[#1a1a1a]">
                            Fetch latest Tally ledgers before analysis
                          </span>
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-amber-800">
                            Auto
                          </span>
                        </span>
                        <span
                          id="bank-statement-sync-mode-status"
                          className="mt-1.5 block text-xs font-semibold leading-5 text-[#6f6256]"
                        >
                          {syncModeStatus.tone === "warning"
                            ? "Fresh ledger fetch will run before analysis once the selected Tally company is verified."
                            : syncModeStatus.text}
                        </span>
                      </span>
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                    </span>
                  </div>

                  {syncModeStatus.tone === "warning" ? (
                    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                      <span>
                        <span className="block font-extrabold">{syncModeStatus.title}</span>
                        <span className="mt-0.5 block leading-5">{syncModeStatus.text}</span>
                      </span>
                    </div>
                  ) : !documentPreview && !documentPreviewLoading ? (
                    <div className="flex items-center gap-2 px-1 text-xs font-bold text-emerald-800">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      Ready to upload.
                    </div>
                  ) : null}
                </div>
              </div>

              <section
                className={
                  documentPreview
                    ? "min-w-0"
                    : `rounded-2xl border border-[#e5ddd0] bg-white shadow-[0_2px_8px_rgba(0,0,0,0.02)] ${
                        documentPreviewLoading ? "p-3 sm:p-4" : "p-6"
                      }`
                }
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.txt,.pdf,image/*"
                  className="hidden"
                  onClick={(event) => {
                    event.currentTarget.value = "";
                  }}
                  onChange={(event) => {
                    const nextFile = event.target.files?.[0] ?? null;
                    if (nextFile) void handleSelectedStatementFile(nextFile);
                  }}
                />
                {!documentPreview && !documentPreviewLoading ? (
                  <button
                    type="button"
                    aria-disabled={!uploadContextReady || loading}
                    onClick={() => {
                      if (!uploadContextReady) {
                        setBanner({ tone: "error", text: setupErrorMessage || "Complete setup before upload." });
                        return;
                      }
                      fileInputRef.current?.click();
                    }}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      if (uploadContextReady) setDragActive(true);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (uploadContextReady) setDragActive(true);
                    }}
                    onDragLeave={(event) => {
                      event.preventDefault();
                      setDragActive(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragActive(false);
                      const nextFile = event.dataTransfer.files?.[0] ?? null;
                      if (!nextFile) return;
                      if (!uploadContextReady) {
                        setBanner({ tone: "error", text: setupErrorMessage || "Complete setup before upload." });
                        return;
                      }
                      void handleSelectedStatementFile(nextFile);
                    }}
                    className={`flex min-h-[420px] w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-all duration-300 ${
                      dragActive
                        ? "border-amber-500 bg-amber-50/40"
                        : uploadContextReady
                          ? "border-amber-200 bg-amber-50/10 hover:border-amber-400 hover:bg-amber-50/30"
                          : "border-[#e5ddd0] bg-white opacity-70 cursor-not-allowed"
                    }`}
                  >
                    <div className={`mb-5 flex h-14 w-14 items-center justify-center rounded-xl transition-colors ${
                      uploadContextReady ? "bg-[#2d2d2d] text-white" : "bg-slate-100 text-slate-400"
                    } shadow-sm`}>
                      {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <UploadCloud className="h-6 w-6" />}
                    </div>
                    <div className="text-lg font-extrabold text-[#1a1a1a]">
                      {loading ? "Analyzing..." : uploadContextReady ? "Upload statement" : "Connect Tally company"}
                    </div>
                    <div className="mt-1 text-xs font-semibold text-slate-400">
                      Supports CSV, TXT, PDF or scanned statement images
                    </div>
                  </button>
                ) : null}
                {documentPreviewLoading && !documentPreview ? (
                  <div className="flex min-h-[420px] w-full flex-col items-center justify-center rounded-2xl border border-[#e5ddd0] bg-[#fffdf9] px-6 py-10 text-center">
                    <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-[#2d2d2d] text-white shadow-sm">
                      <Loader2 className="h-6 w-6 animate-spin" />
                    </div>
                    <div className="text-lg font-extrabold text-[#1a1a1a]">Reading file...</div>
                    <div className="mt-1 text-xs font-semibold text-slate-400">Preparing preview before analysis</div>
                  </div>
                ) : null}
                {documentPreview ? (
                  <div className="grid min-w-0 overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white shadow-[0_8px_24px_rgba(45,45,45,0.06)] xl:grid-cols-[290px_minmax(0,1fr)]">
                    <div className="bg-[#fffdf9] xl:border-r xl:border-[#eee5d8]">
                    <div className="space-y-3 p-4">
                      <label className="block min-w-0">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[#8b7a68]">Company</span>
                        <select
                          className="mt-1 h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                          onChange={(event) => updateStatementContext(event.target.value)}
                          value={selectedCompanyId}
                        >
                          <option value="" disabled>
                            {companyOptions.length === 0 ? "No connected Tally company" : "Select Tally company"}
                          </option>
                          {companyOptions.map((company) => (
                            <option key={company.id} value={company.id}>
                              {formatCompanyOptionLabel(company)}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div
                        className="flex min-h-9 items-center justify-between gap-3 rounded-xl border border-amber-200 bg-[#fffaf2] px-3 py-2 transition"
                        aria-describedby="bank-statement-sync-mode-status-preview"
                      >
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-extrabold text-[#1a1a1a]">Fresh Tally fetch first</span>
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-amber-800">
                              Auto
                            </span>
                          </span>
                          <span
                            id="bank-statement-sync-mode-status-preview"
                            className="sr-only"
                          >
                            {syncModeStatus.text}
                          </span>
                        </span>
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-amber-700" />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            clearSelectedStatementFile();
                            fileInputRef.current?.click();
                          }}
                          className="inline-flex h-9 w-full items-center justify-center rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#5a5046] transition hover:bg-[#faf8f4] hover:text-[#1a1a1a]"
                        >
                          Upload another
                        </button>
                        <button
                          type="button"
                          disabled={
                            Boolean(documentPreview.error) ||
                            loading ||
                            documentPreviewLoading ||
                            statementPasswordChecking ||
                            (documentPreview.kind === "pdf" && !documentPreview.objectUrl) ||
                            !file ||
                            !selectedCompanyId ||
                            !uploadContextReady ||
                            (statementPasswordRequired &&
                              (!statementPassword.trim() ||
                                !statementPasswordVerified ||
                                statementPasswordChecking)) ||
                            Boolean(statementPasswordError && !statementPasswordRequired)
                          }
                          onClick={() => {
                            if (file) void analyzeFile(file);
                          }}
                          className="inline-flex h-9 w-full items-center justify-center rounded-xl bg-[#2d2d2d] px-3 text-xs font-bold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Analyze file
                        </button>
                      </div>
                    </div>

                    <div className="space-y-3 border-t border-[#eee5d8] bg-[#fffaf2] p-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#2d2d2d] text-white">
                          <UploadCloud className="h-4.5 w-4.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-extrabold text-[#1a1a1a]" title={documentPreview.fileName}>
                            {documentPreview.fileName}
                          </div>
                          <div className="mt-0.5 text-xs font-semibold text-[#7a6c5f]">
                            {documentPreview.error ? (
                              "Preview needs attention"
                            ) : documentPreview.kind === "csv" ? (
                              `${formatFileSize(file?.size)} - ${documentPreview.totalRows} transaction row${documentPreview.totalRows === 1 ? "" : "s"} found. Showing ${documentPreview.rows.length}.`
                            ) : documentPreview.kind === "text" ? (
                              `${formatFileSize(file?.size)} - ${documentPreview.totalRows} readable line${documentPreview.totalRows === 1 ? "" : "s"} found. Showing ${documentPreview.textLines.length}.`
                            ) : documentPreview.kind === "pdf" ? (
                              `${formatFileSize(file?.size)} - PDF selected. Review it below before analysis.`
                            ) : documentPreview.kind === "image" ? (
                              `${formatFileSize(file?.size)} - Image selected. Review it below before analysis.`
                            ) : (
                              "Review the selected file before analysis."
                            )}
                          </div>
                        </div>
                      </div>
                      {documentPreview.kind === "pdf" &&
                      (statementPasswordRequired || statementPasswordError || statementPasswordChecking) ? (
                        <div
                          className={`rounded-xl border px-3 py-3 ${
                            statementPasswordVerified
                              ? "border-emerald-200 bg-emerald-50"
                              : statementPasswordError
                                ? "border-rose-200 bg-rose-50"
                                : "border-amber-200 bg-white"
                          }`}
                        >
                          <label className={statementPasswordVerified ? "hidden" : "block"}>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800">
                              Statement password
                            </span>
                            <div className="mt-2 flex gap-2">
                              <input
                                autoComplete="off"
                                autoFocus={statementPasswordRequired}
                                className="h-9 min-w-0 flex-1 rounded-xl border border-[#e5ddd0] bg-white px-3 text-sm font-semibold text-[#1a1a1a] outline-none transition placeholder:text-slate-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                                disabled={statementPasswordChecking}
                                onChange={(event) => {
                                  setStatementPassword(event.target.value);
                                  setStatementPasswordError(null);
                                  setStatementPasswordVerified(false);
                                  setBanner(null);
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && statementPassword.trim() && !statementPasswordChecking) {
                                    event.preventDefault();
                                    void unlockStatementPdfPreview(file, statementPassword);
                                  }
                                }}
                                placeholder="Enter PDF password"
                                type="password"
                                value={statementPassword}
                              />
                              <button
                                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[#2d2d2d] px-3 text-xs font-bold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={!statementPassword.trim() || statementPasswordChecking}
                                onClick={() => void unlockStatementPdfPreview(file, statementPassword)}
                                type="button"
                              >
                                {statementPasswordChecking ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : null}
                                {statementPasswordChecking ? "Checking" : "Unlock preview"}
                              </button>
                            </div>
                          </label>
                          <div
                            aria-live="polite"
                            className={`flex items-start gap-2 text-xs font-semibold ${
                              statementPasswordVerified
                                ? "text-emerald-800"
                                : statementPasswordError
                                  ? "mt-2 text-rose-800"
                                  : "mt-2 text-[#7a6c5f]"
                            }`}
                          >
                            {statementPasswordVerified ? (
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                            ) : (
                              <AlertTriangle
                                className={`mt-0.5 h-4 w-4 shrink-0 ${
                                  statementPasswordError ? "text-rose-700" : "text-amber-700"
                                }`}
                              />
                            )}
                            <span>
                              {statementPasswordVerified
                                ? "PDF unlocked. Preview and analysis are ready."
                                : statementPasswordError ||
                                  "This PDF is protected. Enter its password to unlock the preview."}
                            </span>
                          </div>
                          {statementPasswordRequired && !statementPasswordVerified ? (
                            <div className="mt-1 text-[11px] font-semibold text-[#7a6c5f]">
                              The password is used only to unlock this PDF for analysis. It is not saved.
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    </div>
                    <div className="min-w-0 bg-white p-3 xl:col-start-2 xl:row-start-1">
                      <div className="overflow-hidden rounded-xl border border-[#e5ddd0] bg-white">
                        {documentPreview.error ? (
                          <div className="flex items-start gap-2 px-5 py-4 text-xs font-semibold text-rose-800">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{documentPreview.error}</span>
                          </div>
                        ) : documentPreview.kind === "csv" ? (
                          <div className="max-h-[560px] overflow-auto bg-white">
                            <table className="min-w-full border-collapse text-left text-xs">
                              <thead className="sticky top-0 bg-[#f7f2ea] text-[#5a5046]">
                                <tr>
                                  {documentPreview.headers.map((header, index) => (
                                    <th
                                      key={`${header}-${index}`}
                                      className="max-w-[220px] border-b border-[#e5ddd0] px-3 py-2 font-extrabold"
                                      title={header}
                                    >
                                      <span className="block truncate">{header}</span>
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="bg-white text-[#2b241d]">
                                {documentPreview.rows.map((row, rowIndex) => (
                                  <tr key={`csv-row-${rowIndex}`} className="border-b border-[#f0e8dc] last:border-b-0">
                                    {row.map((value, cellIndex) => (
                                      <td
                                        key={`csv-cell-${rowIndex}-${cellIndex}`}
                                        className="max-w-[220px] px-3 py-2 font-semibold"
                                        title={value}
                                      >
                                        <span className="block truncate">{value || "-"}</span>
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : documentPreview.kind === "text" ? (
                          <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap bg-white px-5 py-4 text-xs font-semibold leading-5 text-[#2b241d]">
                            {documentPreview.textLines.join("\n")}
                          </pre>
                        ) : documentPreview.kind === "pdf" && documentPreview.objectUrl ? (
                          <ScrollablePdfPreview
                            fileName={documentPreview.fileName}
                            objectUrl={documentPreview.objectUrl}
                          />
                        ) : documentPreview.kind === "pdf" ? (
                          <div className="flex min-h-[420px] items-center justify-center bg-[#faf8f4] px-6 py-12 text-center">
                            <div className="max-w-sm">
                              <div
                                className={`mx-auto flex h-11 w-11 items-center justify-center rounded-2xl ${
                                  statementPasswordChecking
                                    ? "bg-slate-200 text-slate-600"
                                    : "bg-amber-100 text-amber-800"
                                }`}
                              >
                                {statementPasswordChecking ? (
                                  <Loader2 className="h-5 w-5 animate-spin" />
                                ) : (
                                  <Landmark className="h-5 w-5" />
                                )}
                              </div>
                              <div className="mt-3 text-sm font-extrabold text-[#1a1a1a]">
                                {statementPasswordChecking ? "Checking PDF security" : "Password required"}
                              </div>
                              <p className="mt-1 text-xs font-semibold leading-5 text-[#7a6c5f]">
                                {statementPasswordChecking
                                  ? "Preparing a safe preview without storing the document password."
                                  : "Enter the PDF password on the left, then choose Unlock preview."}
                              </p>
                            </div>
                          </div>
                        ) : documentPreview.kind === "image" && documentPreview.objectUrl ? (
                          <div className="flex max-h-[640px] items-center justify-center overflow-auto bg-white p-5">
                            {/* eslint-disable-next-line @next/next/no-img-element -- Local object URLs cannot be optimized by next/image. */}
                            <img
                              src={documentPreview.objectUrl}
                              alt={`Preview of ${documentPreview.fileName}`}
                              className="max-h-[600px] max-w-full rounded-xl object-contain"
                            />
                          </div>
                        ) : (
                          <div className="px-5 py-4 text-xs font-semibold text-[#7a6c5f]">
                            No preview is available for this file.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>
            </section>
          ) : (
            <section className="space-y-0">
              <div className="border-y border-[#e5ddd0] bg-transparent px-1 py-2 sm:px-2">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                  {/* Left: Statement Account -> Tally Ledger */}
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:gap-3">
                    {/* Statement Account Box */}
                    <div className="flex min-w-0 items-center gap-1.5">
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[#e5ddd0] bg-[#f5f0e8] text-[#6f6255]">
                        <Landmark className="h-3 w-3" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-slate-400">Statement Account</div>
                        <div className="flex flex-wrap items-baseline gap-1 text-[11px] leading-[13px]">
                          <span className="font-extrabold text-[#1a1a1a]">
                            {account.bankName || "Detected Account"}
                          </span>
                          {account.accountNumber ? (
                            <span className="font-mono text-[9px] font-bold text-[#5a5046]">
                              · {account.accountNumber}
                            </span>
                          ) : null}
                          {account.accountHolderName && account.accountHolderName !== "Holder not found" ? (
                            <span className="text-[8px] font-semibold text-slate-400">
                              ({account.accountHolderName})
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    {/* Mapping Arrow */}
                    <div className="hidden sm:flex items-center text-slate-300">
                      <ArrowRight className="h-3 w-3 text-emerald-600" />
                    </div>

                    {/* Tally Ledger Box */}
                    {!bankLedgerChangeMode && bankLedgerName ? (
                      <div className="flex min-w-0 items-center gap-1.5">
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700">
                          <CheckCircle2 className="h-3 w-3" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-slate-400">Tally Ledger</span>
                            <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[7px] font-extrabold uppercase tracking-wider text-emerald-800">
                              Matched
                            </span>
                          </div>
                          <div className="truncate text-[11px] font-extrabold leading-[13px] text-[#1a1a1a]" title={bankLedgerName}>
                            {bankLedgerName}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {/* Right Actions */}
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-[#eee7dc] pt-1.5 lg:border-t-0 lg:pt-0">
                    {preview.candidates.length > 1 ? (
                      <select
                        value={selectedAccountId || "new"}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSelectedAccountId(value === "new" ? "" : value);
                          const candidate = preview.candidates.find((item) => item.id === value);
                          if (candidate) {
                            setAccount({
                              bankName: candidate.bankName || account.bankName,
                              accountNumber: candidate.accountNumber || account.accountNumber,
                              accountHolderName: candidate.accountHolderName || account.accountHolderName,
                              ifscCode: candidate.ifscCode || account.ifscCode,
                              tallyLedgerName: candidate.tallyLedgerName || account.tallyLedgerName,
                            });
                            if (candidate.tallyLedgerName) {
                              setBankLedgerName(candidate.tallyLedgerName);
                              setBankLedgerVerified(true);
                              setBankLedgerManuallyConfirmed(true);
                            }
                          }
                        }}
                        className="h-7 rounded-md border border-[#e5ddd0] bg-white px-2 text-[9px] font-bold text-[#5a5046] outline-none"
                      >
                        <option value="new">Extracted account</option>
                        {preview.candidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.accountHolderName || "Saved account"} - {candidate.accountNumber || candidate.accountNumberMasked}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {!bankLedgerChangeMode && bankLedgerName ? (
                      <button
                        type="button"
                        onClick={beginBankLedgerChange}
                        className="inline-flex h-7 items-center rounded-md border border-[#e5ddd0] bg-white px-2.5 text-[9px] font-bold text-[#5a5046] shadow-sm transition-all hover:bg-[#faf8f4] hover:text-[#1a1a1a]"
                      >
                        Change ledger
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={handleSyncLedgerMasters}
                      disabled={!tallyCompanyContextVerified || syncingMasters || loadingBankLedgers}
                      className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-[#e5ddd0] bg-white px-2.5 text-[9px] font-bold text-[#5a5046] shadow-sm transition-all hover:bg-[#faf8f4] hover:text-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {syncingMasters || loadingBankLedgers ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      Sync
                    </button>
                  </div>
                </div>

                {/* Ledger Selection Mode */}
                {bankLedgerChangeMode || !bankLedgerName ? (
                  <div className="mt-2 border-t border-[#eee7dc] pt-2">
                    <div className="mb-1 text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#5a5046]">
                      {bankLedgerChangeMode ? "Select replacement Tally bank ledger" : "Choose matching Tally bank ledger"}
                    </div>
                    <LedgerSearchSelect
                      groups={bankLedgerPickerGroups}
                      onChange={bankLedgerChangeMode ? setPendingBankLedgerName : applyTallyBankLedgerSelection}
                      onCommit={bankLedgerChangeMode ? commitBankLedgerChange : undefined}
                      placeholder="Search bank accounts or all Tally ledgers"
                      value={bankLedgerChangeMode ? pendingBankLedgerName : ""}
                    />
                    {bankLedgerChangeMode ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <button
                          className="inline-flex h-7 items-center rounded-md bg-[#2d2d2d] px-3 text-[9px] font-bold text-white transition hover:bg-[#1a1a1a]"
                          onClick={confirmBankLedgerChange}
                          type="button"
                        >
                          Use selected ledger
                        </button>
                        <button
                          className="inline-flex h-7 items-center rounded-md px-2 text-[9px] font-bold text-slate-500 transition hover:bg-slate-100 hover:text-[#1a1a1a]"
                          onClick={cancelBankLedgerChange}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="mt-1.5 flex items-start gap-1.5 text-[9px] font-semibold text-amber-700">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>Choose the intended ledger - no exact account match was found in Tally.</span>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="overflow-hidden border-b border-[#e5ddd0] bg-transparent">
                <div className="border-b border-[#e5ddd0] px-4 py-2.5">
                  <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        className={`inline-flex h-8 w-fit items-center gap-1.5 rounded-lg border px-3 text-[11px] font-bold transition-all ${
                          reviewFiltersOpen || activeReviewFilterCount > 0
                            ? "border-amber-300 bg-amber-50 text-amber-800"
                            : "border-[#e5ddd0] bg-white text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a]"
                        }`}
                        onClick={() => setReviewFiltersOpen((current) => !current)}
                        type="button"
                      >
                        <Filter className="h-3.5 w-3.5" />
                        Filters
                        {activeReviewFilterCount > 0 ? (
                          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#2d2d2d] px-1 text-[9px] text-white">
                            {activeReviewFilterCount}
                          </span>
                        ) : null}
                      </button>
                      <span className="text-[11px] font-bold text-slate-400">
                        {filteredTransactions.length === validTransactions.length
                          ? `${validTransactions.length} transaction${validTransactions.length === 1 ? "" : "s"}`
                          : `${filteredTransactions.length} of ${validTransactions.length} transactions`}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 rounded-lg border border-[#e5ddd0] bg-[#faf8f4]/70 px-3 py-1.5 text-[10px] font-bold">
                      <span className="inline-flex items-center gap-1.5 text-slate-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                        {validTransactions.length} checked
                      </span>
                      {uncheckedTallyPresenceCount === 0 ? (
                        <>
                          <span className="inline-flex items-center gap-1.5 text-emerald-800">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            {alreadyInTallyCount} in Tally
                          </span>
                          <span className="inline-flex items-center gap-1.5 text-blue-800">
                            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                            {transactionOutcomeCounts.receiptsToCreate} receipt{transactionOutcomeCounts.receiptsToCreate === 1 ? "" : "s"} to create
                          </span>
                          <span className={`inline-flex items-center gap-1.5 ${blockingPaymentBillAllocationCount > 0 ? "text-amber-800" : "text-blue-800"}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${blockingPaymentBillAllocationCount > 0 ? "bg-amber-500" : "bg-blue-500"}`} />
                            {transactionOutcomeCounts.paymentsToCreate} payment{transactionOutcomeCounts.paymentsToCreate === 1 ? "" : "s"} to create
                          </span>
                          <span className={`inline-flex items-center gap-1.5 ${transactionOutcomeCounts.needsAttention > 0 ? "text-amber-800" : "text-emerald-800"}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${transactionOutcomeCounts.needsAttention > 0 ? "bg-amber-500" : "bg-emerald-500"}`} />
                            {transactionOutcomeCounts.needsAttention} need review
                          </span>
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-slate-600">
                          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
                          Live Tally check pending
                        </span>
                      )}
                    </div>
                  </div>
                  {reviewFiltersOpen ? (
                    <div className="mt-3 rounded-xl border border-[#e5ddd0] bg-[#faf8f4]/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                      <div className="mb-3 flex items-start justify-between gap-3 border-b border-[#e5ddd0] pb-2.5">
                        <div>
                          <div className="text-[11px] font-extrabold text-[#1a1a1a]">Filter transactions</div>
                          <div className="mt-0.5 text-[9px] font-semibold text-slate-400">
                            Combine search, workflow, Tally, ledger, and period filters.
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            className="h-7 rounded-lg border border-[#e5ddd0] bg-white px-2.5 text-[9px] font-bold text-[#5a5046] transition hover:bg-[#f5f1eb] hover:text-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={activeReviewFilterCount === 0}
                            onClick={() => {
                              setReviewSearch("");
                              setReviewWorkStatusFilter("all");
                              setReviewTallyResultFilter("all");
                              setReviewLedgerFilter("all");
                              setReviewDirectionFilter("all");
                              setReviewAllocationFilter("all");
                              setReviewDateFrom("");
                              setReviewDateTo("");
                            }}
                            type="button"
                          >
                            Clear all
                          </button>
                          <button
                            aria-label="Close transaction filters"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[#e5ddd0] bg-white text-slate-400 transition hover:bg-[#f5f1eb] hover:text-[#1a1a1a]"
                            onClick={() => setReviewFiltersOpen(false)}
                            type="button"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-12 xl:items-end">
                        <label className="block xl:col-span-4">
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Search</span>
                          <div className="relative mt-1">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                            <input
                              className="h-8 w-full rounded-lg border border-[#e5ddd0] bg-white px-2.5 pl-8 text-[11px] font-semibold text-[#1a1a1a] outline-none placeholder:text-slate-400 focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                              onChange={(event) => setReviewSearch(event.target.value)}
                              placeholder="Narration, amount, ledger or reference"
                              ref={reviewSearchInputRef}
                              value={reviewSearch}
                            />
                          </div>
                        </label>

                        <label className="block xl:col-span-2">
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Work status</span>
                          <select
                            className="mt-1 h-8 w-full rounded-lg border border-[#e5ddd0] bg-white px-2.5 text-[10px] font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewWorkStatusFilter(event.target.value as ReviewWorkStatusFilter)}
                            title="Needs action contains only unresolved close ledger matches."
                            value={reviewWorkStatusFilter}
                          >
                            <option value="all">All ({validTransactions.length})</option>
                            <option value="needs_action">Needs action ({reviewWorkStatusCounts.needsAction})</option>
                            <option value="ready">Ready ({reviewWorkStatusCounts.ready})</option>
                            <option value="completed">Completed ({reviewWorkStatusCounts.completed})</option>
                          </select>
                        </label>

                        <label className="block xl:col-span-2">
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Tally status</span>
                          <select
                            className="mt-1 h-8 w-full rounded-lg border border-[#e5ddd0] bg-white px-2.5 text-[10px] font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewTallyResultFilter(event.target.value as ReviewTallyResultFilter)}
                            value={reviewTallyResultFilter}
                          >
                            <option value="all">All results</option>
                            <option value="pending">Check pending</option>
                            <option value="found">Found in Tally</option>
                            <option value="missing">Not found</option>
                            <option value="review">Ambiguous / duplicate</option>
                            <option value="failed">Failed / cannot check</option>
                          </select>
                        </label>

                        <label className="block xl:col-span-2">
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Ledger review</span>
                          <select
                            className="mt-1 h-8 w-full rounded-lg border border-[#e5ddd0] bg-white px-2.5 text-[10px] font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewLedgerFilter(event.target.value as ReviewLedgerFilter)}
                            value={reviewLedgerFilter}
                          >
                            <option value="all">All reviews</option>
                            <option value="needs_action">Close match action</option>
                            <option value="automatic">Auto matched</option>
                            <option value="manual">Manually confirmed</option>
                            <option value="suspense">Suspense / no match</option>
                          </select>
                        </label>

                        <label className="block xl:col-span-2">
                          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Money flow</span>
                          <select
                            className="mt-1 h-8 w-full rounded-lg border border-[#e5ddd0] bg-white px-2.5 text-[10px] font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewDirectionFilter(event.target.value as ReviewDirectionFilter)}
                            value={reviewDirectionFilter}
                          >
                            <option value="all">Payments + receipts</option>
                            <option value="debit">Payments only</option>
                            <option value="credit">Receipts only</option>
                          </select>
                        </label>

                        <fieldset className={`min-w-0 rounded-lg border border-[#e5ddd0] bg-white px-2.5 pb-2 pt-1.5 md:col-span-2 ${tallyCheckAttempted ? "xl:col-span-8" : "xl:col-span-12"}`}>
                          <legend className="px-1 text-[9px] font-bold uppercase tracking-wider text-slate-400">Statement period</legend>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <label className="block min-w-0">
                              <span className="text-[8px] font-bold uppercase tracking-wide text-slate-400">From</span>
                              <div className="relative mt-0.5">
                                <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                                <input
                                  className="h-8 w-full rounded-lg border border-[#e5ddd0] bg-[#fcfbfa] px-2.5 pl-8 text-[10px] font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                                  onChange={(event) => setReviewDateFrom(event.target.value)}
                                  ref={reviewPeriodInputRef}
                                  type="date"
                                  value={reviewDateFrom}
                                />
                              </div>
                            </label>
                            <label className="block min-w-0">
                              <span className="text-[8px] font-bold uppercase tracking-wide text-slate-400">To</span>
                              <div className="relative mt-0.5">
                                <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                                <input
                                  className="h-8 w-full rounded-lg border border-[#e5ddd0] bg-[#fcfbfa] px-2.5 pl-8 text-[10px] font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                                  onChange={(event) => setReviewDateTo(event.target.value)}
                                  type="date"
                                  value={reviewDateTo}
                                />
                              </div>
                            </label>
                          </div>
                        </fieldset>

                        {tallyCheckAttempted ? (
                          <label className="block md:col-span-2 xl:col-span-4">
                            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Receipt allocation</span>
                            <select
                              className="mt-1 h-8 w-full rounded-lg border border-[#e5ddd0] bg-white px-2.5 text-[10px] font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                              onChange={(event) => setReviewAllocationFilter(event.target.value as ReviewAllocationFilter)}
                              value={reviewAllocationFilter}
                            >
                              <option value="all">All allocations</option>
                              <option value="needs_action">Needs allocation action</option>
                              <option value="ready">Ready to post</option>
                              <option value="completed">Allocation completed</option>
                              <option value="not_applicable">Not applicable</option>
                            </select>
                          </label>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div ref={reviewTableScrollRef} className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-230px)] [scrollbar-gutter:stable]">
                  <table className="w-full min-w-full table-fixed border-collapse text-left md:min-w-[900px] xl:min-w-[1120px]">
                    <thead className="sticky top-0 z-20">
                      <tr className="border-b border-[#d8cbbb] bg-[#f7f3ed] text-[9px] font-extrabold uppercase tracking-[0.1em] text-[#776b5f]">
                        <th className="w-[74px] px-3 py-2">Date</th>
                        <th className="w-auto px-2 py-2 sm:px-3 md:w-[28%]">Particulars</th>
                        <th className="hidden w-[84px] px-2 py-2 lg:table-cell">Vch type</th>
                        <th className="hidden w-[120px] px-2 py-2 xl:table-cell">Reference</th>
                        <th className="hidden w-[104px] px-3 py-2 text-right md:table-cell">
                          <span className="block">Payment</span>
                        </th>
                        <th className="hidden w-[104px] px-3 py-2 text-right md:table-cell">
                          <span className="block">Receipt</span>
                        </th>
                        <th className="w-[92px] px-2 py-2 text-right md:hidden">Amount</th>
                        <th className="hidden w-[23%] px-3 py-2 md:table-cell">Tally ledger</th>
                        <th className="w-[160px] px-2 py-2 sm:w-[200px] sm:px-3">Posting status</th>
                        <th className="sticky right-0 w-10 border-l border-[#e5ddd0] bg-[#f7f3ed] px-1 py-2" aria-label="Edit ledger"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#e5ddd0] text-[10px] font-semibold text-slate-600">
                      {validTransactions.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="px-6 py-12 text-center text-xs font-semibold text-slate-400">
                            No posting rows were extracted. Upload another file or add rows after extraction support improves.
                          </td>
                        </tr>
                      ) : visibleReviewTransactions.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="px-6 py-12 text-center text-xs font-semibold text-slate-400">
                            No rows match the current filters.
                          </td>
                        </tr>
                      ) : (
                        visibleReviewTransactions.map((transaction) => {
                          const debit = formatAmount(transaction.debitAmount);
                          const credit = formatAmount(transaction.creditAmount);
                          const partyTitle = getTransactionPartyTitle(transaction);
                          const selectedLedger = ledgerMastersByNormalizedName.get(
                            normalizeName(transaction.selectedLedgerName)
                          ) ?? null;
                          const proposedVoucherType = getProposedBankVoucherType(
                            transaction,
                            ledgerMasters,
                            selectedLedger
                          );
                          const ledgerGroupLabel = getLedgerGroupLabel(
                            transaction,
                            ledgerMasters,
                            selectedLedger
                          );
                          const mode = getTransactionMode(transaction);
                          const reference = getTransactionReference(transaction);
                          const isEditingLedger = editingLedgerIds.has(transaction.id);
                          const showLedgerSelect = isEditingLedger;
                          const ledgerDisplayName =
                            transaction.selectedLedgerName ||
                            transaction.suggestedLedgerName ||
                            "-";
                          const billAllocation = billAllocationsByTransactionId[transaction.id];
                          const outgoingVerification = outgoingVerificationsByTransactionId[transaction.id];
                          const tallyPresence = tallyPresenceByTransactionId[transaction.id];
                          const postedThisSession = postedTransactionIds.has(transaction.id);
                          const outgoingPayment = isOutgoingPaymentRow(transaction);
                          const outgoingNeedsBillAllocation = Boolean(
                            outgoingPayment &&
                            tallyPresence?.status === "missing" &&
                            isBillMatchEligibleTransaction(transaction, ledgerMasters)
                          );
                          const ledgerMatchStatus = getReviewStatusLabel(transaction);
                          const postingReviewAction = getReviewPostingAction(
                            transaction,
                            ledgerMasters,
                            tallyPresence
                          );
                          const highlightedReviewAction = showLedgerSelect || reviewActionStage === "ledger"
                            ? "ledger"
                            : postingReviewAction;
                          const narrationExpanded = expandedNarrationTransactionId === transaction.id;

                          return (
                            <tr
                              aria-selected={activeReviewTransactionIdRef.current === transaction.id}
                              className="group cursor-pointer bg-white align-top hover:bg-[#fff9e8] data-[active=true]:bg-[#fff4d6] data-[active=true]:shadow-[inset_3px_0_0_#d69a28]"
                              data-active={activeReviewTransactionIdRef.current === transaction.id ? "true" : "false"}
                              key={transaction.id}
                              onClick={(event) => {
                                const target = event.target;
                                if (
                                  target instanceof HTMLElement &&
                                  target.closest("button, input, select, textarea, [role='button']")
                                ) {
                                  return;
                                }
                                if (reviewActionStage === "ledger") {
                                  if (!statementReviewLocked) setEditingLedgerIds(new Set([transaction.id]));
                                } else {
                                  openPostingReviewAction(transaction);
                                }
                              }}
                              onMouseDown={() => selectReviewTransaction(transaction.id)}
                              ref={(node) => {
                                if (node) reviewRowRefs.current.set(transaction.id, node);
                                else reviewRowRefs.current.delete(transaction.id);
                              }}
                            >
                              <td className="px-3 py-2 align-top text-[10px] font-bold leading-[12px] text-slate-600">
                                {formatShortDate(getEffectiveTransactionDate(transaction))}
                              </td>
                              <td
                                aria-expanded={narrationExpanded}
                                className={`px-2 py-2 align-top sm:px-3 ${
                                  narrationExpanded ? "cursor-zoom-out" : "cursor-zoom-in"
                                }`}
                                data-narration-cell
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setExpandedNarrationTransactionId((current) =>
                                    current === transaction.id ? null : transaction.id
                                  );
                                }}
                                title={narrationExpanded ? "Click to collapse narration" : "Click to view full narration"}
                              >
                                <div className="truncate text-[11px] font-extrabold leading-[14px] text-[#1a1a1a]" title={partyTitle}>
                                  {partyTitle}
                                </div>
                                <div
                                  className={`mt-0.5 text-[9px] font-semibold leading-[13px] text-slate-500 ${
                                    narrationExpanded
                                      ? "whitespace-normal break-words"
                                      : "truncate"
                                  }`}
                                  title={narrationExpanded ? undefined : transaction.description}
                                >
                                  {transaction.description || "Narration not found"}
                                </div>
                                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 lg:hidden">
                                  <span className={`text-[8px] font-extrabold uppercase ${
                                    proposedVoucherType === "Receipt"
                                      ? "text-emerald-700"
                                      : proposedVoucherType === "Payment"
                                        ? "text-red-700"
                                        : "text-sky-700"
                                  }`}>
                                    {proposedVoucherType || "-"}
                                  </span>
                                  <span className="truncate text-[8px] font-bold uppercase text-slate-400">{mode || "-"}</span>
                                </div>
                                <div className="mt-0.5 truncate text-[8px] font-bold text-[#5a5046] md:hidden" title={ledgerDisplayName}>
                                  {ledgerDisplayName}
                                </div>
                              </td>
                              <td className="hidden px-2 py-2 align-top lg:table-cell">
                                <span
                                  aria-label={proposedVoucherType ? `Tally voucher type: ${proposedVoucherType}` : undefined}
                                  className={`block text-[10px] font-extrabold leading-[13px] ${
                                    proposedVoucherType === "Receipt"
                                      ? "text-emerald-700"
                                      : proposedVoucherType === "Payment"
                                        ? "text-red-700"
                                        : "text-sky-700"
                                  }`}
                                  title={proposedVoucherType ? `Will post as ${proposedVoucherType} voucher` : undefined}
                                >
                                  {proposedVoucherType || "-"}
                                </span>
                                <span className="mt-0.5 block truncate text-[8px] font-bold uppercase text-slate-500">
                                  {mode || "-"}
                                </span>
                              </td>
                              <td className="hidden px-2 py-2 align-top text-[9px] font-bold leading-[12px] text-slate-600 xl:table-cell" title={reference}>
                                <span className="block truncate">{reference || "-"}</span>
                              </td>
                              <td className="hidden px-3 py-2 align-top text-right text-[11px] font-extrabold leading-[14px] tabular-nums text-red-600 md:table-cell">
                                {debit || "-"}
                              </td>
                              <td className="hidden px-3 py-2 align-top text-right text-[11px] font-extrabold leading-[14px] tabular-nums text-emerald-700 md:table-cell">
                                {credit || "-"}
                              </td>
                              <td className={`px-2 py-2 align-top text-right text-[10px] font-extrabold leading-[14px] tabular-nums md:hidden ${debit ? "text-red-600" : "text-emerald-700"}`}>
                                {debit || credit || "-"}
                                <span className="ml-0.5 text-[7px] font-bold uppercase text-slate-400">{debit ? "Dr" : credit ? "Cr" : ""}</span>
                              </td>
                              <td
                                className={`hidden px-3 py-2 align-top md:table-cell ${
                                  !showLedgerSelect && !statementReviewLocked
                                    ? "cursor-pointer outline-none transition hover:bg-[#fbf7f1] focus-visible:bg-[#fbf7f1] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-300"
                                    : ""
                                } ${
                                  highlightedReviewAction === "ledger"
                                    ? "relative group-data-[active=true]:ring-2 group-data-[active=true]:ring-inset group-data-[active=true]:ring-[#ad7617]"
                                    : ""
                                }`}
                                onClick={() => {
                                  if (showLedgerSelect || statementReviewLocked) return;
                                  setReviewActionStage("ledger");
                                  setEditingLedgerIds(new Set([transaction.id]));
                                }}
                                onKeyDown={(event) => {
                                  if (showLedgerSelect || statementReviewLocked) return;
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setReviewActionStage("ledger");
                                    setEditingLedgerIds(new Set([transaction.id]));
                                  }
                                }}
                                role={!showLedgerSelect && !statementReviewLocked ? "button" : undefined}
                                tabIndex={!showLedgerSelect && !statementReviewLocked ? 0 : undefined}
                                title={!showLedgerSelect && !statementReviewLocked ? "Click to change Tally ledger" : undefined}
                              >
                                {showLedgerSelect ? (
                                  <LedgerReviewSelect
                                    ledgerMasters={ledgerMasters}
                                    onCancel={() => {
                                      setEditingLedgerIds((current) => {
                                        const next = new Set(current);
                                        next.delete(transaction.id);
                                        return next;
                                      });
                                    }}
                                    onChange={(selection) => {
                                      updateLedgerSelection(transaction.id, selection);
                                      setReviewActionStage("posting");
                                      setEditingLedgerIds((current) => {
                                        const next = new Set(current);
                                        next.delete(transaction.id);
                                        return next;
                                      });
                                    }}
                                    transaction={transaction}
                                  />
                                ) : (
                                  <div className="block max-w-full text-left">
                                    <span className="block truncate text-[11px] font-extrabold leading-[14px] text-[#1a1a1a]" title={ledgerDisplayName}>
                                      {ledgerDisplayName}
                                    </span>
                                    <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[8px] font-bold leading-[11px] text-slate-500">
                                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ledgerMatchStatus === "Ledger matched" ? "bg-emerald-500" : "bg-amber-500"}`} />
                                      <span className="truncate">{ledgerGroupLabel} · {ledgerMatchStatus}</span>
                                    </span>
                                  </div>
                                )}
                              </td>
                              <td
                                className={`px-2 py-2 align-top sm:px-3 ${
                                  highlightedReviewAction !== "ledger"
                                    ? "relative group-data-[active=true]:ring-2 group-data-[active=true]:ring-inset group-data-[active=true]:ring-[#ad7617]"
                                    : ""
                                }`}
                              >
                                {tallyPresence?.status === "found" ? (
                                  <button
                                    className="flex w-full min-w-0 flex-col items-start gap-1 rounded-lg border border-transparent px-1.5 py-0 text-left transition hover:border-[#e5ddd0] hover:bg-[#faf8f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
                                    onClick={() => {
                                      setReviewActionStage("posting");
                                      setOutgoingReviewTransactionId(transaction.id);
                                    }}
                                    title="View matching Tally voucher details"
                                    type="button"
                                  >
                                    <span className={`inline-flex min-h-5 max-w-full self-start items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border px-2 py-0.5 text-[8px] font-bold uppercase leading-none tracking-wide ${
                                      tallyPresence.duplicateInTally
                                        ? "border-amber-250 bg-amber-50 text-amber-800"
                                        : "border-emerald-250 bg-emerald-50 text-emerald-800"
                                    }`}>
                                      {tallyPresence.duplicateInTally
                                        ? "Already posted - duplicates"
                                        : postedThisSession
                                          ? "Posted"
                                          : "Already in Tally"}
                                    </span>
                                    <span className="block w-full whitespace-normal break-words text-[9px] font-semibold leading-[13px] text-slate-500" title={tallyPresence.reason}>
                                      {tallyPresence.duplicateInTally
                                        ? `Tally vouchers ${tallyPresence.matches?.map((match) => match.voucherNumber).filter(Boolean).join(", ") || "need review"}`
                                        : tallyPresence.voucherNumber
                                          ? `Voucher ${tallyPresence.voucherNumber}`
                                          : postedThisSession
                                            ? "Verified in live Tally"
                                            : "Unique live match"}
                                    </span>
                                  </button>
                                ) : outgoingPayment && !outgoingNeedsBillAllocation ? (
                                  <button
                                    className={`flex w-full min-w-0 flex-col items-start gap-1 rounded-lg border border-transparent px-1.5 py-0 text-left transition ${
                                      statementReviewDrawerLocked ? "cursor-default" : "hover:border-[#e5ddd0] hover:bg-[#faf8f4]"
                                    }`}
                                    onClick={() => {
                                      if (!statementReviewDrawerLocked) {
                                        setReviewActionStage("posting");
                                        setOutgoingReviewTransactionId(transaction.id);
                                      }
                                    }}
                                    title="Review outgoing payment check"
                                    type="button"
                                  >
                                    <span
                                      className={`inline-flex min-h-5 max-w-full self-start items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border px-2 py-0.5 text-[8px] font-bold uppercase leading-none tracking-wide ${getOutgoingVerificationClass(outgoingVerification)}`}
                                    >
                                      {getOutgoingVerificationLabel(outgoingVerification)}
                                    </span>
                                    <span
                                      className="block w-full whitespace-normal break-words text-[9px] font-semibold leading-[13px] text-slate-500"
                                      title={outgoingVerification?.reason}
                                    >
                                      {getOutgoingVerificationSubtext(outgoingVerification)}
                                    </span>
                                  </button>
                                ) : (
                                  <button
                                    className={`flex w-full min-w-0 flex-col items-start gap-1 rounded-lg border border-transparent px-1.5 py-0 text-left transition ${
                                      statementReviewDrawerLocked ? "cursor-default" : "hover:border-[#e5ddd0] hover:bg-[#faf8f4]"
                                    }`}
                                    onClick={() => {
                                      if (!statementReviewDrawerLocked) {
                                        setReviewActionStage("posting");
                                        setBillAllocationReviewTransactionId(transaction.id);
                                      }
                                    }}
                                    title="Review bill allocation"
                                    type="button"
                                  >
                                    <span
                                      className={`inline-flex min-h-5 max-w-full self-start items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border px-2 py-0.5 text-[8px] font-bold uppercase leading-none tracking-wide ${getBillAllocationBadgeClass(transaction, ledgerMasters, billAllocation)}`}
                                    >
                                      {getBillAllocationBadgeText(transaction, ledgerMasters, billAllocation)}
                                    </span>
                                    {getBillAllocationSubtext(billAllocation, transaction, ledgerMasters) ? (
                                      <span className="block w-full whitespace-normal break-words text-[9px] font-semibold leading-[13px] text-slate-500" title={billAllocation?.reason || "Bill matching is not required for this ledger."}>
                                        {getBillAllocationSubtext(billAllocation, transaction, ledgerMasters)}
                                      </span>
                                    ) : null}
                                  </button>
                                )}
                              </td>
                              <td className="sticky right-0 border-l border-[#e5ddd0] bg-white px-1 py-2 text-center align-top group-hover:bg-[#fff9e8] group-data-[active=true]:bg-[#fff4d6]">
                                <button
                                  data-ledger-editor-toggle
                                  className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition ${
                                    isEditingLedger
                                      ? "bg-[#2d2d2d] text-white hover:bg-[#1a1a1a]"
                                      : "text-[#6f6256] hover:bg-[#efe7dc] hover:text-[#1a1a1a]"
                                  }`}
                                  onClick={() => {
                                    setReviewActionStage("ledger");
                                    setEditingLedgerIds((current) => {
                                      const next = new Set(current);
                                      if (next.has(transaction.id)) next.delete(transaction.id);
                                      else return new Set([transaction.id]);
                                      return next;
                                    });
                                  }}
                                  disabled={statementReviewLocked}
                                  title={isEditingLedger ? "Close ledger selection" : "Change ledger"}
                                  type="button"
                                >
                                  {isEditingLedger ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="flex min-h-11 flex-col gap-2 border-t border-[#e5ddd0] px-2 py-2 text-xs font-semibold text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 font-medium">Rows per page</span>
                    <select
                      className="h-7 rounded-lg border border-[#e5ddd0] bg-white px-2 text-xs font-bold text-[#5a5046] outline-none"
                      onChange={(event) => {
                        setRowsPerPage(Number(event.target.value));
                        setReviewPage(1);
                      }}
                      value={rowsPerPage}
                    >
                      {[25, 50, 100, 200].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex max-w-full flex-wrap items-center justify-end gap-2 sm:gap-3">
                    <span className="text-slate-400">
                      Showing {reviewRangeStart}-{reviewRangeEnd} of {filteredTransactions.length}
                      {ignoredStatementRowCount > 0
                        ? ` (${ignoredStatementRowCount} summary row${ignoredStatementRowCount === 1 ? "" : "s"} ignored)`
                        : ""}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        className="h-7 rounded-lg border border-[#e5ddd0] bg-white px-2.5 text-xs font-bold text-[#5a5046] transition hover:bg-[#faf8f4] disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={reviewPage <= 1}
                        onClick={() => setReviewPage((current) => Math.max(1, current - 1))}
                        type="button"
                      >
                        Previous
                      </button>
                      <span className="text-xs font-bold text-[#1a1a1a] px-1">
                        Page {reviewPage} of {reviewPageCount}
                      </span>
                      <button
                        className="h-7 rounded-lg border border-[#e5ddd0] bg-white px-2.5 text-xs font-bold text-[#5a5046] transition hover:bg-[#faf8f4] disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={reviewPage >= reviewPageCount}
                        onClick={() => setReviewPage((current) => Math.min(reviewPageCount, current + 1))}
                        type="button"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {billAllocationReviewTransaction ? (
                <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
                  <button
                    aria-label="Close bill allocation review"
                    className="absolute inset-0 z-0 cursor-default"
                    onClick={() => closeBillAllocationReview(true)}
                    type="button"
                  />
                  <aside className="relative z-10 flex h-full w-full max-w-[720px] flex-col border-l border-[#aebfca] bg-white shadow-2xl">
                    <header className="border-b border-[#b8cad5]">
                      <div className="flex min-h-8 items-center justify-between gap-2 bg-[#d8eaf4] px-4 py-1 text-[#27485d]">
                        <span className="text-[9px] font-extrabold uppercase tracking-[0.12em]">Bill Allocation</span>
                        <div className="flex items-center gap-1">
                          <button
                            className="h-6 px-2 text-[8px] font-extrabold uppercase tracking-wide transition hover:bg-white/60 disabled:opacity-35"
                            disabled={billAllocationReviewIndex <= 0}
                            onClick={() => openAdjacentBillAllocation(-1)}
                            type="button"
                          >
                            Previous
                          </button>
                          <button
                            className="h-6 px-2 text-[8px] font-extrabold uppercase tracking-wide transition hover:bg-white/60 disabled:opacity-35"
                            disabled={
                              billAllocationReviewIndex < 0 ||
                              billAllocationReviewIndex >= partyBillAllocationReviewTransactions.length - 1
                            }
                            onClick={() => openAdjacentBillAllocation(1)}
                            type="button"
                          >
                            Next
                          </button>
                          <button
                            aria-label="Close"
                            className="inline-flex h-6 w-6 items-center justify-center transition hover:bg-white/60"
                            onClick={() => closeBillAllocationReview()}
                            title="Close"
                            type="button"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="bg-white px-4 py-2.5">
                        <h2 className="text-[15px] font-extrabold leading-5 text-[#171717]">
                          {getTransactionPartyTitle(billAllocationReviewTransaction)}
                        </h2>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] font-bold leading-4 text-[#61788a]">
                          <span>
                            {formatShortDate(billAllocationReviewTransaction.transactionDate)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {formatCurrencyAmount(
                              Math.max(
                                parseNumber(billAllocationReviewTransaction.creditAmount) ?? 0,
                                parseNumber(billAllocationReviewTransaction.debitAmount) ?? 0
                              )
                            )}
                          </span>
                          {getTransactionReference(billAllocationReviewTransaction) ? (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono">{getTransactionReference(billAllocationReviewTransaction)}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </header>

                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                      <div className="hidden grid gap-3 sm:grid-cols-2">
                        {[
                          [
                            getEffectiveTransactionDateLabel(billAllocationReviewTransaction),
                            formatShortDate(getEffectiveTransactionDate(billAllocationReviewTransaction)),
                          ],
                          ["Type", getTransactionDirection(billAllocationReviewTransaction) || "-"],
                          [
                            "Amount",
                            formatCurrencyAmount(
                              Math.max(
                                parseNumber(billAllocationReviewTransaction.creditAmount) ?? 0,
                                parseNumber(billAllocationReviewTransaction.debitAmount) ?? 0
                              )
                            ),
                          ],
                          ["UTR / Ref", getTransactionReference(billAllocationReviewTransaction) || "-"],
                          ["Matched Ledger", billAllocationReviewTransaction.selectedLedgerName || "-"],
                          ["Ledger Group", getLedgerGroupLabel(billAllocationReviewTransaction, ledgerMasters)],
                        ].map(([label, value]) => (
                          <div key={label} className="border-b border-[#e5ddd0] pb-2">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              {label}
                            </div>
                              <div className="mt-1 text-xs font-extrabold text-[#1a1a1a]">{value}</div>
                          </div>
                        ))}
                      </div>

                      {!billAllocationReviewDraft ? (
                        <div className="border-y border-[#cfdbe2] bg-[#f4f8fb] px-3 py-2.5 text-[10px] font-bold leading-4 text-[#3f5d70]">
                          {tallyCheckAttempted
                            ? "Bill allocation data is unavailable for this row. Recheck Tally or review the selected ledger."
                            : "Run Check Tally Matches to load this ledger’s open bills before allocating the entry."}
                        </div>
                      ) : (
                        <>
                          <div className="border-y border-[#b8cad5] bg-[#f4f8fb] px-3 py-2.5 text-[#172f3e]">
                            <div className="flex flex-wrap items-end justify-between gap-3">
                              <div>
                                <div className="text-[8px] font-extrabold uppercase tracking-[0.14em] text-[#7890a1]">
                                  {billAllocationReviewIsPayment ? "Payment" : "Receipt"}
                                </div>
                                <div className="mt-0.5 text-[16px] font-extrabold tracking-tight">
                                  {formatCurrencyAmount(billAllocationReviewDraft.receiptAmount)}
                                </div>
                              </div>
                              <div className="flex items-center gap-5 text-right">
                                <div>
                                  <div className="text-[8px] font-extrabold uppercase tracking-wider text-[#7890a1]">Bills</div>
                                <div className="mt-0.5 text-[10px] font-extrabold">
                                    {formatCurrencyAmount(billAllocationReviewDraft.totalAllocatedAmount - billAllocationReviewDraft.newAdvanceAmount)}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-[8px] font-extrabold uppercase tracking-wider text-[#7890a1]">Advance</div>
                                <div className="mt-0.5 text-[10px] font-extrabold">{formatCurrencyAmount(billAllocationReviewDraft.newAdvanceAmount)}</div>
                                </div>
                                <span className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ${
                                  Math.abs(billAllocationReviewDraft.unallocatedAmount) < 0.01
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-amber-100 text-amber-800"
                                }`}>
                                  {Math.abs(billAllocationReviewDraft.unallocatedAmount) < 0.01
                                    ? "Balanced"
                                    : billAllocationReviewDraft.unallocatedAmount > 0
                                      ? `${formatCurrencyAmount(billAllocationReviewDraft.unallocatedAmount)} left`
                                      : `${formatCurrencyAmount(Math.abs(billAllocationReviewDraft.unallocatedAmount))} over`}
                                </span>
                              </div>
                            </div>
                            <div className="mt-2.5 h-1 overflow-hidden bg-[#d6e2e9]">
                              <div
                                className={`h-full transition-[width] duration-300 ${
                                  billAllocationReviewDraft.unallocatedAmount < -0.005 ? "bg-amber-300" : "bg-emerald-400"
                                }`}
                                style={{
                                  width: `${Math.min(100, Math.max(0, billAllocationReviewDraft.receiptAmount > 0
                                    ? (billAllocationReviewDraft.totalAllocatedAmount / billAllocationReviewDraft.receiptAmount) * 100
                                    : 0))}%`,
                                }}
                              />
                            </div>
                          </div>

                          {billAllocationReviewDraft.requiresUserReview ? (
                            <div className="mt-2 flex items-center gap-2 border-y border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-bold text-amber-900">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                              <span>
                                {billAllocationReviewDraft.existingAdvances.length > 0
                                  ? `Existing advance: ${formatCurrencyAmount(
                                      billAllocationReviewDraft.existingAdvances.reduce(
                                        (sum, advance) => sum + advance.pendingAdvanceAmount,
                                        0
                                      )
                                    )}. Review before allocating.`
                                  : billAllocationReviewDraft.reason}
                              </span>
                            </div>
                          ) : null}

                          <section className="hidden mt-6">
                          <h3 className="text-xs font-bold text-[#1a1a1a]">Proposed Allocation</h3>
                            <div className="mt-2 overflow-x-auto rounded-md border border-[#e5ddd0] bg-white">
                              <table className="w-full min-w-[640px] text-left text-xs">
                                <thead className="bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                  <tr>
                                    <th className="px-3 py-2">Ref Type</th>
                                    <th className="px-3 py-2">Bill Reference</th>
                                    <th className="px-3 py-2">Invoice Date</th>
                                    <th className="px-3 py-2 text-right">Previous Pending</th>
                                    <th className="px-3 py-2 text-right">Allocated Now</th>
                                    <th className="px-3 py-2 text-right">Pending After</th>
                                    <th className="px-3 py-2">Result</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-[#e5ddd0]">
                                  {billAllocationReviewDraft.allocations.length === 0 ? (
                                    <tr>
                                      <td className="px-3 py-4 text-center font-semibold text-slate-400" colSpan={7}>
                                        No allocation selected.
                                      </td>
                                    </tr>
                                  ) : (
                                    billAllocationReviewDraft.allocations.map((allocation) => (
                                      <tr key={`${allocation.referenceType}-${allocation.referenceName}`}>
                                        <td className="px-3 py-2 font-bold">{allocation.referenceType}</td>
                                        <td className="px-3 py-2 font-semibold">{allocation.referenceName}</td>
                                        <td className="px-3 py-2">{allocation.invoiceDate ? formatShortDate(allocation.invoiceDate) : "-"}</td>
                                        <td className="px-3 py-2 text-right">
                                          {formatCurrencyAmount(allocation.previousPendingAmount)}
                                        </td>
                                        <td className="px-3 py-2 text-right font-bold">
                                          {formatCurrencyAmount(allocation.allocatedAmount)}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                          {formatCurrencyAmount(allocation.pendingAmountAfterAllocation)}
                                        </td>
                                        <td className="px-3 py-2">{formatDataLabel(allocation.statusAfterAllocation)}</td>
                                      </tr>
                                    ))
                                  )}
                                </tbody>
                              </table>
                            </div>
                          </section>

                          <section className="mt-3">
                            {billAllocationReviewDraft.candidateBills.length === 0 ? (
                            <div className="flex flex-wrap items-center justify-between gap-3 border-y border-[#cfdbe2] bg-[#f8fbfc] px-3 py-2.5">
                                <div>
                                  <h3 className="text-xs font-extrabold text-[#1a1a1a]">New advance</h3>
                                  <p className="mt-0.5 text-[9px] font-semibold text-slate-400">No open bills in Tally</p>
                                </div>
                                <CurrencyAmountInput
                                  min={0}
                                  onChange={(value) =>
                                    updateManualAdvanceAmount(billAllocationReviewTransaction, value)
                                  }
                                  value={billAllocationReviewDraft.newAdvanceAmount}
                                />
                              </div>
                            ) : (
                              <>
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e8e1d7] pb-2">
                              <h3 className="text-xs font-extrabold text-[#1a1a1a]">Open bills</h3>
                              <div className="flex flex-wrap gap-1 rounded-lg bg-[#f3efe9] p-1">
                              <Button
                                className="h-6 rounded-md border-0 bg-transparent px-2 text-[10px] font-bold shadow-none hover:bg-white"
                                onClick={() => redistributeAllocationFifo(billAllocationReviewTransaction)}
                                type="button"
                                variant="outline"
                              >
                                Auto allocate (FIFO)
                              </Button>
                              {billAllocationReviewDraft.totalAllocatedAmount > 0.005 ? (
                                <Button
                                  className="h-6 rounded-md border-0 bg-transparent px-2 text-[10px] font-bold text-red-700 shadow-none hover:bg-white"
                                  onClick={() => clearManualAllocations(billAllocationReviewTransaction)}
                                  type="button"
                                  variant="outline"
                                >
                                  Clear
                                </Button>
                              ) : null}
                              {billAllocationReviewDraft.unallocatedAmount > 0.005 ? (
                                <Button
                                  className="h-6 rounded-md border-0 bg-emerald-100 px-2 text-[10px] font-bold text-emerald-800 shadow-none hover:bg-emerald-200"
                                  onClick={() => recordRemainingAsAdvance(billAllocationReviewTransaction)}
                                  type="button"
                                  variant="outline"
                                >
                                  Remainder as advance
                                </Button>
                              ) : null}
                              <Button
                                className="h-6 rounded-md border-0 bg-transparent px-2 text-[10px] font-bold shadow-none hover:bg-white"
                                onClick={() => {
                                  if (billAllocationReviewDraft.candidateBills.length > 0) {
                                    setConfirmFullAdvance(true);
                                  } else {
                                    recordEntireReceiptAsAdvance(billAllocationReviewTransaction);
                                  }
                                }}
                                type="button"
                                variant="outline"
                              >
                                All as advance
                              </Button>
                              </div>
                            </div>
                            {confirmFullAdvance ? (
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-y border-amber-200 bg-amber-50 px-3 py-2.5 text-[10px] font-semibold text-amber-900">
                                <span>Open bills exist. This will intentionally leave them unpaid and record the complete {billAllocationReviewIsPayment ? "payment" : "receipt"} as a new advance.</span>
                                <div className="flex gap-2">
                                  <Button className="h-8 px-3 text-[11px] font-bold" onClick={() => setConfirmFullAdvance(false)} type="button" variant="outline">
                                    Cancel
                                  </Button>
                                  <Button className="h-8 bg-amber-900 px-3 text-[11px] font-bold text-white hover:bg-amber-950" onClick={() => recordEntireReceiptAsAdvance(billAllocationReviewTransaction)} type="button">
                                    Confirm advance
                                  </Button>
                                </div>
                              </div>
                            ) : null}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <label className="relative min-w-[260px] flex-1">
                                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                                <input
                                  className="h-8 w-full rounded-md border border-[#cfdbe2] bg-white pl-9 pr-3 text-[10px] font-semibold outline-none transition focus:border-[#587286] focus:ring-2 focus:ring-[#d8eaf4]"
                                  onChange={(event) => setBillAllocationSearch(event.target.value)}
                                  placeholder="Search bill reference, voucher, date, or amount"
                                  type="search"
                                  value={billAllocationSearch}
                                />
                                  <span className="sr-only">Search open Tally bills</span>
                                </label>
                                {billAllocationSearch.trim() ? (
                                  <span className="whitespace-nowrap rounded-full bg-[#f5f1eb] px-2.5 py-1 text-[10px] font-extrabold text-[#5a5046]">
                                    {filteredBillAllocationCandidates.length} shown
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <div className="mt-2 overflow-x-auto border-y border-[#cfdbe2] bg-white">
                              <table className="w-full min-w-[560px] text-left text-xs">
                                <thead className="bg-[#fcfbfa] text-[9px] font-extrabold uppercase tracking-[0.12em] text-slate-400">
                                  <tr>
                                    <th className="px-3 py-2">Bill Reference</th>
                                    <th className="px-3 py-2 text-right">Pending</th>
                                    <th className="px-3 py-2 text-right">Allocate</th>
                                    <th className="w-[150px] px-3 py-2 text-right"></th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-[#eee7dc] text-slate-600 font-semibold">
                                  {billAllocationReviewDraft.candidateBills.length === 0 ? (
                                    <tr>
                                      <td className="px-4 py-4 text-center font-semibold text-slate-400" colSpan={4}>
                                        No open bills returned by Tally.
                                      </td>
                                    </tr>
                                  ) : filteredBillAllocationCandidates.length === 0 ? (
                                    <tr>
                                      <td className="px-4 py-4 text-center font-semibold text-slate-400" colSpan={4}>
                                        No bills match this search.
                                      </td>
                                    </tr>
                                  ) : (
                                    filteredBillAllocationCandidates.map((bill) => {
                                      const currentAmount =
                                        billAllocationReviewDraft.allocations.find(
                                          (line) => line.referenceType === "Agst Ref" && line.referenceName === bill.referenceName
                                        )?.allocatedAmount ?? 0;
                                      const canUseRemaining =
                                        billAllocationReviewDraft.unallocatedAmount > 0.005 &&
                                        bill.pendingAmount - currentAmount > 0.005;

                                      return (
                                        <tr className={currentAmount > 0 ? "bg-emerald-50/45" : "transition-colors hover:bg-[#fcfaf7]"} key={bill.referenceName}>
                                          <td className="px-3 py-2.5">
                                            <div className="font-extrabold text-[#1a1a1a]">{bill.referenceName}</div>
                                            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] font-semibold text-slate-400">
                                              <span>Invoice {bill.invoiceDate ? formatShortDate(bill.invoiceDate) : "date unavailable"}</span>
                                              {bill.dueDate ? <span>Due {formatShortDate(bill.dueDate)}</span> : null}
                                            </div>
                                          </td>
                                          <td className="px-3 py-2.5 text-right font-extrabold text-slate-600">{formatCurrencyAmount(bill.pendingAmount)}</td>
                                          <td className="px-3 py-2.5 text-right">
                                            <CurrencyAmountInput
                                              max={bill.pendingAmount}
                                              min={0}
                                              onChange={(value) =>
                                                updateManualBillAmount(
                                                  billAllocationReviewTransaction,
                                                  bill.referenceName,
                                                  value
                                                )
                                              }
                                              value={currentAmount}
                                            />
                                          </td>
                                          <td className="px-3 py-2.5 text-right">
                                            <div className="flex items-center justify-end gap-1.5">
                                              {canUseRemaining ? (
                                                <button
                                                  className="h-7 whitespace-nowrap rounded-md border border-[#9fb8c7] bg-[#eaf3f8] px-2 text-[9px] font-extrabold text-[#27485d] transition hover:bg-[#d8eaf4]"
                                                  onClick={() =>
                                                    allocateRemainingToBill(
                                                      billAllocationReviewTransaction,
                                                      bill.referenceName
                                                    )
                                                  }
                                                  type="button"
                                                >
                                                  Use remaining
                                                </button>
                                              ) : null}
                                              {currentAmount > 0 ? (
                                                <button
                                                  className="h-7 px-1.5 text-[9px] font-extrabold text-red-700 transition hover:bg-red-50"
                                                  onClick={() =>
                                                    updateManualBillAmount(
                                                      billAllocationReviewTransaction,
                                                      bill.referenceName,
                                                      "0"
                                                    )
                                                  }
                                                  type="button"
                                                >
                                                  Remove
                                                </button>
                                              ) : null}
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })
                                  )}
                                  <tr className="bg-[#fbf8f3]">
                                    <td className="px-3 py-2.5 font-bold text-[#1a1a1a]">New advance</td>
                                    <td className="px-3 py-2.5" aria-label="Not allocated to an open bill"></td>
                                    <td className="px-3 py-2.5 text-right">
                                      <CurrencyAmountInput
                                        min={0}
                                        onChange={(value) =>
                                          updateManualAdvanceAmount(billAllocationReviewTransaction, value)
                                        }
                                        value={billAllocationReviewDraft.newAdvanceAmount}
                                      />
                                    </td>
                                    <td className="px-3 py-2.5"></td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                              </>
                            )}
                          </section>

                          {billAllocationReviewDraft.existingAdvances.length > 0 ? (
                            <section className="mt-4">
                              <div className="flex items-center gap-2">
                              <h3 className="text-xs font-bold text-[#1a1a1a]">Existing advances</h3>
                                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wide text-slate-500">
                                  Reference only
                                </span>
                              </div>
                              {billAllocationReviewDraft.existingAdvances.length === 1 ? (
                                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-y border-[#cfdbe2] bg-white px-3 py-2.5 text-[10px] font-semibold text-slate-600">
                                  <div className="min-w-0">
                                    <div className="truncate font-bold text-[#1a1a1a]">
                                      {billAllocationReviewDraft.existingAdvances[0].referenceName}
                                    </div>
                                    <div className="mt-0.5 text-[9px] text-slate-400">
                                      {billAllocationReviewDraft.existingAdvances[0].receiptDate
                                        ? formatShortDate(billAllocationReviewDraft.existingAdvances[0].receiptDate)
                                        : "Date unavailable"}
                                    </div>
                                  </div>
                                  <div className="font-extrabold text-slate-600">
                                    {formatCurrencyAmount(billAllocationReviewDraft.existingAdvances[0].pendingAdvanceAmount)}
                                  </div>
                                </div>
                              ) : (
                                <div className="mt-2 overflow-x-auto border-y border-[#cfdbe2] bg-white">
                                  <table className="w-full min-w-[420px] text-left text-xs">
                                    <thead className="bg-[#fcfbfa] text-[9px] font-bold uppercase tracking-wider text-slate-400">
                                      <tr>
                                        <th className="px-3 py-2">Advance ref</th>
                                        <th className="px-3 py-2">Date</th>
                                        <th className="px-3 py-2 text-right">Pending</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#e5ddd0] text-[11px] font-semibold text-slate-600">
                                      {billAllocationReviewDraft.existingAdvances.map((advance) => (
                                        <tr key={advance.referenceName}>
                                          <td className="px-3 py-2.5 font-bold text-[#1a1a1a]">{advance.referenceName}</td>
                                          <td className="px-3 py-2.5">
                                            {advance.receiptDate ? formatShortDate(advance.receiptDate) : "-"}
                                          </td>
                                          <td className="px-3 py-2.5 text-right">
                                            {formatCurrencyAmount(advance.pendingAdvanceAmount)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </section>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 border-t border-[#b8cad5] bg-[#eaf3f8] px-4 py-2">
                        <span className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-[#61788a]">
                          Allocate transaction
                        </span>
                        <div className="flex items-center gap-1.5">
                        {billAllocationReviewDraft?.requiresUserReview ? (
                          <Button
                            className="h-8 rounded-md border-[#b8cad5] bg-white px-3 text-[10px] font-bold"
                            onClick={() => closeBillAllocationReview(true)}
                            type="button"
                            variant="outline"
                          >
                            Close
                          </Button>
                        ) : null}
                        <Button
                          autoFocus={Boolean(billAllocationReviewDraft && !billAllocationReviewDraft.requiresUserReview)}
                          className="h-8 rounded-md bg-[#263b47] px-3 text-[10px] font-bold text-white shadow-none transition hover:bg-[#172a35]"
                          disabled={!billAllocationReviewDraft || billAllocationReviewDraft.requiresUserReview}
                          onClick={() => completePostingReview(billAllocationReviewTransaction.id)}
                          type="button"
                        >
                          {(filteredTransactionIndexById.get(billAllocationReviewTransaction.id) ?? -1) < filteredTransactions.length - 1
                            ? "Done & next"
                            : "Done"}
                        </Button>
                        </div>
                    </div>
                  </aside>
                </div>
              ) : null}

              {outgoingReviewTransaction ? (
                <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
                  <button
                    aria-label="Close Tally match details"
                    className="absolute inset-0 z-0 cursor-default"
                    onClick={() => setOutgoingReviewTransactionId(null)}
                    type="button"
                  />
                  <aside className="relative z-10 flex h-full w-full max-w-[680px] flex-col border-l border-[#aebfca] bg-white shadow-2xl">
                    <header className="border-b border-[#b8cad5]">
                      <div className="flex h-8 items-center justify-between bg-[#d8eaf4] px-4 text-[9px] font-extrabold uppercase tracking-[0.12em] text-[#27485d]">
                        <span>
                          {tallyResultReviewDraft?.status === "found" || tallyResultReviewDraft?.status === "ambiguous"
                            ? "Tally Match Details"
                            : tallyResultReviewIsIncoming
                              ? "Receipt Check"
                              : "Payment Check"}
                        </span>
                        <button
                          aria-label="Close"
                          className="inline-flex h-6 w-6 items-center justify-center text-[#587286] transition hover:bg-white/60 hover:text-[#172f3e]"
                          onClick={() => setOutgoingReviewTransactionId(null)}
                          title="Close"
                          type="button"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="bg-white px-4 py-2.5">
                        <h2 className="text-[15px] font-extrabold leading-5 text-[#171717]">
                          {getTransactionPartyTitle(outgoingReviewTransaction)}
                        </h2>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] font-bold leading-4 text-[#61788a]">
                          <span>{formatShortDate(outgoingReviewTransaction.transactionDate)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatCurrencyAmount(tallyResultReviewAmount)}</span>
                          {getTransactionReference(outgoingReviewTransaction) ? (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono">{getTransactionReference(outgoingReviewTransaction)}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </header>

                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <div className="grid border-b border-[#cfdbe2] bg-[#fffefb] sm:grid-cols-2">
                        {[
                          [
                            getEffectiveTransactionDateLabel(outgoingReviewTransaction),
                            formatShortDate(getEffectiveTransactionDate(outgoingReviewTransaction)),
                          ],
                          ["Amount", formatCurrencyAmount(tallyResultReviewAmount)],
                          ["UTR / Ref", getTransactionReference(outgoingReviewTransaction) || "-"],
                          ["Matched Ledger", outgoingReviewTransaction.selectedLedgerName || "-"],
                          ["Ledger Group", getLedgerGroupLabel(outgoingReviewTransaction, ledgerMasters)],
                          ["Bank Ledger", bankLedgerName || "-"],
                          ["Will Post As", tallyResultReviewPostingVoucherType],
                        ].map(([label, value]) => (
                          <div key={label} className="min-w-0 border-b border-[#e0e7eb] px-4 py-2 sm:border-r sm:even:border-r-0">
                            <div className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-[#7890a1]">
                              {label}
                            </div>
                            <div className="mt-0.5 break-words text-[11px] font-extrabold leading-[14px] text-[#1a1a1a]">{value}</div>
                          </div>
                        ))}
                      </div>

                      <section className="border-b border-[#cfdbe2] bg-[#f4f8fb] px-4 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dbe5eb] pb-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[8px] font-extrabold uppercase tracking-wider ${
                              tallyResultReviewIsDirectReceipt
                                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                : getOutgoingVerificationClass(tallyResultReviewDraft)
                            }`}>
                              {tallyResultReviewIsDirectReceipt
                                ? "Direct receipt"
                                : getOutgoingVerificationLabel(tallyResultReviewDraft)}
                            </span>
                            {tallyResultReviewDraft?.status === "found" && !tallyResultReviewDraft.duplicateInTally ? (
                              <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[8px] font-extrabold uppercase tracking-wider text-emerald-800">
                                No action required
                              </span>
                            ) : null}
                            {tallyResultReviewDraft?.status === "missing" || tallyResultReviewIsDirectReceipt ? (
                              <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[8px] font-extrabold uppercase tracking-wider text-blue-800">
                                Ready to post as {tallyResultReviewPostingVoucherType}
                              </span>
                            ) : null}
                          </div>
                          <span className="text-[9px] font-bold text-slate-400">
                            Ledger: {outgoingReviewTransaction.selectedLedgerName || "-"}
                          </span>
                        </div>
                        <p className="mt-2 text-[11px] font-semibold leading-4 text-slate-600">
                          {tallyResultReviewReason}
                        </p>
                      </section>

                      <section className={tallyResultReviewEvidence.length ? "px-4 py-3" : "hidden"}>
                        <div className="flex flex-wrap items-end justify-between gap-2">
                          <div>
                            <div className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-slate-400">
                              Tally evidence
                            </div>
                            <h3 className="mt-0.5 text-[11px] font-extrabold text-[#1a1a1a]">
                              {tallyResultReviewDraft?.status === "found"
                                ? tallyResultReviewDraft.duplicateInTally
                                  ? "Matching Tally vouchers"
                                  : "Matched Tally voucher"
                                : "Possible Tally vouchers"}
                            </h3>
                          </div>
                          {tallyResultReviewDraft?.status === "found" ? (
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[8px] font-extrabold uppercase tracking-wider ${
                              tallyResultReviewDraft.duplicateInTally
                                ? "border-amber-200 bg-amber-50 text-amber-800"
                                : "border-emerald-200 bg-emerald-50 text-emerald-800"
                            }`}>
                              {tallyResultReviewDraft.duplicateInTally ? "Posted with duplicates" : "Verified match"}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 border-t border-[#cfdbe2]">
                          {tallyResultReviewEvidence.length ? (
                            tallyResultReviewEvidence.map((match, index) => (
                              <div
                                key={`${match.masterId || match.voucherNumber || index}`}
                                className="border-b border-[#cfdbe2] bg-white py-3"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <div className="text-[11px] font-extrabold text-[#1a1a1a]">
                                      {match.voucherNumber
                                        ? `Voucher ${match.voucherNumber}`
                                        : match.masterId
                                          ? `Voucher ${match.masterId}`
                                          : `Candidate ${index + 1}`}
                                    </div>
                                    <div className="mt-0.5 text-[9px] font-semibold text-slate-400">
                                      {[match.voucherType, match.date ? formatShortDate(match.date) : null, match.reference]
                                        .filter(Boolean)
                                        .join(" - ") || "Voucher details from Tally"}
                                    </div>
                                  </div>
                                  {typeof match.score === "number" ? (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-[#e5ddd0] bg-[#faf8f4] px-2 py-0.5 text-[8px] font-extrabold uppercase tracking-wider text-slate-600">
                                      Score: {match.score}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-3 grid gap-2 border-t border-slate-100 pt-2 sm:grid-cols-2">
                                  <div>
                                    <div className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-slate-400">
                                      Party / Ledger
                                    </div>
                                    <div className="mt-0.5 text-[10px] font-extrabold text-[#1a1a1a]">
                                      {match.partyLedgerName || match.ledgerNames[0] || "-"}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-slate-400">
                                      Why it matched
                                    </div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {match.reasons.length ? (
                                        match.reasons.map((reason) => (
                                          <span
                                            key={reason}
                                            className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[8px] font-bold text-amber-800"
                                          >
                                            {reason}
                                          </span>
                                        ))
                                      ) : (
                                        <span className="text-[9px] font-semibold text-slate-400">
                                          Unique voucher returned by the live Tally check
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="border-b border-[#cfdbe2] bg-white px-3 py-4 text-center text-[10px] font-semibold text-slate-400">
                              No candidate vouchers returned by Tally.
                            </div>
                          )}
                        </div>
                      </section>
                    </div>
                    <div className="flex items-center justify-between border-t border-[#b8cad5] bg-[#eaf3f8] px-4 py-2">
                      <span className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-[#61788a]">
                        Review transaction
                      </span>
                      <Button
                        autoFocus
                        className="h-8 rounded-md bg-[#263b47] px-3 text-[10px] font-bold text-white shadow-none transition hover:bg-[#172a35]"
                        onClick={() => completePostingReview(outgoingReviewTransaction.id)}
                        type="button"
                      >
                        {(filteredTransactionIndexById.get(outgoingReviewTransaction.id) ?? -1) < filteredTransactions.length - 1
                          ? "Done & next"
                          : "Done"}
                      </Button>
                    </div>
                  </aside>
                </div>
              ) : null}
            </section>
          )}
        </div>
      </div>

      {preview ? (
        <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] md:bottom-0 z-40 w-full border-t border-[#ddd3c5] bg-white/95 px-2 py-2.5 shadow-[0_-4px_20px_rgba(49,39,26,0.08)] backdrop-blur-xl">
          <div className="flex w-full max-w-none flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
              <div className="contents text-[11px] font-bold">
                <span className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] font-bold ${newReceiptCount > 0 && !statementCompletedCleanly ? "border-blue-200 bg-blue-50 text-blue-800" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                {matchingBills
                  ? "Checking statement against Tally..."
                  : statementCompletedCleanly
                    ? tallyPostingStatus?.voucherTotal
                      ? "Posted & verified"
                      : "Verified in Tally"
                  : uncheckedTallyPresenceCount > 0
                    ? `${readyPostingTransactions.length} ready · ${uncheckedTallyPresenceCount} need Tally check`
                  : readyPostingTransactions.length > 0
                    ? `${readyPostingTransactions.length} entr${readyPostingTransactions.length === 1 ? "y" : "ies"} ready to post · ${newReceiptCount} receipt${newReceiptCount === 1 ? "" : "s"} · ${missingOutgoingCount} payment${missingOutgoingCount === 1 ? "" : "s"}`
                  : heldPostingRowCount > 0
                    ? "No ready entries · Resolve rows needing review"
                  : alreadyInTallyCount > 0
                    ? "All entries already in Tally · Nothing to post"
                    : "Nothing to post"}
                </span>
                {!statementCompletedCleanly && heldPostingRowCount > 0 ? (
                  <span className="text-[11px] font-bold text-amber-800" role="status">
                    {heldPostingRowCount} held for review — not included in posting
                  </span>
                ) : null}
                {!statementCompletedCleanly && selectedPostingSuspenseCount > 0 ? (
                  <span className="inline-flex h-6 items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 text-[11px] font-bold text-amber-800">
                    {selectedPostingSuspenseCount} entr{selectedPostingSuspenseCount === 1 ? "y" : "ies"} will use Suspense
                  </span>
                ) : null}
              </div>
              {!statementCompletedCleanly && tallyPostingStatus ? (
                <div
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold"
                  role={tallyPostingStatus.finished ? "status" : "progressbar"}
                  aria-valuemin={0}
                  aria-valuemax={tallyPostingStatus.total}
                  aria-valuenow={tallyPostingStatus.completed + tallyPostingStatus.failed + tallyPostingStatus.canceled}
                >
                  {tallyPostingStatus.voucherTotal > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                      Voucher posting {tallyPostingStatus.voucherCompleted}/{tallyPostingStatus.voucherTotal}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-[#e5ddd0] bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                      No entries to create
                    </span>
                  )}
                  {tallyPostingStatus.paymentCheckTotal > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-800">
                      Payment checks {tallyPostingStatus.paymentCheckCompleted}/{tallyPostingStatus.paymentCheckTotal}
                    </span>
                  ) : null}
                  {(tallyPostingStatus.failed > 0 || tallyPostingStatus.canceled > 0) ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-red-250 bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-800">
                      {tallyPostingStatus.failed + tallyPostingStatus.canceled} failed
                    </span>
                  ) : null}
                  {!tallyPostingStatus.finished ? (
                    <span className="inline-flex items-center gap-1 text-slate-400 text-xs font-semibold">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {tallyPostingStatus.voucherWaiting > 0
                        ? "Creating bank vouchers"
                        : "Checking Tally transactions"}
                    </span>
                  ) : null}
                  {tallyPostingStatus.errors[0] ? (
                    <span className="min-w-0 max-w-[520px] truncate text-xs text-red-700">
                      {tallyPostingStatus.errors[0]}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              <Button
                className="h-8 flex-1 rounded-lg border-[#ddd3c5] bg-white px-3 text-[10px] font-bold text-[#5a5046] shadow-sm transition-all hover:bg-[#faf8f4] hover:text-[#1a1a1a] sm:flex-none"
                onClick={() => clearStatementReview()}
                disabled={sending || matchingBills || tallyPostingInProgress}
                type="button"
                variant="outline"
              >
                Upload Another
              </Button>
              {!statementDoneSummary ? (
                <>
                  <Button
                    className="h-8 flex-1 rounded-lg border-[#ddd3c5] bg-white px-3 text-[10px] font-bold text-[#5a5046] shadow-sm transition-all hover:bg-[#faf8f4] hover:text-[#1a1a1a] sm:flex-none"
                    onClick={matchPendingBills}
                    disabled={
                      sending ||
                      matchingBills ||
                      tallyPostingInProgress ||
                      preview.requiresManualExtraction ||
                      preview.extractionDiagnostics?.coverageComplete === false ||
                      validTransactions.length === 0
                    }
                    type="button"
                    variant="outline"
                  >
                    {matchingBills ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Check Tally Matches ({validTransactions.length})
                  </Button>
                  {transactionsNeedingTallyWork.length > 0 ? (
                    <div className="flex flex-1 items-center sm:flex-none">
                      <select
                        aria-label="Choose Tally posting scope"
                        className="h-8 max-w-[150px] rounded-l-lg border border-r-0 border-[#ddd3c5] bg-white px-2 text-[10px] font-bold text-[#5a5046] outline-none"
                        disabled={
                          sending ||
                          matchingBills ||
                          tallyPostingInProgress ||
                          preview.requiresManualExtraction ||
                          preview.extractionDiagnostics?.coverageComplete === false
                        }
                        onChange={(event) => setTallyPostingScope(event.target.value as TallyPostingScope)}
                        value={tallyPostingScope}
                      >
                        <option value="all">All ready entries ({readyPostingTransactions.length})</option>
                        <option disabled={newReceiptCount === 0} value="receipts">Receipts only ({newReceiptCount})</option>
                        <option disabled={missingOutgoingCount === 0} value="payments">Payments only ({missingOutgoingCount})</option>
                      </select>
                      <Button
                        className="h-8 flex-1 rounded-l-none rounded-r-lg bg-[#2d2d2d] px-3 text-[10px] font-bold text-white shadow-sm transition-all hover:bg-[#1a1a1a] sm:flex-none"
                        title={selectedPostingTransactions.length === 0
                          ? "No ready entries in this scope. Check Tally matches and resolve held rows."
                          : `Post ${selectedPostingTransactions.length} ready entries only; held rows will stay for review.`}
                        onClick={() => {
                          const mode = tallyPostingScope === "receipts"
                            ? "post_receipts"
                            : tallyPostingScope === "payments"
                              ? "post_payments"
                              : "post_all";
                          void sendToTally(
                            mode
                          );
                        }}
                        disabled={
                          sending ||
                          matchingBills ||
                          tallyPostingInProgress ||
                          preview.requiresManualExtraction ||
                          preview.extractionDiagnostics?.coverageComplete === false ||
                          selectedPostingTransactions.length === 0 ||
                          selectedPostingMissingLedgerCount > 0 ||
                          !bankLedgerName.trim()
                        }
                        type="button"
                      >
                        {sendingMode ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ArrowRight className="h-3.5 w-3.5" />
                        )}
                        {postTallyButtonLabel}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
    </AppShell>
  );
}
