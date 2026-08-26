#!/usr/bin/env node

import fs from "node:fs";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rootCertificates } from "node:tls";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const BRIDGE_VERSION = "0.1.49";
const DEFAULT_TALLY_URL = "http://localhost:9000";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 3_000;
const MAX_COMMANDS_PER_CYCLE = 50;
const TALLY_IMPORT_TIMEOUT_MS = 30_000;
// Exports can be larger than imports, but they must still release the bridge
// cycle if Tally is busy or has stopped responding.
const TALLY_EXPORT_TIMEOUT_MS = 60_000;
const OPEN_BILL_LEDGER_BATCH_SIZE = 50;
const CONFIG_DIR = path.join(os.homedir(), ".gajkesari-tally-bridge");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const INSTALLATION_ID_PATH = path.join(CONFIG_DIR, "installation-id");
const MAX_NATIVE_DEBIT_NOTE_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PURCHASE_SOURCE_PDF_BYTES = 25 * 1024 * 1024;
const PURCHASE_DOCUMENT_UDFS = {
  path: { name: "GajkesariSourceDocumentPath", index: 30001 },
  name: { name: "GajkesariSourceDocumentName", index: 30002 },
  sha256: { name: "GajkesariSourceDocumentSha256", index: 30003 },
  id: { name: "GajkesariSourceDocumentId", index: 30004 },
};
const DEFAULT_TALLY_DATA_ROOT = path.join(process.env.PUBLIC || "C:\\Users\\Public", "TallyPrime", "data");
const CURRENT_FILE = fileURLToPath(import.meta.url);
let cachedWindowsTlsCertificates;

function windowsTlsCertificates() {
  if (cachedWindowsTlsCertificates) return cachedWindowsTlsCertificates;
  cachedWindowsTlsCertificates = [...rootCertificates];
  if (process.platform !== "win32") return cachedWindowsTlsCertificates;

  try {
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const output = execFileSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$locations = [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine,[System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser; foreach ($location in $locations) { foreach ($name in 'Root','CA') { $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($name,$location); try { $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly); foreach ($certificate in $store.Certificates) { [Convert]::ToBase64String($certificate.RawData) } } finally { $store.Close() } } }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const windowsRoots = output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .flatMap((value) => {
        try {
          return [new X509Certificate(Buffer.from(value, "base64")).toString()];
        } catch {
          return [];
        }
      });
    cachedWindowsTlsCertificates.push(...windowsRoots);
  } catch {
    // The standard Node root set remains available if Windows certificate
    // discovery is blocked by local policy.
  }
  return cachedWindowsTlsCertificates;
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      continue;
    }

    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function required(value, name) {
  if (!value) {
    throw new Error(`Missing required argument: --${name}`);
  }

  return value;
}

function normalizeBaseUrl(value) {
  return required(value, "api-base").replace(/\/+$/, "");
}

function normalizeTallyUrl(value) {
  return (value || DEFAULT_TALLY_URL).replace(/\/+$/, "");
}

function formatTallyConnectivityError(tallyUrl, error) {
  const target = normalizeTallyUrl(tallyUrl);
  const baseMessage = error instanceof Error ? error.message : String(error ?? "Unable to reach Tally.");
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const causeCode = cause && typeof cause.code === "string" ? cause.code : "";
  const causeMessage = cause?.message || "";
  const combined = `${baseMessage} ${causeMessage} ${causeCode}`.trim();

  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|AbortError/i.test(combined)) {
    return `Unable to reach Tally at ${target}. Check the Tally server IP/hostname, port 9000, Windows firewall, and that this connector machine is on the same LAN or VPN.`;
  }

  return combined || `Unable to reach Tally at ${target}.`;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  // Older connector releases persisted the last detected Tally company here.
  // That value is session state, not configuration: on the next launch it can
  // incorrectly override the company that is actually active in TallyPrime.
  if (Object.prototype.hasOwnProperty.call(config, "companyName")) {
    delete config.companyName;
    writeConfig(config);
  }

  return config;
}

function formatCliError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;
  if (cause instanceof Error) {
    const code = typeof cause.code === "string" ? ` (${cause.code})` : "";
    return `${error.message}: ${cause.message}${code}`;
  }

  return error.message;
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function deleteConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.rmSync(CONFIG_PATH, { force: true });
  }
}

function createMachineId() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  let installationId = "";
  if (fs.existsSync(INSTALLATION_ID_PATH)) {
    installationId = fs.readFileSync(INSTALLATION_ID_PATH, "utf8").trim();
  }
  if (!installationId) {
    installationId = randomUUID();
    fs.writeFileSync(INSTALLATION_ID_PATH, `${installationId}\n`, { mode: 0o600 });
  }

  return `${os.hostname()}-${os.platform()}-${os.arch()}-${installationId}`;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `HTTP ${response.status}` };
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXmlEntities(value) {
  let decoded = String(value ?? "");
  for (let index = 0; index < 3; index += 1) {
    const next = decoded
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
        const parsed = Number.parseInt(code, 16);
        return Number.isFinite(parsed) && parsed >= 32 ? String.fromCodePoint(parsed) : " ";
      })
      .replace(/&#(\d+);/g, (_, code) => {
        const parsed = Number.parseInt(code, 10);
        return Number.isFinite(parsed) && parsed >= 32 ? String.fromCodePoint(parsed) : " ";
      })
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function cleanXmlText(value) {
  return decodeXmlEntities(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTagText(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? cleanXmlText(match[1]) : null;
}

function getUdfTagText(block, tagName) {
  const match = block.match(
    new RegExp(`<(?:UDF:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:UDF:)?${tagName}>`, "i")
  );
  return match ? cleanXmlText(match[1]) : null;
}

function getTagTexts(block, tagName) {
  const matches = [...block.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi"))];
  return matches.map((match) => cleanXmlText(match[1])).filter(Boolean);
}

function getAttribute(block, attributeName) {
  const match = block.match(new RegExp(`\\b${attributeName}\\s*=\\s*"([^"]*)"`, "i"));
  return match ? cleanXmlText(match[1]) : null;
}

function extractBlocks(xml, tagName) {
  const blocks = [];
  const regex = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
  let match = regex.exec(xml);

  while (match) {
    blocks.push(match[0]);
    match = regex.exec(xml);
  }

  return blocks;
}

function buildTallyReadinessXml(companyName) {
  const companyVariable = companyName
    ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`
    : "";

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<VERSION>1</VERSION>",
    "<TALLYREQUEST>Export</TALLYREQUEST>",
    "<TYPE>Collection</TYPE>",
    "<ID>Gajkesari Ledgers Probe</ID>",
    "</HEADER>",
    "<BODY>",
    "<DESC>",
    "<STATICVARIABLES>",
    companyVariable,
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    "</STATICVARIABLES>",
    "<TDL>",
    "<TDLMESSAGE>",
    '<COLLECTION NAME="Gajkesari Ledgers Probe" ISMODIFY="No">',
    "<TYPE>Ledger</TYPE>",
    "<FETCH>Name,Parent,GUID</FETCH>",
    "</COLLECTION>",
    "</TDLMESSAGE>",
    "</TDL>",
    "</DESC>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

function buildCollectionExportXml({
  collectionName,
  tallyType,
  fetchFields,
  companyName,
  childOf,
  dateFrom,
  dateTo,
  formulae = [],
  filterNames = [],
}) {
  const companyVariable = companyName
    ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`
    : "";
  const dateVariables = [
    dateFrom ? `<SVFROMDATE TYPE="Date">${escapeXml(String(dateFrom).replaceAll("-", ""))}</SVFROMDATE>` : "",
    dateTo ? `<SVTODATE TYPE="Date">${escapeXml(String(dateTo).replaceAll("-", ""))}</SVTODATE>` : "",
  ].filter(Boolean);
  const childOfFilter = childOf
    ? `<ADD>CHILD OF : ${escapeXml(childOf)}</ADD>`
    : "";
  const safeFormulae = formulae.filter(
    (formula) => formula && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(formula.name || "")) && String(formula.formula || "").trim()
  );
  const availableFormulaNames = new Set(safeFormulae.map((formula) => formula.name));
  const appliedFilterNames = filterNames.filter((name) => availableFormulaNames.has(name));
  const collectionFilter = appliedFilterNames.length > 0
    ? `<FILTER>${escapeXml(appliedFilterNames.join(","))}</FILTER>`
    : "";
  const formulaDefinitions = safeFormulae.map(
    ({ name, formula }) =>
      `<SYSTEM TYPE="Formulae" NAME="${escapeXml(name)}" ISMODIFY="No">${escapeXml(String(formula).trim())}</SYSTEM>`
  );

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<VERSION>1</VERSION>",
    "<TALLYREQUEST>Export</TALLYREQUEST>",
    "<TYPE>Collection</TYPE>",
    `<ID>${escapeXml(collectionName)}</ID>`,
    "</HEADER>",
    "<BODY>",
    "<DESC>",
    "<STATICVARIABLES>",
    companyVariable,
    ...dateVariables,
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    "</STATICVARIABLES>",
    "<TDL>",
    "<TDLMESSAGE>",
    `<COLLECTION NAME="${escapeXml(collectionName)}" ISMODIFY="No">`,
    `<TYPE>${escapeXml(tallyType)}</TYPE>`,
    childOfFilter,
    collectionFilter,
    `<FETCH>${escapeXml(fetchFields)}</FETCH>`,
    "</COLLECTION>",
    ...formulaDefinitions,
    "</TDLMESSAGE>",
    "</TDL>",
    "</DESC>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

function tallyFormulaString(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function buildRequestedLedgerFormula(ledgerNames, methodNames = ["$LedgerName"]) {
  const names = uniquePayloadLedgerNames({ ledgerNames });
  const methods = Array.from(new Set(methodNames.map((method) => String(method || "").trim()).filter(Boolean)));
  if (names.length === 0 || methods.length === 0) return "$$IsEmpty:$Name AND NOT $$IsEmpty:$Name";
  return names
    .flatMap((ledgerName) => methods.map((method) => `$$IsEqual:${method}:${tallyFormulaString(ledgerName)}`))
    .map((condition) => `(${condition})`)
    .join(" OR ");
}

function buildLedgerBalanceExportXml({ companyName, ledgerName, dateFrom, dateTo }) {
  const companyVariable = companyName
    ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`
    : "";
  const fromDate = String(dateFrom || dateTo || "").replaceAll("-", "");
  const toDate = String(dateTo || dateFrom || "").replaceAll("-", "");

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<VERSION>1</VERSION>",
    "<TALLYREQUEST>EXPORT</TALLYREQUEST>",
    "<TYPE>OBJECT</TYPE>",
    "<SUBTYPE>Ledger</SUBTYPE>",
    `<ID TYPE="Name">${escapeXml(ledgerName)}</ID>`,
    "</HEADER>",
    "<BODY>",
    "<DESC>",
    "<STATICVARIABLES>",
    companyVariable,
    fromDate ? `<SVFROMDATE TYPE="Date">${escapeXml(fromDate)}</SVFROMDATE>` : "",
    toDate ? `<SVTODATE TYPE="Date">${escapeXml(toDate)}</SVTODATE>` : "",
    toDate ? `<SVCURRENTDATE TYPE="Date">${escapeXml(toDate)}</SVCURRENTDATE>` : "",
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    "</STATICVARIABLES>",
    "<FETCHLIST>",
    "<FETCH>Name</FETCH>",
    "<FETCH>ClosingBalance</FETCH>",
    "</FETCHLIST>",
    "</DESC>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

function buildAlterLedgerXml(payload, fallbackCompanyName) {
  const oldName = payload?.oldName;
  const newName = payload?.newName || oldName;
  const parentName = payload?.parentName;
  const phoneNumber = payload?.phoneNumber || payload?.ledgerMobile || payload?.ledgerPhone;
  const companyName = payload?.companyName || fallbackCompanyName;

  if (!oldName || !newName) {
    throw new Error("Ledger edit command is missing oldName or newName.");
  }

  const companyVariable = companyName
    ? `<SVCurrentCompany>${escapeXml(companyName)}</SVCurrentCompany>`
    : "";
  const parentBlock = parentName ? `<PARENT>${escapeXml(parentName)}</PARENT>` : "";
  const phoneBlock = phoneNumber
    ? [
        `<LEDGERMOBILE>${escapeXml(phoneNumber)}</LEDGERMOBILE>`,
        `<LEDGERPHONE>${escapeXml(phoneNumber)}</LEDGERPHONE>`,
        `<PHONENUMBER>${escapeXml(phoneNumber)}</PHONENUMBER>`,
      ].join("")
    : "";

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<TALLYREQUEST>Import Data</TALLYREQUEST>",
    "</HEADER>",
    "<BODY>",
    "<IMPORTDATA>",
    "<REQUESTDESC>",
    "<REPORTNAME>All Masters</REPORTNAME>",
    "<STATICVARIABLES>",
    companyVariable,
    "</STATICVARIABLES>",
    "</REQUESTDESC>",
    "<REQUESTDATA>",
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<LEDGER NAME="${escapeXml(oldName)}" ACTION="Alter">`,
    `<NAME>${escapeXml(newName)}</NAME>`,
    parentBlock,
    phoneBlock,
    "<LANGUAGENAME.LIST>",
    '<NAME.LIST TYPE="String">',
    `<NAME>${escapeXml(newName)}</NAME>`,
    "</NAME.LIST>",
    '<LANGUAGEID TYPE="Number">1033</LANGUAGEID>',
    "</LANGUAGENAME.LIST>",
    "</LEDGER>",
    "</TALLYMESSAGE>",
    "</REQUESTDATA>",
    "</IMPORTDATA>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

function buildCreateLedgerXml(payload, fallbackCompanyName) {
  const name = String(payload?.name || "").trim();
  const parentName = String(payload?.parentName || "").trim();
  const companyName = payload?.companyName || fallbackCompanyName;

  if (!name || !parentName) {
    throw new Error("Ledger create command is missing name or parentName.");
  }

  const companyVariable = companyName
    ? `<SVCurrentCompany>${escapeXml(companyName)}</SVCurrentCompany>`
    : "";

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<TALLYREQUEST>Import Data</TALLYREQUEST>",
    "</HEADER>",
    "<BODY>",
    "<IMPORTDATA>",
    "<REQUESTDESC>",
    "<REPORTNAME>All Masters</REPORTNAME>",
    "<STATICVARIABLES>",
    companyVariable,
    "</STATICVARIABLES>",
    "</REQUESTDESC>",
    "<REQUESTDATA>",
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<LEDGER NAME="${escapeXml(name)}" ACTION="Create">`,
    `<NAME>${escapeXml(name)}</NAME>`,
    `<PARENT>${escapeXml(parentName)}</PARENT>`,
    "<ISBILLWISEON>No</ISBILLWISEON>",
    "<AFFECTSSTOCK>No</AFFECTSSTOCK>",
    "<LANGUAGENAME.LIST>",
    '<NAME.LIST TYPE="String">',
    `<NAME>${escapeXml(name)}</NAME>`,
    "</NAME.LIST>",
    '<LANGUAGEID TYPE="Number">1033</LANGUAGEID>',
    "</LANGUAGENAME.LIST>",
    "</LEDGER>",
    "</TALLYMESSAGE>",
    "</REQUESTDATA>",
    "</IMPORTDATA>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

function buildDebitNoteXml(payload, fallbackCompanyName) {
  const companyName = payload?.companyName || fallbackCompanyName;
  const voucherDate = toIsoLikeDate(payload?.voucherDate);
  const partyLedgerName = String(payload?.partyLedgerName || "").trim();
  // A missed cash discount increases the value of the original sale.  The
  // debit note must therefore credit the Sales ledger used by that invoice,
  // not a generic "Cash Discount Reversal" ledger.
  const salesLedgerName = String(payload?.salesLedgerName || "").trim();
  const amount = toMoney(payload?.amount);
  const referenceNumber = String(payload?.referenceNumber || "").trim();
  const linkedInvoiceNumber = String(payload?.linkedInvoiceNumber || "").trim();
  const debitNoteReferenceName = referenceNumber || `DN-CD-${linkedInvoiceNumber || Date.now()}`;
  const narration = String(
    payload?.narration ||
      `Cash discount reversal${linkedInvoiceNumber ? ` against Sales Invoice ${linkedInvoiceNumber}` : ""}.`
  ).trim();

  if (!partyLedgerName) {
    throw new Error("Debit note command requires partyLedgerName.");
  }
  if (!salesLedgerName) {
    throw new Error("Debit note command requires the Sales ledger from the original invoice.");
  }

  const debitNoteEntries = [
    buildLedgerEntryXml({
      ledgerName: partyLedgerName,
      amount,
      isDebit: true,
      isPartyLedger: true,
      billAllocations: buildBillAllocationsXml({
        allocations: [
          {
            referenceType: "New Ref",
            referenceName: debitNoteReferenceName,
            amount,
          },
        ],
        isDebit: true,
      }),
    }),
    buildLedgerEntryXml({
      ledgerName: salesLedgerName,
      amount,
      isDebit: false,
    }),
  ];

  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    messages: [
      buildVoucherMessageXml({
        voucherDate,
        voucherType: "Debit Note",
        referenceNumber,
        narration,
        entries: debitNoteEntries,
        partyLedgerName,
      }),
    ],
  });
}

function toIsoLikeDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{8}$/.test(raw)) {
    return raw;
  }
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]}${match[2]}${match[3]}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Bank voucher command is missing a valid voucher date.");
  }
  return parsed.toISOString().slice(0, 10).replaceAll("-", "");
}

function toDisplayDate(value) {
  const date = toIsoLikeDate(value);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function isLikelyEducationalModeDateRestriction(voucherDate, error) {
  if (!/voucher date is missing/i.test(String(error || ""))) return false;
  const date = toIsoLikeDate(voucherDate);
  const day = date.slice(6, 8);
  return day !== "01" && day !== "02" && day !== "31";
}

function explainBankVoucherTallyError(outcome, payload) {
  if (!outcome?.success && isLikelyEducationalModeDateRestriction(payload?.voucherDate, outcome?.error)) {
    const displayDate = toDisplayDate(payload.voucherDate);
    return {
      ...outcome,
      error:
        `${outcome.error} This matches Tally Educational Mode date restrictions: imports are accepted only on allowed dates such as the 1st, 2nd, and 31st. ` +
        `The voucher date ${displayDate} is blocked by Tally, not missing from the XML. Activate licensed Tally or test with an allowed date.`,
      result: {
        ...(outcome.result || {}),
        diagnosedReason: "tally_educational_mode_date_restriction",
        voucherDate: displayDate,
      },
    };
  }

  return outcome;
}

function toMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Bank voucher command is missing a positive amount.");
  }
  return parsed.toFixed(2);
}

function buildBankAllocationXml({ voucherDate, referenceNumber, amount, isDebit }) {
  const signedAmount = isDebit ? `-${amount}` : amount;
  const escapedReferenceNumber = escapeXml(referenceNumber);

  return [
    "<BANKALLOCATIONS.LIST>",
    `<DATE>${voucherDate}</DATE>`,
    `<INSTRUMENTDATE>${voucherDate}</INSTRUMENTDATE>`,
    escapedReferenceNumber ? `<NAME>${escapedReferenceNumber}</NAME>` : "",
    escapedReferenceNumber ? `<INSTRUMENTNUMBER>${escapedReferenceNumber}</INSTRUMENTNUMBER>` : "",
    "<TRANSACTIONTYPE>Others</TRANSACTIONTYPE>",
    `<AMOUNT>${signedAmount}</AMOUNT>`,
    "</BANKALLOCATIONS.LIST>",
  ].join("");
}

function normalizeBillAllocationType(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "advance") return "Advance";
  if (normalized === "new ref" || normalized === "newref") return "New Ref";
  return "Agst Ref";
}

function buildBillAllocationsXml({ allocations, isDebit }) {
  if (!Array.isArray(allocations) || allocations.length === 0) return "";
  return allocations
    .map((allocation) => {
      const referenceName = String(allocation?.referenceName || "").trim();
      const amount = Number(allocation?.amount);
      if (!referenceName || !Number.isFinite(amount) || amount <= 0) return "";
      const signedAmount = isDebit ? `-${amount.toFixed(2)}` : amount.toFixed(2);
      const billDate = allocation?.billDate
        ? toIsoLikeDate(allocation.billDate)
        : "";
      return [
        "<BILLALLOCATIONS.LIST>",
        `<NAME>${escapeXml(referenceName)}</NAME>`,
        `<BILLTYPE>${normalizeBillAllocationType(allocation?.referenceType)}</BILLTYPE>`,
        billDate ? `<BILLDATE>${billDate}</BILLDATE>` : "",
        `<AMOUNT>${signedAmount}</AMOUNT>`,
        "</BILLALLOCATIONS.LIST>",
      ].join("");
    })
    .join("");
}

function buildLedgerEntryXml({
  ledgerName,
  amount,
  isDebit,
  isPartyLedger = false,
  bankAllocation = null,
  billAllocations = null,
  listTag = "ALLLEDGERENTRIES.LIST",
}) {
  const signedAmount = isDebit ? `-${amount}` : amount;
  return [
    `<${listTag}>`,
    `<LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>`,
    `<ISPARTYLEDGER>${isPartyLedger ? "Yes" : "No"}</ISPARTYLEDGER>`,
    "<REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>",
    `<ISDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `<AMOUNT>${signedAmount}</AMOUNT>`,
    billAllocations || "",
    bankAllocation || "",
    `</${listTag}>`,
  ].join("");
}

function buildVoucherMessageXml({
  voucherDate,
  voucherType,
  referenceNumber,
  narration,
  entries,
  partyLedgerName = null,
}) {
  const escapedReferenceNumber = escapeXml(referenceNumber);
  const voucherReferenceBlock = referenceNumber
    ? [
        `<VOUCHERNUMBER>${escapedReferenceNumber}</VOUCHERNUMBER>`,
        `<REFERENCE>${escapedReferenceNumber}</REFERENCE>`,
      ].join("")
    : "";
  const partyLedgerBlock = partyLedgerName
    ? `<PARTYLEDGERNAME>${escapeXml(partyLedgerName)}</PARTYLEDGERNAME>`
    : "";

  return [
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<VOUCHER VCHTYPE="${escapeXml(voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    `<DATE>${voucherDate}</DATE>`,
    `<EFFECTIVEDATE>${voucherDate}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${escapeXml(voucherType)}</VOUCHERTYPENAME>`,
    voucherReferenceBlock,
    `<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`,
    "<ISINVOICE>No</ISINVOICE>",
    "<ISOPTIONAL>No</ISOPTIONAL>",
    "<DIFFACTUALQTY>No</DIFFACTUALQTY>",
    "<FORJOBCOSTING>No</FORJOBCOSTING>",
    partyLedgerBlock,
    `<NARRATION>${escapeXml(narration)}</NARRATION>`,
    ...entries,
    "</VOUCHER>",
    "</TALLYMESSAGE>",
  ].join("");
}

function buildCustomerAdvanceAdjustmentXml(payload, fallbackCompanyName) {
  const companyName = payload?.companyName || fallbackCompanyName;
  const voucherDate = toIsoLikeDate(payload?.voucherDate);
  const ledgerName = String(payload?.ledgerName || "").trim();
  const referenceNumber = String(payload?.referenceNumber || "").trim();
  const narration = String(payload?.narration || `Adjust customer advance ${referenceNumber}`).trim();
  const adjustments = Array.isArray(payload?.adjustments) ? payload.adjustments : [];

  if (!ledgerName) {
    throw new Error("Customer advance adjustment requires ledgerName.");
  }

  const normalizedAdjustments = adjustments.flatMap((adjustment) => {
    const advanceReferenceName = String(adjustment?.advanceReferenceName || "").trim();
    const billReferenceName = String(adjustment?.billReferenceName || "").trim();
    const amount = Number(adjustment?.amount);
    if (!advanceReferenceName || !billReferenceName || !Number.isFinite(amount) || amount <= 0) return [];
    return [{ advanceReferenceName, billReferenceName, amount: amount.toFixed(2) }];
  });

  if (normalizedAdjustments.length === 0) {
    throw new Error("Customer advance adjustment requires at least one valid adjustment line.");
  }

  const totalAmount = normalizedAdjustments
    .reduce((sum, adjustment) => sum + Number(adjustment.amount), 0)
    .toFixed(2);
  const advanceBillAllocations = normalizedAdjustments
    .map((adjustment) =>
      buildBillAllocationsXml({
        allocations: [
          {
            referenceType: "Advance",
            referenceName: adjustment.advanceReferenceName,
            amount: adjustment.amount,
          },
        ],
        isDebit: true,
      })
    )
    .join("");
  const billAllocations = normalizedAdjustments
    .map((adjustment) =>
      buildBillAllocationsXml({
        allocations: [
          {
            referenceType: "Agst Ref",
            referenceName: adjustment.billReferenceName,
            amount: adjustment.amount,
          },
        ],
        isDebit: false,
      })
    )
    .join("");

  const message = buildVoucherMessageXml({
    voucherDate,
    voucherType: "Journal",
    referenceNumber,
    narration,
    partyLedgerName: ledgerName,
    entries: [
      buildLedgerEntryXml({
        ledgerName,
        amount: totalAmount,
        isDebit: true,
        isPartyLedger: true,
        billAllocations: advanceBillAllocations,
      }),
      buildLedgerEntryXml({
        ledgerName,
        amount: totalAmount,
        isDebit: false,
        isPartyLedger: true,
        billAllocations,
      }),
    ],
  });

  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    messages: [message],
  });
}

function wrapVoucherMessagesXml({
  companyName,
  voucherDate,
  messages,
  legacyHeader = false,
  legacyEnvelope = false,
}) {
  const staticVariables = [
    companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : "",
    `<SVFROMDATE>${voucherDate}</SVFROMDATE>`,
    `<SVTODATE>${voucherDate}</SVTODATE>`,
    `<SVCURRENTDATE>${voucherDate}</SVCURRENTDATE>`,
  ].filter(Boolean);
  if (legacyEnvelope) {
    return [
      "<ENVELOPE>",
      "<HEADER>",
      "<VERSION>1</VERSION>",
      "<TALLYREQUEST>Import</TALLYREQUEST>",
      "<TYPE>Data</TYPE>",
      "<ID>Vouchers</ID>",
      "</HEADER>",
      "<BODY>",
      "<DESC>",
      "<STATICVARIABLES>",
      ...staticVariables,
      "</STATICVARIABLES>",
      "</DESC>",
      "<DATA>",
      ...messages,
      "</DATA>",
      "</BODY>",
      "</ENVELOPE>",
    ].join("");
  }
  const header = legacyHeader
    ? [
        "<HEADER>",
        "<VERSION>1</VERSION>",
        "<TALLYREQUEST>Import Data</TALLYREQUEST>",
        "<TYPE>Data</TYPE>",
        "<ID>Vouchers</ID>",
        "</HEADER>",
      ]
    : [
        "<HEADER>",
        "<TALLYREQUEST>Import Data</TALLYREQUEST>",
        "</HEADER>",
      ];

  return [
    "<ENVELOPE>",
    ...header,
    "<BODY>",
    "<IMPORTDATA>",
    "<REQUESTDESC>",
    "<REPORTNAME>Vouchers</REPORTNAME>",
    "<STATICVARIABLES>",
    ...staticVariables,
    "</STATICVARIABLES>",
    "</REQUESTDESC>",
    "<REQUESTDATA>",
    ...messages,
    "</REQUESTDATA>",
    "</IMPORTDATA>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

export function buildBankVoucherXml(payload, fallbackCompanyName, options = {}) {
  const companyName = payload?.companyName || fallbackCompanyName;
  const voucherType = payload?.voucherType || "Payment";
  const voucherDate = toIsoLikeDate(payload?.voucherDate);
  const bankLedgerName = String(payload?.bankLedgerName || "").trim();
  const counterpartyLedgerName = String(payload?.counterpartyLedgerName || "").trim();
  const counterpartyIsPartyLedger = payload?.counterpartyIsPartyLedger === true;
  const bankLedgerEntryIsDebit = payload?.bankLedgerEntryIsDebit === true;
  const amount = toMoney(payload?.amount);
  const narration = String(payload?.narration || payload?.description || "").trim();
  const referenceNumber = String(payload?.referenceNumber || payload?.transactionId || "").trim();
  const billAllocations = Array.isArray(payload?.billAllocations) ? payload.billAllocations : [];

  if (!bankLedgerName || !counterpartyLedgerName) {
    throw new Error("Bank voucher command requires bank and counterparty ledgers.");
  }

  const partyLedgerName = counterpartyIsPartyLedger ? counterpartyLedgerName : bankLedgerName;
  const bankAllocation =
    voucherType !== "Journal" && options.includeBankAllocation === true
      ? buildBankAllocationXml({
          voucherDate,
          referenceNumber,
          amount,
          isDebit: bankLedgerEntryIsDebit,
        })
      : null;

  const entries =
    voucherType === "Journal"
      ? bankLedgerEntryIsDebit
        ? [
            buildLedgerEntryXml({ ledgerName: bankLedgerName, amount, isDebit: true }),
            buildLedgerEntryXml({ ledgerName: counterpartyLedgerName, amount, isDebit: false }),
          ]
        : [
            buildLedgerEntryXml({ ledgerName: counterpartyLedgerName, amount, isDebit: true }),
            buildLedgerEntryXml({ ledgerName: bankLedgerName, amount, isDebit: false }),
          ]
      : voucherType === "Receipt"
      ? [
          buildLedgerEntryXml({
            ledgerName: counterpartyLedgerName,
            amount,
            isDebit: false,
            isPartyLedger: counterpartyIsPartyLedger,
            billAllocations: buildBillAllocationsXml({ allocations: billAllocations, isDebit: false }),
          }),
          buildLedgerEntryXml({
            ledgerName: bankLedgerName,
            amount,
            isDebit: true,
            bankAllocation,
          }),
        ]
      : voucherType === "Contra"
        ? bankLedgerEntryIsDebit
          ? [
              buildLedgerEntryXml({
                ledgerName: bankLedgerName,
                amount,
                isDebit: true,
                bankAllocation,
              }),
              buildLedgerEntryXml({ ledgerName: counterpartyLedgerName, amount, isDebit: false }),
            ]
          : [
              buildLedgerEntryXml({ ledgerName: counterpartyLedgerName, amount, isDebit: true }),
              buildLedgerEntryXml({
                ledgerName: bankLedgerName,
                amount,
                isDebit: false,
                bankAllocation,
              }),
            ]
        : [
            buildLedgerEntryXml({
              ledgerName: counterpartyLedgerName,
              amount,
              isDebit: true,
              isPartyLedger: counterpartyIsPartyLedger,
              billAllocations: buildBillAllocationsXml({ allocations: billAllocations, isDebit: true }),
            }),
            buildLedgerEntryXml({
              ledgerName: bankLedgerName,
              amount,
              isDebit: false,
              bankAllocation,
            }),
          ];

  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    legacyHeader: options.legacyHeader === true,
    legacyEnvelope: options.legacyEnvelope === true,
    messages: [
      buildVoucherMessageXml({
        voucherDate,
        voucherType,
        referenceNumber,
        narration,
        entries,
        partyLedgerName: voucherType === "Journal" ? null : partyLedgerName,
      }),
    ],
  });
}

export function buildBankVoucherBatchXml(payloads, fallbackCompanyName) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new Error("Bank voucher batch requires at least one voucher.");
  }

  const companyName = payloads[0]?.companyName || fallbackCompanyName;
  const voucherDate = toIsoLikeDate(payloads[0]?.voucherDate);
  const messages = payloads.map((payload) => {
    const voucherXml = buildBankVoucherXml(payload, companyName);
    const message = voucherXml.match(/<TALLYMESSAGE\b[\s\S]*?<\/TALLYMESSAGE>/i)?.[0];
    if (!message) {
      throw new Error("Could not build a Tally message for a bank voucher batch.");
    }
    return message;
  });

  // This is Tally's documented Data import protocol. It is intentionally
  // different from the Import Data / IMPORTDATA protocol used by other
  // request shapes; mixing the two makes Tally return `DESC not found`.
  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    messages,
    legacyEnvelope: true,
  });
}

function toSignedMoney(value, label, options = {}) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(parsed) || (!options.allowZero && parsed === 0)) {
    throw new Error(`Purchase voucher command requires ${label}.`);
  }
  if (!options.allowNegative && parsed < 0) {
    throw new Error(`Purchase voucher ${label} cannot be negative.`);
  }
  return parsed;
}

function buildPurchaseInventoryEntryXml(item) {
  const stockItemName = String(item?.stockItemName || "").trim();
  const purchaseLedgerName = String(item?.purchaseLedgerName || "").trim();
  const description = String(item?.description || "").trim();
  const hsn = String(item?.hsn || "").replace(/\D/g, "").slice(0, 8);
  const unit = String(item?.unit || "").trim();
  const quantity = toSignedMoney(item?.quantity, "a positive item quantity");
  const rate = toSignedMoney(item?.rate, "a positive item rate");
  const amount = toSignedMoney(item?.taxableAmount, "a positive item taxable amount");

  if (!stockItemName || !purchaseLedgerName || !unit || !hsn) {
    throw new Error("Purchase voucher items require stock item, purchase ledger, unit, and full HSN values.");
  }

  const formattedQuantity = `${quantity} ${unit}`;
  const formattedRate = `${rate.toFixed(2)}/${unit}`;
  const formattedAmount = amount.toFixed(2);
  const godownName = String(item?.godownName || "Main Location").trim();
  const batchName = String(item?.batchName || "Primary Batch").trim();

  return [
    "<ALLINVENTORYENTRIES.LIST>",
    `<STOCKITEMNAME>${escapeXml(stockItemName)}</STOCKITEMNAME>`,
    description ? `<DESCRIPTION>${escapeXml(description)}</DESCRIPTION>` : "",
    "<GSTHSNINFERAPPLICABILITY>Specify Details Here</GSTHSNINFERAPPLICABILITY>",
    `<GSTHSNNAME>${escapeXml(hsn)}</GSTHSNNAME>`,
    description ? `<GSTHSNDESCRIPTION>${escapeXml(description)}</GSTHSNDESCRIPTION>` : "",
    "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>",
    `<RATE>${formattedRate}</RATE>`,
    `<AMOUNT>-${formattedAmount}</AMOUNT>`,
    `<ACTUALQTY>${escapeXml(formattedQuantity)}</ACTUALQTY>`,
    `<BILLEDQTY>${escapeXml(formattedQuantity)}</BILLEDQTY>`,
    "<BATCHALLOCATIONS.LIST>",
    `<GODOWNNAME>${escapeXml(godownName)}</GODOWNNAME>`,
    `<BATCHNAME>${escapeXml(batchName)}</BATCHNAME>`,
    `<DESTINATIONGODOWNNAME>${escapeXml(godownName)}</DESTINATIONGODOWNNAME>`,
    `<AMOUNT>-${formattedAmount}</AMOUNT>`,
    `<ACTUALQTY>${escapeXml(formattedQuantity)}</ACTUALQTY>`,
    `<BILLEDQTY>${escapeXml(formattedQuantity)}</BILLEDQTY>`,
    "</BATCHALLOCATIONS.LIST>",
    "<ACCOUNTINGALLOCATIONS.LIST>",
    `<LEDGERNAME>${escapeXml(purchaseLedgerName)}</LEDGERNAME>`,
    "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>",
    `<AMOUNT>-${formattedAmount}</AMOUNT>`,
    "</ACCOUNTINGALLOCATIONS.LIST>",
    "</ALLINVENTORYENTRIES.LIST>",
  ].join("");
}

function buildPurchaseDocumentUdfXml(payload) {
  const values = [
    [PURCHASE_DOCUMENT_UDFS.path, payload?.sourceDocumentPath],
    [PURCHASE_DOCUMENT_UDFS.name, payload?.sourceDocumentName],
    [PURCHASE_DOCUMENT_UDFS.sha256, payload?.sourceDocumentSha256],
    [PURCHASE_DOCUMENT_UDFS.id, payload?.sourceDocumentId],
  ];

  if (values.every(([, value]) => !String(value || "").trim())) {
    return "";
  }
  if (values.some(([, value]) => !String(value || "").trim())) {
    throw new Error("Purchase source document metadata is incomplete.");
  }

  return values.map(([definition, value]) => {
    const tag = definition.name.toUpperCase();
    return [
      `<UDF:${tag}.LIST DESC="'${definition.name}'" ISLIST="YES" TYPE="String" INDEX="${definition.index}">`,
      `<UDF:${tag} DESC="'${definition.name}'">${escapeXml(String(value).trim())}</UDF:${tag}>`,
      `</UDF:${tag}.LIST>`,
    ].join("");
  }).join("");
}

function buildPurchaseVoucherXml(payload, fallbackCompanyName) {
  const companyName = String(payload?.companyName || fallbackCompanyName || "").trim();
  const voucherDate = toIsoLikeDate(payload?.voucherDate || payload?.supplierInvoiceDate);
  const supplierInvoiceDate = toIsoLikeDate(payload?.supplierInvoiceDate);
  const supplierInvoiceNumber = String(payload?.supplierInvoiceNumber || "").trim();
  const supplierLedgerName = String(payload?.supplierLedgerName || "").trim();
  const narration = [
    String(payload?.narration || "").trim(),
    payload?.vehicleNumber ? `Vehicle: ${String(payload.vehicleNumber).trim()}` : "",
    payload?.sourceReferenceFallback && payload?.sourceDocumentReference
      ? `Source: ${String(payload.sourceDocumentReference).trim()}`
      : "",
  ].filter(Boolean).join(" | ");
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const charges = Array.isArray(payload?.charges) ? payload.charges : [];
  const withholdings = Array.isArray(payload?.withholdings) ? payload.withholdings : [];
  const ledgers = payload?.ledgers && typeof payload.ledgers === "object" ? payload.ledgers : {};
  const finalPayable = toSignedMoney(payload?.finalPayableAmount, "a positive final payable amount");

  if (!companyName || !supplierInvoiceNumber || !supplierLedgerName || items.length === 0) {
    throw new Error("Purchase voucher command requires company, supplier invoice, supplier ledger, and item lines.");
  }

  const inventoryEntries = items.map(buildPurchaseInventoryEntryXml);
  const ledgerEntries = [];
  const debitCharges = charges.length > 0
    ? charges
    : ["cgst", "sgst", "igst", "tcs"].map((key) => ledgers[key]).filter(Boolean);
  for (const ledger of debitCharges) {
    if (!ledger) continue;
    const name = String(ledger.name || "").trim();
    const amount = toSignedMoney(ledger.amount, "purchase charge amount", { allowZero: true });
    if (!name || amount === 0) continue;
    ledgerEntries.push(buildLedgerEntryXml({
      ledgerName: name,
      amount: Math.abs(amount).toFixed(2),
      isDebit: amount > 0,
      listTag: "LEDGERENTRIES.LIST",
    }));
  }

  const roundOff = ledgers.roundOff;
  if (roundOff) {
    const name = String(roundOff.name || "").trim();
    const amount = toSignedMoney(roundOff.amount, "round-off amount", {
      allowZero: true,
      allowNegative: true,
    });
    if (name && amount !== 0) {
      ledgerEntries.push(buildLedgerEntryXml({
        ledgerName: name,
        amount: Math.abs(amount).toFixed(2),
        isDebit: amount > 0,
        listTag: "LEDGERENTRIES.LIST",
      }));
    }
  }

  const deductionEntries = withholdings.length > 0
    ? withholdings
    : ledgers.tds ? [ledgers.tds] : [];
  for (const deduction of deductionEntries) {
    const name = String(deduction?.name || "").trim();
    const amount = toSignedMoney(deduction?.amount, "withholding amount", { allowZero: true });
    if (name && amount > 0) {
      ledgerEntries.push(buildLedgerEntryXml({
        ledgerName: name,
        amount: amount.toFixed(2),
        isDebit: false,
        listTag: "LEDGERENTRIES.LIST",
      }));
    }
  }

  ledgerEntries.push(buildLedgerEntryXml({
    ledgerName: supplierLedgerName,
    amount: finalPayable.toFixed(2),
    isDebit: false,
    isPartyLedger: true,
    listTag: "LEDGERENTRIES.LIST",
    billAllocations: buildBillAllocationsXml({
      allocations: [{
        referenceType: "New Ref",
        referenceName: supplierInvoiceNumber,
        // Tally tracks a New Ref from the voucher date. The supplier's own
        // invoice date remains independently preserved in REFERENCE DATE.
        billDate: voucherDate,
        amount: finalPayable,
      }],
      isDebit: false,
    }),
  }));

  const message = [
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    '<VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">',
    `<DATE>${voucherDate}</DATE>`,
    `<EFFECTIVEDATE>${voucherDate}</EFFECTIVEDATE>`,
    "<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>",
    `<REFERENCE>${escapeXml(supplierInvoiceNumber)}</REFERENCE>`,
    `<REFERENCEDATE>${supplierInvoiceDate}</REFERENCEDATE>`,
    `<PARTYLEDGERNAME>${escapeXml(supplierLedgerName)}</PARTYLEDGERNAME>`,
    `<BASICBASEPARTYNAME>${escapeXml(supplierLedgerName)}</BASICBASEPARTYNAME>`,
    "<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>",
    "<VCHENTRYMODE>Item Invoice</VCHENTRYMODE>",
    "<ISINVOICE>Yes</ISINVOICE>",
    "<ISOPTIONAL>No</ISOPTIONAL>",
    "<DIFFACTUALQTY>No</DIFFACTUALQTY>",
    `<NARRATION>${escapeXml(narration)}</NARRATION>`,
    ...inventoryEntries,
    ...ledgerEntries,
    buildPurchaseDocumentUdfXml(payload),
    "</VOUCHER>",
    "</TALLYMESSAGE>",
  ].join("");

  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    messages: [message],
    legacyEnvelope: true,
  });
}

function removeTags(xml, tagNames) {
  return tagNames.reduce(
    (nextXml, tagName) =>
      nextXml.replace(new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi"), ""),
    xml
  );
}

function setAllPartyLedgerFlagsNo(xml) {
  return xml.replace(/<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>/gi, "<ISPARTYLEDGER>No</ISPARTYLEDGER>");
}

function withoutVoucherPresentationHints(xml) {
  return removeTags(xml.replace(/\sOBJVIEW="[^"]*"/gi, ""), ["PERSISTEDVIEW"]);
}

function withoutAccountingBooleans(xml) {
  return removeTags(xml, ["ISINVOICE", "ISOPTIONAL", "DIFFACTUALQTY", "FORJOBCOSTING"]);
}

function withVoucherDateAttribute(xml, voucherDate) {
  return xml.replace(/<VOUCHER\b(?![^>]*\bDATE=)/i, `<VOUCHER DATE="${voucherDate}"`);
}

function withVoucherNameAttribute(xml, referenceNumber) {
  const escapedReferenceNumber = escapeXml(referenceNumber);
  if (!escapedReferenceNumber) return xml;
  return xml.replace(/<VOUCHER\b(?![^>]*\bNAME=)/i, `<VOUCHER NAME="${escapedReferenceNumber}"`);
}

function buildBankVoucherDiagnosticVariants(payload, fallbackCompanyName) {
  const voucherDate = toIsoLikeDate(payload?.voucherDate);
  const referenceNumber = String(payload?.referenceNumber || payload?.transactionId || "").trim();
  const current = buildBankVoucherXml(payload, fallbackCompanyName);
  const noPartyLedgerMarkers = setAllPartyLedgerFlagsNo(removeTags(current, ["PARTYLEDGERNAME"]));
  const noPresentationHints = withoutVoucherPresentationHints(current);
  const minimalAccounting = withoutAccountingBooleans(
    withoutVoucherPresentationHints(noPartyLedgerMarkers)
  );

  return [
    {
      name: "current",
      description: "Current bridge XML.",
      xml: current,
    },
    {
      name: "with-voucher-date-attribute",
      description: "Current XML plus DATE on the VOUCHER attribute, matching the previous bridge attempt.",
      xml: withVoucherDateAttribute(current, voucherDate),
    },
    {
      name: "no-party-ledger-markers",
      description: "Removes PARTYLEDGERNAME and forces ISPARTYLEDGER=No on ledger entries.",
      xml: noPartyLedgerMarkers,
    },
    {
      name: "no-presentation-hints",
      description: "Removes OBJVIEW and PERSISTEDVIEW while keeping accounting/date fields.",
      xml: noPresentationHints,
    },
    {
      name: "minimal-accounting",
      description: "Keeps voucher date/type/reference/narration and ledger entries; removes view, party, and accounting boolean hints.",
      xml: minimalAccounting,
    },
    {
      name: "minimal-with-date-attribute",
      description: "Minimal accounting XML plus DATE on the VOUCHER attribute.",
      xml: withVoucherDateAttribute(minimalAccounting, voucherDate),
    },
    {
      name: "minimal-with-name-and-date-attributes",
      description: "Minimal accounting XML plus NAME and DATE on the VOUCHER attribute.",
      xml: withVoucherNameAttribute(withVoucherDateAttribute(minimalAccounting, voucherDate), referenceNumber),
    },
  ];
}

function getBankVoucherDiagnosticVariantXml(payload, fallbackCompanyName, variantName) {
  const variants = buildBankVoucherDiagnosticVariants(payload, fallbackCompanyName);
  const variant = variants.find((entry) => entry.name === variantName);
  if (!variant) {
    throw new Error(`Unknown variant "${variantName}". Available: ${variants.map((entry) => entry.name).join(", ")}`);
  }
  return variant.xml;
}

function parseExportResult(text, httpStatus) {
  const lineError = getTagText(text, "LINEERROR");
  const statusText = getTagText(text, "STATUS");

  return {
    success: httpStatus >= 200 && httpStatus < 300 && !lineError && statusText === "1",
    error: lineError,
    status: statusText,
    response: text,
  };
}

function extractCompanyName(xml) {
  const currentCompany = xml.match(/<CURRENTCOMPANY[^>]*>([^<]+)<\/CURRENTCOMPANY>/i)?.[1];
  if (currentCompany) {
    return cleanXmlText(currentCompany);
  }

  for (const companyBlock of extractBlocks(xml, "COMPANY")) {
    const name = getTagText(companyBlock, "NAME") || getAttribute(companyBlock, "NAME");
    if (name) {
      return name;
    }
  }

  return null;
}

async function fetchActiveCompanyName(tallyUrl) {
  try {
    // `$$CurrentCompany` is the actual company active in the Tally UI. A
    // Company collection can instead return the first loaded company, which
    // makes multi-company verification incorrect.
    const xml = await exportTallyXml(
      tallyUrl,
      [
        "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>",
        "<TYPE>Function</TYPE><ID>$$CurrentCompany</ID></HEADER><BODY><DESC>",
        "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>",
        "</DESC></BODY></ENVELOPE>",
      ].join(""),
      "Current company"
    );
    return getTagText(xml, "RESULT") || extractCompanyName(xml);
  } catch {
    return null;
  }
}

function normalizeTallyDate(value) {
  const normalized = cleanXmlText(value);
  if (!normalized) return null;

  const compactMatch = normalized.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }

  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return normalized;

  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function financialYearFromStartDate(value) {
  const startDate = normalizeTallyDate(value);
  if (!startDate) return null;
  const year = Number(startDate.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

async function fetchAvailableCompanies(tallyUrl, activeCompanyName = null) {
  const companies = [];

  try {
    const xml = await exportTallyCollection(tallyUrl, {
      collectionName: "Gajkesari Available Companies",
      tallyType: "Company",
      fetchFields: "Name,Guid,StartingFrom,BooksFrom,FinancialYearFrom,CurrentPeriod,AlterID,MasterID",
      companyName: null,
    });
    const seen = new Set();

    for (const companyBlock of extractBlocks(xml, "COMPANY")) {
      const name = getTagText(companyBlock, "NAME") || getAttribute(companyBlock, "NAME");
      const normalized = typeof name === "string" ? name.trim() : "";
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const financialYearStart =
        normalizeTallyDate(
          getTagText(companyBlock, "FINANCIALYEARFROM") ||
            getTagText(companyBlock, "STARTINGFROM")
        );
      companies.push({
        companyName: normalized,
        guid: getTagText(companyBlock, "GUID") || getAttribute(companyBlock, "GUID"),
        financialYear: financialYearFromStartDate(financialYearStart),
        financialYearStart,
        booksFrom: normalizeTallyDate(getTagText(companyBlock, "BOOKSFROM")),
        currentPeriod: getTagText(companyBlock, "CURRENTPERIOD"),
        isActive:
          Boolean(activeCompanyName) &&
          normalized.toLowerCase() === String(activeCompanyName).trim().toLowerCase(),
      });
    }
  } catch {
    // Tally's HTTP API returns an empty Company collection when no company is loaded.
  }

  return companies;
}

function mergeCompanyNames(values) {
  const seen = new Set();
  const names = [];

  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(normalized);
  }

  return names;
}

function tallyDataRoots() {
  return mergeCompanyNames([
    process.env.GAJKESARI_TALLY_DATA_ROOT,
    process.env.TALLY_DATA_ROOT,
    process.env.TALLY_DATA_PATH,
    DEFAULT_TALLY_DATA_ROOT,
  ]);
}

function readLocalTallyCompanyNames() {
  const names = [];

  for (const dataRoot of tallyDataRoots()) {
    try {
      if (!fs.existsSync(dataRoot)) continue;
      const entries = fs.readdirSync(dataRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const companyDir = path.join(dataRoot, entry.name);
        const companyName =
          readTallyCompanyNameFromFile(path.join(companyDir, "Company.1800")) ||
          readTallyCompanyNameFromFile(path.join(companyDir, "CmpSave.1800"));
        if (companyName) {
          names.push(companyName);
        }
      }
    } catch {
      // Local folder fallback is best-effort; heartbeat should still continue.
    }
  }

  return mergeCompanyNames(names);
}

function readTallyCompanyNameFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    const candidates = [
      ...extractReadableTallyStrings(buffer.toString("utf16le")),
      ...extractReadableTallyStrings(buffer.toString("latin1")),
    ];
    return candidates.find(isLikelyTallyCompanyName) ?? null;
  } catch {
    return null;
  }
}

function extractReadableTallyStrings(text) {
  return [...String(text).matchAll(/[A-Za-z0-9][A-Za-z0-9 .&()/_-]{1,78}/g)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isLikelyTallyCompanyName(value) {
  const normalized = String(value ?? "").trim();
  const lower = normalized.toLowerCase();

  if (!normalized || normalized.length < 2 || normalized.length > 80) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (lower.includes("company features")) return false;
  if (lower === "company" || lower === "tally" || lower === "tally prime") return false;
  if (lower.startsWith("alter ") || lower.startsWith("create ")) return false;
  return /[a-z]/i.test(normalized);
}

function parseTallyImportResult(text, httpStatus) {
  const lineError = getTagText(text, "LINEERROR");
  const statusText = getTagText(text, "STATUS");
  const dataText = getTagText(text, "DATA");
  const errorsText = text.match(/<ERRORS[^>]*>([^<]+)<\/ERRORS>/i)?.[1]?.trim() ?? null;
  const alteredText = text.match(/<ALTERED[^>]*>([^<]+)<\/ALTERED>/i)?.[1]?.trim() ?? null;
  const createdText = text.match(/<CREATED[^>]*>([^<]+)<\/CREATED>/i)?.[1]?.trim() ?? null;
  const ignoredText = text.match(/<IGNORED[^>]*>([^<]+)<\/IGNORED>/i)?.[1]?.trim() ?? null;
  const cancelledText = text.match(/<CANCELLED[^>]*>([^<]+)<\/CANCELLED>/i)?.[1]?.trim() ?? null;
  const exceptionsText = text.match(/<EXCEPTIONS[^>]*>([^<]+)<\/EXCEPTIONS>/i)?.[1]?.trim() ?? null;
  const lastVchId = getTagText(text, "LASTVCHID") || getTagText(text, "LASTVCHID.LIST");
  const errors = errorsText ? Number(errorsText) : null;
  const exceptions = exceptionsText ? Number(exceptionsText) : null;
  const responseError =
    lineError ||
    (statusText === "0" && dataText ? dataText.replace(/\s+/g, " ").trim() : null) ||
    (Number(exceptions ?? 0) > 0
      ? `Tally reported ${exceptions} import exception${exceptions === 1 ? "" : "s"}.`
      : null);

  return {
    success:
      httpStatus >= 200 &&
      httpStatus < 300 &&
      !responseError &&
      (errors === null || errors === 0) &&
      (exceptions === null || exceptions === 0),
    error: responseError,
    result: {
      httpStatus,
      altered: alteredText ? Number(alteredText) : null,
      created: createdText ? Number(createdText) : null,
      lastVchId,
      errors,
      exceptions,
      ignored: ignoredText ? Number(ignoredText) : null,
      cancelled: cancelledText ? Number(cancelledText) : null,
      response: text.slice(0, 4000),
    },
  };
}

function requireCreatedVoucher(outcome) {
  const created = Number(outcome.result?.created ?? 0) || 0;
  const altered = Number(outcome.result?.altered ?? 0) || 0;

  if (!outcome.success || created > 0 || altered > 0) {
    return outcome;
  }

  return {
    ...outcome,
    success: false,
    error: `Tally accepted the voucher import request but did not report a created voucher. CREATED=${created}, ALTERED=${altered}.`,
  };
}

function purchaseVoucherReadbackComparison(voucher, payload) {
  const differences = [];
  const expectedItems = Array.isArray(payload?.items) ? payload.items : [];
  const actualItems = Array.isArray(voucher?.inventoryEntries) ? voucher.inventoryEntries : [];
  const expectedPayable = Number(payload?.finalPayableAmount);
  const partyEntry = (voucher?.ledgerEntries || []).find(
    (entry) => normalizeLooseName(entry.ledgerName) === normalizeLooseName(payload?.supplierLedgerName)
  );
  const expectedAllocations = [
    ...(Array.isArray(payload?.charges) ? payload.charges : []),
    ...(Array.isArray(payload?.withholdings) ? payload.withholdings : []),
  ].filter((entry) => entry?.name && Number(entry?.amount) !== 0);

  if (expectedItems.length !== actualItems.length) {
    differences.push(`Expected ${expectedItems.length} item line(s), Tally returned ${actualItems.length}.`);
  }

  expectedItems.forEach((expected, index) => {
    const actual = actualItems[index];
    if (!actual) return;
    if (normalizeLooseName(actual.stockItemName) !== normalizeLooseName(expected.stockItemName)) {
      differences.push(`Line ${index + 1} stock item differs.`);
    }
    if (String(actual.hsn || "").replace(/\D/g, "") !== String(expected.hsn || "").replace(/\D/g, "")) {
      differences.push(`Line ${index + 1} HSN differs.`);
    }
    const expectedAmount = Number(expected.taxableAmount);
    if (Number.isFinite(expectedAmount) && Math.abs(Number(actual.amount || 0) - expectedAmount) > 0.01) {
      differences.push(`Line ${index + 1} taxable amount differs.`);
    }
    if (normalizeLooseName(actual.purchaseLedgerName) !== normalizeLooseName(expected.purchaseLedgerName)) {
      differences.push(`Line ${index + 1} purchase ledger differs.`);
    }
  });

  if (!partyEntry) {
    differences.push("Supplier ledger allocation was not returned by Tally.");
  } else if (Number.isFinite(expectedPayable) && Math.abs(Math.abs(Number(partyEntry.amount || 0)) - expectedPayable) > 0.01) {
    differences.push("Final supplier payable differs.");
  }

  for (const expected of expectedAllocations) {
    const actual = (voucher?.ledgerEntries || []).find(
      (entry) => normalizeLooseName(entry.ledgerName) === normalizeLooseName(expected.name)
    );
    if (!actual) {
      differences.push(`${expected.name} allocation was not returned by Tally.`);
      continue;
    }
    if (Math.abs(Math.abs(Number(actual.amount || 0)) - Math.abs(Number(expected.amount || 0))) > 0.01) {
      differences.push(`${expected.name} amount differs.`);
    }
  }

  if (
    normalizeTallyDate(voucher?.date) !== normalizeTallyDate(payload?.voucherDate)
  ) {
    differences.push("Tally voucher date differs.");
  }
  if (
    normalizeTallyDate(voucher?.referenceDate) !==
    normalizeTallyDate(payload?.supplierInvoiceDate)
  ) {
    differences.push("Supplier invoice date differs.");
  }
  const supplierBillAllocation = (voucher?.billAllocations || []).find(
    (allocation) =>
      normalizeLooseName(allocation.referenceName) ===
      normalizeLooseName(payload?.supplierInvoiceNumber)
  );
  if (!supplierBillAllocation) {
    differences.push("Supplier invoice bill reference was not returned by Tally.");
  } else {
    if (
      supplierBillAllocation.billDate &&
      normalizeTallyDate(supplierBillAllocation.billDate) !==
      normalizeTallyDate(payload?.voucherDate)
    ) {
      differences.push("Supplier outstanding bill date differs from the Tally voucher date.");
    }
    if (
      Number.isFinite(expectedPayable) &&
      Math.abs(Number(supplierBillAllocation.amount || 0) - expectedPayable) > 0.01
    ) {
      differences.push("Supplier outstanding bill amount differs.");
    }
  }
  if (payload?.sourceDocumentPath) {
    const expectedDocument = {
      path: String(payload.sourceDocumentPath).trim(),
      name: String(payload.sourceDocumentName || "").trim(),
      sha256: String(payload.sourceDocumentSha256 || "").trim().toUpperCase(),
      id: String(payload.sourceDocumentId || "").trim(),
    };
    const actualDocument = {
      path: String(voucher?.sourceDocumentPath || "").trim(),
      name: String(voucher?.sourceDocumentName || "").trim(),
      sha256: String(voucher?.sourceDocumentSha256 || "").trim().toUpperCase(),
      id: String(voucher?.sourceDocumentId || "").trim(),
    };
    if (!actualDocument.path || actualDocument.path.toLowerCase() !== expectedDocument.path.toLowerCase()) {
      differences.push("Original invoice PDF path was not attached to the Tally voucher.");
    }
    if (!actualDocument.name || actualDocument.name !== expectedDocument.name) {
      differences.push("Original invoice PDF name differs.");
    }
    if (!actualDocument.sha256 || actualDocument.sha256 !== expectedDocument.sha256) {
      differences.push("Original invoice PDF checksum differs.");
    }
    if (!actualDocument.id || actualDocument.id !== expectedDocument.id) {
      differences.push("Original invoice document identity differs.");
    }
  }

  return differences;
}

async function verifyPurchaseVoucherInTally(config, payload = {}) {
  const companyName = payload?.companyName || config?.companyName || null;
  const tallyUrl = normalizeTallyUrl(payload?.tallyUrl || config?.tallyUrl);
  const voucherDate = payload?.voucherDate || payload?.supplierInvoiceDate;
  const supplierInvoiceNumber = String(payload?.supplierInvoiceNumber || "").trim();
  const supplierLedgerName = String(payload?.supplierLedgerName || "").trim();

  if (!companyName || !voucherDate || !supplierInvoiceNumber || !supplierLedgerName) {
    throw new Error("Purchase voucher verification requires company, date, invoice number, and supplier ledger.");
  }

  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Gajkesari Purchase Voucher Verification",
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,ReferenceDate,VoucherTypeName,VoucherNumber,Reference,PartyLedgerName,MasterID,AlterID,GUID,Narration,GajkesariSourceDocumentPath,GajkesariSourceDocumentName,GajkesariSourceDocumentSha256,GajkesariSourceDocumentId,AllLedgerEntries.*,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.BillDate,AllLedgerEntries.BillAllocations.Amount,AllInventoryEntries.*",
    companyName,
    dateFrom: voucherDate,
    dateTo: voucherDate,
  });
  const candidates = parseVoucherCollection(xml).filter((voucher) =>
    /purchase/i.test(String(voucher.voucherType || "")) &&
    normalizeLooseName(voucher.reference) === normalizeLooseName(supplierInvoiceNumber) &&
    normalizeLooseName(voucher.partyLedgerName) === normalizeLooseName(supplierLedgerName)
  );

  if (candidates.length === 0) {
    return {
      success: true,
      result: {
        verificationStatus: "missing",
        supplierInvoiceNumber,
        supplierLedgerName,
        candidates: [],
      },
    };
  }

  if (candidates.length > 1) {
    return {
      success: true,
      result: {
        verificationStatus: "ambiguous",
        supplierInvoiceNumber,
        supplierLedgerName,
        candidates: candidates.slice(0, 10),
      },
    };
  }

  const voucher = candidates[0];
  const differences = purchaseVoucherReadbackComparison(voucher, payload);
  return {
    success: true,
    result: {
      verificationStatus: differences.length === 0 ? "verified" : "mismatch",
      differences,
      voucherId: voucher.masterId || voucher.voucherNumber || null,
      masterId: voucher.masterId || null,
      voucherNumber: voucher.voucherNumber || null,
      guid: voucher.guid || null,
      voucherDate: normalizeTallyDate(voucher.date),
      supplierInvoiceNumber,
      supplierLedgerName,
      voucher,
    },
  };
}

async function postPurchaseVoucher(tallyUrl, payload, companyName) {
  const preflight = await verifyPurchaseVoucherInTally({ tallyUrl, companyName }, payload);
  if (preflight.result?.verificationStatus === "verified") {
    return {
      outcome: {
        success: true,
        result: {
          ...preflight.result,
          alreadyInTally: true,
          created: 0,
          altered: 0,
        },
      },
      xml: null,
    };
  }
  if (["ambiguous", "mismatch"].includes(preflight.result?.verificationStatus)) {
    return {
      outcome: {
        success: false,
        error: "An existing purchase voucher with this supplier invoice needs review before posting.",
        result: {
          possibleDuplicateInTally: true,
          verification: preflight.result,
        },
      },
      xml: null,
    };
  }

  const xml = buildPurchaseVoucherXml(payload, companyName);
  const importOutcome = requireCreatedVoucher(await invokeTallyXml(tallyUrl, xml));
  if (!importOutcome.success) return { outcome: importOutcome, xml };

  const readback = await verifyPurchaseVoucherInTally({ tallyUrl, companyName }, payload);
  const verified = readback.result?.verificationStatus === "verified";
  return {
    outcome: verified
      ? {
          success: true,
          result: {
            ...(importOutcome.result || {}),
            ...readback.result,
            verification: readback.result,
          },
        }
      : {
          success: false,
          error: "Tally created the Purchase voucher, but read-back verification did not match the approved preview.",
          result: {
            ...(importOutcome.result || {}),
            voucherCreatedButVerificationFailed: true,
            verification: readback.result,
          },
        },
    xml,
  };
}

async function postBankVoucher(tallyUrl, payload, companyName) {
  const voucherType = String(payload?.voucherType || "");
  const expectedDirection = payload?.expectedDirection || (/receipt/i.test(voucherType) ? "incoming" : "outgoing");
  const shouldCheckExisting =
    payload?.preflightVerifyExisting !== false &&
    /receipt|payment|contra|journal/i.test(voucherType);

  if (shouldCheckExisting) {
    const existingCheck = await verifyBankTransactionInTally(
      { tallyUrl, companyName },
      {
        ...payload,
        expectedDirection,
      }
    );
    const existingResult = existingCheck.result || {};

    if (existingResult.verificationStatus === "found") {
      return {
        outcome: {
          success: true,
          result: {
            alreadyInTally: true,
            created: 0,
            altered: 0,
            voucherId: existingResult.voucherId,
            voucherNumber: existingResult.voucherNumber,
            voucherType: existingResult.voucherType,
            voucherDate: existingResult.voucherDate,
            duplicateCheck: existingResult,
          },
        },
        xml: null,
        retriedWithLegacyHeader: false,
      };
    }

    if (existingResult.verificationStatus === "ambiguous") {
      return {
        outcome: {
          success: false,
          error: "Possible existing bank transaction found in Tally. Review before posting to avoid a duplicate.",
          result: {
            possibleDuplicateInTally: true,
            duplicateCheck: existingResult,
          },
        },
        xml: null,
        retriedWithLegacyHeader: false,
      };
    }
  }

  const primaryXml = buildBankVoucherXml(payload, companyName, { legacyEnvelope: true });
  const primaryOutcome = explainBankVoucherTallyError(
    requireCreatedVoucher(await invokeTallyXml(tallyUrl, primaryXml)),
    payload
  );

  return { outcome: primaryOutcome, xml: primaryXml, retriedWithLegacyHeader: false };
}

async function runBankVoucherCommandBatch(config, commands, options = {}) {
  const groups = new Map();
  for (const command of commands) {
    const payload = command?.payload || {};
    const key = [
      normalizeLooseName(payload.companyName || config.companyName),
      normalizeLooseName(payload.bankLedgerName),
    ].join("::");
    const group = groups.get(key) || [];
    group.push(command);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    let preflightByTransactionId = null;
    try {
      const firstPayload = group[0]?.payload || {};
      const batchPreflight = await reconcileBankTransactionsInTally(config, {
        companyName: firstPayload.companyName || config.companyName || null,
        bankLedgerName: firstPayload.bankLedgerName,
        transactions: group.map((command) => ({
          ...command.payload,
          expectedDirection:
            command.payload?.expectedDirection ||
            (/receipt/i.test(String(command.payload?.voucherType || "")) ? "incoming" : "outgoing"),
        })),
      });
      preflightByTransactionId = new Map(
        (batchPreflight.result?.transactions || []).map((row) => [String(row.transactionId || ""), row])
      );
    } catch (error) {
      console.warn(
        `Batch duplicate preflight was unavailable; falling back to independent checks: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const pendingCommands = [];
    for (const command of group) {
      try {
        const transactionId = String(command.payload?.transactionId || "");
        const preflight = preflightByTransactionId?.get(transactionId) || null;
        if (preflight?.verificationStatus === "found") {
          await sendCommandResult(config, command, {
            success: true,
            result: {
              alreadyInTally: true,
              created: 0,
              altered: 0,
              voucherId: preflight.voucherId,
              voucherNumber: preflight.voucherNumber,
              voucherDate: preflight.voucherDate,
              duplicateCheck: preflight,
              transactionId,
            },
          });
          console.log(`Command ${command.id} completed: bank transaction already existed in Tally.`);
          continue;
        }
        if (preflight?.verificationStatus === "ambiguous") {
          await sendCommandResult(config, command, {
            success: false,
            error: "Possible existing bank transaction found in Tally. Review before posting to avoid a duplicate.",
            result: {
              possibleDuplicateInTally: true,
              duplicateCheck: preflight,
              transactionId,
            },
          });
          console.log(`Command ${command.id} needs review: possible duplicate bank transaction.`);
          continue;
        }

        pendingCommands.push(command);
      } catch (error) {
        console.error(
          `Command ${command.id} failed without blocking the remaining vouchers: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (pendingCommands.length === 0) continue;

    const firstPayload = pendingCommands[0].payload || {};
    const companyName = firstPayload.companyName || config.companyName || null;
    let batchXml = null;
    let batchOutcome = null;
    const batchStartedAt = Date.now();
    try {
      batchXml = buildBankVoucherBatchXml(
        pendingCommands.map((command) => command.payload),
        companyName
      );
      batchOutcome = await invokeTallyXml(config.tallyUrl, batchXml);
    } catch (error) {
      batchOutcome = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        result: {},
      };
    }

    const batchElapsedMs = Date.now() - batchStartedAt;
    const importedCount =
      Number(batchOutcome.result?.created || 0) + Number(batchOutcome.result?.altered || 0);
    if (batchOutcome.success && importedCount >= pendingCommands.length) {
      await sendCommandResults(
        config,
        pendingCommands.map((command) => ({
          command,
          outcome: {
            success: true,
            result: {
              created: 1,
              altered: 0,
              transactionId: command.payload?.transactionId,
              sourceBankTransactionId: command.payload?.transactionId,
              voucherId: command.payload?.referenceNumber || command.id,
              voucherNumber: command.payload?.referenceNumber || null,
              requestXml: previewXml(batchXml),
              batchImport: true,
              batchSize: pendingCommands.length,
              batchElapsedMs,
            },
          },
        }))
      );
      console.log(
        `Posted ${pendingCommands.length} bank vouchers in one Tally request (${batchElapsedMs} ms).`
      );
      continue;
    }

    // A Tally batch may create its valid messages and report only the invalid
    // ones as exceptions. Reconcile once after a mixed result so already-created
    // rows are never retried as duplicates, then retry only confirmed-missing
    // rows independently. One bad voucher therefore cannot block the others.
    let postflightByTransactionId = null;
    try {
      const postflight = await reconcileBankTransactionsInTally(config, {
        companyName,
        bankLedgerName: firstPayload.bankLedgerName,
        transactions: pendingCommands.map((command) => ({
          ...command.payload,
          expectedDirection:
            command.payload?.expectedDirection ||
            (/receipt/i.test(String(command.payload?.voucherType || "")) ? "incoming" : "outgoing"),
        })),
      });
      postflightByTransactionId = new Map(
        (postflight.result?.transactions || []).map((row) => [String(row.transactionId || ""), row])
      );
    } catch (error) {
      console.warn(
        `Batch postflight verification was unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    for (const command of pendingCommands) {
      const transactionId = String(command.payload?.transactionId || "");
      const postflight = postflightByTransactionId?.get(transactionId) || null;
      if (postflight?.verificationStatus === "found") {
        await sendCommandResult(config, command, {
          success: true,
          result: {
            created: 1,
            transactionId,
            sourceBankTransactionId: transactionId,
            voucherId: postflight.voucherId || command.payload?.referenceNumber || command.id,
            voucherNumber: postflight.voucherNumber || command.payload?.referenceNumber || null,
            duplicateCheck: postflight,
            requestXml: batchXml ? previewXml(batchXml) : null,
            batchImport: true,
            batchSize: pendingCommands.length,
            batchElapsedMs,
          },
        });
        continue;
      }

      try {
        await runCommand(
          config,
          {
            ...command,
            payload: {
              ...command.payload,
              preflightVerifyExisting: postflightByTransactionId === null,
            },
          },
          options
        );
      } catch (error) {
        console.error(
          `Command ${command.id} failed after batch isolation: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
}

async function postCustomerAdvanceAdjustment(tallyUrl, payload, companyName) {
  const xml = buildCustomerAdvanceAdjustmentXml(payload, companyName);
  const outcome = requireCreatedVoucher(await invokeTallyXml(tallyUrl, xml));

  return { outcome, xml };
}

async function postDebitNote(tallyUrl, payload, companyName) {
  const xml = buildDebitNoteXml(payload, companyName);
  const outcome = requireCreatedVoucher(await invokeTallyXml(tallyUrl, xml));

  return { outcome, xml };
}

async function invokeTallyXml(tallyUrl, xml) {
  const controller = new AbortController();
  let timeout;

  try {
    const response = await Promise.race([
      fetch(tallyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml",
        },
        body: xml,
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          const error = new Error("Tally import timed out.");
          error.name = "AbortError";
          reject(error);
        }, TALLY_IMPORT_TIMEOUT_MS);
      }),
    ]);

    const text = await response.text();
    return parseTallyImportResult(text, response.status);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function previewXml(xml) {
  return xml.replace(/\s+/g, " ").trim().slice(0, 4000);
}

async function exportTallyCollection(tallyUrl, options) {
  return exportTallyXml(
    tallyUrl,
    buildCollectionExportXml(options),
    options.collectionName
  );
}

async function exportTallyXml(tallyUrl, xml, label = "Tally export") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TALLY_EXPORT_TIMEOUT_MS);

  try {
    const response = await fetch(tallyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
      },
      body: xml,
      signal: controller.signal,
    });

    const text = await response.text();
    const result = parseExportResult(text, response.status);
    if (!result.success) {
      throw new Error(
        result.error ||
          `Tally export failed for ${label} with HTTP ${response.status}.`
      );
    }

    return text;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(TALLY_EXPORT_TIMEOUT_MS / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function toMaster(block, tagName) {
  const name = getAttribute(block, "NAME") || getTagText(block, "NAME");
  if (!name) return null;
  const optionalMasterValue = (value) => {
    const normalized = cleanXmlText(value);
    return !normalized || /^(?:not\s+found|not\s+available|n\/?a|none|null|undefined|-+)$/i.test(normalized)
      ? null
      : normalized;
  };

  const bankName =
    getTagText(block, "BANKNAME") ||
    getTagText(block, "BANK") ||
    getTagText(block, "BANKERNAME");
  const bankAccountNumber =
    getTagText(block, "BANKACCOUNTNUMBER") ||
    getTagText(block, "ACCOUNTNUMBER") ||
    getTagText(block, "BANKACCOUNTNO") ||
    getTagText(block, "BANKACNO") ||
    getTagText(block, "ACNUMBER");
  const ifscCode =
    getTagText(block, "IFSCCODE") ||
    getTagText(block, "IFSCODE") ||
    getTagText(block, "IFSC") ||
    getTagText(block, "BANKIFSCCODE");
  const branchName =
    getTagText(block, "BRANCHNAME") ||
    getTagText(block, "BANKBRANCHNAME") ||
    getTagText(block, "BRANCH");
  const accountHolderName =
    getTagText(block, "BANKACCHOLDERNAME") ||
    getTagText(block, "BANKACCOUNTNAME") ||
    getTagText(block, "BANKACCOUNTHOLDERNAME") ||
    getTagText(block, "ACCOUNTHOLDERNAME");
  const email =
    getTagText(block, "EMAIL") ||
    getTagText(block, "EMAILID") ||
    getTagText(block, "LEDGEREMAIL") ||
    getTagText(block, "LEDGEREMAILID");
  const phone =
    getTagText(block, "LEDGERMOBILE") ||
    getTagText(block, "MOBILE") ||
    getTagText(block, "MOBILENO") ||
    getTagText(block, "PHONENUMBER") ||
    getTagText(block, "PHONE") ||
    getTagText(block, "LEDGERPHONE");
  const contactPerson =
    getTagText(block, "CONTACTPERSON") ||
    getTagText(block, "CONTACT") ||
    getTagText(block, "ATTENTIONTO");
  const address = [
    ...getTagTexts(block, "ADDRESS"),
    getTagText(block, "ADDRESS1"),
    getTagText(block, "ADDRESS2"),
    getTagText(block, "ADDRESS3"),
    getTagText(block, "ADDRESS4"),
    getTagText(block, "PINCODE"),
  ].filter(Boolean).join(", ");
  const taxRate =
    getTagText(block, "RATEOFTAXCALCULATION") ||
    getTagText(block, "GSTTAXRATE") ||
    getTagText(block, "RATEOFVAT");
  const closingBalance = parseLedgerClosingBalance(getTagText(block, "CLOSINGBALANCE"));

  return {
    name,
    guid: getTagText(block, "GUID"),
    parent: getTagText(block, "PARENT"),
    gstin: optionalMasterValue(
      getTagText(block, "PARTYGSTIN") ||
      getTagText(block, "GSTIN") ||
      getTagText(block, "GSTREGISTRATIONNUMBER") ||
      getTagText(block, "GSTREGNUMBER")
    ),
    bankName,
    bankAccountNumber,
    ifscCode,
    branchName,
    accountHolderName,
    email,
    phone,
    contactPerson,
    address,
    hsnCode: optionalMasterValue(getTagText(block, "GSTHSNCODE") || getTagText(block, "HSNCODE")),
    unitName: optionalMasterValue(getTagText(block, "BASEUNITS") || getTagText(block, "ORIGINALBASEUNITS")),
    taxRate: optionalMasterValue(taxRate),
    closingBalance: closingBalance.amount,
    closingBalanceType: closingBalance.type,
    raw: {
      tallyTag: tagName,
      reservedName: getAttribute(block, "RESERVEDNAME"),
      bankName,
      bankAccountNumber,
      ifscCode,
      branchName,
      accountHolderName,
      taxType: getTagText(block, "TAXTYPE"),
      gstDutyHead: getTagText(block, "GSTDUTYHEAD"),
      billWiseEnabled: /^yes$/i.test(getTagText(block, "ISBILLWISEON")),
      closingBalance: closingBalance.amount,
      closingBalanceType: closingBalance.type,
      closingBalanceRaw: closingBalance.raw,
      email,
      phone,
      contactPerson,
      address,
      stateName: getTagText(block, "STATENAME") || getTagText(block, "STATE"),
      countryName: getTagText(block, "COUNTRYNAME") || getTagText(block, "COUNTRY"),
    },
  };
}

function dedupeMasters(masters) {
  const seen = new Set();
  const result = [];

  for (const master of masters) {
    const key = `${master.guid || ""}:${master.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(master);
  }

  return result;
}

function parseMasterCollection(xml, tagName) {
  return dedupeMasters(
    extractBlocks(xml, tagName)
      .map((block) => toMaster(block, tagName))
      .filter(Boolean)
  );
}

// Bank-statement analysis only needs identity, hierarchy and bill-wise state for
// the complete ledger list. Avoid the generic master parser here: it scans every
// ledger for dozens of GST, contact, address and inventory fields that are not
// used by this workflow.
function parseBankStatementMasterCollection(xml, tagName, { bankDetails = false } = {}) {
  return dedupeMasters(
    extractBlocks(xml, tagName)
      .map((block) => {
        const name = getAttribute(block, "NAME") || getTagText(block, "NAME");
        if (!name) return null;
        const closingBalance = bankDetails
          ? parseLedgerClosingBalance(getTagText(block, "CLOSINGBALANCE"))
          : { amount: null, type: null };
        const bankName = bankDetails
          ? getTagText(block, "BANKNAME") || getTagText(block, "BANK") || getTagText(block, "BANKERNAME")
          : null;
        const bankAccountNumber = bankDetails
          ? getTagText(block, "BANKACCOUNTNUMBER") || getTagText(block, "ACCOUNTNUMBER") ||
            getTagText(block, "BANKACCOUNTNO") || getTagText(block, "BANKACNO") || getTagText(block, "ACNUMBER")
          : null;
        const ifscCode = bankDetails
          ? getTagText(block, "IFSCCODE") || getTagText(block, "IFSCODE") ||
            getTagText(block, "IFSC") || getTagText(block, "BANKIFSCCODE")
          : null;
        const accountHolderName = bankDetails
          ? getTagText(block, "BANKACCHOLDERNAME") || getTagText(block, "BANKACCOUNTNAME") ||
            getTagText(block, "BANKACCOUNTHOLDERNAME") || getTagText(block, "ACCOUNTHOLDERNAME")
          : null;

        return {
          name,
          guid: getTagText(block, "GUID") || null,
          parent: getTagText(block, "PARENT") || null,
          bankName,
          bankAccountNumber,
          ifscCode,
          accountHolderName,
          closingBalance: closingBalance.amount,
          closingBalanceType: closingBalance.type,
          raw: {
            tallyTag: tagName,
            billWiseEnabled: /^yes$/i.test(getTagText(block, "ISBILLWISEON")),
          },
        };
      })
      .filter(Boolean)
  );
}

function toVoucher(block) {
  const ledgerEntries = extractBlocks(block, "ALLLEDGERENTRIES.LIST")
    .map((entry) => ({
      ledgerName: getTagText(entry, "LEDGERNAME"),
      amount: parseTallyAmount(getTagText(entry, "AMOUNT")),
      isDebit: /^yes$/i.test(getTagText(entry, "ISDEEMEDPOSITIVE") || ""),
    }))
    .filter((entry) => entry.ledgerName);
  const ledgerNames = ledgerEntries.map((entry) => entry.ledgerName).filter(Boolean);
  const bankReferences = extractBlocks(block, "BANKALLOCATIONS.LIST")
    .flatMap((entry) => [
      getTagText(entry, "INSTRUMENTNUMBER"),
      getTagText(entry, "TRANSACTIONNAME"),
      getTagText(entry, "NAME"),
    ])
    .filter(Boolean);
  const inventoryEntries = extractBlocks(block, "ALLINVENTORYENTRIES.LIST")
    .map((entry) => ({
      stockItemName: getTagText(entry, "STOCKITEMNAME"),
      description: getTagText(entry, "DESCRIPTION"),
      hsn:
        getTagText(entry, "HSNOVRDNCLASSIFICATION") ||
        getTagText(entry, "GSTHSNNAME") ||
        getTagText(entry, "GSTOVRDNHSNCODE") ||
        getTagText(entry, "GSTHSNCODE") ||
        getTagText(entry, "HSNCODE"),
      quantity: getTagText(entry, "BILLEDQTY") || getTagText(entry, "ACTUALQTY"),
      rate: getTagText(entry, "RATE"),
      amount: Math.abs(parseTallyAmount(getTagText(entry, "AMOUNT")) ?? 0),
      purchaseLedgerName:
        extractBlocks(entry, "ACCOUNTINGALLOCATIONS.LIST")
          .map((allocation) => getTagText(allocation, "LEDGERNAME"))
          .find(Boolean) || null,
    }))
    .filter((entry) => entry.stockItemName);
  const billAllocations = extractBlocks(block, "BILLALLOCATIONS.LIST")
    .map((allocation) => ({
      referenceName: getTagText(allocation, "NAME"),
      billType: getTagText(allocation, "BILLTYPE") || getTagText(allocation, "TYPEOFREF"),
      billDate: getTagText(allocation, "BILLDATE"),
      amount: Math.abs(parseTallyAmount(getTagText(allocation, "AMOUNT")) ?? 0),
    }))
    .filter((allocation) => allocation.referenceName && allocation.amount > 0);

  return {
    date: getTagText(block, "DATE"),
    effectiveDate: getTagText(block, "EFFECTIVEDATE"),
    voucherType: getTagText(block, "VOUCHERTYPENAME") || getAttribute(block, "VCHTYPE"),
    voucherNumber: getTagText(block, "VOUCHERNUMBER"),
    reference: getTagText(block, "REFERENCE"),
    referenceDate: getTagText(block, "REFERENCEDATE"),
    narration: getTagText(block, "NARRATION"),
    partyLedgerName: getTagText(block, "PARTYLEDGERNAME"),
    ledgerNames,
    ledgerEntries,
    bankReferences,
    billAllocations,
    inventoryEntries,
    masterId: getTagText(block, "MASTERID"),
    alterId: getTagText(block, "ALTERID"),
    guid: getTagText(block, "GUID"),
    isCancelled: getTagText(block, "ISCANCELLED"),
    sourceDocumentPath: getUdfTagText(block, "GAJKESARISOURCEDOCUMENTPATH"),
    sourceDocumentName: getUdfTagText(block, "GAJKESARISOURCEDOCUMENTNAME"),
    sourceDocumentSha256: getUdfTagText(block, "GAJKESARISOURCEDOCUMENTSHA256"),
    sourceDocumentId: getUdfTagText(block, "GAJKESARISOURCEDOCUMENTID"),
    rawPreview: previewXml(block),
  };
}

function parseVoucherCollection(xml) {
  return extractBlocks(xml, "VOUCHER").map(toVoucher);
}

function isSameTallyText(left, right) {
  const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return Boolean(normalize(left) && normalize(left) === normalize(right));
}

function isNumericMasterId(value) {
  return /^\d+$/.test(String(value ?? "").trim());
}

async function resolveDebitNoteVoucher(tallyUrl, payload, fallbackCompanyName) {
  const companyName = payload?.companyName || fallbackCompanyName;
  const requestedMasterId = String(payload?.tallyVoucherId || payload?.voucherId || "").trim();
  const requestedReference = String(payload?.referenceNumber || payload?.expectedReference || "").trim();
  const requestedParty = String(payload?.partyLedgerName || "").trim();
  const requestedAmount = Number(payload?.amount ?? 0);
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Gajkesari Debit Note Voucher Lookup",
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,GUID,IsCancelled,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive",
    companyName,
    // Tally's default collection window ends at its current date. Debit Notes
    // created with a future-effective date must still be found and exported.
    dateFrom: "2000-04-01",
    dateTo: "2099-03-31",
  });
  const vouchers = parseVoucherCollection(xml).filter(
    (voucher) => isSameTallyText(voucher.voucherType, "Debit Note") && !/^yes$/i.test(voucher.isCancelled || "")
  );

  let matches = isNumericMasterId(requestedMasterId)
    ? vouchers.filter((voucher) => String(voucher.masterId || "") === requestedMasterId)
    : [];

  if (matches.length === 0 && requestedReference) {
    matches = vouchers.filter((voucher) => isSameTallyText(voucher.reference, requestedReference));
  }
  if (requestedParty) {
    matches = matches.filter(
      (voucher) =>
        isSameTallyText(voucher.partyLedgerName, requestedParty) ||
        voucher.ledgerNames.some((ledgerName) => isSameTallyText(ledgerName, requestedParty))
    );
  }
  if (requestedAmount > 0) {
    matches = matches.filter((voucher) => voucherHasAnyAmount(voucher, requestedAmount));
  }

  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "Tally did not return the expected Debit Note for native PDF export."
        : "More than one Tally Debit Note matched this request. Native PDF export was stopped."
    );
  }

  const voucher = matches[0];
  if (!voucher.masterId || !voucher.voucherNumber) {
    throw new Error("Tally returned a Debit Note without a MasterID or voucher number.");
  }
  if (requestedReference && !isSameTallyText(voucher.reference, requestedReference)) {
    throw new Error("Tally Debit Note reference does not match the Gajkesari request.");
  }
  if (requestedParty && !voucherHasLedger(voucher, requestedParty)) {
    throw new Error("Tally Debit Note customer does not match the Gajkesari request.");
  }
  if (requestedAmount > 0 && !voucherHasAnyAmount(voucher, requestedAmount)) {
    throw new Error("Tally Debit Note amount does not match the Gajkesari request.");
  }
  return voucher;
}

function debitNoteVoucherAmount(voucher) {
  return voucher.ledgerEntries.reduce((largest, entry) => Math.max(largest, Math.abs(Number(entry.amount) || 0)), 0);
}

function debitNotePartyName(voucher, requestedParty) {
  return voucher.partyLedgerName || voucher.ledgerNames.find((ledgerName) => isSameTallyText(ledgerName, requestedParty)) || null;
}

function escapeHtml(value) {
  return escapeXml(value ?? "");
}

function formatDebitNoteDate(value) {
  const raw = String(value ?? "").trim();
  const compactDate = /^\d{8}$/.test(raw)
    ? raw
    : /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw.replaceAll("-", "")
      : "";
  if (compactDate) {
    const [, year, month, day] = compactDate.match(/^(\d{4})(\d{2})(\d{2})$/) || [];
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (!Number.isNaN(date.valueOf())) {
      return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      }).format(date).replace(/ /g, "-");
    }
  }
  return raw || "—";
}

function formatIndianAmount(value) {
  const amount = Math.abs(Number(value) || 0);
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function amountInIndianWords(value) {
  const number = Math.round(Math.abs(Number(value) || 0) * 100);
  const rupees = Math.floor(number / 100);
  const paise = number % 100;
  const small = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const underThousand = (input) => {
    const valueToRead = Math.trunc(input);
    const parts = [];
    if (valueToRead >= 100) parts.push(`${small[Math.floor(valueToRead / 100)]} Hundred`);
    const remainder = valueToRead % 100;
    if (remainder >= 20) parts.push(`${tens[Math.floor(remainder / 10)]}${remainder % 10 ? ` ${small[remainder % 10]}` : ""}`);
    else if (remainder > 0) parts.push(small[remainder]);
    return parts.join(" ");
  };
  const whole = (input) => {
    if (input === 0) return "Zero";
    const parts = [];
    const crore = Math.floor(input / 10000000);
    const lakh = Math.floor((input % 10000000) / 100000);
    const thousand = Math.floor((input % 100000) / 1000);
    const rest = input % 1000;
    if (crore) parts.push(`${underThousand(crore)} Crore`);
    if (lakh) parts.push(`${underThousand(lakh)} Lakh`);
    if (thousand) parts.push(`${underThousand(thousand)} Thousand`);
    if (rest) parts.push(underThousand(rest));
    return parts.join(" ");
  };
  return `INR ${whole(rupees)}${paise ? ` and ${whole(paise)} Paise` : ""} Only`;
}

function buildVerifiedDebitNoteHtml({ companyName, voucher, requestedParty }) {
  const partyName = debitNotePartyName(voucher, requestedParty);
  const amount = debitNoteVoucherAmount(voucher);
  const reference = voucher.reference || voucher.voucherNumber || "—";
  const particulars = voucher.narration || `Debit note against reference ${reference}.`;
  const visibleAmount = formatIndianAmount(amount);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      @page { size: A4; margin: 15mm 17mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #111; font: 12px Arial, sans-serif; }
      .document { min-height: 255mm; display: flex; flex-direction: column; }
      .company { font-size: 16px; font-weight: 700; text-align: center; margin: 2px 0 16px; }
      .title { font-size: 18px; font-weight: 700; text-align: center; margin: 0 0 18px; }
      .details { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 30px; margin-bottom: 18px; }
      .label { color: #333; display: inline-block; min-width: 68px; margin-right: 8px; }
      .party { margin: 0 0 18px; font-size: 13px; }
      .party strong { font-size: 14px; }
      table { border-collapse: collapse; width: 100%; }
      th { border-top: 1px solid #111; border-bottom: 1px solid #111; padding: 7px 6px; text-align: left; font-weight: 700; }
      th:last-child, td:last-child { width: 155px; text-align: right; border-left: 1px solid #111; }
      td { vertical-align: top; padding: 18px 7px 122px; line-height: 1.45; }
      .words { width: 72%; padding-top: 0; font-weight: 700; }
      .total-row td { border-top: 1px solid #111; padding: 8px 7px; font-weight: 700; }
      .narration { border-top: 1px solid #111; margin-top: 18px; padding: 8px 0; }
      .footer { margin-top: auto; padding-top: 32px; text-align: right; font-weight: 700; }
      .signatory { margin-top: 70px; text-align: right; }
    </style>
  </head>
  <body>
    <main class="document" data-gajkesari-voucher-id="${escapeHtml(voucher.masterId)}">
      <div class="company">${escapeHtml(companyName)}</div>
      <div class="title">Debit Note</div>
      <section class="details">
        <div><span class="label">No.</span><strong>${escapeHtml(voucher.voucherNumber)}</strong></div>
        <div><span class="label">Dated</span><strong>${escapeHtml(formatDebitNoteDate(voucher.date || voucher.effectiveDate))}</strong></div>
        <div><span class="label">Ref.</span><strong>${escapeHtml(reference)}</strong></div>
      </section>
      <p class="party"><span class="label">Party's Name</span><strong>${escapeHtml(partyName)}</strong></p>
      <table>
        <thead><tr><th>Particulars</th><th>Amount</th></tr></thead>
        <tbody>
          <tr><td>${escapeHtml(particulars)}</td><td><strong>₹ ${escapeHtml(visibleAmount)}</strong></td></tr>
          <tr><td class="words">Amount (in words):<br>${escapeHtml(amountInIndianWords(amount))}</td><td></td></tr>
          <tr class="total-row"><td>Total</td><td>₹ ${escapeHtml(visibleAmount)}</td></tr>
        </tbody>
      </table>
      <div class="narration"><strong>Narration:</strong><br>${escapeHtml(voucher.narration || particulars)}</div>
      <div class="footer">for ${escapeHtml(companyName)}</div>
      <div class="signatory">Authorised Signatory</div>
    </main>
  </body>
</html>`;
}

function assertVerifiedDebitNoteHtml(html, voucher, requestedParty) {
  const visibleText = decodeXmlEntities(String(html ?? ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const partyName = debitNotePartyName(voucher, requestedParty);
  const amount = formatIndianAmount(debitNoteVoucherAmount(voucher));
  const expected = ["debit note", voucher.voucherNumber, partyName, amount];
  const missing = expected.filter((value) => value && !visibleText.includes(String(value).toLowerCase()));
  if (missing.length > 0) {
    throw new Error("Tally Debit Note PDF verification failed: voucher number, customer, or amount is missing from the document.");
  }
}

function voucherFromConfirmedDebitNotePayload(payload) {
  const masterId = String(payload?.tallyVoucherId ?? payload?.voucherId ?? "").trim();
  const voucherNumber = String(payload?.tallyVoucherNumber ?? payload?.voucherNumber ?? "").trim();
  const partyLedgerName = String(payload?.partyLedgerName ?? "").trim();
  const reference = String(payload?.referenceNumber ?? payload?.expectedReference ?? "").trim();
  const amount = Math.abs(Number(payload?.amount ?? 0));
  if (!masterId || !voucherNumber || !partyLedgerName || !reference || !(amount > 0)) {
    throw new Error("The confirmed Tally Debit Note details are incomplete; PDF export was stopped.");
  }

  const linkedInvoiceNumber = String(payload?.linkedInvoiceNumber ?? "").trim();
  const narration = String(payload?.narration ?? "").trim() ||
    `Cash discount recovery against invoice ${linkedInvoiceNumber || reference}.`;
  return {
    date: String(payload?.voucherDate ?? "").trim(),
    effectiveDate: String(payload?.voucherDate ?? "").trim(),
    voucherType: "Debit Note",
    voucherNumber,
    reference,
    narration,
    partyLedgerName,
    ledgerNames: [partyLedgerName],
    ledgerEntries: [{ ledgerName: partyLedgerName, amount, isDebit: true }],
    masterId,
    alterId: null,
    guid: null,
    isCancelled: "No",
  };
}

async function exportNativeDebitNotePdf(companyName, voucher, requestedParty, renderTallyPrintToPdf) {
  if (typeof renderTallyPrintToPdf !== "function") {
    throw new Error("The desktop Gajkesari connector must be running to prepare the official Tally PDF.");
  }
  // Tally's VCH Print HTTP report returns an unbound, blank voucher shell
  // even when the requested MasterID is supplied. It cannot be used as a
  // customer document. The payload here was saved only after the Debit Note
  // creation command was confirmed by Tally; render those confirmed fields
  // and reject any document that omits its identity.
  const tallyHtml = buildVerifiedDebitNoteHtml({
    companyName,
    voucher,
    requestedParty,
  });
  assertVerifiedDebitNoteHtml(tallyHtml, voucher, requestedParty);
  const pdf = await renderTallyPrintToPdf({
    html: tallyHtml,
    fileName: `Tally-Debit-Note-${voucher.voucherNumber || voucher.masterId}.pdf`,
  });
  if (!Buffer.isBuffer(pdf) || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("The desktop connector could not render the verified Tally Debit Note into a PDF.");
  }
  if (pdf.length > MAX_NATIVE_DEBIT_NOTE_PDF_BYTES) {
    throw new Error("The verified Tally Debit Note PDF exceeds the 5 MB document limit.");
  }
  return {
    nativePdfBase64: pdf.toString("base64"),
    nativePdfSha256: createHash("sha256").update(pdf).digest("hex"),
    nativePdfByteSize: pdf.length,
    nativePdfFileName: `Tally-Debit-Note-${voucher.voucherNumber || voucher.masterId}.pdf`,
  };
}

function normalizeDateForCompare(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return parseTallyDate(raw);
}

function amountMatches(left, right) {
  return Math.abs(Math.abs(Number(left ?? 0)) - Math.abs(Number(right ?? 0))) < 0.01;
}

function voucherHasLedger(voucher, ledgerName) {
  const key = normalizeLooseName(ledgerName);
  if (!key) return false;
  return [
    voucher.partyLedgerName,
    ...voucher.ledgerNames,
  ].some((name) => normalizeLooseName(name) === key);
}

function voucherHasLedgerAmount(voucher, ledgerName, amount) {
  const key = normalizeLooseName(ledgerName);
  if (!key) return false;
  return voucher.ledgerEntries.some(
    (entry) => normalizeLooseName(entry.ledgerName) === key && amountMatches(entry.amount, amount)
  );
}

function voucherHasAnyAmount(voucher, amount) {
  return voucher.ledgerEntries.some((entry) => amountMatches(entry.amount, amount));
}

function normalizedNeedle(value) {
  return normalizeLooseName(value);
}

function voucherSearchText(voucher) {
  return [
    voucher.voucherNumber,
    voucher.reference,
    voucher.narration,
    voucher.partyLedgerName,
    ...(voucher.bankReferences || []),
    ...voucher.ledgerNames,
    voucher.rawPreview,
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeExactReference(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function voucherHasExactReference(voucher, referenceNumber) {
  const expected = normalizeExactReference(referenceNumber);
  if (expected.length < 5) return false;
  return [voucher.reference, ...(voucher.bankReferences || [])]
    .some((value) => normalizeExactReference(value) === expected);
}

function getBankLedgerEntry(voucher, bankLedgerName, amount, expectedDirection) {
  const bankKey = normalizeLooseName(bankLedgerName);
  const incoming = String(expectedDirection || "").toLowerCase() === "incoming";
  const outgoing = String(expectedDirection || "").toLowerCase() === "outgoing";
  return voucher.ledgerEntries.find((entry) => {
    if (normalizeLooseName(entry.ledgerName) !== bankKey || !amountMatches(entry.amount, amount)) {
      return false;
    }
    if (incoming) return entry.isDebit === true;
    if (outgoing) return entry.isDebit === false;
    return false;
  }) || null;
}

function validateStatementBalanceSequence(transactions) {
  const rows = transactions.map((transaction) => ({
    debit: Number(transaction.debitAmount || 0),
    credit: Number(transaction.creditAmount || 0),
    balance:
      transaction.balanceAmount === null ||
      transaction.balanceAmount === undefined ||
      transaction.balanceAmount === ""
        ? null
        : Number(transaction.balanceAmount),
  }));
  if (rows.length === 0 || rows.some((row) => row.balance === null || !Number.isFinite(row.balance))) {
    return { available: false, valid: false, reason: "Statement running balances were unavailable." };
  }

  const test = (orderedRows) => {
    for (let index = 1; index < orderedRows.length; index += 1) {
      const previous = orderedRows[index - 1];
      const current = orderedRows[index];
      const expected = previous.balance + current.credit - current.debit;
      if (Math.abs(expected - current.balance) >= 0.01) return null;
    }
    const first = orderedRows[0];
    return {
      openingBalance: first.balance - first.credit + first.debit,
      closingBalance: orderedRows.at(-1).balance,
      movement: orderedRows.reduce((sum, row) => sum + row.credit - row.debit, 0),
    };
  };

  const forward = test(rows);
  const reversed = forward ? null : test([...rows].reverse());
  const result = forward || reversed;
  return result
    ? { available: true, valid: true, order: forward ? "statement" : "reversed", ...result }
    : { available: true, valid: false, reason: "Statement running balances do not follow the debit/credit sequence." };
}

async function fetchLedgerClosingBalance(tallyUrl, options) {
  const xml = await exportTallyXml(
    tallyUrl,
    buildLedgerBalanceExportXml(options),
    "Bank ledger closing balance"
  );
  return parseTallyAmount(getTagText(xml, "CLOSINGBALANCE"));
}

function strictBankTransactionCandidates(vouchers, transaction, bankLedgerName, reservedVoucherIndexes) {
  const voucherDate = normalizeDateForCompare(transaction.voucherDate);
  const amount = Number(transaction.amount || 0);
  const referenceNumber = String(transaction.referenceNumber || "").trim();
  const counterpartyLedgerName = String(transaction.counterpartyLedgerName || "").trim();
  const baseCandidates = vouchers.flatMap((voucher, index) => {
    if (reservedVoucherIndexes.has(index)) return [];
    const date = normalizeDateForCompare(voucher.effectiveDate || voucher.date);
    const bankEntry = getBankLedgerEntry(
      voucher,
      bankLedgerName,
      amount,
      transaction.expectedDirection
    );
    if (!voucherDate || date !== voucherDate || !bankEntry) return [];
    return [{ voucher, index, bankEntry }];
  });

  const hasUsableReference = normalizeExactReference(referenceNumber).length >= 5;
  const counterpartyKey = normalizeLooseName(counterpartyLedgerName);
  const hasUsableCounterparty = Boolean(counterpartyKey && !counterpartyKey.includes("suspense"));
  const identityInsufficient = !hasUsableReference && !hasUsableCounterparty;
  let candidates;
  if (hasUsableReference) {
    // An exact usable bank reference is independent transaction identity. Party
    // mismatch must not hide a voucher when the selected ledger was wrong.
    candidates = baseCandidates.filter(({ voucher }) => voucherHasExactReference(voucher, referenceNumber));
  } else if (hasUsableCounterparty) {
    // Without a bank reference, the exact selected counterparty is mandatory.
    // Same-date and same-amount vouchers belonging to another ledger are not a
    // match and must remain missing.
    candidates = baseCandidates.filter(({ voucher }) => voucherHasLedger(voucher, counterpartyLedgerName));
  } else {
    // Keep same-date/amount candidates only so the caller can report ambiguity;
    // one such voucher is never sufficient without a reference or party.
    candidates = baseCandidates;
  }

  return {
    candidates,
    baseCandidateCount: baseCandidates.length,
    hasUsableReference,
    hasUsableCounterparty,
    identityInsufficient,
  };
}

function serializeStrictVoucherMatch(candidate) {
  const voucher = candidate.voucher;
  return {
    date: normalizeDateForCompare(voucher.effectiveDate || voucher.date),
    voucherType: voucher.voucherType,
    voucherNumber: voucher.voucherNumber,
    reference: voucher.reference,
    bankReferences: voucher.bankReferences || [],
    partyLedgerName: voucher.partyLedgerName,
    ledgerNames: voucher.ledgerNames,
    masterId: voucher.masterId,
  };
}

async function reconcileBankTransactionsInTally(config, commandPayload = {}) {
  const transactions = Array.isArray(commandPayload.transactions) ? commandPayload.transactions : [];
  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const bankLedgerName = String(commandPayload.bankLedgerName || "").trim();
  if (!bankLedgerName) throw new Error("Bank transaction verification requires the bank ledger name.");
  if (transactions.length === 0) throw new Error("Bank transaction verification requires at least one row.");

  const normalizedTransactions = transactions.map((transaction, index) => {
    const voucherDate = normalizeDateForCompare(transaction.voucherDate);
    const amount = Number(transaction.amount || 0);
    const expectedDirection = String(transaction.expectedDirection || "").toLowerCase();
    if (!voucherDate) throw new Error(`Bank statement row ${index + 1} requires a valid date.`);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Bank statement row ${index + 1} requires a positive amount.`);
    }
    if (!['incoming', 'outgoing'].includes(expectedDirection)) {
      throw new Error(`Bank statement row ${index + 1} requires a debit/credit direction.`);
    }
    return { ...transaction, voucherDate, amount, expectedDirection };
  });
  const dates = normalizedTransactions.map((transaction) => transaction.voucherDate).sort();
  const dateFrom = dates[0];
  const dateTo = dates.at(-1);
  const bankEntryFormulaName = "AutodealerBankLedgerEntry";
  const bankVoucherFormulaName = "AutodealerBankVoucher";

  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Gajkesari Bank Statement Reconciliation",
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,IsCancelled,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BankAllocations.Name,AllLedgerEntries.BankAllocations.InstrumentNumber,AllLedgerEntries.BankAllocations.TransactionName",
    companyName,
    dateFrom,
    dateTo,
    formulae: [
      {
        name: bankEntryFormulaName,
        formula: buildRequestedLedgerFormula([bankLedgerName], ["$LedgerName"]),
      },
      {
        name: bankVoucherFormulaName,
        formula: `$$FilterCount:AllLedgerEntries:${bankEntryFormulaName} > 0`,
      },
    ],
    // Do not filter by exact VoucherTypeName: Tally companies frequently use
    // custom voucher types derived from Receipt/Payment/Contra/Journal.
    filterNames: [bankVoucherFormulaName],
  });
  const vouchers = parseVoucherCollection(xml).filter(
    (voucher) => !/^yes$/i.test(String(voucher.isCancelled || ""))
  );
  const reservedVoucherIndexes = new Set();
  const results = normalizedTransactions.map((transaction) => {
    const {
      candidates,
      baseCandidateCount,
      hasUsableReference,
      hasUsableCounterparty,
      identityInsufficient,
    } = strictBankTransactionCandidates(
      vouchers,
      transaction,
      bankLedgerName,
      reservedVoucherIndexes
    );
    // An exact bank reference is expected to identify one economic transaction.
    // If Tally contains that same strict reference more than once, the statement
    // row is unquestionably already posted; the extra vouchers are a Tally data
    // quality issue, not a reason to post the bank row again.
    const duplicateInTally = hasUsableReference && candidates.length > 1;
    const verificationStatus = identityInsufficient && candidates.length > 0
      ? "ambiguous"
      : candidates.length === 1 || duplicateInTally
      ? "found"
      : candidates.length > 1
        ? "ambiguous"
        : "missing";
    if (verificationStatus === "found") {
      const indexesToReserve = duplicateInTally ? candidates.map((candidate) => candidate.index) : [candidates[0].index];
      indexesToReserve.forEach((index) => reservedVoucherIndexes.add(index));
    }
    const selectedCandidate = verificationStatus === "found" ? candidates[0] : null;
    return {
      transactionId: transaction.transactionId || null,
      verificationStatus,
      matchCount: candidates.length,
      duplicateInTally,
      duplicateVoucherCount: duplicateInTally ? candidates.length : 0,
      baseCandidateCount,
      scannedCount: vouchers.length,
      voucherId: selectedCandidate ? selectedCandidate.voucher.masterId || selectedCandidate.voucher.voucherNumber : null,
      voucherNumber: selectedCandidate ? selectedCandidate.voucher.voucherNumber : null,
      voucherDate: selectedCandidate
        ? normalizeDateForCompare(selectedCandidate.voucher.effectiveDate || selectedCandidate.voucher.date)
        : null,
      reason: duplicateInTally
        ? `${candidates.length} Tally vouchers have the same strict bank transaction reference. The statement row is already posted; review the duplicate Tally vouchers separately.`
        : verificationStatus === "found"
          ? "A unique Tally voucher matched the date, bank ledger, amount, direction and available reference."
        : identityInsufficient && verificationStatus === "ambiguous"
          ? "A same-date and same-amount voucher exists, but no usable bank reference or exact counterparty ledger proves it is this statement row. Review manually."
        : verificationStatus === "ambiguous"
          ? "More than one same-date and same-amount voucher matched, but no reliable bank reference identifies one transaction. Review manually."
          : !hasUsableReference && hasUsableCounterparty && baseCandidateCount > 0
            ? "Date, amount and direction matched, but the exact selected counterparty ledger did not."
          : hasUsableReference && baseCandidateCount > 0
            ? "Date, amount and direction matched, but the exact UTR/reference did not."
            : "No unused Tally voucher matched the date, selected bank ledger, amount and direction.",
      matches: candidates.slice(0, 5).map(serializeStrictVoucherMatch),
    };
  });

  const statementBalance = validateStatementBalanceSequence(normalizedTransactions);
  const periodBankEntries = vouchers.flatMap((voucher) => voucher.ledgerEntries.filter(
    (entry) => normalizeLooseName(entry.ledgerName) === normalizeLooseName(bankLedgerName)
  ));
  const tallyMovement = periodBankEntries.reduce((sum, entry) => sum - Number(entry.amount || 0), 0);
  let tallyClosingBalance = null;
  let balanceError = null;
  try {
    const rawTallyClosingBalance = await fetchLedgerClosingBalance(tallyUrl, {
      companyName,
      ledgerName: bankLedgerName,
      dateFrom,
      dateTo,
    });
    // Tally's internal amount sign is opposite to the bank statement view for
    // asset bank ledgers: debit balances are negative internally.
    tallyClosingBalance = Number.isFinite(rawTallyClosingBalance)
      ? -Number(rawTallyClosingBalance)
      : null;
  } catch (error) {
    balanceError = error instanceof Error ? error.message : String(error);
  }
  const derivedTallyOpeningBalance = Number.isFinite(tallyClosingBalance)
    ? Number(tallyClosingBalance) - tallyMovement
    : null;
  const balancesMatch = statementBalance.valid && Number.isFinite(tallyClosingBalance)
    ? Math.abs(statementBalance.openingBalance - derivedTallyOpeningBalance) < 0.01 &&
      Math.abs(statementBalance.closingBalance - Number(tallyClosingBalance)) < 0.01
    : null;

  return {
    success: true,
    result: {
      mode: "bank_statement_batch",
      dateFrom,
      dateTo,
      bankLedgerName,
      scannedCount: vouchers.length,
      transactions: results,
      balanceProof: {
        available: statementBalance.available && Number.isFinite(tallyClosingBalance),
        statementSequenceValid: statementBalance.valid,
        statementOpeningBalance: statementBalance.valid ? statementBalance.openingBalance : null,
        statementClosingBalance: statementBalance.valid ? statementBalance.closingBalance : null,
        statementMovement: statementBalance.valid ? statementBalance.movement : null,
        tallyOpeningBalance: derivedTallyOpeningBalance,
        tallyClosingBalance,
        tallyMovement,
        balancesMatch,
        warning: balanceError || (!statementBalance.valid ? statementBalance.reason : null),
      },
    },
  };
}

function scoreBankTransactionVoucher(voucher, payload) {
  const voucherDate = normalizeDateForCompare(voucher.effectiveDate || voucher.date);
  const expectedDate = normalizeDateForCompare(payload.voucherDate);
  const amount = Number(payload.amount ?? 0);
  const bankLedgerName = String(payload.bankLedgerName || "").trim();
  const counterpartyLedgerName = String(payload.counterpartyLedgerName || "").trim();
  const referenceNumber = String(payload.referenceNumber || "").trim();
  const text = voucherSearchText(voucher);
  const normalizedText = normalizedNeedle(text);
  const referenceHit =
    referenceNumber &&
    normalizedNeedle(referenceNumber).length >= 5 &&
    normalizedText.includes(normalizedNeedle(referenceNumber));
  const bankLedgerHit = voucherHasLedger(voucher, bankLedgerName);
  const bankAmountHit = voucherHasLedgerAmount(voucher, bankLedgerName, amount);
  const anyAmountHit = voucherHasAnyAmount(voucher, amount);
  const partyHit = counterpartyLedgerName
    ? voucherHasLedger(voucher, counterpartyLedgerName) ||
      normalizedText.includes(normalizedNeedle(counterpartyLedgerName))
    : false;
  const dateHit = Boolean(expectedDate && voucherDate === expectedDate);
  const expectedDirection = String(payload.expectedDirection || "").toLowerCase();
  const likelyPaymentType =
    expectedDirection === "incoming"
      ? /receipt|journal|contra/i.test(String(voucher.voucherType || ""))
      : /payment|journal|contra/i.test(String(voucher.voucherType || ""));

  let score = 0;
  if (dateHit) score += 45;
  if (bankAmountHit) score += 35;
  else if (bankLedgerHit && anyAmountHit) score += 25;
  else if (anyAmountHit) score += 15;
  if (referenceHit) score += 30;
  if (partyHit) score += 20;
  if (likelyPaymentType) score += 5;

  const reasons = [];
  if (dateHit) reasons.push("same date");
  if (bankAmountHit) reasons.push("same bank ledger and amount");
  else if (bankLedgerHit) reasons.push("same bank ledger");
  else if (anyAmountHit) reasons.push("same amount");
  if (referenceHit) reasons.push("same UTR/reference");
  if (partyHit) reasons.push("same party ledger");

  return {
    score,
    reasons,
    dateHit,
    bankAmountHit,
    anyAmountHit,
    referenceHit,
    partyHit,
  };
}

async function verifyBankTransactionInTally(config, commandPayload = {}) {
  if (Array.isArray(commandPayload.transactions)) {
    return reconcileBankTransactionsInTally(config, commandPayload);
  }
  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const amount = Number(commandPayload.amount ?? 0);
  const voucherDate = normalizeDateForCompare(commandPayload.voucherDate);
  const bankLedgerName = String(commandPayload.bankLedgerName || "").trim();

  if (!voucherDate) {
    throw new Error("Bank transaction verification requires a valid date.");
  }
  if (!bankLedgerName) {
    throw new Error("Bank transaction verification requires the bank ledger name.");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Bank transaction verification requires a positive amount.");
  }

  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Gajkesari Bank Payment Verification",
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,IsCancelled,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BankAllocations.Name,AllLedgerEntries.BankAllocations.InstrumentNumber,AllLedgerEntries.BankAllocations.TransactionName",
    companyName,
    dateFrom: voucherDate,
    dateTo: voucherDate,
  });
  const vouchers = parseVoucherCollection(xml).filter(
    (voucher) => !/^yes$/i.test(String(voucher.isCancelled || ""))
  );
  const strictResult = strictBankTransactionCandidates(
    vouchers,
    { ...commandPayload, voucherDate, amount },
    bankLedgerName,
    new Set()
  );
  const strictMatches = strictResult.candidates;
  const duplicateInTally = strictResult.hasUsableReference && strictMatches.length > 1;
  const verificationStatus = strictResult.identityInsufficient && strictMatches.length > 0
    ? "ambiguous"
    : strictMatches.length === 0
    ? "missing"
    : strictMatches.length === 1 || duplicateInTally
      ? "found"
      : "ambiguous";
  const selectedVoucher = verificationStatus === "found" ? strictMatches[0].voucher : null;

  return {
    success: true,
    result: {
      verificationStatus,
      scannedCount: vouchers.length,
      matchCount: strictMatches.length,
      duplicateInTally,
      duplicateVoucherCount: duplicateInTally ? strictMatches.length : 0,
      voucherId: selectedVoucher?.masterId || selectedVoucher?.voucherNumber || null,
      voucherNumber: selectedVoucher?.voucherNumber || null,
      voucherType: selectedVoucher?.voucherType || null,
      voucherDate: selectedVoucher
        ? normalizeDateForCompare(selectedVoucher.effectiveDate || selectedVoucher.date)
        : null,
      reason:
        duplicateInTally
          ? `${strictMatches.length} Tally vouchers have the same strict bank transaction reference. The bank row is already posted; review the duplicate Tally vouchers separately.`
          : verificationStatus === "found"
            ? "Found a unique strict match in Tally."
          : strictResult.identityInsufficient && verificationStatus === "ambiguous"
            ? "A same-date and same-amount voucher exists, but no usable bank reference or exact counterparty ledger proves it is this bank row. Review manually."
          : verificationStatus === "ambiguous"
            ? "More than one same-date and same-amount voucher matched, but no reliable bank reference identifies one transaction. Review manually."
            : !strictResult.hasUsableReference && strictResult.hasUsableCounterparty && strictResult.baseCandidateCount > 0
              ? "Date, amount and direction matched, but the exact selected counterparty ledger did not."
            : strictResult.hasUsableReference && strictResult.baseCandidateCount > 0
              ? "Date, amount and direction matched, but the exact UTR/reference did not."
              : "No matching Tally voucher found for this bank transaction.",
      matches: strictMatches.slice(0, 5).map(serializeStrictVoucherMatch),
    },
  };
}

function parseTallyAmount(value) {
  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/\s*(Dr|Cr)$/i, "")
    .trim();
  if (!cleaned) return null;
  const negative = cleaned.startsWith("-") || /^\(.*\)$/.test(cleaned);
  const normalized = cleaned.replace(/[()]/g, "").replace(/^-/, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function parseTallyDate(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw || null;
}

function billReferenceType(block) {
  return (
    getTagText(block, "BILLTYPE") ||
    getTagText(block, "TYPEOFREF") ||
    getTagText(block, "REFERENCE_TYPE") ||
    ""
  ).trim();
}

function billLedgerName(block) {
  return (
    getTagText(block, "LEDGERNAME") ||
    getTagText(block, "PARTYLEDGERNAME") ||
    getTagText(block, "PARENT") ||
    getTagText(block, "LEDGER") ||
    ""
  ).trim();
}

function normalizeLooseName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function uniquePayloadLedgerNames(commandPayload = {}) {
  const values = [
    ...(Array.isArray(commandPayload.ledgerNames) ? commandPayload.ledgerNames : []),
    commandPayload.ledgerName,
  ];
  const seen = new Set();
  const ledgerNames = [];

  for (const value of values) {
    const ledgerName = String(value || "").trim();
    const key = normalizeLooseName(ledgerName);
    if (!ledgerName || !key || seen.has(key)) continue;
    seen.add(key);
    ledgerNames.push(ledgerName);
  }

  return ledgerNames;
}

function emptyOpenBillBucket(ledgerName) {
  return {
    ledgerName,
    openBills: [],
    existingAdvances: [],
    rawCount: 0,
  };
}

function classifyOpenBillReferenceKind({
  billType,
  sourceVoucherType,
  referenceName,
  knownInvoice = false,
  knownAdvance = false,
} = {}) {
  const type = String(billType || "").toLowerCase();
  if (type.includes("advance")) return "advance";
  if (knownInvoice) return "bill";
  if (knownAdvance) return "advance";

  // Some Tally Bill collection exports omit BillType for receipt advances.
  // ADV-prefixed references are a controlled fallback only when no Sales
  // invoice with that reference was found.
  const looksLikeAdvanceReference = /^(?:adv|advance)(?:[-/\s]|\d)/i.test(String(referenceName || "").trim());
  if (looksLikeAdvanceReference && (/receipt/i.test(String(sourceVoucherType || "")) || !sourceVoucherType)) {
    return "advance";
  }
  return "bill";
}

export function parseLedgerClosingBalance(value) {
  const raw = String(value ?? "").trim();
  const parsed = parseTallyAmount(raw);
  if (parsed === null) return { amount: null, type: null, raw: null };
  const explicitType = raw.match(/\b(Dr|Cr)\s*$/i)?.[1];
  const type = explicitType
    ? explicitType.toLowerCase() === "dr" ? "Dr" : "Cr"
    : parsed < 0 ? "Dr" : parsed > 0 ? "Cr" : null;
  return {
    amount: Math.abs(parsed),
    type,
    raw,
  };
}

function toOpenBill(block, ledgerName, evidence = {}) {
  const referenceName = getAttribute(block, "NAME") || getTagText(block, "NAME") || getTagText(block, "BILLREF");
  if (!referenceName) return null;
  const rowLedgerName = billLedgerName(block);
  if (rowLedgerName && normalizeLooseName(rowLedgerName) !== normalizeLooseName(ledgerName)) return null;

  const closing =
    parseTallyAmount(getTagText(block, "CLOSINGBALANCE")) ??
    parseTallyAmount(getTagText(block, "BALANCE")) ??
    parseTallyAmount(getTagText(block, "PENDINGAMOUNT")) ??
    parseTallyAmount(getTagText(block, "AMOUNT"));
  const pendingAmount = Math.abs(closing ?? 0);
  if (pendingAmount <= 0) return null;

  const sourceVoucherType = getTagText(block, "VOUCHERTYPENAME") || getTagText(block, "VOUCHERTYPE") || null;
  const kind = classifyOpenBillReferenceKind({
    billType: billReferenceType(block),
    sourceVoucherType,
    referenceName,
    knownInvoice: evidence.knownInvoice === true,
    knownAdvance: evidence.knownAdvance === true,
  });
  const common = {
    referenceName,
    voucherNumber: getTagText(block, "VOUCHERNUMBER") || referenceName,
    invoiceDate: parseTallyDate(getTagText(block, "DATE") || getTagText(block, "BILLDATE")),
    dueDate: parseTallyDate(getTagText(block, "DUEDATE")),
    originalAmount: Math.abs(parseTallyAmount(getTagText(block, "OPENINGBALANCE")) ?? pendingAmount),
    settledAmount: null,
    pendingAmount,
    sourceVoucherType,
    status: "open",
  };

  if (kind === "advance") {
    return {
      kind: "advance",
      referenceName,
      receiptDate: common.invoiceDate,
      pendingAdvanceAmount: pendingAmount,
      status: "unadjusted",
    };
  }

  return { kind: "bill", ...common };
}

function openBillNarrationKey(ledgerName, referenceName) {
  return `${normalizeLooseName(ledgerName)}|${normalizeLooseName(referenceName)}`;
}

function isPartyInvoiceVoucher(block) {
  const voucherType = (getTagText(block, "VOUCHERTYPENAME") || getAttribute(block, "VCHTYPE") || "").toLowerCase();
  return /sales|purchase|invoice/.test(voucherType) && !/debit|credit|receipt|payment/.test(voucherType);
}

function isPartySettlementVoucher(block) {
  const voucherType = (getTagText(block, "VOUCHERTYPENAME") || getAttribute(block, "VCHTYPE") || "").toLowerCase();
  return /receipt|payment/.test(voucherType);
}

function voucherBillAllocations(entryBlock) {
  return extractBlocks(entryBlock, "BILLALLOCATIONS.LIST")
    .map((allocation) => {
      const referenceName = getTagText(allocation, "NAME");
      const amount = Math.abs(parseTallyAmount(getTagText(allocation, "AMOUNT")) ?? 0);
      return {
        referenceName,
        billType: getTagText(allocation, "BILLTYPE") || getTagText(allocation, "TYPEOFREF") || null,
        amount,
      };
    })
    .filter((allocation) => allocation.referenceName && allocation.amount > 0);
}

function voucherLedgerEntries(block) {
  return extractBlocks(block, "ALLLEDGERENTRIES.LIST")
    .map((entry) => {
      const rawAmount = parseTallyAmount(getTagText(entry, "AMOUNT")) ?? 0;
      const isDeemedPositive = /^yes$/i.test(getTagText(entry, "ISDEEMEDPOSITIVE"));
      return {
        ledgerName: getTagText(entry, "LEDGERNAME"),
        amount: Math.abs(rawAmount),
        // Tally marks debit entries as deemed-positive. The amount sign is a
        // useful fallback for companies whose export omits that flag.
        isDebit: isDeemedPositive || rawAmount < 0,
        billAllocations: voucherBillAllocations(entry),
      };
    })
    .filter((entry) => entry.ledgerName && entry.amount > 0);
}

function isLikelyTaxLedgerName(ledgerName) {
  return /(?:^|\s)(?:gst|cgst|sgst|igst|utgst|cess|tax)(?:\s|$)/i.test(String(ledgerName || ""));
}

function salesLedgerFromInvoiceVoucher(voucher, partyLedgerName) {
  const nonPartyEntries = voucherLedgerEntries(voucher).filter(
    (entry) => normalizeLooseName(entry.ledgerName) !== normalizeLooseName(partyLedgerName)
  );
  // A Sales voucher can contain output-tax ledgers as well. Prefer its first
  // non-tax credit ledger, which is the original Sales ledger in Tally's
  // accounting export.
  const salesEntry = nonPartyEntries.find((entry) => !entry.isDebit && !isLikelyTaxLedgerName(entry.ledgerName));
  return salesEntry?.ledgerName || null;
}

function indexInvoiceNarrations(xml, requestedLedgerByKey) {
  const narrationByBill = new Map();
  const invoiceReferencesByLedger = new Map();
  const invoiceReferenceKeys = new Set();
  const advanceReferenceKeys = new Set();
  const salesLedgerByBill = new Map();

  for (const voucher of extractBlocks(xml, "VOUCHER")) {
    if (!isPartyInvoiceVoucher(voucher)) continue;
    const narration = getTagText(voucher, "NARRATION");

    const ledgerNames = [
      getTagText(voucher, "PARTYLEDGERNAME"),
      ...extractBlocks(voucher, "ALLLEDGERENTRIES.LIST").map((entry) => getTagText(entry, "LEDGERNAME")),
    ].filter(Boolean);
    const billReferences = [
      getTagText(voucher, "VOUCHERNUMBER"),
      getTagText(voucher, "REFERENCE"),
      ...extractBlocks(voucher, "BILLALLOCATIONS.LIST").map((allocation) => getTagText(allocation, "NAME")),
    ].filter(Boolean);

    for (const ledgerName of ledgerNames) {
      const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(ledgerName));
      if (!requestedLedgerName) continue;
      const salesLedgerName = salesLedgerFromInvoiceVoucher(voucher, requestedLedgerName);
      for (const billReference of billReferences) {
        const key = openBillNarrationKey(requestedLedgerName, billReference);
        invoiceReferenceKeys.add(key);
        if (narration) narrationByBill.set(key, narration);
        if (salesLedgerName) salesLedgerByBill.set(key, salesLedgerName);
        const references = invoiceReferencesByLedger.get(requestedLedgerName) || new Set();
        references.add(billReference);
        invoiceReferencesByLedger.set(requestedLedgerName, references);
      }
    }
  }

  // A receipt's bill allocation is the strongest evidence that a payment was
  // applied to a particular invoice. Prefer it over narration/reference text,
  // which may be absent or may mention several invoices.
  const receiptEvidenceByBill = new Map();
  for (const voucher of extractBlocks(xml, "VOUCHER")) {
    if (!isPartySettlementVoucher(voucher)) continue;
    const receiptDate = parseTallyDate(getTagText(voucher, "EFFECTIVEDATE") || getTagText(voucher, "DATE"));
    if (!receiptDate) continue;
    const voucherText = [
      getTagText(voucher, "VOUCHERNUMBER"),
      getTagText(voucher, "REFERENCE"),
      getTagText(voucher, "NARRATION"),
    ].join(" ");
    const normalizedVoucherText = normalizeLooseName(voucherText);

    for (const entry of voucherLedgerEntries(voucher)) {
      const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(entry.ledgerName));
      if (!requestedLedgerName) continue;
      const references = invoiceReferencesByLedger.get(requestedLedgerName) || new Set();
      const referenceByKey = new Map(
        [...references].map((reference) => [normalizeLooseName(reference), reference])
      );
      let matchedAllocation = false;

      for (const allocation of entry.billAllocations) {
        const allocationKey = openBillNarrationKey(requestedLedgerName, allocation.referenceName);
        const allocationLooksLikeAdvance =
          /advance/i.test(String(allocation.billType || "")) ||
          (/^(?:adv|advance)(?:[-/\s]|\d)/i.test(allocation.referenceName) &&
            !invoiceReferenceKeys.has(allocationKey));
        if (allocationLooksLikeAdvance) advanceReferenceKeys.add(allocationKey);
        const invoiceReference = referenceByKey.get(normalizeLooseName(allocation.referenceName));
        if (!invoiceReference) continue;
        const key = openBillNarrationKey(requestedLedgerName, invoiceReference);
        const existing = receiptEvidenceByBill.get(key);
        receiptEvidenceByBill.set(key, {
          lastReceiptDate: !existing || receiptDate > existing.lastReceiptDate ? receiptDate : existing.lastReceiptDate,
          matchedReceiptAmount: (existing?.matchedReceiptAmount || 0) + allocation.amount,
        });
        matchedAllocation = true;
      }

      // Older Tally versions can omit allocation blocks from a collection
      // export. Preserve the explicit narration/reference fallback for that
      // case only; never add the full receipt to multiple invoice balances.
      if (matchedAllocation) continue;
      for (const invoiceReference of references) {
        const normalizedReference = normalizeLooseName(invoiceReference);
        if (normalizedReference.length < 8 || !normalizedVoucherText.includes(normalizedReference)) continue;
        const key = openBillNarrationKey(requestedLedgerName, invoiceReference);
        const existing = receiptEvidenceByBill.get(key);
        receiptEvidenceByBill.set(key, {
          lastReceiptDate: !existing || receiptDate > existing.lastReceiptDate ? receiptDate : existing.lastReceiptDate,
          matchedReceiptAmount: (existing?.matchedReceiptAmount || 0) + entry.amount,
        });
      }
    }
  }

  return {
    narrationByBill,
    receiptEvidenceByBill,
    salesLedgerByBill,
    invoiceReferenceKeys,
    advanceReferenceKeys,
  };
}

function chunkValues(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function openBillBlockRequiresVoucherFallback(block) {
  const referenceName = getAttribute(block, "NAME") || getTagText(block, "NAME") || getTagText(block, "BILLREF");
  if (!referenceName) return false;
  const hasReferenceType = Boolean(billReferenceType(block));
  const hasReliablePendingAmount = ["CLOSINGBALANCE", "BALANCE", "PENDINGAMOUNT"].some((tagName) => Boolean(getTagText(block, tagName)));
  return !hasReferenceType || !hasReliablePendingAmount;
}

function earliestBillDate(blocks) {
  const dates = blocks.map((block) => parseTallyDate(getTagText(block, "DATE") || getTagText(block, "BILLDATE"))).filter(Boolean).sort();
  return dates[0] || null;
}

async function exportTargetedOpenBillXml(tallyUrl, { companyName, ledgerNames, asOfDate, forceTargeted = false }, exportCollection = exportTallyCollection) {
  if (!forceTargeted && ledgerNames.length > OPEN_BILL_LEDGER_BATCH_SIZE) {
    const xml = await exportCollection(tallyUrl, {
      collectionName: "Gajkesari Customer Open Bills", tallyType: "Bill",
      fetchFields: "Name,Parent,LedgerName,PartyLedgerName,BillType,TypeOfRef,Date,BillDate,DueDate,VoucherNumber,VoucherTypeName,OpeningBalance,ClosingBalance,Balance,PendingAmount,Amount",
      companyName, dateTo: asOfDate,
    });
    return { xml, batchCount: 1, queryMode: "full" };
  }
  const batches = chunkValues(ledgerNames, OPEN_BILL_LEDGER_BATCH_SIZE);
  const responses = [];
  for (const [index, batch] of batches.entries()) {
    const ledgerFilterName = "GajkesariRequestedBillLedger";
    responses.push(await exportCollection(tallyUrl, {
      collectionName: `Gajkesari Customer Open Bills ${index + 1}`, tallyType: "Bill",
      fetchFields: "Name,Parent,LedgerName,PartyLedgerName,BillType,TypeOfRef,Date,BillDate,DueDate,VoucherNumber,VoucherTypeName,OpeningBalance,ClosingBalance,Balance,PendingAmount,Amount",
      companyName, dateTo: asOfDate,
      formulae: [{ name: ledgerFilterName, formula: buildRequestedLedgerFormula(batch, ["$LedgerName", "$PartyLedgerName", "$Parent"]) }],
      filterNames: [ledgerFilterName],
    }));
  }
  return { xml: responses.join("\n"), batchCount: batches.length, queryMode: "targeted" };
}

async function exportTargetedBillEvidenceXml(tallyUrl, { companyName, ledgerNames, dateFrom, dateTo }, exportCollection = exportTallyCollection) {
  const batches = chunkValues(ledgerNames, OPEN_BILL_LEDGER_BATCH_SIZE);
  const responses = [];
  for (const [index, batch] of batches.entries()) {
    const ledgerEntryFilterName = "GajkesariRequestedPartyEntry";
    const ledgerVoucherFilterName = "GajkesariRequestedPartyVoucher";
    responses.push(await exportCollection(tallyUrl, {
      collectionName: `Gajkesari Customer Bill Evidence ${index + 1}`, tallyType: "Voucher",
      fetchFields: "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount",
      companyName, dateFrom, dateTo,
      formulae: [
        { name: ledgerEntryFilterName, formula: buildRequestedLedgerFormula(batch, ["$LedgerName"]) },
        { name: ledgerVoucherFilterName, formula: `$$FilterCount:AllLedgerEntries:${ledgerEntryFilterName} > 0` },
      ],
      filterNames: [ledgerVoucherFilterName],
    }));
  }
  return { xml: responses.join("\n"), batchCount: batches.length };
}

async function fetchCustomerOpenBillsFromTally(config, commandPayload = {}, dependencies = {}) {
  const ledgerNames = uniquePayloadLedgerNames(commandPayload);
  if (ledgerNames.length === 0) {
    throw new Error("Party open bill fetch requires ledgerName.");
  }
  const requestedLedgerByKey = new Map(ledgerNames.map((ledgerName) => [normalizeLooseName(ledgerName), ledgerName]));

  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const asOfDate = normalizeDateForCompare(commandPayload.asOfDate || commandPayload.dateTo) || null;
  const requestedDateFrom = normalizeDateForCompare(commandPayload.dateFrom) || null;
  const forceTargeted =
    commandPayload.queryPurpose === "bank_statement_match" && ledgerNames.length <= OPEN_BILL_LEDGER_BATCH_SIZE;
  const exportCollection = dependencies.exportCollection || exportTallyCollection;
  // Tally's local HTTP listener processes reports serially. Concurrent large
  // collection exports can leave one request waiting indefinitely, which
  // previously locked the whole connector cycle and surfaced as a dashboard
  // refresh timeout.
  const billExport = dependencies.billExport || await exportTargetedOpenBillXml(
    tallyUrl,
    { companyName, ledgerNames, dateFrom: requestedDateFrom, asOfDate, forceTargeted },
    exportCollection
  );
  const billBlocks = extractBlocks(billExport.xml, "BILL").filter((block) =>
    requestedLedgerByKey.has(normalizeLooseName(billLedgerName(block)))
  );
  const fallbackBlocks = billBlocks.filter(openBillBlockRequiresVoucherFallback);
  const fallbackLedgerNames = Array.from(new Set(fallbackBlocks.flatMap((block) => {
    const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(billLedgerName(block)));
    return requestedLedgerName ? [requestedLedgerName] : [];
  })));
  // Cash Discount calculation always needs invoice narration and receipt
  // allocation evidence. For other consumers, retain the narrower structural
  // fallback behaviour.
  const evidenceLedgerNames = dependencies.forceVoucherEvidence && billBlocks.length > 0
    ? ledgerNames
    : fallbackLedgerNames;
  const evidenceDateFrom =
    requestedDateFrom ||
    earliestBillDate(dependencies.forceVoucherEvidence ? billBlocks : fallbackBlocks);
  const voucherExport = dependencies.voucherExport || (evidenceLedgerNames.length > 0
    ? dependencies.forceVoucherEvidence
      ? await exportCompactCashDiscountEvidenceXml(
          tallyUrl,
          {
            companyName,
            dateFrom: evidenceDateFrom,
            dateTo: asOfDate,
          },
          exportCollection
        )
      : await exportTargetedBillEvidenceXml(
          tallyUrl,
          {
            companyName,
            ledgerNames: evidenceLedgerNames,
            dateFrom: evidenceDateFrom,
            dateTo: asOfDate,
          },
          exportCollection
        )
    : { xml: "", batchCount: 0 });
  const {
    narrationByBill,
    receiptEvidenceByBill,
    salesLedgerByBill,
    invoiceReferenceKeys,
    advanceReferenceKeys,
  } = indexInvoiceNarrations(voucherExport.xml, requestedLedgerByKey);
  const byLedger = Object.fromEntries(ledgerNames.map((ledgerName) => [ledgerName, emptyOpenBillBucket(ledgerName)]));

  for (const block of billBlocks) {
    const rowLedgerName = billLedgerName(block);
    const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(rowLedgerName));
    if (!requestedLedgerName) continue;

    const referenceName = getAttribute(block, "NAME") || getTagText(block, "NAME") || getTagText(block, "BILLREF");
    const referenceKey = openBillNarrationKey(requestedLedgerName, referenceName);
    const entry = toOpenBill(block, requestedLedgerName, {
      knownInvoice: invoiceReferenceKeys.has(referenceKey),
      knownAdvance: advanceReferenceKeys.has(referenceKey),
    });
    if (!entry) continue;

    if (entry.kind === "bill") {
      entry.narration =
        narrationByBill.get(openBillNarrationKey(requestedLedgerName, entry.referenceName)) ||
        narrationByBill.get(openBillNarrationKey(requestedLedgerName, entry.voucherNumber)) ||
        null;
      entry.sourceSalesLedgerName =
        salesLedgerByBill.get(openBillNarrationKey(requestedLedgerName, entry.referenceName)) ||
        salesLedgerByBill.get(openBillNarrationKey(requestedLedgerName, entry.voucherNumber)) ||
        null;
      const receiptEvidence =
        receiptEvidenceByBill.get(openBillNarrationKey(requestedLedgerName, entry.referenceName)) ||
        receiptEvidenceByBill.get(openBillNarrationKey(requestedLedgerName, entry.voucherNumber)) ||
        null;
      entry.receiptDate = receiptEvidence?.lastReceiptDate || null;
      entry.matchedReceiptAmount = receiptEvidence?.matchedReceiptAmount || null;
      if (receiptEvidence && entry.originalAmount > 0) {
        const settledAmount = Math.min(entry.originalAmount, Math.max(0, receiptEvidence.matchedReceiptAmount));
        entry.settledAmount = settledAmount;
        // Some Tally releases expose a Bill collection's original balance even
        // after a receipt has been allocated. The allocation in the Receipt
        // voucher is definitive, so derive the remaining balance from it.
        entry.pendingAmount = Math.max(0, Number((entry.originalAmount - settledAmount).toFixed(2)));
      }
    }

    if (entry.kind === "bill" && entry.pendingAmount <= 0.01) continue;

    const { kind, ...openBillEntry } = entry;
    const bucket = byLedger[requestedLedgerName] || emptyOpenBillBucket(requestedLedgerName);
    bucket.rawCount += 1;
    if (kind === "advance") {
      bucket.existingAdvances.push(openBillEntry);
    } else {
      bucket.openBills.push(openBillEntry);
    }
    byLedger[requestedLedgerName] = bucket;
  }

  const firstLedgerName = ledgerNames[0];
  const firstLedgerBucket = byLedger[firstLedgerName] || emptyOpenBillBucket(firstLedgerName);

  return {
    success: true,
    result: {
      ledgerName: firstLedgerName,
      ledgerNames,
      byLedger,
      openBills: firstLedgerBucket.openBills,
      existingAdvances: firstLedgerBucket.existingAdvances,
      rawCount: Object.values(byLedger).reduce((total, bucket) => total + bucket.rawCount, 0),
      queryDiagnostics: {
        requestedLedgerCount: ledgerNames.length,
        billBatchCount: billExport.batchCount,
        billQueryMode: billExport.queryMode,
        billObjectCount: billBlocks.length,
        voucherFallbackUsed: evidenceLedgerNames.length > 0,
        voucherFallbackLedgerCount: evidenceLedgerNames.length,
        voucherEvidenceMode: dependencies.forceVoucherEvidence ? "required" : "fallback",
        voucherBatchCount: voucherExport.batchCount,
        voucherQueryMode: voucherExport.queryMode || "targeted_chunks",
        voucherDateChunkCount: voucherExport.dateChunkCount ?? 0,
        voucherRetrySplitCount: voucherExport.retrySplitCount ?? 0,
        asOfDate,
      },
    },
  };
}

function toBankStatementLiveMaster(master, type) {
  const billWiseEnabled = master?.raw?.billWiseEnabled;
  return {
    name: master.name,
    guid: master.guid || null,
    parent: master.parent || null,
    type,
    ...(type === "ledger" ? {
      billWiseEnabled: typeof billWiseEnabled === "boolean" ? billWiseEnabled : null,
      bankName: master.bankName || null,
      bankAccountNumber: master.bankAccountNumber || null,
      ifscCode: master.ifscCode || null,
      accountHolderName: master.accountHolderName || null,
      closingBalance: master.closingBalance ?? null,
      closingBalanceType: master.closingBalanceType ?? null,
    } : {}),
  };
}

function taxLedgerIdentity(master) {
  const name = master.name || "";
  const raw = master.raw || {};
  const dutyHead = String(raw.gstDutyHead || "");
  const taxType = String(raw.taxType || "");

  return `${name} ${dutyHead} ${taxType}`;
}

function isGstLedger(master) {
  return /\b(gst|cgst|sgst|igst|cess|central\s+tax|state\s+tax|integrated\s+tax)\b/i.test(
    taxLedgerIdentity(master)
  );
}

function isWithholdingTaxLedger(master) {
  return /\b(tds|tcs|tax\s+deducted|tax\s+collected)\b/i.test(
    taxLedgerIdentity(master)
  );
}

function classifyTaxLedgers(ledgers) {
  return {
    gstLedgers: dedupeMasters(ledgers.filter(isGstLedger)),
    taxLedgers: dedupeMasters(ledgers.filter(isWithholdingTaxLedger)),
  };
}

function gstStateCodeFromName(value) {
  const key = normalizeLooseName(value);
  if (!key) return null;
  const codes = new Map([
    ["jammu and kashmir", "01"], ["himachal pradesh", "02"], ["punjab", "03"],
    ["chandigarh", "04"], ["uttarakhand", "05"], ["haryana", "06"], ["delhi", "07"],
    ["rajasthan", "08"], ["uttar pradesh", "09"], ["bihar", "10"], ["sikkim", "11"],
    ["arunachal pradesh", "12"], ["nagaland", "13"], ["manipur", "14"], ["mizoram", "15"],
    ["tripura", "16"], ["meghalaya", "17"], ["assam", "18"], ["west bengal", "19"],
    ["jharkhand", "20"], ["odisha", "21"], ["chhattisgarh", "22"], ["madhya pradesh", "23"],
    ["gujarat", "24"], ["dadra and nagar haveli and daman and diu", "26"],
    ["maharashtra", "27"], ["karnataka", "29"], ["goa", "30"], ["lakshadweep", "31"],
    ["kerala", "32"], ["tamil nadu", "33"], ["puducherry", "34"],
    ["andaman and nicobar islands", "35"], ["telangana", "36"], ["andhra pradesh", "37"],
    ["ladakh", "38"], ["other territory", "97"],
  ].map(([name, code]) => [normalizeLooseName(name), code]));
  return codes.get(key) || null;
}

function toBankLedgerPayload(master) {
  return {
    name: master.name,
    parent: master.parent || "Bank Accounts",
    guid: master.guid || null,
    bankName: master.bankName || null,
    bankAccountNumber: master.bankAccountNumber || null,
    ifscCode: master.ifscCode || null,
    branchName: master.branchName || null,
    accountHolderName: master.accountHolderName || null,
    closingBalance: Number.isFinite(master.closingBalance) ? master.closingBalance : null,
    closingBalanceType: master.closingBalanceType || null,
  };
}

function findBankLedgersFromMasters(ledgers, groups) {
  const groupParentByName = new Map(
    groups
      .filter((group) => group?.name)
      .map((group) => [normalizeLooseName(group.name), group.parent || null])
  );

  const descendsFromBankAccounts = (parentName) => {
    const visited = new Set();
    let currentName = parentName;

    while (currentName) {
      const normalized = normalizeLooseName(currentName);
      if (!normalized || visited.has(normalized)) return false;
      if (normalized === normalizeLooseName("Bank Accounts")) return true;
      visited.add(normalized);
      currentName = groupParentByName.get(normalized) || null;
    }

    return false;
  };

  return ledgers.filter((ledger) => {
    const hasBankIdentity = Boolean(
      ledger.bankName ||
      ledger.bankAccountNumber ||
      ledger.ifscCode ||
      ledger.branchName ||
      ledger.accountHolderName
    );
    return hasBankIdentity || descendsFromBankAccounts(ledger.parent);
  });
}

async function fetchBankLedgersFromTally(config, commandPayload = {}) {
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const companyNames = mergeCompanyNames([
    ...(Array.isArray(commandPayload.companyNames) ? commandPayload.companyNames : []),
    commandPayload.companyName,
  ]);
  const targets = companyNames.length > 0 ? companyNames : [null];
  const byCompany = {};
  const errors = [];

  for (const companyName of targets) {
    const key = companyName || "Current company";
    try {
      const [ledgerXml, groupXml] = await Promise.all([
        exportTallyCollection(tallyUrl, {
          collectionName: "Gajkesari Bank Ledger Discovery",
          tallyType: "Ledger",
          fetchFields:
            "Name,Parent,GUID,ClosingBalance,BankName,Bank,BankerName,BankAccountNumber,AccountNumber,BankAccountNo,BankAcNo,AcNumber,IFSCCODE,IFSCODE,IFSC,BankIFSCCODE,BranchName,BankBranchName,Branch,BankAccHolderName,BankAccountName,BankAccountHolderName,AccountHolderName",
          companyName,
        }),
        exportTallyCollection(tallyUrl, {
          collectionName: "Gajkesari Bank Group Discovery",
          tallyType: "Group",
          fetchFields: "Name,Parent,GUID",
          companyName,
        }),
      ]);
      const ledgers = parseMasterCollection(ledgerXml, "LEDGER");
      const groups = parseMasterCollection(groupXml, "GROUP");
      byCompany[key] = findBankLedgersFromMasters(ledgers, groups)
        .map(toBankLedgerPayload);
    } catch (error) {
      errors.push({
        companyName: key,
        error: error instanceof Error ? error.message : String(error ?? "Could not fetch bank ledgers."),
      });
      byCompany[key] = [];
    }
  }

  if (Object.values(byCompany).every((ledgers) => !Array.isArray(ledgers) || ledgers.length === 0) && errors.length === targets.length) {
    throw new Error(errors[0]?.error || "Could not fetch bank ledgers from Tally.");
  }

  const firstCompanyName = targets[0] || "Current company";

  return {
    success: true,
    result: {
      source: "tally_bank_accounts_group",
      companyName: firstCompanyName,
      companyNames: targets.filter(Boolean),
      bankLedgers: byCompany[firstCompanyName] || [],
      byCompany,
      errors,
    },
  };
}

async function collectTallyMasters(config, commandPayload = {}) {
  const timings = {};
  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const fieldProfile = String(commandPayload.fieldProfile || "").trim();
  const requestedMasterTypes = new Set(
    Array.isArray(commandPayload.requestedMasterTypes)
      ? commandPayload.requestedMasterTypes.map((value) => String(value || "").trim())
      : []
  );
  const shouldFetch = (type) => {
    if (requestedMasterTypes.size === 0 || requestedMasterTypes.has(type)) return true;
    // GST/tax master rows are classified from Ledger exports, not a separate
    // Tally collection.
    return type === "ledger" && (requestedMasterTypes.has("gst_ledger") || requestedMasterTypes.has("tax_ledger"));
  };
  const fetches = [];
  const fetchMaster = (key, type, collectionName, fetchFields) => {
    if (!shouldFetch(type)) return;
    fetches.push([key, () => exportTallyCollection(tallyUrl, {
      collectionName,
      tallyType: type === "stock_item" ? "StockItem" : type === "voucher_type" ? "VoucherType" : type[0].toUpperCase() + type.slice(1),
      fetchFields,
      companyName,
    })]);
  };
  const ledgerFetchFields = fieldProfile === "bank_statement"
    ? "Name,Parent,GUID,IsBillWiseOn"
    : "Name,Parent,GUID,ClosingBalance,PartyGSTIN,IsBillWiseOn,BankName,Bank,BankerName,BankAccountNumber,AccountNumber,BankAccountNo,BankAcNo,AcNumber,IFSCCODE,IFSCODE,IFSC,BankIFSCCODE,BranchName,BankBranchName,Branch,BankAccHolderName,BankAccountName,BankAccountHolderName,AccountHolderName,Email,EmailId,LedgerEmail,LedgerEmailId,LedgerMobile,Mobile,MobileNo,PhoneNumber,Phone,LedgerPhone,ContactPerson,Contact,AttentionTo,Address,Address1,Address2,Address3,Address4,Pincode,TaxType,GSTDutyHead,RateOfTaxCalculation";
  fetchMaster("ledgerXml", "ledger", "Gajkesari Ledgers Sync", ledgerFetchFields);
  fetchMaster("groupXml", "group", "Gajkesari Groups Sync", "Name,Parent,GUID");
  fetchMaster("stockItemXml", "stock_item", "Gajkesari Stock Items Sync",
    "Name,Parent,GUID,BaseUnits,OriginalBaseUnits,GSTHSNCode,HSNCode,GSTTaxRate,RateOfTaxCalculation,IsGSTApplicable");
  fetchMaster("unitXml", "unit", "Gajkesari Units Sync", "Name,GUID,OriginalName,DecimalPlaces,IsSimpleUnit");
  fetchMaster("voucherTypeXml", "voucher_type", "Gajkesari Voucher Types Sync", "Name,Parent,GUID");
  if (shouldFetch("ledger") && fieldProfile !== "bank_statement") {
    fetches.push(["companyXml", () => exportTallyCollection(tallyUrl, {
      collectionName: "Gajkesari Company Profile Sync",
      tallyType: "Company",
      fetchFields: "Name,GUID,PartyGSTIN,GSTIN,GSTRegistrationNumber,GSTRegNumber,StateName,State,CountryName,Country,IsGSTOn,GSTRegistrationDetails.*",
      companyName,
    }).catch(() => "")]);
  }
  let resolved;
  if (fieldProfile === "bank_statement") {
    resolved = {};
    for (const [key, request] of fetches) {
      const startedAt = Date.now();
      resolved[key] = await request();
      timings[`${key}ExportMs`] = Date.now() - startedAt;
    }
  } else {
    resolved = Object.fromEntries(await Promise.all(fetches.map(async ([key, request]) => [key, await request()])));
  }
  const ledgerXml = resolved.ledgerXml || "";
  const groupXml = resolved.groupXml || "";
  const stockItemXml = resolved.stockItemXml || "";
  const unitXml = resolved.unitXml || "";
  const voucherTypeXml = resolved.voucherTypeXml || "";
  const companyXml = resolved.companyXml || "";

  const parseStartedAt = Date.now();
  let ledgers = fieldProfile === "bank_statement"
    ? parseBankStatementMasterCollection(ledgerXml, "LEDGER")
    : parseMasterCollection(ledgerXml, "LEDGER");
  const groups = fieldProfile === "bank_statement"
    ? parseBankStatementMasterCollection(groupXml, "GROUP")
    : parseMasterCollection(groupXml, "GROUP");
  timings.parseMs = Date.now() - parseStartedAt;

  if (fieldProfile === "bank_statement" && shouldFetch("ledger")) {
    const groupParentByName = new Map(
      groups.map((item) => [normalizeLooseName(item.name), item.parent || null])
    );
    const descendsFrom = (parentName, targetGroupName) => {
      const target = normalizeLooseName(targetGroupName);
      const visited = new Set();
      let current = parentName;
      while (current) {
        const normalized = normalizeLooseName(current);
        if (!normalized || visited.has(normalized)) return false;
        if (normalized === target) return true;
        visited.add(normalized);
        current = groupParentByName.get(normalized) || null;
      }
      return false;
    };
    const bankLedgerNames = ledgers
      .filter((ledger) =>
        descendsFrom(ledger.parent, "Bank Accounts") || descendsFrom(ledger.parent, "Bank OD A/c")
      )
      .map((ledger) => ledger.name);

    if (bankLedgerNames.length > 0) {
      const detailStartedAt = Date.now();
      const filterName = "GajkesariBankStatementLedgerFilter";
      const bankXml = await exportTallyCollection(tallyUrl, {
        collectionName: "Gajkesari Bank Statement Ledger Details",
        tallyType: "Ledger",
        fetchFields: "Name,Parent,GUID,ClosingBalance,IsBillWiseOn,BankName,Bank,BankerName,BankAccountNumber,AccountNumber,BankAccountNo,BankAcNo,AcNumber,IFSCCODE,IFSCODE,IFSC,BankIFSCCODE,BankAccHolderName,BankAccountName,BankAccountHolderName,AccountHolderName",
        companyName,
        formulae: [{ name: filterName, formula: buildRequestedLedgerFormula(bankLedgerNames, ["$Name"]) }],
        filterNames: [filterName],
      });
      timings.bankDetailExportMs = Date.now() - detailStartedAt;
      const detailParseStartedAt = Date.now();
      const detailsByName = new Map(
        parseBankStatementMasterCollection(bankXml, "LEDGER", { bankDetails: true })
          .map((master) => [normalizeLooseName(master.name), master])
      );
      ledgers = ledgers.map((ledger) => ({
        ...ledger,
        ...(detailsByName.get(normalizeLooseName(ledger.name)) || {}),
      }));
      timings.bankDetailParseMs = Date.now() - detailParseStartedAt;
    }
  }
  const stockItems = parseMasterCollection(stockItemXml, "STOCKITEM");
  const units = parseMasterCollection(unitXml, "UNIT");
  const voucherTypes = parseMasterCollection(voucherTypeXml, "VOUCHERTYPE");
  const companies = parseMasterCollection(companyXml, "COMPANY");
  const activeCompany = companies.find(
    (company) => normalizeLooseName(company.name) === normalizeLooseName(companyName)
  ) || companies[0] || null;
  const companyGstin = activeCompany?.gstin || null;
  const companyStateCode =
    String(companyGstin || "").match(/^\d{2}/)?.[0] ||
    gstStateCodeFromName(activeCompany?.raw?.stateName) ||
    null;
  const { gstLedgers, taxLedgers } = classifyTaxLedgers(ledgers);

  return {
    // Keep the requested scope with the result. syncMastersFromTally uses this
    // to avoid sending omitted master types as empty arrays, which would retire
    // a previously-good snapshot for those types on the API.
    requestedMasterTypes: Array.from(requestedMasterTypes),
    timings,
    ledgers,
    groups,
    stockItems,
    units,
    voucherTypes,
    gstLedgers,
    taxLedgers,
    companyProfile: activeCompany ? {
      name: activeCompany.name,
      guid: activeCompany.guid || null,
      gstin: companyGstin,
      stateCode: companyStateCode,
      stateName: activeCompany.raw?.stateName || null,
      countryName: activeCompany.raw?.countryName || null,
    } : {},
  };
}

async function postMastersToBackend(config, payload) {
  const response = await fetch(`${config.apiBase}/api/tally/bridge/masters`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.bridgeToken}`,
    },
    body: JSON.stringify(payload),
  });
  const result = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(result.error || `Master sync upload failed with HTTP ${response.status}.`);
  }

  return result;
}

async function syncMastersFromTally(config, commandPayload = {}) {
  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const readiness = await testTally(tallyUrl);

  if (!readiness.tallyReachable) {
    throw new Error(readiness.error || "Tally Prime is not reachable.");
  }

  if (!readiness.companyLoaded) {
    throw new Error(readiness.error || "Tally Prime is reachable, but no company is loaded.");
  }

  const resolvedCompanyName = companyName || readiness.companyName || null;

  const requestedMasterTypes = new Set(
    Array.isArray(commandPayload.requestedMasterTypes)
      ? commandPayload.requestedMasterTypes.map((value) => String(value || "").trim())
      : []
  );
  const masters = await collectTallyMasters(
    {
      ...config,
      tallyUrl,
      companyName: resolvedCompanyName,
    },
    {
      ...commandPayload,
      companyName: commandPayload.companyName || resolvedCompanyName,
    }
  );

  const isFullMasterSync = masters.requestedMasterTypes.length === 0;
  const requestedTypes = new Set(masters.requestedMasterTypes);
  if ((isFullMasterSync || requestedTypes.has("ledger")) && masters.ledgers.length === 0) {
    throw new Error("Tally returned zero ledgers. Open the correct company and try sync again.");
  }

  const masterPayload = {};
  if (isFullMasterSync || requestedTypes.has("ledger")) {
    masterPayload.ledgers = masters.ledgers;
  }
  if (isFullMasterSync || requestedTypes.has("group")) {
    masterPayload.groups = masters.groups;
  }
  if (isFullMasterSync || requestedTypes.has("stock_item")) {
    masterPayload.stockItems = masters.stockItems;
  }
  if (isFullMasterSync || requestedTypes.has("unit")) {
    masterPayload.units = masters.units;
  }
  if (isFullMasterSync || requestedTypes.has("voucher_type")) {
    masterPayload.voucherTypes = masters.voucherTypes;
  }
  // GST and tax ledgers are derived from the Ledger collection. They remain
  // opt-in so a Bank Statements refresh writes only its ledger/group scope.
  if (isFullMasterSync || requestedTypes.has("gst_ledger")) {
    masterPayload.gstLedgers = masters.gstLedgers;
  }
  if (isFullMasterSync || requestedTypes.has("tax_ledger")) {
    masterPayload.taxLedgers = masters.taxLedgers;
  }

  const payload = {
    connectionId: config.connectionId,
    companyName: resolvedCompanyName,
    bridgeVersion: BRIDGE_VERSION,
    masters: masterPayload,
    companyProfile: masters.companyProfile,
  };
  const syncResult = await postMastersToBackend(config, payload);

  return {
    success: true,
    result: {
      syncRunId: syncResult.syncRunId,
      totals: syncResult.totals,
      accepted: syncResult.accepted,
      companyName: payload.companyName,
      bridgeVersion: payload.bridgeVersion,
    },
  };
}

async function testTally(tallyUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TALLY_IMPORT_TIMEOUT_MS);
  try {
    const response = await fetch(tallyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
      },
      // Readiness must always inspect the current Tally session. Supplying
      // SVCURRENTCOMPANY here would test a remembered/requested company and
      // could falsely report it as the active UI company.
      body: buildTallyReadinessXml(null),
      signal: controller.signal,
    });

    const text = await response.text();
    const looksLikeXml = /<\?xml|<ENVELOPE|<RESPONSE|<LISTOF/i.test(text);
    const lineError = text.match(/<LINEERROR[^>]*>([\s\S]*?)<\/LINEERROR>/i)?.[1]?.trim() ?? null;
    const status = text.match(/<STATUS[^>]*>([^<]+)<\/STATUS>/i)?.[1]?.trim() ?? null;

    if (!response.ok) {
      return {
        tallyReachable: false,
        companyLoaded: false,
        companyName: null,
        error: `Tally returned HTTP ${response.status}.`,
      };
    }

    if (!looksLikeXml) {
      return {
        tallyReachable: true,
        companyLoaded: false,
        companyName: null,
        error: "Tally responded, but the response was not XML.",
      };
    }

    const possibleCompanyLoaded = !lineError && status === "1";
    const activeCompanyName = possibleCompanyLoaded
      ? await fetchActiveCompanyName(normalizeTallyUrl(tallyUrl))
      : null;
    // The readiness collection can contain ledgers from the first loaded
    // company in a multi-company Tally session. It is not proof that this is
    // the UI-active company. Only $$CurrentCompany is authoritative.
    const companyLoaded = possibleCompanyLoaded && Boolean(activeCompanyName);

    return {
      tallyReachable: true,
      companyLoaded,
      companyName: companyLoaded ? activeCompanyName : null,
      error:
        lineError ??
        (possibleCompanyLoaded && !activeCompanyName
          ? "Tally responded but did not identify the active company."
          : null),
    };
  } catch (error) {
    return {
      tallyReachable: false,
      companyLoaded: false,
      companyName: null,
      error: formatTallyConnectivityError(tallyUrl, error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function receiveNextCommands(config, limit = MAX_COMMANDS_PER_CYCLE) {
  const url = new URL(`${config.apiBase}/api/tally/bridge/commands/next`);
  url.searchParams.set("connectionId", config.connectionId);
  url.searchParams.set("bridgeVersion", BRIDGE_VERSION);
  url.searchParams.set("limit", String(Math.max(1, Math.min(MAX_COMMANDS_PER_CYCLE, limit))));

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.bridgeToken}`,
    },
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(payload.error || `Command poll failed with HTTP ${response.status}.`);
  }

  if (Array.isArray(payload.commands)) return payload.commands;
  return payload.command ? [payload.command] : [];
}

async function sendCommandResults(config, entries, concurrency = 10) {
  for (let index = 0; index < entries.length; index += concurrency) {
    await Promise.all(
      entries
        .slice(index, index + concurrency)
        .map(({ command, outcome }) => sendCommandResult(config, command, outcome))
    );
  }
}

async function sendCommandResult(config, command, outcome) {
  const status = outcome.success ? "succeeded" : "failed";
  const error = outcome.error ?? null;
  console.log(`Reporting command ${command.id} as ${status}${error ? `: ${error}` : ""}`);

  const response = await fetch(`${config.apiBase}/api/tally/bridge/commands/${command.id}/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.bridgeToken}`,
    },
    body: JSON.stringify({
      connectionId: config.connectionId,
      status,
      success: outcome.success,
      result: outcome.result ?? {},
      error,
    }),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(payload.error || `Command result failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function safeDocumentPathSegment(value, fallback) {
  const sanitized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[.\s]+$/g, "")
    .slice(0, 100);
  return sanitized || fallback;
}

async function materializePurchaseSourceDocument(payload) {
  const source = payload?.sourceDocument;
  if (!source || typeof source !== "object") {
    return payload;
  }

  const downloadUrl = String(source.downloadUrl || "").trim();
  const documentId = safeDocumentPathSegment(source.id, "source-document");
  const companyName = safeDocumentPathSegment(payload?.companyName, "Tally company");
  const originalName = safeDocumentPathSegment(source.name, "source-invoice.pdf");
  const fileName = /\.pdf$/i.test(originalName) ? originalName : `${originalName}.pdf`;
  if (!/^https?:\/\//i.test(downloadUrl)) {
    throw new Error("Purchase source document does not have a valid download URL.");
  }

  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`Purchase source document download failed with HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_PURCHASE_SOURCE_PDF_BYTES) {
    throw new Error("Purchase source PDF is larger than the 25 MB connector limit.");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_PURCHASE_SOURCE_PDF_BYTES) {
    throw new Error("Purchase source PDF is empty or larger than the 25 MB connector limit.");
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Purchase source document is not a valid PDF.");
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const documentDir = path.join(
    CONFIG_DIR,
    "documents",
    companyName,
    "Purchase",
    documentId
  );
  const documentPath = path.join(documentDir, fileName);
  fs.mkdirSync(documentDir, { recursive: true });

  const existingSha256 = fs.existsSync(documentPath)
    ? createHash("sha256").update(fs.readFileSync(documentPath)).digest("hex").toUpperCase()
    : null;
  if (existingSha256 !== sha256) {
    const temporaryPath = `${documentPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, bytes, { mode: 0o600 });
    fs.rmSync(documentPath, { force: true });
    fs.renameSync(temporaryPath, documentPath);
  }

  return {
    ...payload,
    sourceDocumentPath: documentPath,
    sourceDocumentName: fileName,
    sourceDocumentSha256: sha256,
    sourceDocumentId: String(source.id || documentId).trim() || documentId,
  };
}

async function runCommand(config, command, options = {}) {
  if (!command) return;

  if (command.commandType === "sync_masters") {
    try {
      const outcome = await syncMastersFromTally(config, command.payload);
      await sendCommandResult(config, command, outcome);
      const totals = outcome.result?.totals || {};
      console.log(
        `Command ${command.id} completed: synced ledgers=${totals.ledger ?? 0}, gstLedgers=${totals.gst_ledger ?? 0}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Master sync failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {},
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "fetch_bank_ledgers") {
    try {
      const outcome = await fetchBankLedgersFromTally(config, command.payload);
      await sendCommandResult(config, command, outcome);
      const count = Object.values(outcome.result?.byCompany || {}).reduce(
        (total, ledgers) => total + (Array.isArray(ledgers) ? ledgers.length : 0),
        0
      );
      console.log(`Command ${command.id} completed: fetched ${count} bank ledger(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Bank ledger fetch failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {},
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "alter_ledger") {
    const xml = buildAlterLedgerXml(command.payload, command.payload?.companyName || null);
    const outcome = await invokeTallyXml(config.tallyUrl, xml);
    await sendCommandResult(config, command, outcome);
    console.log(
      outcome.success
        ? `Command ${command.id} completed: ledger altered.`
        : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
    );
    return;
  }

  if (command.commandType === "create_ledger") {
    const xml = buildCreateLedgerXml(command.payload, command.payload?.companyName || null);
    const outcome = await invokeTallyXml(config.tallyUrl, xml);
    await sendCommandResult(config, command, {
      ...outcome,
      result: {
        ...(outcome.result || {}),
        requestXml: previewXml(xml),
        ledgerName: command.payload?.name,
        parentName: command.payload?.parentName,
      },
    });
    console.log(
      outcome.success
        ? `Command ${command.id} completed: ledger created.`
        : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
    );
    return;
  }

  if (command.commandType === "fetch_customer_open_bills") {
    try {
      const outcome = await fetchCustomerOpenBillsFromTally(config, command.payload);
      await sendCommandResult(config, command, outcome);
      const fetchedLedgerCount = Array.isArray(outcome.result?.ledgerNames) ? outcome.result.ledgerNames.length : 1;
      console.log(
        `Command ${command.id} completed: fetched open bills for ${fetchedLedgerCount} party ledger(s).`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Open bill fetch failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {},
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "verify_bank_transaction") {
    try {
      const outcome = await verifyBankTransactionInTally(config, command.payload);
      await sendCommandResult(config, command, {
        ...outcome,
        result: {
          ...(outcome.result || {}),
          transactionId: command.payload?.transactionId,
          sourceBankTransactionId: command.payload?.transactionId,
        },
      });
      console.log(
        outcome.result?.verificationStatus === "found"
          ? `Command ${command.id} completed: outgoing bank payment found in Tally.`
          : outcome.result?.verificationStatus === "ambiguous"
            ? `Command ${command.id} completed: outgoing bank payment needs review.`
            : `Command ${command.id} completed: outgoing bank payment missing in Tally.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Bank transaction verification failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {
          commandPayload: command.payload ?? {},
          transactionId: command.payload?.transactionId,
          sourceBankTransactionId: command.payload?.transactionId,
        },
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "create_purchase_voucher") {
    try {
      const live = await testTally(config.tallyUrl);
      const requestedCompany = String(command.payload?.companyName || "").trim();
      if (!live.tallyReachable || !live.companyLoaded) {
        throw new Error(live.error || "TallyPrime is not ready for Purchase voucher creation.");
      }
      if (
        requestedCompany &&
        normalizeLooseName(requestedCompany) !== normalizeLooseName(live.companyName)
      ) {
        throw new Error(`Tally is currently open to ${live.companyName || "another company"}. Switch to ${requestedCompany} before posting.`);
      }

      const purchasePayload = await materializePurchaseSourceDocument(command.payload);
      const posted = await postPurchaseVoucher(
        config.tallyUrl,
        purchasePayload,
        requestedCompany || live.companyName || config.companyName
      );
      await sendCommandResult(config, command, {
        ...posted.outcome,
        result: {
          ...(posted.outcome.result || {}),
          postingId: command.payload?.postingId,
          caseId: command.payload?.caseId,
          revision: command.payload?.revision,
          idempotencyKey: command.payload?.idempotencyKey,
          sourceDocumentAttached: Boolean(purchasePayload.sourceDocumentPath),
          sourceDocumentName: purchasePayload.sourceDocumentName || null,
          sourceDocumentSha256: purchasePayload.sourceDocumentSha256 || null,
        },
      });
      console.log(
        posted.outcome.success
          ? `Command ${command.id} completed: Purchase voucher verified in Tally.`
          : `Command ${command.id} needs correction: ${posted.outcome.error || "Purchase voucher verification failed."}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Purchase voucher creation failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {
          postingId: command.payload?.postingId,
          caseId: command.payload?.caseId,
          revision: command.payload?.revision,
          idempotencyKey: command.payload?.idempotencyKey,
        },
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "post_bank_voucher") {
    let xml = null;
    try {
      const posted = await postBankVoucher(
        config.tallyUrl,
        command.payload,
        command.payload?.companyName || null
      );
      xml = posted.xml;
      const outcome = posted.outcome;
      await sendCommandResult(config, command, {
        ...outcome,
        result: {
          ...(outcome.result || {}),
          requestXml: xml ? previewXml(xml) : null,
          retriedWithLegacyHeader: posted.retriedWithLegacyHeader,
          transactionId: command.payload?.transactionId,
          voucherId: outcome.result?.voucherId || command.payload?.referenceNumber || command.id,
        },
      });
      console.log(
        outcome.success
          ? outcome.result?.alreadyInTally
            ? `Command ${command.id} completed: bank transaction already existed in Tally.`
            : `Command ${command.id} completed: bank voucher posted.`
          : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
      );
      if (!outcome.success) {
        console.log(`Command ${command.id} Tally request XML: ${previewXml(xml)}`);
      }
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "Tally did not respond within 30 seconds while posting the bank voucher."
          : error instanceof Error
            ? error.message
            : String(error ?? "Bank voucher posting failed.");
      await sendCommandResult(config, command, {
        success: false,
        error: message,
        result: {
          requestXml: xml ? previewXml(xml) : null,
          commandPayload: command.payload ?? {},
          transactionId: command.payload?.transactionId,
          voucherId: command.payload?.referenceNumber || command.id,
        },
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (
    command.commandType === "export_debit_note_pdf" ||
    (command.commandType === "create_debit_note" && command.payload?.operation === "export_native_pdf")
  ) {
    try {
      const companyName = command.payload?.companyName || null;
      if (!companyName) {
        throw new Error("The native PDF export command is missing the Tally company name.");
      }
      const voucher = voucherFromConfirmedDebitNotePayload(command.payload);
      const exportedPdf = await exportNativeDebitNotePdf(
        companyName,
        voucher,
        command.payload?.partyLedgerName,
        options.renderTallyPrintToPdf
      );
      await sendCommandResult(config, command, {
        success: true,
        result: {
          proposalId: command.payload?.proposalId,
          companyName,
          voucherId: voucher.masterId,
          voucherGuid: voucher.guid || null,
          voucherNumber: voucher.voucherNumber,
          voucherDate: normalizeDateForCompare(voucher.effectiveDate || voucher.date),
          openReferenceName: voucher.reference || null,
          voucherReference: voucher.reference || null,
          voucherAlterId: voucher.alterId || null,
          voucherType: voucher.voucherType,
          partyLedgerName: debitNotePartyName(voucher, command.payload?.partyLedgerName),
          amount: debitNoteVoucherAmount(voucher),
          ...exportedPdf,
        },
      });
      console.log(`Command ${command.id} completed: native Tally Debit Note PDF exported.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Native Tally PDF export failed.");
      await sendCommandResult(config, command, {
        success: false,
        error: message,
        result: {
          proposalId: command.payload?.proposalId,
          companyName: command.payload?.companyName || null,
        },
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "create_debit_note") {
    let xml = null;
    try {
      const posted = await postDebitNote(
        config.tallyUrl,
        command.payload,
        command.payload?.companyName || null
      );
      xml = posted.xml;
      const outcome = posted.outcome;
      const voucher = await resolveDebitNoteVoucher(
        config.tallyUrl,
        {
          ...command.payload,
          tallyVoucherId: outcome.result?.lastVchId,
          expectedReference: command.payload?.referenceNumber,
        },
        command.payload?.companyName || null
      );
      await sendCommandResult(config, command, {
        ...outcome,
        result: {
          ...(outcome.result || {}),
          requestXml: previewXml(xml),
          proposalId: command.payload?.proposalId,
          voucherId: voucher.masterId,
          voucherGuid: voucher.guid || null,
          voucherNumber: voucher.voucherNumber,
          openReferenceName: voucher.reference || null,
          voucherReference: voucher.reference || null,
          voucherAlterId: voucher.alterId || null,
          voucherType: voucher.voucherType,
          partyLedgerName: voucher.partyLedgerName || null,
          voucherDate: normalizeDateForCompare(voucher.effectiveDate || voucher.date),
        },
      });
      console.log(
        outcome.success
          ? `Command ${command.id} completed: debit note created.`
          : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
      );
      if (!outcome.success) {
        console.log(`Command ${command.id} Tally request XML: ${previewXml(xml)}`);
      }
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "Tally did not respond within 30 seconds while creating the debit note."
          : error instanceof Error
            ? error.message
            : String(error ?? "Debit note creation failed.");
      await sendCommandResult(config, command, {
        success: false,
        error: message,
        result: {
          requestXml: xml ? previewXml(xml) : null,
          commandPayload: command.payload ?? {},
          proposalId: command.payload?.proposalId,
          voucherId: command.payload?.referenceNumber || command.id,
        },
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "adjust_customer_advance") {
    let xml = null;
    try {
      const posted = await postCustomerAdvanceAdjustment(
        config.tallyUrl,
        command.payload,
        command.payload?.companyName || null
      );
      xml = posted.xml;
      const outcome = posted.outcome;
      await sendCommandResult(config, command, {
        ...outcome,
        result: {
          ...(outcome.result || {}),
          requestXml: previewXml(xml),
          sourceBankTransactionId: command.payload?.sourceBankTransactionId,
          voucherId: command.payload?.referenceNumber || command.id,
        },
      });
      console.log(
        outcome.success
          ? `Command ${command.id} completed: customer advance adjusted.`
          : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
      );
      if (!outcome.success) {
        console.log(`Command ${command.id} Tally request XML: ${previewXml(xml)}`);
      }
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "Tally did not respond within 30 seconds while adjusting the customer advance."
          : error instanceof Error
            ? error.message
            : String(error ?? "Customer advance adjustment failed.");
      await sendCommandResult(config, command, {
        success: false,
        error: message,
        result: {
          requestXml: xml ? previewXml(xml) : null,
          commandPayload: command.payload ?? {},
          sourceBankTransactionId: command.payload?.sourceBankTransactionId,
          voucherId: command.payload?.referenceNumber || command.id,
        },
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  await sendCommandResult(config, command, {
    success: false,
    result: {},
    error: `Unsupported command type: ${command.commandType}`,
  });
}

async function pairBridge(args) {
  const apiBase = normalizeBaseUrl(args["api-base"]);
  const connectionId = required(args["connection-id"], "connection-id");
  const pairingCode = required(args["pairing-code"], "pairing-code");
  const controlToken = required(args["control-token"], "control-token");
  const tallyUrl = normalizeTallyUrl(args["tally-url"]);
  const bridgeName = args["bridge-name"] || os.hostname() || "Tally Bridge";
  const bridgeMachineId = args["bridge-machine-id"] || createMachineId();
  const bridgeMachineName = os.hostname() || "This computer";
  const readiness = await testTally(tallyUrl);
  const detectedCompanyName = readiness.companyName;

  const response = await fetch(`${apiBase}/api/tally/connections/${connectionId}/pair`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pairingCode,
      controlToken,
      bridgeName,
      bridgeVersion: BRIDGE_VERSION,
      bridgeMachineId,
      bridgeMachineName,
      companyName: detectedCompanyName,
      tallyReachable: readiness.tallyReachable,
      companyLoaded: readiness.companyLoaded,
    }),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok || !payload.bridgeToken) {
    throw new Error(payload.error || `Pairing failed with HTTP ${response.status}.`);
  }

  writeConfig({
    apiBase,
    connectionId,
    bridgeToken: payload.bridgeToken,
    tallyUrl,
    bridgeName,
    bridgeVersion: BRIDGE_VERSION,
    bridgeMachineId,
    bridgeMachineName,
  });

  console.log("Tally bridge paired successfully.");
  console.log(`Config saved to ${CONFIG_PATH}`);
}

async function sendHeartbeat(config, testResult, availableCompanies = []) {
  const response = await fetch(`${config.apiBase}/api/tally/bridge/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.bridgeToken}`,
    },
    body: JSON.stringify({
      connectionId: config.connectionId,
      tallyUrl: config.tallyUrl,
      bridgeVersion: BRIDGE_VERSION,
      bridgeMachineId: config.bridgeMachineId,
      bridgeMachineName: config.bridgeMachineName || os.hostname() || "This computer",
      ...testResult,
      companyName: testResult.companyName ?? null,
      companies: availableCompanies,
    }),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const error = new Error(payload.error || `Heartbeat failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function runOnce(config, options = {}) {
  // A verified Debit Note document needs the already-confirmed voucher fields
  // and the local PDF renderer, not a fresh Tally HTTP call. Claim and finish
  // it before a slow/unreachable Tally heartbeat can hold the customer send
  // flow hostage for a minute.
  const deferredCommands = [];
  try {
    const claimedCommands = await receiveNextCommands(config);
    for (const command of claimedCommands) {
      const isVerifiedDebitNotePdf =
        command.commandType === "export_debit_note_pdf" ||
        (command.commandType === "create_debit_note" && command.payload?.operation === "export_native_pdf");
      if (isVerifiedDebitNotePdf) {
        await runCommand(config, command, options);
      } else {
        deferredCommands.push(command);
      }
    }
  } catch (commandError) {
    console.error(commandError instanceof Error ? commandError.message : commandError);
  }

  const result = await testTally(config.tallyUrl);
  const companyCache = options.companyHeartbeatCache || null;
  const cacheIsFresh =
    companyCache &&
    companyCache.activeCompanyName === (result.companyName || null) &&
    Date.now() - Number(companyCache.fetchedAt || 0) < 60_000;
  const availableCompanies = result.tallyReachable
    ? cacheIsFresh
      ? companyCache.companies
      : await fetchAvailableCompanies(config.tallyUrl, result.companyName)
    : [];
  if (companyCache && result.tallyReachable && !cacheIsFresh) {
    companyCache.activeCompanyName = result.companyName || null;
    companyCache.companies = availableCompanies;
    companyCache.fetchedAt = Date.now();
  }
  const heartbeat = await sendHeartbeat(config, result, availableCompanies);
  const company = result.companyName ? ` Company: ${result.companyName}.` : "";
  const companyList =
    availableCompanies.length > 0
      ? ` Companies: ${availableCompanies.map((entry) => entry.companyName).join(", ")}.`
      : "";
  const error = result.error ? ` Error: ${result.error}` : "";
  console.log(
    `Heartbeat sent. Tally reachable: ${result.tallyReachable}. Company loaded: ${result.companyLoaded}.${company}${companyList}${error}`
  );

  try {
    const bankVoucherCommands = deferredCommands.filter(
      (command) => command.commandType === "post_bank_voucher"
    );
    for (const command of deferredCommands) {
      if (command.commandType !== "post_bank_voucher") {
        try {
          await runCommand(config, command, options);
        } catch (error) {
          console.error(
            `Command ${command.id} failed without blocking the remaining queue: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }
    if (bankVoucherCommands.length > 0) {
      await runBankVoucherCommandBatch(config, bankVoucherCommands, options);
    }
  } catch (commandError) {
    console.error(commandError instanceof Error ? commandError.message : commandError);
  }

  return {
    result,
    connection: heartbeat?.connection ?? null,
    timestamp: new Date().toISOString(),
    heartbeat,
  };
}

function tallyLiveGatewayUrl(config) {
  const configured = String(process.env.TALLY_LIVE_GATEWAY_URL || process.env.CASH_DISCOUNT_GATEWAY_URL || "").trim();
  if (configured) return configured;
  const url = new URL(config.apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (["localhost", "127.0.0.1"].includes(url.hostname)) {
    url.port = "3002";
    url.pathname = "/";
  } else {
    url.pathname = "/cash-discount-live";
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function startTallyLiveChannel(config, executeExclusive, options = {}) {
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;

  const log = (level, message) => emitLog(options, level, message);
  const send = (payload) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
    reconnectTimer.unref?.();
  };

  const handleOperation = async (message) => {
    const requestId = String(message.requestId || "").trim();
    const operation = String(message.operation || "");
    if (!requestId) return;
    try {
      const lockRequestedAt = Date.now();
      const data = await executeExclusive(async () => {
        const lockWaitMs = Date.now() - lockRequestedAt;
        if (operation === "company_check") return collectTallyCompanyCheck(config);
        if (operation === "bank_ledgers") {
          const outcome = await fetchBankLedgersFromTally(config, {
            companyNames: message.companyNames,
            companyName: message.companyName,
          });
          return outcome.result || outcome;
        }
        if (operation === "ledger_masters") {
          const operationStartedAt = Date.now();
          const requestedMasterTypes =
            Array.isArray(message.payload?.requestedMasterTypes) && message.payload.requestedMasterTypes.length > 0
              ? message.payload.requestedMasterTypes
              : ["ledger", "group"];
          const isBankStatementMasterRead =
            requestedMasterTypes.length === 2 &&
            requestedMasterTypes.includes("ledger") &&
            requestedMasterTypes.includes("group") &&
            message.payload?.persistSnapshot !== true;
          const masters = await collectTallyMasters(config, {
            companyName: message.companyName,
            requestedMasterTypes,
            fieldProfile: message.payload?.fieldProfile || (isBankStatementMasterRead ? "bank_statement" : ""),
          });
          const requestedTypes = new Set(requestedMasterTypes);
          const masterPayload = {};
          if (requestedTypes.has("ledger")) masterPayload.ledgers = masters.ledgers;
          if (requestedTypes.has("group")) masterPayload.groups = masters.groups;
          if (requestedTypes.has("stock_item")) masterPayload.stockItems = masters.stockItems;
          if (requestedTypes.has("unit")) masterPayload.units = masters.units;
          if (requestedTypes.has("voucher_type")) masterPayload.voucherTypes = masters.voucherTypes;
          if (requestedTypes.has("gst_ledger")) masterPayload.gstLedgers = masters.gstLedgers;
          if (requestedTypes.has("tax_ledger")) masterPayload.taxLedgers = masters.taxLedgers;
          // Interactive ledger reads must remain local and fast. Persisting a
          // 12k+ master snapshot here blocked the browser for about a minute
          // and could disconnect the live socket. Explicit sync_masters
          // commands still use syncMastersFromTally and persist the snapshot.
          let syncRunId = null;
          if (message.payload?.persistSnapshot === true) {
            const syncResult = await postMastersToBackend(config, {
              connectionId: config.connectionId,
              companyName: message.companyName || config.companyName || null,
              bridgeVersion: BRIDGE_VERSION,
              masters: masterPayload,
              companyProfile: masters.companyProfile,
              requestedMasterTypes: masters.requestedMasterTypes,
            });
            syncRunId = syncResult.syncRunId || null;
          }
          log(
            "info",
            `Live ledger fetch completed in ${Date.now() - operationStartedAt} ms (${masters.ledgers.length} ledgers, ${masters.groups.length} groups, lock ${lockWaitMs} ms, phases ${JSON.stringify(masters.timings || {})}, persistence ${message.payload?.persistSnapshot === true ? "enabled" : "skipped"}).`
          );
          const responseLedgers = isBankStatementMasterRead
            ? masters.ledgers.map((master) => toBankStatementLiveMaster(master, "ledger"))
            : masters.ledgers;
          const responseGroups = isBankStatementMasterRead
            ? masters.groups.map((master) => toBankStatementLiveMaster(master, "group"))
            : masters.groups;
          const response = {
            source: "live_tally",
            companyName: message.companyName,
            fetchedAt: new Date().toISOString(),
            syncRunId,
            timings: { lockWaitMs, ...(masters.timings || {}), totalMs: Date.now() - lockRequestedAt },
            ledgers: responseLedgers,
            groups: responseGroups,
            stockItems: masters.stockItems,
            units: masters.units,
            companyProfile: masters.companyProfile,
          };
          // Bank Statements consumes the top-level ledgers/groups. Do not add
          // the legacy nested copy here: it doubled an already-large 12k row
          // WebSocket message and caused Heroku to terminate the live socket.
          if (!isBankStatementMasterRead) {
            response.masters = {
              ledgers: responseLedgers,
              groups: responseGroups,
              stockItems: masters.stockItems,
              units: masters.units,
            };
          }
          log("info", `Live ledger response size: ${Buffer.byteLength(JSON.stringify(response))} bytes.`);
          return response;
        }
        if (operation === "verify_bank_transaction") {
          const outcome = await reconcileBankTransactionsInTally(config, message.payload || {});
          return outcome.result || outcome;
        }
        if (operation === "fetch_customer_open_bills") {
          const outcome = await fetchCustomerOpenBillsFromTally(config, message.payload || {});
          return outcome.result || outcome;
        }
        throw new Error("Unsupported live Tally operation.");
      });
      send({ type: "operation_result", requestId, success: true, companyName: message.companyName, data });
    } catch (error) {
      send({
        type: "operation_result",
        requestId,
        success: false,
        companyName: message.companyName,
        error: error instanceof Error ? error.message : String(error || "Live Tally operation failed."),
      });
    }
  };

  const connect = () => {
    if (stopped) return;
    try {
      socket = new WebSocket(tallyLiveGatewayUrl(config), {
        ca: windowsTlsCertificates(),
      });
      socket.addEventListener("open", () => {
        send({
          type: "authenticate",
          role: "connector",
          connectionId: config.connectionId,
          token: config.bridgeToken,
        });
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data || "{}"));
          if (message.type === "authenticated") {
            log("info", "Live Tally channel connected.");
          } else if (message.type === "operation") {
            void handleOperation(message);
          } else if (message.type === "error") {
            log("error", `Live Tally channel: ${message.error || "unknown error"}`);
          }
        } catch (error) {
          log("error", error instanceof Error ? error.message : "Invalid live Tally message.");
        }
      });
      socket.addEventListener("error", (event) => {
        const detail = String(event?.message || event?.error?.message || "").trim();
        log("error", `Live Tally channel is unavailable${detail ? `: ${detail}` : ""}; retrying.`);
      });
      socket.addEventListener("close", (event) => {
        const code = Number(event?.code || 0);
        const reason = String(event?.reason || "").trim();
        if (!stopped && (code !== 1000 || reason)) {
          log("error", `Live Tally channel closed (code ${code || "unknown"}${reason ? `: ${reason}` : ""}); retrying.`);
        }
        scheduleReconnect();
      });
    } catch (error) {
      log("error", error instanceof Error ? error.message : "Could not start the live Tally channel.");
      scheduleReconnect();
    }
  };

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}

async function startBridge(args) {
  const config = readConfig();
  if (!config) {
    throw new Error(`Bridge is not paired. Run pair first. Expected config at ${CONFIG_PATH}`);
  }

  if (args["tally-url"]) {
    config.tallyUrl = normalizeTallyUrl(args["tally-url"]);
    writeConfig(config);
  }

  const intervalMs = Number(args.interval || DEFAULT_HEARTBEAT_INTERVAL_MS);
  console.log(`Starting Tally bridge for ${config.tallyUrl}`);
  console.log(`Sending heartbeat every ${intervalMs} ms.`);

  let running = false;
  let pendingExclusive = 0;
  const executeExclusive = async (task) => {
    pendingExclusive += 1;
    while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    pendingExclusive -= 1;
    running = true;
    try {
      return await task();
    } finally {
      running = false;
    }
  };
  const runnerOptions = { companyHeartbeatCache: {} };
  const runSerially = async () => {
    if (running || pendingExclusive > 0) {
      console.log("Previous bridge cycle is still running; skipping this heartbeat.");
      return;
    }

    running = true;
    try {
      await runOnce(config, runnerOptions);
    } finally {
      running = false;
    }
  };

  await runOnce(config, runnerOptions);
  startTallyLiveChannel(config, executeExclusive);
  setInterval(() => {
    runSerially().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
    });
  }, intervalMs);
}

async function testBridge(args) {
  const config = readConfig() ?? {
    tallyUrl: normalizeTallyUrl(args["tally-url"]),
  };
  const result = await testTally(normalizeTallyUrl(args["tally-url"] || config.tallyUrl));
  console.log(JSON.stringify(result, null, 2));
}

function emitLog(options, level, message) {
  if (typeof options?.onLog === "function") {
    options.onLog({
      level,
      message,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (level === "error") {
    console.error(message);
    return;
  }

  console.log(message);
}

function createBridgeRunner(options = {}) {
  const config = options.config ?? readConfig();
  if (!config) {
    throw new Error(`Bridge is not paired. Run pair first. Expected config at ${CONFIG_PATH}`);
  }

  const intervalMs = Number(options.intervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
  let timer = null;
  let running = false;
  let pendingExclusive = 0;
  let stopped = false;
  let stopTallyLiveChannel = null;
  const companyHeartbeatCache = {};

  const executeExclusive = async (task) => {
    pendingExclusive += 1;
    while (running && !stopped) await new Promise((resolve) => setTimeout(resolve, 25));
    pendingExclusive -= 1;
    if (stopped) throw new Error("The connector has stopped.");
    running = true;
    try {
      return await task();
    } finally {
      running = false;
    }
  };

  const stop = (reason = "stopped", error = null) => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    stopTallyLiveChannel?.();
    stopTallyLiveChannel = null;
    if (typeof options.onStop === "function") {
      options.onStop({ reason, error, timestamp: new Date().toISOString() });
    }
  };

  const runSerially = async () => {
    if (stopped) return;
    if (running || pendingExclusive > 0) {
      emitLog(options, "info", "Previous bridge cycle is still running; skipping this heartbeat.");
      return;
    }

    running = true;
    try {
      const cycle = await runOnce(config, { ...options, companyHeartbeatCache });
      if (typeof options.onStatus === "function") {
        options.onStatus(cycle);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Bridge cycle failed.");
      emitLog(options, "error", message);
      if (
        error?.status === 401 ||
        error?.status === 409 ||
        error?.status === 426 ||
        /invalid bridge token|different connector installation|connector update required/i.test(
          String(error?.message ?? "")
        )
      ) {
        deleteConfig();
        stop(error?.status === 426 ? "update required" : "revoked", error);
      }
    } finally {
      running = false;
    }
  };

  return {
    config,
    get stopped() {
      return stopped;
    },
    async start() {
      emitLog(options, "info", `Starting Tally bridge for ${config.tallyUrl}`);
      emitLog(options, "info", `Sending heartbeat every ${intervalMs} ms.`);
      stopTallyLiveChannel = startTallyLiveChannel(config, executeExclusive, options);
      await runSerially();
      if (!stopped) {
        timer = setInterval(() => {
          runSerially().catch((error) => {
            emitLog(options, "error", error instanceof Error ? error.message : String(error));
          });
        }, intervalMs);
      }
    },
    stop,
    async runOnce() {
      await runSerially();
    },
  };
}

async function disconnectBridge(args = {}) {
  const config = readConfig();
  if (!config) {
    return {
      disconnected: false,
      localConfigDeleted: false,
      reason: "not_paired",
    };
  }

  const requestedConnectionId = String(args["connection-id"] || "").trim();
  if (requestedConnectionId && requestedConnectionId !== config.connectionId) {
    return {
      disconnected: false,
      localConfigDeleted: false,
      reason: "connection_mismatch",
      activeConnectionId: config.connectionId,
      requestedConnectionId,
    };
  }

  let remote = null;
  try {
    const response = await fetch(`${config.apiBase}/api/tally/bridge/disconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.bridgeToken}`,
      },
      body: JSON.stringify({
        connectionId: config.connectionId,
      }),
    });
    remote = await readJsonResponse(response);
  } catch (_error) {
    // Local disconnect should succeed even if the API is unavailable.
  } finally {
    if (String(args["keep-config"] || "").toLowerCase() !== "true") {
      deleteConfig();
    }
  }

  return {
    disconnected: true,
    localConfigDeleted: String(args["keep-config"] || "").toLowerCase() !== "true",
    remote,
  };
}

async function syncMastersCli(args) {
  const config = readConfig();
  if (!config) {
    throw new Error(`Bridge is not paired. Run pair first. Expected config at ${CONFIG_PATH}`);
  }

  const nextConfig = { ...config };
  if (args["tally-url"]) {
    nextConfig.tallyUrl = normalizeTallyUrl(args["tally-url"]);
  }
  if (args["company-name"]) {
    nextConfig.companyName = args["company-name"];
  }

  const outcome = await syncMastersFromTally(nextConfig, {
    companyName: args["company-name"] || nextConfig.companyName,
    tallyUrl: nextConfig.tallyUrl,
  });

  console.log(JSON.stringify(outcome.result, null, 2));
}

async function listBankLedgersCli(args) {
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const companyNames = args["company-names"]
    ? String(args["company-names"]).split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const outcome = await fetchBankLedgersFromTally(
    {
      ...(config || {}),
      tallyUrl: normalizeTallyUrl(args["tally-url"] || config?.tallyUrl),
      companyName: args["company-name"] || config?.companyName || null,
    },
    {
      companyName: args["company-name"] || config?.companyName || null,
      companyNames,
    }
  );

  console.log(JSON.stringify(outcome.result, null, 2));
}

function readJsonPayload(args) {
  if (args["payload-json"]) {
    return JSON.parse(args["payload-json"]);
  }

  if (args["payload-file"]) {
    return JSON.parse(fs.readFileSync(args["payload-file"], "utf8"));
  }

  throw new Error("Provide --payload-file <path> or --payload-json '<json>'.");
}

async function validateBankVoucherCli(args) {
  const payload = readJsonPayload(args);
  const config = readConfig();
  const companyName = args["company-name"] || config?.companyName || null;
  const xml = buildBankVoucherXml(payload, companyName);

  console.log(JSON.stringify(
    {
      ok: true,
      commandType: "post_bank_voucher",
      companyName: payload.companyName || companyName,
      voucherType: payload.voucherType || "Payment",
      voucherDate: toIsoLikeDate(payload.voucherDate),
      bankLedgerName: payload.bankLedgerName,
      counterpartyLedgerName: payload.counterpartyLedgerName,
      amount: toMoney(payload.amount),
      requestXml: previewXml(xml),
    },
    null,
    2
  ));
}

function shouldPostDiagnostics(args) {
  return String(args.post || "").toLowerCase() === "true" || String(args.post || "").toLowerCase() === "yes";
}

function writeDiagnosticArtifact(outputDir, variantName, extension, content) {
  if (!outputDir) return null;
  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = variantName.replace(/[^a-z0-9._-]/gi, "-");
  const filePath = path.join(outputDir, `${safeName}.${extension}`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

async function diagnoseBankVoucherCli(args) {
  const payload = readJsonPayload(args);
  const config = readConfig();
  const post = shouldPostDiagnostics(args);
  if (post && !config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const companyName = args["company-name"] || payload.companyName || config?.companyName || null;
  const tallyUrl = post ? normalizeTallyUrl(args["tally-url"] || config?.tallyUrl) : null;
  const stopOnSuccess = String(args["stop-on-success"] ?? "true").toLowerCase() !== "false";
  const outputDir = args["output-dir"] || null;
  const variants = buildBankVoucherDiagnosticVariants(payload, companyName);
  const requestedVariantNames = String(args.variants || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const selectedVariants = requestedVariantNames.length
    ? variants.filter((variant) => requestedVariantNames.includes(variant.name))
    : variants;

  if (selectedVariants.length === 0) {
    throw new Error(`No diagnostic variants matched --variants. Available: ${variants.map((variant) => variant.name).join(", ")}`);
  }

  const results = [];
  for (const variant of selectedVariants) {
    const requestXmlPath = writeDiagnosticArtifact(outputDir, variant.name, "request.xml", variant.xml);
    const result = {
      name: variant.name,
      description: variant.description,
      requestXmlPath,
      requestXml: outputDir ? undefined : previewXml(variant.xml),
      posted: post,
      success: null,
      error: null,
      created: null,
      altered: null,
      errors: null,
      responsePath: null,
      responsePreview: null,
    };

    if (post) {
      const outcome = explainBankVoucherTallyError(
        await invokeTallyXml(tallyUrl, variant.xml),
        payload
      );
      const responseText = String(outcome.result?.response || "");
      result.success = outcome.success;
      result.error = outcome.error || null;
      result.created = outcome.result?.created ?? null;
      result.altered = outcome.result?.altered ?? null;
      result.errors = outcome.result?.errors ?? null;
      result.responsePath = writeDiagnosticArtifact(outputDir, variant.name, "response.xml", responseText);
      result.responsePreview = outputDir ? undefined : responseText;
      results.push(result);

      const created = Number(outcome.result?.created ?? 0) || 0;
      const altered = Number(outcome.result?.altered ?? 0) || 0;
      if (outcome.success && (created > 0 || altered > 0) && stopOnSuccess) {
        break;
      }
      continue;
    }

    results.push(result);
  }

  console.log(JSON.stringify(
    {
      ok: true,
      posted: post,
      tallyUrl: post ? tallyUrl : null,
      companyName,
      voucherType: payload.voucherType || "Payment",
      voucherDate: toIsoLikeDate(payload.voucherDate),
      referenceNumber: String(payload.referenceNumber || payload.transactionId || ""),
      outputDir,
      variants: results,
    },
    null,
    2
  ));
}

async function diagnoseBankVoucherDatesCli(args) {
  const payload = readJsonPayload(args);
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const companyName = args["company-name"] || payload.companyName || config?.companyName || null;
  const tallyUrl = normalizeTallyUrl(args["tally-url"] || config?.tallyUrl);
  const variantName = args.variant || "minimal-accounting";
  const outputDir = args["output-dir"] || null;
  const dateValues = String(args.dates || "2026-04-01,2026-06-03,2026-06-04")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (dateValues.length === 0) {
    throw new Error("Provide one or more dates with --dates YYYY-MM-DD,YYYY-MM-DD.");
  }

  const results = [];
  for (const dateValue of dateValues) {
    const voucherDate = toIsoLikeDate(dateValue);
    const datePayload = {
      ...payload,
      voucherDate: dateValue,
      referenceNumber: `DIAG-${payload.voucherType || "VCH"}-${voucherDate}`,
      narration: `${payload.narration || "Bank voucher diagnostic"} date probe ${dateValue}`,
    };
    const xml = getBankVoucherDiagnosticVariantXml(datePayload, companyName, variantName);
    const artifactName = `date-${voucherDate}`;
    const requestXmlPath = writeDiagnosticArtifact(outputDir, artifactName, "request.xml", xml);
    const outcome = explainBankVoucherTallyError(
      await invokeTallyXml(tallyUrl, xml),
      datePayload
    );
    const responseText = String(outcome.result?.response || "");
    const responsePath = writeDiagnosticArtifact(outputDir, artifactName, "response.xml", responseText);
    results.push({
      date: dateValue,
      voucherDate,
      referenceNumber: datePayload.referenceNumber,
      variant: variantName,
      success: outcome.success,
      error: outcome.error || null,
      created: outcome.result?.created ?? null,
      altered: outcome.result?.altered ?? null,
      errors: outcome.result?.errors ?? null,
      requestXmlPath,
      responsePath,
      responsePreview: outputDir ? undefined : responseText,
    });
  }

  console.log(JSON.stringify(
    {
      ok: true,
      posted: true,
      tallyUrl,
      companyName,
      voucherType: payload.voucherType || "Payment",
      variant: variantName,
      outputDir,
      results,
    },
    null,
    2
  ));
}

async function diagnoseTallyCompanyCli(args) {
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const tallyUrl = normalizeTallyUrl(args["tally-url"] || config?.tallyUrl);
  const companyName = args["company-name"] || config?.companyName || null;
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Gajkesari Company Diagnostics",
    tallyType: "Company",
    fetchFields:
      "Name,Guid,StartingFrom,BooksFrom,FinancialYearFrom,CurrentPeriod,AlterID,MasterID",
    companyName,
  });
  const companies = parseMasterCollection(xml, "COMPANY");
  console.log(JSON.stringify(
    {
      ok: true,
      tallyUrl,
      companyName,
      companies,
      rawPreview: previewXml(xml),
    },
    null,
    2
  ));
}

async function findVouchersCli(args) {
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const tallyUrl = normalizeTallyUrl(args["tally-url"] || config.tallyUrl);
  const companyName = args["company-name"] || config?.companyName || null;
  const refs = String(args.refs || args.ref || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (refs.length === 0) {
    throw new Error("Provide --refs REF1,REF2 or --ref REF.");
  }

  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Gajkesari Voucher Lookup",
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,IsCancelled,AllLedgerEntries.LedgerName",
    companyName,
    dateFrom: "2000-04-01",
    dateTo: "2099-03-31",
  });
  const vouchers = parseVoucherCollection(xml);
  const matches = vouchers.filter((voucher) => {
    const haystack = [
      voucher.voucherNumber,
      voucher.reference,
      voucher.narration,
      voucher.partyLedgerName,
      ...voucher.ledgerNames,
      voucher.rawPreview,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return refs.some((ref) => haystack.includes(ref.toLowerCase()));
  });

  console.log(JSON.stringify(
    {
      ok: true,
      companyName,
      searchedRefs: refs,
      scannedCount: vouchers.length,
      matchCount: matches.length,
      matches,
    },
    null,
    2
  ));
}

async function listVouchersCli(args) {
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const tallyUrl = normalizeTallyUrl(args["tally-url"] || config.tallyUrl);
  const companyName = args["company-name"] || config?.companyName || null;
  const limit = Math.max(1, Math.min(Number(args.limit || 20) || 20, 200));
  const includeAll = String(args.all || "").toLowerCase() === "true" || String(args.all || "").toLowerCase() === "yes";
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Gajkesari Voucher List",
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,IsCancelled,AllLedgerEntries.LedgerName",
    companyName,
    dateFrom: "2000-04-01",
    dateTo: "2099-03-31",
  });
  const vouchers = parseVoucherCollection(xml);

  console.log(JSON.stringify(
    {
      ok: true,
      companyName,
      scannedCount: vouchers.length,
      vouchers: includeAll ? vouchers : vouchers.slice(-limit),
    },
    null,
    2
  ));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "pair") {
    await pairBridge(args);
    return;
  }

  if (command === "start") {
    await startBridge(args);
    return;
  }

  if (command === "test") {
    await testBridge(args);
    return;
  }

  if (command === "sync-masters") {
    await syncMastersCli(args);
    return;
  }

  if (command === "list-bank-ledgers") {
    await listBankLedgersCli(args);
    return;
  }

  if (command === "validate-bank-voucher") {
    await validateBankVoucherCli(args);
    return;
  }

  if (command === "diagnose-bank-voucher") {
    await diagnoseBankVoucherCli(args);
    return;
  }

  if (command === "diagnose-bank-voucher-dates") {
    await diagnoseBankVoucherDatesCli(args);
    return;
  }

  if (command === "diagnose-tally-company") {
    await diagnoseTallyCompanyCli(args);
    return;
  }

  if (command === "find-vouchers") {
    await findVouchersCli(args);
    return;
  }

  if (command === "list-vouchers") {
    await listVouchersCli(args);
    return;
  }

  console.log("Usage:");
  console.log("  node apps/tally-bridge/src/bridge.mjs pair --api-base <url> --connection-id <id> --pairing-code <code> --tally-url http://localhost:9000");
  console.log("  node apps/tally-bridge/src/bridge.mjs start");
  console.log("  node apps/tally-bridge/src/bridge.mjs sync-masters --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs list-bank-ledgers --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs validate-bank-voucher --payload-file <path>");
  console.log("  node apps/tally-bridge/src/bridge.mjs diagnose-bank-voucher --payload-file <path> --post true --output-dir ./tally-diagnostics");
  console.log("  node apps/tally-bridge/src/bridge.mjs diagnose-bank-voucher-dates --payload-file <path> --dates 2026-04-01,2026-06-03");
  console.log("  node apps/tally-bridge/src/bridge.mjs diagnose-tally-company --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs find-vouchers --refs REF1,REF2 --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs list-vouchers --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs test --tally-url http://localhost:9000");
}

export {
  BRIDGE_VERSION,
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_TALLY_URL,
  createBridgeRunner,
  classifyOpenBillReferenceKind,
  classifyTaxLedgers,
  buildCollectionExportXml,
  buildRequestedLedgerFormula,
  buildPurchaseVoucherXml,
  deleteConfig,
  disconnectBridge,
  exportTallyCollection,
  fetchAvailableCompanies,
  fetchBankLedgersFromTally,
  findBankLedgersFromMasters,
  fetchCustomerOpenBillsFromTally,
  normalizeTallyUrl,
  openBillBlockRequiresVoucherFallback,
  pairBridge,
  parseBankStatementMasterCollection,
  parseTallyImportResult,
  purchaseVoucherReadbackComparison,
  readConfig,
  reconcileBankTransactionsInTally,
  strictBankTransactionCandidates,
  runOnce,
  startBridge,
  testBridge,
  testTally,
  verifyPurchaseVoucherInTally,
  writeConfig,
};

if (process.argv[1] && path.resolve(process.argv[1]) === CURRENT_FILE) {
  main().catch((error) => {
    console.error(formatCliError(error));
    process.exit(1);
  });
}
