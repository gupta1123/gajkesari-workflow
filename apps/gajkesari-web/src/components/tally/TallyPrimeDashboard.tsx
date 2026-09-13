"use client";

import { tallyBrowserStorage } from "@/lib/tally-browser-storage";


import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Building2,
  FileText,
  Loader2,
  PlugZap,
  RefreshCw,
  Server,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { useTallyConnectionStatus } from "@/components/tally/TallyConnectionStatusProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CompanyAvatar } from "@/components/ui/company-avatar";
import { GradientSuccessMark } from "@/components/ui/gradient-success-mark";
import { Input } from "@/components/ui/input";

const DEFAULT_TALLY_URL = "http://localhost:9000";
const DEFAULT_LAN_TALLY_URL = "http://192.168.1.10:9000";
const SELECTED_CONNECTION_STORAGE_KEY = "gajkesari:selected-tally-connection";
const EXPECTED_MACHINE_STORAGE_PREFIX = "gajkesari:tally-connector-machine:";
const CONNECTION_CONTROL_STORAGE_PREFIX = "gajkesari:tally-connection-control:";

type TallySetupMode = "same_machine" | "lan_server";

type TallyConnection = {
  id: string;
  displayName: string;
  status: string;
  tallyUrl: string;
  pairingCodeExpiresAt: string | null;
  pairedAt: string | null;
  bridgeName: string | null;
  bridgeVersion: string | null;
  bridgeMachineId: string | null;
  lastHeartbeatAt: string | null;
  lastTestedAt: string | null;
  lastTallyReachable: boolean | null;
  lastCompanyLoaded: boolean | null;
  lastCompanyName: string | null;
  lastError: string | null;
  bridgeConnected?: boolean;
  tallyReachable?: boolean;
  companyLoaded?: boolean;
  heartbeatStale?: boolean;
  connectorUpdateRequired?: boolean;
  revoked?: boolean;
};

type CompanyOption = {
  id: string;
  connectionId: string;
  companyName: string;
  financialYear: string;
  isActive?: boolean;
};

type ConnectionsResponse = {
  connections?: TallyConnection[];
  error?: string;
};

type CreateConnectionResponse = {
  connection?: TallyConnection;
  pairingCode?: string;
  controlToken?: string;
  error?: string;
};

type StatusResponse = {
  connection?: TallyConnection;
  error?: string;
};

type DisconnectOthersResponse = {
  connections?: TallyConnection[];
  disconnectedCount?: number;
  disconnectedConnectionIds?: string[];
  error?: string;
};

type CompaniesResponse = {
  companies?: CompanyOption[];
  selectedCompanyId?: string | null;
  error?: string;
};

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  return payload.error || `Request failed with status ${response.status}`;
}

function formatTime(value?: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getStatusLabel(connection?: TallyConnection | null) {
  if (!connection) return "Not connected";
  if (connection.status === "company_loaded") return "Company loaded";
  if (connection.status === "tally_reachable") return "Tally reachable";
  if (connection.status === "bridge_connected") return "Connector connected";
  if (connection.status === "connection_error") return "Connection error";
  if (connection.status === "waiting_for_bridge")
    return "Waiting for connector";
  return "Not connected";
}

const DEFAULT_BRIDGE_API_BASE_URL =
  "https://gajkesari-workflow-b626b81159b6.herokuapp.com";

function getBridgeApiBaseUrl() {
  // In local development the connector runs on the same workstation as this
  // browser. Never fall back to the hosted API here: doing so pairs the
  // desktop connector to a different connection record than localhost is
  // displaying, leaving the UI permanently "Waiting for connector".
  if (typeof window !== "undefined") {
    const { hostname, origin } = window.location;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    ) {
      return origin.replace(/\/+$/, "");
    }
  }
  const configuredBaseUrl = (
    process.env.NEXT_PUBLIC_BRIDGE_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    ""
  ).replace(/\/+$/, "");
  if (configuredBaseUrl) return configuredBaseUrl;
  return DEFAULT_BRIDGE_API_BASE_URL;
}

function buildConnectorConnectUrl(
  connection: TallyConnection,
  pairingCode: string,
  controlToken: string,
) {
  const params = new URLSearchParams({
    apiBase: getBridgeApiBaseUrl(),
    connectionId: connection.id,
    pairingCode,
    controlToken,
    tallyUrl: connection.tallyUrl || DEFAULT_TALLY_URL,
  });

  return `gajkesari-tally://connect?${params.toString()}`;
}

function normalizeTallyUrlInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function getSetupModeForUrl(value?: string | null): TallySetupMode {
  if (!value) return "same_machine";
  try {
    const url = new URL(normalizeTallyUrlInput(value));
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1"
      ? "same_machine"
      : "lan_server";
  } catch {
    return "lan_server";
  }
}

function openConnectorUrl(value: string) {
  window.location.assign(value);
}

function HubCard({
  title,
  description,
  status,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  status: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="group flex min-h-[190px] w-full flex-col justify-between rounded-2xl border border-[#e5ddd0] bg-white p-6 text-left shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all duration-300 hover:-translate-y-1 hover:border-[#cbd5e1] hover:shadow-[0_8px_24px_rgba(0,0,0,0.04)] focus:outline-none focus:ring-2 focus:ring-[#1a1a1a]/10"
      onClick={onClick}
      type="button"
    >
      <div className="w-full">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50 border border-amber-100/50 text-amber-700 transition-colors group-hover:bg-amber-100/60">
            {icon}
          </div>
          <ArrowRight className="h-5 w-5 text-slate-400 transition-all duration-300 group-hover:translate-x-1 group-hover:text-[#1a1a1a]" />
        </div>
        <h3 className="text-lg font-extrabold text-[#1a1a1a]">{title}</h3>
        <p className="mt-2 text-xs font-semibold leading-relaxed text-slate-500">
          {description}
        </p>
      </div>
      <div className="mt-6 w-fit rounded-full border border-amber-250 bg-amber-50 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-800">
        {status}
      </div>
    </button>
  );
}

function FeedbackToast({
  message,
  onClose,
}: {
  message: { tone: "success" | "error"; text: string } | null;
  onClose: () => void;
}) {
  if (!message) return null;

  const isError = message.tone === "error";
  return (
    <div
      aria-live={isError ? "assertive" : "polite"}
      className="fixed bottom-5 right-5 z-[100] flex w-[min(360px,calc(100vw-2rem))] items-start gap-3 rounded-xl border border-[#ded7cc] bg-white px-4 py-3 text-[#24211e] shadow-[0_12px_36px_rgba(60,49,36,0.14)] animate-in fade-in slide-in-from-bottom-2 duration-200"
      role={isError ? "alert" : "status"}
    >
      {isError ? (
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-red-50 text-red-700">
          <TriangleAlert className="h-4 w-4" />
        </span>
      ) : (
        <GradientSuccessMark className="mt-0.5 h-7 w-7" />
      )}
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-xs font-bold leading-5">
          {isError ? "Something needs attention" : "Done"}
        </p>
        <p className="text-[11px] font-medium leading-4 text-[#6f675e]">
          {message.text}
        </p>
      </div>
      <button
        aria-label="Dismiss notification"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[#8a8177] transition-colors hover:bg-[#f5f2ed] hover:text-[#24211e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b8ac9e]"
        onClick={onClose}
        type="button"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface TallyPrimeDashboardProps {
  initialView?: "home" | "connection";
}

export function TallyPrimeDashboard({ initialView = "home" }: TallyPrimeDashboardProps) {
  const router = useRouter();
  const { refresh: refreshGlobalTallyStatus } = useTallyConnectionStatus();
  const [view, setView] = useState<"home" | "connection">(initialView);
  const [connections, setConnections] = useState<TallyConnection[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectingOthers, setDisconnectingOthers] = useState(false);
  const [testing, setTesting] = useState(false);
  const [setupMode, setSetupMode] = useState<TallySetupMode>("same_machine");
  const [tallyUrlInput, setTallyUrlInput] = useState("");
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const statusRefreshInFlight = useRef(false);

  const selectedConnection =
    connections.find((connection) => connection.id === selectedId) ??
    connections[0] ??
    null;
  const selectedConnectionId = selectedConnection?.id ?? "";
  const expectedMachineId =
    typeof window !== "undefined" && selectedConnectionId
      ? tallyBrowserStorage.getItem(
          `${EXPECTED_MACHINE_STORAGE_PREFIX}${selectedConnectionId}`,
        )
      : null;
  const selectedControlToken =
    typeof window !== "undefined" && selectedConnectionId
      ? tallyBrowserStorage.getItem(
          `${CONNECTION_CONTROL_STORAGE_PREFIX}${selectedConnectionId}`,
        )
      : null;
  const connectionBelongsToThisBrowser =
    !selectedConnection?.bridgeConnected ||
    (Boolean(selectedControlToken) &&
      (!expectedMachineId ||
        !selectedConnection?.bridgeMachineId ||
        expectedMachineId === selectedConnection.bridgeMachineId));
  const selectedCompany = connectionBelongsToThisBrowser
    ? (companies.find(
        (company) =>
          company.connectionId === selectedConnection?.id &&
          (company.isActive ||
            company.companyName.trim().toLowerCase() ===
              String(selectedConnection?.lastCompanyName ?? "")
                .trim()
                .toLowerCase()),
      ) ?? null)
    : null;
  const connectorActive =
    connectionBelongsToThisBrowser &&
    Boolean(selectedConnection?.bridgeConnected);
  const selectedActiveConnectionId = selectedConnection?.bridgeConnected
    ? (selectedConnection?.id ?? "")
    : "";
  const otherActiveConnectionCount = connections.filter(
    (connection) =>
      connection.bridgeConnected && connection.id !== selectedActiveConnectionId,
  ).length;
  const tallyReachable =
    connectionBelongsToThisBrowser &&
    selectedConnection?.tallyReachable === true;
  const companyLoaded =
    connectionBelongsToThisBrowser &&
    selectedConnection?.companyLoaded === true;
  const companyDetail = !connectionBelongsToThisBrowser
    ? "Another connector replaced this connection. Reconnect this computer."
    : selectedConnection?.lastCompanyName ||
      selectedCompany?.companyName ||
      (selectedConnection?.companyLoaded
        ? "Company loaded"
        : "Company not detected yet");
  const connectionVisualState = !connectionBelongsToThisBrowser || selectedConnection?.revoked
    ? "replaced"
    : selectedConnection?.connectorUpdateRequired
      ? "error"
      : selectedConnection?.heartbeatStale
        ? "stale"
        : selectedConnection?.status === "waiting_for_bridge" &&
            selectedConnection.lastError?.toLowerCase().includes("disconnected by user")
          ? "paused"
    : selectedConnection?.status === "connection_error"
      ? "error"
      : !connectorActive
        ? "waiting"
        : !tallyReachable
          ? "needs_tally"
          : !companyLoaded
            ? "needs_company"
            : "ready";
  const connectionVisual = {
    ready: {
      title: `Connected to ${selectedConnection?.lastCompanyName || selectedCompany?.companyName || "Tally"}`,
      description: "The connector, Tally Prime, and company are ready for Gajkesari workflows.",
      eyebrow: "Ready",
      shader: "/images/tally/connection-ready.webp",
      badge: "Connected",
      badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-800",
    },
    needs_company: {
      title: "Open a company in Tally",
      description: "Tally Prime is reachable. Load the company you want Gajkesari to use, then check again.",
      eyebrow: "One step left",
      shader: "/images/tally/connection-waiting.webp",
      badge: "Company needed",
      badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
    },
    needs_tally: {
      title: "Open Tally Prime",
      description: "The connector is online, but it cannot reach Tally at the configured address.",
      eyebrow: "Action needed",
      shader: "/images/tally/connection-waiting.webp",
      badge: "Tally unavailable",
      badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
    },
    waiting: {
      title: "Waiting for Tally Connector",
      description: "Launch or reconnect the desktop connector on this computer to continue.",
      eyebrow: "Not connected",
      shader: "/images/tally/connection-waiting.webp",
      badge: "Waiting",
      badgeClass: "border-[#ddd3c5] bg-[#faf8f4] text-[#6f6255]",
    },
    paused: {
      title: "Tally Connector is paused",
      description: "Reconnect this computer when you are ready to resume Tally workflows.",
      eyebrow: "Paused",
      shader: "/images/tally/connection-waiting.webp",
      badge: "Paused",
      badgeClass: "border-[#ddd3c5] bg-[#faf8f4] text-[#6f6255]",
    },
    stale: {
      title: "Connector has stopped responding",
      description: "The last heartbeat is out of date. Check that the connector is still open, then reconnect if needed.",
      eyebrow: "Status out of date",
      shader: "/images/tally/connection-waiting.webp",
      badge: "Offline",
      badgeClass: "border-amber-200 bg-amber-50 text-amber-800",
    },
    error: {
      title: "Connection needs attention",
      description: selectedConnection?.lastError || "The connector reported an error. Reconnect it, then check the status again.",
      eyebrow: "Connection error",
      shader: "/images/tally/connection-error.webp",
      badge: "Error",
      badgeClass: "border-rose-200 bg-rose-50 text-rose-800",
    },
    replaced: {
      title: "Reconnect this computer",
      description: "Another connector replaced this session. Reconnect here to restore control safely.",
      eyebrow: "Session replaced",
      shader: "/images/tally/connection-error.webp",
      badge: "Reconnect required",
      badgeClass: "border-rose-200 bg-rose-50 text-rose-800",
    },
  }[connectionVisualState];
  async function loadConnections(options?: { quiet?: boolean }) {
    try {
      if (!options?.quiet) {
        setLoading(true);
      }
      const response = await apiFetch("/api/tally/connections", {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as ConnectionsResponse;
      const nextConnections = payload.connections ?? [];
      setConnections(nextConnections);
      setSelectedId((current) => {
        const stored =
          typeof window !== "undefined"
            ? (tallyBrowserStorage.getItem(SELECTED_CONNECTION_STORAGE_KEY) ??
              "")
            : "";
        const preferred = current || stored;
        const nextId = nextConnections.some(
          (connection) => connection.id === preferred,
        )
          ? preferred
          : nextConnections[0]?.id || "";
        if (typeof window !== "undefined" && nextId) {
          tallyBrowserStorage.setItem(SELECTED_CONNECTION_STORAGE_KEY, nextId);
        }
        return nextId;
      });

      const preferredId = selectedId || tallyBrowserStorage.getItem(SELECTED_CONNECTION_STORAGE_KEY) || "";
      if (!nextConnections.some((connection) => connection.id === preferredId)) {
        setCompanies([]);
        return;
      }
      const companyResponse = await apiFetch(`/api/tally/companies?connectionId=${encodeURIComponent(preferredId)}`, {
        method: "GET",
        cache: "no-store",
      });
      if (companyResponse.ok) {
        const companyPayload =
          (await companyResponse.json()) as CompaniesResponse;
        setCompanies(companyPayload.companies ?? []);
      }
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to load Tally connections.",
      });
    } finally {
      setLoading(false);
    }
  }

  const refreshStatus = useCallback(async (connectionId: string) => {
    if (!connectionId || statusRefreshInFlight.current) return;

    statusRefreshInFlight.current = true;
    try {
      const response = await apiFetch(
        `/api/tally/connections/${connectionId}/status`,
        {
          method: "GET",
          cache: "no-store",
        },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as StatusResponse;
      if (!payload.connection) return;

      setConnections((current) =>
        current.map((connection) =>
          connection.id === payload.connection?.id
            ? payload.connection
            : connection,
        ),
      );
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to refresh Tally status.",
      });
    } finally {
      statusRefreshInFlight.current = false;
    }
  }, []);

  async function connectConnector() {
    try {
      setCreating(true);
      setMessage(null);
      const tallyUrl =
        setupMode === "same_machine"
          ? DEFAULT_TALLY_URL
          : normalizeTallyUrlInput(tallyUrlInput);
      if (!tallyUrl) {
        throw new Error("Enter the Tally server URL or IP address.");
      }
      try {
        const parsedTallyUrl = new URL(tallyUrl);
        if (!["http:", "https:"].includes(parsedTallyUrl.protocol)) {
          throw new Error("Unsupported protocol");
        }
      } catch {
        throw new Error("Enter a valid Tally server URL.");
      }

      const response = await apiFetch("/api/tally/connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName:
            setupMode === "same_machine" ? "Tally Prime" : "Tally Prime LAN",
          tallyUrl,
          controlToken: selectedConnection ? tallyBrowserStorage.getItem(`${CONNECTION_CONTROL_STORAGE_PREFIX}${selectedConnection.id}`) : null,
          reuseConnectionId:
            selectedConnection && !connectorActive ? selectedConnection.id : null,
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as CreateConnectionResponse;
      if (
        !payload.connection ||
        !payload.pairingCode ||
        !payload.controlToken
      ) {
        throw new Error(
          "Connection created, but pairing details were missing.",
        );
      }

      setConnections((current) => [
        payload.connection as TallyConnection,
        ...current,
      ]);
      setSelectedId(payload.connection.id);
      tallyBrowserStorage.setItem(
        SELECTED_CONNECTION_STORAGE_KEY,
        payload.connection.id,
      );
      tallyBrowserStorage.removeItem(
        `${EXPECTED_MACHINE_STORAGE_PREFIX}${payload.connection.id}`,
      );
      tallyBrowserStorage.setItem(
        `${CONNECTION_CONTROL_STORAGE_PREFIX}${payload.connection.id}`,
        payload.controlToken,
      );
      openConnectorUrl(
        buildConnectorConnectUrl(
          payload.connection,
          payload.pairingCode,
          payload.controlToken,
        ),
      );
      setMessage({
        tone: "success",
        text: "Connector launch requested. Approve the browser prompt if it appears.",
      });
      window.setTimeout(
        () => {
          void refreshStatus(payload.connection?.id || "");
          void refreshGlobalTallyStatus();
        },
        2500,
      );
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to connect Tally connector.",
      });
    } finally {
      setCreating(false);
    }
  }

  async function disconnectConnector() {
    if (!selectedConnection) return;

    try {
      setDisconnecting(true);
      setMessage(null);
      const controlToken = tallyBrowserStorage.getItem(
        `${CONNECTION_CONTROL_STORAGE_PREFIX}${selectedConnection.id}`,
      );
      if (!controlToken) {
        throw new Error(
          "This connection was created in another browser. Reconnect from this browser to manage it.",
        );
      }
      const response = await apiFetch(
        `/api/tally/connections/${selectedConnection.id}/disconnect`,
        {
          method: "POST",
          headers: {
            "x-tally-control-token": controlToken,
          },
        },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as StatusResponse;
      if (payload.connection) {
        setConnections((current) =>
          current.map((connection) =>
            connection.id === payload.connection?.id
              ? payload.connection
              : connection,
          ),
        );
      }
      tallyBrowserStorage.removeItem(
        `${EXPECTED_MACHINE_STORAGE_PREFIX}${selectedConnection.id}`,
      );
      // Keep this browser's binding so a paused installation can be resumed.
      await refreshGlobalTallyStatus();
      setMessage({
        tone: "success",
        text: "Tally connector paused.",
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to disconnect connector.",
      });
    } finally {
      setDisconnecting(false);
    }
  }

  async function disconnectOtherConnectors() {
    try {
      setDisconnectingOthers(true);
      setMessage(null);
      const response = await apiFetch(
        "/api/tally/connections/disconnect-others",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            keepConnectionId: selectedActiveConnectionId || null,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as DisconnectOthersResponse;
      const disconnectedIds = payload.disconnectedConnectionIds ?? [];
      for (const connectionId of disconnectedIds) {
        tallyBrowserStorage.removeItem(
          `${EXPECTED_MACHINE_STORAGE_PREFIX}${connectionId}`,
        );
        tallyBrowserStorage.removeItem(
          `${CONNECTION_CONTROL_STORAGE_PREFIX}${connectionId}`,
        );
      }

      const nextConnections = payload.connections ?? [];
      setConnections(nextConnections);
      setSelectedId((current) => {
        if (
          selectedActiveConnectionId &&
          nextConnections.some(
            (connection) => connection.id === selectedActiveConnectionId,
          )
        ) {
          return selectedActiveConnectionId;
        }
        if (nextConnections.some((connection) => connection.id === current)) {
          return current;
        }
        return nextConnections[0]?.id || "";
      });
      await refreshGlobalTallyStatus();
      setMessage({
        tone: "success",
        text:
          (payload.disconnectedCount ?? disconnectedIds.length) > 0
            ? "Other connector sessions disconnected."
            : "No other connector sessions were active.",
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to disconnect other connector sessions.",
      });
    } finally {
      setDisconnectingOthers(false);
    }
  }

  async function requestTest() {
    if (!selectedConnection) return;

    try {
      setTesting(true);
      setMessage(null);
      const response = await apiFetch(
        `/api/tally/connections/${selectedConnection.id}/test`,
        {
          method: "POST",
        },
      );
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as StatusResponse;
      if (payload.connection) {
        setConnections((current) =>
          current.map((connection) =>
            connection.id === payload.connection?.id
              ? payload.connection
              : connection,
          ),
        );
      }

      await refreshGlobalTallyStatus();

      setMessage({
        tone: "success",
        text: "Connection checked.",
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to test Tally connection.",
      });
    } finally {
      setTesting(false);
    }
  }

  useEffect(() => {
    void loadConnections();
  }, []);

  useEffect(() => {
    const tallyUrl = selectedConnection?.tallyUrl || DEFAULT_TALLY_URL;
    setTallyUrlInput(tallyUrl);
    setSetupMode(getSetupModeForUrl(tallyUrl));
  }, [selectedConnection?.id, selectedConnection?.tallyUrl]);

  useEffect(() => {
    if (!selectedConnectionId) return;
    void refreshStatus(selectedConnectionId);
    const timer = window.setInterval(() => {
      void refreshStatus(selectedConnectionId);
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [refreshStatus, selectedConnectionId]);

  useEffect(() => {
    if (!selectedConnection?.id) return;
    tallyBrowserStorage.setItem(
      SELECTED_CONNECTION_STORAGE_KEY,
      selectedConnection.id,
    );
  }, [selectedConnection?.id]);

  useEffect(() => {
    if (
      !selectedConnection?.id ||
      !selectedConnection.bridgeConnected ||
      !selectedConnection.bridgeMachineId
    ) {
      return;
    }
    const key = `${EXPECTED_MACHINE_STORAGE_PREFIX}${selectedConnection.id}`;
    if (!tallyBrowserStorage.getItem(key)) {
      tallyBrowserStorage.setItem(key, selectedConnection.bridgeMachineId);
    }
  }, [
    selectedConnection?.bridgeConnected,
    selectedConnection?.bridgeMachineId,
    selectedConnection?.id,
  ]);

  useEffect(() => {
    if (
      selectedConnection?.bridgeConnected &&
      message?.tone === "success" &&
      message.text.startsWith("Connector launch requested")
    ) {
      setMessage(null);
    }
  }, [message, selectedConnection?.bridgeConnected]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(
      () => setMessage(null),
      message.tone === "error" ? 6500 : 4000,
    );
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  if (view === "home") {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] flex-col overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="mb-5 border-b border-[#e5ddd0] pb-4">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-200/50 bg-amber-50 px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-800">
            <Sparkles className="h-3 w-3 text-amber-600 animate-spin duration-3000" />
            ERP Sync Bridge
          </div>
          <h1 className="mt-1.5 flex items-center gap-2 text-2xl font-black tracking-tight text-[#1a1a1a]">
            Tally Prime Integration
          </h1>
          <p className="mt-0.5 text-[11px] font-semibold text-slate-500">
            Sync your dealer verification workflows directly with Tally Prime
            company ledgers.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <HubCard
            description="Configure, test, or launch the Tally desktop sync connector."
            icon={<Server className="h-5.5 w-5.5" />}
            onClick={() => setView("connection")}
            status={
              loading ? "Checking..." : getStatusLabel(selectedConnection)
            }
            title="Tally Connection"
          />
          <HubCard
            description="Import, review, and post digitized bank statement entries."
            icon={<FileText className="h-5.5 w-5.5" />}
            onClick={() => router.push("/bank-statements")}
            status="Open Ledgers"
            title="Bank Statements"
          />
        </div>
        <FeedbackToast message={message} onClose={() => setMessage(null)} />
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-black tracking-tight text-[#1a1a1a]">
            Tally Connection
          </h2>
          <p className="mt-0.5 text-[11px] font-semibold text-slate-500">
            Connect Tally Prime to sync workflows and post bank statement ledger
            entries.
          </p>
        </div>
      </div>

      {!loading && !selectedConnection ? (
        <section className="mb-5 max-w-5xl overflow-hidden rounded-2xl border border-[#ddd5c9] bg-white shadow-[0_8px_24px_rgba(64,51,35,0.05)]">
          <div className="relative h-24 overflow-hidden border-b border-white/70">
            <Image
              alt=""
              aria-hidden="true"
              className="object-cover"
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 1000px"
              src="/images/tally/connection-waiting.webp"
            />
            <div className="absolute inset-0 flex items-center px-6" aria-hidden="true">
              <div className="flex items-center gap-2.5">
                {[PlugZap, Server].map((Icon, index) => (
                  <div
                    className="grid h-10 w-10 place-items-center rounded-xl border border-white/80 bg-white/90 text-[#4d463e] shadow-[0_4px_14px_rgba(68,55,40,0.10)] backdrop-blur-sm"
                    key={index}
                  >
                    <Icon className="h-4.5 w-4.5" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="p-5 sm:p-6">
            <div className="mb-4">
              <div className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-[#8a7f72]">
                First-time setup
              </div>
              <h3 className="mt-2 text-xl font-black tracking-tight text-[#1a1a1a]">
                Where does Tally run?
              </h3>
              <p className="mt-1 text-xs font-semibold text-[#6f6255]">
                Choose the location once. Gajkesari will remember it for this connector.
              </p>
            </div>

          <div className="grid max-w-3xl gap-3 md:grid-cols-2">
            <button
              className={`rounded-2xl border p-4 text-left transition ${
                setupMode === "same_machine"
                  ? "border-[#1a1a1a] bg-amber-50"
                  : "border-[#e5ddd0] bg-white hover:bg-[#faf8f4]"
              }`}
              onClick={() => {
                setSetupMode("same_machine");
                setTallyUrlInput(DEFAULT_TALLY_URL);
              }}
              aria-pressed={setupMode === "same_machine"}
              type="button"
            >
              <div className="text-sm font-extrabold text-[#1a1a1a]">
                Same machine
              </div>
              <div className="mt-1 text-xs font-semibold leading-5 text-slate-500">
                Tally and connector run on this computer.
              </div>
            </button>

            <button
              className={`rounded-2xl border p-4 text-left transition ${
                setupMode === "lan_server"
                  ? "border-[#1a1a1a] bg-amber-50"
                  : "border-[#e5ddd0] bg-white hover:bg-[#faf8f4]"
              }`}
              onClick={() => {
                setSetupMode("lan_server");
                setTallyUrlInput((current) =>
                  getSetupModeForUrl(current) === "same_machine" ? "" : current,
                );
              }}
              aria-pressed={setupMode === "lan_server"}
              type="button"
            >
              <div className="text-sm font-extrabold text-[#1a1a1a]">
                LAN/server
              </div>
              <div className="mt-1 text-xs font-semibold leading-5 text-slate-500">
                Connector reaches Tally on a Gold LAN machine.
              </div>
            </button>
          </div>

          {setupMode === "lan_server" ? (
            <div className="mt-4">
              <label
                className="text-[9px] font-bold uppercase tracking-wider text-slate-400"
                htmlFor="tally-url"
              >
                Tally server URL
              </label>
              <Input
                className="mt-2 h-11 rounded-xl border-[#d8ccbc] bg-white font-mono text-sm"
                id="tally-url"
                onChange={(event) => setTallyUrlInput(event.target.value)}
                placeholder={DEFAULT_LAN_TALLY_URL}
                value={tallyUrlInput}
              />
              <div className="mt-2 text-xs font-semibold leading-5 text-slate-500">
                Use the Tally server IP or hostname reachable from the connector
                machine.
              </div>
            </div>
          ) : null}
          <Button
            className="mt-5 rounded-xl bg-[#2d2d2d] px-5 text-xs font-bold text-white hover:bg-[#1a1a1a]"
            disabled={creating}
            onClick={() => void connectConnector()}
            type="button"
          >
            {creating ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <PlugZap className="mr-1.5 h-3.5 w-3.5" />
            )}
            Connect Tally
          </Button>
          </div>
        </section>
      ) : null}
      <FeedbackToast message={message} onClose={() => setMessage(null)} />

      {loading ? (
        <div className="overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white">
          <div className="h-24 animate-pulse bg-[#eee8de]" />
          <div className="space-y-3 p-5">
            <div className="h-4 w-32 animate-pulse rounded bg-[#eee8de]" />
            <div className="h-7 w-64 max-w-full animate-pulse rounded bg-[#eee8de]" />
            <div className="h-12 animate-pulse rounded-xl bg-[#f5f1ea]" />
          </div>
        </div>
      ) : selectedConnection ? (
        <article className="overflow-hidden rounded-2xl border border-[#ddd5c9] bg-white shadow-[0_8px_24px_rgba(64,51,35,0.05)]">
          <div className="relative h-24 overflow-hidden border-b border-white/70 sm:h-28">
            <Image
              alt=""
              aria-hidden="true"
              className="object-cover"
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 900px"
              src={connectionVisual.shader}
            />
            <div className="absolute inset-0 flex items-center px-5 sm:px-7" aria-hidden="true">
              <div className="flex items-center gap-2.5">
                {[
                  { done: connectorActive, icon: PlugZap },
                  { done: tallyReachable, icon: Server },
                  { done: companyLoaded, icon: Building2 },
                ].map((stage, index) => {
                  const Icon = stage.icon;
                  return (
                    <div
                      className={`grid h-10 w-10 place-items-center rounded-xl border border-white/80 bg-white/90 text-[#4d463e] shadow-[0_4px_14px_rgba(68,55,40,0.10)] backdrop-blur-sm ${stage.done ? "opacity-100" : "opacity-55"}`}
                      key={index}
                    >
                      <Icon className="h-4.5 w-4.5" />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="p-5 sm:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex min-w-0 items-start gap-3.5">
                {selectedCompany?.companyName ? (
                  <CompanyAvatar
                    name={selectedCompany.companyName}
                    size="md"
                    verified={connectionVisualState === "ready"}
                  />
                ) : null}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-[#8a7f72]">
                      {connectionVisual.eyebrow}
                    </span>
                    <Badge className={connectionVisual.badgeClass} variant="outline">
                      {connectionVisual.badge}
                    </Badge>
                  </div>
                  <h3 className="mt-2 text-xl font-black tracking-tight text-[#1a1a1a]">
                    {connectionVisual.title}
                  </h3>
                  <p className="mt-1.5 max-w-2xl text-xs font-semibold leading-5 text-[#6f6255]">
                    {connectionVisual.description}
                  </p>
                  <p className="mt-2 text-[10px] font-semibold text-[#9a8f82]">
                    {selectedConnection.displayName} · Last seen {formatTime(selectedConnection.lastHeartbeatAt)}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button
                  className="rounded-xl border-[#ddd3c5] bg-white text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4]"
                  disabled={testing}
                  onClick={() => void requestTest()}
                  type="button"
                  variant="outline"
                >
                  {testing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Check again
                </Button>
                {!connectorActive ? (
                  <Button
                    className="rounded-xl bg-[#2d2d2d] text-xs font-bold text-white hover:bg-[#1a1a1a]"
                    disabled={creating}
                    onClick={() => void connectConnector()}
                    type="button"
                  >
                    {creating ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PlugZap className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Reconnect
                  </Button>
                ) : (
                  <Button
                    className="rounded-xl border-amber-200 bg-amber-50 text-xs font-bold text-amber-900 hover:bg-amber-100"
                    disabled={disconnecting}
                    onClick={() => void disconnectConnector()}
                    type="button"
                    variant="outline"
                  >
                    {disconnecting ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PlugZap className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Pause connection
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-5 grid overflow-hidden rounded-xl border border-[#e8e1d7] bg-[#fbfaf8] sm:grid-cols-3 sm:divide-x sm:divide-[#e8e1d7]">
              {[
                {
                  label: "Connector",
                  value: connectorActive ? "Connected" : "Waiting",
                  detail: formatTime(selectedConnection.lastHeartbeatAt),
                  ok: connectorActive,
                },
                {
                  label: "Tally",
                  value: tallyReachable ? "Reachable" : "Not reachable",
                  detail: formatTime(selectedConnection.lastTestedAt),
                  ok: tallyReachable,
                },
                {
                  label: "Company",
                  value: companyLoaded ? "Loaded" : "Not detected",
                  detail: companyLoaded ? companyDetail : "Open a company in Tally",
                  ok: companyLoaded,
                },
              ].map((stage) => (
                <div className="flex min-w-0 items-start gap-2.5 border-b border-[#e8e1d7] px-3.5 py-3 last:border-b-0 sm:border-b-0" key={stage.label}>
                  {stage.ok ? (
                    <GradientSuccessMark
                      className="h-8 w-8 rounded-lg [&_svg]:h-4.5 [&_svg]:w-4.5"
                      size="md"
                    />
                  ) : (
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#b47a2f]" />
                  )}
                  <div className="min-w-0">
                    <div className="text-[9px] font-extrabold uppercase tracking-wider text-[#9a8f82]">
                      {stage.label}
                    </div>
                    <div className="mt-0.5 truncate text-xs font-extrabold text-[#2d2d2d]">
                      {stage.value}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] font-semibold text-[#8a7f72]" title={stage.detail}>
                      {stage.detail}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </article>
      ) : null}
    </div>
  );
}
