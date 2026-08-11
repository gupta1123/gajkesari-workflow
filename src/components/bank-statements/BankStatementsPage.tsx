"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowLeftRight,
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
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";
import { allocateReceiptByFifo } from "@/lib/bank-statement-bill-allocation";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";

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
    const raw = window.localStorage.getItem(BANK_STATEMENT_COMPANY_SELECTION_KEY);
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
    window.localStorage.removeItem(BANK_STATEMENT_COMPANY_SELECTION_KEY);
    return;
  }

  window.localStorage.setItem(
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
  extractionError?: string | null;
  extractionDiagnostics?: {
    rawAiTransactionCount?: number;
    normalizedAiTransactionCount?: number;
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

type TallyMaster = {
  key: string;
  name: string;
  type: string;
  parent?: string | null;
  billWiseEnabled?: boolean | null;
  ledgerType?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  ifscCode?: string | null;
  accountHolderName?: string | null;
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
type TallySendMode = "post_receipts" | "check_payments";

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
    suspenseName;
  const ledgerAction: LedgerRecommendationAction = confirmedMappedLedger
    ? "use_existing_ledger"
    : standardLedger
    ? "use_standard_ledger"
    : matchedLedger
    ? action === "use_standard_ledger"
      ? "use_standard_ledger"
      : "use_existing_ledger"
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

function transactionIsValid(transaction: ReviewTransaction) {
  return Boolean(
    hasValidTransactionDate(transaction.transactionDate) &&
    transaction.description.trim() &&
    transactionHasPostingAmount(transaction)
  );
}

function formatAmount(value: string | number | null | undefined) {
  const parsed = parseNumber(value) ?? 0;
  if (!Number.isFinite(parsed) || parsed === 0) return "";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(parsed);
}

function formatCurrencyAmount(value: string | number | null | undefined) {
  const formatted = formatAmount(value);
  return formatted ? `Rs. ${formatted}` : "Rs. 0";
}

function formatCurrencyInputAmount(value: string | number | null | undefined) {
  const parsed = parseNumber(value) ?? 0;
  if (!Number.isFinite(parsed) || parsed === 0) return "";
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(parsed);
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
            },
          ]
        : []),
      ...candidateLedgers.map((ledger) => ({
        name: ledger.name,
        action: "use_existing_ledger" as const,
        label: ledger.name,
        helper: ledger.parent ? `Group: ${ledger.parent}` : "AI-suggested possible match.",
        badge: "Suggested",
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
    }))
  );

  addGroup(
    "Search Tally ledgers",
    ledgerMasters.map((ledger) => ({
      name: ledger.name,
      action: "use_existing_ledger",
      label: ledger.name,
      helper: ledger.parent ? `Group: ${ledger.parent}` : "Existing Tally ledger.",
    }))
  );

  return groups;
}

type LedgerSearchGroup = {
  label: string;
  options: Array<{
    name: string;
    helper?: string;
  }>;
};

function LedgerSearchSelect({
  value,
  groups,
  placeholder,
  onChange,
}: {
  value: string;
  groups: LedgerSearchGroup[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
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
  const filteredGroups = useMemo(() => {
    const normalizedQuery = normalizeName(query);
    if (!normalizedQuery) return uniqueGroups;
    return uniqueGroups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) =>
          normalizeName(`${option.name} ${option.helper ?? ""} ${group.label}`).includes(normalizedQuery)
        ),
      }))
      .filter((group) => group.options.length > 0);
  }, [query, uniqueGroups]);
  const visibleOptions = useMemo(
    () => filteredGroups.flatMap((group) => group.options),
    [filteredGroups]
  );

  function chooseLedger(name: string) {
    onChange(name);
    setQuery("");
    setOpen(false);
    setActiveOptionIndex(0);
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a8d7f]" />
        <input
          autoFocus
          className="h-10 w-full rounded-md border border-[#d8cbbb] bg-white px-3 pl-9 text-sm font-medium text-[#2b241d] outline-none transition placeholder:text-[#9a8d7f] focus:border-[#7c5f3f] focus:ring-2 focus:ring-[#7c5f3f]/10"
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveOptionIndex(0);
          }}
          onFocus={(event) => {
            const input = event.currentTarget;
            setOpen(true);
            setActiveOptionIndex(0);
            window.requestAnimationFrame(() => input.select());
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActiveOptionIndex((current) => {
                if (visibleOptions.length === 0) return 0;
                return (current + direction + visibleOptions.length) % visibleOptions.length;
              });
              return;
            }
            if (event.key === "Enter" && open && visibleOptions[activeOptionIndex]) {
              event.preventDefault();
              chooseLedger(visibleOptions[activeOptionIndex].name);
            }
          }}
          placeholder={placeholder}
          value={open ? query : value}
        />
      </div>

      {open ? (
        <div className="absolute z-30 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-[#d8cbbb] bg-white p-1 shadow-xl">
          {filteredGroups.length > 0 ? (
            filteredGroups.map((group) => (
              <div className="mb-1 last:mb-0" key={group.label}>
                <div className="px-3 pb-1 pt-2 text-[10px] font-black uppercase tracking-[0.14em] text-[#9a8d7f]">
                  {group.label}
                </div>
                {group.options.map((option) => {
                  const optionIndex = visibleOptions.findIndex((candidate) => candidate.name === option.name);
                  const keyboardActive = optionIndex === activeOptionIndex;
                  return (
                    <button
                      className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-semibold transition hover:bg-[#fbf4ea] ${
                        option.name === value || keyboardActive
                          ? "bg-[#f6efe6] text-[#4b3828]"
                          : "text-[#2b241d]"
                      }`}
                      key={option.name}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        chooseLedger(option.name);
                      }}
                      type="button"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{option.name}</span>
                        {option.helper ? (
                          <span className="mt-0.5 block truncate text-[11px] font-medium text-[#8a7f72]">
                            {option.helper}
                          </span>
                        ) : null}
                      </span>
                      {option.name === value ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" /> : null}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="px-3 py-4 text-sm font-semibold text-[#8a7f72]">
              No matching ledger found.
            </div>
          )}
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
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{
    bottom?: number;
    left: number;
    maxHeight: number;
    top?: number;
    width: number;
  } | null>(null);
  const [query, setQuery] = useState("");
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
          const searchable = `${group.label} ${option.label} ${option.name} ${option.helper ?? ""} ${option.badge ?? ""}`;
          return (
            normalizeName(searchable).includes(normalizedQuery) ||
            ledgerNameSimilarity(query, option.name) >= 0.78
          );
        }),
      }))
      .filter((group) => group.options.length > 0);
  }, [groups, normalizedQuery, query]);
  const displayValue = open ? query : getLedgerPickerDisplayValue(transaction);
  const visibleOptions = useMemo(
    () => filteredGroups.flatMap((group) => group.options),
    [filteredGroups]
  );

  function selectOption(option: LedgerSelection) {
    onChange(option);
    setQuery("");
    setOpen(false);
  }

  function openMenu() {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const gutter = 16;
      const width = Math.min(480, window.innerWidth - gutter * 2);
      const left = Math.min(
        Math.max(gutter, rect.right - width),
        Math.max(gutter, window.innerWidth - width - gutter)
      );
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const shouldOpenAbove = spaceBelow < 360 && spaceAbove > spaceBelow;
      const availableHeight = Math.max(220, shouldOpenAbove ? spaceAbove - gutter * 2 : spaceBelow - gutter * 2);
      setPopoverPosition({
        bottom: shouldOpenAbove ? window.innerHeight - rect.top + 8 : undefined,
        left,
        maxHeight: Math.min(420, availableHeight),
        top: shouldOpenAbove ? undefined : rect.bottom + 8,
        width,
      });
    }
    setActiveOptionIndex(0);
    setOpen(true);
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      openMenu();
    });
    return () => window.cancelAnimationFrame(frame);
    // This editor is mounted only when a row enters edit mode. Opening once
    // after layout guarantees that the first cell click can be measured.
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
        filteredGroups.map((group) => (
          <div className="mb-1 last:mb-0" key={group.label}>
            <div className="px-3 pb-1 pt-2 text-[10px] font-black uppercase tracking-[0.14em] text-[#9a8d7f]">
              {group.label}
            </div>
            {group.options.map((option) => {
              const selected =
                normalizeName(option.name) === normalizeName(transaction.selectedLedgerName) &&
                option.action === transaction.ledgerAction;
              const optionIndex = visibleOptions.findIndex((candidate) => candidate.key === option.key);
              const keyboardActive = optionIndex === activeOptionIndex;
              return (
                <button
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-semibold transition hover:bg-[#fbf4ea] ${
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
                    {option.helper ? (
                      <span className="mt-0.5 block whitespace-normal break-words text-[11px] font-medium leading-4 text-[#8a7f72]">
                        {option.helper}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {option.badge ? (
                      <Badge className="border-[#d8cbbb] bg-white text-[#6f4e2f]" variant="outline">
                        {option.badge}
                      </Badge>
                    ) : null}
                    {selected ? <CheckCircle2 className="h-4 w-4 text-emerald-700" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        ))
      ) : ledgerMasters.length === 0 ? (
        <div className="px-3 py-4 text-sm font-semibold text-[#8a7f72]">
          Tally ledgers are not loaded. Use Sync above, then search again.
        </div>
      ) : (
        <div className="px-3 py-4 text-sm font-semibold text-[#8a7f72]">
          No matching ledger found.
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="relative" ref={rootRef}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a8d7f]" />
        <input
          autoFocus
          className="h-10 w-full rounded-md border border-[#d8cbbb] bg-white px-3 pl-9 text-sm font-medium text-[#2b241d] outline-none transition placeholder:text-[#9a8d7f] focus:border-[#7c5f3f] focus:ring-2 focus:ring-[#7c5f3f]/10"
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
            setActiveOptionIndex(0);
            openMenu();
          }}
          onFocus={(event) => {
            const input = event.currentTarget;
            openMenu();
            window.requestAnimationFrame(() => input.select());
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
                if (visibleOptions.length === 0) return 0;
                return (current + direction + visibleOptions.length) % visibleOptions.length;
              });
              return;
            }
            if (event.key === "Enter" && open && visibleOptions[activeOptionIndex]) {
              event.preventDefault();
              selectOption(visibleOptions[activeOptionIndex]);
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

function getReviewStatusClass(transaction: ReviewTransaction) {
  const status = getReviewStatus(transaction);
  if (status === "matched") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "suspense") return "border-slate-300 bg-slate-100 text-slate-700";
  return "border-amber-200 bg-amber-50 text-amber-800";
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
  if (!draft) return "Not Matched";
  if (draft.status === "not_applicable") return "Not Applicable";
  if (draft.status === "cannot_match_yet") return "Cannot Match Yet";
  if (draft.status === "ready_to_post") {
    if (draft.newAdvanceAmount > 0 && draft.allocations.some((line) => line.referenceType === "Agst Ref")) {
      return "Bills + Advance";
    }
    if (draft.allocations.some((line) => line.referenceType === "Advance")) return "Advance";
    return `Ready - ${draft.allocations.length} Bill${draft.allocations.length === 1 ? "" : "s"}`;
  }
  if (draft.status === "needs_review") return "Needs Review";
  if (draft.status === "stale_data") return "Re-match Required";
  if (draft.status === "posted") return "Posted";
  if (draft.status === "post_failed") return "Posting Failed";
  return "Not Matched";
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
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
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

function getLedgerGroupLabel(transaction: ReviewTransaction, ledgerMasters: TallyMaster[]) {
  const ledger = findLedgerByNormalizedName(ledgerMasters, transaction.selectedLedgerName);
  return ledger?.parent || transaction.ledgerGroup || "-";
}

function getSelectedLedger(transaction: ReviewTransaction, ledgerMasters: TallyMaster[]) {
  return findLedgerByNormalizedName(ledgerMasters, transaction.selectedLedgerName);
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
  if (!transaction.selectedLedgerName.trim() || isSuspenseLedgerName(transaction.selectedLedgerName)) {
    return { eligible: false, amount, direction, partyKind: null, reason: "Select the party ledger first." };
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
  if (direction === "payment") {
    return { eligible: false, amount, direction, partyKind, reason: "Outgoing payments will be checked against existing Tally entries." };
  }
  if (partyKind === "customer" && direction !== "receipt") {
    return { eligible: false, amount, direction, partyKind, reason: "Customer refunds need manual review." };
  }
  if (partyKind !== "customer") {
    return { eligible: false, amount, direction, partyKind, reason: "Only incoming customer receipts need bill matching." };
  }

  return { eligible: true, amount, direction, partyKind, reason: "" };
}

function isBillMatchEligibleTransaction(transaction: ReviewTransaction, ledgerMasters: TallyMaster[]) {
  return getPartyBillMatchContext(transaction, ledgerMasters).eligible;
}

function getBillAllocationBadgeText(
  transaction: ReviewTransaction,
  ledgerMasters: TallyMaster[],
  draft?: BillAllocationDraft | null
) {
  if (draft) return getBillAllocationLabel(draft);
  if (isOutgoingPaymentRow(transaction)) return "Check Entry";
  const context = getPartyBillMatchContext(transaction, ledgerMasters);
  if (context.eligible) return "Not Matched";
  if (context.partyKind && context.reason.includes("bill-wise")) return "Needs Bill-Wise";
  if (!context.partyKind && context.reason.includes("party ledger")) return "Needs Party Ledger";
  return "Not Applicable";
}

function getBillAllocationBadgeClass(
  transaction: ReviewTransaction,
  ledgerMasters: TallyMaster[],
  draft?: BillAllocationDraft | null
) {
  if (draft) return getBillAllocationClass(draft);
  if (isOutgoingPaymentRow(transaction)) return "border-blue-200 bg-blue-50 text-blue-800";
  const context = getPartyBillMatchContext(transaction, ledgerMasters);
  if (context.eligible) return "border-amber-200 bg-amber-50 text-amber-800";
  if (context.partyKind || context.reason.includes("party ledger")) return "border-amber-200 bg-amber-50 text-amber-800";
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
  const date = transaction.transactionDate.replace(/-/g, "");
  const suffix = normalizeReferenceToken(transaction.referenceNumber || transaction.id).slice(-8) || transaction.id.slice(0, 8);
  return `ADV-${date}-${suffix}`.slice(0, 80);
}

function isAllocationTotalValid(receiptAmount: number, totalAllocatedAmount: number) {
  return Math.abs(receiptAmount - totalAllocatedAmount) < 0.005;
}

function getAllocationCaseLabel(allocations: BillAllocationLine[], newAdvanceAmount: number, manual = false) {
  if (manual) return "Manual Review";
  const billLines = allocations.filter((line) => line.referenceType === "Agst Ref");
  if (billLines.length === 0) return "No Pending Bill - Advance";
  if (newAdvanceAmount > 0) return "Bills Cleared + Advance";
  if (billLines.length > 1) return "Split Across Bills";
  return billLines[0]?.pendingAmountAfterAllocation === 0 ? "Exact Bill Match" : "Partial Settlement";
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
      reason: "Existing advances require an explicit allocation review before applying this receipt.",
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
    allocationReason = "No open bill was found. The full receipt will be posted as a new customer advance.";
  } else if (narrationBill) {
    allocationReason = `Matched the visible bill reference ${narrationBill.referenceName}; any remaining receipt was allocated FIFO.`;
  } else if (automaticAllocation.newAdvanceAmount > 0) {
    allocationReason = "Allocated open bills FIFO; the remaining receipt will be posted as a new advance.";
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
  description: string;
  referenceNumber?: string | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
}) {
  return [
    transaction.transactionDate,
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
    return {
      tone: "info" as const,
      text: `File stored. ${extractionIssue} Please verify rows before posting receipts or checking payments.`,
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

function getPdfPreviewUrl(objectUrl: string) {
  return `${objectUrl}#navpanes=0&view=Fit&zoom=page-fit`;
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
  const sending = sendingMode !== null;
  const [matchingBills, setMatchingBills] = useState(false);
  const [tallyCheckAttempted, setTallyCheckAttempted] = useState(false);
  const [statementDirectionsSwapped, setStatementDirectionsSwapped] = useState(false);
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
  const [activeReviewTransactionId, setActiveReviewTransactionId] = useState<string | null>(null);
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
  const [, setTallyBalanceProof] = useState<TallyBalanceProof | null>(null);
  const [billAllocationReviewTransactionId, setBillAllocationReviewTransactionId] = useState<string | null>(null);
  const [outgoingReviewTransactionId, setOutgoingReviewTransactionId] = useState<string | null>(null);
  const reviewRowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const reviewSearchInputRef = useRef<HTMLInputElement>(null);
  const reviewPeriodInputRef = useRef<HTMLInputElement>(null);
  const ledgerLoadSeqRef = useRef(0);
  const bankLedgerLoadKeyRef = useRef("");
  const initialSummaryLoadStartedRef = useRef(false);
  const tallyStatusStartedAtRef = useRef(Date.now());
  const lastNonEmptyCompaniesRef = useRef<CompanyOption[]>([]);
  const [checkingLiveTallyCompany, setCheckingLiveTallyCompany] = useState(true);

  const validTransactions = useMemo(
    () => transactions.filter(transactionIsValid),
    [transactions]
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
      }));
    const allOtherLedgers = ledgerMasters
      .filter((ledger) => ledger.name.trim() && !identifiedNames.has(normalizeName(ledger.name)))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((ledger) => ({
        name: ledger.name,
        helper: ledger.parent ? `Group: ${ledger.parent}` : "Tally ledger",
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
  const missingLedgerCount = useMemo(
    () => validTransactions.filter((transaction) => !transaction.selectedLedgerName.trim()).length,
    [validTransactions]
  );
  const pendingLedgerReviewCount = useMemo(
    () => validTransactions.filter((transaction) => getReviewStatus(transaction) === "needs_review").length,
    [validTransactions]
  );
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
    () => validTransactions.filter(
      (transaction) => tallyPresenceByTransactionId[transaction.id]?.status === "missing"
    ),
    [tallyPresenceByTransactionId, validTransactions]
  );
  const receiptTransactionsNeedingPost = useMemo(
    () => transactionsNeedingTallyWork.filter(isIncomingReceiptRow),
    [transactionsNeedingTallyWork]
  );
  const outgoingTransactionsNeedingCheck = useMemo(
    () => transactionsNeedingTallyWork.filter(isOutgoingPaymentRow),
    [transactionsNeedingTallyWork]
  );
  const newReceiptCount = receiptTransactionsNeedingPost.length;
  const missingOutgoingCount = outgoingTransactionsNeedingCheck.length;
  const verifiedReceiptCount = validTransactions.filter(
    (transaction) =>
      isIncomingReceiptRow(transaction) && tallyPresenceByTransactionId[transaction.id]?.status === "found"
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
  const blockingReceiptBillAllocationTransactions = useMemo(
    () =>
      receiptTransactionsNeedingPost.filter((transaction) => {
        if (!isBillMatchEligibleTransaction(transaction, ledgerMasters)) return false;
        const draft = billAllocationsByTransactionId[transaction.id];
        return !draft || draft.status === "cannot_match_yet" || draft.status === "needs_review" || draft.status === "stale_data";
      }),
    [billAllocationsByTransactionId, ledgerMasters, receiptTransactionsNeedingPost]
  );
  const blockingReceiptBillAllocationCount = blockingReceiptBillAllocationTransactions.length;
  const firstBlockingReceiptBillAllocationTransaction = blockingReceiptBillAllocationTransactions[0] ?? null;
  const transactionOutcomeCounts = useMemo(() => {
    const counts = {
      alreadyInTally: 0,
      receiptsToCreate: 0,
      paymentsConfirmed: 0,
      needsAttention: 0,
    };

    for (const transaction of validTransactions) {
      const presence = tallyPresenceByTransactionId[transaction.id];
      const isIncoming = isIncomingReceiptRow(transaction);
      const isOutgoing = isOutgoingPaymentRow(transaction);
      const hasLedgerIssue = getReviewStatus(transaction) === "needs_review";
      const allocation = billAllocationsByTransactionId[transaction.id];
      const hasBlockingBillAllocation =
        isIncoming &&
        presence?.status === "missing" &&
        isBillMatchEligibleTransaction(transaction, ledgerMasters) &&
        (!allocation ||
          allocation.status === "cannot_match_yet" ||
          allocation.status === "needs_review" ||
          allocation.status === "stale_data");

      if (
        hasLedgerIssue ||
        hasBlockingBillAllocation ||
        presence?.status === "ambiguous" ||
        presence?.duplicateInTally === true
      ) {
        counts.needsAttention += 1;
      } else if (isOutgoing && presence?.status === "found") {
        counts.paymentsConfirmed += 1;
      } else if (presence?.status === "found") {
        counts.alreadyInTally += 1;
      } else if (isIncoming && presence?.status === "missing") {
        counts.receiptsToCreate += 1;
      } else {
        counts.needsAttention += 1;
      }
    }

    return counts;
  }, [
    billAllocationsByTransactionId,
    ledgerMasters,
    tallyPresenceByTransactionId,
    validTransactions,
  ]);
  const needsAttentionDetail = useMemo(() => {
    if (uncheckedTallyPresenceCount > 0) return "Run Tally check first";
    if (transactionOutcomeCounts.needsAttention === 0) return "No manual review needed";

    const otherAttentionCount = Math.max(
      transactionOutcomeCounts.needsAttention - missingOutgoingCount,
      0
    );
    if (missingOutgoingCount > 0 && otherAttentionCount === 0) {
      return `${missingOutgoingCount} payment${missingOutgoingCount === 1 ? "" : "s"} not found in Tally`;
    }
    if (missingOutgoingCount > 0) {
      return `${missingOutgoingCount} payment${missingOutgoingCount === 1 ? "" : "s"} not found; ${otherAttentionCount} other`;
    }
    return `${transactionOutcomeCounts.needsAttention} transaction${transactionOutcomeCounts.needsAttention === 1 ? "" : "s"} need review`;
  }, [missingOutgoingCount, transactionOutcomeCounts.needsAttention, uncheckedTallyPresenceCount]);
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
      if (reviewDateFrom && transaction.transactionDate < reviewDateFrom) {
        return false;
      }
      if (reviewDateTo && transaction.transactionDate > reviewDateTo) {
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
        transaction.transactionDate,
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
  const receiptPostingCompleted = Boolean(
    statementCompletedCleanly &&
      tallyPostingStatus?.finished &&
      tallyPostingStatus.voucherTotal > 0
  );
  const statementReconciliationCompleted =
    receiptPostingCompleted && transactionOutcomeCounts.needsAttention === 0;
  const billAllocationReviewIsNextAction =
    uncheckedTallyPresenceCount === 0 &&
    pendingLedgerReviewCount === 0 &&
    ambiguousTallyPresenceCount === 0 &&
    blockingReceiptBillAllocationCount > 0;
  const postReceiptsButtonLabel = sendingMode === "post_receipts"
    ? "Sending..."
    : uncheckedTallyPresenceCount > 0
      ? "Check Matches First"
      : pendingLedgerReviewCount > 0
        ? `Review ${pendingLedgerReviewCount} Ledger Match${pendingLedgerReviewCount === 1 ? "" : "es"}`
        : ambiguousTallyPresenceCount > 0
          ? `Review ${ambiguousTallyPresenceCount} Ambiguous`
          : blockingReceiptBillAllocationCount > 0
            ? `Review ${blockingReceiptBillAllocationCount} Bill Match${blockingReceiptBillAllocationCount === 1 ? "" : "es"}`
            : `Post ${newReceiptCount} Receipt${newReceiptCount === 1 ? "" : "s"}`;
  const statementReviewLocked = Boolean(statementDoneSummary) || tallyPostingInProgress;
  const statementReviewDrawerLocked = tallyPostingInProgress;
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
      setActiveReviewTransactionId(null);
      return;
    }
    setActiveReviewTransactionId((current) =>
      current && visibleReviewTransactions.some((transaction) => transaction.id === current)
        ? current
        : visibleReviewTransactions[0].id
    );
  }, [visibleReviewTransactions]);

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
          setBillAllocationReviewTransactionId(null);
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
        const currentIndex = filteredTransactions.findIndex(
          (transaction) => transaction.id === activeReviewTransactionId
        );
        let nextIndex = currentIndex < 0 ? 0 : currentIndex;
        if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = filteredTransactions.length - 1;
        else if (event.key === "ArrowDown") nextIndex += 1;
        else if (event.key === "ArrowUp") nextIndex -= 1;
        else if (event.key === "PageDown") nextIndex += rowsPerPage;
        else if (event.key === "PageUp") nextIndex -= rowsPerPage;
        nextIndex = Math.min(Math.max(nextIndex, 0), filteredTransactions.length - 1);
        const nextTransaction = filteredTransactions[nextIndex];
        setActiveReviewTransactionId(nextTransaction.id);
        setReviewPage(Math.floor(nextIndex / rowsPerPage) + 1);
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            reviewRowRefs.current.get(nextTransaction.id)?.scrollIntoView({ block: "nearest" });
          });
        });
        return;
      }

      if ((event.key === "Enter" || event.key === "F2") && activeReviewTransactionId && !statementReviewLocked) {
        event.preventDefault();
        setEditingLedgerIds(new Set([activeReviewTransactionId]));
      }
    }

    window.addEventListener("keydown", handleReviewShortcut);
    return () => window.removeEventListener("keydown", handleReviewShortcut);
  }, [
    activeReviewTransactionId,
    bankLedgerChangeMode,
    billAllocationReviewTransactionId,
    editingLedgerIds,
    filteredTransactions,
    outgoingReviewTransactionId,
    preview,
    reviewFiltersOpen,
    rowsPerPage,
    shortcutsOpen,
    statementReviewLocked,
  ]);
  const billAllocationReviewTransaction = billAllocationReviewTransactionId
    ? validTransactions.find((transaction) => transaction.id === billAllocationReviewTransactionId) ?? null
    : null;
  const billAllocationReviewDraft = billAllocationReviewTransaction
    ? billAllocationsByTransactionId[billAllocationReviewTransaction.id] ?? null
    : null;
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
  const tallyResultReviewDirection = tallyResultReviewIsIncoming ? "receipt" : "payment";
  const tallyResultReviewAmount = outgoingReviewTransaction
    ? tallyResultReviewIsIncoming
      ? outgoingReviewTransaction.creditAmount
      : outgoingReviewTransaction.debitAmount
    : 0;
  const tallyResultReviewReason = (() => {
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

    const response = await apiFetch(
      `/api/tally/connections/${connectionId}/masters?type=ledger&all=true`,
      { cache: "no-store" }
    );
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const payload = (await response.json()) as { masters?: TallyMaster[] };
    const masters = payload.masters ?? [];
    if (loadSeq === ledgerLoadSeqRef.current) {
      setLedgerMasters(masters);
    }
    return masters;
  }, []);

  useEffect(() => {
    if (!tallyConnectionId) {
      setCheckingLiveTallyCompany(false);
      return;
    }

    let cancelled = false;
    let attempts = 0;
    tallyStatusStartedAtRef.current = Date.now();
    setCheckingLiveTallyCompany(true);

    const pollLiveCompany = async () => {
      try {
        const response = await apiFetch(`/api/tally/connections/${tallyConnectionId}/status`, { cache: "no-store" });
        if (!response.ok || cancelled) return false;
        const payload = (await response.json()) as { connection?: TallyConnection };
        const connection = payload.connection;
        if (!connection) return false;
        setConnections((current) => current.map((item) => (item.id === connection.id ? connection : item)));

        const updatedAt = connection.updatedAt ? Date.parse(connection.updatedAt) : Number.NaN;
        if (Number.isFinite(updatedAt) && updatedAt >= tallyStatusStartedAtRef.current - 1000) {
          setCheckingLiveTallyCompany(false);
          return true;
        }
      } catch {
        // Do not present a stale company as the active Tally company.
      }
      return false;
    };

    void pollLiveCompany();
    const timer = window.setInterval(() => {
      attempts += 1;
      void pollLiveCompany().then((fresh) => {
        if (fresh || attempts >= 7) window.clearInterval(timer);
      });
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tallyConnectionId]);

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
      const byCompany = Object.fromEntries(
        cleanCompanyNames.map((companyName) => {
          const company = companyOptions.find(
            (option) => normalizeName(option.companyName) === normalizeName(companyName)
          );
          return [companyName, company?.bankLedgers ?? []];
        })
      ) as Record<string, LocalBankLedger[]>;
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
    setTallyBalanceProof(null);
    setTallyCheckAttempted(false);
    setStatementDirectionsSwapped(false);
    setBillAllocationReviewTransactionId(null);
    setOutgoingReviewTransactionId(null);
  }, []);
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
            text: `${nextStatus.voucherCompleted}/${nextStatus.voucherTotal} receipt posting action(s) and ${nextStatus.paymentCheckCompleted}/${nextStatus.paymentCheckTotal} payment check(s) completed. Review the failed work before retrying.`,
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
              : `${nextStatus.voucherCompleted} receipt posting action(s) and ${nextStatus.paymentCheckCompleted} outgoing payment check(s) completed.`,
          });
          setBanner({
            tone: "success",
            text: checksOnly
              ? `${nextStatus.paymentCheckCompleted} outgoing payment check(s) completed. No Tally entries were created.`
              : `${nextStatus.voucherCompleted} receipt posting action(s) and ${nextStatus.paymentCheckCompleted} payment check(s) completed.`,
          });
          showToast(
            "success",
            checksOnly
              ? `${nextStatus.paymentCheckCompleted} payment check(s) completed; no entries created.`
              : `${nextStatus.voucherCompleted} receipt posting action(s) completed.`
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
      const response = await apiFetch(`/api/bank-statements/tally/queue-jobs/${jobId}/run`, {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) {
        if ([502, 503, 504].includes(response.status)) {
          const payload = await readTallyQueueJob(jobId).catch(() => null);
          const job = payload?.job;
          if (job?.status === "succeeded") {
            return (payload?.result ?? job.result ?? { queuedCount: 0, verificationCount: 0, commands: [] }) as TallyQueueResult;
          }
          if (job?.status === "failed" || job?.status === "cancelled") {
            throw new Error(job.error || payload?.error || "Tally queue job failed.");
          }
          const processed = Number(job?.processedCount ?? 0);
          const total = Number(job?.totalCount ?? 0);
          setBanner({
            tone: "info",
            text: total > 0
              ? `Preparing Tally queue: ${Math.min(processed, total)} of ${total} transaction(s). Retrying after a server timeout.`
              : "Preparing Tally queue. Retrying after a server timeout.",
          });
          await wait(5000);
          continue;
        }
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as TallyQueueJobResponse;
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
      await wait(1200);
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
    const connectionId = companyOptions[0]?.connectionId || tallyConnectionId;
    const companyNames = companyOptions.map((company) => company.companyName).filter(Boolean);
    const key = `${connectionId}::${companyNames.join("|")}`;
    if (!connectionId || companyNames.length === 0 || bankLedgerLoadKeyRef.current === key) return;

    bankLedgerLoadKeyRef.current = key;
    void fetchTallyBankLedgersForCompanies(connectionId, companyNames, { quiet: true });
  }, [companyOptions, tallyConnectionId]);

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
    setBillAllocationsByTransactionId((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setOutgoingVerificationsByTransactionId((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setBillAllocationReviewTransactionId((current) => (current === id ? null : current));
    setOutgoingReviewTransactionId((current) => (current === id ? null : current));
  }

  function swapStatementPaymentAndReceipt() {
    if (tallyCheckAttempted || matchingBills || validTransactions.length === 0) return;

    setTransactions((current) =>
      current.map((transaction) => ({
        ...transaction,
        debitAmount: transaction.creditAmount,
        creditAmount: transaction.debitAmount,
      }))
    );
    setStatementDirectionsSwapped((current) => !current);
    setBillAllocationsByTransactionId({});
    setOutgoingVerificationsByTransactionId({});
    setTallyPresenceByTransactionId({});
    setTallyBalanceProof(null);
    setStatementDoneSummary(null);
    setTallyPostingStatus(null);
    setBanner({
      tone: "info",
      text: statementDirectionsSwapped
        ? "Payment and receipt amounts restored. Run Check Tally Matches when ready."
        : "Payment and receipt amounts swapped. This corrected direction will be used for Tally checking and posting.",
    });
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
        const companyNames = loadedCompanies.map((company) => company.companyName).filter(Boolean);
        bankLedgerLoadKeyRef.current = "";
        await fetchTallyBankLedgersForCompanies(nextConnectionId, companyNames, { quiet: true });
        await loadLedgerMasters(nextConnectionId).catch(() => setLedgerMasters([]));
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

  function confirmBankLedgerChange() {
    if (!pendingBankLedgerName.trim()) {
      showToast("error", "Choose a Tally bank ledger first.");
      return;
    }

    applyTallyBankLedgerSelection(pendingBankLedgerName);
    showToast("success", "Bank ledger updated for this statement.");
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
    setTallyBalanceProof(null);
    setTallyCheckAttempted(false);
    setStatementDirectionsSwapped(false);
    setReviewFiltersOpen(false);
    setReviewSearch("");
    setReviewWorkStatusFilter("all");
    setReviewTallyResultFilter("all");
    setReviewLedgerFilter("all");
    setReviewDirectionFilter("all");
    setReviewAllocationFilter("all");
    setReviewDateFrom("");
    setReviewDateTo("");
    setActiveReviewTransactionId(null);
    setBillAllocationReviewTransactionId(null);
    setOutgoingReviewTransactionId(null);
  }
  async function pollImportUntilReady(importId: string, ledgerMastersForReview = ledgerMasters) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(2500);
      const payload = await loadImportPreviewMetadata(importId);
      if (payload.processing) {
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
      setBanner(getAnalysisCompleteMessage(fullPayload));
      return fullPayload;
    }

    throw new Error("Bank statement analysis is still running. Please refresh in a moment.");
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
      setLoading(true);
      setBanner(null);
      setStatementPasswordError(null);
      setTallyPostingStatus(null);
      setStatementDoneSummary(null);
      setPostUploadSyncImportId(null);
      setPostUploadSyncError(null);
      setFile(nextFile);
      const syncedMasters = await syncCompanyData({
        quiet: true,
        statusText: "Fetching the latest ledgers directly from Tally before analysis...",
      });
      if (!syncedMasters) {
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
      const syncedMasters = await syncCompanyData({ quiet: true });
      if (!syncedMasters) {
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
            requestedMasterTypes: ["ledger", "group", "voucher_type", "gst_ledger", "tax_ledger"],
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

  async function fetchOpenBillsForLedgers(connection: TallyConnection, ledgerNames: string[], asOfDate?: string | null) {
    const requestedLedgerNames = Array.from(
      new Set(ledgerNames.map((ledgerName) => ledgerName.trim()).filter(Boolean))
    );
    if (requestedLedgerNames.length === 0) {
      return new Map<string, { openBills: OpenBillReference[]; existingAdvances: ExistingAdvanceReference[] }>();
    }

    const response = await apiFetch(`/api/tally/connections/${connection.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandType: "fetch_customer_open_bills",
        payload: {
          ledgerName: requestedLedgerNames[0],
          ledgerNames: requestedLedgerNames,
          companyName: selectedCompanyName || connection.lastCompanyName,
          asOfDate: asOfDate || undefined,
          queryPurpose: "bank_statement_match",
        },
      }),
    });

    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const payload = (await response.json()) as { command?: TallyCommand };
    const command = payload.command;
    if (!command?.id) {
      throw new Error("Open bill fetch was queued, but no command id was returned.");
    }

    const completedCommand = await waitForCommand(connection.id, command.id);
    if (!completedCommand) {
      throw new Error("Open bill fetch is still pending.");
    }
    if (completedCommand.status !== "succeeded") {
      throw new Error(completedCommand.error || `Open bill fetch ${completedCommand.status}.`);
    }

    const result = completedCommand.result ?? {};
    const billDataByLedger = new Map<string, { openBills: OpenBillReference[]; existingAdvances: ExistingAdvanceReference[] }>();
    const rawByLedger = result.byLedger && typeof result.byLedger === "object"
      ? result.byLedger as Record<string, unknown>
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

  async function verifyBankStatementPresence(connection: TallyConnection, rows: ReviewTransaction[]) {
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
    const response = await apiFetch(`/api/tally/connections/${connection.id}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandType: "verify_bank_transaction",
        payload: {
          companyName: selectedCompanyName || connection.lastCompanyName,
          bankLedgerName,
          relevantLedgerNames,
          voucherTypes: ["Receipt", "Payment", "Contra", "Journal"],
          transactions: rows.map((transaction) => {
            const incoming = isIncomingReceiptRow(transaction);
            const debitAmount = parseNumber(transaction.debitAmount) ?? 0;
            const creditAmount = parseNumber(transaction.creditAmount) ?? 0;
            return {
              transactionId: transaction.id,
              voucherDate: transaction.transactionDate,
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
      }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { command?: TallyCommand };
    if (!payload.command?.id) throw new Error("Tally statement check was queued without a command id.");

    const completed = await waitForCommands(connection.id, [payload.command.id]);
    const command = completed.find((item) => item.id === payload.command?.id);
    if (!command) throw new Error("Tally statement check timed out.");
    if (command.status !== "succeeded") {
      throw new Error(command.error || `Tally statement check ${command.status}.`);
    }
    const result = command.result ?? {};
    const resultRows = Array.isArray(result.transactions) ? result.transactions : [];
    const drafts = Object.fromEntries(resultRows.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      const transactionId = typeof row.transactionId === "string" ? row.transactionId : "";
      if (!transactionId) return [];
      return [[transactionId, outgoingVerificationFromCommand({
        ...command,
        result: row,
      })]];
    })) as Record<string, OutgoingVerificationDraft>;
    const balanceProof = result.balanceProof && typeof result.balanceProof === "object" && !Array.isArray(result.balanceProof)
      ? result.balanceProof as TallyBalanceProof
      : null;
    setTallyPresenceByTransactionId(drafts);
    setOutgoingVerificationsByTransactionId(Object.fromEntries(
      rows.filter(isOutgoingPaymentRow).flatMap((transaction) => {
        const draft = drafts[transaction.id];
        return draft ? [[transaction.id, draft]] : [];
      })
    ));
    setTallyBalanceProof(balanceProof);
    return { drafts, balanceProof };
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
      if (!transaction.transactionDate || amount <= 0) {
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
              voucherDate: transaction.transactionDate,
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
    try {
      setMatchingBills(true);
      setBanner({ tone: "info", text: "Checking the full statement against live Tally vouchers..." });
      const { drafts: presenceDrafts, balanceProof } = await verifyBankStatementPresence(connection, validTransactions);
      const receiptTransactionsToMatch = pendingBillEligibleTransactions.filter(
        (transaction) => presenceDrafts[transaction.id]?.status === "missing"
      );
      const nextDrafts: Record<string, BillAllocationDraft> = {};
      if (receiptTransactionsToMatch.length > 0) {
        const ledgers = Array.from(new Set(receiptTransactionsToMatch.map((transaction) => transaction.selectedLedgerName)));
        const asOfDate = receiptTransactionsToMatch.map((transaction) => transaction.transactionDate).filter(Boolean).sort().at(-1);
        const billDataByLedger = await fetchOpenBillsForLedgers(connection, ledgers, asOfDate);

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
      const foundCount = Object.values(presenceDrafts).filter((draft) => draft.status === "found").length;
      const ambiguousCount = Object.values(presenceDrafts).filter((draft) => draft.status === "ambiguous").length;
      const duplicateCount = Object.values(presenceDrafts).filter((draft) => draft.duplicateInTally).length;
      const missingReceiptRows = validTransactions.filter(
        (transaction) => isIncomingReceiptRow(transaction) && presenceDrafts[transaction.id]?.status === "missing"
      ).length;
      const missingOutgoingRows = validTransactions.filter(
        (transaction) => isOutgoingPaymentRow(transaction) && presenceDrafts[transaction.id]?.status === "missing"
      ).length;
      const uncheckedRows = validTransactions.length - foundCount - ambiguousCount - missingReceiptRows - missingOutgoingRows;
      const hasRowReviewIssues =
        duplicateCount > 0 ||
        ambiguousCount > 0 ||
        uncheckedRows > 0;
      setBanner({
        tone: hasRowReviewIssues ? "info" : "success",
        text: `Statement checked. ${missingReceiptRows > 0
          ? `${missingReceiptRows} receipt${missingReceiptRows === 1 ? " is" : "s are"} ready to post.`
          : "No new receipts to post."}${hasRowReviewIssues ? " Review the highlighted rows." : ""}${
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
    }
  }

  async function sendToTally(mode: TallySendMode) {
    if (!preview) return;
    const selectedTallyWorkTransactions =
      mode === "post_receipts" ? receiptTransactionsNeedingPost : outgoingTransactionsNeedingCheck;
    if (selectedTallyWorkTransactions.length === 0) {
      showToast(
        "info",
        mode === "post_receipts" ? "No new receipts to post." : "No missing payments to check."
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
    if (!bankLedgerVerified && !bankLedgerManuallyConfirmed) {
      showToast("error", "Review the account mismatch and explicitly choose the intended Tally ledger before posting.");
      return;
    }
    if (validTransactions.length === 0) {
      showToast("error", "No valid rows are available to send.");
      return;
    }
    if (missingLedgerCount > 0) {
      showToast("error", "Select a ledger for every row before sending to Tally.");
      return;
    }
    if (pendingLedgerReviewCount > 0) {
      showToast("error", "Review and confirm close ledger matches before sending to Tally.");
      return;
    }
    if (uncheckedTallyPresenceCount > 0) {
      showToast("error", "Check the full statement against Tally before sending anything.");
      return;
    }
    if (ambiguousTallyPresenceCount > 0) {
      showToast("error", "Review ambiguous Tally matches before sending anything.");
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
    if (mode === "post_receipts" && blockingReceiptBillAllocationCount > 0) {
      setBanner({
        tone: "error",
        text: `${blockingReceiptBillAllocationCount} party row(s) need bill allocation review before posting receipts to Tally.`,
      });
      showToast("error", "Match or review open bills before posting receipts to Tally.");
      return;
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
      };

      const queueableTransactions = await fetchQueueableTransactions({
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
        setStatementDoneSummary({
          tone: "info",
          title: "Done. Nothing new to send.",
          text: `${confirmPayload.importedTransactionCount} transaction(s) imported. No new row needed Tally posting or payment checking.`,
        });
        setBillAllocationsByTransactionId({});
        setOutgoingVerificationsByTransactionId({});
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
          transactions: queueRows.map((transaction) => ({
            transactionId: transaction.id,
            ...(() => {
              const reviewedTransaction = reviewedTransactionsByKey.get(transactionQueueKey(transaction));
              const billAllocation = reviewedTransaction
                ? billAllocationsByTransactionId[reviewedTransaction.id]
                : null;
              return {
                counterpartyLedgerName:
                  reviewedTransaction?.selectedLedgerName ||
                  transaction.confirmedLedgerName ||
                  transaction.suggestedLedgerName ||
                  "Suspense",
                createLedgerName: "",
                createLedgerParentName: "",
                billAllocations:
                  billAllocation?.status === "ready_to_post"
                    ? billAllocation.allocations.map((allocation) => ({
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
            ? `Creating ${voucherCount} receipt voucher(s) and checking ${paymentCheckCount} outgoing payment(s). Keep this page open while Tally works.`
            : voucherCount > 0
              ? `Creating ${voucherCount} receipt voucher(s). Keep this page open while Tally works.`
              : `Checking ${paymentCheckCount} outgoing payment(s) against Tally. No receipt vouchers will be created.`,
        });
        void pollTallyPostingStatus(postingConnectionId, commandIds)
          .then(async (finalStatus) => {
            if (!finalStatus?.finished || finalStatus.failed > 0 || finalStatus.canceled > 0 || !commandConnection) return;
            setBanner({ tone: "info", text: "Tally actions completed. Verifying the statement against live Tally..." });
            const { drafts, balanceProof } = await verifyBankStatementPresence(commandConnection, validTransactions);
            const remainingReceipts = validTransactions.filter(
              (transaction) => isIncomingReceiptRow(transaction) && drafts[transaction.id]?.status !== "found"
            ).length;
            const foundRows = Object.values(drafts).filter((draft) => draft.status === "found").length;
            if (remainingReceipts > 0) {
              setStatementDoneSummary({
                tone: "error",
                title: "Posting verification failed.",
                text: `${remainingReceipts} receipt(s) are still not present in live Tally. They were not treated as completed.`,
              });
              setBanner({
                tone: "error",
                text: `${remainingReceipts} receipt(s) are still missing after posting. Review the failed rows before retrying.`,
              });
              return;
            }
            const checksOnly = finalStatus.voucherTotal === 0;
            setStatementDoneSummary({
              tone: "success",
              title: checksOnly ? "Statement verified against Tally." : "Posted and verified in Tally.",
              text: checksOnly
                ? `All incoming receipts were already present. ${finalStatus.paymentCheckCompleted} outgoing payment check(s) completed and no Tally entries were created.`
                : `All incoming receipts are present in live Tally. ${foundRows} statement row(s) currently have matching Tally vouchers.`,
            });
            setBanner({
              tone: balanceProof?.balancesMatch === false ? "info" : "success",
              text: `${checksOnly ? "No entries were created; all incoming receipts were already present." : "All incoming receipts were verified in live Tally."}${balanceProof?.balancesMatch === false ? " Balance differs from Tally; posting remains allowed." : ""}`,
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
          ? `${queuedPayload.queuedCount ?? 0} receipt voucher(s) will be created; ${queuedPayload.verificationCount ?? 0} outgoing payment(s) will be checked.`
          : (queuedPayload.queuedCount ?? 0) > 0
            ? `${queuedPayload.queuedCount ?? 0} receipt voucher(s) will be created.`
            : `${queuedPayload.verificationCount ?? 0} outgoing payment check(s) started. No receipt vouchers will be created.`
      );
    } catch (error) {
      showToast(
        "error",
        error instanceof Error
          ? error.message
          : mode === "post_receipts"
            ? "Could not post receipts to Tally."
            : "Could not check payments in Tally."
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
                ["Enter", "Open ledger selection for the highlighted row"],
                ["F2", "Alter the highlighted row's Tally ledger"],
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
      <div className={`bank-statements-workflow min-h-screen bg-[#f7f7f5] px-4 text-[#1a1a1a] sm:px-8 ${preview ? "py-3 pb-40 sm:py-4 sm:pb-40" : "py-6 sm:py-8"}`}>
        <div className={`mx-auto flex max-w-7xl flex-col ${preview ? "gap-2.5" : "gap-4"}`}>
          <header className={`flex flex-col md:flex-row md:items-start md:justify-between border-b border-[#e5ddd0] ${preview ? "gap-2 pb-2" : "gap-3 pb-4"}`}>
            <div>
              {!preview && (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200/50 text-[10px] font-bold uppercase tracking-wider text-amber-800 mb-2">
                  <Sparkles className="h-3 w-3 text-amber-600 animate-spin duration-3000" />
                  ERP Reconciliation
                </div>
              )}
              <h1 className={`${preview ? "text-xl sm:text-2xl" : "text-2xl sm:text-[28px]"} font-black tracking-tight text-[#1a1a1a] flex items-center gap-2`}>
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
              {!preview && (
                <p className="text-xs font-semibold text-slate-500 mt-1">
                  Reconcile bank statement transactions and match bill allocations with Tally.
                </p>
              )}
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
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[#e5ddd0] bg-white px-3 py-2 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
              {["Upload statement", "Review file", "Analyze", "Match transactions"].map((step, index) => {
                const complete = workflowStep > index;
                const current = workflowStep === index;
                return (
                  <div
                    key={step}
                    className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-[11px] font-extrabold ${
                      complete
                        ? "bg-emerald-50 text-emerald-800"
                        : current
                          ? "bg-[#fff7e8] text-amber-900"
                          : "text-slate-400"
                    }`}
                  >
                    <span
                      className={`grid h-5 w-5 place-items-center rounded-full text-[10px] ${
                        complete
                          ? "bg-emerald-600 text-white"
                          : current
                            ? "bg-amber-500 text-white"
                            : "bg-slate-100 text-slate-400"
                      }`}
                    >
                      {complete ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
                    </span>
                    {step}
                  </div>
                );
              })}
            </div>
          ) : null}

          {banner && (!preview || banner.tone !== "success") && (
            <div
              className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ${
                banner.tone === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : banner.tone === "info"
                    ? "border-blue-200 bg-blue-50 text-blue-800"
                    : "border-rose-200 bg-rose-50 text-rose-800"
              }`}
            >
              {banner.tone === "success" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4" />
              )}
              <span>{banner.text}</span>
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
                documentPreview || documentPreviewLoading
                  ? ""
                  : "lg:grid-cols-[0.95fr_1.05fr]"
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
                {documentPreviewLoading ? (
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
                          <iframe
                            src={getPdfPreviewUrl(documentPreview.objectUrl)}
                            title={`Preview of ${documentPreview.fileName}`}
                            className="h-[680px] w-full bg-white"
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
            <section className="space-y-2.5">
              <div className="rounded-xl border border-[#e5ddd0] bg-white px-3 py-2 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
                <div className="grid gap-2 xl:grid-cols-[56%_44%] xl:items-center xl:gap-0">
                  <div className="grid min-w-0 sm:grid-cols-[minmax(0,0.82fr)_minmax(0,1.05fr)_minmax(0,1.2fr)] sm:divide-x sm:divide-[#eee7dc]">
                    <div className="min-w-0 py-1 sm:pr-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Company</div>
                      <div className="mt-0.5 break-words text-xs font-extrabold leading-4 text-[#1a1a1a]" title={selectedCompanyName}>
                        {selectedCompanyName || "Not selected"} - {selectedFinancialYear}
                      </div>
                    </div>
                    <div className="min-w-0 py-1 sm:px-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Period</div>
                      <div className="mt-0.5 break-words text-xs font-extrabold leading-4 text-[#1a1a1a]">
                        {preview.import.statementPeriodStart && preview.import.statementPeriodEnd
                          ? `${formatShortDate(preview.import.statementPeriodStart)} - ${formatShortDate(preview.import.statementPeriodEnd)}`
                          : "After analysis"}
                      </div>
                    </div>
                    <div className="min-w-0 py-1 sm:px-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-sky-700">Statement account</div>
                      <div className="mt-0.5 break-words text-xs font-extrabold leading-4 text-[#1a1a1a]" title={`${account.bankName || ""} ${account.accountNumber || ""}`}>
                        {account.bankName || "Account not detected"}
                        {account.accountNumber ? ` - ${account.accountNumber}` : ""}
                      </div>
                      <div className="mt-0.5 break-words text-[10px] font-semibold leading-3.5 text-slate-400">
                        {account.accountHolderName || "Holder not found"}
                        {account.ifscCode ? ` - ${account.ifscCode}` : ""}
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0 border-t border-[#eee7dc] pt-2 xl:border-l xl:border-t-0 xl:pl-3 xl:pt-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <ArrowRight aria-label="Statement to Tally ledger" className={`hidden h-3 w-3 shrink-0 xl:block ${bankLedgerVerified ? "text-emerald-600" : "text-amber-600"}`} />
                          <div className="text-[9px] font-bold uppercase tracking-wider text-emerald-700">
                            {bankLedgerChangeMode ? "Replace ledger" : "Posting ledger"}
                          </div>
                        </div>
                        {bankLedgerChangeMode || !bankLedgerName ? (
                          <div className="mt-1.5">
                            <LedgerSearchSelect
                              groups={bankLedgerPickerGroups}
                              onChange={bankLedgerChangeMode ? setPendingBankLedgerName : applyTallyBankLedgerSelection}
                              placeholder="Search bank accounts or all Tally ledgers"
                              value={bankLedgerChangeMode ? pendingBankLedgerName : ""}
                            />
                            {bankLedgerChangeMode ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <button
                                  className="inline-flex h-7 items-center rounded-lg bg-[#2d2d2d] px-3 text-[10px] font-bold text-white transition hover:bg-[#1a1a1a]"
                                  onClick={confirmBankLedgerChange}
                                  type="button"
                                >
                                  Use selected ledger
                                </button>
                                <button
                                  className="inline-flex h-7 items-center rounded-lg px-2 text-[10px] font-bold text-slate-500 transition hover:bg-slate-100 hover:text-[#1a1a1a]"
                                  onClick={cancelBankLedgerChange}
                                  type="button"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div className="mt-1 flex items-start gap-1.5 text-[10px] font-semibold text-amber-700">
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>Choose the intended ledger - no exact account match was found.</span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                            {bankLedgerVerified ? (
                              <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-700" />
                            ) : (
                              <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600" />
                            )}
                            <div className="min-w-0">
                              <div className="break-words text-xs font-extrabold leading-4 text-[#1a1a1a]" title={bankLedgerName}>
                                {bankLedgerName}
                              </div>
                              <div className={`text-[9px] font-bold leading-3.5 ${bankLedgerVerified ? "text-emerald-700" : "text-amber-700"}`} title={bankLedgerVerified ? "Exact statement account match" : "Manual selection - review account numbers"}>
                                {bankLedgerVerified ? "Exact statement account match" : "Manual selection - review account numbers"}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-col items-stretch gap-1.5">
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
                                  setBankLedgerVerified(false);
                                  setBankLedgerManuallyConfirmed(false);
                                }
                              }
                            }}
                            className="h-8 w-28 rounded-lg border border-[#e5ddd0] bg-white px-2 text-[10px] font-bold text-[#5a5046] outline-none focus:border-amber-500"
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
                            className="inline-flex h-6.5 items-center justify-center rounded-lg border border-[#e5ddd0] bg-white px-2 text-[9px] font-bold text-[#5a5046] transition-all hover:bg-[#faf8f4] hover:text-[#1a1a1a]"
                          >
                            Change ledger
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={handleSyncLedgerMasters}
                          disabled={!tallyCompanyContextVerified || syncingMasters || loadingBankLedgers}
                          className="inline-flex h-6.5 items-center justify-center gap-1 rounded-lg border border-[#e5ddd0] bg-white px-2 text-[9px] font-bold text-[#5a5046] transition-all hover:bg-[#faf8f4] hover:text-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {syncingMasters || loadingBankLedgers ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                          )}
                          Sync
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              {bankLedgerName && !bankLedgerVerified ? (
                <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <span>
                    This ledger has no exact verified account-number match to the uploaded statement. Choose it deliberately before posting.
                  </span>
                </div>
              ) : null}
              <section className="rounded-2xl border border-[#e5ddd0] bg-white p-3 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-sm font-black text-[#1a1a1a]">
                      {tallyPostingInProgress
                        ? "Posting receipts to Tally"
                        : matchingBills
                        ? "Checking statement against Tally"
                        : statementReconciliationCompleted
                          ? "Statement reconciliation complete"
                          : receiptPostingCompleted
                            ? "Receipt posting complete"
                        : uncheckedTallyPresenceCount > 0
                          ? "Live Tally check pending"
                        : transactionOutcomeCounts.needsAttention > 0
                          ? "Review needed before posting"
                          : transactionOutcomeCounts.receiptsToCreate > 0
                            ? "Receipts ready to post"
                             : "No new posting required"}
                    </h2>
                    {receiptPostingCompleted ? (
                      <p className="mt-0.5 text-[10px] font-semibold text-[#7a6c5f]">
                        {verifiedReceiptCount} receipt{verifiedReceiptCount === 1 ? " was" : "s were"} created or matched and verified in Tally.
                      </p>
                    ) : null}
                  </div>
                  <div className="text-[11px] font-bold text-[#7a6c5f]">
                    {filteredTransactions.length === validTransactions.length
                      ? `${validTransactions.length} transaction${validTransactions.length === 1 ? "" : "s"}`
                      : `${filteredTransactions.length} of ${validTransactions.length} transactions shown`}
                  </div>
                </div>
                <div className="mt-2 grid auto-cols-[minmax(160px,1fr)] grid-flow-col gap-2 overflow-x-auto pb-1 xl:grid-flow-row xl:grid-cols-5 xl:overflow-visible xl:pb-0">
                  {[
                    {
                      label: receiptPostingCompleted ? "Transactions analyzed" : "Transactions checked",
                      value: validTransactions.length,
                      detail: uncheckedTallyPresenceCount > 0
                        ? "Awaiting live Tally check"
                        : ignoredStatementRowCount === 0
                          ? "All rows classified"
                        : `${ignoredStatementRowCount} statement header/summary row${ignoredStatementRowCount === 1 ? "" : "s"} ignored`,
                      className: "border-slate-200 bg-slate-50 text-slate-800",
                    },
                    {
                      label: receiptPostingCompleted ? "Receipts verified in Tally" : "Already in Tally",
                      value: receiptPostingCompleted
                        ? verifiedReceiptCount
                        : uncheckedTallyPresenceCount > 0
                          ? "-"
                          : transactionOutcomeCounts.alreadyInTally,
                      detail: receiptPostingCompleted
                        ? "Created or matched successfully"
                        : uncheckedTallyPresenceCount > 0
                          ? "Live check pending"
                          : "Existing receipts or entries",
                      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
                    },
                    {
                      label: receiptPostingCompleted ? "Receipts remaining" : "Receipts to create",
                      value: uncheckedTallyPresenceCount > 0 ? "-" : transactionOutcomeCounts.receiptsToCreate,
                      detail: receiptPostingCompleted
                        ? transactionOutcomeCounts.receiptsToCreate === 0
                          ? "All receipts are in Tally"
                          : "Still require posting"
                        : uncheckedTallyPresenceCount > 0
                          ? "Live check pending"
                          : "Can be posted to Tally",
                      className: "border-blue-200 bg-blue-50 text-blue-800",
                    },
                    {
                      label: receiptPostingCompleted ? "Payments verified" : "Payments confirmed",
                      value: uncheckedTallyPresenceCount > 0 ? "-" : transactionOutcomeCounts.paymentsConfirmed,
                      detail: uncheckedTallyPresenceCount > 0 ? "Live check pending" : "Found in Tally",
                      className: "border-teal-200 bg-teal-50 text-teal-800",
                    },
                    {
                      label: receiptPostingCompleted ? "Payments to review" : "Needs review",
                      value: uncheckedTallyPresenceCount > 0 ? "-" : transactionOutcomeCounts.needsAttention,
                      detail: needsAttentionDetail,
                      className: transactionOutcomeCounts.needsAttention > 0
                        ? "border-amber-200 bg-amber-50 text-amber-900"
                        : "border-emerald-200 bg-emerald-50 text-emerald-800",
                    },
                  ].map((item) => (
                    <div key={item.label} className={`min-w-[160px] rounded-xl border px-3 py-2 xl:min-w-0 ${item.className}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-[9px] font-black uppercase tracking-[0.12em] opacity-75">
                          {item.label}
                        </div>
                        <div className="shrink-0 text-lg font-black leading-none">{item.value}</div>
                      </div>
                      <div className="mt-1 truncate text-[10px] font-bold leading-4 opacity-80" title={item.detail}>{item.detail}</div>
                    </div>
                  ))}
                </div>
              </section>
              <div className="hidden rounded-2xl border border-[#e3d6c6] bg-[#fffaf2] px-4 py-3 shadow-sm">
                <div className="grid gap-3 md:grid-cols-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-[#9a8d7f]">Company</div>
                    <div className="mt-1 truncate text-sm text-[#2b241d]" title={selectedCompanyName}>
                      {selectedCompanyName || "Not selected"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-[#9a8d7f]">Financial year</div>
                    <div className="mt-1 text-sm text-[#2b241d]">{selectedFinancialYear}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-[#9a8d7f]">Bank ledger (optional)</div>
                    <div className="mt-1 truncate text-sm text-[#2b241d]" title={bankLedgerName}>
                      {bankLedgerName || "Not selected"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-[#9a8d7f]">Statement period</div>
                    <div className="mt-1 text-sm text-[#2b241d]">
                      {preview.import.statementPeriodStart && preview.import.statementPeriodEnd
                        ? `${formatShortDate(preview.import.statementPeriodStart)} - ${formatShortDate(preview.import.statementPeriodEnd)}`
                        : "Extracted after analysis"}
                    </div>
                  </div>
                </div>
              </div>
              <div className="hidden rounded-2xl border border-[#e3d6c6] bg-white px-4 py-3 shadow-sm">
                <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
                  <div className="min-w-0 rounded-xl border border-[#eee5da] bg-[#fdfaf6] px-4 py-3">
                    <div className="text-[10px] font-black uppercase tracking-[0.16em] text-[#9a8d7f]">
                      Statement account
                    </div>
                    <div className="mt-2 flex min-w-0 items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-black text-[#2b241d]">
                          {account.bankName || "Account not detected"}
                          {account.accountNumber ? ` - ${account.accountNumber}` : ""}
                        </div>
                        <div className="truncate text-xs font-semibold text-[#8a7f72]">
                          {account.accountHolderName || "Holder not found"}
                          {account.ifscCode ? ` - ${account.ifscCode}` : ""}
                        </div>
                      </div>
                    </div>
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
                              setBankLedgerVerified(false);
                              setBankLedgerManuallyConfirmed(false);
                            }
                          }
                        }}
                        className="mt-3 h-9 w-full rounded-md border border-[#d8cbbb] bg-white px-3 text-sm font-medium outline-none focus:border-[#7c5f3f]"
                      >
                        <option value="new">Use extracted account</option>
                        {preview.candidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.accountHolderName || "Saved account"} - {candidate.accountNumber || candidate.accountNumberMasked}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>

                  <div className="min-w-0 rounded-xl border border-[#eee5da] bg-[#fdfaf6] px-4 py-3">
                    <div className="flex min-h-7 items-center justify-between gap-3">
                      <div className="text-[10px] font-black uppercase tracking-[0.16em] text-[#9a8d7f]">
                        Post entries to Tally bank account
                      </div>
                      <button
                        type="button"
                        onClick={handleSyncLedgerMasters}
                        disabled={!tallyCompanyContextVerified || syncingMasters || loadingBankLedgers}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d8cbbb] bg-white px-2 text-[11px] font-bold text-[#6f4e2f] hover:bg-[#fbf7f1] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {syncingMasters || loadingBankLedgers ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Sync company data
                      </button>
                    </div>
                    {bankLedgerName ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
                          <div className="truncate text-sm font-black text-[#2b241d]">{bankLedgerName}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setBankLedgerName("")}
                          className="text-xs font-bold text-[#6f4e2f] underline-offset-2 hover:underline"
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <div className="mt-2">
                        <LedgerSearchSelect
                          groups={bankLedgerPickerGroups}
                          onChange={applyTallyBankLedgerSelection}
                          placeholder="Search bank accounts or all Tally ledgers"
                          value={bankLedgerName}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
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
                      {!tallyCheckAttempted && validTransactions.length > 0 ? (
                        <button
                          aria-pressed={statementDirectionsSwapped}
                          className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[10px] font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 ${
                            statementDirectionsSwapped
                              ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                              : "border-[#e5ddd0] bg-white text-[#5a5046] hover:border-amber-300 hover:bg-amber-50 hover:text-amber-900"
                          }`}
                          disabled={matchingBills || sending || tallyPostingInProgress}
                          onClick={swapStatementPaymentAndReceipt}
                          title="Swap every statement row between the Payment and Receipt columns before checking Tally"
                          type="button"
                        >
                          <ArrowLeftRight className="h-3.5 w-3.5" />
                          {statementDirectionsSwapped ? "Undo Payment / Receipt" : "Swap Payment / Receipt"}
                        </button>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[#e5ddd0] bg-[#faf8f4]/70 px-3 py-1.5 text-[10px] font-bold">
                      {receiptPostingCompleted ? (
                        <>
                          <span className="inline-flex items-center gap-1.5 text-emerald-800">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {verifiedReceiptCount} receipt{verifiedReceiptCount === 1 ? "" : "s"} verified
                          </span>
                          {missingOutgoingCount > 0 ? (
                            <span className="inline-flex items-center gap-1.5 text-amber-800">
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                              {missingOutgoingCount} payment{missingOutgoingCount === 1 ? "" : "s"} not found in Tally
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-emerald-800">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              No payment review needed
                            </span>
                          )}
                        </>
                      ) : uncheckedTallyPresenceCount === 0 ? (
                        <>
                          <span className="inline-flex items-center gap-1.5 text-emerald-800">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            {alreadyInTallyCount} in Tally
                          </span>
                          <span className="inline-flex items-center gap-1.5 text-blue-800">
                            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                            {newReceiptCount} new receipt{newReceiptCount === 1 ? "" : "s"}
                          </span>
                          <span className="inline-flex items-center gap-1.5 text-rose-800">
                            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                            {missingOutgoingCount} payment{missingOutgoingCount === 1 ? "" : "s"} missing
                          </span>
                          {ambiguousTallyPresenceCount > 0 ? (
                            <span className="inline-flex items-center gap-1.5 text-amber-800">
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                              {ambiguousTallyPresenceCount} match review
                            </span>
                          ) : null}
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
                    <div className="mt-3.5 rounded-xl border border-[#e5ddd0] bg-[#faf8f4]/60 p-4">
                      <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-4 xl:items-end">
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            Work status
                          </span>
                          <select
                            className="mt-1.5 h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewWorkStatusFilter(event.target.value as ReviewWorkStatusFilter)}
                            title="Needs action contains only unresolved close ledger matches."
                            value={reviewWorkStatusFilter}
                          >
                            <option value="all">All transactions ({validTransactions.length})</option>
                            <option value="needs_action">Needs action - close matches ({reviewWorkStatusCounts.needsAction})</option>
                            <option value="ready">Ready ({reviewWorkStatusCounts.ready})</option>
                            <option value="completed">Completed ({reviewWorkStatusCounts.completed})</option>
                          </select>
                        </label>
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            Search
                          </span>
                          <div className="relative mt-1.5">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <input
                              className="h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 pl-9 text-xs font-semibold text-[#1a1a1a] outline-none placeholder:text-slate-400 focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                              onChange={(event) => setReviewSearch(event.target.value)}
                              placeholder="Narration, amount, ledger, reference..."
                              ref={reviewSearchInputRef}
                              value={reviewSearch}
                            />
                          </div>
                        </label>
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            Tally result
                          </span>
                          <select
                            className="mt-1.5 h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewTallyResultFilter(event.target.value as ReviewTallyResultFilter)}
                            value={reviewTallyResultFilter}
                          >
                            <option value="all">All Tally results</option>
                            <option value="pending">Check pending</option>
                            <option value="found">Found in Tally</option>
                            <option value="missing">Not found in Tally</option>
                            <option value="review">Ambiguous or duplicate</option>
                            <option value="failed">Failed or cannot check</option>
                          </select>
                        </label>
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            Ledger review
                          </span>
                          <select
                            className="mt-1.5 h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewLedgerFilter(event.target.value as ReviewLedgerFilter)}
                            value={reviewLedgerFilter}
                          >
                            <option value="all">All ledger reviews</option>
                            <option value="needs_action">Close match needs action</option>
                            <option value="automatic">Matched automatically</option>
                            <option value="manual">Confirmed manually</option>
                            <option value="suspense">Suspense / no match</option>
                          </select>
                        </label>
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            Payment / receipt
                          </span>
                          <select
                            className="mt-1.5 h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewDirectionFilter(event.target.value as ReviewDirectionFilter)}
                            value={reviewDirectionFilter}
                          >
                            <option value="all">Payments and receipts</option>
                            <option value="debit">Payments only</option>
                            <option value="credit">Receipts only</option>
                          </select>
                        </label>
                        <label className="block xl:col-span-2">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            Statement period
                          </span>
                          <div className="mt-1.5 grid grid-cols-2 gap-2">
                            <div className="relative">
                              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                              <input
                                aria-label="Statement period from"
                                className="h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 pl-9 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                                onChange={(event) => setReviewDateFrom(event.target.value)}
                                ref={reviewPeriodInputRef}
                                type="date"
                                value={reviewDateFrom}
                              />
                            </div>
                            <div className="relative">
                              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                              <input
                                aria-label="Statement period to"
                                className="h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 pl-9 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                                onChange={(event) => setReviewDateTo(event.target.value)}
                                type="date"
                                value={reviewDateTo}
                              />
                            </div>
                          </div>
                        </label>
                        {tallyCheckAttempted ? (
                          <label className="block">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              Receipt allocation
                            </span>
                            <select
                              className="mt-1.5 h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
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
                        <button
                          className="h-9 rounded-xl border border-[#e5ddd0] bg-white px-4 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all"
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
                          Reset all
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="max-h-[calc(100vh-390px)] overflow-auto [scrollbar-gutter:stable]">
                  <table className="w-full min-w-[940px] table-fixed border-collapse text-left">
                    <thead className="sticky top-0 z-20">
                      <tr className="border-b border-[#e5ddd0] bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        <th className="w-20 px-3 py-3.5">Date</th>
                        <th className="w-[29%] px-3 py-3.5">Transaction</th>
                        <th className="w-24 px-3 py-3.5 text-right">Payment</th>
                        <th className="w-24 px-3 py-3.5 text-right">Receipt</th>
                        <th className="w-[22%] px-3 py-3.5">Tally ledger</th>
                        <th className="w-32 px-3 py-3.5">Ledger status</th>
                        <th className="w-44 px-3 py-3.5">Tally result</th>
                        <th className="w-12 px-2 py-3.5" aria-label="Row actions"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#e5ddd0] text-xs font-semibold text-slate-600">
                      {validTransactions.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-6 py-12 text-center text-xs font-semibold text-slate-400">
                            No posting rows were extracted. Upload another file or add rows after extraction support improves.
                          </td>
                        </tr>
                      ) : visibleReviewTransactions.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-6 py-12 text-center text-xs font-semibold text-slate-400">
                            No rows match the current filters.
                          </td>
                        </tr>
                      ) : (
                        visibleReviewTransactions.map((transaction) => {
                          const debit = formatAmount(transaction.debitAmount);
                          const credit = formatAmount(transaction.creditAmount);
                          const partyTitle = getTransactionPartyTitle(transaction);
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
                          const outgoingPayment = isOutgoingPaymentRow(transaction);
                          const ledgerMatchStatus = getReviewStatusLabel(transaction);
                          const ledgerMatchStatusClass = getReviewStatusClass(transaction);

                          return (
                            <tr
                              aria-selected={activeReviewTransactionId === transaction.id}
                              className={`align-middle transition-colors ${
                                activeReviewTransactionId === transaction.id
                                  ? "bg-amber-50/70 shadow-[inset_3px_0_0_#f59e0b]"
                                  : "hover:bg-[#fcfbfa]/60"
                              }`}
                              key={transaction.id}
                              onMouseDown={() => setActiveReviewTransactionId(transaction.id)}
                              ref={(node) => {
                                if (node) reviewRowRefs.current.set(transaction.id, node);
                                else reviewRowRefs.current.delete(transaction.id);
                              }}
                            >
                              <td className="px-3 py-4 text-xs font-bold text-slate-500">
                                {formatShortDate(transaction.transactionDate)}
                              </td>
                              <td className="px-3 py-4 align-top">
                                <div className="whitespace-normal break-words text-sm font-bold leading-5 text-[#1a1a1a]" title={partyTitle}>
                                  {partyTitle}
                                </div>
                                <div className="mt-0.5 line-clamp-2 whitespace-normal break-words text-xs font-semibold leading-4 text-slate-500" title={transaction.description}>
                                  {transaction.description || "Narration not found"}
                                </div>
                                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-bold">
                                  <span className="shrink-0 text-[#1a1a1a]">{mode || "-"}</span>
                                  <span className="min-w-0 truncate text-slate-500" title={reference}>{reference || "-"}</span>
                                </div>
                              </td>
                              <td className="px-3 py-4 text-right text-sm font-extrabold text-red-600">
                                {debit || "-"}
                              </td>
                              <td className="px-3 py-4 text-right text-sm font-extrabold text-emerald-700">
                                {credit || "-"}
                              </td>
                              <td
                                className={`px-3 py-4 align-top ${
                                  !showLedgerSelect && !statementReviewLocked
                                    ? "cursor-pointer outline-none transition hover:bg-[#fbf7f1] focus-visible:bg-[#fbf7f1] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-300"
                                    : ""
                                }`}
                                onClick={() => {
                                  if (showLedgerSelect || statementReviewLocked) return;
                                  setEditingLedgerIds(new Set([transaction.id]));
                                }}
                                onKeyDown={(event) => {
                                  if (showLedgerSelect || statementReviewLocked) return;
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
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
                                    <span className="block line-clamp-2 whitespace-normal break-words text-sm font-bold leading-5 text-[#1a1a1a]" title={ledgerDisplayName}>
                                      {ledgerDisplayName}
                                    </span>
                                    <span className="mt-0.5 block truncate text-xs font-semibold leading-4 text-slate-500">
                                      {getLedgerGroupLabel(transaction, ledgerMasters)}
                                    </span>
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-4 align-middle">
                                <span className={`inline-flex min-h-5 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide ${ledgerMatchStatusClass}`}>
                                  {ledgerMatchStatus}
                                </span>
                              </td>
                              <td className="px-3 py-4">
                                {tallyPresence?.status === "found" ? (
                                  <button
                                    className="inline-flex min-w-0 max-w-full flex-col items-start gap-1 rounded-xl border border-transparent px-2 py-1.5 text-left transition hover:border-[#e5ddd0] hover:bg-[#faf8f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
                                    onClick={() => setOutgoingReviewTransactionId(transaction.id)}
                                    title="View matching Tally voucher details"
                                    type="button"
                                  >
                                    <span className={`inline-flex min-h-5 self-start items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide ${
                                      tallyPresence.duplicateInTally
                                        ? "border-amber-250 bg-amber-50 text-amber-800"
                                        : "border-emerald-250 bg-emerald-50 text-emerald-800"
                                    }`}>
                                      {tallyPresence.duplicateInTally ? "Already posted - duplicates" : "Already in Tally"}
                                    </span>
                                    <span className="block max-w-full truncate text-[10px] font-semibold leading-4 text-slate-500" title={tallyPresence.reason}>
                                      {tallyPresence.duplicateInTally
                                        ? `Tally vouchers ${tallyPresence.matches?.map((match) => match.voucherNumber).filter(Boolean).join(", ") || "need review"}`
                                        : tallyPresence.voucherNumber
                                          ? `Voucher ${tallyPresence.voucherNumber}`
                                          : "Unique live match"}
                                    </span>
                                  </button>
                                ) : outgoingPayment ? (
                                  <button
                                    className={`inline-flex min-w-0 max-w-full flex-col items-start gap-1 rounded-xl border border-transparent px-2 py-1.5 text-left transition ${
                                      statementReviewDrawerLocked ? "cursor-default" : "hover:border-[#e5ddd0] hover:bg-[#faf8f4]"
                                    }`}
                                    onClick={() => {
                                      if (!statementReviewDrawerLocked) setOutgoingReviewTransactionId(transaction.id);
                                    }}
                                    title="Review outgoing payment check"
                                    type="button"
                                  >
                                    <span
                                      className={`inline-flex min-h-5 self-start items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide ${getOutgoingVerificationClass(outgoingVerification)}`}
                                    >
                                      {getOutgoingVerificationLabel(outgoingVerification)}
                                    </span>
                                    <span
                                      className="block max-w-full truncate text-[10px] font-semibold leading-4 text-slate-500"
                                      title={outgoingVerification?.reason}
                                    >
                                      {getOutgoingVerificationSubtext(outgoingVerification)}
                                    </span>
                                  </button>
                                ) : (
                                  <button
                                    className={`inline-flex min-w-0 max-w-full flex-col items-start gap-1 rounded-xl border border-transparent px-2 py-1.5 text-left transition ${
                                      statementReviewDrawerLocked ? "cursor-default" : "hover:border-[#e5ddd0] hover:bg-[#faf8f4]"
                                    }`}
                                    onClick={() => {
                                      if (!statementReviewDrawerLocked) setBillAllocationReviewTransactionId(transaction.id);
                                    }}
                                    title="Review bill allocation"
                                    type="button"
                                  >
                                    <span
                                      className={`inline-flex min-h-5 self-start items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide ${getBillAllocationBadgeClass(transaction, ledgerMasters, billAllocation)}`}
                                    >
                                      {getBillAllocationBadgeText(transaction, ledgerMasters, billAllocation)}
                                    </span>
                                    {billAllocation?.caseLabel && billAllocation.status === "ready_to_post" ? (
                                      <span className="block max-w-full truncate text-[10px] font-semibold leading-4 text-slate-500" title={billAllocation.reason}>
                                        {billAllocation.caseLabel}
                                      </span>
                                    ) : null}
                                  </button>
                                )}
                              </td>
                              <td className="px-2 py-4 text-right align-top">
                                <button
                                  data-ledger-editor-toggle
                                  className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition ${
                                    isEditingLedger
                                      ? "bg-[#2d2d2d] text-white hover:bg-[#1a1a1a]"
                                      : "border border-[#e5ddd0] bg-white text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a]"
                                  }`}
                                  onClick={() =>
                                    setEditingLedgerIds((current) => {
                                      const next = new Set(current);
                                       if (next.has(transaction.id)) next.delete(transaction.id);
                                       else return new Set([transaction.id]);
                                       return next;
                                    })
                                  }
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

                <div className="flex flex-col gap-3 border-t border-[#e5ddd0] px-5 py-4 text-xs font-semibold text-slate-400 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <span>Rows per page</span>
                    <select
                      className="h-8.5 rounded-xl border border-[#e5ddd0] bg-white px-3.5 text-xs font-bold text-[#5a5046] outline-none focus:border-amber-500"
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
                  <div className="flex flex-wrap items-center gap-3">
                    <span>
                      Showing {reviewRangeStart}-{reviewRangeEnd} of {filteredTransactions.length}
                      {ignoredStatementRowCount > 0
                        ? ` (${ignoredStatementRowCount} statement header/summary row${ignoredStatementRowCount === 1 ? "" : "s"} ignored)`
                        : ""}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-xl border border-[#e5ddd0] bg-white px-3 py-2 text-xs font-bold text-[#5a5046] transition hover:bg-[#faf8f4] disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={reviewPage <= 1}
                        onClick={() => setReviewPage((current) => Math.max(1, current - 1))}
                        type="button"
                      >
                        Previous
                      </button>
                      <span className="text-xs font-bold text-slate-500">
                        Page {reviewPage} of {reviewPageCount}
                      </span>
                      <button
                        className="rounded-xl border border-[#e5ddd0] bg-white px-3 py-2 text-xs font-bold text-[#5a5046] transition hover:bg-[#faf8f4] disabled:cursor-not-allowed disabled:opacity-50"
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
                    className="absolute inset-0 cursor-default"
                    onClick={() => setBillAllocationReviewTransactionId(null)}
                    type="button"
                  />
                  <aside className="relative flex h-full w-full max-w-[720px] flex-col border-l border-[#e5ddd0] bg-[#fcfbfa] shadow-2xl">
                    <div className="flex items-start justify-between border-b border-[#e5ddd0] bg-white px-5 py-4">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Bill Allocation
                        </div>
                        <h2 className="mt-1 text-xl font-extrabold text-[#1a1a1a]">
                          {getTransactionPartyTitle(billAllocationReviewTransaction)}
                        </h2>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
                          <span>
                            {formatShortDate(billAllocationReviewTransaction.transactionDate)}
                          </span>
                          <span>-</span>
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
                              <span>-</span>
                              <span>{getTransactionReference(billAllocationReviewTransaction)}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <button
                        className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                        onClick={() => setBillAllocationReviewTransactionId(null)}
                        title="Close"
                        type="button"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                      <div className="hidden grid gap-3 sm:grid-cols-2">
                        {[
                          ["Bank Date", formatShortDate(billAllocationReviewTransaction.transactionDate)],
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
                            <div className="mt-1 text-sm font-extrabold text-[#1a1a1a]">{value}</div>
                          </div>
                        ))}
                      </div>

                      {!billAllocationReviewDraft ? (
                        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
                          Match bills first. This row has no allocation draft yet.
                        </div>
                      ) : (
                        <>
                          <div className="mt-1 grid gap-3 sm:grid-cols-3">
                            {[
                              ["Received", billAllocationReviewDraft.receiptAmount],
                              ["Bills", billAllocationReviewDraft.totalAllocatedAmount - billAllocationReviewDraft.newAdvanceAmount],
                              ["Advance", billAllocationReviewDraft.newAdvanceAmount],
                            ].map(([label, value]) => (
                              <div key={label} className="rounded-xl border border-[#e5ddd0] bg-white px-4 py-3 shadow-[0_2px_8px_rgba(0,0,0,0.01)]">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                  {label}
                                </div>
                                <div className="mt-1 text-sm font-extrabold text-[#1a1a1a]">
                                  {formatCurrencyAmount(value as number)}
                                </div>
                              </div>
                            ))}
                          </div>

                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${getBillAllocationClass(billAllocationReviewDraft)}`}>
                              {getBillAllocationLabel(billAllocationReviewDraft)}
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-full border border-[#e5ddd0] bg-white px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                              {billAllocationReviewDraft.caseLabel}
                            </span>
                          </div>

                          <section className="hidden mt-6">
                            <h3 className="text-sm font-bold text-[#1a1a1a]">Proposed Allocation</h3>
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

                          <section className="mt-5">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <h3 className="text-sm font-bold text-[#1a1a1a]">Allocate receipt</h3>
                              <div className="flex flex-wrap items-center justify-end gap-2">
                                {billAllocationReviewDraft.candidateBills.length === 0 &&
                                Math.abs(billAllocationReviewDraft.newAdvanceAmount - billAllocationReviewDraft.receiptAmount) >= 0.01 ? (
                                  <Button
                                    className="h-8 rounded-lg border-emerald-200 bg-emerald-50 px-3 text-[11px] font-bold text-emerald-800 hover:bg-emerald-100"
                                    onClick={() => recordEntireReceiptAsAdvance(billAllocationReviewTransaction)}
                                    type="button"
                                    variant="outline"
                                  >
                                    Record full receipt as advance
                                  </Button>
                                ) : null}
                                <span
                                  className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                    Math.abs(billAllocationReviewDraft.unallocatedAmount) < 0.01
                                      ? "border-emerald-250 bg-emerald-50 text-emerald-800"
                                      : "border-amber-250 bg-amber-50 text-amber-800"
                                  }`}
                                >
                                  {Math.abs(billAllocationReviewDraft.unallocatedAmount) < 0.01
                                    ? "Balanced"
                                    : `${formatCurrencyAmount(billAllocationReviewDraft.unallocatedAmount)} left`}
                                </span>
                              </div>
                            </div>
                            <div className="mt-2 overflow-x-auto rounded-xl border border-[#e5ddd0] bg-white">
                              <table className="w-full min-w-[460px] text-left text-xs">
                                <thead className="bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                  <tr>
                                    <th className="px-4 py-3">Bill Reference</th>
                                    <th className="px-4 py-3 text-right">Pending</th>
                                    <th className="px-4 py-3 text-right">Allocate</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-[#e5ddd0] text-slate-600 font-semibold">
                                  {billAllocationReviewDraft.candidateBills.length === 0 ? (
                                    <tr>
                                      <td className="px-4 py-4 text-center font-semibold text-slate-400" colSpan={3}>
                                        No open bills returned by Tally.
                                      </td>
                                    </tr>
                                  ) : (
                                    billAllocationReviewDraft.candidateBills.map((bill) => {
                                      const currentAmount =
                                        billAllocationReviewDraft.allocations.find(
                                          (line) => line.referenceType === "Agst Ref" && line.referenceName === bill.referenceName
                                        )?.allocatedAmount ?? 0;

                                      return (
                                        <tr key={bill.referenceName}>
                                          <td className="px-4 py-3 font-bold text-[#1a1a1a]">{bill.referenceName}</td>
                                          <td className="px-4 py-3 text-right">{formatCurrencyAmount(bill.pendingAmount)}</td>
                                          <td className="px-4 py-3 text-right">
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
                                        </tr>
                                      );
                                    })
                                  )}
                                  <tr>
                                    <td className="px-4 py-3 font-bold text-[#1a1a1a]">New Advance</td>
                                    <td className="px-4 py-3 text-right">-</td>
                                    <td className="px-4 py-3 text-right">
                                      <CurrencyAmountInput
                                        min={0}
                                        onChange={(value) =>
                                          updateManualAdvanceAmount(billAllocationReviewTransaction, value)
                                        }
                                        value={billAllocationReviewDraft.newAdvanceAmount}
                                      />
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </section>

                          {billAllocationReviewDraft.existingAdvances.length > 0 ? (
                            <section className="mt-6">
                              <h3 className="text-sm font-bold text-[#1a1a1a]">Existing Advances</h3>
                              <div className="mt-2 overflow-x-auto rounded-xl border border-[#e5ddd0] bg-white">
                                <table className="w-full min-w-[420px] text-left text-xs">
                                  <thead className="bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                    <tr>
                                      <th className="px-4 py-3">Advance Ref</th>
                                      <th className="px-4 py-3">Date</th>
                                      <th className="px-4 py-3 text-right">Pending Advance</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-[#e5ddd0] text-slate-600 font-semibold">
                                    {billAllocationReviewDraft.existingAdvances.map((advance) => (
                                      <tr key={advance.referenceName}>
                                        <td className="px-4 py-3 font-bold text-[#1a1a1a]">{advance.referenceName}</td>
                                        <td className="px-4 py-3">
                                          {advance.receiptDate ? formatShortDate(advance.receiptDate) : "-"}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                          {formatCurrencyAmount(advance.pendingAdvanceAmount)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <p className="mt-2 text-xs font-semibold text-slate-400">
                                Existing advances are shown for information only. They will not be auto-adjusted in this flow.
                              </p>
                            </section>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e5ddd0] bg-white px-5 py-4">
                      <span className="text-xs font-semibold text-slate-500">
                        Changes are saved automatically.
                      </span>
                      <Button
                        className="bg-[#2d2d2d] text-white text-xs font-bold hover:bg-[#1a1a1a] shadow-sm transition-all rounded-xl h-10"
                        onClick={() => setBillAllocationReviewTransactionId(null)}
                        type="button"
                      >
                        Done
                      </Button>
                    </div>
                  </aside>
                </div>
              ) : null}

              {outgoingReviewTransaction ? (
                <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
                  <button
                    aria-label="Close Tally match details"
                    className="absolute inset-0 cursor-default"
                    onClick={() => setOutgoingReviewTransactionId(null)}
                    type="button"
                  />
                  <aside className="relative flex h-full w-full max-w-[680px] flex-col border-l border-[#e5ddd0] bg-[#fcfbfa] shadow-2xl">
                    <div className="flex items-start justify-between border-b border-[#e5ddd0] bg-white px-5 py-4">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          {tallyResultReviewDraft?.status === "found" || tallyResultReviewDraft?.status === "ambiguous"
                            ? "Tally Match Details"
                            : tallyResultReviewIsIncoming
                              ? "Receipt Check"
                              : "Payment Check"}
                        </div>
                        <h2 className="mt-1 text-xl font-extrabold text-[#1a1a1a]">
                          {getTransactionPartyTitle(outgoingReviewTransaction)}
                        </h2>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
                          <span>{formatShortDate(outgoingReviewTransaction.transactionDate)}</span>
                          <span>-</span>
                          <span>{formatCurrencyAmount(tallyResultReviewAmount)}</span>
                          {getTransactionReference(outgoingReviewTransaction) ? (
                            <>
                              <span>-</span>
                              <span>{getTransactionReference(outgoingReviewTransaction)}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <button
                        className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                        onClick={() => setOutgoingReviewTransactionId(null)}
                        title="Close"
                        type="button"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                      <div className="mb-4 grid gap-3 rounded-xl border border-[#e5ddd0] bg-white p-4 sm:grid-cols-2">
                        {[
                          ["Bank Date", formatShortDate(outgoingReviewTransaction.transactionDate)],
                          ["Amount", formatCurrencyAmount(tallyResultReviewAmount)],
                          ["UTR / Ref", getTransactionReference(outgoingReviewTransaction) || "-"],
                          ["Matched Ledger", outgoingReviewTransaction.selectedLedgerName || "-"],
                          ["Ledger Group", getLedgerGroupLabel(outgoingReviewTransaction, ledgerMasters)],
                          ["Bank Ledger", bankLedgerName || "-"],
                        ].map(([label, value]) => (
                          <div key={label} className="border-b border-[#e5ddd0] pb-2">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              {label}
                            </div>
                            <div className="mt-1 text-sm font-extrabold text-[#1a1a1a]">{value}</div>
                          </div>
                        ))}
                      </div>

                      <div className="rounded-xl border border-[#e5ddd0] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,0.01)]">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${getOutgoingVerificationClass(tallyResultReviewDraft)}`}>
                              {getOutgoingVerificationLabel(tallyResultReviewDraft)}
                            </span>
                            {tallyResultReviewDraft?.status === "found" && !tallyResultReviewDraft.duplicateInTally ? (
                              <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                                No action required
                              </span>
                            ) : null}
                          </div>
                          <span className="text-xs font-semibold text-slate-400">
                            Ledger: {outgoingReviewTransaction.selectedLedgerName || "-"}
                          </span>
                        </div>
                        <p className="mt-3 text-sm leading-6 text-slate-600">
                          {tallyResultReviewReason}
                        </p>
                      </div>

                      <section className={tallyResultReviewEvidence.length ? "mt-5" : "hidden"}>
                        <div className="flex flex-wrap items-end justify-between gap-2">
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              Tally evidence
                            </div>
                            <h3 className="mt-1 text-sm font-bold text-[#1a1a1a]">
                              {tallyResultReviewDraft?.status === "found"
                                ? tallyResultReviewDraft.duplicateInTally
                                  ? "Matching Tally vouchers"
                                  : "Matched Tally voucher"
                                : "Possible Tally vouchers"}
                            </h3>
                          </div>
                          {tallyResultReviewDraft?.status === "found" ? (
                            <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                              tallyResultReviewDraft.duplicateInTally
                                ? "border-amber-200 bg-amber-50 text-amber-800"
                                : "border-emerald-200 bg-emerald-50 text-emerald-800"
                            }`}>
                              {tallyResultReviewDraft.duplicateInTally ? "Posted with duplicates" : "Verified match"}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 space-y-3">
                          {tallyResultReviewEvidence.length ? (
                            tallyResultReviewEvidence.map((match, index) => (
                              <div
                                key={`${match.masterId || match.voucherNumber || index}`}
                                className="rounded-xl border border-[#e5ddd0] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,0.01)]"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <div className="text-sm font-bold text-[#1a1a1a]">
                                      {match.voucherNumber
                                        ? `Voucher ${match.voucherNumber}`
                                        : match.masterId
                                          ? `Voucher ${match.masterId}`
                                          : `Candidate ${index + 1}`}
                                    </div>
                                    <div className="mt-1 text-xs font-semibold text-slate-400">
                                      {[match.voucherType, match.date ? formatShortDate(match.date) : null, match.reference]
                                        .filter(Boolean)
                                        .join(" - ") || "Voucher details from Tally"}
                                    </div>
                                  </div>
                                  {typeof match.score === "number" ? (
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e5ddd0] bg-[#faf8f4] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                                      Score: {match.score}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-4 grid gap-2 sm:grid-cols-2 border-t border-slate-100 pt-3">
                                  <div>
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                      Party / Ledger
                                    </div>
                                    <div className="mt-1 text-xs font-extrabold text-[#1a1a1a]">
                                      {match.partyLedgerName || match.ledgerNames[0] || "-"}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                      Why it matched
                                    </div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {match.reasons.length ? (
                                        match.reasons.map((reason) => (
                                          <span
                                            key={reason}
                                            className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800"
                                          >
                                            {reason}
                                          </span>
                                        ))
                                      ) : (
                                        <span className="text-xs font-semibold text-slate-400">
                                          Unique voucher returned by the live Tally check
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="rounded-xl border border-[#e5ddd0] bg-white px-4 py-5 text-sm font-semibold text-slate-400 text-center">
                              No candidate vouchers returned by Tally.
                            </div>
                          )}
                        </div>
                      </section>
                    </div>
                  </aside>
                </div>
              ) : null}

              <div className="fixed bottom-2 left-2 right-2 z-40 rounded-xl border border-[#ddd3c5] bg-white/95 px-3 py-2 shadow-[0_8px_24px_rgba(49,39,26,0.12)] backdrop-blur-xl sm:left-[232px]">
                <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
                  <div className="contents text-[11px] font-bold">
                    <span className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] font-bold ${newReceiptCount > 0 && !statementCompletedCleanly ? "border-blue-200 bg-blue-50 text-blue-800" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                    {matchingBills
                      ? "Checking statement"
                      : statementCompletedCleanly
                        ? tallyPostingStatus?.voucherTotal
                          ? "Posted & verified"
                          : "Verified in Tally"
                      : uncheckedTallyPresenceCount > 0
                        ? "Tally check pending"
                      : newReceiptCount > 0
                        ? `${newReceiptCount} receipt${newReceiptCount === 1 ? "" : "s"} ready to post`
                        : "Nothing to post"}
                    </span>
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
                          Receipt posting {tallyPostingStatus.voucherCompleted}/{tallyPostingStatus.voucherTotal}
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
                            ? "Creating receipt vouchers"
                            : "Checking outgoing payments only"}
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
                          validTransactions.length === 0
                        }
                        type="button"
                        variant="outline"
                      >
                        {matchingBills ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        Check Tally Matches ({validTransactions.length})
                      </Button>
                      {newReceiptCount > 0 ? (
                        <Button
                          className={`h-8 flex-1 rounded-lg px-3 text-[10px] font-bold shadow-sm transition-all sm:flex-none ${
                            billAllocationReviewIsNextAction
                              ? "border border-amber-250 bg-amber-50 text-amber-900 hover:bg-amber-100"
                              : "bg-[#2d2d2d] text-white hover:bg-[#1a1a1a]"
                          }`}
                          onClick={() => {
                            if (billAllocationReviewIsNextAction && firstBlockingReceiptBillAllocationTransaction) {
                              setBillAllocationReviewTransactionId(firstBlockingReceiptBillAllocationTransaction.id);
                              return;
                            }
                            void sendToTally("post_receipts");
                          }}
                          disabled={
                            sending ||
                            matchingBills ||
                            tallyPostingInProgress ||
                            validTransactions.length === 0 ||
                            pendingLedgerReviewCount > 0 ||
                            uncheckedTallyPresenceCount > 0 ||
                            ambiguousTallyPresenceCount > 0 ||
                            (!bankLedgerVerified && !bankLedgerManuallyConfirmed)
                          }
                          type="button"
                        >
                          {sendingMode === "post_receipts" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : billAllocationReviewIsNextAction ? (
                            <Pencil className="h-3.5 w-3.5" />
                          ) : (
                            <ArrowRight className="h-3.5 w-3.5" />
                          )}
                          {postReceiptsButtonLabel}
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </AppShell>
  );
}
