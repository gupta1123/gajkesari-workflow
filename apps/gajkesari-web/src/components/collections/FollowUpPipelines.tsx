"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  createPipelines, listPipelines, runPipelineAction,
  type FollowupPipeline, type PipelineAction, type ReminderMessage,
} from "@/lib/followups-client";

type Company = { id: string; connectionId: string; companyName: string; financialYear: string };

const STATUS_LABEL: Record<FollowupPipeline["status"], string> = {
  active: "Active", paused: "Paused", review: "Needs review", settled: "Settled",
  finished: "Finished", stopped: "Stopped", sending: "Sending", uncertain: "Delivery uncertain",
};

const inr = (value: number | null) =>
  value == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);

function isDue(row: FollowupPipeline) {
  return row.status === "active" && !!row.next_due_at && Date.parse(row.next_due_at) <= Date.now();
}

export function FollowUpPipelines() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [rows, setRows] = useState<FollowupPipeline[]>([]);
  const [messages, setMessages] = useState<ReminderMessage[]>([]);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [form, setForm] = useState({ customer: "", invoice: "", invoiceDate: "", phone: "", narration: "", template: "", everyDays: "3", limit: "3" });
  const [adding, setAdding] = useState(false);

  const company = companies.find((c) => c.id === companyId) ?? companies[0] ?? null;

  const refresh = useCallback(async () => {
    const data = await listPipelines();
    setRows(data.pipelines);
    setMessages(data.messages);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const response = await apiFetch("/api/tally/companies", { cache: "no-store" });
        const payload = await response.json();
        if (response.ok) {
          setCompanies(payload.companies ?? []);
          setCompanyId(payload.selectedCompanyId || payload.companies?.[0]?.id || "");
        }
        await refresh();
      } catch (error) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load reminders." });
      }
    })();
  }, [refresh]);

  const act = async (row: FollowupPipeline, action: PipelineAction) => {
    if (!company) return setNotice({ tone: "error", text: "Connect a Tally company first." });
    if (action === "send" && !window.confirm(`Send a WhatsApp reminder to ${row.customer} for ${row.invoice}?`)) return;
    setBusyId(row.id);
    setNotice(null);
    try {
      const result = await runPipelineAction(row, action, company.connectionId);
      setNotice({
        tone: "ok",
        text: action === "send" ? (result.sent ? "Reminder sent." : result.note || "Nothing was sent.")
          : result.note || `Reminder ${action === "check" ? "checked against Tally" : "updated"}.`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Action failed." });
    } finally {
      setBusyId("");
      await refresh().catch(() => undefined);
    }
  };

  const add = async () => {
    if (!company) return setNotice({ tone: "error", text: "Connect a Tally company first." });
    if (!form.template) return setNotice({ tone: "error", text: "Choose a reminder message." });
    setAdding(true);
    setNotice(null);
    try {
      const result = await createPipelines({
        connectionId: company.connectionId,
        companyName: company.companyName,
        financialYear: company.financialYear,
        plan: {
          name: "Standard",
          stages: [{ name: "Reminder", template: form.template, delay: 0, every: Number(form.everyDays) || 3, unit: "days", limit: Number(form.limit) || 3 }],
        },
        invoices: [{ customer: form.customer, invoice: form.invoice, invoiceDate: form.invoiceDate, recipient: form.phone, narration: form.narration }],
      });
      const skipped = result.skipped[0];
      setNotice(skipped ? { tone: "error", text: skipped.reason } : { tone: "ok", text: "Reminder added. Nothing is sent until you press Send." });
      if (!skipped) setForm((f) => ({ ...f, customer: "", invoice: "", invoiceDate: "", phone: "" }));
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not add the reminder." });
    } finally {
      setAdding(false);
    }
  };

  const field = "rounded-md border border-slate-300 px-2 py-1.5 text-sm";

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Payment follow-ups</h1>
        <p className="text-sm text-slate-600">
          Every send re-checks the outstanding amount in Tally first. Reminders are only sent when you press Send.
        </p>
      </header>

      {companies.length > 1 && (
        <select className={field} value={company?.id ?? ""} onChange={(e) => setCompanyId(e.target.value)}>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.companyName}</option>)}
        </select>
      )}

      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          {notice.text}
        </p>
      )}

      <section className="rounded-lg border border-slate-200 p-4">
        <h2 className="mb-3 text-sm font-medium">Add an invoice</h2>
        {messages.length === 0 ? (
          <p className="text-sm text-amber-700">No WhatsApp reminder template is configured yet.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-4">
            <input className={field} placeholder="Customer ledger (exact Tally name)" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} />
            <input className={field} placeholder="Invoice / bill number" value={form.invoice} onChange={(e) => setForm({ ...form, invoice: e.target.value })} />
            <input className={field} type="date" value={form.invoiceDate} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} />
            <input className={field} placeholder="WhatsApp number (10 digits)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input className={field} placeholder="Invoice narration (optional, e.g. ADVANCE RTGS)" value={form.narration} onChange={(e) => setForm({ ...form, narration: e.target.value })} />
            <select className={field} value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
              <option value="">Message…</option>
              {messages.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
            </select>
            <label className="text-sm">Repeat every <input className={`${field} w-16`} value={form.everyDays} onChange={(e) => setForm({ ...form, everyDays: e.target.value })} /> days</label>
            <label className="text-sm">Up to <input className={`${field} w-16`} value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} /> reminders</label>
            <button className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={adding || !company} onClick={add}>
              {adding ? "Checking Tally…" : "Verify & add"}
            </button>
          </div>
        )}
      </section>

      <section className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr><th className="p-2">Customer</th><th className="p-2">Invoice</th><th className="p-2">Outstanding</th><th className="p-2">Status</th><th className="p-2">Next</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td className="p-4 text-slate-500" colSpan={6}>No reminders yet.</td></tr>}
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100 align-top">
                <td className="p-2">{row.customer}<div className="text-xs text-slate-500">+{row.recipient}</div></td>
                <td className="p-2">{row.invoice}<div className="text-xs text-slate-500">{row.invoice_date ?? ""}</div></td>
                <td className="p-2">{inr(row.outstanding)}</td>
                <td className="p-2">{STATUS_LABEL[row.status]}{row.note && <div className="text-xs text-slate-500">{row.note}</div>}</td>
                <td className="p-2">{row.next_due_at ? new Date(row.next_due_at).toLocaleString("en-IN") : "—"}</td>
                <td className="space-x-2 whitespace-nowrap p-2">
                  <button disabled={busyId === row.id} className="text-slate-700 underline" onClick={() => act(row, "check")}>Check</button>
                  {isDue(row) && <button disabled={busyId === row.id} className="font-medium text-emerald-700 underline" onClick={() => act(row, "send")}>Send</button>}
                  {row.status === "active" && <button disabled={busyId === row.id} className="underline" onClick={() => act(row, "pause")}>Pause</button>}
                  {(row.status === "paused" || row.status === "review") && <button disabled={busyId === row.id} className="underline" onClick={() => act(row, "resume")}>Resume</button>}
                  {["active", "paused", "review", "uncertain"].includes(row.status) && <button disabled={busyId === row.id} className="text-red-700 underline" onClick={() => act(row, "stop")}>Stop</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
