import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_SECRET = process.env.WORKER_SECRET;
const WORKER_NAME = process.env.WORKER_NAME || `worker-${process.pid}`;
const WORKER_POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const RAW_APP_BASE_URL =
  process.env.APP_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : null);
const APP_BASE_URL = RAW_APP_BASE_URL?.replace(/\/+$/, "");
const HEROKU_ROUTER_TIMEOUT_GRACE_MS = Number(process.env.HEROKU_ROUTER_TIMEOUT_GRACE_MS ?? 29_000);
const WORKER_STALE_RUNNING_JOB_MS = Number(process.env.WORKER_STALE_RUNNING_JOB_MS ?? 20 * 60_000);
const WORKER_STALE_RUNNING_JOB_INTERVAL = `${Math.max(1, Math.round(WORKER_STALE_RUNNING_JOB_MS / 60_000))} minutes`;
const WORKER_IN_FLIGHT_WAIT_MS = Number(process.env.WORKER_IN_FLIGHT_WAIT_MS ?? 2 * 60_000);
const WORKER_IN_FLIGHT_POLL_MS = Number(process.env.WORKER_IN_FLIGHT_POLL_MS ?? 5_000);
const BANK_STATEMENT_AI_MAX_PAGES = Number(process.env.BANK_STATEMENT_AI_MAX_PAGES ?? 8);
const BANK_STATEMENT_SINGLE_SHOT_MAX_PAGES = Number(
  process.env.BANK_STATEMENT_SINGLE_SHOT_MAX_PAGES ?? BANK_STATEMENT_AI_MAX_PAGES
);
const BANK_STATEMENT_MAX_TOTAL_PAGES = Number(process.env.BANK_STATEMENT_MAX_TOTAL_PAGES ?? 1000);
const BANK_STATEMENT_BATCH_PAGE_SIZE = Math.max(1, Number(process.env.BANK_STATEMENT_BATCH_PAGE_SIZE ?? 2));
const BANK_STATEMENT_BATCH_CONCURRENCY = Math.max(1, Number(process.env.BANK_STATEMENT_BATCH_CONCURRENCY ?? 3));
const BANK_STATEMENT_BATCH_RETRY_LIMIT = Math.max(0, Number(process.env.BANK_STATEMENT_BATCH_RETRY_LIMIT ?? 2));
const BANK_STATEMENT_SINGLE_PAGE_RECOVERY_LIMIT = Math.max(
  0,
  Number(process.env.BANK_STATEMENT_SINGLE_PAGE_RECOVERY_LIMIT ?? 50)
);
const BANK_STATEMENT_TEXT_PROMPT_MAX_CHARS = Number(process.env.BANK_STATEMENT_TEXT_PROMPT_MAX_CHARS ?? 80_000);
const BANK_STATEMENT_PDF_RENDER_DPI = Number(process.env.BANK_STATEMENT_PDF_RENDER_DPI ?? 170);
const BANK_STATEMENT_PROVIDER_IMAGE_TARGET_BYTES = Number(
  process.env.BANK_STATEMENT_PROVIDER_IMAGE_TARGET_BYTES ?? 8 * 1024 * 1024
);
const BANK_STATEMENT_PROVIDER_IMAGE_HARD_LIMIT_BYTES = Number(
  process.env.BANK_STATEMENT_PROVIDER_IMAGE_HARD_LIMIT_BYTES ?? 20 * 1024 * 1024
);
const BANK_STATEMENT_PROVIDER_IMAGE_MAX_DIMENSION = Number(
  process.env.BANK_STATEMENT_PROVIDER_IMAGE_MAX_DIMENSION ?? 3200
);
const BANK_STATEMENT_BUCKET = "bank-statement-files";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL =
  process.env.OPENROUTER_QUALITY_MODEL ||
  process.env.GEMINI_THINKING_MODEL ||
  "google/gemini-2.5-flash";
const OPENROUTER_MAX_RETRIES = Number(process.env.OPENROUTER_MAX_RETRIES ?? 2);
const OPENROUTER_RETRY_BASE_MS = Number(process.env.OPENROUTER_RETRY_BASE_MS ?? 1200);
const OPENROUTER_MAX_OUTPUT_TOKENS = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS ?? 8192);
const OPENROUTER_QUALITY_REASONING_TOKENS = Number(process.env.OPENROUTER_QUALITY_REASONING_TOKENS ?? 2000);
const OPENROUTER_BANK_LEDGER_MODEL =
  process.env.OPENROUTER_BANK_LEDGER_MODEL ||
  "deepseek/deepseek-v4-pro";
const OPENROUTER_BANK_LEDGER_MAX_OUTPUT_TOKENS = Number(
  process.env.OPENROUTER_BANK_LEDGER_MAX_OUTPUT_TOKENS ?? 4096
);
const execFileAsync = promisify(execFile);
const WORKER_IDLE_LOG_INTERVAL_MS = Number(process.env.WORKER_IDLE_LOG_INTERVAL_MS ?? 30_000);

const BANK_LEDGER_MATCHING_SYSTEM_PROMPT = `You match Indian bank statement transactions to synced Tally ledgers.
Your task is to recommend the correct existing Tally ledger for each bank transaction.
This is ledger assignment only. Do not attempt invoice matching, voucher matching, invoice settlement, split allocation, or full bank reconciliation.
Return only valid JSON. Do not return markdown, explanations outside JSON, or code fences.
Choose only from the provided tallyLedgers list. Copy every selected ledger name exactly as provided.
Never invent, modify, shorten, merge, or create a ledger. If no existing ledger is clearly correct, use suspense.
Every transaction must produce exactly one result using its original index.
Return this exact structure: {"matches":[{"index":0,"matchType":"direct_match","action":"use_existing_ledger","ledgerName":"Exact Ledger Name From tallyLedgers","candidateLedgerNames":[],"confidence":0.95,"reason":"Short reason"}]}.
Allowed matchType values: direct_match, close_match, suspense.
For direct_match, action must be "use_existing_ledger", ledgerName must be one exact name from tallyLedgers, candidateLedgerNames must be [], and confidence must be at least 0.90.
For close_match, action must be "use_suspense", ledgerName must be null, candidateLedgerNames must contain at least two exact competing ledger names from tallyLedgers, and confidence must be 0.0.
For suspense, action must be "use_suspense", ledgerName must be null, candidateLedgerNames must be [], and confidence must be 0.0.
A shortened, OCR-damaged, misspelled, or incomplete party name can still be a direct match when it uniquely identifies one existing ledger.
Ignore bank-system noise such as NEFT, RTGS, IMPS, UPI, NACH, ACH, ECS, CMS, CR, DR, payment, receipt, UTR, RRN, TXN, REF, beneficiary, account words, IFSC, bank, branch, dates, and reference numbers.
Ignore case, spaces, punctuation, legal suffixes, and common spelling variants only when the full party root remains clearly the same.
Do not remove meaningful descriptors such as Steel, Metals, Alloys, Traders, Transport, Logistics, Engineering, Fabrication, Electricals, Industries, Services, and Works when they differentiate parties.
A named party ledger is preferred over a generic expense-category ledger when both are available.
Select an expense, statutory, payroll, or bank-related ledger only when the narration explicitly supports that category and exactly one existing ledger clearly fits.
Use suspense for generic narrations, only-reference rows, ambiguous merchants, self-transfers/reversals without a unique ledger, multiple plausible ledgers, best match below 0.90, or anything requiring guessing.`;

function resolvePdfJsWorkerSrc() {
  const candidates = [
    path.resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    path.resolve(process.cwd(), "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    path.resolve(process.cwd(), "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    path.resolve(process.cwd(), "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ];

  const existingPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existingPath) {
    throw new Error("Unable to locate pdfjs-dist worker file in node_modules.");
  }

  return pathToFileURL(existingPath).href;
}

const PDFJS_WORKER_SRC = resolvePdfJsWorkerSrc();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase environment variables are missing for the worker.");
}

if (!WORKER_SECRET) {
  throw new Error("WORKER_SECRET is required for the worker.");
}

if (!APP_BASE_URL) {
  throw new Error("APP_BASE_URL is required for the worker.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class JobMayStillBeRunningError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobMayStillBeRunningError";
  }
}

function isTerminalJobStatus(status) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error ?? "Unknown error");
}

function diagnosticError(error) {
  return formatError(error).slice(0, 500);
}

async function runWithConcurrency(items, concurrency, handler) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await handler(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeImageMimeType(mimeType) {
  const lower = String(mimeType || "").toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  if (lower.startsWith("image/")) return lower;
  return "image/jpeg";
}

function isProviderSafeImageMimeType(mimeType) {
  return ["image/jpeg", "image/png", "image/webp"].includes(normalizeImageMimeType(mimeType));
}

function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function renderedPageNumber(fileName) {
  const match = fileName.match(/-(\d+)\.png$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function textLineKey(y) {
  return String(Math.round(Number(y || 0) / 2) * 2);
}

function reconstructPdfTextLines(items) {
  const lines = new Map();
  for (const item of items) {
    const text = String(item?.str ?? "").trim();
    const transform = Array.isArray(item?.transform) ? item.transform : [];
    if (!text || transform.length < 6) continue;
    const x = Number(transform[4] ?? 0);
    const y = Number(transform[5] ?? 0);
    const key = textLineKey(y);
    const entries = lines.get(key) ?? [];
    entries.push({ x, text });
    lines.set(key, entries);
  }

  return [...lines.entries()]
    .sort((left, right) => Number(right[0]) - Number(left[0]))
    .map(([, entries]) =>
      entries
        .sort((left, right) => left.x - right.x)
        .map((entry) => entry.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}

async function extractBankStatementPdfTextPages(data, options = {}) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if ("GlobalWorkerOptions" in pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  }

  const pdf = await pdfjsLib.getDocument({
    data,
    disableWorker: true,
    useSystemFonts: true,
    verbosity: pdfjsLib.VerbosityLevel?.ERRORS,
  }).promise;
  const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : BANK_STATEMENT_MAX_TOTAL_PAGES;
  const pageCount = Math.min(pdf.numPages, Math.max(1, maxPages));
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    pages.push({
      pageNumber,
      text: reconstructPdfTextLines(textContent.items),
    });
  }

  return {
    pageCount: pdf.numPages,
    pages,
    truncated: pdf.numPages > pageCount,
  };
}

function hasUsableBankStatementText(pages) {
  const combined = pages
    .map((page) => (typeof page === "string" ? page : page?.text || ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  if (combined.length < 300) return false;
  return /\b(?:date|value date|description|narration|particulars)\b/i.test(combined) &&
    /\b(?:balance|deposit|withdrawal|debit|credit)\b/i.test(combined);
}

function formatBankStatementTextForAi(pages) {
  return pages
    .map((page, index) => {
      const pageNumber = typeof page === "object" && page ? page.pageNumber : index + 1;
      const text = typeof page === "string" ? page : page?.text;
      return `Page ${pageNumber}\n${text || "[No text extracted]"}`;
    })
    .join("\n\n---\n\n")
    .slice(0, BANK_STATEMENT_TEXT_PROMPT_MAX_CHARS);
}

function parseDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const [, year, month, day] = iso;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const indian = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (indian) {
    const [, day, month, yearRaw] = indian;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw) || /^-/.test(raw);
  const cleaned = raw.replace(/[(),₹$€£\s]/g, "").replace(/^-/, "");
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

function textCell(value) {
  return String(value ?? "").trim();
}

function firstTextCell(...values) {
  for (const value of values) {
    const text = textCell(value);
    if (text) return text;
  }
  return "";
}

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseName(value) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join(" ");
}

const COUNTERPARTY_PREFIXES = new Set([
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
  "from",
  "to",
  "by",
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

function cleanCounterpartyCandidate(value) {
  let cleaned = String(value ?? "")
    .replace(/\b(?:utr|ref|reference|invoice|bill|chq|cheque|txn|transaction)\b[\s:#/-]*[a-z0-9-]+.*$/i, "")
    .replace(/[^a-zA-Z0-9 .&'/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (let index = 0; index < 5; index += 1) {
    const match = cleaned.match(/^([a-z0-9]+)(?:\s+|[-:/._]+)(.+)$/i);
    if (!match) break;
    const prefix = match[1].toLowerCase();
    if (!COUNTERPARTY_PREFIXES.has(prefix) && !/^\d{4,}$/.test(prefix)) break;
    cleaned = match[2].trim();
  }

  return cleaned
    .split(/\s*[/|]\s*/)[0]
    .replace(/[-:/._\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCounterpartyName(description) {
  const raw = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const patterns = [
    /\b(?:neft|rtgs|imps)\s+(?:receipt\s+)?from\s+(.+?)(?:\s+(?:utr|ref|reference|a\/c|ac|account|ifsc|on)\b|$)/i,
    /\b(?:neft|rtgs|imps)\s+(?:payment\s+)?to\s+(.+?)(?:\s+(?:utr|ref|reference|a\/c|ac|account|ifsc|on)\b|$)/i,
    /\b(?:neft|rtgs|imps)\s+(.+?)(?:\s+(?:utr|ref|reference|a\/c|ac|account|ifsc|on)\b|$)/i,
    /\bupi\s+(?:payment\s+)?to\s+(.+?)(?:\s+(?:upi|ref|reference|txn|transaction|on)\b|$)/i,
    /\bupi\s+(?:receipt\s+)?from\s+(.+?)(?:\s+(?:upi|ref|reference|txn|transaction|on)\b|$)/i,
    /\bupi\s+(.+?)(?:\s+(?:upi|ref|reference|txn|transaction|on)\b|$)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const candidate = cleanCounterpartyCandidate(match?.[1]);
    if (candidate && normalizeName(candidate).length >= 3) return titleCaseName(candidate);
  }
  return null;
}

function detectTransactionType(description) {
  const text = String(description || "").toLowerCase();
  if (/\bupi\b/.test(text)) return "upi";
  if (/\bneft\b/.test(text)) return "neft";
  if (/\brtgs\b/.test(text)) return "rtgs";
  if (/\bimps\b/.test(text)) return "imps";
  if (/\bcheque|chq\b/.test(text)) return "cheque";
  if (/\bcash\b/.test(text)) return "cash";
  if (/\bcharge|charges|fee|gst\b/.test(text)) return "bank_charge";
  if (/\binterest\b/.test(text)) return "interest";
  return "unknown";
}

function detectCategory(description, debitAmount, creditAmount) {
  const text = String(description || "").toLowerCase();
  if (/\bcharge|charges|fee|gst\b/.test(text)) return "bank_charges";
  if (/\btax|tds|gst\b/.test(text)) return "tax";
  if (/\bsalary|wages\b/.test(text)) return "salary";
  if (/\bloan|emi\b/.test(text)) return "loan_or_emi";
  if (/\bself|own account|internal transfer|transfer to own\b/.test(text)) return "internal_transfer";
  if ((creditAmount ?? 0) > 0) return "receipt";
  if ((debitAmount ?? 0) > 0) return "payment";
  return "unknown";
}

function toMoneyNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function sameMoney(left, right) {
  return Math.abs(left - right) < 0.01;
}

function correctPreviewRowsFromRunningBalance(transactions) {
  let previousBalance = null;

  return transactions.map((transaction) => {
    const balance = toMoneyNumber(transaction.balance_amount);
    const debit = toMoneyNumber(transaction.debit_amount);
    const credit = toMoneyNumber(transaction.credit_amount);
    const amount = Math.max(debit && debit > 0 ? debit : 0, credit && credit > 0 ? credit : 0);
    let next = transaction;

    if (previousBalance !== null && balance !== null && amount > 0) {
      const delta = roundMoney(balance - previousBalance);
      const expectedAmount = roundMoney(Math.abs(delta));
      const hasDirectionMismatch =
        (delta > 0 && (!credit || !sameMoney(credit, expectedAmount) || (debit ?? 0) > 0)) ||
        (delta < 0 && (!debit || !sameMoney(debit, expectedAmount) || (credit ?? 0) > 0));

      if (!sameMoney(delta, 0) && sameMoney(expectedAmount, amount) && hasDirectionMismatch) {
        const correctedDebit = delta < 0 ? expectedAmount : null;
        const correctedCredit = delta > 0 ? expectedAmount : null;
        next = {
          ...transaction,
          debit_amount: correctedDebit,
          credit_amount: correctedCredit,
          category: detectCategory(transaction.description, correctedDebit, correctedCredit),
          confidence: Math.max(transaction.confidence ?? 0, 0.9),
          raw_payload: {
            ...(transaction.raw_payload ?? {}),
            balanceCorrection: {
              previousBalance,
              balanceAmount: balance,
              delta,
              originalDebitAmount: debit,
              originalCreditAmount: credit,
            },
          },
        };
      }
    }

    if (balance !== null) previousBalance = balance;
    return next;
  });
}

function safeJsonParse(raw, fallback) {
  try {
    const trimmed = String(raw || "").trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    const jsonString = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
    return JSON.parse(jsonString);
  } catch {
    return fallback;
  }
}

function normalizeIfscCode(value) {
  const normalized = String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return normalized.slice(0, 16);
}

function normalizeAccountNumber(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function maskAccountNumber(value) {
  const normalized = normalizeAccountNumber(value);
  if (!normalized) return "";
  if (normalized.length <= 4) return normalized;
  return `${"*".repeat(Math.max(0, normalized.length - 4))}${normalized.slice(-4)}`;
}

async function imageBytesToProviderDataUrl(data, mimeType, label) {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  const input = Buffer.from(data);
  if (input.byteLength <= BANK_STATEMENT_PROVIDER_IMAGE_TARGET_BYTES && isProviderSafeImageMimeType(normalizedMimeType)) {
    return bufferToDataUrl(input, normalizedMimeType);
  }

  let smallest = null;
  let lastError = null;
  for (const dimension of [BANK_STATEMENT_PROVIDER_IMAGE_MAX_DIMENSION, 2800, 2400, 2000, 1600, 1200]) {
    for (const quality of [86, 80, 74, 68, 62, 56]) {
      try {
        const output = await sharp(input, { failOn: "none" })
          .rotate()
          .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality, progressive: true, force: true })
          .toBuffer();
        if (!smallest || output.byteLength < smallest.byteLength) smallest = output;
        if (output.byteLength <= BANK_STATEMENT_PROVIDER_IMAGE_TARGET_BYTES) {
          return bufferToDataUrl(output, "image/jpeg");
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (smallest && smallest.byteLength <= BANK_STATEMENT_PROVIDER_IMAGE_HARD_LIMIT_BYTES) {
    return bufferToDataUrl(smallest, "image/jpeg");
  }
  if (input.byteLength <= BANK_STATEMENT_PROVIDER_IMAGE_HARD_LIMIT_BYTES && isProviderSafeImageMimeType(normalizedMimeType)) {
    return bufferToDataUrl(input, normalizedMimeType);
  }

  const reason = lastError instanceof Error ? lastError.message : "image remained above provider limit";
  throw new Error(`Unable to prepare "${label}" for bank statement extraction: ${reason}`);
}

async function renderBankStatementPdfToImages(data, sourceName, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-statement-pdf-"));
  const inputPath = path.join(tmpDir, "input.pdf");
  const outputPrefix = path.join(tmpDir, "page");
  const startPage = Math.max(1, Number(options.startPage ?? 1));
  const endPage = Math.max(startPage, Number(options.endPage ?? BANK_STATEMENT_AI_MAX_PAGES));

  try {
    fs.writeFileSync(inputPath, Buffer.from(data));
    await execFileAsync("pdftoppm", [
      "-r",
      String(BANK_STATEMENT_PDF_RENDER_DPI),
      "-png",
      "-f",
      String(startPage),
      "-l",
      String(endPage),
      inputPath,
      outputPrefix,
    ]);

    const pageFileNames = fs
      .readdirSync(tmpDir)
      .filter((fileName) => fileName.startsWith("page-") && fileName.endsWith(".png"))
      .sort((left, right) => renderedPageNumber(left) - renderedPageNumber(right));

    const images = [];
    for (const fileName of pageFileNames) {
      const bytes = fs.readFileSync(path.join(tmpDir, fileName));
      images.push(await imageBytesToProviderDataUrl(bytes, "image/png", `${sourceName} ${fileName}`));
    }
    return images;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function normalizeAiTransaction(value, rowNumber) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value;
  const transactionDate = parseDate(row.transactionDate ?? row.date ?? row.txnDate ?? row.postingDate);
  const description = firstTextCell(
    row.fullNarration,
    row["full narration"],
    row.bankNarration,
    row["bank narration"],
    row.transactionNarration,
    row["transaction narration"],
    row.description,
    row.narration,
    row.particulars,
    row.remarks,
    row.details,
    row.transactionDetails,
    row["transaction details"],
    row.transactionDescription,
    row["transaction description"],
    row.rawLine,
    row["raw line"]
  );
  if (!transactionDate || !description) return null;

  const debitAmount = parseAmount(row.debitAmount ?? row.debit ?? row.withdrawal ?? row.paidOut);
  const creditAmount = parseAmount(row.creditAmount ?? row.credit ?? row.deposit ?? row.paidIn);
  const balanceAmount = parseAmount(row.balanceAmount ?? row.balance ?? row.runningBalance ?? row.closingBalance);
  const transactionType = textCell(row.transactionType) || detectTransactionType(description);
  const category = textCell(row.category) || detectCategory(description, debitAmount, creditAmount);
  const cleanedCounterpartyName = cleanCounterpartyCandidate(row.counterpartyName);
  const counterpartyName =
    (cleanedCounterpartyName && normalizeName(cleanedCounterpartyName).length >= 3
      ? titleCaseName(cleanedCounterpartyName)
      : null) || extractCounterpartyName(description);

  return {
    row_index: rowNumber,
    transaction_date: transactionDate,
    value_date: parseDate(row.valueDate) ?? transactionDate,
    description,
    reference_number: textCell(row.referenceNumber ?? row.reference ?? row.utr ?? row.chequeNumber) || null,
    debit_amount: debitAmount,
    credit_amount: creditAmount,
    balance_amount: balanceAmount,
    transaction_type: transactionType,
    category,
    counterparty_name: counterpartyName,
    suggested_ledger_name: textCell(row.suggestedLedgerName) || null,
    suggestion_confidence:
      typeof row.suggestionConfidence === "number" && Number.isFinite(row.suggestionConfidence)
        ? Math.max(0, Math.min(1, row.suggestionConfidence))
        : null,
    suggestion_reason: textCell(row.suggestionReason) || null,
    confirmed_ledger_name: textCell(row.confirmedLedgerName) || null,
    additional_charges: transactionType === "bank_charge" ? [{ type: "bank_charge", amount: debitAmount }] : [],
    confidence:
      typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? Math.max(0, Math.min(1, row.confidence))
        : 0.78,
    raw_payload: { rowNumber, source: "openrouter_bank_statement_v1", row },
  };
}

function normalizeAiBankStatement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      account: { bankName: null, accountNumber: null, accountHolderName: null, ifscCode: null },
      statementPeriodStart: null,
      statementPeriodEnd: null,
      transactions: [],
    };
  }
  const parsed = value;
  const account = parsed.account && typeof parsed.account === "object" && !Array.isArray(parsed.account)
    ? parsed.account
    : parsed;
  const transactions = Array.isArray(parsed.transactions)
    ? parsed.transactions.flatMap((row, index) => {
        const transaction = normalizeAiTransaction(row, index + 1);
        return transaction ? [transaction] : [];
      })
    : [];

  return {
    account: {
      bankName: textCell(account.bankName ?? parsed.bankName) || null,
      accountNumber: textCell(account.accountNumber ?? parsed.accountNumber) || null,
      accountHolderName: textCell(account.accountHolderName ?? account.accountName ?? parsed.accountHolderName) || null,
      ifscCode: normalizeIfscCode(textCell(account.ifscCode ?? parsed.ifscCode)) || null,
    },
    statementPeriodStart: parseDate(parsed.statementPeriodStart) ?? parseDate(parsed.periodStart),
    statementPeriodEnd: parseDate(parsed.statementPeriodEnd) ?? parseDate(parsed.periodEnd),
    transactions: correctPreviewRowsFromRunningBalance(transactions),
  };
}

function bankAccountNumberFromTallyLedger(ledger) {
  const raw = ledger?.raw_payload && typeof ledger.raw_payload === "object" && !Array.isArray(ledger.raw_payload)
    ? ledger.raw_payload
    : {};
  const explicit = textCell(raw.bankAccountNumber ?? raw.accountNumber ?? raw.account_number)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  if (explicit) return explicit;
  const numbers = Array.from(new Set((textCell(ledger?.tally_name).match(/\d{6,18}/g) ?? [])));
  return numbers.length === 1 ? numbers[0] : "";
}

async function getTallyBankAccountCandidates(ownerUserId, connectionId) {
  if (!connectionId) return [];
  const { data, error } = await supabase
    .from("tally_masters")
    .select("tally_name, parent_name, raw_payload")
    .eq("owner_user_id", ownerUserId)
    .eq("connection_id", connectionId)
    .eq("master_type", "ledger")
    .eq("is_active", true)
    .limit(5000);
  if (error) throw error;

  return (data ?? []).flatMap((ledger) => {
    const parent = textCell(ledger.parent_name).toLowerCase();
    const accountNumber = bankAccountNumberFromTallyLedger(ledger);
    if (!/\bbank\s+accounts?\b/.test(parent) || !accountNumber) return [];
    return [{ ledgerName: textCell(ledger.tally_name), accountNumber }];
  });
}

function bankAccountCandidateInstruction(candidates = []) {
  if (candidates.length === 0) return "";
  return (
    " The verified Tally company has these posting bank ledgers: " +
    JSON.stringify(candidates) +
    ". Use this list only to validate the statement account. If the visible statement account number exactly matches one candidate, return that candidate's accountNumber and the bank name visible in its ledger name. Never choose a candidate from bank name alone, and never invent an account number."
  );
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isHardQuotaError(message) {
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("limit: 0") ||
    lower.includes("quota exceeded") ||
    lower.includes("billing") ||
    lower.includes("insufficient credits")
  );
}

async function callOpenRouterForBankStatement(messages) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  let attempt = 0;
  let lastError = "OpenRouter request failed";
  while (attempt <= OPENROUTER_MAX_RETRIES) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_BASE_URL || "http://localhost:3001",
          "X-Title": "Gajkesari Workflow Bank Statement Worker",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages,
          temperature: 0,
          reasoning:
            Number.isFinite(OPENROUTER_QUALITY_REASONING_TOKENS) && OPENROUTER_QUALITY_REASONING_TOKENS > 0
              ? { max_tokens: OPENROUTER_QUALITY_REASONING_TOKENS, exclude: true }
              : undefined,
          response_format: { type: "json_object" },
          max_tokens:
            Number.isFinite(OPENROUTER_MAX_OUTPUT_TOKENS) && OPENROUTER_MAX_OUTPUT_TOKENS > 0
              ? Math.floor(OPENROUTER_MAX_OUTPUT_TOKENS)
              : undefined,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) {
        const errorText =
          payload?.error?.message ||
          payload?.message ||
          (response.ok ? "OpenRouter returned an error payload" : `OpenRouter request failed (${response.status})`);
        lastError = errorText;
        if (!isRetryableStatus(response.status) || isHardQuotaError(errorText) || attempt === OPENROUTER_MAX_RETRIES) {
          throw new Error(errorText);
        }
        await sleep(OPENROUTER_RETRY_BASE_MS * Math.pow(2, attempt));
        attempt += 1;
        continue;
      }

      const message = payload?.choices?.[0]?.message?.content;
      return Array.isArray(message) ? message.map((part) => part?.text || "").join("\n") : String(message || "");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error ?? "Unknown error");
      if (attempt === OPENROUTER_MAX_RETRIES) {
        throw new Error(lastError);
      }
      await sleep(OPENROUTER_RETRY_BASE_MS * Math.pow(2, attempt));
      attempt += 1;
    }
  }

  throw new Error(lastError);
}

async function callOpenRouterForLedgerMatching(messages) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  let attempt = 0;
  let lastError = "OpenRouter ledger matching request failed";
  while (attempt <= OPENROUTER_MAX_RETRIES) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_BASE_URL || "http://localhost:3001",
          "X-Title": "Gajkesari Workflow Bank Ledger Matching",
        },
        body: JSON.stringify({
          model: OPENROUTER_BANK_LEDGER_MODEL,
          messages,
          temperature: 0,
          response_format: { type: "json_object" },
          max_tokens:
            Number.isFinite(OPENROUTER_BANK_LEDGER_MAX_OUTPUT_TOKENS) && OPENROUTER_BANK_LEDGER_MAX_OUTPUT_TOKENS > 0
              ? Math.floor(OPENROUTER_BANK_LEDGER_MAX_OUTPUT_TOKENS)
              : undefined,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) {
        const errorText =
          payload?.error?.message ||
          payload?.message ||
          (response.ok ? "OpenRouter returned an error payload" : `OpenRouter request failed (${response.status})`);
        lastError = errorText;
        if (!isRetryableStatus(response.status) || isHardQuotaError(errorText) || attempt === OPENROUTER_MAX_RETRIES) {
          throw new Error(errorText);
        }
        await sleep(OPENROUTER_RETRY_BASE_MS * Math.pow(2, attempt));
        attempt += 1;
        continue;
      }

      const message = payload?.choices?.[0]?.message?.content;
      return Array.isArray(message) ? message.map((part) => part?.text || "").join("\n") : String(message || "");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error ?? "Unknown error");
      if (attempt === OPENROUTER_MAX_RETRIES) {
        throw new Error(lastError);
      }
      await sleep(OPENROUTER_RETRY_BASE_MS * Math.pow(2, attempt));
      attempt += 1;
    }
  }

  throw new Error(lastError);
}

function findLedgerNameByNormalized(ledgerNames, ledgerName) {
  const normalized = normalizeName(ledgerName);
  if (!normalized) return null;
  return ledgerNames.find((name) => normalizeName(name) === normalized) || null;
}

async function applyAiLedgerSuggestionsToPreviewRows({ ownerUserId, connectionId, rows }) {
  if (!connectionId || rows.length === 0) return rows;

  const { data: ledgerRows, error: ledgerError } = await supabase
    .from("tally_masters")
    .select("tally_name, parent_name")
    .eq("owner_user_id", ownerUserId)
    .eq("connection_id", connectionId)
    .eq("master_type", "ledger")
    .eq("is_active", true)
    .limit(5000);

  if (ledgerError) throw ledgerError;

  const ledgers = (ledgerRows ?? []).flatMap((ledger) => {
    const name = textCell(ledger?.tally_name);
    return name ? [{ name, group: textCell(ledger?.parent_name) || null }] : [];
  });
  if (ledgers.length === 0) return rows;

  const raw = await callOpenRouterForLedgerMatching([
    { role: "system", content: BANK_LEDGER_MATCHING_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        tallyLedgers: ledgers,
        transactions: rows.map((row, index) => ({
          index,
          transactionDate: row.transaction_date,
          description: row.description,
          referenceNumber: row.reference_number,
          debitAmount: row.debit_amount,
          creditAmount: row.credit_amount,
          transactionType: row.transaction_type,
          category: row.category,
          counterpartyName: row.counterparty_name,
        })),
      }),
    },
  ]);

  const parsed = safeJsonParse(raw, {});
  const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
  const ledgerNames = ledgers.map((ledger) => ledger.name);
  const matchByIndex = new Map(
    matches
      .filter((match) => match && typeof match === "object" && Number.isInteger(Number(match.index)))
      .map((match) => [Number(match.index), match])
  );

  return rows.map((row, index) => {
    const match = matchByIndex.get(index);
    if (!match) return row;

    const candidateLedgerNames = Array.isArray(match.candidateLedgerNames)
      ? match.candidateLedgerNames
          .map((name) => findLedgerNameByNormalized(ledgerNames, name))
          .filter(Boolean)
      : [];
    const confidence = Math.max(0, Math.min(1, Number(match.confidence) || 0));
    const reason = textCell(match.reason) || "AI ledger matching completed.";
    const rawPayload = row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload)
      ? row.raw_payload
      : {};

    if (
      match.matchType === "direct_match" &&
      match.action === "use_existing_ledger" &&
      confidence >= 0.9
    ) {
      const ledgerName = findLedgerNameByNormalized(ledgerNames, match.ledgerName);
      if (ledgerName) {
        return {
          ...row,
          suggested_ledger_name: ledgerName,
          suggestion_confidence: confidence,
          suggestion_reason: reason,
          raw_payload: {
            ...rawPayload,
            aiLedgerRecommendation: {
              matchType: "direct_match",
              action: "use_existing_ledger",
              ledgerName,
              candidateLedgerNames: [],
              confidence,
              reason,
              model: OPENROUTER_BANK_LEDGER_MODEL,
            },
          },
        };
      }
    }

    return {
      ...row,
      suggested_ledger_name: null,
      suggestion_confidence: 0,
      suggestion_reason: reason,
      raw_payload: {
        ...rawPayload,
        aiLedgerRecommendation: {
          matchType: match.matchType === "close_match" && candidateLedgerNames.length >= 2 ? "close_match" : "suspense",
          action: "use_suspense",
          ledgerName: null,
          candidateLedgerNames,
          confidence: 0,
          reason,
          model: OPENROUTER_BANK_LEDGER_MODEL,
        },
      },
    };
  });
}

async function extractBankStatementFromImages(fileName, images, bankAccountCandidates = []) {
  if (images.length === 0) {
    return {
      account: { bankName: null, accountNumber: null, accountHolderName: null, ifscCode: null },
      statementPeriodStart: null,
      statementPeriodEnd: null,
      transactions: [],
    };
  }

  const raw = await callOpenRouterForBankStatement([
    {
      role: "system",
      content:
        "Extract bank statement account details and transaction rows. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, and transactions. " +
        "account must include bankName, accountNumber, accountHolderName, and ifscCode when visible. Dates must be ISO YYYY-MM-DD. " +
        "Each transaction must include transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, balanceAmount, transactionType, category, counterpartyName, and confidence. " +
        "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. Do not shorten description to only the party name, and do not include date/value-date/debit/credit/balance columns in description. " +
        "counterpartyName must be only the real party/vendor/customer name, separate from the full description. Remove payment modes, bank/channel prefixes, CR/DR markers, account numbers, UTR/ref/invoice/bill text, and bank names from counterpartyName. For example, description NEFT CR-HDFC-BHARAT LTD / INVOICE BL-801 should produce counterpartyName BHARAT LTD; UPI/9188201001/ORION TOOLING CENTRE should produce ORION TOOLING CENTRE. Use numbers for amounts, with debit and credit as positive values in their own columns. Do not invent rows. Preserve narration text exactly enough for audit matching. " +
        "If a page contains only summary information and no ledger rows, extract account/period only and leave transactions empty." +
        bankAccountCandidateInstruction(bankAccountCandidates),
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Extract bank statement data from ${fileName}.` },
        ...images.map((image) => ({ type: "image_url", image_url: { url: image } })),
      ],
    },
  ]);

  return normalizeAiBankStatement(safeJsonParse(raw, {}));
}

async function extractBankStatementFromPdfFile(fileName, mimeType, bytes, bankAccountCandidates = []) {
  const fileData = Buffer.from(bytes).toString("base64");
  const raw = await callOpenRouterForBankStatement([
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            filename: fileName,
            file_data: `data:${mimeType || "application/pdf"};base64,${fileData}`,
          },
        },
        {
          type: "text",
          text:
            "Extract bank statement account details and transaction rows from the attached PDF. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, and transactions. " +
            "account must include bankName, accountNumber, accountHolderName, and ifscCode when visible. Dates must be ISO YYYY-MM-DD. " +
            "Each transaction must include transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, balanceAmount, transactionType, category, counterpartyName, and confidence. " +
            "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. Do not shorten description to only the party name, and do not include date/value-date/debit/credit/balance columns in description. " +
            "counterpartyName must be only the real party/vendor/customer name, separate from the full description. Remove payment modes, bank/channel prefixes, CR/DR markers, account numbers, UTR/ref/invoice/bill text, and bank names from counterpartyName. For example, description NEFT CR-HDFC-BHARAT LTD / INVOICE BL-801 should produce counterpartyName BHARAT LTD; UPI/9188201001/ORION TOOLING CENTRE should produce ORION TOOLING CENTRE. Use numbers for amounts, with debit and credit as positive values in their own columns. Preserve multi-line narration text in the description. " +
            "Rows may continue on following lines without a date; attach those continuation lines to the previous dated transaction. " +
            "Do not treat BALANCE FORWARD, page footers, insurance notices, reward-points sections, summary totals, or opening/closing balance-only lines as transactions. " +
            "Do not invent rows or amounts. If the PDF contains only summary information and no ledger rows, extract account/period only and leave transactions empty." +
            bankAccountCandidateInstruction(bankAccountCandidates),
        },
      ],
    },
  ]);

  return normalizeAiBankStatement(safeJsonParse(raw, {}));
}

async function extractBankStatementFromText(fileName, pages, bankAccountCandidates = []) {
  const raw = await callOpenRouterForBankStatement([
    {
      role: "system",
      content:
        "Extract bank statement account details and transaction rows from PDF text. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, and transactions. " +
        "account must include bankName, accountNumber, accountHolderName, and ifscCode when visible. Dates must be ISO YYYY-MM-DD. " +
        "Each transaction must include transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, balanceAmount, transactionType, category, counterpartyName, and confidence. " +
        "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. Do not shorten description to only the party name, and do not include date/value-date/debit/credit/balance columns in description. " +
        "counterpartyName must be only the real party/vendor/customer name, separate from the full description. Remove payment modes, bank/channel prefixes, CR/DR markers, account numbers, UTR/ref/invoice/bill text, and bank names from counterpartyName. For example, description NEFT CR-HDFC-BHARAT LTD / INVOICE BL-801 should produce counterpartyName BHARAT LTD; UPI/9188201001/ORION TOOLING CENTRE should produce ORION TOOLING CENTRE. Use numbers for amounts, with debit and credit as positive values in their own columns. Preserve multi-line narration text in the description. " +
        "Rows may continue on following lines without a date; attach those continuation lines to the previous dated transaction. " +
        "Do not treat BALANCE FORWARD, page footers, insurance notices, reward-points sections, summary totals, or opening/closing balance-only lines as transactions. " +
        "Do not invent rows or amounts. If the text is only summary information and no ledger rows are present, extract account/period only and leave transactions empty." +
        bankAccountCandidateInstruction(bankAccountCandidates),
    },
    {
      role: "user",
      content: `Extract bank statement data from ${fileName} using this text:\n\n${formatBankStatementTextForAi(pages)}`,
    },
  ]);

  return normalizeAiBankStatement(safeJsonParse(raw, {}));
}

function mergeBankStatementResults(results) {
  const merged = normalizeAiBankStatement({});
  const seenTransactions = new Set();
  for (const result of results) {
    if (!result) continue;
    merged.account = {
      bankName: merged.account.bankName || result.account.bankName || null,
      accountNumber: merged.account.accountNumber || result.account.accountNumber || null,
      accountHolderName: merged.account.accountHolderName || result.account.accountHolderName || null,
      ifscCode: merged.account.ifscCode || result.account.ifscCode || null,
    };
    merged.statementPeriodStart = merged.statementPeriodStart || result.statementPeriodStart || null;
    merged.statementPeriodEnd = merged.statementPeriodEnd || result.statementPeriodEnd || null;
    for (const transaction of result.transactions) {
      const key = [
        transaction.transaction_date,
        normalizeName(transaction.description),
        normalizeName(transaction.reference_number),
        transaction.debit_amount ?? "",
        transaction.credit_amount ?? "",
        transaction.balance_amount ?? "",
      ].join("|");
      if (seenTransactions.has(key)) continue;
      seenTransactions.add(key);
      merged.transactions.push(transaction);
    }
  }
  merged.transactions = correctPreviewRowsFromRunningBalance(merged.transactions);
  return merged;
}

function likelyHasTransactionRows(page) {
  const text = String(typeof page === "string" ? page : page?.text || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  const hasAmount = /(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}|(?:\d{1,3}(?:,\d{2,3})+|\d+)\b/.test(text);
  const hasDate =
    /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(text) ||
    /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\b/.test(text) ||
    /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.test(text);
  const hasStatementWords = /\b(?:neft|rtgs|imps|upi|deposit|withdrawal|debit|credit|balance|particulars|narration)\b/i.test(text);
  return hasAmount && (hasDate || hasStatementWords);
}

function pageRangeLabel(pages) {
  const first = pages[0]?.pageNumber ?? 1;
  const last = pages[pages.length - 1]?.pageNumber ?? first;
  return first === last ? `page ${first}` : `pages ${first}-${last}`;
}

function chunkPages(pages, size) {
  const chunks = [];
  for (let index = 0; index < pages.length; index += size) {
    chunks.push(pages.slice(index, index + size));
  }
  return chunks;
}

function lastItem(items) {
  return items[items.length - 1];
}

async function extractBankStatementFromTextBatch(fileName, pages) {
  const raw = await callOpenRouterForBankStatement([
    {
      role: "system",
      content:
        "Extract bank statement account details and transaction rows from a batch of PDF text pages. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, and transactions. " +
        "account must include bankName, accountNumber, accountHolderName, and ifscCode when visible. Dates must be ISO YYYY-MM-DD. " +
        "Each transaction must include transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, balanceAmount, transactionType, category, counterpartyName, and confidence. " +
        "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. Do not shorten description to only the party name, and do not include date/value-date/debit/credit/balance columns in description. " +
        "counterpartyName must be only the real party/vendor/customer name, separate from the full description. Remove payment modes, bank/channel prefixes, CR/DR markers, account numbers, UTR/ref/invoice/bill text, and bank names from counterpartyName. " +
        "Rows may continue on following lines without a date; attach those continuation lines to the previous dated transaction. " +
        "Ignore BALANCE FORWARD, OPENING BALANCE, CLOSING BALANCE, page footers, reward-points sections, summary totals, and bank notices unless they have a real debit or credit transaction amount. " +
        "Do not invent rows. If this batch contains only summary/header information and no ledger rows, return account/period if visible and an empty transactions array.",
    },
    {
      role: "user",
      content: `Extract ${pageRangeLabel(pages)} from ${fileName}:\n\n${formatBankStatementTextForAi(pages)}`,
    },
  ]);

  return normalizeAiBankStatement(safeJsonParse(raw, {}));
}

async function extractBankStatementFromImageBatch(fileName, images, rangeLabel) {
  if (images.length === 0) return normalizeAiBankStatement({});
  const raw = await callOpenRouterForBankStatement([
    {
      role: "system",
      content:
        "Extract bank statement account details and transaction rows from these rendered statement pages. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, and transactions. " +
        "Dates must be ISO YYYY-MM-DD. Each transaction must include transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, balanceAmount, transactionType, category, counterpartyName, and confidence. " +
        "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. counterpartyName must be only the party/vendor/customer name. " +
        "Ignore BALANCE FORWARD, OPENING BALANCE, CLOSING BALANCE, summary totals, page footers, and bank notices. Do not invent rows.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Extract ${rangeLabel} from ${fileName}.` },
        ...images.map((image) => ({ type: "image_url", image_url: { url: image } })),
      ],
    },
  ]);

  return normalizeAiBankStatement(safeJsonParse(raw, {}));
}

async function callWithBatchRetries(label, handler) {
  let lastError = null;
  for (let attempt = 0; attempt <= BANK_STATEMENT_BATCH_RETRY_LIMIT; attempt += 1) {
    try {
      return await handler(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < BANK_STATEMENT_BATCH_RETRY_LIMIT) {
        await sleep(OPENROUTER_RETRY_BASE_MS * Math.pow(2, attempt));
      }
    }
  }
  throw new Error(`${label} failed: ${diagnosticError(lastError)}`);
}

async function extractBankStatementTextBatches(fileName, pages, jobId) {
  const batches = chunkPages(pages, BANK_STATEMENT_BATCH_PAGE_SIZE);
  const diagnostics = [];
  const failedBatches = [];
  const results = await runWithConcurrency(batches, BANK_STATEMENT_BATCH_CONCURRENCY, async (batch, index) => {
    const label = pageRangeLabel(batch);
    const hasLikelyRows = batch.some(likelyHasTransactionRows);
    if (!hasLikelyRows && !hasUsableBankStatementText(batch)) {
      diagnostics[index] = {
        startPage: batch[0]?.pageNumber,
        endPage: lastItem(batch)?.pageNumber,
        status: "skipped",
        rowCount: 0,
      };
      return null;
    }

    try {
      const parsed = await callWithBatchRetries(label, () => extractBankStatementFromTextBatch(fileName, batch));
      diagnostics[index] = {
        startPage: batch[0]?.pageNumber,
        endPage: lastItem(batch)?.pageNumber,
        status: parsed.transactions.length > 0 ? "succeeded" : "empty",
        rowCount: parsed.transactions.length,
      };
      if (parsed.transactions.length === 0 && hasLikelyRows) {
        failedBatches.push({ pages: batch, reason: "empty" });
      }
      const completed = diagnostics.filter(Boolean).length;
      await updateBankJob(jobId, {
        progress: Math.min(70, 35 + Math.round((completed / Math.max(1, batches.length)) * 30)),
        stage: `Analyzing statement batches ${completed}/${batches.length}`,
      });
      return parsed;
    } catch (error) {
      diagnostics[index] = {
        startPage: batch[0]?.pageNumber,
        endPage: lastItem(batch)?.pageNumber,
        status: "failed",
        rowCount: 0,
        error: diagnosticError(error),
      };
      failedBatches.push({ pages: batch, reason: "failed" });
      return null;
    }
  });

  return {
    parsed: mergeBankStatementResults(results),
    diagnostics,
    failedBatches,
  };
}

async function extractBankStatementImageBatches(fileName, bytes, pageCount, jobId) {
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
  const ranges = chunkPages(pageNumbers.map((pageNumber) => ({ pageNumber })), BANK_STATEMENT_BATCH_PAGE_SIZE);
  const diagnostics = [];
  const failedBatches = [];
  const results = await runWithConcurrency(ranges, BANK_STATEMENT_BATCH_CONCURRENCY, async (range, index) => {
    const startPage = range[0].pageNumber;
    const endPage = lastItem(range).pageNumber;
    const label = startPage === endPage ? `page ${startPage}` : `pages ${startPage}-${endPage}`;
    try {
      const parsed = await callWithBatchRetries(label, async () => {
        const images = await renderBankStatementPdfToImages(bytes, fileName, { startPage, endPage });
        return extractBankStatementFromImageBatch(fileName, images, label);
      });
      diagnostics[index] = {
        startPage,
        endPage,
        status: parsed.transactions.length > 0 ? "succeeded" : "empty",
        rowCount: parsed.transactions.length,
      };
      if (parsed.transactions.length === 0) {
        failedBatches.push({ pages: range, reason: "empty" });
      }
      const completed = diagnostics.filter(Boolean).length;
      await updateBankJob(jobId, {
        progress: Math.min(70, 35 + Math.round((completed / Math.max(1, ranges.length)) * 30)),
        stage: `Analyzing rendered page batches ${completed}/${ranges.length}`,
      });
      return parsed;
    } catch (error) {
      diagnostics[index] = { startPage, endPage, status: "failed", rowCount: 0, error: diagnosticError(error) };
      failedBatches.push({ pages: range, reason: "failed" });
      return null;
    }
  });

  return {
    parsed: mergeBankStatementResults(results),
    diagnostics,
    failedBatches,
  };
}

async function recoverSinglePages({ fileName, bytes, textPagesByNumber, failedBatches, jobId }) {
  const pageMap = new Map();
  for (const batch of failedBatches) {
    for (const page of batch.pages) {
      const pageNumber = page.pageNumber;
      if (!pageMap.has(pageNumber)) {
        pageMap.set(pageNumber, textPagesByNumber.get(pageNumber) ?? { pageNumber, text: "" });
      }
    }
  }
  const pages = [...pageMap.values()]
    .filter((page) => likelyHasTransactionRows(page) || !String(page.text || "").trim())
    .slice(0, BANK_STATEMENT_SINGLE_PAGE_RECOVERY_LIMIT);
  if (pages.length === 0) {
    return { parsed: normalizeAiBankStatement({}), diagnostics: [] };
  }

  const diagnostics = [];
  const results = await runWithConcurrency(pages, BANK_STATEMENT_BATCH_CONCURRENCY, async (page, index) => {
    try {
      const parsed = await callWithBatchRetries(`recovery page ${page.pageNumber}`, async () => {
        if (String(page.text || "").trim()) {
          return extractBankStatementFromTextBatch(fileName, [page]);
        }
        const images = await renderBankStatementPdfToImages(bytes, fileName, {
          startPage: page.pageNumber,
          endPage: page.pageNumber,
        });
        return extractBankStatementFromImageBatch(fileName, images, `page ${page.pageNumber}`);
      });
      diagnostics[index] = {
        page: page.pageNumber,
        status: parsed.transactions.length > 0 ? "succeeded" : "empty",
        rowCount: parsed.transactions.length,
      };
      const completed = diagnostics.filter(Boolean).length;
      await updateBankJob(jobId, {
        progress: Math.min(74, 70 + Math.round((completed / Math.max(1, pages.length)) * 4)),
        stage: `Recovering difficult pages ${completed}/${pages.length}`,
      });
      return parsed;
    } catch (error) {
      diagnostics[index] = { page: page.pageNumber, status: "failed", rowCount: 0, error: diagnosticError(error) };
      return null;
    }
  });

  return {
    parsed: mergeBankStatementResults(results),
    diagnostics,
  };
}

async function extractBankStatementAdaptive({ fileName, mimeType, bytes, isPdf, isImage, jobId, bankAccountCandidates = [] }) {
  const diagnostics = {
    pipeline: null,
    pageCount: isImage ? 1 : null,
    singleShotAttempted: false,
    singleShotRows: 0,
    batchSize: BANK_STATEMENT_BATCH_PAGE_SIZE,
    batchConcurrency: BANK_STATEMENT_BATCH_CONCURRENCY,
    batches: [],
    recovery: [],
    errors: [],
  };
  let parsed = null;
  let extractionSource = "none";
  let extractionError = null;
  let textInfo = { pages: [], pageCount: isImage ? 1 : 0, truncated: false };

  if (isPdf) {
    try {
      textInfo = await extractBankStatementPdfTextPages(bytes);
      diagnostics.pageCount = textInfo.pageCount;
      diagnostics.textPagesExtracted = textInfo.pages.length;
      diagnostics.textExtractionTruncated = textInfo.truncated;
    } catch (error) {
      diagnostics.errors.push({ stage: "pdf_text_extraction", error: diagnosticError(error) });
      console.warn(`[worker] PDF text extraction skipped for ${fileName}: ${diagnosticError(error)}`);
    }
  }

  const canUseSingleShot = !isPdf || Number(textInfo.pageCount || 0) <= BANK_STATEMENT_SINGLE_SHOT_MAX_PAGES;
  if (canUseSingleShot) {
    diagnostics.singleShotAttempted = true;
    try {
      await updateBankJob(jobId, { progress: 45, stage: "Running single-shot AI extraction" });
      if (isPdf && hasUsableBankStatementText(textInfo.pages)) {
        parsed = await extractBankStatementFromText(fileName, textInfo.pages, bankAccountCandidates);
        extractionSource = "single_shot_ai_pdf_text";
      } else if (isPdf) {
        parsed = await extractBankStatementFromPdfFile(fileName, mimeType || "application/pdf", bytes, bankAccountCandidates);
        extractionSource = "single_shot_ai_pdf_file";
      } else if (isImage) {
        const image = await imageBytesToProviderDataUrl(bytes, mimeType || "image/jpeg", fileName);
        parsed = await extractBankStatementFromImages(fileName, [image], bankAccountCandidates);
        extractionSource = "single_shot_ai_image";
      }
      diagnostics.singleShotRows = parsed?.transactions.length ?? 0;
      if (parsed && parsed.transactions.length > 0) {
        diagnostics.pipeline = "single_shot_ai";
        return { parsed, extractionSource, extractionError: null, diagnostics };
      }
    } catch (error) {
      diagnostics.errors.push({ stage: "single_shot_ai", error: diagnosticError(error) });
      console.warn(`[worker] single-shot AI extraction skipped for ${fileName}: ${diagnosticError(error)}`);
    }
  }

  if (!isPdf) {
    diagnostics.pipeline = "manual_review_required";
    extractionError =
      lastItem(diagnostics.errors)?.error || "No transaction rows were extracted from the image.";
    return { parsed: parsed ?? normalizeAiBankStatement({}), extractionSource, extractionError, diagnostics };
  }

  const textPages = textInfo.pages ?? [];
  const textPagesByNumber = new Map(textPages.map((page) => [page.pageNumber, page]));
  const pageCount = Math.min(Number(textInfo.pageCount || textPages.length || 0), BANK_STATEMENT_MAX_TOTAL_PAGES);

  try {
    await updateBankJob(jobId, { progress: 35, stage: "Running batched AI extraction" });
    let batchResult;
    if (hasUsableBankStatementText(textPages)) {
      batchResult = await extractBankStatementTextBatches(fileName, textPages, jobId);
      extractionSource = "batched_ai_pdf_text";
    } else {
      batchResult = await extractBankStatementImageBatches(fileName, bytes, pageCount, jobId);
      extractionSource = "batched_ai_pdf_images";
    }

    diagnostics.pipeline = "batched_ai";
    diagnostics.batches = batchResult.diagnostics;
    parsed = batchResult.parsed;

    if (batchResult.failedBatches.length > 0 && BANK_STATEMENT_SINGLE_PAGE_RECOVERY_LIMIT > 0) {
      await updateBankJob(jobId, { progress: 70, stage: "Recovering difficult pages" });
      const recovery = await recoverSinglePages({
        fileName,
        bytes,
        textPagesByNumber,
        failedBatches: batchResult.failedBatches,
        jobId,
      });
      diagnostics.pipeline = "single_page_recovery";
      diagnostics.recovery = recovery.diagnostics;
      parsed = mergeBankStatementResults([parsed, recovery.parsed]);
    }

    if (parsed.transactions.length > 0) {
      return { parsed, extractionSource, extractionError: null, diagnostics };
    }
  } catch (error) {
    diagnostics.errors.push({ stage: "batched_ai", error: diagnosticError(error) });
    console.warn(`[worker] batched AI extraction failed for ${fileName}: ${diagnosticError(error)}`);
  }

  diagnostics.pipeline = "manual_review_required";
  extractionError =
    lastItem(diagnostics.errors)?.error ||
    "No transaction rows were extracted. The file may need manual review or a clearer scan.";
  return {
    parsed: parsed ?? normalizeAiBankStatement({}),
    extractionSource: extractionSource === "none" ? "manual_review_required" : extractionSource,
    extractionError,
    diagnostics,
  };
}

async function updateBankJob(jobId, fields) {
  const { error } = await supabase
    .from("bank_statement_extraction_jobs")
    .update(fields)
    .eq("id", jobId);
  if (error) throw error;
}

async function claimNextBankStatementJob() {
  const { data, error } = await supabase.rpc("claim_bank_statement_extraction_job", {
    worker_name: WORKER_NAME,
    stale_after: WORKER_STALE_RUNNING_JOB_INTERVAL,
  });

  if (error) {
    const message = error instanceof Error ? error.message : String(error?.message ?? error ?? "");
    if (message.includes("claim_bank_statement_extraction_job")) {
      return null;
    }
    throw error;
  }

  const claimedJob = Array.isArray(data) ? data[0] : data;
  return claimedJob?.id ? claimedJob : null;
}

async function getBankJob(jobId) {
  const { data, error } = await supabase
    .from("bank_statement_extraction_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function requeueBankJob(jobId, errorMessage) {
  const job = await getBankJob(jobId);
  if (!job || isTerminalJobStatus(job.status)) return;
  if (Number(job.attempt_count ?? 0) >= Number(job.max_attempts ?? 3)) {
    await updateBankJob(jobId, {
      status: "failed",
      progress: 100,
      stage: "Failed",
      error: errorMessage,
      locked_at: null,
      locked_by: null,
      finished_at: new Date().toISOString(),
    });
    await supabase
      .from("bank_statement_imports")
      .update({
        status: "failed",
        processing_meta: {
          jobStatus: "failed",
          extractionError: errorMessage,
          failedAt: new Date().toISOString(),
        },
      })
      .eq("id", job.import_id)
      .eq("owner_user_id", job.owner_user_id);
    return;
  }
  await updateBankJob(jobId, {
    status: "queued",
    progress: 0,
    stage: "Queued after worker failure",
    error: errorMessage,
    locked_at: null,
    locked_by: null,
    next_run_at: new Date(Date.now() + WORKER_POLL_INTERVAL_MS).toISOString(),
  });
}

async function runBankStatementJob(job) {
  const { data: importRow, error: importError } = await supabase
    .from("bank_statement_imports")
    .select("*")
    .eq("id", job.import_id)
    .eq("owner_user_id", job.owner_user_id)
    .maybeSingle();

  if (importError) throw importError;
  if (!importRow) {
    await updateBankJob(job.id, {
      status: "cancelled",
      progress: 100,
      stage: "Cancelled",
      error: "Bank statement import was deleted.",
      locked_at: null,
      locked_by: null,
      finished_at: new Date().toISOString(),
    });
    return;
  }

  await updateBankJob(job.id, { progress: 15, stage: "Downloading statement" });
  const { data: storedFile, error: downloadError } = await supabase.storage
    .from(importRow.storage_bucket || BANK_STATEMENT_BUCKET)
    .download(importRow.storage_path);
  if (downloadError) throw downloadError;

  const mimeType = importRow.mime_type || "";
  const fileName = importRow.original_file_name || "bank-statement";
  const bytes = new Uint8Array(await storedFile.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Downloaded bank statement file "${fileName}" is empty.`);
  }
  const processingMeta =
    importRow.processing_meta && typeof importRow.processing_meta === "object" && !Array.isArray(importRow.processing_meta)
      ? importRow.processing_meta
      : {};
  const selectedContext =
    processingMeta.selectedContext && typeof processingMeta.selectedContext === "object" && !Array.isArray(processingMeta.selectedContext)
      ? processingMeta.selectedContext
      : {};
  const analysisContext =
    processingMeta.analysis && typeof processingMeta.analysis === "object" && !Array.isArray(processingMeta.analysis)
      ? processingMeta.analysis
      : {};
  const tallyConnectionId =
    typeof selectedContext.connectionId === "string"
      ? selectedContext.connectionId
      : typeof analysisContext.connectionId === "string"
        ? analysisContext.connectionId
        : null;
  const bankAccountCandidates = await getTallyBankAccountCandidates(job.owner_user_id, tallyConnectionId);
  await updateBankJob(job.id, { progress: 30, stage: "Preparing pages for AI" });
  const isPdf = mimeType.includes("pdf") || /\.pdf$/i.test(fileName);
  const isImage = mimeType.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(fileName);
  const extraction = await extractBankStatementAdaptive({
    fileName,
    mimeType,
    bytes,
    isPdf,
    isImage,
    jobId: job.id,
    bankAccountCandidates,
  });
  const parsed = extraction.parsed ?? normalizeAiBankStatement({});
  const extractionSource = extraction.extractionSource;
  const extractionError = extraction.extractionError;
  const extractionDiagnostics = extraction.diagnostics;
  console.log(
    `[worker] ${extractionDiagnostics.pipeline} returned ${parsed.transactions.length} row(s) for ${fileName}`
  );

  const account = {
    bankName: importRow.extracted_bank_name || parsed.account.bankName || null,
    accountNumber: importRow.extracted_account_number || parsed.account.accountNumber || null,
    accountHolderName: importRow.extracted_account_holder_name || parsed.account.accountHolderName || null,
    ifscCode: importRow.extracted_ifsc_code || parsed.account.ifscCode || null,
  };
  const normalizedAccountNumber = normalizeAccountNumber(account.accountNumber);
  const { data: candidateRows, error: candidateError } = normalizedAccountNumber
    ? await supabase
        .from("bank_accounts")
        .select("id")
        .eq("owner_user_id", job.owner_user_id)
        .eq("account_number_normalized", normalizedAccountNumber)
        .limit(5)
    : { data: [], error: null };
  if (candidateError) throw candidateError;
  const candidateCount = (candidateRows ?? []).length;
  const selectedAccountId = candidateCount === 1 ? candidateRows[0].id : null;
  const finalStatus =
    parsed.transactions.length === 0
      ? "manual_review_required"
      : candidateCount > 1
        ? "needs_account_selection"
        : "ready_to_review";
  await updateBankJob(job.id, { progress: 75, stage: "Saving preview rows" });
  await supabase
    .from("bank_statement_import_preview_transactions")
    .delete()
    .eq("import_id", job.import_id)
    .eq("owner_user_id", job.owner_user_id);

  const rows = parsed.transactions.map((transaction, index) => ({
    import_id: job.import_id,
    owner_user_id: job.owner_user_id,
    ...transaction,
    row_index: index + 1,
  }));
  let previewRows = rows;
  if (rows.length > 0 && tallyConnectionId) {
    try {
      await updateBankJob(job.id, { progress: 78, stage: "Matching Tally ledgers with AI" });
      previewRows = await applyAiLedgerSuggestionsToPreviewRows({
        ownerUserId: job.owner_user_id,
        connectionId: tallyConnectionId,
        rows,
      });
    } catch (error) {
      console.warn("[worker] AI ledger matching failed for preview rows:", diagnosticError(error));
    }
  }

  if (previewRows.length > 0) {
    const { error: previewInsertError } = await supabase
      .from("bank_statement_import_preview_transactions")
      .insert(previewRows);
    if (previewInsertError) throw previewInsertError;
  }

  const previousAnalysis =
    processingMeta.analysis && typeof processingMeta.analysis === "object" && !Array.isArray(processingMeta.analysis)
      ? processingMeta.analysis
      : {};
  const completedAt = new Date().toISOString();
  const finalStatementPeriodStart = parsed.statementPeriodStart || importRow.statement_period_start || null;
  const finalStatementPeriodEnd = parsed.statementPeriodEnd || importRow.statement_period_end || null;
  const { error: importUpdateError } = await supabase
    .from("bank_statement_imports")
    .update({
      bank_account_id: selectedAccountId,
      statement_period_start: finalStatementPeriodStart,
      statement_period_end: finalStatementPeriodEnd,
      extracted_bank_name: account.bankName,
      extracted_account_number: account.accountNumber,
      extracted_account_holder_name: account.accountHolderName,
      extracted_ifsc_code: account.ifscCode,
      status: finalStatus,
      processing_meta: {
        ...processingMeta,
        parser: "openrouter_bank_statement_v1",
        extractionSource,
        jobStatus: "completed",
        extractionError,
        extractionDiagnostics,
        normalizedAccountNumber,
        maskedAccountNumber: maskAccountNumber(account.accountNumber),
        ifscCode: account.ifscCode,
        previewTransactionCount: previewRows.length,
        completedAt,
        analysis: {
          ...previousAnalysis,
          status: "completed",
          progress: 100,
          stage: "Statement analyzed",
          error: null,
          statementPeriodStart: finalStatementPeriodStart,
          statementPeriodEnd: finalStatementPeriodEnd,
          extractedStatementPeriodStart: parsed.statementPeriodStart || null,
          extractedStatementPeriodEnd: parsed.statementPeriodEnd || null,
          completedAt,
          updatedAt: completedAt,
        },
      },
    })
    .eq("id", job.import_id)
    .eq("owner_user_id", job.owner_user_id);
  if (importUpdateError) throw importUpdateError;

  await updateBankJob(job.id, {
    status: "succeeded",
    progress: 100,
    stage: "Completed",
    error: null,
    result: {
      importId: job.import_id,
      transactionCount: previewRows.length,
      status: finalStatus,
    },
    locked_at: null,
    locked_by: null,
    finished_at: new Date().toISOString(),
  });
}

async function getJob(jobId) {
  const { data, error } = await supabase
    .from("packet_processing_jobs")
    .select("id, case_id, status, attempt_count, max_attempts, locked_at, locked_by, result, error, updated_at")
    .eq("id", jobId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

async function markCaseFailed(caseId, message) {
  const { data: caseRow } = await supabase
    .from("packet_cases")
    .select("processing_meta")
    .eq("id", caseId)
    .maybeSingle();

  const existingMeta =
    caseRow?.processing_meta && typeof caseRow.processing_meta === "object" && !Array.isArray(caseRow.processing_meta)
      ? caseRow.processing_meta
      : {};

  await supabase
    .from("packet_cases")
    .update({
      status: "failed",
      processing_meta: {
        ...existingMeta,
        lastProcessingError: message,
      },
    })
    .eq("id", caseId);
}

async function failJob(job, message) {
  await supabase
    .from("packet_processing_jobs")
    .update({
      status: "failed",
      progress: 100,
      stage: "Failed",
      error: message,
      locked_at: null,
      locked_by: null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  await markCaseFailed(job.case_id, message);
}

async function requeueJob(jobId, errorMessage) {
  const job = await getJob(jobId);
  if (!job || isTerminalJobStatus(job.status)) {
    return;
  }

  if (Number(job.attempt_count ?? 0) >= Number(job.max_attempts ?? 3)) {
    await failJob(job, errorMessage);
    return;
  }

  const nextRunAt = new Date(Date.now() + WORKER_POLL_INTERVAL_MS).toISOString();
  await supabase
    .from("packet_processing_jobs")
    .update({
      status: "queued",
      progress: 0,
      stage: "Queued after worker dispatch failure",
      error: errorMessage,
      locked_at: null,
      locked_by: null,
      next_run_at: nextRunAt,
    })
    .eq("id", jobId)
    .eq("status", "running");
}

async function recoverStaleRunningJobs() {
  const cutoff = new Date(Date.now() - WORKER_STALE_RUNNING_JOB_MS).toISOString();
  const { data: jobs, error } = await supabase
    .from("packet_processing_jobs")
    .select("id, case_id, status, attempt_count, max_attempts, locked_at")
    .eq("status", "running")
    .lt("locked_at", cutoff)
    .limit(10);

  if (error) {
    throw error;
  }

  for (const job of jobs ?? []) {
    const message = `Processing job was stale for more than ${Math.round(WORKER_STALE_RUNNING_JOB_MS / 60000)} minutes.`;
    if (Number(job.attempt_count ?? 0) >= Number(job.max_attempts ?? 3)) {
      await failJob(job, message);
      continue;
    }

    await supabase
      .from("packet_processing_jobs")
      .update({
        status: "queued",
        progress: 0,
        stage: "Queued after stale worker run",
        error: message,
        locked_at: null,
        locked_by: null,
        next_run_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "running");
  }
}

async function claimNextJob() {
  await recoverStaleRunningJobs();

  const { data, error } = await supabase.rpc("claim_packet_processing_job", {
    worker_name: WORKER_NAME,
    stale_after: WORKER_STALE_RUNNING_JOB_INTERVAL,
  });

  if (error) {
    throw error;
  }

  const claimedJob = Array.isArray(data) ? data[0] : data;

  if (!claimedJob?.id) {
    return null;
  }

  return claimedJob;
}

async function runJob(job) {
  if (!job?.id) {
    throw new Error("Cannot run a packet processing job without an id.");
  }

  const startedAt = Date.now();
  const response = await fetch(`${APP_BASE_URL}/api/internal/jobs/${job.id}/run`, {
    method: "POST",
    headers: {
      "x-worker-secret": WORKER_SECRET,
    },
  });

  if (response.status === 409) {
    const payload = await response.text().catch(() => "");
    console.warn(`[worker] job ${job.id} skipped: ${payload || "not runnable"}`);
    return;
  }

  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    if (response.status === 503 && Date.now() - startedAt >= HEROKU_ROUTER_TIMEOUT_GRACE_MS) {
      throw new JobMayStillBeRunningError(
        payload || "Heroku router timed out while the analysis request continued on the web dyno."
      );
    }
    throw new Error(payload || `Internal processing failed (${response.status})`);
  }
}

async function waitForInFlightRun(jobId) {
  const deadline = Date.now() + WORKER_IN_FLIGHT_WAIT_MS;

  while (Date.now() < deadline) {
    const job = await getJob(jobId);
    if (!job || isTerminalJobStatus(job.status) || job.status === "queued") {
      return job;
    }
    await sleep(WORKER_IN_FLIGHT_POLL_MS);
  }

  return getJob(jobId);
}

async function main() {
  console.log(
    `[worker] started name=${WORKER_NAME} appBase=${APP_BASE_URL} pollMs=${WORKER_POLL_INTERVAL_MS} bankPdfMode=adaptive_ai batchPages=${BANK_STATEMENT_BATCH_PAGE_SIZE} concurrency=${BANK_STATEMENT_BATCH_CONCURRENCY}`
  );
  let lastIdleLogAt = 0;

  while (true) {
    try {
      const bankJob = await claimNextBankStatementJob();
      if (bankJob) {
        try {
          console.log(
            `[worker] claimed bank statement job ${bankJob.id} import=${bankJob.import_id ?? "<unknown>"} attempt=${bankJob.attempt_count ?? "?"}/${bankJob.max_attempts ?? "?"}`
          );
          await runBankStatementJob(bankJob);
          console.log(`[worker] completed bank statement job ${bankJob.id}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
          console.error(`[worker] bank statement extraction failed for job ${bankJob.id}: ${message}`);
          await requeueBankJob(bankJob.id, message);
        }
        continue;
      }

      const job = await claimNextJob();
      if (!job) {
        const now = Date.now();
        if (now - lastIdleLogAt >= WORKER_IDLE_LOG_INTERVAL_MS) {
          console.log("[worker] idle: no queued bank statement or packet jobs claimed");
          lastIdleLogAt = now;
        }
        await sleep(WORKER_POLL_INTERVAL_MS);
        continue;
      }

      try {
        console.log(
          `[worker] claimed packet job ${job.id} case=${job.case_id ?? "<unknown>"} attempt=${job.attempt_count ?? "?"}/${job.max_attempts ?? "?"}`
        );
        await runJob(job);
        console.log(`[worker] completed packet job ${job.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
        if (error instanceof JobMayStillBeRunningError) {
          console.warn(`[worker] job ${job.id} exceeded router timeout; waiting for in-flight run instead of requeueing`);
          const latestJob = await waitForInFlightRun(job.id);
          if (latestJob?.status === "running") {
            console.warn(`[worker] job ${job.id} is still running; leaving it locked for stale recovery`);
          }
          continue;
        }
        console.error(`[worker] dispatch failed for job ${job.id}: ${message}`);
        await requeueJob(job.id, message);
      }
    } catch (error) {
      const message = formatError(error);
      console.error(`[worker] polling failed: ${message}`);
      await sleep(WORKER_POLL_INTERVAL_MS);
    }
  }
}

main().catch((error) => {
  console.error("[worker] fatal error", error);
  process.exit(1);
});
