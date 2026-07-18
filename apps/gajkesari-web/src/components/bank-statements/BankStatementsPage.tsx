"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Filter,
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

function uniqueCompanyOptions(options: CompanyOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.companyName.trim().toLowerCase()}::${option.financialYear.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatCompanyOptionLabel(company: CompanyOption) {
  return [company.companyName, company.financialYear].filter(Boolean).join(" - ");
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
  action: LedgerRecommendationAction;
  ledgerName: string | null;
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
  scannedCount?: number | null;
  matches?: OutgoingMatchCandidate[];
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

function findCloseLedgerMatches(
  ledgerMasters: TallyMaster[],
  ledgerName?: string | null,
  threshold = 0.84
) {
  const compactName = compactLedgerName(ledgerName);
  if (compactName.length < 5) return [];

  const matches: Array<{ ledger: TallyMaster; score: number }> = [];
  for (const ledger of ledgerMasters) {
    if (normalizeName(ledger.name) === normalizeName(ledgerName)) continue;
    const score = ledgerNameSimilarity(ledgerName ?? "", ledger.name);
    if (score < threshold) continue;
    matches.push({ ledger, score });
  }

  return matches.sort((left, right) => right.score - left.score || left.ledger.name.localeCompare(right.ledger.name));
}

function findUniqueCloseLedgerMatch(
  ledgerMasters: TallyMaster[],
  ledgerName?: string | null,
  threshold = 0.84
) {
  const matches = findCloseLedgerMatches(ledgerMasters, ledgerName, threshold);
  return matches.length === 1 ? matches[0] : null;
}

function findLedgerByNormalizedName(ledgerMasters: TallyMaster[], ledgerName?: string | null) {
  const normalizedLedgerName = normalizeName(ledgerName);
  if (!normalizedLedgerName) return null;

  return (
    ledgerMasters.find((ledger) => normalizeName(ledger.name) === normalizedLedgerName) ?? null
  );
}

function findLedgerByCandidates(ledgerMasters: TallyMaster[], candidates: string[]) {
  for (const candidate of candidates) {
    const ledger = findLedgerByNormalizedName(ledgerMasters, candidate);
    if (ledger) return ledger;
  }
  return null;
}

function findUniqueCloseLedgerMatchByCandidates(ledgerMasters: TallyMaster[], candidates: string[]) {
  const matchesByLedger = new Map<string, { ledger: TallyMaster; score: number }>();

  for (const candidate of candidates) {
    for (const match of findCloseLedgerMatches(ledgerMasters, candidate)) {
      const key = normalizeName(match.ledger.name);
      const existing = matchesByLedger.get(key);
      if (!existing || match.score > existing.score) {
        matchesByLedger.set(key, match);
      }
    }
  }

  const matches = Array.from(matchesByLedger.values()).sort(
    (left, right) => right.score - left.score || left.ledger.name.localeCompare(right.ledger.name)
  );
  return matches.length === 1 ? matches[0] : null;
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
  const recommendedLedgerName = recommendation?.ledgerName || suggestedLedgerName || fallbackReviewLedgerName(transaction);
  const suspenseLedger = findLedgerByNormalizedName(ledgerMasters, "Suspense");
  const suspenseName = suspenseLedger?.name || "Suspense";
  const confirmedLedger = findLedgerByNormalizedName(ledgerMasters, transaction.confirmedLedgerName);
  const confirmedSuspenseLedger = confirmedLedger && isSuspenseLedgerName(confirmedLedger.name) ? confirmedLedger : null;
  const confirmedMappedLedger = confirmedLedger && !isSuspenseLedgerName(confirmedLedger.name) ? confirmedLedger : null;
  const ledgerCandidates = ledgerNameCandidateVariants(
    recommendedLedgerName,
    transaction.counterpartyName,
    transaction.description
  );
  const standardLedger = findLedgerByNormalizedName(ledgerMasters, standardLedgerNameForTransaction(transaction));
  const matchedLedger = findLedgerByCandidates(ledgerMasters, ledgerCandidates);
  const closeLedgerMatch = !matchedLedger
    ? findUniqueCloseLedgerMatchByCandidates(ledgerMasters, ledgerCandidates)
    : null;
  const reviewSuggestedLedgerName = closeLedgerMatch
    ? closeLedgerMatch?.ledger.name || recommendedLedgerName
    : recommendedLedgerName;
  const selectedLedgerName =
    confirmedMappedLedger?.name ||
    standardLedger?.name ||
    matchedLedger?.name ||
    closeLedgerMatch?.ledger.name ||
    confirmedSuspenseLedger?.name ||
    suspenseName;
  const ledgerAction: LedgerRecommendationAction = confirmedMappedLedger
    ? "use_existing_ledger"
    : standardLedger
    ? "use_standard_ledger"
    : closeLedgerMatch
    ? "use_existing_ledger"
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
    suggestionReason: closeLedgerMatch
      ? `Single close Tally ledger match found: ${closeLedgerMatch.ledger.name}.`
      : ledgerAction === "use_suspense" && !matchedLedger
        ? "No matching Tally ledger was found. This row will go to Suspense unless changed."
        : recommendation?.reason || transaction.suggestionReason || "",
    selectedLedgerName,
    ledgerAction,
    ledgerGroup: recommendation?.ledgerGroup || "",
    requiresUserConfirmation: false,
    ledgerSelectionTouched: false,
  };
}

function autoMatchUntouchedLedgerSelection(transaction: ReviewTransaction, ledgerMasters: TallyMaster[]) {
  if (transaction.ledgerSelectionTouched) return transaction;

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
    ) ||
    findUniqueCloseLedgerMatchByCandidates(
      ledgerMasters,
      ledgerNameCandidateVariants(transaction.suggestedLedgerName, transaction.counterpartyName, transaction.description)
    )?.ledger;

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

function transactionIsValid(transaction: ReviewTransaction) {
  return Boolean(transaction.transactionDate && transaction.description.trim() && transactionHasPostingAmount(transaction));
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

function maskAccountNumber(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalized) return "";
  if (normalized.length <= 4) return normalized;
  return `${"*".repeat(Math.max(0, normalized.length - 4))}${normalized.slice(-4)}`;
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

function getLedgerCandidateName(transaction: ReviewTransaction) {
  if (transaction.ledgerAction === "needs_review" && transaction.counterpartyName) {
    return transaction.counterpartyName.trim();
  }

  return (
    transaction.selectedLedgerName ||
    transaction.suggestedLedgerName ||
    transaction.counterpartyName ||
    ""
  ).trim();
}

function getCloseLedgerMatches(transaction: ReviewTransaction, ledgerMasters: TallyMaster[], limit = 5) {
  const searchTerms = [
    transaction.counterpartyName,
    transaction.suggestedLedgerName,
    transaction.category,
  ]
    .map((term) => String(term ?? "").trim())
    .filter((term) => compactLedgerName(term).length >= 4);

  const exactName = normalizeName(getLedgerCandidateName(transaction));
  const matches: Array<{ ledger: TallyMaster; score: number }> = [];

  for (const ledger of ledgerMasters) {
    const normalizedLedger = normalizeName(ledger.name);
    if (!normalizedLedger || normalizedLedger === exactName) continue;

    const score = searchTerms.reduce((current, term) => {
      const normalizedTerm = normalizeName(term);
      const fuzzyScore = ledgerNameSimilarity(term, ledger.name);
      if (normalizedLedger === normalizedTerm) return Math.max(current, 100);
      if (normalizedLedger.includes(normalizedTerm)) return Math.max(current, Math.min(90, normalizedTerm.length * 4));
      if (normalizedTerm.includes(normalizedLedger) && normalizedLedger.length >= 4) {
        return Math.max(current, Math.min(80, normalizedLedger.length * 4));
      }
      if (fuzzyScore >= 0.84) return Math.max(current, Math.round(fuzzyScore * 100));
      return current;
    }, 0);

    if (score > 0) matches.push({ ledger, score });
  }

  return matches
    .sort((left, right) => right.score - left.score || left.ledger.name.localeCompare(right.ledger.name))
    .slice(0, limit)
    .map(({ ledger }) => ledger.name);
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
  const suspenseLedger = ledgerMasters.find((ledger) => normalizeName(ledger.name) === "suspense");
  const suspenseName = suspenseLedger?.name || "Suspense";
  const currentLedger = findLedgerByNormalizedName(ledgerMasters, transaction.selectedLedgerName);
  const suggestedLedger = findLedgerByNormalizedName(ledgerMasters, transaction.suggestedLedgerName);
  const closeMatches = getCloseLedgerMatches(transaction, ledgerMasters);
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

  if (transaction.ledgerAction === "needs_review" || closeMatches.length > 0) {
    addGroup("Suggested matches", [
      ...(suggestedLedger
        ? [
            {
              name: suggestedLedger.name,
              action: "use_existing_ledger" as const,
              label: suggestedLedger.name,
              helper: transaction.requiresUserConfirmation
                ? "Close Tally ledger match. Review before using."
                : "Matched by extracted counterparty name.",
              badge: transaction.requiresUserConfirmation ? "Close" : "Suggested",
            },
          ]
        : []),
      ...closeMatches.map((name) => ({
        name,
        action: "use_existing_ledger" as const,
        label: name,
        helper: "Possible Tally ledger match.",
        badge: "Close",
      })),
    ]);
  }

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

  addGroup("Safe fallback", [
    {
      name: suspenseName,
      action: "use_suspense",
      label: "Put in Suspense",
      helper: "Use when the correct ledger is unclear.",
      badge: "Fallback",
    },
  ]);

  return groups;
}

function LedgerSearchSelect({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const uniqueOptions = useMemo(() => Array.from(new Set(options.filter(Boolean))), [options]);
  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeName(query);
    const matches = normalizedQuery
      ? uniqueOptions.filter((option) => normalizeName(option).includes(normalizedQuery))
      : uniqueOptions;

    return matches.slice(0, 60);
  }, [query, uniqueOptions]);

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a8d7f]" />
        <input
          className="h-10 w-full rounded-md border border-[#d8cbbb] bg-white px-3 pl-9 text-sm font-medium text-[#2b241d] outline-none transition placeholder:text-[#9a8d7f] focus:border-[#7c5f3f] focus:ring-2 focus:ring-[#7c5f3f]/10"
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          value={open ? query : value}
        />
      </div>

      {open ? (
        <div className="absolute z-30 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-[#d8cbbb] bg-white p-1 shadow-xl">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <button
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-semibold transition hover:bg-[#fbf4ea] ${
                  option === value ? "bg-[#f6efe6] text-[#4b3828]" : "text-[#2b241d]"
                }`}
                key={option}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(option);
                  setQuery("");
                  setOpen(false);
                }}
                type="button"
              >
                <span className="truncate">{option}</span>
                {option === value ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" /> : null}
              </button>
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
  return normalizeName(value) === "suspense";
}

function LedgerReviewSelect({
  transaction,
  ledgerMasters,
  onChange,
}: {
  transaction: ReviewTransaction;
  ledgerMasters: TallyMaster[];
  onChange: (selection: LedgerSelection) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{
    bottom?: number;
    left: number;
    maxHeight: number;
    top?: number;
    width: number;
  } | null>(null);
  const [query, setQuery] = useState("");
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
    setOpen(true);
  }

  const popover = open && popoverPosition ? (
    <div
      className="fixed z-[1000] overflow-auto rounded-xl border border-[#d8cbbb] bg-white p-1 shadow-2xl"
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
              return (
                <button
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-semibold transition hover:bg-[#fbf4ea] ${
                    selected ? "bg-[#f6efe6] text-[#4b3828]" : "text-[#2b241d]"
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
          className="h-10 w-full rounded-md border border-[#d8cbbb] bg-white px-3 pl-9 text-sm font-medium text-[#2b241d] outline-none transition placeholder:text-[#9a8d7f] focus:border-[#7c5f3f] focus:ring-2 focus:ring-[#7c5f3f]/10"
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            setQuery(event.target.value);
            openMenu();
          }}
          onFocus={openMenu}
          placeholder="Search or choose action"
          value={displayValue}
        />
      </div>

      {popover ? createPortal(popover, document.body) : null}
    </div>
  );
}

function getReviewStatus(transaction: ReviewTransaction): ReviewStatusFilter {
  if (transaction.ledgerAction === "use_suspense" || isSuspenseLedgerName(transaction.selectedLedgerName)) {
    return "suspense";
  }
  if (
    transaction.selectedLedgerName.trim() &&
    (transaction.ledgerAction === "use_existing_ledger" || transaction.ledgerAction === "use_standard_ledger")
  ) {
    return "matched";
  }
  return "needs_review";
}

function getReviewStatusLabel(transaction: ReviewTransaction) {
  const status = getReviewStatus(transaction);
  if (status === "matched") return "Ledger matched";
  if (status === "suspense") return "In Suspense";
  return "Needs review";
}

function getReviewStatusClass(transaction: ReviewTransaction) {
  const status = getReviewStatus(transaction);
  if (status === "matched") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "suspense") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-amber-200 bg-amber-50 text-amber-800";
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
  return openBills.find((bill) => {
    const ref = normalizeReferenceToken(bill.referenceName);
    return ref.length >= 5 && narration.includes(ref);
  }) ?? null;
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

  let remaining = receiptAmount;
  const allocations: BillAllocationLine[] = [];
  const narrationBill = findNarrationBill(openBills, transaction);
  const candidateBills = narrationBill
    ? [narrationBill, ...sortOpenBills(openBills.filter((bill) => bill.referenceName !== narrationBill.referenceName))]
    : sortOpenBills(openBills);

  for (const bill of candidateBills) {
    if (remaining <= 0) break;
    const pendingAmount = Math.max(0, Number(bill.pendingAmount ?? 0));
    if (pendingAmount <= 0) continue;
    const allocatedAmount = Math.min(remaining, pendingAmount);
    remaining = Number((remaining - allocatedAmount).toFixed(2));
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

  const newAdvanceAmount = Number(Math.max(0, remaining).toFixed(2));
  if (newAdvanceAmount > 0) {
    allocations.push({
      referenceType: "Advance",
      referenceName: buildAdvanceReference(transaction),
      allocatedAmount: newAdvanceAmount,
      pendingAmountAfterAllocation: newAdvanceAmount,
      statusAfterAllocation: "advance",
    });
    remaining = 0;
  }

  const totalAllocatedAmount = Number(allocations.reduce((sum, line) => sum + line.allocatedAmount, 0).toFixed(2));
  const unallocatedAmount = Number(Math.max(0, receiptAmount - totalAllocatedAmount).toFixed(2));
  const caseType = getAllocationCaseType(allocations, newAdvanceAmount);
  const caseLabel = getAllocationCaseLabel(allocations, newAdvanceAmount);
  const billCount = allocations.filter((line) => line.referenceType === "Agst Ref").length;

  return {
    status: unallocatedAmount === 0 ? "ready_to_post" : "needs_review",
    caseType,
    caseLabel,
    reason: narrationBill
      ? `Matched visible bill reference ${narrationBill.referenceName}; remaining amount used FIFO.`
      : billCount > 0
        ? "Allocated using FIFO from oldest due date or invoice date."
        : "No open bill found; the balance will be posted as a new advance.",
    receiptAmount,
    totalAllocatedAmount,
    newAdvanceAmount,
    unallocatedAmount,
    allocations,
    candidateBills: openBills,
    existingAdvances,
    requiresUserReview: unallocatedAmount !== 0,
    isEligibleForPosting: unallocatedAmount === 0,
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
  const errors: string[] = [];

  for (const commandId of commandIds) {
    const command = commandById.get(commandId);
    const status = command?.status ?? "queued";

    if (status === "succeeded") {
      completed += 1;
    } else if (status === "failed") {
      failed += 1;
      if (command?.error) errors.push(command.error);
    } else if (status === "canceled") {
      canceled += 1;
      if (command?.error) errors.push(command.error);
    } else if (status === "claimed") {
      sent += 1;
    } else {
      waiting += 1;
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
  };
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
      text: `Statement analyzed, but ledger recommendations need review: ${payload.ledgerRecommendationError}`,
    };
  }

  return {
    tone: "success" as const,
    text: "Statement analyzed.",
  };
}

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    diagnostics?: unknown;
  };
  const message = payload.error || `Request failed with status ${response.status}`;
  if (!payload.diagnostics) return message;

  return `${message} ${JSON.stringify(payload.diagnostics)}`;
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

export function BankStatementsPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
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
  const [syncBeforeAnalysis, setSyncBeforeAnalysis] = useState(true);
  const [ledgerMasters, setLedgerMasters] = useState<TallyMaster[]>([]);
  const [tallyBankLedgersByCompany, setTallyBankLedgersByCompany] = useState<Record<string, LocalBankLedger[]>>({});
  const [transactions, setTransactions] = useState<ReviewTransaction[]>([]);
  const [editingLedgerIds, setEditingLedgerIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [matchingBills, setMatchingBills] = useState(false);
  const [syncingMasters, setSyncingMasters] = useState(false);
  const [loadingBankLedgers, setLoadingBankLedgers] = useState(false);
  const [refreshingConnections, setRefreshingConnections] = useState(false);
  const [banner, setBanner] = useState<{ tone: MessageTone; text: string } | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [tallyPostingStatus, setTallyPostingStatus] = useState<TallyPostingStatus | null>(null);
  const [statementDoneSummary, setStatementDoneSummary] = useState<StatementDoneSummary | null>(null);
  const [reviewFiltersOpen, setReviewFiltersOpen] = useState(false);
  const [reviewSearch, setReviewSearch] = useState("");
  const [reviewStatusFilter, setReviewStatusFilter] = useState<ReviewStatusFilter>("all");
  const [reviewDirectionFilter, setReviewDirectionFilter] = useState<ReviewDirectionFilter>("all");
  const [reviewDateFrom, setReviewDateFrom] = useState("");
  const [reviewDateTo, setReviewDateTo] = useState("");
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [billAllocationsByTransactionId, setBillAllocationsByTransactionId] = useState<Record<string, BillAllocationDraft>>({});
  const [outgoingVerificationsByTransactionId, setOutgoingVerificationsByTransactionId] = useState<Record<string, OutgoingVerificationDraft>>({});
  const [billAllocationReviewTransactionId, setBillAllocationReviewTransactionId] = useState<string | null>(null);
  const [outgoingReviewTransactionId, setOutgoingReviewTransactionId] = useState<string | null>(null);
  const ledgerLoadSeqRef = useRef(0);
  const bankLedgerLoadKeyRef = useRef("");
  const initialSummaryLoadStartedRef = useRef(false);
  const tallyStatusStartedAtRef = useRef(Date.now());
  const [checkingLiveTallyCompany, setCheckingLiveTallyCompany] = useState(true);

  const validTransactions = useMemo(
    () => transactions.filter(transactionIsValid),
    [transactions]
  );
  const incomingReceiptCount = validTransactions.filter(isIncomingReceiptRow).length;
  const outgoingPaymentTransactions = useMemo(
    () => validTransactions.filter(isOutgoingPaymentRow),
    [validTransactions]
  );
  const outgoingPaymentCheckCount = outgoingPaymentTransactions.length;
  const visibleConnections = useMemo(
    () => getRelevantTallyConnections(connections),
    [connections]
  );
  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === tallyConnectionId) ?? null,
    [connections, tallyConnectionId]
  );
  const selectedCompany = useMemo(
    () =>
      companies.find((company) => company.id === selectedCompanyId) ??
      companies.find((company) => company.connectionId === tallyConnectionId) ??
      null,
    [companies, selectedCompanyId, tallyConnectionId]
  );
  const companyOptions = useMemo(() => {
    if (companies.length > 0) return uniqueCompanyOptions(companies);
    return uniqueCompanyOptions(visibleConnections.map((connection) => ({
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
    })));
  }, [companies, visibleConnections]);
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
    selectedCompany?.companyName || selectedConnection?.lastCompanyName || "";
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

  const uploadContextReady = Boolean(tallyCompanyContextVerified);
  const setupErrorMessage = !tallyConnectionId
    ? "Select the Tally company first."
    : !tallyConnected
      ? "Open Tally Prime, load the company, then refresh the connection."
      : !activeTallyCompanyName
        ? "Refresh Gajkesari to confirm the company currently open in Tally."
        : !tallyCompanyContextVerified
          ? `Tally is open to ${activeTallyCompanyName}. Switch Tally Prime to ${selectedCompanyName}, then refresh.`
          : "";
  const missingLedgerCount = useMemo(
    () => validTransactions.filter((transaction) => !transaction.selectedLedgerName.trim()).length,
    [validTransactions]
  );
  const matchedLedgerCount = validTransactions.filter(
    (transaction) =>
      transaction.selectedLedgerName.trim() &&
      !isSuspenseLedgerName(transaction.selectedLedgerName) &&
      (transaction.ledgerAction === "use_existing_ledger" || transaction.ledgerAction === "use_standard_ledger")
  ).length;
  const suspenseLedgerCount = validTransactions.filter(
    (transaction) => transaction.ledgerAction === "use_suspense" || isSuspenseLedgerName(transaction.selectedLedgerName)
  ).length;
  const needsReviewCount = validTransactions.filter(
    (transaction) => getReviewStatus(transaction) === "needs_review"
  ).length;
  const pendingBillEligibleTransactions = useMemo(
    () => validTransactions.filter((transaction) => isBillMatchEligibleTransaction(transaction, ledgerMasters)),
    [ledgerMasters, validTransactions]
  );
  const blockingBillAllocationCount = useMemo(
    () =>
      pendingBillEligibleTransactions.filter((transaction) => {
        const draft = billAllocationsByTransactionId[transaction.id];
        return !draft || draft.status === "cannot_match_yet" || draft.status === "needs_review" || draft.status === "stale_data";
      }).length,
    [billAllocationsByTransactionId, pendingBillEligibleTransactions]
  );
  const filteredTransactions = useMemo(() => {
    const normalizedSearch = normalizeName(reviewSearch);
    return validTransactions.filter((transaction) => {
      if (reviewStatusFilter !== "all" && getReviewStatus(transaction) !== reviewStatusFilter) {
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
        transaction.debitAmount,
        transaction.creditAmount,
        getTransactionPartyTitle(transaction),
      ].join(" ");
      return normalizeName(searchable).includes(normalizedSearch);
    });
  }, [reviewDateFrom, reviewDateTo, reviewDirectionFilter, reviewSearch, reviewStatusFilter, validTransactions]);
  const visibleReviewTransactions = useMemo(
    () => filteredTransactions.slice(0, rowsPerPage),
    [filteredTransactions, rowsPerPage]
  );
  const tallyPostingInProgress = Boolean(tallyPostingStatus && !tallyPostingStatus.finished);
  const statementReviewLocked = Boolean(statementDoneSummary) || tallyPostingInProgress;
  const activeReviewFilterCount = [
    reviewSearch.trim(),
    reviewStatusFilter !== "all" ? reviewStatusFilter : "",
    reviewDirectionFilter !== "all" ? reviewDirectionFilter : "",
    reviewDateFrom,
    reviewDateTo,
  ].filter(Boolean).length;
  const billAllocationReviewTransaction = billAllocationReviewTransactionId
    ? validTransactions.find((transaction) => transaction.id === billAllocationReviewTransactionId) ?? null
    : null;
  const billAllocationReviewDraft = billAllocationReviewTransaction
    ? billAllocationsByTransactionId[billAllocationReviewTransaction.id] ?? null
    : null;
  const outgoingReviewTransaction = outgoingReviewTransactionId
    ? validTransactions.find((transaction) => transaction.id === outgoingReviewTransactionId) ?? null
    : null;
  const outgoingReviewDraft = outgoingReviewTransaction
    ? outgoingVerificationsByTransactionId[outgoingReviewTransaction.id] ?? null
    : null;

  const loadTallyConnections = useCallback(async () => {
    const response = await apiFetch("/api/tally/connections", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const payload = (await response.json()) as { connections?: TallyConnection[] };
    const loadedConnections = payload.connections ?? [];
    const preferredConnection = getRelevantTallyConnections(loadedConnections)[0];
    setConnections(loadedConnections);
    setTallyConnectionId((current) => {
      if (current && loadedConnections.some((connection) => connection.id === current)) {
        return current;
      }
      return preferredConnection?.id || "";
    });
    return loadedConnections;
  }, []);

  const loadCompanyOptions = useCallback(async () => {
    const response = await apiFetch("/api/tally/companies", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const payload = (await response.json()) as { companies?: CompanyOption[]; selectedCompanyId?: string | null };
    const nextCompanies = uniqueCompanyOptions(payload.companies ?? []);
    setCompanies(nextCompanies);
    setSelectedCompanyId((current) => {
      if (current && nextCompanies.some((company) => company.id === current)) {
        return current;
      }
      return payload.selectedCompanyId || nextCompanies[0]?.id || current;
    });
    setTallyConnectionId((current) => {
      const selectedOption =
        nextCompanies.find((company) => company.id === selectedCompanyId) ??
        nextCompanies.find((company) => company.id === payload.selectedCompanyId) ??
        nextCompanies[0];
      if (selectedOption) return selectedOption.connectionId;
      if (current && nextCompanies.some((company) => company.connectionId === current)) return current;
      return current;
    });
    return nextCompanies;
  }, [selectedCompanyId]);

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
      `/api/tally/connections/${connectionId}/masters?type=ledger&limit=5000`,
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

  const clearStatementReview = useCallback(() => {
    setPreview(null);
    setTransactions([]);
    setFile(null);
    setAccount(EMPTY_ACCOUNT);
    setBankLedgerName("");
    setBankLedgerVerified(false);
    setBankLedgerManuallyConfirmed(false);
    setSelectedAccountId("");
    setBankLedgerChangeMode(false);
    setPendingBankLedgerName("");
    setEditingLedgerIds(new Set());
    setBanner(null);
    setTallyPostingStatus(null);
    setStatementDoneSummary(null);
    setBillAllocationsByTransactionId({});
    setOutgoingVerificationsByTransactionId({});
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
            text: `${nextStatus.completed} completed, ${nextStatus.failed + nextStatus.canceled} failed. Review the failed rows before uploading another statement.`,
          });
          showToast(
            "error",
            `${nextStatus.completed} completed, ${nextStatus.failed + nextStatus.canceled} failed or canceled.`
          );
        } else {
          setStatementDoneSummary({
            tone: "success",
            title: "Done. Sent to Tally.",
            text: `${nextStatus.completed} Tally action(s) completed. You can upload another statement when ready.`,
          });
          setBanner({
            tone: "success",
            text: `${nextStatus.completed} Tally action(s) completed.`,
          });
          showToast("success", `${nextStatus.completed} Tally action(s) completed.`);
        }
        return;
      }
    }

    showToast("info", "Tally work is still running. Keep the connector open.");
  }, []);

  useEffect(() => {
    if (initialSummaryLoadStartedRef.current) return;
    initialSummaryLoadStartedRef.current = true;

    let cancelled = false;

    async function loadSummary() {
      const [importsResponse, accountsResponse, loadedConnections, loadedCompanies] = await Promise.all([
        apiFetch("/api/bank-statements/imports", { cache: "no-store" }),
        apiFetch("/api/bank-statements/accounts", { cache: "no-store" }),
        loadTallyConnections(),
        loadCompanyOptions(),
      ]);

      if (cancelled) return;

      if (importsResponse.ok) {
        const payload = (await importsResponse.json()) as { imports?: BankStatementImport[] };
        setRecentImports(payload.imports ?? []);
      }
      if (accountsResponse.ok) {
        const payload = (await accountsResponse.json()) as { accounts?: BankAccount[] };
        setAccounts(payload.accounts ?? []);
      }
      const preferredConnection = getRelevantTallyConnections(loadedConnections)[0];
      const preferredCompany = loadedCompanies.find((company) => company.id === selectedCompanyId) ?? loadedCompanies[0];
      const nextConnectionId = tallyConnectionId || preferredCompany?.connectionId || preferredConnection?.id || "";
      const nextCompanyId = selectedCompanyId || preferredCompany?.id || "";
      setSelectedCompanyId(nextCompanyId);
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
      const fallbackCompany = companies[0] ?? null;
      setSelectedCompanyId(fallbackCompany?.id || "");
      setTallyConnectionId(fallbackCompany?.connectionId || visibleConnections[0]?.id || "");
    } else if (!currentCompanyExists) {
      setSelectedCompanyId(companies.find((company) => company.connectionId === tallyConnectionId)?.id || companies[0]?.id || "");
    }
  }, [companies, selectedCompanyId, tallyConnectionId, visibleConnections]);

  useEffect(() => {
    if (ledgerMasters.length === 0) return;

    setTransactions((current) =>
      current.map((transaction) => {
        const autoMatchedTransaction = autoMatchUntouchedLedgerSelection(transaction, ledgerMasters);
        if (autoMatchedTransaction !== transaction) return autoMatchedTransaction;

        if (
          transaction.ledgerAction === "use_suspense" ||
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
      const [loadedConnections, loadedCompanies] = await Promise.all([
        loadTallyConnections(),
        loadCompanyOptions(),
      ]);
      const preferredConnection = getRelevantTallyConnections(loadedConnections)[0];
      const preferredCompany = loadedCompanies.find((company) => company.id === selectedCompanyId) ?? loadedCompanies[0];
      const nextConnectionId = preferredCompany?.connectionId || preferredConnection?.id || "";
      const nextCompanyId = preferredCompany?.id || "";
      if (nextConnectionId) {
        setSelectedCompanyId(nextCompanyId);
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
    setEditingLedgerIds(new Set());
    setTallyPostingStatus(null);
    setBillAllocationsByTransactionId({});
    setOutgoingVerificationsByTransactionId({});
    setBillAllocationReviewTransactionId(null);
    setOutgoingReviewTransactionId(null);
  }
  async function pollImportUntilReady(importId: string, ledgerMastersForReview = ledgerMasters) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(2500);
      const response = await apiFetch(`/api/bank-statements/imports/${importId}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as PreviewResponse;
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

      applyPreviewPayload(payload, EMPTY_ACCOUNT, ledgerMastersForReview);
      setBanner(getAnalysisCompleteMessage(payload));
      return payload;
    }

    throw new Error("Bank statement analysis is still running. Please refresh in a moment.");
  }

  async function analyzeFile(nextFile = file) {
    if (!nextFile) {
      setBanner({ tone: "error", text: "Select a bank statement file." });
      return;
    }
    if (!tallyConnectionId || !selectedCompanyName) {
      setBanner({ tone: "error", text: "Select the Tally company before upload." });
      return;
    }
    if (!tallyConnected) {
      setBanner({ tone: "error", text: "Tally company is not ready. Open Tally Prime and refresh the connection." });
      return;
    }
    try {
      clearStatementReview();
      setLoading(true);
      setBanner(null);
      setTallyPostingStatus(null);
      setStatementDoneSummary(null);
      setFile(nextFile);
      let ledgerMastersForReview = ledgerMasters;
      if (syncBeforeAnalysis) {
        const syncedMasters = await syncCompanyData({ quiet: true });
        if (!syncedMasters) {
          return;
        }
        ledgerMastersForReview = syncedMasters;
      }
      const formData = new FormData();
      formData.set("file", nextFile);
      formData.set("account", JSON.stringify(EMPTY_ACCOUNT));
      formData.set("connectionId", tallyConnectionId);
      formData.set("companyName", selectedCompanyName);
      formData.set("financialYear", selectedFinancialYear);
      formData.set("bankLedgerName", "");
      formData.set("syncBeforeAnalysis", String(syncBeforeAnalysis));

      const response = await apiFetch("/api/bank-statements/imports", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as PreviewResponse;
      if (payload.processing) {
        setBanner({
          tone: "info",
          text: payload.job?.stage
            ? `Analyzing statement: ${payload.job.stage}`
            : "Analyzing statement...",
        });
        await pollImportUntilReady(payload.import.id, ledgerMastersForReview);
        return;
      }

      applyPreviewPayload(payload, EMPTY_ACCOUNT, ledgerMastersForReview);
      setBanner(getAnalysisCompleteMessage(payload));
    } catch (error) {
      setBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Bank statement analysis failed.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function syncCompanyData(options?: { quiet?: boolean }) {
    const connection = commandConnection;
    if (!connection) {
      setBanner({ tone: "error", text: "Select a Tally connection before syncing ledgers." });
      return false;
    }

    try {
      setSyncingMasters(true);
      setBanner(options?.quiet ? { tone: "info", text: "Refreshing Tally company data before analysis..." } : null);
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
          ? "Refreshing Tally company data before analysis..."
          : "Company data sync is running. Keep the connector open.",
      });
      const completedCommand = await waitForCommand(connection.id, command.id);
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
      await loadCompanyOptions().catch(() => undefined);
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

  async function fetchOpenBillsForLedgers(connection: TallyConnection, ledgerNames: string[]) {
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
    if (pendingBillEligibleTransactions.length === 0 && outgoingPaymentTransactions.length === 0) {
      showToast("info", "No receipt or outgoing payment rows were found to check.");
      return;
    }

    try {
      setMatchingBills(true);
      setBanner({ tone: "info", text: "Checking receipts and outgoing payments in Tally..." });
      const nextDrafts: Record<string, BillAllocationDraft> = {};
      if (pendingBillEligibleTransactions.length > 0) {
        const ledgers = Array.from(new Set(pendingBillEligibleTransactions.map((transaction) => transaction.selectedLedgerName)));
        const billDataByLedger = await fetchOpenBillsForLedgers(connection, ledgers);

        for (const transaction of validTransactions) {
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

      if (pendingBillEligibleTransactions.length > 0) {
        setBillAllocationsByTransactionId(nextDrafts);
      }
      const outgoingDrafts =
        outgoingPaymentTransactions.length > 0
          ? await verifyOutgoingPayments(connection, outgoingPaymentTransactions)
          : {};
      const readyCount = Object.values(nextDrafts).filter((draft) => draft.status === "ready_to_post").length;
      const foundOutgoingCount = Object.values(outgoingDrafts).filter((draft) => draft.status === "found").length;
      const issueOutgoingCount = Object.values(outgoingDrafts).filter(
        (draft) => draft.status === "missing" || draft.status === "ambiguous" || draft.status === "failed"
      ).length;
      setBanner({
        tone: issueOutgoingCount > 0 ? "info" : "success",
        text: `${readyCount} receipt row(s) matched with open bills. ${foundOutgoingCount} outgoing row(s) found in Tally${issueOutgoingCount > 0 ? `, ${issueOutgoingCount} need review` : ""}.`,
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

  async function sendToTally() {
    if (!preview) return;
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
    if (blockingBillAllocationCount > 0) {
      setBanner({
        tone: "error",
        text: `${blockingBillAllocationCount} party row(s) need bill allocation review before sending to Tally.`,
      });
      showToast("error", "Match or review open bills before sending to Tally.");
      return;
    }
    try {
      setSending(true);
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
          transactions: validTransactions.map((transaction) => ({
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

      const transactionsResponse = await apiFetch(
        `/api/bank-statements/transactions?${new URLSearchParams({
          accountId: confirmPayload.account.id,
          importId: confirmPayload.import.id,
          status: "queueable",
          connectionId: tallyConnectionId,
        }).toString()}`,
        { cache: "no-store" }
      );
      if (!transactionsResponse.ok) {
        throw new Error(await readError(transactionsResponse));
      }

      const queuePayload = (await transactionsResponse.json()) as { transactions?: QueueTransaction[] };
      const queueRows = queuePayload.transactions ?? [];
      const reviewedTransactionsByKey = new Map(
        validTransactions.map((transaction) => [transactionQueueKey(transaction), transaction])
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
            saveMapping: true,
          })),
        }),
      });

      if (!queueResponse.ok) {
        throw new Error(await readError(queueResponse));
      }

      const queuedPayload = (await queueResponse.json()) as {
        queuedCount?: number;
        verificationCount?: number;
        commands?: TallyCommand[];
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
          text: `${voucherCount} Tally voucher(s) queued, ${paymentCheckCount} payment check(s) queued. Keep this page open while Tally works.`,
        });
        void pollTallyPostingStatus(postingConnectionId, commandIds).catch((pollError) => {
          showToast(
            "error",
            pollError instanceof Error ? pollError.message : "Could not refresh Tally posting status."
          );
        });
      } else {
        setBanner(null);
      }
      showToast(
        "success",
        `${confirmPayload.importedTransactionCount} transactions imported. ${queuedPayload.queuedCount ?? 0} Tally voucher(s) queued and ${queuedPayload.verificationCount ?? 0} payment check(s) queued.`
      );
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Could not send bank statement to Tally.");
    } finally {
      setSending(false);
    }
  }

  return (
    <AppShell>
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
      <div className={`min-h-screen bg-[#f7f7f5] px-4 py-6 text-[#1a1a1a] sm:px-8 sm:py-8 ${preview ? "pb-40" : ""}`}>
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          <header className={`flex flex-col gap-3 md:flex-row md:items-start md:justify-between border-b border-[#e5ddd0] ${preview ? "pb-3" : "pb-6"}`}>
            <div>
              {!preview && (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200/50 text-[10px] font-bold uppercase tracking-wider text-amber-800 mb-2">
                  <Sparkles className="h-3 w-3 text-amber-600 animate-spin duration-3000" />
                  ERP Reconciliation
                </div>
              )}
              <h1 className={`${preview ? "text-xl sm:text-2xl" : "text-3xl"} font-black tracking-tight text-[#1a1a1a] flex items-center gap-2`}>
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
                    {!tallyConnected
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
                  onClick={clearStatementReview}
                  type="button"
                >
                  Upload Another
                </button>
              </div>
            </div>
          ) : null}

          {!preview ? (
            <section className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
              <div className="rounded-2xl border border-[#e5ddd0] bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
                <div className="space-y-4">
                  <label className="block">
                    <span className="text-xs font-bold text-[#5a5046]">Company</span>
                    <select
                      className="mt-1.5 h-11 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                      onChange={(event) => updateStatementContext(event.target.value)}
                      value={selectedCompany?.id || selectedCompanyId}
                    >
                      {companyOptions.length === 0 ? <option value="">No connected Tally company</option> : null}
                      {companyOptions.map((company) => (
                        <option key={company.id} value={company.id}>
                          {formatCompanyOptionLabel(company)}
                        </option>
                      ))}
                    </select>
                  </label>

                      <label className="flex items-center justify-between gap-3 rounded-xl border border-[#e5ddd0] bg-[#faf8f4]/60 px-4 py-3">
                    <span className="min-w-0">
                      <span className="block text-xs font-bold text-[#1a1a1a]">Sync current Tally company before analysis</span>
                    </span>
                    <input
                      checked={syncBeforeAnalysis}
                      className="h-5 w-5 shrink-0 rounded border-[#e5ddd0] accent-amber-600 focus:ring-amber-500"
                      onChange={(event) => setSyncBeforeAnalysis(event.target.checked)}
                      type="checkbox"
                    />
                  </label>

                  {setupErrorMessage ? (
                    <div className="rounded-xl border border-amber-250 bg-amber-50 px-3.5 py-2.5 text-xs font-bold text-amber-800">
                      {setupErrorMessage}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-emerald-250 bg-emerald-50 px-3.5 py-2.5 text-xs font-bold text-emerald-800">
                      Ready to upload.
                    </div>
                  )}
                </div>
              </div>

              <section className="rounded-2xl border border-[#e5ddd0] bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
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
                    if (nextFile) void analyzeFile(nextFile);
                  }}
                />
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
                    void analyzeFile(nextFile);
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
                  <div className="text-xs font-semibold text-slate-400 mt-1">
                    Supports CSV, TXT, PDF or scanned statement images
                  </div>
                  {file ? (
                    <div className="mt-5 rounded-full border border-amber-200 bg-amber-50 px-4 py-1.5 text-xs font-bold text-amber-800 shadow-sm animate-pulse">
                      {file.name}
                    </div>
                  ) : null}
                </button>
              </section>
            </section>
          ) : (
            <section className="space-y-4">
              <div className="rounded-2xl border border-[#e5ddd0] bg-white px-4 py-2 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div className="grid min-w-0 flex-1 items-center gap-4 sm:grid-cols-2 xl:grid-cols-[0.72fr_0.9fr_1.45fr_auto_minmax(240px,1.35fr)]">
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Company</div>
                      <div className="mt-1 truncate text-sm font-extrabold text-[#1a1a1a]" title={selectedCompanyName}>
                        {selectedCompanyName || "Not selected"} - {selectedFinancialYear}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Period</div>
                      <div className="mt-1 truncate text-sm font-extrabold text-[#1a1a1a]">
                        {preview.import.statementPeriodStart && preview.import.statementPeriodEnd
                          ? `${formatShortDate(preview.import.statementPeriodStart)} - ${formatShortDate(preview.import.statementPeriodEnd)}`
                          : "After analysis"}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-sky-700">Statement account</div>
                      <div className="mt-1 truncate text-sm font-extrabold text-[#1a1a1a]" title={`${account.bankName || ""} ${account.accountNumber || ""}`}>
                        {account.bankName || "Account not detected"}
                        {account.accountNumber ? ` - ${maskAccountNumber(account.accountNumber)}` : ""}
                      </div>
                      <div className="hidden 2xl:block truncate text-[10px] font-semibold text-slate-400 mt-0.5">
                        {account.accountHolderName || "Holder not found"}
                        {account.ifscCode ? ` - ${account.ifscCode}` : ""}
                      </div>
                    </div>
                    <div className="hidden xl:flex items-center justify-center px-0.5">
                      <ArrowRight aria-label="Statement to Tally ledger" className={`h-3.5 w-3.5 ${bankLedgerVerified ? "text-emerald-600" : "text-amber-600"}`} />

                    </div>
                    <div className="min-w-0">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-emerald-700">
                        {bankLedgerChangeMode ? "Replace Tally ledger" : "Tally posting ledger"}
                      </div>
                      {bankLedgerChangeMode || !bankLedgerName ? (
                        <div className="mt-1">
                          <LedgerSearchSelect
                            onChange={bankLedgerChangeMode ? setPendingBankLedgerName : applyTallyBankLedgerSelection}
                            options={bankLedgerOptions.map((ledger) => ledger.name)}
                            placeholder={ledgerMasters.length > 0 && bankLedgerOptions.length === 0 ? "No bank account ledger found" : "Search Tally bank ledger"}
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
                            <div className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold text-amber-700">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                              Choose the intended ledger - no exact account match was found.
                            </div>
                          )}
                        </div>                      ) : (
                        <div className="mt-1 flex min-w-0 items-center gap-2">
                          {bankLedgerVerified ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
                          ) : (
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate text-sm font-extrabold text-[#1a1a1a]" title={bankLedgerName}>
                              {bankLedgerName}
                            </div>
                            <div className={`truncate text-[10px] font-bold ${bankLedgerVerified ? "text-emerald-700" : "text-amber-700"}`}>
                              {bankLedgerVerified ? "Exact statement account match" : "Manual selection - review account numbers"}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                        className="h-8.5 rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#5a5046] outline-none focus:border-amber-500"
                      >
                        <option value="new">Extracted account</option>
                        {preview.candidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.accountHolderName || "Saved account"} - {candidate.accountNumberMasked}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {!bankLedgerChangeMode && bankLedgerName ? (
                      <button
                        type="button"
                        onClick={beginBankLedgerChange}
                        className="inline-flex h-8.5 items-center rounded-xl border border-[#e5ddd0] bg-white px-3.5 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] transition-all"
                      >
                        Change ledger
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={handleSyncLedgerMasters}
                      disabled={!tallyCompanyContextVerified || syncingMasters || loadingBankLedgers}
                      className="inline-flex h-8.5 items-center gap-1.5 rounded-xl border border-[#e5ddd0] bg-white px-3.5 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50 transition-all"
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
              {bankLedgerName && !bankLedgerVerified ? (
                <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <span>
                    This ledger has no exact verified account-number match to the uploaded statement. Choose it deliberately before posting.
                  </span>
                </div>
              ) : null}              <div className="hidden rounded-2xl border border-[#e3d6c6] bg-[#fffaf2] px-4 py-3 shadow-sm">
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
                          {account.accountNumber ? ` - ${maskAccountNumber(account.accountNumber)}` : ""}
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
                            {candidate.accountHolderName || "Saved account"} - {candidate.accountNumberMasked}
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
                          onChange={applyTallyBankLedgerSelection}
                          options={bankLedgerOptions.map((ledger) => ledger.name)}
                          placeholder={ledgerMasters.length > 0 && bankLedgerOptions.length === 0 ? "No bank account ledger found" : "Search Tally bank account"}
                          value={bankLedgerName}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
                <div className="border-b border-[#e5ddd0] px-5 py-4">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                    <button
                      className={`inline-flex h-9 w-fit items-center gap-2 rounded-xl border px-4 text-xs font-bold transition-all ${
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
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#2d2d2d] px-1.5 text-[10px] text-white">
                          {activeReviewFilterCount}
                        </span>
                      ) : null}
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e5ddd0] bg-white px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        {transactions.length} total
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-250 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                        {matchedLedgerCount} matched
                      </span>
                      {needsReviewCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-250 bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                          {needsReviewCount} needs review
                        </span>
                      ) : null}
                      {suspenseLedgerCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-250 bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                          {suspenseLedgerCount} in suspense
                        </span>
                      ) : null}
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                          missingLedgerCount === 0
                            ? "border-emerald-250 bg-emerald-50 text-emerald-800"
                            : "border-amber-250 bg-amber-50 text-amber-800"
                        }`}
                      >
                        {missingLedgerCount === 0 ? "Ready" : `${missingLedgerCount} need ledger`}
                      </span>
                    </div>
                  </div>
                  {reviewFiltersOpen ? (
                    <div className="mt-3.5 rounded-xl border border-[#e5ddd0] bg-[#faf8f4]/60 p-4">
                      <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr_0.8fr_auto] xl:items-end">
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
                              value={reviewSearch}
                            />
                          </div>
                        </label>
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            Status
                          </span>
                          <select
                            className="mt-1.5 h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewStatusFilter(event.target.value as ReviewStatusFilter)}
                            value={reviewStatusFilter}
                          >
                            <option value="all">All rows</option>
                            <option value="matched">Ledger matched</option>
                            <option value="needs_review">Needs review</option>
                            <option value="suspense">Suspense</option>
                          </select>
                        </label>
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            Type
                          </span>
                          <select
                            className="mt-1.5 h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                            onChange={(event) => setReviewDirectionFilter(event.target.value as ReviewDirectionFilter)}
                            value={reviewDirectionFilter}
                          >
                            <option value="all">Debit and credit</option>
                            <option value="debit">Debit only</option>
                            <option value="credit">Credit only</option>
                          </select>
                        </label>
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            From date
                          </span>
                          <div className="relative mt-1.5">
                            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                            <input
                              className="h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 pl-9 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                              onChange={(event) => setReviewDateFrom(event.target.value)}
                              type="date"
                              value={reviewDateFrom}
                            />
                          </div>
                        </label>
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            To date
                          </span>
                          <div className="relative mt-1.5">
                            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                            <input
                              className="h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 pl-9 text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                              onChange={(event) => setReviewDateTo(event.target.value)}
                              type="date"
                              value={reviewDateTo}
                            />
                          </div>
                        </label>
                        <button
                          className="h-9 rounded-xl border border-[#e5ddd0] bg-white px-4 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all"
                          onClick={() => {
                            setReviewSearch("");
                            setReviewStatusFilter("all");
                            setReviewDirectionFilter("all");
                            setReviewDateFrom("");
                            setReviewDateTo("");
                          }}
                          type="button"
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="max-h-[calc(100vh-470px)] overflow-auto [scrollbar-gutter:stable]">
                  <table className="w-full min-w-[1180px] table-fixed border-collapse text-left">
                    <thead className="sticky top-0 z-20">
                      <tr className="border-b border-[#e5ddd0] bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        <th className="w-20 px-3 py-3.5">Date</th>
                        <th className="w-[22%] px-3 py-3.5">Narration</th>
                        <th className="w-20 px-3 py-3.5">Type</th>
                        <th className="w-28 px-3 py-3.5">Ref / UTR</th>
                        <th className="w-28 px-3 py-3.5 text-right">Withdrawal</th>
                        <th className="w-28 px-3 py-3.5 text-right">Deposit</th>
                        <th className="w-[19%] px-3 py-3.5">Tally ledger</th>
                        <th className="w-44 px-3 py-3.5">Tally action</th>
                        <th className="w-32 px-3 py-3.5">Status</th>
                        <th className="w-16 px-3 py-3.5 text-right"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#e5ddd0] text-xs font-semibold text-slate-600">
                      {transactions.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="px-6 py-12 text-center text-xs font-semibold text-slate-400">
                            No rows were extracted. Upload another file or add rows after extraction support improves.
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
                          const direction = getTransactionDirection(transaction);
                          const mode = getTransactionMode(transaction);
                          const reference = getTransactionReference(transaction);
                          const isEditingLedger = editingLedgerIds.has(transaction.id);
                          const showLedgerSelect = isEditingLedger;
                          const billAllocation = billAllocationsByTransactionId[transaction.id];
                          const outgoingVerification = outgoingVerificationsByTransactionId[transaction.id];
                          const outgoingPayment = isOutgoingPaymentRow(transaction);
                          const finalRowStatus =
                            statementDoneSummary?.tone === "success"
                              ? outgoingPayment
                                ? "Checked"
                                : "Posted"
                              : statementDoneSummary?.tone === "info"
                                ? "Imported"
                                : getReviewStatusLabel(transaction);
                          const finalRowStatusClass =
                            statementDoneSummary?.tone === "success"
                              ? "border-emerald-250 bg-emerald-50 text-emerald-800"
                              : statementDoneSummary?.tone === "info"
                                ? "border-blue-200 bg-blue-50 text-blue-800"
                                : getReviewStatusClass(transaction);

                          return (
                            <tr key={transaction.id} className="align-middle hover:bg-[#fcfbfa]/60 transition-colors">
                              <td className="px-3 py-4 text-xs font-bold text-slate-500">
                                {formatShortDate(transaction.transactionDate)}
                              </td>
                              <td className="px-3 py-4">
                                <div className="truncate text-sm font-bold text-[#1a1a1a]" title={partyTitle}>
                                  {partyTitle}
                                </div>
                                <div className="mt-1 truncate text-xs font-semibold text-slate-400" title={transaction.description}>
                                  {transaction.description || "Narration not found"}
                                </div>
                              </td>
                              <td className="px-3 py-4">
                                <span
                                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                    direction === "Credit"
                                      ? "border-emerald-250 bg-emerald-50 text-emerald-800"
                                      : "border-red-250 bg-red-50 text-red-700"
                                  }`}
                                >
                                  {direction}
                                </span>
                              </td>
                              <td className="px-3 py-4">
                                <div className="truncate text-xs font-bold text-[#1a1a1a]" title={mode}>
                                  {mode || "-"}
                                </div>
                                <div className="mt-1 truncate text-xs font-semibold text-slate-400" title={reference}>
                                  {reference || "-"}
                                </div>
                              </td>
                              <td className="px-3 py-4 text-right text-xs font-bold text-red-600">
                                {debit || "-"}
                              </td>
                              <td className="px-3 py-4 text-right text-xs font-bold text-emerald-700">
                                {credit || "-"}
                              </td>
                              <td className="px-3 py-4">
                                {showLedgerSelect ? (
                                  <LedgerReviewSelect
                                    ledgerMasters={ledgerMasters}
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
                                    <span className="block truncate text-sm font-bold text-[#1a1a1a]" title={transaction.selectedLedgerName}>
                                      {transaction.selectedLedgerName}
                                    </span>
                                    <span className="mt-1 block truncate text-xs font-semibold text-slate-400">
                                      {getLedgerGroupLabel(transaction, ledgerMasters)}
                                    </span>
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-4">
                                {outgoingPayment ? (
                                  <button
                                    className={`flex max-w-full flex-col gap-1 rounded-xl border border-transparent px-2 py-1.5 text-left transition ${
                                      statementReviewLocked ? "cursor-default" : "hover:border-[#e5ddd0] hover:bg-[#faf8f4]"
                                    }`}
                                    onClick={() => {
                                      if (!statementReviewLocked) setOutgoingReviewTransactionId(transaction.id);
                                    }}
                                    title="Review outgoing payment check"
                                    type="button"
                                  >
                                    <span
                                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${getOutgoingVerificationClass(outgoingVerification)}`}
                                    >
                                      {getOutgoingVerificationLabel(outgoingVerification)}
                                    </span>
                                    <span
                                      className="truncate text-[10px] font-bold text-slate-400 mt-1"
                                      title={outgoingVerification?.reason}
                                    >
                                      {getOutgoingVerificationSubtext(outgoingVerification)}
                                    </span>
                                  </button>
                                ) : (
                                  <button
                                    className={`flex max-w-full flex-col gap-1 rounded-xl border border-transparent px-2 py-1.5 text-left transition ${
                                      statementReviewLocked ? "cursor-default" : "hover:border-[#e5ddd0] hover:bg-[#faf8f4]"
                                    }`}
                                    onClick={() => {
                                      if (!statementReviewLocked) setBillAllocationReviewTransactionId(transaction.id);
                                    }}
                                    title="Review bill allocation"
                                    type="button"
                                  >
                                    <span
                                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${getBillAllocationBadgeClass(transaction, ledgerMasters, billAllocation)}`}
                                    >
                                      {getBillAllocationBadgeText(transaction, ledgerMasters, billAllocation)}
                                    </span>
                                    {billAllocation?.caseLabel && billAllocation.status === "ready_to_post" ? (
                                      <span className="truncate text-[10px] font-bold text-slate-400 mt-1" title={billAllocation.reason}>
                                        {billAllocation.caseLabel}
                                      </span>
                                    ) : null}
                                  </button>
                                )}
                              </td>
                              <td className="px-3 py-4">
                                <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${finalRowStatusClass}`}>
                                  {finalRowStatus}
                                </span>
                              </td>
                              <td className="px-3 py-4">
                                <div className="flex justify-end gap-2">
                                  <button
                                    className={`inline-flex h-8.5 w-8.5 items-center justify-center rounded-xl transition ${
                                      isEditingLedger
                                        ? "bg-[#2d2d2d] text-white hover:bg-[#1a1a1a]"
                                        : "border border-[#e5ddd0] bg-white text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a]"
                                    }`}
                                    onClick={() =>
                                      setEditingLedgerIds((current) => {
                                        const next = new Set(current);
                                        if (next.has(transaction.id)) {
                                          next.delete(transaction.id);
                                        } else {
                                          next.add(transaction.id);
                                        }
                                        return next;
                                      })
                                    }
                                    disabled={statementReviewLocked}
                                    title={isEditingLedger ? "Close ledger selection" : "Change ledger"}
                                    type="button"
                                  >
                                    {isEditingLedger ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                                  </button>
                                </div>
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
                      onChange={(event) => setRowsPerPage(Number(event.target.value))}
                      value={rowsPerPage}
                    >
                      {[25, 50, 100, 200].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    Showing {visibleReviewTransactions.length === 0 ? 0 : 1}-
                    {visibleReviewTransactions.length} of {filteredTransactions.length}
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
                            <div className="flex items-center justify-between gap-3">
                              <h3 className="text-sm font-bold text-[#1a1a1a]">Allocate receipt</h3>
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
                                            <input
                                              className="h-8.5 w-32 rounded-xl border border-[#e5ddd0] bg-white px-3 text-right text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                                              min={0}
                                              max={bill.pendingAmount}
                                              onChange={(event) =>
                                                updateManualBillAmount(
                                                  billAllocationReviewTransaction,
                                                  bill.referenceName,
                                                  event.target.value
                                                )
                                              }
                                              step="0.01"
                                              type="number"
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
                                      <input
                                        className="h-8.5 w-32 rounded-xl border border-[#e5ddd0] bg-white px-3 text-right text-xs font-bold text-[#1a1a1a] outline-none focus:border-amber-500"
                                        min={0}
                                        onChange={(event) =>
                                          updateManualAdvanceAmount(billAllocationReviewTransaction, event.target.value)
                                        }
                                        step="0.01"
                                        type="number"
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
                  </aside>
                </div>
              ) : null}

              {outgoingReviewTransaction ? (
                <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
                  <button
                    aria-label="Close outgoing payment review"
                    className="absolute inset-0 cursor-default"
                    onClick={() => setOutgoingReviewTransactionId(null)}
                    type="button"
                  />
                  <aside className="relative flex h-full w-full max-w-[680px] flex-col border-l border-[#e5ddd0] bg-[#fcfbfa] shadow-2xl">
                    <div className="flex items-start justify-between border-b border-[#e5ddd0] bg-white px-5 py-4">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Payment Check
                        </div>
                        <h2 className="mt-1 text-xl font-extrabold text-[#1a1a1a]">
                          {getTransactionPartyTitle(outgoingReviewTransaction)}
                        </h2>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
                          <span>{formatShortDate(outgoingReviewTransaction.transactionDate)}</span>
                          <span>-</span>
                          <span>{formatCurrencyAmount(outgoingReviewTransaction.debitAmount)}</span>
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
                      <div className="hidden grid gap-3 sm:grid-cols-2">
                        {[
                          ["Bank Date", formatShortDate(outgoingReviewTransaction.transactionDate)],
                          ["Amount", formatCurrencyAmount(outgoingReviewTransaction.debitAmount)],
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
                          <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${getOutgoingVerificationClass(outgoingReviewDraft)}`}>
                            {getOutgoingVerificationLabel(outgoingReviewDraft)}
                          </span>
                          <span className="text-xs font-semibold text-slate-400">
                            Ledger: {outgoingReviewTransaction.selectedLedgerName || "-"}
                          </span>
                        </div>
                        <p className="mt-3 text-sm leading-6 text-slate-600">
                          {outgoingReviewDraft?.reason || "Run Check Tally Matches to verify this outgoing row against Tally."}
                        </p>
                      </div>

                      <section className={outgoingReviewDraft?.matches?.length ? "mt-5" : "hidden"}>
                        <h3 className="text-sm font-bold text-[#1a1a1a]">Possible vouchers</h3>
                        <div className="mt-2 space-y-3">
                          {outgoingReviewDraft?.matches?.length ? (
                            outgoingReviewDraft.matches.map((match, index) => (
                              <div
                                key={`${match.masterId || match.voucherNumber || index}`}
                                className="rounded-xl border border-[#e5ddd0] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,0.01)]"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <div className="text-sm font-bold text-[#1a1a1a]">
                                      {match.voucherNumber || match.masterId || `Candidate ${index + 1}`}
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
                                        <span className="text-xs font-semibold text-slate-400">No reason returned</span>
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

              <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-[#e5ddd0] bg-white/95 px-4 py-4 shadow-[0_-8px_24px_rgba(0,0,0,0.04)] backdrop-blur sm:left-[224px] sm:px-8">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1.5">
                  <div className="text-xs font-bold text-slate-500">
                    {incomingReceiptCount} receipt(s) to post, {outgoingPaymentCheckCount} payment check(s).
                  </div>
                  {tallyPostingStatus ? (
                    <div
                      className="flex flex-wrap items-center gap-2 text-xs font-bold"
                      role={tallyPostingStatus.finished ? "status" : "progressbar"}
                      aria-valuemin={0}
                      aria-valuemax={tallyPostingStatus.total}
                      aria-valuenow={tallyPostingStatus.completed + tallyPostingStatus.failed + tallyPostingStatus.canceled}
                    >
                      <span className="inline-flex items-center gap-1 rounded-full border border-[#e5ddd0] bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                        {tallyPostingStatus.total} enqueued
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-800">
                        {tallyPostingStatus.waiting + tallyPostingStatus.sent} pending
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-250 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                        {tallyPostingStatus.completed} completed
                      </span>
                      {(tallyPostingStatus.failed > 0 || tallyPostingStatus.canceled > 0) ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-red-250 bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-800">
                          {tallyPostingStatus.failed + tallyPostingStatus.canceled} failed
                        </span>
                      ) : null}
                      {!tallyPostingStatus.finished ? (
                        <span className="inline-flex items-center gap-1 text-slate-400 text-xs font-semibold">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Working in Tally
                        </span>
                      ) : null}
                      {tallyPostingStatus.errors[0] ? (
                        <span className="max-w-[520px] truncate text-red-700 text-xs">
                          {tallyPostingStatus.errors[0]}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="border-[#e5ddd0] bg-white text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] transition-all rounded-xl h-10 text-xs font-bold"
                    onClick={clearStatementReview}
                    disabled={sending || matchingBills || tallyPostingInProgress}
                    type="button"
                    variant="outline"
                  >
                    Upload Another
                  </Button>
                  {!statementDoneSummary ? (
                    <>
                      <Button
                        className="border-[#e5ddd0] bg-white text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] transition-all rounded-xl h-10 text-xs font-bold"
                        onClick={matchPendingBills}
                        disabled={
                          sending ||
                          matchingBills ||
                          tallyPostingInProgress ||
                          (pendingBillEligibleTransactions.length === 0 && outgoingPaymentCheckCount === 0)
                        }
                        type="button"
                        variant="outline"
                      >
                        {matchingBills ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        Check Tally Matches ({pendingBillEligibleTransactions.length + outgoingPaymentCheckCount})
                      </Button>
                      <Button
                        className="bg-[#2d2d2d] text-white text-xs font-bold hover:bg-[#1a1a1a] shadow-sm transition-all rounded-xl h-10"
                        onClick={sendToTally}
                        disabled={
                          sending ||
                          matchingBills ||
                          tallyPostingInProgress ||
                          validTransactions.length === 0 ||
                          blockingBillAllocationCount > 0 ||
                          (!bankLedgerVerified && !bankLedgerManuallyConfirmed)
                        }
                      >
                        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                        {tallyPostingInProgress ? "Working In Tally" : "Send to Tally"}
                      </Button>
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
