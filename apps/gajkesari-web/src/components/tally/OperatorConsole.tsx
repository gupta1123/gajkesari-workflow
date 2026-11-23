"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

const actions = {
  diagnose: "Diagnose connector",
  logs: "Read recent connector events",
  reconnect: "Reconnect live channel",
  followups: "Run payment follow-ups check",
  discount: "Explain cash discount",
  statement: "Trace bank statement",
  parse: "Preview PDF extraction",
  match: "Preview ledger matches",
  verify: "Verify transaction in Tally",
  update: "Install signed connector release",
};
type Action = keyof typeof actions;
type Device = {
  id: string;
  last_company_name: string | null;
  last_heartbeat_at: string | null;
  bridge_version: string | null;
};
type Dataset = { id: string; company_name: string; financial_year: string };
type Job = {
  id: string;
  operator_id: string;
  operation: Action;
  status: string;
  progress: string | null;
  error: string | null;
  created_at: string;
  result: Record<string, unknown> | null;
};
type Data = {
  connection: Device;
  datasets: Dataset[];
  jobs: Job[];
  statements: { id: string; original_file_name: string }[];
};
const stamp = (s: string | null) =>
  s ? new Date(s).toLocaleString() : "Never observed";
async function read<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch("/api/operator-support" + url, {
    cache: "no-store",
    ...init,
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Support unavailable.");
  return data;
}
const input = "block w-full rounded-lg border bg-white px-3 py-2 mt-1";

function Report({ value }: { value: unknown }) {
  if (value == null) return <span>Unavailable</span>;
  if (Array.isArray(value))
    return (
      <div className="space-y-2">
        {value.length
          ? value.map((row, i) => (
              <div key={i} className="border-l-2 pl-3">
                <Report value={row} />
              </div>
            ))
          : "None"}
      </div>
    );
  if (typeof value === "object")
    return (
      <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1">
        {Object.entries(value).map(([key, v]) => (
          <div key={key} className="contents">
            <dt className="text-slate-600">
              {key.replace(/([a-z])([A-Z])/g, "$1 $2")}
            </dt>
            <dd className="min-w-0 break-words">
              {typeof v === "object" && v !== null ? (
                <details>
                  <summary className="cursor-pointer">
                    {Array.isArray(v) ? v.length + " entries" : "Details"}
                  </summary>
                  <Report value={v} />
                </details>
              ) : (
                <Report value={v} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span>{String(value)}</span>;
}
export function OperatorConsole() {
  const [devices, setDevices] = useState<Device[]>([]),
    [id, setId] = useState(""),
    [ds, setDs] = useState("");
  const [data, setData] = useState<Data | null>(null),
    [action, setAction] = useState<Action>("diagnose");
  const [file, setFile] = useState(""),
    [row, setRow] = useState(""),
    [customer, setCustomer] = useState(""),
    [invoice, setInvoice] = useState(""),
    [version, setVersion] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    void read<{ connections: Device[] }>("", { signal: ctl.signal })
      .then((r) => {
        setDevices(r.connections);
        setId(r.connections[0]?.id || "");
        if (!r.connections.length)
          setError("Your account has no assigned installations.");
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(e.message);
      });
    return () => ctl.abort();
  }, []);
  useEffect(() => {
    if (!id) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const r = await read<Data>(
          "?" + new URLSearchParams({ connectionId: id, datasetId: ds }),
          { signal: ctl.signal },
        );
        if (ctl.signal.aborted) return;
        setData(r);
        if (!ds) setDs(r.datasets[0]?.id || "");
      } catch (e) {
        if (!ctl.signal.aborted)
          setError(e instanceof Error ? e.message : "Load failed.");
      }
      if (!ctl.signal.aborted) timer = setTimeout(() => void refresh(), 5000);
    }
    void refresh();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [id, ds, reload]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await read("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: id,
          datasetId: ds,
          operation: action,
          statementId: file,
          transactionId: row,
          customer,
          invoice,
          version,
        }),
      });
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit.");
    } finally {
      setBusy(false);
    }
  }
  const online =
    Date.now() - Date.parse(data?.connection.last_heartbeat_at || "") < 45000;
  return (
    <main className="mx-auto w-full max-w-5xl space-y-5 p-6 text-sm">
      <h1 className="text-2xl font-semibold">Remote connector support</h1>
      {error && (
        <p role="alert" className="rounded-lg border bg-red-50 p-3">
          {error}
        </p>
      )}
      {devices.length > 0 && (
        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl border bg-white p-5"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              Paired installation
              <select
                className={input}
                value={id}
                onChange={(e) => {
                  setId(e.target.value);
                  setDs("");
                  setData(null);
                  setFile("");
                  setRow("");
                  setError("");
                }}
              >
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.last_company_name || "Paired PC"} · {d.id.slice(-8)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tally company and year
              <select
                required
                className={input}
                value={ds}
                onChange={(e) => {
                  setDs(e.target.value);
                  setFile("");
                  setRow("");
                  setData(null);
                }}
              >
                {data?.datasets.map((d) => (
                  <option value={d.id} key={d.id}>
                    {d.company_name} · {d.financial_year}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {data && (
            <p>
              {online ? "Online" : "No recent heartbeat"} · Version{" "}
              {data.connection.bridge_version} · Last heartbeat{" "}
              {stamp(data.connection.last_heartbeat_at)}
            </p>
          )}
          <label className="block">
            Operation
            <select
              className={input}
              value={action}
              onChange={(e) => setAction(e.target.value as Action)}
            >
              {Object.entries(actions).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {["statement", "match", "parse", "verify"].includes(action) && (
            <label className="block">
              Statement
              <select
                required
                className={input}
                value={file}
                onChange={(e) => {
                  setFile(e.target.value);
                  setRow("");
                }}
              >
                <option value="">Select an upload</option>
                {data?.statements.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.original_file_name} · {f.id.slice(-8)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(action === "verify" || action === "statement") && (
            <label className="block">
              Transaction ID{" "}
              {action === "statement" ? "(optional)" : "from statement trace"}
              <input
                required={action === "verify"}
                className={input}
                value={row}
                onChange={(e) => setRow(e.target.value)}
              />
            </label>
          )}
          {["discount", "followups"].includes(action) && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                Customer (optional)
                <input
                  className={input}
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                />
              </label>
              <label>
                Invoice (optional)
                <input
                  className={input}
                  value={invoice}
                  onChange={(e) => setInvoice(e.target.value)}
                />
              </label>
            </div>
          )}
          {action === "update" && (
            <label className="block">
              Published version to install on this PC
              <input
                required
                pattern="[0-9]+\.[0-9]+\.[0-9]+"
                className={input}
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
            </label>
          )}
          <button
            disabled={!ds || busy || !data}
            className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? "Submitting…" : actions[action]}
          </button>
        </form>
      )}
      {data && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Request history</h2>
          {data.jobs.length === 0 && (
            <p>No support requests for this selection.</p>
          )}
          {data.jobs.map((j) => (
            <details key={j.id} className="mb-2 rounded-lg border bg-white p-3">
              <summary className="cursor-pointer">
                {actions[j.operation]} · {j.status} · {stamp(j.created_at)}
              </summary>
              <div className="mt-3">
                <p>Requested by {j.operator_id}</p>
                {j.progress && <p>{j.progress}</p>}
                {j.error && <p role="alert">{j.error}</p>}
                {j.result && <Report value={j.result} />}
              </div>
            </details>
          ))}
        </section>
      )}
    </main>
  );
}
