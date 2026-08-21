import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.CASH_DISCOUNT_GATEWAY_PORT || 3002);
const HOST = process.env.CASH_DISCOUNT_GATEWAY_HOST || "0.0.0.0";
let apiBaseUrl = (process.env.CASH_DISCOUNT_API_BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
const AUTH_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 4 * 60_000;
const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;

const metadata = new WeakMap();
const connectors = new Map();
const pending = new Map();
const activeDebitNotes = new Set();

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function closeWithError(socket, message, code = 1008) {
  send(socket, { type: "error", error: message });
  socket.close(code, message.slice(0, 120));
}

async function apiRequest(path, { accessToken, bridgeToken, body }) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (bridgeToken) headers["X-Bridge-Token"] = bridgeToken;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Cash Discount API failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function clearPending(requestId) {
  const item = pending.get(requestId);
  if (!item) return null;
  clearTimeout(item.timeout);
  pending.delete(requestId);
  if (item.debitNoteKey) activeDebitNotes.delete(item.debitNoteKey);
  return item;
}

function failPending(requestId, error) {
  const item = clearPending(requestId);
  if (!item) return;
  send(item.browser, {
    type: "result",
    requestId,
    success: false,
    error: error instanceof Error ? error.message : String(error ?? "The live request failed."),
  });
}

function startPending({ requestId, browser, connector, connectionId, ownerUserId, accessToken, operation, proposal, payload }) {
  const timeout = setTimeout(() => failPending(requestId, new Error("The live Tally request timed out.")), REQUEST_TIMEOUT_MS);
  const item = {
    requestId,
    browser,
    connector,
    connectionId,
    ownerUserId,
    accessToken,
    operation,
    proposal,
    payload,
    phase: operation === "company_check"
    ? "company_check"
    : operation === "bank_ledgers" || operation === "ledger_masters" || operation === "verify_bank_transaction" || operation === "fetch_customer_open_bills"
      ? operation
      : operation === "scan"
        ? "scanning"
        : "revalidating",
    commandPayload: null,
    debitNoteKey: operation === "create_debit_note"
      ? `${connectionId}|${String(proposal?.partyLedgerName ?? "").trim().toLowerCase()}|${String(proposal?.linkedInvoiceNumber ?? "").trim().toLowerCase()}`
      : null,
    timeout,
  };
  pending.set(requestId, item);
  return item;
}

async function authenticate(socket, message) {
  const role = String(message.role ?? "");
  const connectionId = String(message.connectionId ?? "").trim();
  const token = String(message.token ?? "");
  if (!connectionId || !token || !["browser", "connector"].includes(role)) {
    throw new Error("Live-session credentials are incomplete.");
  }
  const session = await apiRequest("/api/tally/live/session", {
    accessToken: role === "browser" ? token : null,
    bridgeToken: role === "connector" ? token : null,
    body: {
      role,
      connectionId,
      companyName: role === "browser" ? String(message.companyName ?? "").trim() : null,
    },
  });
  const meta = {
    authenticated: true,
    role,
    connectionId,
    ownerUserId: session.ownerUserId,
    accessToken: role === "browser" ? token : null,
    bridgeToken: role === "connector" ? token : null,
    alive: true,
    customerScope: session.customerScope ?? null,
    customerScopes: session.customerScopes && typeof session.customerScopes === "object"
      ? session.customerScopes
      : null,
    defaultCustomerScope: session.defaultCustomerScope ?? null,
  };
  metadata.set(socket, meta);

  if (role === "connector") {
    const previous = connectors.get(connectionId);
    if (previous && previous !== socket) closeWithError(previous, "A newer connector live session replaced this one.", 1000);
    connectors.set(connectionId, socket);
  }
  send(socket, { type: "authenticated", role, connectionId });
}

async function handleBrowserRequest(socket, message, meta) {
  const requestId = String(message.requestId || randomUUID());
  const operation = String(message.operation ?? "");
  if (!['company_check', 'bank_ledgers', 'ledger_masters', 'verify_bank_transaction', 'fetch_customer_open_bills', 'scan', 'create_debit_note'].includes(operation)) {
    send(socket, { type: "result", requestId, success: false, error: "Unsupported Cash Discount operation." });
    return;
  }
  if (pending.has(requestId)) {
    send(socket, { type: "result", requestId, success: false, error: "This live request is already running." });
    return;
  }
  const connector = connectors.get(meta.connectionId);
  const connectorMeta = connector ? metadata.get(connector) : null;
  if (!connector || connector.readyState !== WebSocket.OPEN || connectorMeta?.ownerUserId !== meta.ownerUserId) {
    send(socket, {
      type: "result",
      requestId,
      success: false,
      error: "The Tally connector is not on the live Cash Discount channel. Update or restart the connector and try again.",
    });
    return;
  }

  const proposal = message.proposal && typeof message.proposal === "object" ? message.proposal : null;
  const debitNoteKey = operation === "create_debit_note"
    ? `${meta.connectionId}|${String(proposal?.partyLedgerName ?? "").trim().toLowerCase()}|${String(proposal?.linkedInvoiceNumber ?? "").trim().toLowerCase()}`
    : null;
  if (debitNoteKey && activeDebitNotes.has(debitNoteKey)) {
    send(socket, { type: "result", requestId, success: false, error: "A Debit Note for this invoice is already being created." });
    return;
  }

  const item = startPending({
    requestId,
    browser: socket,
    connector,
    connectionId: meta.connectionId,
    ownerUserId: meta.ownerUserId,
    accessToken: meta.accessToken,
    operation,
    proposal,
    payload: message.payload && typeof message.payload === "object" ? message.payload : undefined,
  });
  if (item.debitNoteKey) activeDebitNotes.add(item.debitNoteKey);
  const requestedCompanyName = String(message.companyName ?? "").trim();
  const companyKey = requestedCompanyName.toLowerCase().replace(/\s+/g, " ");
  send(connector, {
    type: "operation",
    requestId,
      operation: operation === "company_check"
        ? "company_check"
        : operation === "bank_ledgers"
          ? "bank_ledgers"
          : operation === "ledger_masters"
            ? "ledger_masters"
            : operation === "verify_bank_transaction"
              ? "verify_bank_transaction"
              : operation === "fetch_customer_open_bills"
                ? "fetch_customer_open_bills"
        : operation === "scan"
        ? "cash_discount_scan"
        : "cash_discount_revalidate",
    companyName: requestedCompanyName,
    companyNames: Array.isArray(message.companyNames)
      ? message.companyNames.map((value) => String(value || "").trim()).filter(Boolean)
      : undefined,
    financialYear: String(message.financialYear ?? "").trim() || null,
    proposal,
    payload: item.payload,
    customerScope: message.customerScope && typeof message.customerScope === "object"
      ? message.customerScope
      : meta.customerScope ?? meta.customerScopes?.[companyKey] ?? meta.defaultCustomerScope,
  });
}

async function handleConnectorResult(socket, message, meta) {
  const requestId = String(message.requestId ?? "");
  const item = pending.get(requestId);
  if (!item || item.connector !== socket || item.connectionId !== meta.connectionId) return;
  if (message.success !== true) {
    failPending(requestId, new Error(String(message.error ?? "Tally could not complete the live request.")));
    return;
  }

  if (item.phase === "company_check") {
    clearPending(requestId);
    send(item.browser, { type: "result", requestId, success: true, data: message.data });
    return;
  }

  if (["bank_ledgers", "ledger_masters", "verify_bank_transaction", "fetch_customer_open_bills"].includes(item.phase)) {
    clearPending(requestId);
    send(item.browser, { type: "result", requestId, success: true, data: message.data });
    return;
  }

  if (item.phase === "scanning") {
    try {
      const dashboard = await apiRequest("/api/collections/live/analyse", {
        accessToken: item.accessToken,
        body: {
          connectionId: item.connectionId,
          companyName: message.companyName,
          scan: message.data,
        },
      });
      clearPending(requestId);
      send(item.browser, { type: "result", requestId, success: true, data: dashboard });
    } catch (error) {
      failPending(requestId, error);
    }
    return;
  }

  if (item.phase === "revalidating") {
    try {
      const prepared = await apiRequest("/api/collections/live/prepare-debit-note", {
        accessToken: item.accessToken,
        body: {
          connectionId: item.connectionId,
          companyName: message.companyName,
          proposal: item.proposal,
          scan: message.data,
        },
      });
      item.commandPayload = prepared.commandPayload;
      item.phase = "creating";
      send(item.connector, {
        type: "operation",
        requestId,
        operation: "cash_discount_execute_debit_note",
        commandPayload: prepared.commandPayload,
      });
    } catch (error) {
      failPending(requestId, error);
    }
    return;
  }

  if (item.phase === "creating") {
    try {
      const connectorMeta = metadata.get(item.connector);
      const confirmed = await apiRequest("/api/collections/live/confirm-debit-note", {
        accessToken: item.accessToken,
        bridgeToken: connectorMeta?.bridgeToken,
        body: {
          connectionId: item.connectionId,
          commandPayload: item.commandPayload,
          tallyOutcome: message.data,
        },
      });
      clearPending(requestId);
      send(item.browser, { type: "result", requestId, success: true, data: confirmed });
    } catch (error) {
      failPending(requestId, error);
    }
  }
}

export function startCashDiscountGateway(options = {}) {
  const attachedServer = options.server;
  const gatewayPath = options.path ?? (attachedServer ? "/cash-discount-live" : "/");
  apiBaseUrl = String(options.apiBaseUrl || process.env.CASH_DISCOUNT_API_BASE_URL || "http://localhost:3001")
    .replace(/\/+$/, "");

  const server = attachedServer
    ? new WebSocketServer({ server: attachedServer, path: gatewayPath, maxPayload: MAX_MESSAGE_BYTES })
    : new WebSocketServer({
        host: options.host || HOST,
        port: Number(options.port ?? PORT),
        path: gatewayPath,
        maxPayload: MAX_MESSAGE_BYTES,
      });

  server.on("connection", (socket) => {
  metadata.set(socket, { authenticated: false, alive: true });
  const authTimer = setTimeout(() => {
    if (!metadata.get(socket)?.authenticated) closeWithError(socket, "Live-session authentication timed out.");
  }, AUTH_TIMEOUT_MS);

  socket.on("pong", () => {
    const meta = metadata.get(socket);
    if (meta) meta.alive = true;
  });

  socket.on("message", async (buffer) => {
    try {
      const message = JSON.parse(buffer.toString());
      const meta = metadata.get(socket);
      if (!meta?.authenticated) {
        if (message.type !== "authenticate") throw new Error("Authenticate before using the live channel.");
        await authenticate(socket, message);
        clearTimeout(authTimer);
        return;
      }
      if (message.type === "request" && meta.role === "browser") {
        await handleBrowserRequest(socket, message, meta);
      } else if (message.type === "operation_result" && meta.role === "connector") {
        await handleConnectorResult(socket, message, meta);
      } else if (message.type === "progress" && meta.role === "connector") {
        const item = pending.get(String(message.requestId ?? ""));
        if (item?.connector === socket) send(item.browser, message);
      }
    } catch (error) {
      const meta = metadata.get(socket);
      if (!meta?.authenticated) closeWithError(socket, error instanceof Error ? error.message : "Authentication failed.");
      else send(socket, { type: "error", error: error instanceof Error ? error.message : "Invalid live-channel message." });
    }
  });

  socket.on("close", () => {
    clearTimeout(authTimer);
    const meta = metadata.get(socket);
    if (meta?.role === "connector" && connectors.get(meta.connectionId) === socket) connectors.delete(meta.connectionId);
    for (const [requestId, item] of pending) {
      if (item.browser === socket) clearPending(requestId);
      else if (item.connector === socket) failPending(requestId, new Error("The Tally connector disconnected during the live request."));
    }
  });
  });

  const heartbeat = setInterval(() => {
    for (const socket of server.clients) {
      const meta = metadata.get(socket);
      if (meta?.alive === false) {
        socket.terminate();
        continue;
      }
      if (meta) meta.alive = false;
      socket.ping();
    }
  }, 30_000);

  server.on("close", () => clearInterval(heartbeat));
  const location = attachedServer
    ? gatewayPath
    : `ws://${options.host || HOST}:${Number(options.port ?? PORT)}${gatewayPath}`;
  console.log(`Cash Discount live gateway listening on ${location}`);
  return server;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) startCashDiscountGateway();
