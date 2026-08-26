import { app, BrowserWindow, dialog, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pairBridge, createBridgeRunner, disconnectBridge } from "./src/bridge.mjs";

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
    width: 460,
    height: 260,
    show: false,
    resizable: false,
    backgroundColor: "#f8f5ef",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const connectorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html>
      <body style="font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f8f5ef;color:#24140c">
        <div style="padding:24px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
            <div style="width:34px;height:34px;border-radius:10px;background:#24140c;color:white;display:grid;place-items:center;font-weight:700">${BRAND_MARK}</div>
            <div>
              <h2 style="margin:0;font-size:18px">${CONNECTOR_NAME}</h2>
              <div style="font-size:12px;color:#6c5c4f">Desktop bridge for Tally Prime</div>
            </div>
          </div>
          <div id="card" style="border:1px solid #ded1c3;border-radius:12px;background:#fffaf5;padding:16px">
            <div id="title" style="font-size:15px;font-weight:650">Waiting for connection</div>
            <div id="detail" style="margin-top:6px;color:#6c5c4f;font-size:13px;line-height:1.4">Open ${BRAND_NAME} and click Connect.</div>
          </div>
          <div style="margin-top:14px;color:#8a7b6f;font-size:12px">Do not close this window while posting entries to Tally.</div>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          const card = document.getElementById('card');
          ipcRenderer.on('status', (_event, data) => {
            document.getElementById('title').textContent = data.title || 'Connector';
            document.getElementById('detail').textContent = data.detail || '';
            const state = data.state || 'idle';
            card.style.borderColor = state === 'connected' ? '#86efac' : state === 'error' || state === 'expired' ? '#fda4af' : '#ded1c3';
            card.style.background = state === 'connected' ? '#f0fdf4' : state === 'error' || state === 'expired' ? '#fff1f2' : '#fffaf5';
          });
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
