import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

import { suggestBankLedgersForTransactions } from "../src/lib/bank-statement-ledger-matching.ts";
import { correctRowsFromRunningBalance } from "./bank-statement-running-balance.mjs";
import {
  addBankStatementPageProvenance,
  shouldAttemptBankStatementSingleShot,
  sortBankStatementTransactionsByProvenance,
  unresolvedBankStatementRecoveryPages,
  validateBankStatementPageCoverage,
} from "./bank-statement-resilience.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_SECRET = process.env.WORKER_SECRET;
const RAW_APP_BASE_URL =
  process.env.APP_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  (process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : null);
const APP_BASE_URL = RAW_APP_BASE_URL?.replace(/\/+$/, "");
const CONFIGURED_WORKER_POOL = process.env.BANK_STATEMENT_WORKER_POOL?.trim().toLowerCase();
const WORKER_POOL =
  CONFIGURED_WORKER_POOL === "local" || CONFIGURED_WORKER_POOL === "remote"
    ? CONFIGURED_WORKER_POOL
    : /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(APP_BASE_URL ?? "")
      ? "local"
      : "remote";
const WORKER_NAME = process.env.WORKER_NAME || `${WORKER_POOL}-worker-${process.pid}`;
const WORKER_POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
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
// One AI request per page keeps transaction JSON bounded and makes page
// coverage independently verifiable. Do not allow a stale deployment config
// to restore the two-page output-limit failure mode.
const BANK_STATEMENT_BATCH_PAGE_SIZE = 1;
const BANK_STATEMENT_BATCH_CONCURRENCY = Math.max(1, Number(process.env.BANK_STATEMENT_BATCH_CONCURRENCY ?? 4));
const BANK_STATEMENT_SINGLE_PAGE_RECOVERY_LIMIT = Math.max(
  0,
  Number(process.env.BANK_STATEMENT_SINGLE_PAGE_RECOVERY_LIMIT ?? 50)
);
const BANK_STATEMENT_TEXT_PROMPT_MAX_CHARS = Number(process.env.BANK_STATEMENT_TEXT_PROMPT_MAX_CHARS ?? 80_000);
const BANK_STATEMENT_SINGLE_SHOT_MAX_INPUT_CHARS = Number(
  process.env.BANK_STATEMENT_SINGLE_SHOT_MAX_INPUT_CHARS ?? 36_000
);
const BANK_STATEMENT_SINGLE_SHOT_MAX_LIKELY_ROWS = Number(
  process.env.BANK_STATEMENT_SINGLE_SHOT_MAX_LIKELY_ROWS ?? 70
);
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
const BANK_STATEMENT_PAGE_MANIFEST_INSTRUCTION =
  " Every transaction must include sourcePage with the visible PDF page number. Also return pageResults with exactly one entry for every supplied page: pageNumber, status (transactions or no_transactions), and transactionCount. Never omit a supplied page from pageResults.";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL =
  process.env.OPENROUTER_QUALITY_MODEL ||
  process.env.GEMINI_THINKING_MODEL ||
  "google/gemini-2.5-flash";
const OPENROUTER_MAX_RETRIES = Number(process.env.OPENROUTER_MAX_RETRIES ?? 2);
const OPENROUTER_RETRY_BASE_MS = Number(process.env.OPENROUTER_RETRY_BASE_MS ?? 1200);
const OPENROUTER_MAX_OUTPUT_TOKENS = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS ?? 8192);
const OPENROUTER_QUALITY_REASONING_TOKENS = Number(process.env.OPENROUTER_QUALITY_REASONING_TOKENS ?? 2000);
const OPENROUTER_BANK_STATEMENT_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.OPENROUTER_BANK_STATEMENT_TIMEOUT_MS ?? 90_000)
);
const BANK_STATEMENT_JOB_HEARTBEAT_MS = Math.max(
  5_000,
  Number(process.env.BANK_STATEMENT_JOB_HEARTBEAT_MS ?? 30_000)
);
const OPENROUTER_BANK_LEDGER_MODEL =
  process.env.OPENROUTER_BANK_LEDGER_MODEL || "deepseek/deepseek-v4-pro";
const execFileAsync = promisify(execFile);
const WORKER_IDLE_LOG_INTERVAL_MS = Number(process.env.WORKER_IDLE_LOG_INTERVAL_MS ?? 30_000);
const PDF_IMAGE_RENDER_SCRIPT = String.raw`
import sys
from pathlib import Path

try:
    import fitz
except Exception:
    sys.exit(7)

input_path = Path(sys.argv[1])
output_prefix = Path(sys.argv[2])
dpi = max(72, int(sys.argv[3]))
start_page = max(1, int(sys.argv[4]))
end_page = max(start_page, int(sys.argv[5]))

document = fitz.open(str(input_path))
last_page = min(end_page, document.page_count)
matrix = fitz.Matrix(dpi / 72, dpi / 72)
for page_number in range(start_page, last_page + 1):
    page = document.load_page(page_number - 1)
    pixmap = page.get_pixmap(matrix=matrix, alpha=False)
    pixmap.save(str(output_prefix.parent / f"{output_prefix.name}-{page_number}.png"))
document.close()
`;

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
    // pdf.js transfers and detaches the supplied ArrayBuffer even with
    // disableWorker. Always give it a disposable copy so later recovery can
    // still render the original PDF bytes.
    data: new Uint8Array(data),
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
  const formatted = pages
    .map((page, index) => {
      const pageNumber = typeof page === "object" && page ? page.pageNumber : index + 1;
      const text = typeof page === "string" ? page : page?.text;
      return `Page ${pageNumber}\n${text || "[No text extracted]"}`;
    })
    .join("\n\n---\n\n");
  if (formatted.length > BANK_STATEMENT_TEXT_PROMPT_MAX_CHARS) {
    const error = new Error(
      `PDF text input is ${formatted.length} characters, above the ${BANK_STATEMENT_TEXT_PROMPT_MAX_CHARS}-character AI limit.`
    );
    error.code = "BANK_STATEMENT_INPUT_TOO_LARGE";
    throw error;
  }
  return formatted;
}

function estimateVisibleTransactionRows(page) {
  const text = String(typeof page === "string" ? page : page?.text || "");
  return text.split(/\r?\n/).filter((line) => {
    const hasDate =
      /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(line) ||
      /\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}\b/.test(line) ||
      /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.test(line);
    const amountCount = (line.match(/(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}\b/g) || []).length;
    return hasDate && amountCount >= 2;
  }).length;
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

function correctPreviewRowsFromRunningBalance(transactions, openingBalance = null) {
  return correctRowsFromRunningBalance(transactions, { openingBalance, detectCategory });
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

function parseBankStatementAiResponse(raw) {
  const trimmed = String(raw || "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw bankStatementError(
      "AI returned an incomplete bank statement JSON response.",
      "BANK_STATEMENT_INVALID_JSON"
    );
  }
  try {
    return normalizeAiBankStatement(JSON.parse(trimmed.slice(start, end + 1)));
  } catch (error) {
    throw bankStatementError(
      `AI returned invalid bank statement JSON: ${error instanceof Error ? error.message : String(error)}`,
      "BANK_STATEMENT_INVALID_JSON"
    );
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
  const renderDpi = Math.max(72, Number(options.renderDpi ?? BANK_STATEMENT_PDF_RENDER_DPI));

  try {
    fs.writeFileSync(inputPath, Buffer.from(data));
    try {
      await execFileAsync("pdftoppm", [
        "-r",
        String(renderDpi),
        "-png",
        "-f",
        String(startPage),
        "-l",
        String(endPage),
        inputPath,
        outputPrefix,
      ]);
    } catch (popplerError) {
      const configuredPython = process.env.KALIKA_PDF_PYTHON_BIN?.trim();
      const pythonCandidates = [
        ...(configuredPython ? [{ command: configuredPython, prefixArgs: [] }] : []),
        ...(process.platform === "win32"
          ? [
              { command: "py", prefixArgs: ["-3"] },
              { command: "python", prefixArgs: [] },
              { command: "python3", prefixArgs: [] },
            ]
          : [
              { command: "python3", prefixArgs: [] },
              { command: "python", prefixArgs: [] },
            ]),
      ];
      let renderedWithPython = false;
      const attempted = new Set();
      for (const candidate of pythonCandidates) {
        const key = `${candidate.command}\u0000${candidate.prefixArgs.join("\u0000")}`;
        if (attempted.has(key)) continue;
        attempted.add(key);
        try {
          await execFileAsync(candidate.command, [
            ...candidate.prefixArgs,
            "-c",
            PDF_IMAGE_RENDER_SCRIPT,
            inputPath,
            outputPrefix,
            String(renderDpi),
            String(startPage),
            String(endPage),
          ]);
          renderedWithPython = true;
          break;
        } catch {
          // Try the next Python interpreter before reporting the Poppler failure.
        }
      }
      if (!renderedWithPython) throw popplerError;
    }

    const pageFileNames = fs
      .readdirSync(tmpDir)
      .filter((fileName) => fileName.startsWith("page-") && fileName.endsWith(".png"))
      .sort((left, right) => renderedPageNumber(left) - renderedPageNumber(right));

    const images = [];
    try {
      for (const fileName of pageFileNames) {
        const bytes = fs.readFileSync(path.join(tmpDir, fileName));
        images.push(await imageBytesToProviderDataUrl(bytes, "image/png", `${sourceName} ${fileName}`));
      }
    } catch (error) {
      const nextDpi = [140, 110, 90, 72].find((dpi) => dpi < renderDpi);
      if (!nextDpi) throw error;
      console.warn(
        `[worker] page image preparation failed at ${renderDpi} DPI for ${sourceName}; retrying at ${nextDpi} DPI. ${diagnosticError(error)}`
      );
      return renderBankStatementPdfToImages(data, sourceName, {
        ...options,
        renderDpi: nextDpi,
      });
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
  const hasDebit = typeof debitAmount === "number" && debitAmount > 0;
  const hasCredit = typeof creditAmount === "number" && creditAmount > 0;
  if (hasDebit === hasCredit) return null;
  const transactionType = detectTransactionType(description);
  const category = detectCategory(description, debitAmount, creditAmount);
  const counterpartyName = extractCounterpartyName(description);

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
    confidence: 0.9,
    raw_payload: { rowNumber, source: "openrouter_bank_statement_v1", row },
  };
}

function normalizeAiBankStatement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      account: { bankName: null, accountNumber: null, accountHolderName: null, ifscCode: null },
      statementPeriodStart: null,
      statementPeriodEnd: null,
      openingBalance: null,
      transactions: [],
      pageResults: [],
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

  const openingBalance = parseAmount(
    parsed.openingBalance ??
      parsed.opening_balance ??
      parsed.balanceForward ??
      parsed.balance_forward ??
      parsed.broughtForwardBalance
  );
  const rawPageResults = Array.isArray(parsed.pageResults)
    ? parsed.pageResults
    : Array.isArray(parsed.page_results)
      ? parsed.page_results
      : [];
  const pageResults = rawPageResults.filter((result) =>
    result && typeof result === "object" && !Array.isArray(result)
  );

  return {
    account: {
      bankName: textCell(account.bankName ?? parsed.bankName) || null,
      accountNumber: textCell(account.accountNumber ?? parsed.accountNumber) || null,
      accountHolderName: textCell(account.accountHolderName ?? account.accountName ?? parsed.accountHolderName) || null,
      ifscCode: normalizeIfscCode(textCell(account.ifscCode ?? parsed.ifscCode)) || null,
    },
    statementPeriodStart: parseDate(parsed.statementPeriodStart) ?? parseDate(parsed.periodStart),
    statementPeriodEnd: parseDate(parsed.statementPeriodEnd) ?? parseDate(parsed.periodEnd),
    openingBalance,
    transactions: correctPreviewRowsFromRunningBalance(transactions, openingBalance),
    pageResults,
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
  const ledgers = [];
  const groups = [];
  const pageSize = 1000;
  for (const [masterType, target] of [["ledger", ledgers], ["group", groups]]) {
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
      const page = data ?? [];
      target.push(...page);
      if (page.length < pageSize) break;
      if (from + pageSize >= 20000) {
        throw new Error(`Tally ${masterType} sync exceeds the supported 20,000-master safety limit.`);
      }
    }
  }
  const groupParentByName = new Map(
    groups.map((group) => [normalizeName(group.tally_name), textCell(group.parent_name)])
  );
  function isDescendantOfGroup(parentName, targetGroupName) {
    const target = normalizeName(targetGroupName);
    const visited = new Set();
    let current = textCell(parentName);
    while (current) {
      const normalized = normalizeName(current);
      if (!normalized || visited.has(normalized)) return false;
      if (normalized === target) return true;
      visited.add(normalized);
      current = groupParentByName.get(normalized) || "";
    }
    return false;
  }

  return ledgers.flatMap((ledger) => {
    const accountNumber = bankAccountNumberFromTallyLedger(ledger);
    if (!isDescendantOfGroup(ledger.parent_name, "Bank Accounts") || !accountNumber) return [];
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

function bankStatementError(message, code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function isRetryableBankStatementError(error) {
  return error?.retryable === true;
}

function bankStatementFailureReason(error) {
  if (error?.code === "BANK_STATEMENT_OUTPUT_LIMIT") return "output_limit";
  if (error?.code === "BANK_STATEMENT_INPUT_TOO_LARGE") return "input_too_large";
  if (error?.code === "BANK_STATEMENT_INVALID_JSON") return "invalid_json";
  if (error?.code === "BANK_STATEMENT_TIMEOUT") return "timeout";
  return "failed";
}

async function callOpenRouterForBankStatement(messages) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  let attempt = 0;
  let lastError = "OpenRouter request failed";
  while (attempt <= OPENROUTER_MAX_RETRIES) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), OPENROUTER_BANK_STATEMENT_TIMEOUT_MS);
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: abortController.signal,
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_BASE_URL || "http://localhost:3001",
          "X-Title": "Autodealer Workflow Bank Statement Worker",
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

      const retryAfterSeconds = Number(response.headers.get("Retry-After"));
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) {
        const errorText =
          payload?.error?.message ||
          payload?.message ||
          (response.ok ? "OpenRouter returned an error payload" : `OpenRouter request failed (${response.status})`);
        lastError = errorText;
        if (!isRetryableStatus(response.status) || isHardQuotaError(errorText) || attempt === OPENROUTER_MAX_RETRIES) {
          throw bankStatementError(
            errorText,
            isHardQuotaError(errorText) ? "BANK_STATEMENT_QUOTA" : `BANK_STATEMENT_PROVIDER_${response.status}`,
            isRetryableStatus(response.status) && !isHardQuotaError(errorText)
          );
        }
        await sleep(
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : OPENROUTER_RETRY_BASE_MS * Math.pow(2, attempt)
        );
        attempt += 1;
        continue;
      }

      const choice = payload?.choices?.[0];
      const embeddedError = choice?.error || payload?.error;
      if (embeddedError || choice?.finish_reason === "error") {
        throw bankStatementError(
          embeddedError?.message || embeddedError?.metadata?.error_type || "OpenRouter generation failed."
          ,
          "BANK_STATEMENT_PROVIDER_GENERATION"
        );
      }
      if (choice?.finish_reason === "length") {
        throw bankStatementError(
          "AI response reached its output limit before the statement JSON was complete.",
          "BANK_STATEMENT_OUTPUT_LIMIT"
        );
      }

      const message = choice?.message?.content;
      const content = Array.isArray(message)
        ? message.map((part) => part?.text || "").join("\n")
        : String(message || "");
      if (!content.trim()) {
        throw bankStatementError(
          "OpenRouter returned an empty bank statement response.",
          "BANK_STATEMENT_EMPTY_RESPONSE",
          true
        );
      }
      return content;
    } catch (error) {
      const normalizedError =
        error?.name === "AbortError"
          ? bankStatementError(
              `AI request timed out after ${OPENROUTER_BANK_STATEMENT_TIMEOUT_MS} ms.`,
              "BANK_STATEMENT_TIMEOUT",
              true
            )
          : /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket/i.test(String(error?.message || error || ""))
            ? bankStatementError(
                error instanceof Error ? error.message : String(error),
                "BANK_STATEMENT_NETWORK",
                true
              )
          : error;
      lastError = normalizedError instanceof Error ? normalizedError.message : String(normalizedError ?? "Unknown error");
      if (!isRetryableBankStatementError(normalizedError) || attempt === OPENROUTER_MAX_RETRIES) {
        throw normalizedError instanceof Error ? normalizedError : new Error(lastError);
      }
      await sleep(OPENROUTER_RETRY_BASE_MS * Math.pow(2, attempt));
      attempt += 1;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(lastError);
}

async function extractBankStatementFromImages(fileName, images, bankAccountCandidates = []) {
  if (images.length === 0) {
    return {
      account: { bankName: null, accountNumber: null, accountHolderName: null, ifscCode: null },
      statementPeriodStart: null,
      statementPeriodEnd: null,
      openingBalance: null,
      transactions: [],
    };
  }

  const raw = await callOpenRouterForBankStatement([
    {
      role: "system",
      content:
        "Extract bank statement account details and transaction rows. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, openingBalance, and transactions. " +
        "openingBalance must be a number when an opening, brought-forward, or balance-forward amount is visible; otherwise return null. Keep it as metadata and never add the opening-balance line to transactions. " +
        "account must include bankName, accountNumber, accountHolderName, and ifscCode when visible. Dates must be ISO YYYY-MM-DD. " +
        "Each transaction must include only transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, and balanceAmount. " +
        "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. Do not shorten description to only the party name, and do not include date/value-date/debit/credit/balance columns in description. " +
        "Use numbers for amounts, with debit and credit as positive values in their own columns. Do not invent rows. Preserve narration text exactly enough for audit matching. " +
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

  return parseBankStatementAiResponse(raw);
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
            "Extract bank statement account details and transaction rows from the attached PDF. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, openingBalance, and transactions. " +
            "openingBalance must be a number when an opening, brought-forward, or balance-forward amount is visible; otherwise return null. Keep it as metadata and never add the opening-balance line to transactions. " +
            "account must include bankName, accountNumber, accountHolderName, and ifscCode when visible. Dates must be ISO YYYY-MM-DD. " +
            "Each transaction must include only transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, and balanceAmount. " +
            "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. Do not shorten description to only the party name, and do not include date/value-date/debit/credit/balance columns in description. " +
            "Use numbers for amounts, with debit and credit as positive values in their own columns. Preserve multi-line narration text in the description. " +
            "Rows may continue on following lines without a date; attach those continuation lines to the previous dated transaction. " +
            "Do not treat BALANCE FORWARD, page footers, insurance notices, reward-points sections, summary totals, or opening/closing balance-only lines as transactions. " +
            "Do not invent rows or amounts. If the PDF contains only summary information and no ledger rows, extract account/period only and leave transactions empty." +
            bankAccountCandidateInstruction(bankAccountCandidates),
        },
      ],
    },
  ]);

  return parseBankStatementAiResponse(raw);
}

async function extractBankStatementFromText(fileName, pages, bankAccountCandidates = []) {
  const raw = await callOpenRouterForBankStatement([
    {
      role: "system",
      content:
        "Extract bank statement account details and transaction rows from PDF text. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, openingBalance, and transactions. " +
        "openingBalance must be a number when an opening, brought-forward, or balance-forward amount is visible; otherwise return null. Keep it as metadata and never add the opening-balance line to transactions. " +
        "account must include bankName, accountNumber, accountHolderName, and ifscCode when visible. Dates must be ISO YYYY-MM-DD. " +
        "Each transaction must include only transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, and balanceAmount. " +
        "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. Do not shorten description to only the party name, and do not include date/value-date/debit/credit/balance columns in description. " +
        "Use numbers for amounts, with debit and credit as positive values in their own columns. Preserve multi-line narration text in the description. " +
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

  return parseBankStatementAiResponse(raw);
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
    merged.openingBalance = merged.openingBalance ?? result.openingBalance ?? null;
    if (Array.isArray(result.pageResults)) merged.pageResults.push(...result.pageResults);
    for (const transaction of result.transactions) {
      const transactionProvenance = transaction?.raw_payload?.extractionProvenance ?? {};
      const normalizedReference = normalizeName(transaction.reference_number);
      const key = normalizedReference
        ? [
            "reference",
            transaction.transaction_date,
            normalizedReference,
            transaction.debit_amount ?? "",
            transaction.credit_amount ?? "",
          ].join("|")
        : [
            "source-row",
            transactionProvenance.startPage ?? "",
            transactionProvenance.sourceIndex ?? transaction.row_index ?? "",
            transaction.transaction_date,
            normalizeName(transaction.description),
            transaction.debit_amount ?? "",
            transaction.credit_amount ?? "",
            transaction.balance_amount ?? "",
          ].join("|");
      if (seenTransactions.has(key)) continue;
      seenTransactions.add(key);
      merged.transactions.push(transaction);
    }
  }
  merged.transactions = correctPreviewRowsFromRunningBalance(
    sortBankStatementTransactionsByProvenance(merged.transactions),
    merged.openingBalance
  );
  return merged;
}

function validateRunningBalanceContinuity(transactions, openingBalance = null) {
  let previousBalance = typeof openingBalance === "number" && Number.isFinite(openingBalance)
    ? openingBalance
    : null;
  const breaks = [];
  for (const transaction of transactions) {
    const balance = transaction.balance_amount;
    const debit = transaction.debit_amount ?? 0;
    const credit = transaction.credit_amount ?? 0;
    if (
      previousBalance !== null &&
      typeof balance === "number" && Number.isFinite(balance)
    ) {
      const expectedBalance = Number((previousBalance - debit + credit).toFixed(2));
      if (Math.abs(expectedBalance - balance) >= 0.01) {
        const provenance = transaction?.raw_payload?.extractionProvenance ?? {};
        breaks.push({
          page: Number(provenance.startPage) || null,
          sourceIndex: Number(provenance.sourceIndex) || 0,
          previousBalance,
          expectedBalance,
          actualBalance: balance,
          referenceNumber: transaction.reference_number ?? null,
        });
      }
    }
    if (typeof balance === "number" && Number.isFinite(balance)) previousBalance = balance;
  }
  return { valid: breaks.length === 0, checkedTransitions: Math.max(0, transactions.length - 1), breaks };
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

function hasReadableBankStatementPageText(page) {
  return String(typeof page === "string" ? page : page?.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .length >= 50;
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
        "Extract bank statement account details and transaction rows from a batch of PDF text pages. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, openingBalance, transactions, and pageResults. " +
        "openingBalance must be a number when an opening, brought-forward, or balance-forward amount is visible in this batch; otherwise return null. Keep it as metadata and never add the opening-balance line to transactions. " +
        "account must include bankName, accountNumber, accountHolderName, and ifscCode when visible. Dates must be ISO YYYY-MM-DD. " +
        "Each transaction must include only transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, and balanceAmount. " +
        "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. Do not shorten description to only the party name, and do not include date/value-date/debit/credit/balance columns in description. " +
        "Rows may continue on following lines without a date; attach those continuation lines to the previous dated transaction. " +
        "Ignore BALANCE FORWARD, OPENING BALANCE, CLOSING BALANCE, page footers, reward-points sections, summary totals, and bank notices unless they have a real debit or credit transaction amount. " +
        "Do not invent rows. If this batch contains only summary/header information and no ledger rows, return account/period if visible and an empty transactions array." +
        BANK_STATEMENT_PAGE_MANIFEST_INSTRUCTION,
    },
    {
      role: "user",
      content: `Extract ${pageRangeLabel(pages)} from ${fileName}:\n\n${formatBankStatementTextForAi(pages)}`,
    },
  ]);

  return parseBankStatementAiResponse(raw);
}

async function extractBankStatementFromImageBatch(fileName, images, rangeLabel) {
  if (images.length === 0) return normalizeAiBankStatement({});
  const raw = await callOpenRouterForBankStatement([
    {
      role: "system",
      content:
        "Extract bank statement account details and transaction rows from these rendered statement pages. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, openingBalance, transactions, and pageResults. " +
        "openingBalance must be a number when an opening, brought-forward, or balance-forward amount is visible in these pages; otherwise return null. Keep it as metadata and never add the opening-balance line to transactions. " +
        "Dates must be ISO YYYY-MM-DD. Each transaction must include only transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, and balanceAmount. " +
        "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. " +
        "Ignore BALANCE FORWARD, OPENING BALANCE, CLOSING BALANCE, summary totals, page footers, and bank notices. Do not invent rows." +
        BANK_STATEMENT_PAGE_MANIFEST_INSTRUCTION,
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Extract ${rangeLabel} from ${fileName}.` },
        ...images.map((image) => ({ type: "image_url", image_url: { url: image } })),
      ],
    },
  ]);

  return parseBankStatementAiResponse(raw);
}

async function callWithBatchRetries(label, handler) {
  try {
    // Provider/network retries are owned by callOpenRouterForBankStatement.
    // Retrying again here multiplies identical calls and makes output-limit
    // failures take minutes. Batch-level recovery instead changes the input.
    return await handler(0);
  } catch (error) {
    const wrapped = new Error(`${label} failed: ${diagnosticError(error)}`);
    wrapped.code = error?.code;
    wrapped.retryable = error?.retryable === true;
    throw wrapped;
  }
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
        status: "needs_render",
        rowCount: 0,
        pages: batch.map((page) => ({ page: page.pageNumber, status: "unverified", rowCount: 0 })),
      };
      failedBatches.push({ pages: batch, reason: "no_usable_text" });
      return null;
    }

    try {
      const parsed = await callWithBatchRetries(label, () => extractBankStatementFromTextBatch(fileName, batch));
      const coverage = validateBankStatementPageCoverage({
        transactions: parsed.transactions,
        pageResults: parsed.pageResults,
        pages: batch.map((page) => ({
          pageNumber: page.pageNumber,
          likelyHasRows: likelyHasTransactionRows(page),
          canConfirmNoTransactions: hasReadableBankStatementPageText(page),
          expectedMinimumRowCount: estimateVisibleTransactionRows(page),
        })),
        method: "text_batch",
      });
      parsed.transactions = coverage.transactions;
      diagnostics[index] = {
        startPage: batch[0]?.pageNumber,
        endPage: lastItem(batch)?.pageNumber,
        status:
          coverage.unresolvedPages.length > 0
            ? "partial"
            : parsed.transactions.length > 0
              ? "succeeded"
              : "empty_non_transaction",
        rowCount: parsed.transactions.length,
        pages: coverage.pageOutcomes,
        droppedUnassignedRowCount: coverage.droppedUnassignedRowCount,
      };
      if (coverage.unresolvedPages.length > 0) {
        const unresolvedSet = new Set(coverage.unresolvedPages);
        failedBatches.push({
          pages: batch.filter((page) => unresolvedSet.has(page.pageNumber)),
          reason: "page_coverage_incomplete",
        });
      }
      const completed = diagnostics.filter(Boolean).length;
      await updateBankJob(jobId, {
        progress: Math.min(70, 35 + Math.round((completed / Math.max(1, batches.length)) * 30)),
        stage: `Analyzing statement batches ${completed}/${batches.length}`,
      });
      return parsed;
    } catch (error) {
      const reason = bankStatementFailureReason(error);
      diagnostics[index] = {
        startPage: batch[0]?.pageNumber,
        endPage: lastItem(batch)?.pageNumber,
        status: "failed",
        rowCount: 0,
        error: diagnosticError(error),
        reason,
      };
      failedBatches.push({ pages: batch, reason });
      const completed = diagnostics.filter(Boolean).length;
      await updateBankJob(jobId, {
        progress: Math.min(70, 35 + Math.round((completed / Math.max(1, batches.length)) * 30)),
        stage: `Analyzing statement pages ${completed}/${batches.length}`,
      });
      return null;
    }
  });

  return {
    parsed: mergeBankStatementResults(results),
    diagnostics,
    failedBatches,
  };
}

async function extractBankStatementImageBatches(fileName, bytes, pageCount, jobId, textPagesByNumber = new Map()) {
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
      const coverage = validateBankStatementPageCoverage({
        transactions: parsed.transactions,
        pageResults: parsed.pageResults,
        pages: range.map((page) => ({
          pageNumber: page.pageNumber,
          likelyHasRows: likelyHasTransactionRows(textPagesByNumber.get(page.pageNumber)),
          canConfirmNoTransactions: true,
          expectedMinimumRowCount: estimateVisibleTransactionRows(textPagesByNumber.get(page.pageNumber)),
        })),
        method: "image_batch",
      });
      parsed.transactions = coverage.transactions;
      diagnostics[index] = {
        startPage,
        endPage,
        status:
          coverage.unresolvedPages.length > 0
            ? "partial"
            : parsed.transactions.length > 0
              ? "succeeded"
              : "empty_non_transaction",
        rowCount: parsed.transactions.length,
        pages: coverage.pageOutcomes,
        droppedUnassignedRowCount: coverage.droppedUnassignedRowCount,
      };
      if (coverage.unresolvedPages.length > 0) {
        const unresolvedSet = new Set(coverage.unresolvedPages);
        failedBatches.push({
          pages: range.filter((page) => unresolvedSet.has(page.pageNumber)),
          reason: "page_coverage_incomplete",
        });
      }
      const completed = diagnostics.filter(Boolean).length;
      await updateBankJob(jobId, {
        progress: Math.min(70, 35 + Math.round((completed / Math.max(1, ranges.length)) * 30)),
        stage: `Analyzing rendered page batches ${completed}/${ranges.length}`,
      });
      return parsed;
    } catch (error) {
      const reason = bankStatementFailureReason(error);
      diagnostics[index] = { startPage, endPage, status: "failed", rowCount: 0, error: diagnosticError(error), reason };
      failedBatches.push({ pages: range, reason });
      const completed = diagnostics.filter(Boolean).length;
      await updateBankJob(jobId, {
        progress: Math.min(70, 35 + Math.round((completed / Math.max(1, ranges.length)) * 30)),
        stage: `Analyzing rendered pages ${completed}/${ranges.length}`,
      });
      return null;
    }
  });

  return {
    parsed: mergeBankStatementResults(results),
    diagnostics,
    failedBatches,
  };
}

async function recoverSinglePages({
  fileName,
  bytes,
  textPagesByNumber,
  failedBatches,
  jobId,
  forceRenderedImages = false,
}) {
  const pageMap = new Map();
  for (const batch of failedBatches) {
    for (const page of batch.pages) {
      const pageNumber = page.pageNumber;
      if (!pageMap.has(pageNumber)) {
        pageMap.set(pageNumber, {
          ...(textPagesByNumber.get(pageNumber) ?? { pageNumber, text: "" }),
          recoveryReason: batch.reason || "failed",
        });
      }
    }
  }
  const pages = [...pageMap.values()].slice(0, BANK_STATEMENT_SINGLE_PAGE_RECOVERY_LIMIT);
  if (pages.length === 0) {
    return { parsed: normalizeAiBankStatement({}), diagnostics: [] };
  }

  const diagnostics = [];
  const results = await runWithConcurrency(pages, BANK_STATEMENT_BATCH_CONCURRENCY, async (page, index) => {
    try {
      const useRenderedImage =
        forceRenderedImages ||
        !String(page.text || "").trim() ||
        ["no_usable_text", "input_too_large"].includes(page.recoveryReason);
      const parsed = await callWithBatchRetries(`recovery page ${page.pageNumber}`, async () => {
        if (!useRenderedImage) {
          return extractBankStatementFromTextBatch(fileName, [page]);
        }
        const images = await renderBankStatementPdfToImages(bytes, fileName, {
          startPage: page.pageNumber,
          endPage: page.pageNumber,
        });
        return extractBankStatementFromImageBatch(fileName, images, `page ${page.pageNumber}`);
      });
      const coverage = validateBankStatementPageCoverage({
        transactions: parsed.transactions,
        pageResults: parsed.pageResults,
        pages: [{
          pageNumber: page.pageNumber,
          likelyHasRows: likelyHasTransactionRows(page),
          canConfirmNoTransactions: useRenderedImage || hasReadableBankStatementPageText(page),
          expectedMinimumRowCount: estimateVisibleTransactionRows(page),
        }],
        method: useRenderedImage ? "rendered_image_recovery" : "single_page_text_recovery",
      });
      parsed.transactions = coverage.transactions;
      const pageOutcome = coverage.pageOutcomes[0] ?? {
        page: page.pageNumber,
        status: "unverified",
        rowCount: 0,
      };
      diagnostics[index] = {
        ...pageOutcome,
        droppedUnassignedRowCount: coverage.droppedUnassignedRowCount,
        recoveryReason: page.recoveryReason,
        recoveryMode: useRenderedImage ? "rendered_image" : "pdf_text",
      };
      const completed = diagnostics.filter(Boolean).length;
      await updateBankJob(jobId, {
        progress: Math.min(74, 70 + Math.round((completed / Math.max(1, pages.length)) * 4)),
        stage: useRenderedImage
          ? `Checking rendered pages ${completed}/${pages.length}`
          : `Recovering difficult pages ${completed}/${pages.length}`,
      });
      return parsed;
    } catch (error) {
      diagnostics[index] = {
        page: page.pageNumber,
        status: "failed",
        rowCount: 0,
        error: diagnosticError(error),
        recoveryReason: page.recoveryReason,
        reason: bankStatementFailureReason(error),
      };
      const completed = diagnostics.filter(Boolean).length;
      await updateBankJob(jobId, {
        progress: Math.min(74, 70 + Math.round((completed / Math.max(1, pages.length)) * 4)),
        stage: `Recovering statement pages ${completed}/${pages.length}`,
      });
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
    recoveryMode: null,
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

  const canUseSingleShot = shouldAttemptBankStatementSingleShot({
    isPdf,
    pageCount: Number(textInfo.pageCount || 0),
    pages: textInfo.pages,
    maxPages: BANK_STATEMENT_SINGLE_SHOT_MAX_PAGES,
    maxInputChars: BANK_STATEMENT_SINGLE_SHOT_MAX_INPUT_CHARS,
    maxLikelyRows: BANK_STATEMENT_SINGLE_SHOT_MAX_LIKELY_ROWS,
  });
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
        parsed.transactions = addBankStatementPageProvenance(parsed.transactions, {
          startPage: 1,
          endPage: Math.max(1, Number(textInfo.pageCount || 1)),
          method: extractionSource,
        });
        diagnostics.pipeline = "single_shot_ai";
        diagnostics.coverageComplete = true;
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
    const usedTextBatches = hasUsableBankStatementText(textPages);
    if (usedTextBatches) {
      batchResult = await extractBankStatementTextBatches(fileName, textPages, jobId);
      extractionSource = "batched_ai_pdf_text";
    } else {
      batchResult = await extractBankStatementImageBatches(
        fileName,
        bytes,
        pageCount,
        jobId,
        textPagesByNumber
      );
      extractionSource = "batched_ai_pdf_images";
    }

    diagnostics.pipeline = "batched_ai";
    diagnostics.batches = batchResult.diagnostics;
    parsed = batchResult.parsed;

    const expectedRecoveryPages = Array.from(
      new Set(
        batchResult.failedBatches.flatMap((batch) =>
          batch.pages.map((page) => Number(page.pageNumber)).filter(Number.isFinite)
        )
      )
    );
    diagnostics.unresolvedPages = expectedRecoveryPages;
    diagnostics.coverageComplete = expectedRecoveryPages.length === 0 && !textInfo.truncated;

    if (expectedRecoveryPages.length > 0 && BANK_STATEMENT_SINGLE_PAGE_RECOVERY_LIMIT > 0) {
      // Keep readable PDF text authoritative for AI input. Render a page only
      // when its text is absent or too large for a safe provider request.
      const forceRenderedImages = !usedTextBatches;
      await updateBankJob(jobId, {
        progress: 70,
        stage: forceRenderedImages
          ? "Retrying difficult pages as rendered images"
          : "Recovering difficult pages",
      });
      const recovery = await recoverSinglePages({
        fileName,
        bytes,
        textPagesByNumber,
        failedBatches: batchResult.failedBatches,
        jobId,
        forceRenderedImages,
      });
      const usedRenderedRecovery = recovery.diagnostics.some((entry) => entry?.recoveryMode === "rendered_image");
      const usedTextRecovery = recovery.diagnostics.some((entry) => entry?.recoveryMode === "pdf_text");
      diagnostics.pipeline = usedRenderedRecovery
        ? usedTextRecovery
          ? "mixed_single_page_recovery"
          : "rendered_image_recovery"
        : "single_page_text_recovery";
      diagnostics.recoveryMode = usedRenderedRecovery
        ? usedTextRecovery
          ? "mixed"
          : "rendered_images"
        : "pdf_text";
      diagnostics.recovery = recovery.diagnostics;
      parsed = mergeBankStatementResults([parsed, recovery.parsed]);
      const unresolvedPages = unresolvedBankStatementRecoveryPages(
        recovery.diagnostics,
        expectedRecoveryPages
      );
      diagnostics.unresolvedPages = unresolvedPages;
      diagnostics.coverageComplete = unresolvedPages.length === 0;
      if (usedRenderedRecovery && recovery.parsed.transactions.length > 0) {
        extractionSource = "single_page_ai_pdf_images";
      }
    }

    if (parsed.transactions.length > 0) {
      const unresolvedPages = Array.isArray(diagnostics.unresolvedPages) ? diagnostics.unresolvedPages : [];
      extractionError =
        unresolvedPages.length > 0
          ? `Could not verify transaction extraction on page${unresolvedPages.length === 1 ? "" : "s"} ${unresolvedPages.join(", ")}.`
          : textInfo.truncated
            ? `The statement has ${textInfo.pageCount} pages, but this worker is configured to analyze at most ${BANK_STATEMENT_MAX_TOTAL_PAGES}.`
            : null;
      diagnostics.coverageComplete = unresolvedPages.length === 0 && !textInfo.truncated;
      return { parsed, extractionSource, extractionError, diagnostics };
    }
  } catch (error) {
    diagnostics.errors.push({ stage: "batched_ai", error: diagnosticError(error) });
    console.warn(`[worker] batched AI extraction failed for ${fileName}: ${diagnosticError(error)}`);
  }

  diagnostics.pipeline = "manual_review_required";
  extractionError =
    lastItem(diagnostics.errors)?.error ||
    (diagnostics.recoveryMode === "rendered_images"
      ? "Extraction failed after checking both readable PDF text and rendered page images. Review the document or retry extraction."
      : "No transaction rows were extracted. The file may need manual review or a clearer scan.");
  return {
    parsed: parsed ?? normalizeAiBankStatement({}),
    extractionSource: extractionSource === "none" ? "manual_review_required" : extractionSource,
    extractionError,
    diagnostics,
  };
}

async function updateBankJob(jobId, fields) {
  const updateFields =
    fields.locked_at === undefined && fields.status === undefined
      ? { ...fields, locked_at: new Date().toISOString() }
      : fields;
  const { error } = await supabase
    .from("bank_statement_extraction_jobs")
    .update(updateFields)
    .eq("id", jobId);
  if (error) throw error;
}

function startBankJobHeartbeat(jobId) {
  const timer = setInterval(() => {
    void updateBankJob(jobId, { locked_at: new Date().toISOString() }).catch((error) => {
      console.warn(`[worker] bank job heartbeat failed for ${jobId}: ${diagnosticError(error)}`);
    });
  }, BANK_STATEMENT_JOB_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function claimNextBankStatementJob() {
  const { data, error } = await supabase.rpc("claim_bank_statement_extraction_job", {
    worker_name: WORKER_NAME,
    stale_after: WORKER_STALE_RUNNING_JOB_INTERVAL,
    worker_pool: WORKER_POOL,
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

function bankLedgerMatchTransaction(row) {
  return {
    transactionDate: row.transaction_date || "",
    valueDate: row.value_date || null,
    description: row.description || "",
    referenceNumber: row.reference_number || null,
    debitAmount: row.debit_amount ?? null,
    creditAmount: row.credit_amount ?? null,
    balanceAmount: row.balance_amount ?? null,
    transactionType: row.transaction_type || undefined,
    category: row.category || undefined,
    counterpartyName: row.counterparty_name || null,
  };
}

async function addBankLedgerRecommendations({
  rows,
  ownerUserId,
  connectionId,
  accountId,
}) {
  if (rows.length === 0) return rows;

  const suggestions = await suggestBankLedgersForTransactions({
    supabase,
    ownerUserId,
    connectionId,
    transactions: rows.map((row) => ({
      accountId,
      transaction: bankLedgerMatchTransaction(row),
    })),
  });

  return rows.map((row, index) => {
    const suggestion = suggestions[index];
    if (!suggestion) return row;

    const recommendationCompleted = suggestion.mappingSource !== "none";
    const rawPayload =
      row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload)
        ? row.raw_payload
        : {};
    return {
      ...row,
      suggested_ledger_name: suggestion.ledgerName,
      suggestion_confidence: suggestion.confidence,
      suggestion_reason: suggestion.reason,
      raw_payload: {
        ...rawPayload,
        aiLedgerRecommendation: {
          matchType: suggestion.matchType || (suggestion.ledgerName ? "direct_match" : "suspense"),
          action: suggestion.ledgerName ? "use_existing_ledger" : "use_suspense",
          ledgerName: suggestion.ledgerName,
          candidateLedgerNames: suggestion.candidateLedgerNames || [],
          confidence: suggestion.confidence,
          reason: suggestion.reason,
          model: recommendationCompleted
            ? suggestion.mappingSource === "ai_match"
              ? OPENROUTER_BANK_LEDGER_MODEL
              : suggestion.mappingSource
            : null,
          source: suggestion.mappingSource,
          status: recommendationCompleted ? "completed" : "unavailable",
        },
      },
    };
  });
}

function markBankLedgerRecommendationsUnavailable(rows, reason, status = "unavailable") {
  return rows.map((row) => {
    const rawPayload =
      row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload)
        ? row.raw_payload
        : {};
    return {
      ...row,
      suggested_ledger_name: null,
      suggestion_confidence: null,
      suggestion_reason: reason,
      raw_payload: {
        ...rawPayload,
        aiLedgerRecommendation: {
          matchType: "suspense",
          action: "use_suspense",
          ledgerName: null,
          candidateLedgerNames: [],
          confidence: null,
          reason,
          model: null,
          source: "none",
          status,
        },
      },
    };
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
  // AI receives only the already-unlocked stored bytes and a neutral filename.
  // User filenames such as "password-protected.pdf" can incorrectly bias model output.
  const analysisFileName = isPdf ? "bank-statement.pdf" : fileName;
  const stopHeartbeat = startBankJobHeartbeat(job.id);
  let extraction;
  try {
    extraction = await extractBankStatementAdaptive({
      fileName: analysisFileName,
      mimeType,
      bytes,
      isPdf,
      isImage,
      jobId: job.id,
      bankAccountCandidates,
    });
  } finally {
    stopHeartbeat();
  }
  const parsed = extraction.parsed ?? normalizeAiBankStatement({});
  const extractionSource = extraction.extractionSource;
  let extractionError = extraction.extractionError;
  const extractionDiagnostics = extraction.diagnostics;
  const balanceValidation = validateRunningBalanceContinuity(parsed.transactions, parsed.openingBalance);
  extractionDiagnostics.balanceValidation = balanceValidation;
  if (!balanceValidation.valid) {
    extractionDiagnostics.coverageComplete = false;
    const balancePages = balanceValidation.breaks
      .map((entry) => entry.page)
      .filter((page) => Number.isFinite(page));
    extractionDiagnostics.unresolvedPages = Array.from(new Set([
      ...(Array.isArray(extractionDiagnostics.unresolvedPages) ? extractionDiagnostics.unresolvedPages : []),
      ...balancePages,
    ])).sort((left, right) => left - right);
    extractionError = `Running-balance validation failed at ${balanceValidation.breaks.length} transaction${balanceValidation.breaks.length === 1 ? "" : "s"}.`;
  }
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
  const extractionIncomplete =
    Boolean(extractionError) || extractionDiagnostics?.coverageComplete === false;
  const finalStatus =
    parsed.transactions.length === 0 || extractionIncomplete
      ? "manual_review_required"
      : candidateCount > 1
        ? "needs_account_selection"
        : "ready_to_review";
  const rows = parsed.transactions.map((transaction, index) => ({
    import_id: job.import_id,
    owner_user_id: job.owner_user_id,
    ...transaction,
    row_index: index + 1,
  }));
  await updateBankJob(job.id, { progress: 82, stage: "Matching Tally ledgers" });
  let ledgerRecommendationError = null;
  let previewRows;
  if (extractionIncomplete) {
    ledgerRecommendationError =
      "Ledger matching is paused because one or more statement pages still need extraction review.";
    previewRows = markBankLedgerRecommendationsUnavailable(rows, ledgerRecommendationError, "deferred");
  } else {
    try {
      previewRows = await addBankLedgerRecommendations({
        rows,
        ownerUserId: job.owner_user_id,
        connectionId: tallyConnectionId,
        accountId: String(selectedAccountId || importRow.bank_account_id || ""),
      });
    } catch (error) {
      const detail = diagnosticError(error);
      ledgerRecommendationError = `Statement rows were extracted, but ledger matching is temporarily unavailable: ${detail}`;
      previewRows = markBankLedgerRecommendationsUnavailable(rows, ledgerRecommendationError);
      console.warn(`[worker] ledger matching deferred for ${fileName}: ${detail}`);
    }
  }

  const incompleteRecommendationCount = previewRows.reduce((count, row) => {
    const payload = row?.raw_payload;
    const recommendation =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload.aiLedgerRecommendation
        : null;
    return recommendation?.status === "completed" ? count : count + 1;
  }, 0);
  if (incompleteRecommendationCount > 0 && !ledgerRecommendationError) {
    ledgerRecommendationError =
      `Ledger matching is pending for ${incompleteRecommendationCount} of ${previewRows.length} transaction(s).`;
  }

  await updateBankJob(job.id, { progress: 88, stage: "Saving preview rows" });
  await supabase
    .from("bank_statement_import_preview_transactions")
    .delete()
    .eq("import_id", job.import_id)
    .eq("owner_user_id", job.owner_user_id);

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
  const analysisStage =
    parsed.transactions.length > 0 ? "Statement analyzed" : "Extraction needs attention";
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
        ledgerRecommendationError,
        ledgerRecommendationIncompleteCount: incompleteRecommendationCount,
        normalizedAccountNumber,
        maskedAccountNumber: maskAccountNumber(account.accountNumber),
        ifscCode: account.ifscCode,
        previewTransactionCount: previewRows.length,
        completedAt,
        analysis: {
          ...previousAnalysis,
          status: "completed",
          progress: 100,
          stage: analysisStage,
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
    stage: extractionIncomplete ? "Completed with unresolved pages" : "Completed",
    error: null,
    result: {
      importId: job.import_id,
      transactionCount: previewRows.length,
      ledgerRecommendationCount: previewRows.length - incompleteRecommendationCount,
      ledgerRecommendationIncompleteCount: incompleteRecommendationCount,
      status: finalStatus,
      coverageComplete: !extractionIncomplete,
      unresolvedPages: extractionDiagnostics?.unresolvedPages ?? [],
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

async function claimNextTallyQueueJob() {
  const { data, error } = await supabase.rpc("claim_bank_statement_tally_queue_job", {
    worker_name: WORKER_NAME,
    stale_after: "5 minutes",
  });
  if (error) {
    const message = formatError(error);
    // Allows code deployment before the migration is applied. The web/API keeps
    // serving while Tally preparation waits safely in the database.
    if (/claim_bank_statement_tally_queue_job|PGRST202|42883/i.test(message)) return null;
    throw error;
  }
  return Array.isArray(data) ? data[0] ?? null : data ?? null;
}

async function runTallyQueueJob(job) {
  if (!job?.id) throw new Error("Cannot run a Tally queue job without an id.");

  for (let batch = 0; batch < 500; batch += 1) {
    const response = await fetch(
      `${APP_BASE_URL}/api/bank-statements/tally/queue-jobs/${job.id}/run`,
      {
        method: "POST",
        headers: { "x-worker-secret": WORKER_SECRET },
        signal: AbortSignal.timeout(25_000),
      }
    );
    const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));
    if (!response.ok) {
      throw new Error(payload?.error || `Tally queue batch failed (${response.status})`);
    }
    const status = payload?.job?.status;
    const processed = Number(payload?.job?.processedCount ?? 0);
    const total = Number(payload?.job?.totalCount ?? 0);
    console.log(`[worker] Tally queue ${job.id}: ${processed}/${total} status=${status ?? "unknown"}`);
    if (["succeeded", "failed", "cancelled"].includes(status)) {
      if (status !== "succeeded") throw new Error(payload?.job?.error || `Tally queue job ${status}`);
      return;
    }
  }
  throw new Error("Tally queue job exceeded the 500-batch safety limit.");
}

async function requeueTallyQueueJob(job, error) {
  const attempts = Number(job?.attempt_count ?? 1);
  const maxAttempts = Number(job?.max_attempts ?? 5);
  const terminal = attempts >= maxAttempts;
  const delaySeconds = Math.min(120, Math.max(5, 5 * 2 ** Math.max(0, attempts - 1)));
  const now = new Date();
  const { error: updateError } = await supabase
    .from("bank_statement_tally_queue_jobs")
    .update({
      status: terminal ? "failed" : "queued",
      error: String(error ?? "Unknown Tally queue error").slice(0, 2000),
      locked_at: null,
      locked_by: null,
      next_run_at: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
      completed_at: terminal ? now.toISOString() : null,
      updated_at: now.toISOString(),
    })
    .eq("id", job.id);
  if (updateError) throw updateError;
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
    `[worker] started name=${WORKER_NAME} pool=${WORKER_POOL} appBase=${APP_BASE_URL} pollMs=${WORKER_POLL_INTERVAL_MS} bankPdfMode=adaptive_ai batchPages=${BANK_STATEMENT_BATCH_PAGE_SIZE} concurrency=${BANK_STATEMENT_BATCH_CONCURRENCY}`
  );
  let lastIdleLogAt = 0;

  while (true) {
    try {
      const tallyQueueJob = await claimNextTallyQueueJob();
      if (tallyQueueJob) {
        try {
          console.log(
            `[worker] claimed Tally queue job ${tallyQueueJob.id} attempt=${tallyQueueJob.attempt_count ?? "?"}/${tallyQueueJob.max_attempts ?? "?"}`
          );
          await runTallyQueueJob(tallyQueueJob);
          console.log(`[worker] completed Tally queue job ${tallyQueueJob.id}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
          console.error(`[worker] Tally queue failed for ${tallyQueueJob.id}: ${message}`);
          await requeueTallyQueueJob(tallyQueueJob, message);
        }
        continue;
      }

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
          console.log("[worker] idle: no queued Tally, bank statement, or packet jobs claimed");
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

const launchedAsMainModule = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
);

if (launchedAsMainModule) {
  main().catch((error) => {
    console.error("[worker] fatal error", error);
    process.exit(1);
  });
}

export {
  extractBankStatementFromTextBatch,
  extractBankStatementPdfTextPages,
  mergeBankStatementResults,
  validateRunningBalanceContinuity,
};
