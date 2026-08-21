"use client";

import { getApiAccessToken } from "@/lib/api-client";

type LiveRequest = {
  connectionId: string;
  companyName: string;
  financialYear?: string | null;
  operation: "company_check" | "bank_ledgers" | "ledger_masters" | "verify_bank_transaction" | "fetch_customer_open_bills" | "scan" | "create_debit_note";
  payload?: Record<string, unknown>;
  companyNames?: string[];
  proposal?: Record<string, unknown>;
  customerScope?: Record<string, unknown>;
  onProgress?: (message: string) => void;
};

type LiveResult<T> = {
  type?: string;
  requestId?: string;
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
};

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (message: string) => void;
  timeout: number;
};

type BrowserLiveSession = {
  key: string;
  token: string;
  socket: WebSocket;
  createdAt: number;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  ended: boolean;
  pending: Map<string, PendingRequest>;
};

const SESSION_MAX_AGE_MS = 2 * 60_000;
let cachedGatewayUrl: Promise<string> | null = null;
let cachedSession: BrowserLiveSession | null = null;

async function gatewayUrl() {
  const configured = String(process.env.NEXT_PUBLIC_CASH_DISCOUNT_GATEWAY_URL || "").trim();
  if (configured) return configured;
  const apiBaseUrl = String(
    process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_BRIDGE_API_BASE_URL || ""
  ).trim();
  const gatewayBaseUrl = apiBaseUrl;
  if (!gatewayBaseUrl && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    const response = await fetch("/api/cash-discount-live-url", { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { url?: string; error?: string };
    if (!response.ok || !payload.url) {
      throw new Error(payload.error || "The Cash Discount gateway URL is not configured.");
    }
    return payload.url;
  }

  const url = new URL(gatewayBaseUrl || window.location.href);
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

function liveGatewayUrl() {
  cachedGatewayUrl ??= gatewayUrl().catch((error) => {
    cachedGatewayUrl = null;
    throw error;
  });
  return cachedGatewayUrl;
}

function endSession(session: BrowserLiveSession, error: Error) {
  if (session.ended) return;
  session.ended = true;
  if (!session.readySettled) {
    session.readySettled = true;
    session.rejectReady(error);
  }
  for (const pending of session.pending.values()) {
    window.clearTimeout(pending.timeout);
    pending.reject(error);
  }
  session.pending.clear();
  if (cachedSession === session) cachedSession = null;
}

function closeSession(session: BrowserLiveSession) {
  endSession(session, new Error("The previous live Tally session was replaced."));
  if (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING) {
    session.socket.close(1000, "Session refreshed");
  }
}

function createSession(params: {
  key: string;
  token: string;
  gateway: string;
  connectionId: string;
  companyName: string;
}) {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const socket = new WebSocket(params.gateway);
  const session: BrowserLiveSession = {
    key: params.key,
    token: params.token,
    socket,
    createdAt: Date.now(),
    ready,
    resolveReady,
    rejectReady,
    readySettled: false,
    ended: false,
    pending: new Map(),
  };

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "authenticate",
      role: "browser",
      connectionId: params.connectionId,
      companyName: params.companyName,
      token: params.token,
    }));
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data ?? "{}")) as LiveResult<unknown>;
      if (message.type === "authenticated") {
        if (!session.readySettled) {
          session.readySettled = true;
          session.resolveReady();
        }
        return;
      }

      const requestId = String(message.requestId ?? "");
      const pending = requestId ? session.pending.get(requestId) : null;
      if (message.type === "progress" && pending) {
        pending.onProgress?.(message.message || "Reading live Tally data...");
      } else if (message.type === "result" && pending) {
        window.clearTimeout(pending.timeout);
        session.pending.delete(requestId);
        if (message.success === true) pending.resolve(message.data);
        else pending.reject(new Error(message.error || "The live Tally request failed."));
      } else if (message.type === "error") {
        endSession(session, new Error(message.error || "The live Cash Discount channel failed."));
      }
    } catch {
      endSession(session, new Error("The live Cash Discount channel returned an invalid response."));
    }
  });
  socket.addEventListener("error", () => {
    endSession(session, new Error("Could not connect to the live Cash Discount channel. Start the gateway and connector, then try again."));
  });
  socket.addEventListener("close", () => {
    endSession(session, new Error("The live Cash Discount channel closed before the request completed."));
  });
  return session;
}

async function getLiveSession(request: LiveRequest) {
  const accessToken = await getApiAccessToken();
  const localMode = process.env.NEXT_PUBLIC_LOCAL_DB_MODE === "true";
  if (!accessToken && !localMode) throw new Error("Your session has expired. Sign in and try again.");
  const token = accessToken || "local-development";
  const gateway = await liveGatewayUrl();
  const key = `${gateway}|${request.connectionId}`;
  const reusable =
    cachedSession &&
    !cachedSession.ended &&
    cachedSession.key === key &&
    cachedSession.token === token &&
    Date.now() - cachedSession.createdAt < SESSION_MAX_AGE_MS &&
    (cachedSession.socket.readyState === WebSocket.CONNECTING || cachedSession.socket.readyState === WebSocket.OPEN);
  if (reusable) return cachedSession as BrowserLiveSession;
  if (cachedSession) closeSession(cachedSession);
  cachedSession = createSession({
    key,
    token,
    gateway,
    connectionId: request.connectionId,
    // Authenticate the connection once and let the API return the small scope
    // map for every company on it. Company switches then reuse this socket.
    companyName: "",
  });
  return cachedSession;
}

export async function runCashDiscountLiveRequest<T>(request: LiveRequest) {
  const session = await getLiveSession(request);
  await session.ready;
  return new Promise<T>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = window.setTimeout(
      () => {
        session.pending.delete(requestId);
        reject(new Error("The live Tally request timed out. Check the connector and try again."));
      },
      4 * 60_000
    );
    session.pending.set(requestId, {
      resolve: (data) => resolve(data as T),
      reject,
      onProgress: request.onProgress,
      timeout,
    });
    session.socket.send(JSON.stringify({
      type: "request",
      requestId,
      operation: request.operation,
      companyName: request.companyName,
      companyNames: request.companyNames,
      financialYear: request.financialYear,
      proposal: request.proposal,
      payload: request.payload,
      customerScope: request.customerScope,
    }));
  });
}
