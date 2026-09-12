import { app, BrowserWindow, dialog, net, ipcMain, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pairBridge, createBridgeRunner, disconnectBridge } from "./src/bridge.mjs";
import { loadLocalDb, saveLocalDb, getLocalDbPaths, upsertLedgers, getStatusForCompany, getAllCompaniesStatus, normalizeCompanyKey } from "./src/local-matching/store.mjs";
import { vectoriseCompany, getVectorStatus, getVectorEngine, isZvecAvailable } from "./src/local-matching/vector.mjs";
import { syncLedgersReadOnly } from "./src/local-matching/sync.mjs";
import { suggestLedgers, suggestLedgersBatch } from "./src/local-matching/suggest.mjs";
import { parseDocumentLocal } from "./src/document-parsing/parser.mjs";
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
  return {
    db: { exists: dbExists, path: paths.dbPath, dir: paths.dir, version: db.version || 1 },
    tally: { companyName: tallyCompany, companyGuid: activeEntry?.companyGuid || activeStatus?.companyGuid || null, tallyUrl },
    ledgers: activeStatus ? { count: activeStatus.ledgerCount, lastSyncAt: activeStatus.lastSyncAt, counts: activeStatus.syncCounts, cursor: activeStatus.syncCursor } : { count: 0, lastSyncAt: null, counts: null, cursor: null },
    vector: activeStatus ? { ...activeStatus.vector, engineDetail: vectorEngine } : { status: "idle", lastVectorisedAt: null, vectorCount: 0, engine: vectorEngine.engine, engineDetail: vectorEngine },
    companies,
    isZvecAvailable: isZvecAvailable(),
    // For UI
    activeCompanyKey: activeKey || activeStatus?.companyKey || null,
  };
}

async function handleLocalSync() {
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

  const result = await syncLedgersReadOnly({
    tallyUrl,
    companyName,
    companyGuid,
    exportTallyCollection,
    helpers,
    getActiveCompany: async () => ({ companyName, companyGuid }),
  });

  // Upsert into persistent store
  const upsert = upsertLedgers({ db, companyName: result.companyName || companyName, companyGuid: result.companyGuid || companyGuid, ledgers: result.ledgers, cursor: result.cursor });
  saveLocalDb(db, { appUserDataPath: app.getPath("userData") });
  return { companyName: result.companyName || companyName, companyGuid: result.companyGuid || companyGuid, counts: upsert.counts, totalFetched: result.ledgers.length, isReadOnly: true };
}

async function handleLocalVectorise() {
  let db;
  try { db = loadLocalDb({ appUserDataPath: app.getPath("userData") }); } catch { db = loadLocalDb({}); }
  const status = getLocalMatchingStatus();
  const companyName = status.tally.companyName || (status.companies[0] && status.companies[0].companyName);
  const companyGuid = status.tally.companyGuid || (status.companies[0] && status.companies[0].companyGuid);
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
  lastStatus = { ...lastStatus, ...status };
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
    sendStatus({ title: "Connector paired", detail: "Starting live sync.", state: "running" });
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
    width: 540,
    height: 620,
    minWidth: 460,
    minHeight: 540,
    show: false,
    resizable: true,
    frame: false,
    icon: brandLogoPath,
    backgroundColor: "#f6f1ec",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const connectorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html>
      <head>
        <style>
          :root{--ink:#211916;--muted:#786b65;--line:#e7ddd6;--surface:#fffdfb;--canvas:#f6f1ec;--brand:#e51522;--brand-deep:#571016;--accent:#167a50;--accent-soft:#eaf7f0;--danger:#b42318}
          *{box-sizing:border-box}
          html,body{width:100%;min-width:0;overflow-x:hidden}
          body{font-family:"Aptos","Segoe UI Variable Text",sans-serif;margin:0;background:var(--canvas);color:var(--ink);font-size:13px;letter-spacing:.002em}
          button,input,textarea{font:inherit}
          button{cursor:pointer}
          button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid rgba(229,21,34,.18);outline-offset:2px}
          .titleBar{height:42px;display:flex;align-items:center;padding-left:14px;color:#fff;background:linear-gradient(105deg,#3a0c10 0%,#68131a 65%,#841820 100%);-webkit-app-region:drag;user-select:none}
          .titleBrand{display:flex;align-items:center;gap:9px;min-width:0;font-family:"Aptos Display","Aptos",sans-serif;font-size:12px;font-weight:650;letter-spacing:.01em}
          .titleLogo{width:20px;height:20px;object-fit:contain;filter:drop-shadow(0 1px 2px rgba(0,0,0,.18))}
          .windowControls{display:flex;margin-left:auto;height:100%;-webkit-app-region:no-drag}
          .windowControl{width:46px;height:100%;border:0;background:transparent;color:rgba(255,255,255,.82);display:grid;place-items:center;font-size:16px}
          .windowControl:hover{background:rgba(255,255,255,.1);color:#fff}.windowControl.close:hover{background:#c42b35}
          #appContent{height:calc(100vh - 42px);overflow:auto}
          #localPanel{display:none;position:absolute;inset:42px 0 0;background:var(--canvas);z-index:10;overflow-y:auto;overflow-x:hidden;padding:0 20px 20px}
          #localPanel.open{display:block}
          .stickyHeader{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:13px 0 7px;background:linear-gradient(var(--canvas) 82%,rgba(246,241,236,0))}
          .pageTitle{font-family:"Aptos Display","Aptos",sans-serif;font-size:20px;font-weight:700;letter-spacing:-.025em;margin:0}
          .contextLine{display:flex;align-items:center;gap:7px;min-width:0;margin:0 0 11px;padding-left:42px;color:var(--muted);font-size:12px}
          .contextLine strong{color:var(--ink);font-weight:680}
          .contextCompany{max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-weight:650}
          .step{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:14px}
          .step{padding:13px 15px;margin-bottom:10px;box-shadow:0 2px 8px rgba(61,34,25,.035)}
          .stepReady{border-color:#b9dfca;background:linear-gradient(135deg,#fff 45%,#f1faf5)}
          .stepHeader{display:flex;align-items:center;gap:9px;margin-bottom:8px}
          .stepNumber{flex:0 0 22px;height:22px;border-radius:7px;display:grid;place-items:center;background:#eee8e3;color:#685c52;font-size:11px;font-weight:750}
          .stepReady .stepNumber{background:var(--accent);color:#fff}
          .stepCopy{min-width:0;flex:1}
          .stepTitle{font-family:"Aptos Display","Aptos",sans-serif;font-size:14px;font-weight:700;line-height:1.2;margin:0;letter-spacing:-.01em}
          .stepHint,.meta,.statusLine{font-size:12px;color:var(--muted);line-height:1.35}
          .metric{font-size:26px;font-weight:740;letter-spacing:-.04em;line-height:1;margin-bottom:4px}
          .row{display:flex;align-items:center;gap:10px;min-width:0}
          .rowBetween{justify-content:space-between}
          .pill{display:inline-flex;align-items:center;gap:5px;max-width:100%;font-size:11px;font-weight:650;padding:4px 8px;border-radius:999px;background:#f3f0ed;color:#62574e;border:1px solid var(--line);white-space:nowrap}
          .pillReady{background:var(--accent-soft);color:#11643f;border-color:#b9dfca}
          .btn{min-height:34px;padding:7px 13px;border-radius:9px;border:1px solid var(--brand-deep);background:var(--brand-deep);color:#fff;font-weight:680;transition:transform .12s ease,box-shadow .12s ease}
          .btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(35,27,22,.15)}
          .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
          .btnSecondary{min-height:34px;padding:7px 11px;border-radius:9px;border:1px solid var(--line);background:#fff;color:var(--ink);font-weight:650}
          .iconBtn{width:36px;height:36px;padding:0;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink);font-size:18px}
          .kv{font-size:12px;color:var(--muted);line-height:1.5;min-width:0;overflow-wrap:anywhere}
          .kv b{color:var(--ink)}
          .resultNote{display:none;margin-top:10px;padding:9px 10px;border-radius:9px;background:#f7f5f2;color:var(--muted);font-size:11px;line-height:1.4}
          .field{width:100%;min-height:62px;border:1px solid #dcd4cc;border-radius:10px;padding:9px 11px;background:#fff;resize:vertical;line-height:1.4;color:var(--ink)}
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
          @media(max-width:460px){#localPanel{padding-left:14px;padding-right:14px}.contextLine{padding-left:0}.searchBar{align-items:stretch;flex-direction:column}.searchBar .btn{width:100%}}
        </style>
      </head>
      <body>
        <header class="titleBar">
          <div class="titleBrand"><img class="titleLogo" src="${brandLogoDataUrl}" alt=""><span>${CONNECTOR_NAME}</span></div>
          <div class="windowControls">
            <button id="minimizeBtn" class="windowControl" aria-label="Minimize">−</button>
            <button id="maximizeBtn" class="windowControl" aria-label="Maximize">□</button>
            <button id="closeBtn" class="windowControl close" aria-label="Close">×</button>
          </div>
        </header>
        <main id="appContent"><div style="padding:16px 20px 10px">
          <div style="display:flex;align-items:center;gap:11px;margin-bottom:12px">
            <img src="${brandLogoDataUrl}" alt="Gajkesari" style="width:38px;height:38px;object-fit:contain">
            <div style="flex:1">
              <h2 style="font-family:'Aptos Display','Aptos',sans-serif;margin:0;font-size:18px;letter-spacing:-.02em">${CONNECTOR_NAME}</h2>
              <div style="font-size:12px;color:var(--muted);margin-top:1px">Desktop bridge for Tally Prime</div>
            </div>
            <div style="position:relative">
              <button id="menuBtn" title="More" aria-label="More options" style="width:28px;height:32px;padding:0;border:0;background:transparent;color:var(--ink);font-size:22px;line-height:1">⋮</button>
              <div id="menu" style="display:none;position:absolute;right:0;top:38px;min-width:180px;background:#fff;border:1px solid #ded1c3;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.12);overflow:hidden;z-index:20">
                <button id="menuLocalMatching" style="width:100%;text-align:left;padding:10px 14px;background:#fff;border:0;font-size:13px">Local Matching</button>
              </div>
            </div>
          </div>
          <div id="card" style="border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:14px">
            <div id="title" style="font-size:15px;font-weight:650">Waiting for connection</div>
            <div id="detail" style="margin-top:6px;color:#6c5c4f;font-size:13px;line-height:1.4">Open ${BRAND_NAME} and click Connect.</div>
          </div>
          <div style="margin-top:10px;color:#8a7b6f;font-size:11px">Keep the connector open while using Tally.</div>
        </div></main>

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

          <section class="step">
            <div class="stepHeader"><div class="stepNumber">3</div><div class="stepTitle">Find a ledger</div><span id="zvecReady" class="pill" style="margin-left:auto">Checking…</span></div>
            <div class="searchBar"><textarea id="suggestInput" class="field" aria-label="Bank narration or party name" placeholder="Bank narration or party name"></textarea><button id="suggestBtn" class="btn">Search</button></div>
            <input id="topK" type="hidden" value="5">
            <div id="suggestStatus" class="statusLine" style="margin-top:10px"></div>
            <div id="suggestResults" style="margin-top:10px;display:grid;gap:8px;max-height:250px;overflow-y:auto;overflow-x:hidden"></div>
          </section>

        </div>

        <script>
          const { ipcRenderer } = require('electron');
          document.getElementById('minimizeBtn').addEventListener('click', () => ipcRenderer.send('window:minimize'));
          document.getElementById('maximizeBtn').addEventListener('click', () => ipcRenderer.send('window:toggle-maximize'));
          document.getElementById('closeBtn').addEventListener('click', () => ipcRenderer.send('window:close'));
          const card = document.getElementById('card');
          const menuBtn = document.getElementById('menuBtn');
          const menu = document.getElementById('menu');
          const menuLocalMatching = document.getElementById('menuLocalMatching');
          const localPanel = document.getElementById('localPanel');
          const backBtn = document.getElementById('backBtn');
          const syncBtn = document.getElementById('syncBtn');
          const vectorBtn = document.getElementById('vectorBtn');

          function setStatus(data){
            document.getElementById('title').textContent = data.title || 'Connector';
            document.getElementById('detail').textContent = data.detail || '';
            const state = data.state || 'idle';
            card.style.borderColor = state === 'connected' ? '#86efac' : state === 'error' || state === 'expired' ? '#fda4af' : '#ded1c3';
            card.style.background = state === 'connected' ? '#f0fdf4' : state === 'error' || state === 'expired' ? '#fff1f2' : '#fffaf5';
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
          menuLocalMatching.addEventListener('click', () => {
            menu.style.display='none';
            localPanel.classList.add('open');
            refreshLocalStatus();
          });
          backBtn.addEventListener('click', () => localPanel.classList.remove('open'));

          function fmtTime(iso){ if(!iso) return '—'; try{ return new Date(iso).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}); }catch{ return iso; } }
          function escapeHtml(value){ return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
          function formatCount(value){ return Number(value||0).toLocaleString(); }

          async function refreshLocalStatus(){
            try{
              const s = await ipcRenderer.invoke('local-matching:getStatus');
              document.getElementById('localDbStatus').textContent = s.db.exists ? 'Local data ready' : 'Local data not created';
              document.getElementById('localDbPath').textContent = s.db.path || '';
              document.getElementById('companyIdentity').textContent = s.tally.companyName || 'Open a company in Tally';
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
              // vector
              const v = s.vector;
              const searchReady = v.status==='ready' && (v.vectorCount||0)>0;
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

          const suggestInput = document.getElementById('suggestInput');
          const topKInput = document.getElementById('topK');
          const suggestBtn = document.getElementById('suggestBtn');
          const suggestStatus = document.getElementById('suggestStatus');
          const suggestResults = document.getElementById('suggestResults');
          const zvecReadyEl = document.getElementById('zvecReady');

          async function doSuggest(){
            const q = suggestInput.value.trim();
            if(!q){ suggestStatus.textContent='Enter a bank narration or party name first.'; suggestInput.focus(); return; }
            const topK = parseInt(topKInput.value,10)||10;
            suggestBtn.disabled=true; suggestBtn.textContent='Searching…';
            suggestStatus.textContent='Searching ledger vectors…';
            suggestResults.innerHTML='';
            const t0=Date.now();
            try{
              const res = await ipcRenderer.invoke('local-matching:suggest', { query: q, narration: q, topK });
              const elapsed = Date.now()-t0;
              if(res.isEmpty){
                suggestStatus.textContent = ['vector_search_not_ready','vector_search_unavailable'].includes(res.emptyReason)
                  ? 'Vector search is not ready. Vectorise your ledgers first.'
                  : 'No vector results found.';
                return;
              }
              suggestStatus.textContent = res.suggestions.length+' match'+(res.suggestions.length===1?'':'es');
              suggestResults.innerHTML = res.suggestions.map(function(s){
                const confidence = Math.max(0,Math.min(100,Math.round(Number(s.confidence||0)*100)));
                return '<div class="resultCard">'
                  + '<div class="row rowBetween"><div class="resultTitle">' + escapeHtml(s.ledgerName) + '</div><span class="pill">' + confidence + '% match</span></div>'
                  + (s.parentGroup?'<div class="meta">'+escapeHtml(s.parentGroup)+'</div>':'')
                  + '</div>';
              }).join('');
            }catch(e){
              suggestStatus.textContent=e.message||String(e);
            } finally { suggestBtn.disabled=false; suggestBtn.textContent='Find matches'; }
          }
          suggestBtn.addEventListener('click', doSuggest);
          suggestInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && (e.ctrlKey||e.metaKey)) doSuggest(); });

          // initial refresh when panel opened via menu, also on load
          setTimeout(()=>refreshLocalStatus(), 800);
        </script>
      </body>
    </html>
  `)}`;

  mainWindow.once("ready-to-show", () => {
    showWindow();
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    appendLog(errPath, `Connector status page failed to load (${code}: ${description}).`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appendLog(errPath, `Connector renderer stopped (${details.reason || "unknown"}). Reloading status page.`);
    if (!mainWindow?.isDestroyed()) void mainWindow.loadURL(connectorPage);
  });
  void mainWindow.loadURL(connectorPage).catch((error) => {
    appendLog(errPath, `Connector status page could not be opened: ${formatConnectorError(error)}`);
    showWindow();
  });

  mainWindow.webContents.once("did-finish-load", () => sendStatus(lastStatus));
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
      ipcMain.handle("local-matching:getStatus", async () => getLocalMatchingStatus());
      ipcMain.handle("local-matching:sync", async () => handleLocalSync());
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
      ipcMain.handle("document-parsing:parse-and-suggest", async (_event, payload) => {
        const startedAt = performance.now();
        const parseStartedAt = performance.now();
        const parsed = await parseDocumentLocal({ ...(payload || {}), output: "json" });
        const parseMs = performance.now() - parseStartedAt;
        const transactions = Array.isArray(parsed?.content?.transactions) ? parsed.content.transactions : [];
        const queries = transactions.map((transaction) => String(transaction?.description || "").trim());
        if (!queries.length) throw new Error("The document contains no transactions to match.");
        if (queries.some((query) => !query)) throw new Error("Every parsed transaction must have a description for vector search.");
        const searchStartedAt = performance.now();
        const matches = [];
        for (let offset = 0; offset < queries.length; offset += 256) {
          matches.push(...await suggestLedgersBatch({
            queries: queries.slice(offset, offset + 256),
            companyId: payload?.companyId || payload?.companyGuid || null,
            companyName: payload?.companyName || null,
            companyGuid: payload?.companyGuid || null,
            topK: payload?.topK || payload?.top_k || 5,
            appUserDataPath: app.getPath("userData"),
            embedTexts: requestSemanticEmbeddings,
          }));
        }
        const searchMs = performance.now() - searchStartedAt;
        return {
          parsed,
          transactions: transactions.map((transaction, index) => ({ ...transaction, ledgerSuggestions: matches[index]?.suggestions || [] })),
          matching: matches,
          timing: {
            parseMs: Number(parseMs.toFixed(2)),
            vectorSearchMs: Number(searchMs.toFixed(2)),
            totalMs: Number((performance.now() - startedAt).toFixed(2)),
          },
        };
      });
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
