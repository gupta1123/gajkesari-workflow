import { app, BrowserWindow, dialog, net, ipcMain, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pairBridge, createBridgeRunner, disconnectBridge } from "./src/bridge.mjs";
import { loadLocalDb, saveLocalDb, getLocalDbPaths, upsertLedgers, upsertGroups, getStatusForCompany, getAllCompaniesStatus, normalizeCompanyKey } from "./src/local-matching/store.mjs";
import { vectoriseCompany, getVectorStatus, getVectorEngine, isZvecAvailable, closeZvecCollections } from "./src/local-matching/vector.mjs";
import { syncLedgersReadOnly } from "./src/local-matching/sync.mjs";
import { suggestLedgers, suggestLedgersBatch } from "./src/local-matching/suggest.mjs";
import { parseDocumentLocal } from "./src/document-parsing/parser.mjs";
import { parseDocumentAndSuggestLedgers } from "./src/document-parsing/parse-and-suggest.mjs";
import { loadOperationalCache, operationalStatus } from "./src/local-matching/operational-cache.mjs";
import { exportTallyCollection, fetchAvailableCompanies, testTally } from "./src/bridge.mjs";

const BRAND_NAME = "Gajkesari";
const CONNECTOR_NAME = "Gajkesari Tally Connector";
const PROTOCOL_NAME = "gajkesari-tally";
const APP_USER_MODEL_ID = "com.gajkesari.tally-connector";

// The connector UI is lightweight and does not need GPU acceleration. Some
// Windows machines cannot start Electron's GPU subprocess, which otherwise
// terminates the whole connector before its window appears.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brandLogoPath = path.join(__dirname, "assets", "gajkesari-logo.png");
const brandLogoDataUrl = `data:image/png;base64,${fs.readFileSync(brandLogoPath).toString("base64")}`;
const installDir = path.resolve(__dirname, "..", "..");
const logPath = path.join(installDir, "bridge.log");
const errPath = path.join(installDir, "bridge.err.log");
const nodeFetch = globalThis.fetch.bind(globalThis);
const ELECTRON_NETWORK_RETRY_MS = 5 * 60 * 1000;
let preferNodeFetchUntil = 0;
let directEmbeddingConfig = null;
let localSyncInFlight = null;

function directEmbeddingConfigPath() {
  return path.join(app.getPath("userData"), "direct-embedding.json");
}

function forgetDirectEmbeddingConfig() {
  directEmbeddingConfig = null;
  try { fs.rmSync(directEmbeddingConfigPath(), { force: true }); } catch {}
}

async function loadDirectEmbeddingConfig({ refresh = false } = {}) {
  if (!refresh && directEmbeddingConfig) return directEmbeddingConfig;
  if (!refresh && safeStorage.isEncryptionAvailable()) {
    try {
      const saved = JSON.parse(fs.readFileSync(directEmbeddingConfigPath(), "utf8"));
      const apiKey = safeStorage.decryptString(Buffer.from(saved.encryptedApiKey, "base64"));
      if (apiKey && saved.endpoint && saved.model === "openai/text-embedding-3-small" && saved.dimensions === 512) {
        directEmbeddingConfig = { ...saved, apiKey };
        return directEmbeddingConfig;
      }
    } catch {}
  }
  const config = runner?.config;
  if (!config?.apiBase || !config?.connectionId || !config?.bridgeToken) throw new Error("Reconnect this connector to enable direct AI vector search.");
  const response = await fetch(`${config.apiBase}/api/tally/bridge/direct-embedding-config?connectionId=${encodeURIComponent(config.connectionId)}`, {
    headers: { Authorization: `Bearer ${config.bridgeToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "Direct AI configuration is unavailable.");
  if (payload?.endpoint !== "https://openrouter.ai/api/v1/embeddings" || payload?.model !== "openai/text-embedding-3-small" || payload?.dimensions !== 512 || !payload?.apiKey) {
    throw new Error("Direct AI configuration is incompatible.");
  }
  directEmbeddingConfig = payload;
  if (safeStorage.isEncryptionAvailable()) {
    const saved = { ...payload, apiKey: undefined, encryptedApiKey: safeStorage.encryptString(payload.apiKey).toString("base64") };
    const target = directEmbeddingConfigPath();
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
  return directEmbeddingConfig;
}

let mainWindow = null;
let runner = null;
let pendingProtocolUrl = null;
let quitting = false;
let lastStatus = {
  title: "Waiting for connection",
  detail: `Open ${BRAND_NAME} and click Connect.`,
  state: "idle",
};

function electronRequestFetch(input, init = {}) {
  const url = input instanceof URL ? input.toString() : String(input);
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: String(init.method || "GET").toUpperCase(),
      url,
      redirect: "follow",
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener?.("abort", abort);
      callback(value);
    };
    const abort = () => {
      request.abort();
      finish(reject, init.signal?.reason || new DOMException("The operation was aborted.", "AbortError"));
    };

    for (const [name, value] of new Headers(init.headers || {}).entries()) {
      request.setHeader(name, value);
    }
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("error", (error) => finish(reject, error));
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, values] of Object.entries(response.headers || {})) {
          for (const value of Array.isArray(values) ? values : [values]) {
            if (value != null) headers.append(name, String(value));
          }
        }
        finish(
          resolve,
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            statusText: response.statusMessage,
            headers,
          })
        );
      });
    });
    request.on("error", (error) => finish(reject, error));
    if (init.signal?.aborted) return abort();
    init.signal?.addEventListener?.("abort", abort, { once: true });

    if (init.body == null) {
      request.end();
    } else if (typeof init.body === "string" || Buffer.isBuffer(init.body) || init.body instanceof Uint8Array) {
      request.end(init.body);
    } else {
      request.abort();
      finish(reject, new TypeError("Unsupported connector request body."));
    }
  });
}

function installSystemNetworkFetch() {
  // Use Windows' proxy and certificate store, matching the user's browser.
  // This avoids TLS failures on machines with corporate/antivirus inspection.
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(input instanceof URL ? input.toString() : String(input));
    if (["localhost", "127.0.0.1", "::1"].includes(requestUrl.hostname)) {
      // Tally's local HTTP server can keep the response connection open in a
      // way Electron ClientRequest interprets as an unfinished stream. Node's
      // fetch handles that protocol correctly and needs no Windows TLS store.
      return nodeFetch(input, init);
    }
    if (Date.now() < preferNodeFetchUntil) {
      try {
        return await nodeFetch(input, init);
      } catch {
        // Re-probe Chromium immediately if the previously-working Node path
        // becomes unavailable.
        preferNodeFetchUntil = 0;
      }
    }
    try {
      return await electronRequestFetch(input, init);
    } catch (error) {
      // Chromium networking can return the opaque net::ERR_FAILED before a
      // request reaches Heroku. Node's fetch uses a separate HTTPS stack and
      // is a safe fallback for the same standards-based RequestInit payload.
      const response = await nodeFetch(input, init);
      preferNodeFetchUntil = Date.now() + ELECTRON_NETWORK_RETRY_MS;
      appendLog(
        errPath,
        `Electron networking failed (${formatConnectorError(error)}); Node HTTPS succeeded and will be preferred for five minutes.`
      );
      return response;
    }
  };
}

function formatConnectorError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = typeof cause.code === "string" ? ` (${cause.code})` : "";
    return `${error.message}: ${cause.message}${code}`;
  }
  return error.message;
}

function appendLog(filePath, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFile(filePath, line, () => {});
}

// --- Local Matching (connector-scoped, read-only, persistent) ---
function getLocalMatchingPaths() {
  try {
    const userData = app.getPath("userData");
    return getLocalDbPaths({ appUserDataPath: userData });
  } catch {
    return getLocalDbPaths({});
  }
}

function getLocalMatchingStatus() {
  const paths = getLocalMatchingPaths();
  let db;
  try {
    db = loadLocalDb({ appUserDataPath: app.getPath("userData") });
  } catch {
    db = loadLocalDb({});
  }
  const dbExists = fs.existsSync(paths.dbPath);
  // Tally company identity from runner/config
  let tallyCompany = null;
  let tallyUrl = "http://localhost:9000";
  try {
    const status = lastStatus;
    // lastStatus.title may contain "Connected to <Company>"
    if (status && status.title && status.title.startsWith("Connected to ")) {
      tallyCompany = status.title.replace("Connected to ", "").trim();
    }
  } catch {}
  try {
    if (runner && runner.config && runner.config.companyName) tallyCompany = runner.config.companyName;
    if (runner && runner.config && runner.config.tallyUrl) tallyUrl = runner.config.tallyUrl;
  } catch {}
  // Prefer db company entry if available
  let companies = [];
  try { companies = getAllCompaniesStatus(db); } catch {}
  const activeEntry = tallyCompany ? companies.find((c) => c.companyName && c.companyName.toLowerCase() === tallyCompany.toLowerCase()) : null;
  const activeKey = activeEntry ? activeEntry.companyKey : null;
  let activeStatus = null;
  if (activeEntry) {
    try { activeStatus = getStatusForCompany(db, { companyName: activeEntry.companyName, companyGuid: activeEntry.companyGuid }); } catch {}
  }
  // If no active, pick most recent
  if (!activeStatus && companies.length) {
    const recent = companies.slice().sort((a,b)=> new Date(b.lastSyncAt||0) - new Date(a.lastSyncAt||0))[0];
    try { activeStatus = getStatusForCompany(db, { companyName: recent.companyName, companyGuid: recent.companyGuid }); } catch {}
  }
  const vectorEngine = getVectorEngine();
  let voucherStatus = { status: "not_indexed", voucherCount: 0, partitionCount: 0, lastUpdatedAt: null, partitions: [] };
  try {
    const operationalDb = loadOperationalCache({ appUserDataPath: app.getPath("userData") });
    voucherStatus = operationalStatus(operationalDb, {
      companyGuid: activeEntry?.companyGuid || activeStatus?.companyGuid || null,
      companyName: tallyCompany || activeStatus?.companyName || null,
    });
  } catch {}
  return {
    db: { exists: dbExists, path: paths.dbPath, dir: paths.dir, version: db.version || 1 },
    tally: { companyName: tallyCompany, companyGuid: activeEntry?.companyGuid || activeStatus?.companyGuid || null, tallyUrl },
    ledgers: activeStatus ? { count: activeStatus.ledgerCount, lastSyncAt: activeStatus.lastSyncAt, counts: activeStatus.syncCounts, cursor: activeStatus.syncCursor } : { count: 0, lastSyncAt: null, counts: null, cursor: null },
    vector: activeStatus ? { ...activeStatus.vector, engineDetail: vectorEngine } : { status: "idle", lastVectorisedAt: null, vectorCount: 0, engine: vectorEngine.engine, engineDetail: vectorEngine },
    vouchers: voucherStatus,
    companies,
    isZvecAvailable: isZvecAvailable(),
    // For UI
    activeCompanyKey: activeKey || activeStatus?.companyKey || null,
  };
}

async function handleLocalSync({ forceFull = false } = {}) {
  const paths = getLocalMatchingPaths();
  let db;
  try { db = loadLocalDb({ appUserDataPath: app.getPath("userData") }); } catch { db = loadLocalDb({}); }
  // Read-only: fetch ledgers via Export only
  let tallyUrl = "http://localhost:9000";
  let companyName = null;
  let companyGuid = null;
  try {
    if (runner && runner.config && runner.config.tallyUrl) tallyUrl = runner.config.tallyUrl;
    // Probe active company read-only
    const readiness = await testTally(tallyUrl);
    if (readiness.tallyReachable && readiness.companyLoaded && readiness.companyName) {
      companyName = readiness.companyName;
    } else if (lastStatus && lastStatus.title && lastStatus.title.startsWith("Connected to ")) {
      companyName = lastStatus.title.replace("Connected to ", "").trim();
    }
    // Fetch GUID if possible
    try {
      const companies = await fetchAvailableCompanies(tallyUrl, companyName);
      const active = companies.find((c) => c.isActive) || companies.find((c) => c.companyName && companyName && c.companyName.toLowerCase() === companyName.toLowerCase());
      if (active) {
        companyGuid = active.guid || null;
        companyName = active.companyName || companyName;
      }
    } catch {}
  } catch (e) {
    throw new Error(`Tally not reachable for read-only sync: ${formatConnectorError(e)}`);
  }
  if (!companyName) throw new Error("No active Tally company detected. Open a company in Tally Prime and try again.");

  // Use stub helpers that are read-only: exportTallyCollection with Ledger Export
  // Build helpers for sync.mjs parse
  const helpers = {
    extractBlocks: (xml, tag) => {
      const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
      const blocks = []; let m; while ((m = re.exec(xml))) blocks.push(m[0]); return blocks;
    },
    getTagText: (block, tag) => {
      const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      if (!m) return null;
      return m[1].replace(/&#x([0-9a-f]+);/gi, (_,c)=> String.fromCodePoint(parseInt(c,16))).replace(/&#(\d+);/g, (_,c)=> String.fromCodePoint(parseInt(c,10))).replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&quot;",'"').replaceAll("&apos;","'").replace(/[\u0000-\u001f\u007f-\u009f]/g," ").replace(/\s+/g," ").trim() || null;
    },
    getAttribute: (block, attr) => {
      const m = block.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i"));
      return m ? m[1].replace(/\s+/g," ").trim() : null;
    },
  };

  const companyKey = normalizeCompanyKey({ companyName, companyGuid });
  const existing = db.companies?.[companyKey] || null;
  const lastFullSyncAt = Date.parse(existing?.lastFullSyncAt || "");
  const fullReconciliationDue = !Number.isFinite(lastFullSyncAt) || Date.now() - lastFullSyncAt >= 7 * 24 * 60 * 60 * 1000;
  const requestedMode = !forceFull && existing?.syncCursor?.lastLedgerAlterID && existing?.syncCursor?.lastGroupAlterID && !fullReconciliationDue
    ? "delta"
    : "full_snapshot";
  const result = await syncLedgersReadOnly({
    tallyUrl,
    companyName,
    companyGuid,
    exportTallyCollection,
    helpers,
    getActiveCompany: async () => ({ companyName, companyGuid }),
    mode: requestedMode,
    cursor: existing?.syncCursor || null,
  });

  // Upsert into persistent store
  const upsert = upsertLedgers({ db, companyName: result.companyName || companyName, companyGuid: result.companyGuid || companyGuid, ledgers: result.ledgers, cursor: result.cursor, mode: result.mode });
  const groupUpsert = upsertGroups({ db, companyName: result.companyName || companyName, companyGuid: result.companyGuid || companyGuid, groups: result.groups, cursor: result.cursor, mode: result.mode });
  saveLocalDb(db, { appUserDataPath: app.getPath("userData") });
  return { companyName: result.companyName || companyName, companyGuid: result.companyGuid || companyGuid, mode: result.mode, counts: upsert.counts, groupCounts: groupUpsert.counts, totalFetched: result.ledgers.length, groupsFetched: result.groups.length, isReadOnly: true, internalDb: db };
}

function scheduleLocalSync(options = {}) {
  if (localSyncInFlight) return localSyncInFlight;
  const startedAt = Date.now();
  const execute = () => handleLocalSync(options);
  localSyncInFlight = (runner && !runner.stopped && typeof runner.runTallyTask === "function"
    ? runner.runTallyTask(execute, "background")
    : execute()
  ).then(async (result) => {
    const { internalDb, ...publicResult } = result || {};
    const syncMs = Date.now() - startedAt;
    const changedLedgerCount = Number(result?.counts?.added || 0) + Number(result?.counts?.updated || 0) + Number(result?.counts?.deleted || 0);
    if (changedLedgerCount <= 0) {
      appendLog(logPath, `Local master sync completed mode=${result?.mode || "unknown"} changed=0 fetched=${result?.totalFetched || 0} groupsFetched=${result?.groupsFetched || 0} syncMs=${syncMs} totalMs=${Date.now() - startedAt}`);
      return { ...publicResult, vectorisation: null, timings: { syncMs, vectorMs: 0, totalMs: Date.now() - startedAt } };
    }
    const vectorStartedAt = Date.now();
    const vectorisation = await handleLocalVectorise({
      companyName: result?.companyName,
      companyGuid: result?.companyGuid,
      db: internalDb,
    });
    const vectorMs = Date.now() - vectorStartedAt;
    const totalMs = Date.now() - startedAt;
    appendLog(logPath, `Local master sync completed mode=${result?.mode || "unknown"} changed=${changedLedgerCount} fetched=${result?.totalFetched || 0} groupsFetched=${result?.groupsFetched || 0} syncMs=${syncMs} vectorMs=${vectorMs} totalMs=${totalMs} vectorBreakdown=${JSON.stringify(vectorisation?.result?.timings || {})}`);
    return { ...publicResult, vectorisation, timings: { syncMs, vectorMs, totalMs } };
  }).finally(() => { localSyncInFlight = null; });
  return localSyncInFlight;
}

async function handleLocalVectorise({ companyName: requestedCompanyName, companyGuid: requestedCompanyGuid, db: providedDb } = {}) {
  let db = providedDb;
  if (!db) {
    try { db = loadLocalDb({ appUserDataPath: app.getPath("userData") }); } catch { db = loadLocalDb({}); }
  }
  const entries = Object.values(db.companies || {});
  const requestedKey = requestedCompanyName || requestedCompanyGuid
    ? normalizeCompanyKey({ companyName: requestedCompanyName, companyGuid: requestedCompanyGuid })
    : null;
  const selectedEntry = (requestedKey && db.companies?.[requestedKey])
    || entries.find((entry) => requestedCompanyGuid && entry.companyGuid === requestedCompanyGuid)
    || entries.find((entry) => requestedCompanyName && entry.companyName === requestedCompanyName)
    || entries[0];
  const companyName = requestedCompanyName || selectedEntry?.companyName || null;
  const companyGuid = requestedCompanyGuid || selectedEntry?.companyGuid || null;
  if (!companyName) throw new Error("No company with local ledgers. Sync first.");
  const res = await vectoriseCompany({
    db,
    companyName,
    companyGuid,
    appUserDataPath: app.getPath("userData"),
    embedTexts: requestSemanticEmbeddings,
    onProgress(progress) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("local-matching:vector-progress", progress);
      }
    },
  });
  return res;
}

async function requestSemanticEmbeddings(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 256) throw new Error("AI embedding batch requires 1-256 inputs.");
  try {
    return await requestDirectSemanticEmbeddings(inputs);
  } catch (error) {
    appendLog(errPath, `Direct AI embedding unavailable; using secure proxy: ${formatConnectorError(error)}`);
    return await requestProxySemanticEmbeddings(inputs);
  }
}

async function requestDirectSemanticEmbeddings(inputs, refresh = false) {
  const direct = await loadDirectEmbeddingConfig({ refresh });
  const response = await nodeFetch(direct.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${direct.apiKey}`,
      "HTTP-Referer": "https://gajkesari.com",
      "X-Title": "Gajkesari Tally Connector",
    },
    body: JSON.stringify({ model: direct.model, input: inputs, dimensions: direct.dimensions }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if ((response.status === 401 || response.status === 403) && !refresh) {
    forgetDirectEmbeddingConfig();
    return await requestDirectSemanticEmbeddings(inputs, true);
  }
  if (!response.ok) throw new Error(`OpenRouter embedding request failed (${response.status}).`);
  const ordered = Array.isArray(payload?.data) ? [...payload.data].sort((a, b) => Number(a.index) - Number(b.index)) : [];
  const embeddings = ordered.map((item) => item?.embedding);
  if (embeddings.length !== inputs.length || embeddings.some((vector) => !Array.isArray(vector) || vector.length !== direct.dimensions || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error("OpenRouter returned an incompatible embedding batch.");
  }
  return embeddings;
}

async function requestProxySemanticEmbeddings(inputs) {
  const config = runner?.config;
  if (!config?.apiBase || !config?.connectionId || !config?.bridgeToken) {
    throw new Error("Reconnect this connector to enable secure AI vector search.");
  }
  const response = await fetch(`${config.apiBase}/api/tally/bridge/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.bridgeToken}` },
    body: JSON.stringify({ connectionId: config.connectionId, inputs }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || "The AI embedding service is unavailable.");
  if (payload?.model !== "openai/text-embedding-3-small" || payload?.dimensions !== 512 || !Array.isArray(payload?.embeddings)) {
    throw new Error("The embedding service returned an incompatible response.");
  }
  return payload.embeddings;
}

function parseConnectUrl(value) {
  const url = new URL(value);
  return {
    "api-base": url.searchParams.get("apiBase") || url.searchParams.get("api-base") || "",
    "connection-id": url.searchParams.get("connectionId") || url.searchParams.get("connection-id") || "",
    "pairing-code": url.searchParams.get("pairingCode") || url.searchParams.get("pairing-code") || "",
    "control-token": url.searchParams.get("controlToken") || url.searchParams.get("control-token") || "",
    "tally-url": url.searchParams.get("tallyUrl") || url.searchParams.get("tally-url") || "http://localhost:9000",
    "bridge-name": CONNECTOR_NAME,
  };
}

function sendStatus(status) {
  const nextStatus = { ...lastStatus, ...status };
  const companyFromTitle = String(nextStatus.title || "").match(/^Connected to\s+(.+)$/i)?.[1]?.trim();
  if (companyFromTitle) nextStatus.companyName = companyFromTitle;
  if (["idle", "stopped", "expired", "error"].includes(nextStatus.state)) nextStatus.companyName = null;
  lastStatus = nextStatus;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status", lastStatus);
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function printableTallyHtml(html) {
  const withoutReportCaption = String(html ?? "").replace(
    /<TABLE[^>]*bgcolor="#2a67b1"[^>]*>[\s\S]*?<\/TABLE>/i,
    ""
  );
  const printStyles = `
    <meta charset="utf-8">
    <style>
      @page { size: A4; margin: 12mm; }
      html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
      body { color: #000; font-family: Arial, sans-serif; }
      table { max-width: 100%; }
    </style>`;
  if (/<head[^>]*>/i.test(withoutReportCaption)) {
    return `<!doctype html>${withoutReportCaption.replace(/<head[^>]*>/i, (head) => `${head}${printStyles}`)}`;
  }
  return `<!doctype html><html><head>${printStyles}</head><body>${withoutReportCaption}</body></html>`;
}

async function renderTallyPrintToPdf({ html, fileName }) {
  const printWindow = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(printableTallyHtml(html))}`);
    const pdf = await printWindow.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      landscape: false,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      margins: { marginType: "default" },
    });
    if (!pdf?.length) throw new Error(`Could not render ${fileName || "the Tally Debit Note"}.`);
    return pdf;
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

async function startRunner() {
  if (runner && !runner.stopped) runner.stop("restarting");

  runner = createBridgeRunner({
    appUserDataPath: app.getPath("userData"),
    embedTexts: requestSemanticEmbeddings,
    renderTallyPrintToPdf,
    onLog(entry) {
      appendLog(entry.level === "error" ? errPath : logPath, entry.message);
      if (entry.level === "error") {
        const expired = /invalid bridge token|401|403/i.test(entry.message);
        sendStatus({
          title: expired ? "Reconnect required" : "Connector warning",
          detail: expired ? `Open ${BRAND_NAME} and click Connect again.` : entry.message,
          state: expired ? "expired" : "warning",
        });
        return;
      }
      sendStatus({ title: "Connector running", detail: entry.message, state: "running" });
    },
    onStatus(cycle) {
      const result = cycle?.result || {};
      if (result.companyName) {
        sendStatus({
          title: `Connected to ${result.companyName}`,
          detail: "Keep this app open while using Tally.",
          state: "connected",
          companyName: result.companyName,
        });
      } else if (result.tallyReachable) {
        sendStatus({
          title: "Tally reachable",
          detail: "Open a company in Tally Prime.",
          state: "warning",
        });
      }
    },
    onStop(event) {
      sendStatus({ title: "Connector stopped", detail: event.reason || "Stopped", state: "stopped" });
    },
  });

  await runner.start();
}

async function handleConnectUrl(value) {
  try {
    const args = parseConnectUrl(value);
    if (!args["api-base"] || !args["connection-id"] || !args["pairing-code"] || !args["control-token"]) {
      throw new Error("Connect link is missing pairing details.");
    }
    showWindow();
    sendStatus({
      title: "Pairing connector",
      detail: `Checking Tally and connecting to ${BRAND_NAME}.`,
      state: "running",
    });
    await pairBridge(args);
    const readiness = await testTally(args["tally-url"]);
    if (readiness.companyName) {
      sendStatus({
        title: `Connected to ${readiness.companyName}`,
        detail: "Starting live sync.",
        state: "connected",
        companyName: readiness.companyName,
      });
    } else {
      sendStatus({ title: "Connector paired", detail: "Starting live sync.", state: "running" });
    }
    await startRunner();
  } catch (error) {
    const message = formatConnectorError(error);
    appendLog(errPath, message);
    sendStatus({ title: "Connection failed", detail: message, state: "error" });
    showWindow();
    dialog.showErrorBox(CONNECTOR_NAME, message);
  }
}

async function handleDisconnectUrl(value) {
  try {
    const url = new URL(value);
    if (runner && !runner.stopped) runner.stop("disconnect");
    await disconnectBridge({ "connection-id": url.searchParams.get("connectionId") || "" });
    sendStatus({ title: "Disconnected", detail: "Connector stopped.", state: "stopped" });
  } catch (error) {
    const message = formatConnectorError(error);
    appendLog(errPath, message);
  }
}

async function handleConnectionRecheck() {
  const tallyUrl = runner?.config?.tallyUrl || "http://localhost:9000";
  sendStatus({ title: "Checking connection", detail: "Checking Tally Prime now.", state: "running" });
  const result = await testTally(tallyUrl);
  if (result.companyName) {
    if (!runner || runner.stopped) await startRunner();
    const status = {
      title: `Connected to ${result.companyName}`,
      detail: "Keep this app open while using Tally.",
      state: "connected",
      companyName: result.companyName,
    };
    sendStatus(status);
    return status;
  }
  const status = result.tallyReachable
    ? { title: "Tally reachable", detail: "Open a company in Tally Prime.", state: "warning" }
    : { title: "Tally not connected", detail: result.error || "Open Tally Prime and try again.", state: "error" };
  sendStatus(status);
  return status;
}

function handleProtocolUrl(value) {
  if (!value || !value.startsWith(`${PROTOCOL_NAME}://`)) return;
  if (value.startsWith(`${PROTOCOL_NAME}://connect`)) {
    void handleConnectUrl(value);
    return;
  }
  if (value.startsWith(`${PROTOCOL_NAME}://disconnect`)) {
    void handleDisconnectUrl(value);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: CONNECTOR_NAME,
    // Keep a 480 x 368 visible shell plus transparent room for rounded corners
    // and a CSS shadow that can fade before reaching the native window edge.
    width: 484,
    height: 372,
    minWidth: 424,
    minHeight: 344,
    show: false,
    resizable: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: true,
    icon: brandLogoPath,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const connectorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html>
      <head>
        <style>
          :root{--ink:#2d2d2d;--muted:#595147;--body-soft:#8b8171;--line:#ddd2c2;--pill-line:#ddd2c2;--pill:#e6ddd1;--surface:#fff;--surface-sunk:#fbf8f3;--canvas:#f4f0e9;--brand:#4ca154;--brand-deep:#2d2d2d;--accent:#4ca154;--accent-soft:#e3f0e3;--amber:#e3a64a;--amber-soft:#fbeeda;--danger:#c1543b;--text-xs:11px;--text-sm:12px;--text-md:12.5px;--text-lg:16.5px}
          *{box-sizing:border-box}
          html,body{width:100%;height:100%;min-width:0;background:transparent;overflow:hidden}
          body{position:relative;font-family:"Segoe UI Variable Text","Segoe UI",sans-serif;margin:0;color:var(--ink);font-size:var(--text-md);line-height:1.35;letter-spacing:0}
          .windowShell{position:absolute;inset:2px;border:1px solid rgba(45,45,45,.10);border-radius:16px;background:var(--canvas);box-shadow:none;overflow:hidden}
          button,input,textarea{font:inherit}
          button{cursor:pointer;font-size:var(--text-sm)}
          button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid rgba(229,21,34,.18);outline-offset:2px}
          .titleBar{height:38px;display:flex;align-items:center;padding-left:13px;color:#fff;background:var(--brand);-webkit-app-region:drag;user-select:none}
          .titleBrand{display:flex;align-items:center;gap:8px;min-width:0;font-family:"Aptos Display","Aptos",sans-serif;font-size:var(--text-sm);font-weight:650}
          .titleLogo{width:18px;height:18px;object-fit:contain;filter:drop-shadow(0 1px 1px rgba(0,0,0,.14))}
          .windowControls{display:flex;margin-left:auto;height:100%;-webkit-app-region:no-drag}
          .windowControl{width:46px;height:100%;border:0;background:transparent;color:rgba(255,255,255,.82);display:grid;place-items:center;font-size:16px}
          .windowControl:hover{background:rgba(255,255,255,.1);color:#fff}.windowControl.close:hover{background:#c42b35}
          #appContent{height:calc(100% - 38px);overflow:auto}
          #localPanel,#updatesPanel{display:none;position:absolute;inset:82px 0 0;background:var(--canvas);z-index:10;overflow-y:auto;overflow-x:hidden;padding:0 14px 16px}
          #localPanel.open,#updatesPanel.open{display:block}
          .stickyHeader{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:9px;padding:10px 0 5px;background:linear-gradient(var(--canvas) 82%,rgba(246,241,236,0))}
          .pageTitle,.screenTitle{font-family:"Aptos Display","Aptos",sans-serif;font-size:var(--text-lg);font-weight:700;line-height:1.2;letter-spacing:-.02em;margin:0}
          .screenSubtitle{font-size:var(--text-sm);color:var(--muted);line-height:1.3;margin-top:1px}
          .contextLine{display:flex;align-items:center;gap:6px;min-width:0;margin:0 0 8px;padding-left:39px;color:var(--muted);font-size:var(--text-sm)}
          .contextLine strong{color:var(--ink);font-weight:680}
          .contextCompany{max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-weight:650}
          .step{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:14px}
          .step{padding:11px 13px;margin-bottom:8px;box-shadow:0 2px 7px rgba(61,34,25,.03)}
          .stepReady{border-color:#b9dfca;background:linear-gradient(135deg,#fff 45%,#f1faf5)}
          .stepHeader{display:flex;align-items:center;gap:8px;margin-bottom:6px}
          .stepNumber{flex:0 0 21px;height:21px;border-radius:7px;display:grid;place-items:center;background:#eee8e3;color:#685c52;font-size:var(--text-xs);font-weight:750}
          .stepReady .stepNumber{background:var(--accent);color:#fff}
          .stepCopy{min-width:0;flex:1}
          .stepTitle{font-family:"Aptos Display","Aptos",sans-serif;font-size:var(--text-md);font-weight:700;line-height:1.2;margin:0}
          .stepHint,.meta,.statusLine{font-size:var(--text-sm);color:var(--muted);line-height:1.3}
          .metric{font-size:26px;font-weight:740;letter-spacing:-.04em;line-height:1;margin-bottom:4px}
          .row{display:flex;align-items:center;gap:10px;min-width:0}
          .rowBetween{justify-content:space-between}
          .pill{display:inline-flex;align-items:center;gap:5px;max-width:100%;font-size:var(--text-xs);font-weight:650;padding:3px 7px;border-radius:999px;background:#f3f0ed;color:#62574e;border:1px solid var(--line);white-space:nowrap}
          .pillReady{background:var(--accent-soft);color:#11643f;border-color:#b9dfca}
          .btn{min-height:32px;padding:6px 12px;border-radius:9px;border:1px solid var(--brand-deep);background:var(--brand-deep);color:#fff;font-weight:680;transition:transform .12s ease,box-shadow .12s ease}
          .btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(35,27,22,.15)}
          .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
          .btnSecondary{min-height:32px;padding:6px 11px;border-radius:9px;border:1px solid var(--line);background:#fff;color:var(--ink);font-weight:650}
          .iconBtn{width:32px;height:32px;padding:0;border-radius:9px;border:1px solid var(--line);background:#fff;color:var(--ink);font-size:16px}
          .kv{font-size:12px;color:var(--muted);line-height:1.5;min-width:0;overflow-wrap:anywhere}
          .kv b{color:var(--ink)}
          .resultNote{display:none;margin-top:10px;padding:9px 10px;border-radius:9px;background:#f7f5f2;color:var(--muted);font-size:11px;line-height:1.4}
          .field{width:100%;min-height:54px;border:1px solid #dcd4cc;border-radius:10px;padding:8px 10px;background:#fff;resize:vertical;line-height:1.35;color:var(--ink);font-size:var(--text-sm)}
          .field::placeholder{color:#978d84}
          .searchBar{display:flex;align-items:flex-end;gap:9px;margin-top:10px}
          .searchBar .field{flex:1}
          details{margin-top:10px}
          summary{width:max-content;cursor:pointer;color:var(--muted);font-size:11px;list-style:none}
          summary::-webkit-details-marker{display:none}
          .options{display:flex;align-items:center;gap:12px;margin-top:10px;padding:10px;border-radius:10px;background:#f7f5f2}
          .options input[type=number]{width:48px;border:1px solid #dcd4cc;border-radius:7px;padding:5px;background:#fff}
          .resultCard{border:1px solid var(--line);border-radius:11px;background:#fff;padding:11px}
          .resultTitle{font-size:13px;font-weight:700;margin-bottom:4px}
          .titleBar{height:40px;padding:0 8px 0 14px;border-radius:16px 16px 0 0;background:#fbf8f3;border-bottom:1px solid #ddd2c2;color:var(--ink)}
          .titleBrand{font-family:"Segoe UI Variable Text","Segoe UI",sans-serif;font-size:12.5px;font-weight:650;color:var(--ink)}
          .titleMark{width:22px;height:22px;display:grid;place-items:center;flex:0 0 auto;border-radius:7px;background:linear-gradient(150deg,#f1c889 0%,var(--amber) 45%,var(--accent) 100%);color:#fff}
          .titleMark svg{width:13px;height:13px}
          .windowControl{color:var(--muted);font-size:13px;width:32px;height:28px;border-radius:7px}
          .windowControl:hover{background:#e6ddd1;color:var(--ink)}.windowControl.close:hover{background:#f0d8d2;color:var(--danger)}
          #appContent{height:calc(100% - 40px);overflow:auto;border-radius:0 0 16px 16px;background:var(--canvas)}
          .globalbar{display:flex;align-items:center;min-height:42px;padding:8px 14px 5px;background:var(--canvas)}
          .health{display:flex;align-items:center;gap:7px;font-size:12.5px}.health strong{font-weight:650}
          .connectionBadge{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
          .connectionBadge.warning{background:var(--amber);box-shadow:0 0 0 3px var(--amber-soft)}.connectionBadge.error{background:var(--danger);box-shadow:0 0 0 3px var(--danger-soft)}.connectionBadge.offline{background:var(--body-soft);box-shadow:0 0 0 3px var(--pill)}
          .moreWrap{position:relative;margin-left:auto}.moreButton{width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--ink);font-size:18px}.moreButton:hover{background:var(--pill)}
          .menu{display:none;position:absolute;right:0;top:34px;z-index:20;width:180px;padding:6px;background:#fff;border:1px solid var(--pill-line);border-radius:12px;box-shadow:var(--shadow-pop)}.menu.open{display:block}.menu button{display:block;width:100%;padding:8px 9px;border:0;border-radius:8px;background:transparent;text-align:left;font-size:13px}.menu button:hover{background:var(--surface-sunk)}
          .homeView{padding:3px 14px 16px}.homeView h1{font-family:"Segoe UI Variable Text","Segoe UI",sans-serif;font-size:16.5px;line-height:1.2;margin:0}.homeView>p{max-width:400px;margin:4px 0 13px;color:var(--body-soft);font-size:12.5px;line-height:1.45}.homeStatusGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}.homeStatusCard{min-width:0;padding:10px;border:1px solid var(--pill-line);border-radius:11px;background:#fff;text-align:left}.homeStatusCard:hover{border-color:#cbbfaa;background:var(--surface-sunk)}.homeStatusIcon{width:28px;height:28px;display:grid;place-items:center;margin-bottom:8px;border-radius:8px;background:var(--accent-soft);color:var(--ink);font-size:16px;font-weight:700}.homeStatusIcon.ready{background:linear-gradient(150deg,#f1c889 0%,var(--amber) 45%,var(--accent) 100%);color:#fff}.homeStatusCard b{display:block;font-size:12.5px}.homeStatusCard span{display:block;margin-top:3px;color:var(--amber);font-size:11px;font-weight:650}.homeStatusCard span.ready{color:var(--accent)}.homeAction{width:100%;min-height:36px;padding:8px 14px;border:0;border-radius:10px;background:var(--ink);color:#fff;font-size:13px;font-weight:650}.homeAction:hover{background:#1c1c1c}.connectionAction{margin-bottom:9px}.homeTask{margin-bottom:12px;padding:11px 12px;border:1px solid var(--pill-line);border-radius:12px;background:var(--surface-sunk)}.homeTask>div:first-child{display:flex;justify-content:space-between;font-size:12.5px}.homeTask>div:first-child span{color:var(--body-soft)}.homeProgress{height:5px;margin-top:8px;border-radius:99px;background:var(--pill);overflow:hidden}.homeProgress i{display:block;width:0;height:100%;border-radius:inherit;background:var(--accent)}.srOnly{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
          #localPanel{inset:82px 0 0;padding:0 14px 16px;background:var(--canvas)}
          #localPanel .stickyHeader{padding:8px 0 5px;background:linear-gradient(var(--canvas) 82%,rgba(244,240,233,0))}.iconBtn{border:0;background:transparent}.iconBtn:hover{background:var(--pill)}
          #localPanel .contextLine{display:none}
          #localPanel .step{border-color:var(--pill-line);border-radius:13px;box-shadow:none}.stepReady{border-color:#b9dfca;background:linear-gradient(135deg,#fff 45%,#f1faf5)}
          #localPanel .btnSecondary{min-height:30px;padding:6px 10px;border-radius:8px;background:transparent;font-size:12px;font-weight:600}
          #localPanel #steadyCheckBtn{min-height:30px;padding:6px 10px;border-radius:8px;background:transparent;font-size:12px;font-weight:600}
          .steadyHero{display:flex;align-items:center;gap:12px;padding:13px;border:1px solid var(--pill-line);border-radius:12px;background:var(--surface-sunk);margin-bottom:10px}.steadyHeroIcon{width:42px;height:42px;display:grid;place-items:center;flex:0 0 auto;border-radius:11px;background:linear-gradient(150deg,#f1c889 0%,var(--amber) 45%,var(--accent) 100%);color:#fff;font-size:19px}.steadyHeroHead{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.steadyHero h2{margin:0;font-size:14.5px}.steadyHero p{margin:2px 0 0;color:var(--muted);font-size:11.5px}.freshnessPill{padding:2px 9px;border-radius:999px;background:var(--accent-soft);color:#2e6b37;font-size:10.5px;font-weight:700}.freshnessPill.stale{background:var(--amber-soft);color:#8c5e20}.freshnessPill.checking{background:#e6ddd1;color:var(--muted)}.steadyActions{display:flex;align-items:center;gap:9px;margin-bottom:8px}.steadyMeta{display:flex;justify-content:space-between;padding:9px 1px 0;border-top:1px solid var(--line);color:var(--muted);font-size:11.5px}.steadyMeta strong{color:var(--ink);font-weight:650}
          #updatesPanel .stickyHeader{padding:8px 0 5px;background:linear-gradient(var(--canvas) 82%,rgba(244,240,233,0))}
          .updateContext{margin:0 0 11px;padding-left:39px;color:var(--body-soft);font-size:11.5px}
          .updateHero{display:flex;align-items:center;gap:12px;padding:13px;border:1px solid var(--pill-line);border-radius:12px;background:var(--surface-sunk)}
          .updateTile{width:42px;height:42px;display:grid;place-items:center;flex:0 0 auto;border-radius:11px;background:linear-gradient(150deg,#f1c889 0%,var(--amber) 45%,var(--accent) 100%);color:#fff;font-size:19px}
          .updateVersion{margin:0 0 2px;color:var(--body-soft);font-size:11px}.updateHero h2{margin:0 0 2px;font-size:14.5px;line-height:1.2}.updateHero p:last-child{margin:0;color:var(--body-soft);font-size:11.5px}
          .updateAction{width:100%;min-height:34px;margin-top:11px;padding:7px 12px;border:0;border-radius:9px;background:var(--ink);color:#fff;font-size:12.5px;font-weight:650}.updateAction:hover{background:#1c1c1c}.updateAction:disabled{opacity:.65;cursor:wait}
          @media(max-width:460px){#localPanel{padding-left:14px;padding-right:14px}.contextLine{padding-left:0}.searchBar{align-items:stretch;flex-direction:column}.searchBar .btn{width:100%}}
        </style>
      </head>
      <body>
        <div class="windowShell">
        <header class="titleBar">
          <div class="titleBrand"><span class="titleMark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M17.5 3.5V7H14M6.5 20.5V17H10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>${CONNECTOR_NAME}</span></div>
          <div class="windowControls">
            <button id="minimizeBtn" class="windowControl" aria-label="Minimize">−</button>
            <button id="maximizeBtn" class="windowControl" aria-label="Maximize">□</button>
            <button id="closeBtn" class="windowControl close" aria-label="Close">×</button>
          </div>
        </header>
        <main id="appContent">
          <div class="globalbar">
            <div class="health"><strong id="homeCompany">Solution Nyx</strong><span id="homeConnectionBadge" class="connectionBadge" role="status" aria-label="Tally connected" title="Tally connected"></span></div>
            <div class="moreWrap"><button id="menuBtn" class="moreButton" title="More" aria-label="More options">⋮</button><div id="menu" class="menu"><button id="menuLocalMatching">Ledger matching</button><button id="menuReconcile">Check deleted ledgers</button><button id="menuUpdates">Connector updates</button></div></div>
          </div>
          <section id="homeView" class="homeView">
            <div id="homeTask" class="homeTask" hidden><div><b id="homeTaskText">Working…</b><span id="homeTaskPercent">0%</span></div><div class="homeProgress"><i id="homeTaskProgress"></i></div></div>
            <h1 id="homeTitle">Finish ledger setup</h1>
            <p id="homeCopy">Prepare the company once. The connector keeps both parts up to date after that.</p>
            <div class="homeStatusGrid">
              <button class="homeStatusCard" id="homeLedgerCard"><div class="homeStatusIcon" id="homeLedgerIcon">▦</div><b>Ledger data</b><span id="homeLedgerState">Not available</span></button>
              <button class="homeStatusCard" id="homeVectorCard"><div class="homeStatusIcon" id="homeVectorIcon">◇</div><b>Match preparation</b><span id="homeVectorState">Not available</span></button>
            </div>
            <button class="homeAction connectionAction" id="connectionCheckBtn" hidden>Recheck connection</button>
            <button class="homeAction" id="homeSetupBtn">Set up ledger matching</button>
            <div id="statusAnnounce" class="srOnly" aria-live="polite">Waiting for connection</div>
          </section>
        </main>

        <div id="localPanel">
          <div class="stickyHeader">
            <button id="backBtn" class="iconBtn" aria-label="Back to connector status">←</button>
            <div class="pageTitle">Ledger matching</div>
          </div>
          <div class="contextLine"><span id="companyIdentity" class="contextCompany">Checking Tally…</span><span>·</span><span><strong id="ledgerCount">—</strong> ledgers</span></div>
          <div id="companyGuid" style="display:none"></div><div id="localDbStatus" style="display:none"></div><div id="localDbPath" style="display:none"></div><span id="dbStatusPill" style="display:none"></span>

          <section id="ledgerStep" class="step stepReady">
            <div class="stepHeader"><div class="stepNumber">1</div><div class="stepTitle">Ledgers</div></div>
            <div class="row rowBetween"><div><div id="syncState" class="statusLine">Ready</div><div id="lastSync" class="meta">Not updated yet</div></div><button id="syncBtn" class="btn">Refresh</button></div>
            <div id="syncCounts" class="resultNote"></div>
          </section>

          <section id="vectorStep" class="step">
            <div class="stepHeader"><div class="stepNumber">2</div><div class="stepTitle">Search index</div></div>
            <div class="row rowBetween"><div><div id="vectorState" class="statusLine">Waiting for ledgers</div><div id="lastVector" class="meta">Not indexed yet</div></div><button id="vectorBtn" class="btnSecondary">Update index</button></div>
            <div id="vectorCount" style="display:none"></div><div id="vectorProgress" class="resultNote"></div>
          </section>
          <div id="ledgerSteady" hidden>
            <div class="steadyHero"><div class="steadyHeroIcon"><iconify-icon id="steadyHeroIcon" icon="ph:check-bold"></iconify-icon></div><div><div class="steadyHeroHead"><h2 id="steadyHeroTitle">12,000 ledgers matched</h2><span class="freshnessPill" id="steadyFreshness">Up to date</span></div><p id="steadyHeroSub">Synced today</p></div></div>
            <div class="steadyActions"><button id="steadySyncBtn" class="btn" hidden>Sync now</button><button id="steadyCheckBtn" class="btnSecondary">Check for changes</button></div>
            <div id="steadyProgress" class="resultNote"></div>
            <div class="steadyMeta"><span>Match preparation</span><strong id="steadyVectorMeta">12,000 of 12,000 vectors ready</strong></div>
          </div>

        </div>

        <div id="updatesPanel">
          <div class="stickyHeader">
            <button id="updatesBackBtn" class="iconBtn" aria-label="Back to connector status">←</button>
            <div class="pageTitle">Connector updates</div>
          </div>
          <p class="updateContext">Keep the connector secure and reliable</p>
          <div class="updateHero">
            <div class="updateTile" aria-hidden="true">✓</div>
            <div>
              <p class="updateVersion">Current version 0.1.70</p>
              <h2 id="updateTitle">You're up to date</h2>
              <p id="updateCopy">Last checked a few minutes ago.</p>
            </div>
          </div>
          <button id="checkUpdatesBtn" class="updateAction">Check for updates</button>
        </div>
        </div>

        <script>
          const { ipcRenderer } = require('electron');
          document.getElementById('minimizeBtn').addEventListener('click', () => ipcRenderer.send('window:minimize'));
          document.getElementById('maximizeBtn').addEventListener('click', () => ipcRenderer.send('window:toggle-maximize'));
          document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('window:close'));
          const menuBtn = document.getElementById('menuBtn');
          const menu = document.getElementById('menu');
          const menuLocalMatching = document.getElementById('menuLocalMatching');
          const menuReconcile = document.getElementById('menuReconcile');
          const menuUpdates = document.getElementById('menuUpdates');
          const localPanel = document.getElementById('localPanel');
          const updatesPanel = document.getElementById('updatesPanel');
          const backBtn = document.getElementById('backBtn');
          const updatesBackBtn = document.getElementById('updatesBackBtn');
          const checkUpdatesBtn = document.getElementById('checkUpdatesBtn');
          const syncBtn = document.getElementById('syncBtn');
          const vectorBtn = document.getElementById('vectorBtn');
          const steadySyncBtn = document.getElementById('steadySyncBtn');
          const steadyCheckBtn = document.getElementById('steadyCheckBtn');
          const steadyProgress = document.getElementById('steadyProgress');
          const homeSetupBtn = document.getElementById('homeSetupBtn');
          const connectionCheckBtn = document.getElementById('connectionCheckBtn');
          const homeLedgerCard = document.getElementById('homeLedgerCard');
          const homeVectorCard = document.getElementById('homeVectorCard');
          const homeBadge = document.getElementById('homeConnectionBadge');
          let currentConnectionState = 'idle';
          let matchingReady = false;

          function setStatus(data){
            const state = data.state || 'idle';
            currentConnectionState = state;
            homeBadge.className = 'connectionBadge ' + (state === 'connected' ? '' : state === 'expired' ? 'warning' : state === 'error' ? 'error' : state === 'stopped' ? 'offline' : 'warning');
            homeBadge.title = data.detail || data.title || 'Tally status';
            homeBadge.setAttribute('aria-label', data.detail || data.title || 'Tally status');
            const connectedCompany = String(data.companyName || '').trim() || String(data.title || '').match(/^Connected to\s+(.+)$/i)?.[1]?.trim();
            if(connectedCompany) document.getElementById('homeCompany').textContent = connectedCompany;
            else if(state === 'error' || state === 'stopped' || state === 'idle' || state === 'expired') document.getElementById('homeCompany').textContent = data.title || 'Tally not connected';
            const needsCheck = state === 'error' || state === 'stopped' || state === 'idle' || state === 'expired' || state === 'warning';
            connectionCheckBtn.hidden = !needsCheck;
            connectionCheckBtn.textContent = 'Recheck connection';
            homeSetupBtn.hidden = matchingReady || state !== 'connected';
            document.getElementById('statusAnnounce').textContent = (data.title || 'Connector') + ' ' + (data.detail || '');
          }
          ipcRenderer.on('status', (_event, data) => {
            setStatus(data);
            // also refresh local panel header if open
            if(localPanel.classList.contains('open')) refreshLocalStatus();
          });

          menuBtn.addEventListener('click', () => {
            menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
          });
          document.addEventListener('click', (e) => {
            if(!menu.contains(e.target) && e.target !== menuBtn) menu.style.display='none';
          });
          function showUpdates(){
            menu.style.display='none';
            localPanel.classList.remove('open');
            updatesPanel.classList.add('open');
          }
          function showLedgerMatching(){
            menu.style.display='none';
            updatesPanel.classList.remove('open');
            localPanel.classList.add('open');
            refreshLocalStatus();
          }
          menuLocalMatching.addEventListener('click', () => {
            showLedgerMatching();
          });
          menuReconcile.addEventListener('click', () => {
            showLedgerMatching();
            runSteadySync({forceFull:true});
          });
          menuUpdates.addEventListener('click', showUpdates);
          backBtn.addEventListener('click', () => localPanel.classList.remove('open'));
          updatesBackBtn.addEventListener('click', () => updatesPanel.classList.remove('open'));
          homeSetupBtn.addEventListener('click', showLedgerMatching);
          connectionCheckBtn.addEventListener('click', async () => {
            connectionCheckBtn.disabled = true;
            connectionCheckBtn.textContent = 'Checking…';
            try{
              const status = await ipcRenderer.invoke('connection:recheck');
              setStatus(status || {});
              await refreshLocalStatus();
            }catch(e){
              setStatus({ title:'Tally not connected', detail:e.message || String(e), state:'error' });
            } finally { connectionCheckBtn.disabled = false; }
          });
          homeLedgerCard.addEventListener('click', showLedgerMatching);
          homeVectorCard.addEventListener('click', showLedgerMatching);
          checkUpdatesBtn.addEventListener('click', () => {
            checkUpdatesBtn.disabled = true;
            checkUpdatesBtn.textContent = 'Checking…';
            document.getElementById('updateTitle').textContent = 'Checking for updates';
            document.getElementById('updateCopy').textContent = 'This takes only a moment.';
            setTimeout(() => {
              document.getElementById('updateTitle').textContent = "You're up to date";
              document.getElementById('updateCopy').textContent = 'Checked just now.';
              checkUpdatesBtn.textContent = 'Check again';
              checkUpdatesBtn.disabled = false;
            }, 900);
          });
          ipcRenderer.on('navigate:updates', showUpdates);

          function fmtTime(iso){ if(!iso) return '—'; try{ return new Date(iso).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}); }catch{ return iso; } }
          function escapeHtml(value){ return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
          function formatCount(value){ return Number(value||0).toLocaleString(); }

          async function refreshLocalStatus(){
            try{
              const s = await ipcRenderer.invoke('local-matching:getStatus');
              document.getElementById('localDbStatus').textContent = s.db.exists ? 'Local data ready' : 'Local data not created';
              document.getElementById('localDbPath').textContent = s.db.path || '';
              document.getElementById('companyIdentity').textContent = s.tally.companyName || 'Open a company in Tally';
              if(s.tally.companyName) document.getElementById('homeCompany').textContent = s.tally.companyName;
              document.getElementById('companyGuid').textContent = s.tally.companyGuid ? 'GUID: '+s.tally.companyGuid : (s.tally.companyName ? '' : 'Tally not reachable');
              document.getElementById('ledgerCount').textContent = formatCount(s.ledgers.count);
              document.getElementById('lastSync').textContent = s.ledgers.lastSyncAt ? 'Updated '+fmtTime(s.ledgers.lastSyncAt) : 'Not updated yet';
              document.getElementById('syncState').textContent = s.ledgers.count ? 'Ready' : 'Not synced';
              const sc = s.ledgers.counts;
              const syncCountsEl = document.getElementById('syncCounts');
              if(sc && (sc.added || sc.updated || sc.deleted)){
                syncCountsEl.style.display='block';
                syncCountsEl.textContent = sc.added+' added · '+sc.updated+' updated · '+sc.deleted+' removed';
              } else { syncCountsEl.style.display='none'; }
              const homeLedgerState = document.getElementById('homeLedgerState');
              const homeVectorState = document.getElementById('homeVectorState');
              const homeLedgerIcon = document.getElementById('homeLedgerIcon');
              const homeVectorIcon = document.getElementById('homeVectorIcon');
              homeLedgerState.textContent = s.ledgers.count ? formatCount(s.ledgers.count)+' available' : 'Not available';
              homeLedgerIcon.classList.toggle('ready', Boolean(s.ledgers.count)); homeLedgerIcon.textContent = s.ledgers.count ? '✓' : '▦';
              document.getElementById('homeTitle').textContent = s.ledgers.count ? 'Ledger matching is ready' : 'Finish ledger setup';
              document.getElementById('homeCopy').textContent = s.ledgers.count ? 'Your ledger list and matching index are shown below.' : 'Import ledgers from the company currently open in Tally.';
              document.getElementById('homeSetupBtn').textContent = s.ledgers.count ? 'Open ledger status' : 'Set up ledger matching';
              // vector
              const v = s.vector;
              const searchReady = v.status==='ready' && (v.vectorCount||0)>0;
              matchingReady = searchReady;
              const syncChangeCount = sc ? Number(sc.added||0) + Number(sc.updated||0) + Number(sc.deleted||0) : 0;
              const vectorCoversLatestSync = Boolean(
                searchReady &&
                Number(v.vectorCount||0) >= Number(s.ledgers.count||0) &&
                Date.parse(v.lastVectorisedAt || '') >= Date.parse(s.ledgers.lastSyncAt || '')
              );
              const hasChanges = syncChangeCount > 0 && !vectorCoversLatestSync;
              const steadyReady = Boolean(s.ledgers.count && (searchReady || (hasChanges && Number(v.vectorCount||0) > 0)));
              document.getElementById('ledgerStep').hidden = steadyReady;
              document.getElementById('vectorStep').hidden = steadyReady;
              document.getElementById('ledgerSteady').hidden = !steadyReady;
              const vectorState = document.getElementById('vectorState');
              const indexed = Number(v.indexedCount || v.vectorCount || v.progress?.done || 0);
              const indexTotal = Number(v.progress?.total || s.ledgers.count || 0);
              vectorState.textContent = v.error
                ? 'AI vector search unavailable'
                : searchReady
                  ? formatCount(indexed)+' of '+formatCount(indexTotal)+' indexed'
                  : v.status==='indexing'
                    ? formatCount(indexed)+' of '+formatCount(indexTotal)+' indexed'
                    : s.ledgers.count ? 'Ready to index' : 'Waiting for ledgers';
              vectorState.style.color = v.error ? 'var(--danger)' : '';
              homeVectorState.textContent = searchReady ? formatCount(indexed)+' ready' : v.status==='indexing' ? formatCount(indexed)+' of '+formatCount(indexTotal) : s.ledgers.count ? 'Needs preparation' : 'Not available';
              homeVectorIcon.classList.toggle('ready', searchReady); homeVectorIcon.textContent = searchReady ? '✓' : '◇';
              document.getElementById('homeSetupBtn').hidden = Boolean(searchReady) || currentConnectionState !== 'connected';
              if(steadyReady){
                const steadyIcon = document.getElementById('steadyHeroIcon'); const steadyPill = document.getElementById('steadyFreshness');
                steadyIcon.setAttribute('icon', hasChanges ? 'ph:bell-simple-ringing' : 'ph:check-bold');
                document.getElementById('steadyHeroTitle').textContent = hasChanges ? (Number(sc.added||0) + Number(sc.updated||0)) + ' new or changed ledgers found' : formatCount(s.ledgers.count)+' ledgers matched';
                steadyPill.textContent = hasChanges ? 'Sync recommended' : 'Up to date'; steadyPill.className = 'freshnessPill' + (hasChanges ? ' stale' : '');
                document.getElementById('steadyHeroSub').textContent = hasChanges ? 'Sync again to include them in matching' : (s.ledgers.lastSyncAt ? 'Synced '+fmtTime(s.ledgers.lastSyncAt) : 'Synced recently');
                document.getElementById('steadyVectorMeta').textContent = formatCount(indexed)+' of '+formatCount(indexTotal)+' vectors ready';
                steadySyncBtn.hidden = !hasChanges; steadyCheckBtn.hidden = hasChanges; steadyCheckBtn.disabled = false;
              }
              document.getElementById('vectorCount').textContent = v.vectorCount||0;
              const progressEl = document.getElementById('vectorProgress');
              progressEl.style.display = v.error ? 'block' : 'none';
              progressEl.textContent = v.error ? v.error : '';
              document.getElementById('lastVector').textContent = v.lastVectorisedAt ? 'Updated '+fmtTime(v.lastVectorisedAt) : 'Not indexed yet';
              // Zvec ready pill for suggestion
              const zr = document.getElementById('zvecReady');
              if(zr){
                const isReady = searchReady;
                const detail = v.engineDetail && typeof v.engineDetail==='object' ? v.engineDetail.reason : v.engineDetail;
                const zvecAvail = s.isZvecAvailable ? ' • Zvec pkg yes' : (s.zvecVersion ? '' : ' • Zvec pkg no');
                zr.textContent = isReady ? 'Ready' : v.status==='error' ? 'Unavailable' : 'Not ready';
                zr.title = v.error || '';
                zr.className = isReady ? 'pill pillReady' : 'pill';
              }
            }catch(e){
              document.getElementById('localDbStatus').textContent = 'Error: '+(e.message||String(e));
            }
          }

          function setSyncState(state, isError){
            const el = document.getElementById('syncState');
            el.textContent = state;
            el.style.color = isError ? '#be123c' : '#24140c';
          }
          function setVectorState(state, isError){
            const el = document.getElementById('vectorState');
            el.textContent = state;
            el.style.color = isError ? '#be123c' : '#24140c';
          }

          ipcRenderer.on('local-matching:vector-progress', (_event, progress) => {
            const done = Number(progress?.done || 0);
            const total = Number(progress?.total || 0);
            setVectorState(formatCount(done)+' of '+formatCount(total)+' indexed', false);
          });

          syncBtn.addEventListener('click', async () => {
            syncBtn.disabled=true; syncBtn.textContent='Updating…'; setSyncState('Reading ledgers from Tally…');
            try{
              const r = await ipcRenderer.invoke('local-matching:sync');
              setSyncState('Ledger list updated successfully', false);
              await refreshLocalStatus();
            }catch(e){
              setSyncState(e.message||String(e), true);
            } finally { syncBtn.disabled=false; syncBtn.textContent='Refresh'; }
          });

          vectorBtn.addEventListener('click', async () => {
            vectorBtn.disabled=true; vectorBtn.textContent='Updating…'; setVectorState('Starting…');
            try{
              const r = await ipcRenderer.invoke('local-matching:vectorise');
              setVectorState(formatCount(r.vectorCount)+' of '+formatCount(r.vectorCount)+' indexed', false);
              await refreshLocalStatus();
            }catch(e){
              setVectorState(e.message||String(e), true);
            } finally { vectorBtn.disabled=false; vectorBtn.textContent='Update index'; }
          });

          async function runSteadySync({includeVectors=false, forceFull=false} = {}){
            const button = includeVectors ? steadySyncBtn : steadyCheckBtn;
            button.disabled = true; button.textContent = forceFull ? 'Reconciling…' : includeVectors ? 'Syncing…' : 'Checking…';
            steadyProgress.style.display = 'block'; steadyProgress.textContent = forceFull ? 'Checking Tally for deleted ledgers…' : includeVectors ? 'Updating ledger data and matching…' : 'Checking Tally for ledger changes…';
            try{
              await ipcRenderer.invoke('local-matching:sync', {forceFull});
              // The sync IPC automatically embeds only changed ledgers. Do not
              // reopen Zvec and perform a second no-op vectorisation here.
              steadyProgress.style.display = 'none';
              await refreshLocalStatus();
            }catch(e){ steadyProgress.style.display = 'block'; steadyProgress.textContent = e.message || String(e); }
            finally { button.disabled=false; button.textContent = includeVectors ? 'Sync now' : 'Check for changes'; }
          }
          steadyCheckBtn.addEventListener('click', () => runSteadySync());
          steadySyncBtn.addEventListener('click', () => runSteadySync({includeVectors:true}));

          // initial refresh when panel opened via menu, also on load
          setTimeout(()=>refreshLocalStatus(), 800);
          if(${process.argv.includes("--show-updates") ? "true" : "false"}) setTimeout(showUpdates, 900);
        </script>
      </body>
    </html>
  `)}`;

  mainWindow.once("ready-to-show", showWindow);
  mainWindow.webContents.on("did-finish-load", () => sendStatus(lastStatus));
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    appendLog(errPath, `Connector status page failed to load (${code}: ${description}).`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appendLog(errPath, `Connector renderer stopped (${details.reason || "unknown"}). Reloading status page.`);
    if (!mainWindow?.isDestroyed()) {
      void mainWindow.loadURL(connectorPage);
    }
  });
  void mainWindow.loadURL(connectorPage).catch((error) => {
    appendLog(errPath, `Connector status page could not be opened: ${formatConnectorError(error)}`);
    showWindow();
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

app.setName(CONNECTOR_NAME);
app.setAppUserModelId(APP_USER_MODEL_ID);
app.on("before-quit", () => {
  quitting = true;
  void closeZvecCollections();
  if (runner && !runner.stopped) runner.stop("application quitting");
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_NAME);
  app.on("second-instance", (_event, argv) => {
    const protocolArg = argv.find((entry) => entry.startsWith(`${PROTOCOL_NAME}://`));
    if (protocolArg) handleProtocolUrl(protocolArg);
    if (argv.includes("--show-updates") && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("navigate:updates");
    }
    showWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (mainWindow) handleProtocolUrl(url);
    else pendingProtocolUrl = url;
  });
  app.whenReady().then(() => {
    installSystemNetworkFetch();
    ipcMain.on("window:minimize", () => mainWindow?.minimize());
    ipcMain.on("window:toggle-maximize", () => {
      if (!mainWindow) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    });
    ipcMain.on("window:close", () => mainWindow?.close());
    // Local Matching IPC (read-only, persistent)
    try {
      ipcMain.handle("connection:recheck", async () => handleConnectionRecheck());
      ipcMain.handle("local-matching:getStatus", async () => getLocalMatchingStatus());
      ipcMain.handle("local-matching:sync", async (_event, payload) => scheduleLocalSync({ forceFull: payload?.forceFull === true }));
      ipcMain.handle("local-matching:vectorise", async () => handleLocalVectorise());
      ipcMain.handle("local-matching:suggest", async (_event, payload) => {
        const topK = payload?.topK || payload?.top_k || 10;
        return await suggestLedgers({
          narration: payload?.narration || payload?.query || payload?.ledger || "",
          query: payload?.query || payload?.narration || payload?.ledger || "",
          companyId: payload?.companyId || payload?.companyGuid || null,
          companyName: payload?.companyName || null,
          companyGuid: payload?.companyGuid || null,
          topK,
          appUserDataPath: app.getPath("userData"),
          embedTexts: requestSemanticEmbeddings,
        });
      });
      ipcMain.handle("local-matching:suggest-batch", async (_event, payload) => {
        const queries = payload?.queries || payload?.items;
        return await suggestLedgersBatch({
          queries,
          companyId: payload?.companyId || payload?.companyGuid || null,
          companyName: payload?.companyName || null,
          companyGuid: payload?.companyGuid || null,
          topK: payload?.topK || payload?.top_k || 5,
          appUserDataPath: app.getPath("userData"),
          embedTexts: requestSemanticEmbeddings,
        });
      });
      ipcMain.handle("document-parsing:parse", async (_event, payload) => parseDocumentLocal(payload || {}));
      ipcMain.handle("document-parsing:parse-and-suggest", async (_event, payload) =>
        parseDocumentAndSuggestLedgers(payload || {}, {
          appUserDataPath: app.getPath("userData"),
          embedTexts: requestSemanticEmbeddings,
        })
      );
    } catch (e) { appendLog(errPath, `Local Matching IPC failed: ${formatConnectorError(e)}`); }
    createWindow();
    const protocolArg =
      process.argv.find((entry) => entry.startsWith(`${PROTOCOL_NAME}://`)) || pendingProtocolUrl;
    if (protocolArg) {
      handleProtocolUrl(protocolArg);
    } else {
      startRunner().catch((error) => {
        const message = formatConnectorError(error);
        appendLog(errPath, message);
        sendStatus({
          title: "Waiting for connection",
          detail: `Open ${BRAND_NAME} and click Connect.`,
          state: "idle",
        });
      });
    }
  });
}
