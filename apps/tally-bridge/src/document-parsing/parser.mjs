import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { formatFromBytes, formatFromExtension, toDocument, toMarkdownBytes } from "@firecrawl/anydoc";
import { enrichBankStatementTransactions, validatePrintedStatementSummary } from "./transaction-details.mjs";
import { readScannedPdf } from "./scanned-pdf.mjs";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  ".doc", ".docx", ".docm", ".odt", ".rtf", ".epub", ".pdf",
  ".ppt", ".pps", ".pot", ".pptx", ".pptm", ".ppsx", ".ppsm", ".odp",
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".ods", ".csv",
];

let bankStatementModulesPromise = null;
let documentParserWarmupPromise = null;

async function loadBankStatementModules() {
  if (bankStatementModulesPromise) return bankStatementModulesPromise;
  const runtimeRoot = new URL("./backend-logic/", import.meta.url);
  const sourceRoot = new URL("../../../api/worker/", import.meta.url);
  const load = async (name) => {
    try {
      return await import(new URL(name, runtimeRoot));
    } catch {
      return import(new URL(name, sourceRoot));
    }
  };
  bankStatementModulesPromise = Promise.all([
    load("bank-statement-deterministic.mjs"),
    load("bank-statement-account.mjs"),
    load("bank-statement-markdown-amounts.mjs"),
    load("bank-statement-running-balance.mjs"),
    load("bank-statement-resilience.mjs"),
    load("bank-statement-pdf-columns.mjs"),
  ]).then(([deterministic, account, amounts, runningBalance, resilience, pdfColumns]) => ({
    deterministic, account, amounts, runningBalance, resilience, pdfColumns,
  }));
  return bankStatementModulesPromise;
}

function createWarmupPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 35 >>\nstream\nBT /F1 8 Tf 5 36 Td (Warmup) Tj ET\nendstream",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}

export function warmDocumentParser() {
  if (documentParserWarmupPromise) return documentParserWarmupPromise;
  documentParserWarmupPromise = Promise.all([
    loadBankStatementModules(),
    toMarkdownBytes(createWarmupPdf(), "pdf"),
  ]).then(() => ({ ready: true }));
  return documentParserWarmupPromise;
}

function normalizeOutput(value) {
  const output = String(value || "markdown").trim().toLowerCase();
  if (output === "md") return "markdown";
  if (output !== "markdown" && output !== "json") {
    throw new Error('Document output must be "markdown" or "json".');
  }
  return output;
}

async function readRequestBytes(request) {
  if (request?.filePath) {
    const filePath = path.resolve(String(request.filePath));
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Document path does not point to a file.");
    if (stat.size === 0) throw new Error("Document is empty.");
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
    return { bytes: fs.readFileSync(filePath), fileName: path.basename(filePath) };
  }
  const remoteUrl = request?.documentUrl || request?.sourceUrl || request?.url;
  if (remoteUrl) {
    const parsedUrl = new URL(String(remoteUrl));
    if (parsedUrl.protocol !== "https:") throw new Error("Remote documents must use HTTPS.");
    const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Document download failed with HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
    if (!response.body) throw new Error("Document download returned no content.");
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        throw new Error("Document is larger than the 25 MB limit.");
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, byteLength);
    if (!bytes.length) throw new Error("Document is empty.");
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
    const urlName = path.basename(decodeURIComponent(parsedUrl.pathname)) || "document";
    return { bytes, fileName: path.basename(String(request?.fileName || urlName)) };
  }
  let bytes = null;
  if (Buffer.isBuffer(request?.bytes) || request?.bytes instanceof Uint8Array) {
    bytes = Buffer.from(request.bytes);
  } else if (typeof request?.base64 === "string" && request.base64.trim()) {
    const encoded = request.base64.trim().replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
      throw new Error("Document base64 content is invalid.");
    }
    bytes = Buffer.from(encoded, "base64");
  }
  if (!bytes?.length) throw new Error("Document request requires filePath, bytes, or base64.");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
  return { bytes, fileName: path.basename(String(request?.fileName || "document")) };
}

function requestedFormat(request, fileName, bytes) {
  const explicit = String(request?.format || "").trim().toLowerCase().replace(/^\./, "");
  if (explicit) {
    const format = formatFromExtension(explicit);
    if (!format) throw new Error(`Unsupported document format: ${explicit}.`);
    return format;
  }
  return formatFromBytes(bytes) || formatFromExtension(path.extname(fileName));
}

function jsonSafeDocument(document) {
  return {
    ...document,
    assets: (document.assets || []).map((asset) => {
      const { data, ...rest } = asset;
      return {
        ...rest,
        byteLength: data?.length || 0,
        dataBase64: data ? Buffer.from(data).toString("base64") : "",
      };
    }),
  };
}

function metadata({ fileName, format, bytes, startedAt, structured }) {
  return {
    fileName,
    format,
    byteLength: bytes.length,
    structured,
    parser: "firecrawl-anydoc",
    processing: "local",
    ocrUsed: false,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  };
}

function approximatePdfPageCount(bytes) {
  const source = Buffer.from(bytes).toString("latin1");
  return Math.max(1, (source.match(/\/Type\s*\/Page\b/g) || []).length);
}

function requiresDocumentOcr(error) {
  return error?.code === "needsOcr" || /needs?\s+OCR|OCR\s+is\s+required/i.test(error?.message || "");
}

function physicalDate(value) {
  const iso = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const date = new Date(Date.UTC(Number(iso[1]),Number(iso[2])-1,Number(iso[3])));
    return date.toISOString().slice(0,10) === iso[0] ? iso[0] : null;
  }
  const match = String(value || "").match(/^(\d{1,2})[-/ ](\d{1,2}|[A-Za-z]{3})[-/ ](\d{2,4})/);
  if (!match) return null;
  const month = /^[A-Za-z]/.test(match[2])
    ? String(['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[2].toLowerCase()) + 1)
    : match[2];
  const result = `${match[3].length === 2 ? '20' : ''}${match[3]}-${month.padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const date = new Date(Date.UTC(Number(result.slice(0,4)),Number(month)-1,Number(match[1])));
  return date.toISOString().slice(0,10) === result ? result : null;
}

function transactionsFromPhysicalRows(rows) {
  return rows.map((row, sourceIndex) => ({
    row_index: sourceIndex + 1,
    transaction_date: physicalDate(row.sourceDate),
    value_date: physicalDate(row.valueDate || row.sourceDate),
    description: String(row.narration || "").replace(/\s+/g, " ").trim(),
    reference_number: row.reference || null,
    debit_amount: row.debitAmount > 0 ? row.debitAmount : null,
    credit_amount: row.creditAmount > 0 ? row.creditAmount : null,
    balance_amount: row.balanceAmount,
    transaction_type: "unknown",
    category: row.creditAmount > 0 ? "receipt" : "payment",
    counterparty_name: null,
    suggested_ledger_name: null,
    suggestion_confidence: null,
    suggestion_reason: null,
    confirmed_ledger_name: null,
    additional_charges: [],
    confidence: 0.95,
    raw_payload: {
      rowNumber: sourceIndex + 1,
      source: "physical_pdf_columns",
      extractionProvenance: {
        startPage: row.page,
        endPage: row.page,
        sourceIndex,
        method: "physical_pdf_columns",
      },
    },
  }));
}

export async function processBankStatementMarkdownLocal(markdown, { pageCount = 1, pdfBytes = null, physicalEvidence = null } = {}) {
  const { deterministic, account, amounts, runningBalance, resilience, pdfColumns } = await loadBankStatementModules();
  let normalized = deterministic.deterministicTransactionsFromAnydoc(markdown);
  let pipeline = "deterministic_anydoc";
  let physical = physicalEvidence;
  let physicalWarning = null;
  if (pdfBytes && !physicalEvidence) {
    try {
      physical = await pdfColumns.readBankStatementPhysicalColumns(pdfBytes);
    } catch (error) {
      if (!normalized?.transactions?.length || /\bTxn No\.?\b/i.test(markdown)) throw error;
      physicalWarning = "Physical table verification was unavailable; the normalized rows were checked against their running balances.";
    }
    // PNB's Markdown may contain the right amounts but clipped narrations.
    // Its printed table cells remain authoritative even when balances pass.
    if (physical?.imageOnlyPages?.length) {
      const error = new Error("This statement contains scanned pages and needs OCR.");
      error.code = "ocr_required";
      throw error;
    }
  }
  if (physical?.detected && physical.rows.length && (physicalEvidence || !normalized?.transactions?.length || physical.layout === "pnb")) {
    normalized = {
      headers: [`physical:${physical.layout}`],
      transactions: transactionsFromPhysicalRows(physical.rows),
    };
    pipeline = "physical_pdf_columns";
  }
  if (!normalized?.transactions?.length) {
    const error = new Error("The bank-statement tables could not be normalized deterministically.");
    error.code = "deterministic_extraction_unavailable";
    throw error;
  }
  if (normalized.transactions.some(row=>!row.transaction_date)) {
    const error = new Error("A transaction date could not be read reliably. Please review the original statement.");
    error.code = "statement_date_uncertain";
    throw error;
  }
  const sourceCoverage = physical?.detected && physical.rows.length ? {
    checked:true,sourceRows:physical.rows.length,extractedRows:normalized.transactions.length,
    complete:physical.rows.length===normalized.transactions.length,
  } : {checked:false};
  if (sourceCoverage.checked && !sourceCoverage.complete) {
    const error = new Error("Some statement entries could not be read reliably. Please review the original PDF.");
    error.code = "statement_row_count_mismatch";
    throw error;
  }
  const source = amounts.extractBankStatementMarkdownAmounts(markdown);
  const openingBalance = physical?.openingBalance ?? source.openingBalance;
  const references = amounts.restoreSourceBankReferences(normalized.transactions, source.rows);
  normalized.transactions = references.transactions;
  const accountFromMarkdown = account.extractAccountFromBankStatementMarkdown(markdown);
  const statementPeriod = account.extractBankStatementPeriodFromMarkdown(markdown);
  let balanceValidation = runningBalance.validateRunningBalanceContinuity(
    normalized.transactions,
    openingBalance,
  );
  if (balanceValidation.status === "failed" && pdfBytes && !physical) {
    physical = await pdfColumns.readBankStatementPhysicalColumns(pdfBytes);
    const identity = (date, description, reference) => JSON.stringify([date,
      String(description || '').toLowerCase().replace(/\s+/g, ' ').trim(),
      String(reference || '').toUpperCase().replace(/[^A-Z0-9]/g, '')]);
    const sourceIdentities = normalized.transactions.filter(row => !/^(?:opening balance|closing balance)$/i.test(row.description))
      .map(row => identity(row.transaction_date, row.description, row.reference_number)).sort();
    const physicalIdentities = physical.rows.map(row => identity(physicalDate(row.sourceDate), row.narration, row.reference)).sort();
    if (physical.detected && physical.rows.length && JSON.stringify(sourceIdentities) === JSON.stringify(physicalIdentities)) {
      normalized.transactions = transactionsFromPhysicalRows(physical.rows);
      pipeline = "physical_pdf_columns";
      balanceValidation = runningBalance.validateRunningBalanceContinuity(normalized.transactions, openingBalance);
    }
  }
  if (balanceValidation.status === "failed") {
    const error = new Error(`Running-balance validation failed at ${balanceValidation.breaks.length} transaction${balanceValidation.breaks.length === 1 ? "" : "s"}.`);
    error.code = "running_balance_failed";
    error.diagnostics = { balanceValidation };
    throw error;
  }
  const summaryValidation = validatePrintedStatementSummary(markdown, normalized.transactions, openingBalance, balanceValidation.orientation);
  if (summaryValidation.status === "failed") {
    const error = new Error("The extracted entries do not match the totals printed on this statement. Please review the original PDF.");
    error.code = "statement_summary_mismatch";
    error.diagnostics = { summaryValidation };
    throw error;
  }
  const printedReferenceKind = physical?.referenceKind ?? (normalized.headers.some(header=>/cheque|chq/i.test(header)) ? "cheque" : "reference");
  normalized.transactions = enrichBankStatementTransactions(normalized.transactions, {
    physicalLayout:physical?.layout, bankName:accountFromMarkdown.bankName,
    accountHolderName:accountFromMarkdown.accountHolderName, printedReferenceKind,
  });
  return {
    parsed: {
      account: account.mergeBankStatementAccount({}, accountFromMarkdown),
      ...statementPeriod,
      openingBalance,
      transactions: pipeline === "physical_pdf_columns"
        ? normalized.transactions
        : resilience.addBankStatementPageProvenance(normalized.transactions, {
            startPage: 1,
            endPage: Math.max(1, Number(pageCount) || 1),
            method: "deterministic_anydoc",
          }),
      pageResults: [],
    },
    diagnostics: {
      pipeline,
      physicalLayout: physical?.layout ?? null,
      rowCount: normalized.transactions.length,
      headers: normalized.headers,
      normalized: true,
      referenceValidation: references.diagnostics,
      statementDetails: {
        fields: {
          accountHolderName: Boolean(accountFromMarkdown.accountHolderName),
          statementPeriod: Boolean(statementPeriod.statementPeriodStart && statementPeriod.statementPeriodEnd),
          openingBalance: source.openingBalance !== null,
        },
        warnings: [
          ...(!accountFromMarkdown.accountHolderName ? ["Account-holder name could not be read."] : []),
          ...(!statementPeriod.statementPeriodStart ? ["The statement period could not be read."] : []),
          ...(source.openingBalance === null && /\b(?:opening balance|balance brought forward|balance b\/?f|brought forward balance)\b/i.test(markdown)
            ? ["The printed opening balance could not be read."] : []),
        ],
      },
      balanceValidation,
      summaryValidation,
      sourceCoverage,
      ...(physicalWarning ? {warnings:[physicalWarning]} : {}),
      used: true,
    },
  };
}

export async function parseDocumentLocal(request = {}) {
  const startedAt = performance.now();
  const output = normalizeOutput(request.output || request.outputFormat);
  const { bytes, fileName } = await readRequestBytes(request);
  const format = requestedFormat(request, fileName, bytes);
  if (!format) throw new Error("Document format could not be detected. Supply a supported file extension or format.");

  try {
    if (output === "markdown") {
      try {
        const markdown = await toMarkdownBytes(bytes, format);
        return { outputFormat: "markdown", content: markdown, metadata: metadata({ fileName, format, bytes, startedAt, structured: false }) };
      } catch (error) {
        if (format !== "pdf" || !requiresDocumentOcr(error)) throw error;
        const {pdfColumns} = await loadBankStatementModules();
        const ocr = await readScannedPdf(bytes,pdfColumns.extractBankStatementPhysicalColumns);
        await processBankStatementMarkdownLocal(ocr.markdown,{pageCount:ocr.pages,physicalEvidence:ocr.physical});
        return {outputFormat:"markdown",content:ocr.markdown,metadata:{...metadata({fileName,format,bytes,startedAt,structured:false}),ocrUsed:true}};
      }
    }
    if (format === "pdf") {
      let markdown;
      try { markdown = await toMarkdownBytes(bytes, format); }
      catch (error) {
        if (!requiresDocumentOcr(error)) throw error;
        markdown = "";
      }
      let ocr = null;
      let bankStatement;
      try {
      bankStatement = await processBankStatementMarkdownLocal(markdown, {
        pageCount: request.pageCount || approximatePdfPageCount(bytes),
        pdfBytes: bytes,
      });
      } catch (error) {
        if (!["ocr_required","deterministic_extraction_unavailable"].includes(error.code)) throw error;
        try {
          const {pdfColumns} = await loadBankStatementModules();
          ocr = await readScannedPdf(bytes,pdfColumns.extractBankStatementPhysicalColumns);
          bankStatement = await processBankStatementMarkdownLocal(ocr.markdown,{pageCount:ocr.pages,physicalEvidence:ocr.physical});
          bankStatement.parsed.transactions = bankStatement.parsed.transactions.map(row=>({...row,confidence:Math.min(row.confidence,0.8),raw_payload:{...row.raw_payload,ocrUsed:true}}));
          bankStatement.diagnostics.ocr = {used:true,languages:ocr.languages,reviewRecommended:true};
          bankStatement.diagnostics.warnings = [...(bankStatement.diagnostics.warnings||[]),"This statement was read from scanned images. Please review the names and amounts before posting."];
        } catch (ocrError) {
          const failure = new Error("The scanned statement could not be read reliably. Please upload a clearer scan or a text PDF.");
          failure.code = ocrError.code || "ocr_review_required";
          throw failure;
        }
      }
      return {
        outputFormat: "json",
        content: bankStatement.parsed,
        metadata: {
          ...metadata({ fileName, format, bytes, startedAt, structured: true }),
          ocrUsed: Boolean(ocr),
          sourceFormat: ocr ? "windows_ocr_physical" : "anydoc_markdown",
          diagnostics: bankStatement.diagnostics,
        },
      };
    }
    const document = await toDocument(bytes, format);
    return {
      outputFormat: "json",
      content: jsonSafeDocument(document),
      metadata: metadata({ fileName, format, bytes, startedAt, structured: true }),
    };
  } catch (error) {
    const wrapped = new Error(error?.message || "Document could not be parsed locally.");
    wrapped.code = error?.code || "parse_failed";
    throw wrapped;
  }
}
