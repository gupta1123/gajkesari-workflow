"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clipboard,
  FileText,
  Loader2,
  PlugZap,
  RefreshCw,
  Server,
  Sparkles,
  Terminal,
  TriangleAlert,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
};

type CompanyOption = {
  id: string;
  connectionId: string;
  companyName: string;
  financialYear: string;
};

type ConnectionsResponse = {
  connections?: TallyConnection[];
  error?: string;
};

type CreateConnectionResponse = {
  connection?: TallyConnection;
  pairingCode?: string;
  error?: string;
};

type StatusResponse = {
  connection?: TallyConnection;
  error?: string;
};

type CompaniesResponse = {
  companies?: CompanyOption[];
  selectedCompanyId?: string | null;
  error?: string;
};

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
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
  if (connection.status === "waiting_for_bridge") return "Waiting for connector";
  return "Not connected";
}

function getStatusTone(connection?: TallyConnection | null) {
  if (!connection) return "neutral";
  if (connection.status === "company_loaded") return "success";
  if (connection.status === "tally_reachable" || connection.status === "bridge_connected") return "warning";
  if (connection.status === "connection_error") return "error";
  return "neutral";
}

const DEFAULT_BRIDGE_API_BASE_URL = "https://gajkesari-workflow-api.herokuapp.com";

function getBridgeApiBaseUrl() {
  const configuredBaseUrl = (
    process.env.NEXT_PUBLIC_BRIDGE_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    ""
  ).replace(/\/+$/, "");
  if (configuredBaseUrl) return configuredBaseUrl;
  return DEFAULT_BRIDGE_API_BASE_URL;
}

function escapeCommandValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildPairCommand(connection: TallyConnection, pairingCode: string) {
  const apiBaseUrl = getBridgeApiBaseUrl();
  return `npm.cmd run pair -- --api-base "${apiBaseUrl}" --connection-id "${connection.id}" --pairing-code "${pairingCode}"`;
}

function buildStartCommand(connection?: TallyConnection | null) {
  const companyFlag = connection?.lastCompanyName
    ? ` -- --company-name "${escapeCommandValue(connection.lastCompanyName)}"`
    : "";

  return `npm.cmd run start${companyFlag}`;
}

function formatCompanyOptionLabel(company: CompanyOption) {
  return [company.companyName, company.financialYear].filter(Boolean).join(" - ");
}

function buildConnectorConnectUrl(connection: TallyConnection, pairingCode: string) {
  const params = new URLSearchParams({
    apiBase: getBridgeApiBaseUrl(),
    connectionId: connection.id,
    pairingCode,
    tallyUrl: connection.tallyUrl || "http://localhost:9000",
  });

  return `gajkesari-tally://connect?${params.toString()}`;
}

function buildConnectorDisconnectUrl(connection: TallyConnection) {
  const params = new URLSearchParams({
    connectionId: connection.id,
  });

  return `gajkesari-tally://disconnect?${params.toString()}`;
}

function openConnectorUrl(value: string) {
  window.location.assign(value);
}

function StatusCard({
  title,
  value,
  ok,
  detail,
}: {
  title: string;
  value: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all duration-300 hover:shadow-[0_4px_12px_rgba(0,0,0,0.03)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
            {title}
          </div>
          <div className="mt-2 text-base font-extrabold text-[#1a1a1a]">{value}</div>
          <div className="mt-1 text-xs font-semibold text-slate-400 leading-snug">{detail}</div>
        </div>
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${
          ok ? "bg-emerald-50 border-emerald-100 text-emerald-600" : "bg-amber-50 border-amber-100 text-amber-600"
        }`}>
          {ok ? (
            <CheckCircle2 className="h-4.5 w-4.5" />
          ) : (
            <TriangleAlert className="h-4.5 w-4.5" />
          )}
        </div>
      </div>
    </div>
  );
}

function CommandBlock({
  title,
  command,
  onCopy,
}: {
  title: string;
  command: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
          <Terminal className="h-4 w-4 text-slate-400" />
          {title}
        </div>
        <Button
          className="h-8 rounded-xl border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all"
          onClick={() => onCopy(command)}
          type="button"
          variant="outline"
        >
          <Clipboard className="h-3.5 w-3.5 mr-1" />
          Copy
        </Button>
      </div>
      <code className="block overflow-x-auto whitespace-nowrap rounded-xl bg-[#2d2d2d] px-4 py-3 font-mono text-[11px] font-semibold text-[#f7f7f5] border border-black/10">
        {command}
      </code>
    </div>
  );
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
        <p className="mt-2 text-xs font-semibold leading-relaxed text-slate-500">{description}</p>
      </div>
      <div className="mt-6 w-fit rounded-full border border-amber-250 bg-amber-50 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-800">
        {status}
      </div>
    </button>
  );
}

export function TallyPrimeDashboard() {
  const router = useRouter();
  const [view, setView] = useState<"home" | "connection">("home");
  const [connections, setConnections] = useState<TallyConnection[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const selectedConnection =
    connections.find((connection) => connection.id === selectedId) ?? connections[0] ?? null;
  const selectedCompany =
    companies.find((company) => company.connectionId === selectedConnection?.id) ?? companies[0] ?? null;
  const statusTone = getStatusTone(selectedConnection);
  const connectorActive = Boolean(selectedConnection?.bridgeConnected);
  const companyDetail = selectedCompany?.companyName || selectedConnection?.lastCompanyName
    || (selectedConnection?.lastCompanyLoaded ? "Company loaded" : "Company not detected yet");
  const pairCommand = useMemo(() => {
    if (!selectedConnection || !pairingCode) return "";
    return buildPairCommand(selectedConnection, pairingCode);
  }, [pairingCode, selectedConnection]);
  const startCommand = useMemo(() => buildStartCommand(selectedConnection), [selectedConnection]);

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
      setSelectedId((current) =>
        nextConnections.some((connection) => connection.id === current)
          ? current
          : nextConnections[0]?.id || ""
      );

      const companyResponse = await apiFetch("/api/tally/companies", {
        method: "GET",
        cache: "no-store",
      });
      if (companyResponse.ok) {
        const companyPayload = (await companyResponse.json()) as CompaniesResponse;
        setCompanies(companyPayload.companies ?? []);
      }
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to load Tally connections.",
      });
    } finally {
      setLoading(false);
    }
  }

  const refreshStatus = useCallback(async (connectionId: string) => {
    if (!connectionId) return;

    try {
      const response = await apiFetch(`/api/tally/connections/${connectionId}/status`, {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as StatusResponse;
      if (!payload.connection) return;

      setConnections((current) =>
        current.map((connection) =>
          connection.id === payload.connection?.id ? payload.connection : connection
        )
      );
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to refresh Tally status.",
      });
    }
  }, []);

  async function connectConnector() {
    try {
      setCreating(true);
      setMessage(null);
      const response = await apiFetch("/api/tally/connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Tally Prime",
          tallyUrl: "http://localhost:9000",
        }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as CreateConnectionResponse;
      if (!payload.connection || !payload.pairingCode) {
        throw new Error("Connection created, but pairing details were missing.");
      }

      setConnections((current) => [payload.connection as TallyConnection, ...current]);
      setSelectedId(payload.connection.id);
      setPairingCode(payload.pairingCode);
      openConnectorUrl(buildConnectorConnectUrl(payload.connection, payload.pairingCode));
      setMessage({
        tone: "success",
        text: "Connector launch requested. Approve the browser prompt if it appears.",
      });
      window.setTimeout(() => void refreshStatus(payload.connection?.id || ""), 2500);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to connect Tally connector.",
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
      openConnectorUrl(buildConnectorDisconnectUrl(selectedConnection));
      const response = await apiFetch(`/api/tally/connections/${selectedConnection.id}/disconnect`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as StatusResponse;
      if (payload.connection) {
        setConnections((current) =>
          current.map((connection) =>
            connection.id === payload.connection?.id ? payload.connection : connection
          )
        );
      }
      setPairingCode("");
      setMessage({
        tone: "success",
        text: "Connector disconnected.",
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to disconnect connector.",
      });
    } finally {
      setDisconnecting(false);
    }
  }

  async function requestTest() {
    if (!selectedConnection) return;

    try {
      setTesting(true);
      setMessage(null);
      const response = await apiFetch(`/api/tally/connections/${selectedConnection.id}/test`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const payload = (await response.json()) as StatusResponse;
      if (payload.connection) {
        setConnections((current) =>
          current.map((connection) =>
            connection.id === payload.connection?.id ? payload.connection : connection
          )
        );
      }

      setMessage({
        tone: "success",
        text: "Connection checked.",
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to test Tally connection.",
      });
    } finally {
      setTesting(false);
    }
  }

  async function copyText(value: string) {
    await navigator.clipboard.writeText(value);
    setMessage({ tone: "success", text: "Command copied." });
  }

  useEffect(() => {
    void loadConnections();
  }, []);

  useEffect(() => {
    if (!selectedConnection) return;
    const timer = window.setInterval(() => {
      void refreshStatus(selectedConnection.id);
    }, 10_000);

    return () => window.clearInterval(timer);
  }, [refreshStatus, selectedConnection]);

  if (view === "home") {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] flex-col overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="mb-8 border-b border-[#e5ddd0] pb-6">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200/50 text-[10px] font-bold uppercase tracking-wider text-amber-800">
            <Sparkles className="h-3 w-3 text-amber-600 animate-spin duration-3000" />
            ERP Sync Bridge
          </div>
          <h1 className="text-3xl font-black tracking-tight text-[#1a1a1a] mt-2 flex items-center gap-2">
            Tally Prime Integration
          </h1>
          <p className="text-xs font-semibold text-slate-500 mt-1">
            Sync your dealer verification workflows directly with Tally Prime company ledgers.
          </p>
        </div>

        {message ? (
          <div
            className={`mb-6 rounded-xl border px-4 py-3 text-sm font-medium ${message.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
              }`}
          >
            {message.text}
          </div>
        ) : null}

        <div className="grid gap-5 md:grid-cols-2">
          <HubCard
            description="Configure, test, or launch the Tally desktop sync connector."
            icon={<Server className="h-5.5 w-5.5" />}
            onClick={() => setView("connection")}
            status={loading ? "Checking..." : getStatusLabel(selectedConnection)}
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
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <button
            className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-[#1a1a1a] transition-all"
            onClick={() => setView("home")}
            type="button"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Tally Home
          </button>
          <h2 className="text-2xl font-black tracking-tight text-[#1a1a1a]">Tally Connection</h2>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            Connect Tally Prime to sync workflows and post bank statement ledger entries.
          </p>
        </div>
      </div>

      {message ? (
        <div
          className={`mb-6 rounded-xl border px-4 py-3 text-sm font-medium ${message.tone === "success"
              ? "border-emerald-255 bg-emerald-50 text-emerald-800"
              : "border-red-255 bg-red-50 text-red-800"
            }`}
        >
          {message.text}
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-2xl bg-white border border-[#e5ddd0]" />
          ))}
        </div>
      ) : selectedConnection ? (
        <div className="space-y-5">
          <div className="rounded-2xl border border-[#e5ddd0] bg-white p-6 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 border border-amber-100/50 text-amber-700">
                  <Server className="h-5.5 w-5.5" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-extrabold text-[#1a1a1a]">{selectedConnection.displayName}</h3>
                    <Badge
                      className={
                        statusTone === "success"
                          ? "border-emerald-250 bg-emerald-50 text-emerald-800"
                          : statusTone === "error"
                            ? "border-red-255 bg-red-55 text-red-855"
                            : statusTone === "warning"
                              ? "border-amber-250 bg-amber-50 text-amber-800"
                              : "border-[#e5ddd0] bg-white text-slate-500"
                      }
                      variant="outline"
                    >
                      {getStatusLabel(selectedConnection)}
                    </Badge>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-500">
                    {selectedCompany ? formatCompanyOptionLabel(selectedCompany) : companyDetail}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2.5">
                <Button
                  className="rounded-xl border-[#e5ddd0] bg-white text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all"
                  disabled={loading}
                  onClick={() => void loadConnections()}
                  type="button"
                  variant="outline"
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  Refresh
                </Button>
                <Button
                  className="w-fit rounded-xl border-[#e5ddd0] bg-white text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all"
                  disabled={testing}
                  onClick={() => void requestTest()}
                  type="button"
                  variant="outline"
                >
                  {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                  Test Connection
                </Button>
                {connectorActive ? (
                  <Button
                    className="w-fit rounded-xl border-red-250 bg-red-50 text-xs font-bold text-red-800 hover:bg-red-100 hover:text-red-900 shadow-sm transition-all"
                    disabled={disconnecting}
                    onClick={() => void disconnectConnector()}
                    type="button"
                    variant="outline"
                  >
                    {disconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <PlugZap className="h-3.5 w-3.5 mr-1.5" />}
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    className="w-fit rounded-xl bg-[#2d2d2d] hover:bg-[#1a1a1a] text-xs font-bold text-white shadow-md transition-all"
                    disabled={creating}
                    onClick={() => void connectConnector()}
                    type="button"
                  >
                    {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <PlugZap className="h-3.5 w-3.5 mr-1.5" />}
                    Connect
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <StatusCard
              detail={`Last seen: ${formatTime(selectedConnection.lastHeartbeatAt)}`}
              ok={Boolean(selectedConnection.bridgeConnected)}
              title="Connector"
              value={selectedConnection.bridgeConnected ? "Connected" : "Waiting"}
            />
            <StatusCard
              detail={`Last checked: ${formatTime(selectedConnection.lastTestedAt)}`}
              ok={selectedConnection.lastTallyReachable === true}
              title="Tally"
              value={selectedConnection.lastTallyReachable ? "Reachable" : "Not reachable"}
            />
            <StatusCard
              detail={selectedConnection.lastCompanyName || selectedConnection.lastError || companyDetail}
              ok={selectedConnection.lastCompanyLoaded === true}
              title="Company"
              value={selectedConnection.lastCompanyLoaded ? "Loaded" : "Not detected"}
            />
          </div>
        </div>
      ) : (
        <div className="flex min-h-[320px] items-center justify-center rounded-2xl border-2 border-dashed border-[#e5ddd0] bg-white p-8 text-center shadow-sm">
          <div>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-50 border border-amber-200/50 text-amber-700">
              <PlugZap className="h-6 w-6 animate-pulse" />
            </div>
            <h3 className="mt-4 text-base font-extrabold text-[#1a1a1a]">No Tally connection found</h3>
            <p className="mt-1.5 text-xs font-semibold text-slate-400 max-w-sm">
              Bridge this workstation to start the Tally Prime desktop agent and sync ledgers.
            </p>
            <Button
              className="mt-6 rounded-xl bg-[#2d2d2d] hover:bg-[#1a1a1a] px-6 py-5 text-xs font-bold text-white shadow-md transition-all"
              disabled={creating}
              onClick={() => void connectConnector()}
              type="button"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <PlugZap className="h-3.5 w-3.5 mr-1.5" />}
              Connect Bridge
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
