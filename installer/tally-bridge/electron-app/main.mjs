import { app, BrowserWindow, dialog, net, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pairBridge, createBridgeRunner, disconnectBridge } from "./src/bridge.mjs";
import { loadLocalDb, saveLocalDb, getLocalDbPaths, upsertLedgers, getStatusForCompany, getAllCompaniesStatus, normalizeCompanyKey } from "./src/local-matching/store.mjs";
import { vectoriseCompany, getVectorStatus, getVectorEngine, isZvecAvailable } from "./src/local-matching/vector.mjs";
import { syncLedgersReadOnly } from "./src/local-matching/sync.mjs";
import { suggestLedgers } from "./src/local-matching/suggest.mjs";
import { exportTallyCollection, fetchAvailableCompanies, testTally } from "./src/bridge.mjs";

const BRAND_NAME = "Gajkesari";
const CONNECTOR_NAME = "Gajkesari Tally Connector";
const PROTOCOL_NAME = "gajkesari-tally";
const APP_USER_MODEL_ID = "com.gajkesari.tally-connector";
const BRAND_MARK = "P";

// The connector UI is lightweight and does not need GPU acceleration. Some
// Windows machines cannot start Electron's GPU subprocess, which otherwise
// terminates the whole connector before its window appears.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const installDir = path.resolve(__dirname, "..", "..");
const logPath = path.join(installDir, "bridge.log");
const errPath = path.join(installDir, "bridge.err.log");
const nodeFetch = globalThis.fetch.bind(globalThis);
const ELECTRON_NETWORK_RETRY_MS = 5 * 60 * 1000;
let preferNodeFetchUntil = 0;

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
    height: 680,
    show: false,
    resizable: true,
    backgroundColor: "#f8f5ef",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const connectorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html>
      <head>
        <style>
          :root{--ink:#231b16;--muted:#756b63;--line:#e8e1da;--surface:#fff;--canvas:#f7f5f2;--accent:#167a50;--accent-soft:#eaf7f0;--danger:#b42318}
          *{box-sizing:border-box}
          html,body{width:100%;min-width:0;overflow-x:hidden}
          body{font-family:"Segoe UI Variable Text","Segoe UI",sans-serif;margin:0;background:var(--canvas);color:var(--ink);font-size:13px}
          button,input,textarea{font:inherit}
          button{cursor:pointer}
          button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid rgba(22,122,80,.2);outline-offset:2px}
          #localPanel{display:none;position:absolute;inset:0;background:var(--canvas);z-index:10;overflow-y:auto;overflow-x:hidden;padding:0 22px 24px}
          #localPanel.open{display:block}
          .stickyHeader{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;padding:18px 0 14px;background:linear-gradient(var(--canvas) 78%,rgba(247,245,242,0))}
          .eyebrow{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
          .pageTitle{font-size:20px;font-weight:720;letter-spacing:-.02em;margin:2px 0 0}
          .intro{margin:0 0 18px;color:var(--muted);line-height:1.5}
          .summary{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,.7fr);gap:10px;margin-bottom:14px}
          .summaryCard,.step{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:14px}
          .summaryCard{padding:13px 14px}
          .summaryLabel{font-size:11px;color:var(--muted);margin-bottom:4px}
          .summaryValue{font-size:14px;font-weight:680;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          .step{padding:16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(35,27,22,.03)}
          .stepReady{border-color:#b9dfca;background:linear-gradient(135deg,#fff 45%,#f1faf5)}
          .stepHeader{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
          .stepNumber{flex:0 0 28px;height:28px;border-radius:9px;display:grid;place-items:center;background:#eee9e4;color:#685c52;font-weight:750}
          .stepReady .stepNumber{background:var(--accent);color:#fff}
          .stepCopy{min-width:0;flex:1}
          .stepTitle{font-size:14px;font-weight:720;line-height:1.2;margin:1px 0 3px}
          .stepHint,.meta,.statusLine{font-size:12px;color:var(--muted);line-height:1.45}
          .metric{font-size:26px;font-weight:740;letter-spacing:-.04em;line-height:1;margin-bottom:4px}
          .row{display:flex;align-items:center;gap:10px;min-width:0}
          .rowBetween{justify-content:space-between}
          .pill{display:inline-flex;align-items:center;gap:5px;max-width:100%;font-size:11px;font-weight:650;padding:4px 8px;border-radius:999px;background:#f3f0ed;color:#62574e;border:1px solid var(--line);white-space:nowrap}
          .pillReady{background:var(--accent-soft);color:#11643f;border-color:#b9dfca}
          .btn{min-height:36px;padding:8px 13px;border-radius:10px;border:1px solid var(--ink);background:var(--ink);color:#fff;font-weight:680;transition:transform .12s ease,box-shadow .12s ease}
          .btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(35,27,22,.15)}
          .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}
          .btnSecondary{min-height:34px;padding:7px 11px;border-radius:9px;border:1px solid var(--line);background:#fff;color:var(--ink);font-weight:650}
          .iconBtn{width:36px;height:36px;padding:0;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink);font-size:18px}
          .kv{font-size:12px;color:var(--muted);line-height:1.5;min-width:0;overflow-wrap:anywhere}
          .kv b{color:var(--ink)}
          .resultNote{display:none;margin-top:10px;padding:9px 10px;border-radius:9px;background:#f7f5f2;color:var(--muted);font-size:11px;line-height:1.4}
          .field{width:100%;min-height:72px;border:1px solid #dcd4cc;border-radius:11px;padding:10px 11px;background:#fff;resize:vertical;line-height:1.4;color:var(--ink)}
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
          .footerNote{display:flex;gap:8px;align-items:flex-start;color:var(--muted);font-size:11px;line-height:1.45;padding:4px 2px}
          @media(max-width:460px){#localPanel{padding-left:14px;padding-right:14px}.summary{grid-template-columns:1fr}.searchBar{align-items:stretch;flex-direction:column}.searchBar .btn{width:100%}}
        </style>
      </head>
      <body style="font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f8f5ef;color:#24140c">
        <div style="padding:20px 20px 12px 20px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
            <div style="width:34px;height:34px;border-radius:10px;background:#24140c;color:white;display:grid;place-items:center;font-weight:700">${BRAND_MARK}</div>
            <div style="flex:1">
              <h2 style="margin:0;font-size:18px">${CONNECTOR_NAME}</h2>
              <div style="font-size:12px;color:#6c5c4f">Desktop bridge for Tally Prime</div>
            </div>
            <div style="position:relative">
              <button id="menuBtn" title="Menu" style="width:34px;height:34px;border-radius:8px;border:1px solid #ded1c3;background:#fff;font-size:20px;line-height:1">⋮</button>
              <div id="menu" style="display:none;position:absolute;right:0;top:38px;min-width:180px;background:#fff;border:1px solid #ded1c3;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.12);overflow:hidden;z-index:20">
                <button id="menuLocalMatching" style="width:100%;text-align:left;padding:10px 14px;background:#fff;border:0;font-size:13px">Local Matching</button>
              </div>
            </div>
          </div>
          <div id="card" style="border:1px solid #ded1c3;border-radius:12px;background:#fffaf5;padding:16px">
            <div id="title" style="font-size:15px;font-weight:650">Waiting for connection</div>
            <div id="detail" style="margin-top:6px;color:#6c5c4f;font-size:13px;line-height:1.4">Open ${BRAND_NAME} and click Connect.</div>
          </div>
          <div style="margin-top:12px;color:#8a7b6f;font-size:12px">Do not close this window while posting entries to Tally.</div>
        </div>

        <div id="localPanel">
          <div class="stickyHeader">
            <button id="backBtn" class="iconBtn" aria-label="Back to connector status">←</button>
            <div style="min-width:0;flex:1"><div class="eyebrow">Tally tools</div><div class="pageTitle">Ledger matching</div></div>
            <span class="pill" id="dbStatusPill">Checking…</span>
          </div>
          <p class="intro">Prepare a fast local copy of your Tally ledgers, then check which ledger best matches a bank narration.</p>

          <div class="summary">
            <div class="summaryCard"><div class="summaryLabel">Open company</div><div id="companyIdentity" class="summaryValue">Checking Tally…</div><div id="companyGuid" style="display:none"></div></div>
            <div class="summaryCard"><div class="summaryLabel">Saved ledgers</div><div id="ledgerCount" class="summaryValue">—</div></div>
          </div>
          <div id="localDbStatus" style="display:none"></div><div id="localDbPath" style="display:none"></div>

          <section id="ledgerStep" class="step stepReady">
            <div class="stepHeader"><div class="stepNumber">1</div><div class="stepCopy"><div class="stepTitle">Update ledger list</div><div class="stepHint">Copies ledger names from the open Tally company. Nothing in Tally is changed.</div></div></div>
            <div class="row rowBetween"><div><div id="syncState" class="statusLine">Ready to update</div><div id="lastSync" class="meta">Not updated yet</div></div><button id="syncBtn" class="btn">Update ledgers</button></div>
            <div id="syncCounts" class="resultNote"></div>
          </section>

          <section id="vectorStep" class="step">
            <div class="stepHeader"><div class="stepNumber">2</div><div class="stepCopy"><div class="stepTitle">Vectorise your ledgers</div><div class="stepHint">Creates AI embeddings for ledger names with text-embedding-3-small. No vouchers or other Tally data are indexed.</div></div></div>
            <div class="row rowBetween"><div><div id="vectorState" class="statusLine">Waiting for ledgers</div><div id="lastVector" class="meta">Not vectorised yet</div></div><button id="vectorBtn" class="btnSecondary">Vectorise ledgers</button></div>
            <div id="vectorCount" style="display:none"></div><div id="vectorProgress" class="resultNote"></div>
          </section>

          <section class="step">
            <div class="stepHeader"><div class="stepNumber">3</div><div class="stepCopy"><div class="stepTitle">Find a matching ledger</div><div class="stepHint">Paste a bank narration or type a party name to see the closest matches.</div></div><span id="zvecReady" class="pill">Checking…</span></div>
            <div class="searchBar"><textarea id="suggestInput" class="field" aria-label="Bank narration or party name" placeholder="Example: UPI payment to Aarav Steel Traders"></textarea><button id="suggestBtn" class="btn">Find matches</button></div>
            <input id="topK" type="hidden" value="5">
            <div id="suggestStatus" class="statusLine" style="margin-top:10px">Enter a narration to begin.</div>
            <div id="suggestResults" style="margin-top:10px;display:grid;gap:8px;max-height:250px;overflow-y:auto;overflow-x:hidden"></div>
          </section>

          <div class="footerNote"><span aria-hidden="true">🔒</span><span>Ledger names and searches are securely sent to OpenRouter for embedding. The resulting vector index stays on this computer.</span></div>
        </div>

        <script>
          const { ipcRenderer } = require('electron');
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
              document.getElementById('dbStatusPill').textContent = s.db.exists ? 'Ready' : 'Not prepared';
              document.getElementById('dbStatusPill').className = s.db.exists ? 'pill pillReady' : 'pill';
              document.getElementById('localDbStatus').textContent = s.db.exists ? 'Local data ready' : 'Local data not created';
              document.getElementById('localDbPath').textContent = s.db.path || '';
              document.getElementById('companyIdentity').textContent = s.tally.companyName || 'Open a company in Tally';
              document.getElementById('companyGuid').textContent = s.tally.companyGuid ? 'GUID: '+s.tally.companyGuid : (s.tally.companyName ? '' : 'Tally not reachable');
              document.getElementById('ledgerCount').textContent = formatCount(s.ledgers.count);
              document.getElementById('lastSync').textContent = s.ledgers.lastSyncAt ? 'Updated '+fmtTime(s.ledgers.lastSyncAt) : 'Not updated yet';
              document.getElementById('syncState').textContent = s.ledgers.count ? 'Ledger list is ready' : 'Ready to update';
              const sc = s.ledgers.counts;
              const syncCountsEl = document.getElementById('syncCounts');
              if(sc){
                syncCountsEl.style.display='block';
                syncCountsEl.textContent = sc.added || sc.updated || sc.deleted
                  ? sc.added+' added · '+sc.updated+' updated · '+sc.deleted+' no longer active'
                  : 'Everything is up to date.';
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
                  ? formatCount(indexed)+' of '+formatCount(indexTotal)+' ledgers vectorised'
                  : v.status==='indexing'
                    ? formatCount(indexed)+' of '+formatCount(indexTotal)+' ledgers vectorised'
                    : s.ledgers.count ? 'Ready to vectorise '+formatCount(s.ledgers.count)+' ledgers' : 'Waiting for ledgers';
              vectorState.style.color = v.error ? 'var(--danger)' : '';
              document.getElementById('vectorCount').textContent = v.vectorCount||0;
              const progressEl = document.getElementById('vectorProgress');
              progressEl.style.display = v.error ? 'block' : 'none';
              progressEl.textContent = v.error ? v.error : '';
              document.getElementById('lastVector').textContent = v.lastVectorisedAt ? 'Last vectorised '+fmtTime(v.lastVectorisedAt) : 'Not vectorised yet';
              // Zvec ready pill for suggestion
              const zr = document.getElementById('zvecReady');
              if(zr){
                const isReady = searchReady;
                const detail = v.engineDetail && typeof v.engineDetail==='object' ? v.engineDetail.reason : v.engineDetail;
                const zvecAvail = s.isZvecAvailable ? ' • Zvec pkg yes' : (s.zvecVersion ? '' : ' • Zvec pkg no');
                zr.textContent = isReady ? 'AI vector search ready' : v.status==='error' ? 'AI vector search unavailable' : 'AI vector search not ready';
                zr.title = (detail || v.engine || 'Search index') + (v.zvecError ? ' | '+v.zvecError.slice(0,120) : '') + zvecAvail;
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
            setVectorState(formatCount(done)+' of '+formatCount(total)+' ledgers vectorised', false);
          });

          syncBtn.addEventListener('click', async () => {
            syncBtn.disabled=true; syncBtn.textContent='Updating…'; setSyncState('Reading ledgers from Tally…');
            try{
              const r = await ipcRenderer.invoke('local-matching:sync');
              setSyncState('Ledger list updated successfully', false);
              await refreshLocalStatus();
            }catch(e){
              setSyncState(e.message||String(e), true);
            } finally { syncBtn.disabled=false; syncBtn.textContent='Update ledgers'; }
          });

          vectorBtn.addEventListener('click', async () => {
            vectorBtn.disabled=true; vectorBtn.textContent='Vectorising…'; setVectorState('Starting ledger vectorisation…');
            try{
              const r = await ipcRenderer.invoke('local-matching:vectorise');
              setVectorState(formatCount(r.vectorCount)+' of '+formatCount(r.vectorCount)+' ledgers vectorised', false);
              await refreshLocalStatus();
            }catch(e){
              setVectorState(e.message||String(e), true);
            } finally { vectorBtn.disabled=false; vectorBtn.textContent='Vectorise ledgers'; }
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
              suggestStatus.textContent = 'Vector search · '+res.suggestions.length+' possible match'+(res.suggestions.length===1?'':'es')+'.';
              suggestResults.innerHTML = res.suggestions.map(function(s){
                const confidence = Math.max(0,Math.min(100,Math.round(Number(s.confidence||0)*100)));
                return '<div class="resultCard">'
                  + '<div class="row rowBetween"><div class="resultTitle">' + escapeHtml(s.ledgerName) + '</div><span class="pill">' + confidence + '% match</span></div>'
                  + (s.parentGroup?'<div class="meta">'+escapeHtml(s.parentGroup)+'</div>':'')
                  + '<div class="meta" style="margin-top:5px">Vector result</div>'
                  + (s.needsReview?'<div class="meta" style="color:#9a6700;margin-top:5px">Please review before using this match.</div>':'')
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
