import type { SupabaseClient } from "@supabase/supabase-js";

import {
  extractCounterpartyName,
  normalizeName,
  normalizeNarrationPattern,
  type ParsedBankTransaction,
} from "@/lib/bank-statements";
import {
  callOpenRouter,
  getBankLedgerMatchingMaxTokens,
  getBankLedgerMatchingModel,
  getBankLedgerMatchingTimeoutMs,
} from "@/lib/processing/openrouter";
import { normalizeMasterKey, type TallyMappingRow, type TallyMasterRow } from "@/lib/tally/masters";

export type BankLedgerSuggestion = {
  counterpartyName: string | null;
  ledgerName: string | null;
  confidence: number;
  reason: string | null;
  mappingSource: "saved_narration" | "category" | "ledger_name" | "close_match" | "ai_match" | "none";
  matchType?: "direct_match" | "close_match" | "suspense";
  candidateLedgerNames?: string[];
};

type MatchableTransaction = Pick<ParsedBankTransaction, "description" | "category" | "counterpartyName"> &
  Partial<ParsedBankTransaction>;

type AiLedgerMatch = {
  index: number;
  matchType: "direct_match" | "close_match" | "suspense";
  action: "use_existing_ledger" | "use_suspense";
  ledgerName: string | null;
  candidateLedgerNames: string[];
  confidence: number;
  reason: string;
};

const BANK_LEDGER_MATCHING_SYSTEM_PROMPT = `You match Indian bank statement transactions to synced Tally ledgers.
Your task is to recommend the correct existing Tally ledger for each bank transaction.
This is ledger assignment only. Do not attempt invoice matching, voucher matching, invoice settlement, split allocation, or full bank reconciliation.
Return only valid JSON. Do not return markdown, explanations outside JSON, or code fences.

Allowed ledgers:
Choose only from the provided tallyLedgers list. Copy every selected ledger name exactly as provided.
Never invent, modify, shorten, merge, or create a ledger.
Never create a new party, expense, tax, bank, transfer, or suspense ledger.
If no existing ledger is clearly correct, use suspense.
Every transaction must produce exactly one result using its original index.

Output format:
{
  "matches": [
    {
      "index": 0,
      "matchType": "direct_match",
      "action": "use_existing_ledger",
      "ledgerName": "Exact Ledger Name From tallyLedgers",
      "candidateLedgerNames": [],
      "confidence": 0.95,
      "reason": "Short reason"
    }
  ]
}

Allowed matchType values: direct_match, close_match, suspense.

Direct match:
Use direct_match only when exactly one existing ledger is clearly the best match.
For direct_match, action must be "use_existing_ledger", ledgerName must be one exact name from tallyLedgers, candidateLedgerNames must be [], and confidence must be at least 0.90.

Close match:
Use close_match when two or more existing ledgers are genuinely plausible and no single ledger can be selected safely.
For close_match, action must be "use_suspense", ledgerName must be null, candidateLedgerNames must contain at least two exact competing ledger names from tallyLedgers, and confidence must be 0.0.

Suspense:
Use suspense when there is no clear existing ledger, the narration is too generic, or matching would require guessing.
For suspense, action must be "use_suspense", ledgerName must be null, candidateLedgerNames must be [], and confidence must be 0.0.

Core rule:
A shortened, OCR-damaged, misspelled, or incomplete party name can still be a direct match when it uniquely identifies one existing ledger.
Do not call something a close match only because the bank narration does not exactly equal the ledger name.
Use close_match only when there is a real collision.

Remove bank-system noise before comparing names:
Ignore NEFT, RTGS, IMPS, UPI, UPIREF, NACH, ACH, ECS, CMS, CR, DR, transfer, fund transfer, payment, receipt, UTR, RRN, TXN, REF, beneficiary, to, from, by, account words, IFSC, bank, branch, mobile/account/reference numbers, M/S, MS, M S, dates, and similar bank references.
Do not treat these words or numbers as party names.
Use transaction direction, amount, and date only as supporting context. Do not use them alone to guess a ledger.

Normalize carefully:
Ignore case, extra spaces, missing spaces, punctuation, dots, commas, brackets, hyphens, slashes, separators, and legal-form suffixes such as Pvt Ltd, Private Limited, Ltd, Limited, LLP, Co, Company, Inc.
Treat spelling variants as possible normal variants only when the full party root remains clearly the same.
Examples: Bharat/Bharath/Bharth, Shree/Shri/Sri, Steel/Steels, Enterprise/Enterprises, Engg/Engineering, Transport/Transports, Logistics/Logistic, Roadline/Roadlines, Electrical/Electricals, Fabrication/Fabricators.
Do not use phonetic similarity alone as proof. It can support a direct match only when one ledger remains clearly unique after collision checking.

Preserve meaningful business descriptors:
Do not remove descriptors such as Steel, Metals, Alloys, Traders, Transport, Logistics, Roadlines, Engineering, Fabrication, Electricals, Chemicals, Hardware, Fuel, Power, Construction, Enterprises, Industries, Agencies, Services, Works.
These may differentiate different parties. Prefer the ledger with the closest matching full root and descriptor.
A named party ledger is preferred over a generic expense-category ledger when both are available.
Never confuse different party roots based only on one shared word, partial string, or loose phonetic resemblance.

Transaction types to consider:
The statement may include customer receipts, supplier payments, raw-material purchases, transport/freight/logistics, contractor/fabrication/repair/machinery/electrical payments, fuel/toll/travel/hotel/food/staff welfare, salaries/wages/incentives/advances/reimbursements, utilities, GST/TDS/PF/ESIC/professional tax/income tax/customs duty, bank charges/interest/cheque return/loan interest/OD interest, insurance/loan/EMI/fixed deposit, cash deposits/withdrawals, payment-gateway/card settlements, reversals, and transfers between company accounts.
Do not assume every transaction is a customer or vendor payment.

Category and expense-ledger matching:
You may select an expense, statutory, payroll, or bank-related ledger only when the narration explicitly supports that category and exactly one existing ledger clearly fits.
Do not infer an expense category from a merchant name alone.
If a merchant/category could belong to multiple expense ledgers, use suspense.

Employee, salary, and reimbursement transactions:
Match an employee-name ledger only when one existing employee ledger clearly matches the person.
Do not map a person's name to Salary Expenses, Travelling Expenses, Staff Welfare Expenses, or Wages Expenses merely because the transaction may be related to that category.
If narration says salary but both Salary Expenses and Wages Expenses are plausible, use close_match or suspense.

Transfers, reversals, and company-own transactions:
Do not select the company's own ledger merely because the company name appears in narration.
Use suspense unless one existing transfer, loan, bank, or finance ledger is explicitly and uniquely supported by the narration.

Cases that must go to suspense:
No identifiable party/category; only UTR/RRN/account/bank code/reference; multiple possible expense categories; merchant name does not reveal purpose; self-transfer/reversal without explicit matching ledger; best possible match below 0.90; selecting requires guessing; transaction may need split allocation or voucher-level reconciliation.

Final decision rules:
Use direct_match when exactly one ledger is clearly best.
A unique shortened party name is a direct match when no competing ledger shares that root.
A typo, OCR issue, joined word, missing space, or phonetic variation can still be a direct match when one ledger clearly fits.
Use close_match only when two or more existing ledgers are genuinely plausible.
Use suspense when no clear ledger exists or matching requires guessing.
Never select a ledger when confidence is below 0.90.
Never invent, alter, or create a ledger.
Never guess between similar ledgers.`;

function categoryLedgerCandidates(category?: string | null, description?: string | null) {
  const text = `${category ?? ""} ${description ?? ""}`.toLowerCase();
  if (/\batm\b|\bcash\s*withdrawal\b|\bcash\b/.test(text)) return ["Cash", "Cash in Hand", "Cash-in-Hand"];
  if (/\binterest\b/.test(text)) return ["Interest Income", "Interest Received"];
  if (/\bbank[_\s-]*charges\b|\bcharge|charges|fee\b/.test(text)) {
    if (/\bgst\b/.test(text)) return ["Bank Charges GST", "Bank Charges", "Duties & Taxes"];
    return ["Bank Charges", "Bank Charges GST"];
  }
  if (/\btax|tds|gst\b/.test(text)) return ["Duties & Taxes", "GST Payable", "TDS Payable"];
  if (/\bsalary|wages\b/.test(text)) return ["Salary Payable", "Salary"];
  return [];
}

function findLedgerByName(ledgers: TallyMasterRow[], candidates: string[]) {
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeName(candidate);
    const exact = ledgers.find((ledger) => normalizeName(ledger.tally_name) === normalizedCandidate);
    if (exact) return exact.tally_name;
  }

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeName(candidate);
    const partial = ledgers.find((ledger) => {
      const normalizedLedger = normalizeName(ledger.tally_name);
      return normalizedLedger.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedLedger);
    });
    if (partial) return partial.tally_name;
  }

  return null;
}

function ledgerNameTokens(value?: string | null) {
  return normalizeName(value)
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

function findCloseLedgerMatches(ledgers: TallyMasterRow[], candidateName?: string | null) {
  const normalizedCandidate = normalizeName(candidateName);
  if (!normalizedCandidate || compactLedgerName(normalizedCandidate).length < 5) return [];

  const matches: Array<{ ledgerName: string; score: number }> = [];
  for (const ledger of ledgers) {
    const score = ledgerNameSimilarity(normalizedCandidate, ledger.tally_name);
    if (score < 0.84) continue;
    matches.push({ ledgerName: ledger.tally_name, score });
  }

  return matches.sort((left, right) => right.score - left.score || left.ledgerName.localeCompare(right.ledgerName));
}

function findUniqueCloseLedgerByName(ledgers: TallyMasterRow[], candidateName?: string | null) {
  const matches = findCloseLedgerMatches(ledgers, candidateName);
  return matches.length === 1 ? matches[0] : null;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return fallback;
    }
  }
}

function compactPromptJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function clampConfidence(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function findLedgerByNormalizedName(ledgers: TallyMasterRow[], ledgerName?: string | null) {
  const normalized = normalizeName(ledgerName);
  if (!normalized) return null;
  return ledgers.find((ledger) => normalizeName(ledger.tally_name) === normalized) ?? null;
}

function ledgerShortlistScore(ledger: TallyMasterRow, transaction: MatchableTransaction, counterpartyName: string | null) {
  const candidates = [
    counterpartyName,
    transaction.counterpartyName,
    extractCounterpartyName(transaction.description),
    transaction.description,
  ].filter(Boolean) as string[];

  return Math.max(0, ...candidates.map((candidate) => ledgerNameSimilarity(candidate, ledger.tally_name)));
}

function shortlistLedgersForAi(ledgers: TallyMasterRow[], transaction: MatchableTransaction, counterpartyName: string | null) {
  if (ledgers.length <= 200) return ledgers;

  const scoredLedgers = ledgers
    .map((ledger) => ({
      ledger,
      score: ledgerShortlistScore(ledger, transaction, counterpartyName),
    }))
    .filter((entry) => entry.score >= 0.35)
    .sort((left, right) => right.score - left.score || left.ledger.tally_name.localeCompare(right.ledger.tally_name))
    .slice(0, 120)
    .map((entry) => entry.ledger);

  return scoredLedgers.length > 0 ? scoredLedgers : ledgers.slice(0, 200);
}

async function aiMatchLedgerForTransaction(input: {
  ledgers: TallyMasterRow[];
  transaction: MatchableTransaction;
  counterpartyName: string | null;
}) {
  const candidateLedgers = shortlistLedgersForAi(input.ledgers, input.transaction, input.counterpartyName);
  if (candidateLedgers.length === 0) return null;

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content: BANK_LEDGER_MATCHING_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: compactPromptJson({
          transactions: [
            {
              index: 0,
              transactionDate: input.transaction.transactionDate ?? null,
              description: input.transaction.description,
              referenceNumber: input.transaction.referenceNumber ?? null,
              debitAmount: input.transaction.debitAmount ?? null,
              creditAmount: input.transaction.creditAmount ?? null,
              transactionType: input.transaction.transactionType ?? null,
              category: input.transaction.category,
              counterpartyName: input.counterpartyName ?? input.transaction.counterpartyName ?? null,
            },
          ],
          tallyLedgers: candidateLedgers.map((ledger) => ({
            name: ledger.tally_name,
            group: ledger.parent_name ?? null,
          })),
        }),
      },
    ],
    {
      expectJson: true,
      jsonMode: true,
      model: getBankLedgerMatchingModel(),
      maxTokens: getBankLedgerMatchingMaxTokens(),
      timeoutMs: getBankLedgerMatchingTimeoutMs(),
    }
  );

  const parsed = safeJsonParse<{
    matches?: Array<Partial<AiLedgerMatch>>;
  }>(raw, {});
  const match = parsed.matches?.find((entry) => Number(entry?.index) === 0);
  if (!match) return null;

  const reason = String(match.reason ?? "").trim() || "AI ledger matching completed.";
  const candidateLedgerNames = Array.isArray(match.candidateLedgerNames)
    ? match.candidateLedgerNames
        .map((name) => String(name ?? "").trim())
        .filter((name) => Boolean(findLedgerByNormalizedName(candidateLedgers, name)))
    : [];

  if (match.matchType === "direct_match" && match.action === "use_existing_ledger") {
    const matchedLedger = findLedgerByNormalizedName(candidateLedgers, String(match.ledgerName ?? ""));
    const confidence = clampConfidence(match.confidence);
    if (!matchedLedger || confidence < 0.9) {
      return {
        ledgerName: null,
        confidence: 0,
        reason: "AI returned an unsafe ledger match, so the row was kept in suspense.",
        matchType: "suspense" as const,
        candidateLedgerNames: [],
      };
    }

    return {
      ledgerName: matchedLedger.tally_name,
      confidence,
      reason,
      matchType: "direct_match" as const,
      candidateLedgerNames: [],
    };
  }

  if (match.matchType === "close_match" && candidateLedgerNames.length >= 2) {
    return {
      ledgerName: null,
      confidence: 0,
      reason,
      matchType: "close_match" as const,
      candidateLedgerNames,
    };
  }

  return {
    ledgerName: null,
    confidence: 0,
    reason,
    matchType: "suspense" as const,
    candidateLedgerNames: [],
  };
}

function sourceKeyForNarration(accountId: string, description: string) {
  return `${accountId}:${normalizeNarrationPattern(description)}`.slice(0, 240);
}

export function buildBankAccountLedgerSourceKey(accountId: string) {
  return `bank_account:${accountId}`.slice(0, 240);
}

export function buildBankNarrationLedgerSourceKey(accountId: string, description: string) {
  return sourceKeyForNarration(accountId, description);
}

export async function suggestBankLedgerForTransaction(input: {
  supabase: SupabaseClient;
  ownerUserId: string;
  connectionId?: string | null;
  accountId: string;
  transaction: MatchableTransaction;
}): Promise<BankLedgerSuggestion> {
  const counterpartyName = input.transaction.counterpartyName ?? extractCounterpartyName(input.transaction.description);
  const sourceKey = sourceKeyForNarration(input.accountId, input.transaction.description);

  if (input.connectionId) {
    const { data: mappingRows, error: mappingError } = await input.supabase
      .from("tally_mapping_settings")
      .select("*")
      .eq("owner_user_id", input.ownerUserId)
      .eq("connection_id", input.connectionId)
      .eq("mapping_type", "bank_narration_ledger")
      .eq("source_key", sourceKey)
      .eq("status", "active")
      .limit(1);

    if (mappingError) throw mappingError;

    const savedMapping = ((mappingRows ?? []) as unknown as TallyMappingRow[])[0];
    if (savedMapping?.target_master_name) {
      return {
        counterpartyName,
        ledgerName: savedMapping.target_master_name,
        confidence: 0.99,
        reason: "Saved narration mapping",
        mappingSource: "saved_narration",
      };
    }
  }

  const { data: ledgerRows, error: ledgerError } = input.connectionId
    ? await input.supabase
        .from("tally_masters")
        .select("*")
        .eq("owner_user_id", input.ownerUserId)
        .eq("connection_id", input.connectionId)
        .eq("master_type", "ledger")
        .eq("is_active", true)
        .limit(5000)
    : { data: [], error: null };

  if (ledgerError) throw ledgerError;

  const ledgers = (ledgerRows ?? []) as unknown as TallyMasterRow[];
  if (ledgers.length > 0) {
    try {
      const aiLedger = await aiMatchLedgerForTransaction({
        ledgers,
        transaction: input.transaction,
        counterpartyName,
      });
      if (aiLedger) {
        return {
          counterpartyName,
          ledgerName: aiLedger.ledgerName,
          confidence: aiLedger.confidence,
          reason: aiLedger.reason,
          mappingSource: aiLedger.ledgerName ? "ai_match" : "none",
          matchType: aiLedger.matchType,
          candidateLedgerNames: aiLedger.candidateLedgerNames,
        };
      }
    } catch (error) {
      console.warn("AI ledger match failed; using deterministic fallback:", error);
    }
  }

  const categoryCandidates = categoryLedgerCandidates(input.transaction.category, input.transaction.description);
  const categoryLedgerName = findLedgerByName(ledgers, categoryCandidates);
  if (categoryCandidates.length > 0) {
    return {
      counterpartyName,
      ledgerName: categoryLedgerName,
      confidence: categoryLedgerName ? 0.9 : 0.4,
      reason: categoryLedgerName
        ? "Matched standard bank transaction category"
        : "Category detected, but no matching Tally ledger was synced",
      mappingSource: categoryLedgerName ? "category" : "none",
    };
  }

  if (counterpartyName) {
    const normalizedCounterparty = normalizeName(counterpartyName);
    const matchedLedger = ledgers.find((ledger) => normalizeName(ledger.tally_name) === normalizedCounterparty);
    if (matchedLedger) {
      return {
        counterpartyName,
        ledgerName: matchedLedger.tally_name,
        confidence: 0.88,
        reason: "Counterparty matched synced Tally ledger name",
        mappingSource: "ledger_name",
      };
    }

    const closeLedger = findUniqueCloseLedgerByName(ledgers, counterpartyName);
    if (closeLedger) {
      return {
        counterpartyName,
        ledgerName: closeLedger.ledgerName,
        confidence: Math.min(0.95, Math.max(0.86, closeLedger.score)),
        reason: "One close Tally ledger match found",
        mappingSource: "close_match",
      };
    }
  }

  return {
    counterpartyName,
    ledgerName: null,
    confidence: 0,
    reason: null,
    mappingSource: "none",
  };
}

export function buildLedgerMappingTarget(ledgerName: string) {
  return {
    target_master_type: "ledger",
    target_master_key: normalizeMasterKey({ masterType: "ledger", name: ledgerName }),
    target_master_name: ledgerName,
  };
}
