"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type Capability = { allowed: boolean; supported: boolean; version: string | null; lastHeartbeatAt: string | null };
type Diagnostics = {
  companyName: string | null; companyGuid: string | null; financialYear: string | null; companyMatches: boolean;
  checkedAt: string; companyObservedAt: string | null; bridgeVersion: string;
  live: { state: string; gatewayHost: string | null; lastAttemptAt: string | null; lastAuthenticatedAt: string | null; lastCloseCode: number | null; lastError: string | null };
  dues: { status: string; preparedAt: string | null; customers: number | null; openBills: number | null } | null;
};

function time(value: string | null) {
  return value ? new Date(value).toLocaleString() : "No observation";
}

export function ConnectorSupport({ connectionId, companyName, onReconnect }: {
  connectionId: string; companyName: string; onReconnect: () => void;
}) {
  const [capability, setCapability] = useState<Capability | null>(null);
  const [report, setReport] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const path = `/api/tally/connections/${connectionId}/commands`;

  useEffect(() => {
    const abort = new AbortController();
    void apiFetch(path + "?support=1", { signal: abort.signal, cache: "no-store" })
      .then(async response => { if (response.ok && !abort.signal.aborted) setCapability(await response.json()); })
      .catch(() => {});
    return () => { abort.abort(); controller.current?.abort(); };
  }, [path]);

  async function run(reconnect: boolean) {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setReport(null);
    setMessage("Waiting for the paired connector...");
    try {
      const response = await apiFetch(path, { method: "POST", signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandType: reconnect ? "reconnect_live_channel" : "get_connector_diagnostics", payload: { companyName } }) });
      const queued = await response.json();
      if (!response.ok || !queued.command?.id) throw new Error(queued.error || "Could not queue support request.");
      const deadline = Date.now() + 100_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        abort.signal.throwIfAborted();
        const result = await apiFetch(path + "?ids=" + encodeURIComponent(queued.command.id), { signal: abort.signal, cache: "no-store" });
        const data = await result.json();
        if (!result.ok) throw new Error(data.error || "Could not read command status.");
        const command = data.commands?.[0];
        if (command?.status === "failed" || command?.status === "canceled") throw new Error(command.error || "Support command stopped.");
        if (command?.status === "succeeded") {
          setReport(command.result);
          setMessage(reconnect ? "Live channel authenticated. Refreshing Collections..." : "");
          if (reconnect) onReconnect();
          return;
        }
      }
      throw new Error("The connector has not reported a result. Check its heartbeat.");
    } catch (error) {
      if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "Support request failed.");
    } finally {
      controller.current = null;
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  if (!capability?.allowed) return null;
  const button = "rounded-lg border bg-white px-3 py-1.5 font-medium disabled:opacity-50";
  return <details className="mb-4 rounded-xl border bg-white px-4 py-3 text-sm">
    <summary className="cursor-pointer font-semibold">Connector support</summary>
    <p className="my-2">Version {capability.version ?? "unknown"} &middot; Last reported heartbeat {time(capability.lastHeartbeatAt)}</p>
    {capability.supported ? <div className="flex gap-2">
      <button type="button" className={button} disabled={busy} onClick={() => void run(false)}>Diagnose</button>
      <button type="button" className={button} disabled={busy} onClick={() => void run(true)}>Reconnect live channel</button>
    </div> : <p>Install connector 0.1.96 or later to run support commands.</p>}
    <p role="status">{message}</p>
    {report && <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt>Checked</dt><dd>{time(report.checkedAt)}</dd>
      <dt>Active company</dt><dd>{report.companyName ?? "Unknown"} &middot; {report.financialYear ?? "Year unknown"} &middot; {report.companyGuid ?? "GUID unknown"} ({time(report.companyObservedAt)})</dd>
      <dt>Live channel</dt><dd>{report.live.state} &middot; {report.live.gatewayHost ?? "Unknown host"}</dd>
      <dt>Last attempt</dt><dd>{time(report.live.lastAttemptAt)}</dd>
      <dt>Last authentication</dt><dd>{time(report.live.lastAuthenticatedAt)}</dd>
      <dt>Last disconnect</dt><dd>{report.live.lastCloseCode ?? "None recorded"} &middot; {report.live.lastError ?? "No error recorded"}</dd>
      <dt>Customer dues</dt><dd>{report.companyMatches ? report.dues?.status : "Selected company does not match the observation"}</dd>
      {report.dues?.preparedAt && <><dt>Prepared</dt><dd>{time(report.dues.preparedAt)} &middot; {report.dues.customers} customers &middot; {report.dues.openBills} open bills</dd></>}
    </dl>}
  </details>;
}
