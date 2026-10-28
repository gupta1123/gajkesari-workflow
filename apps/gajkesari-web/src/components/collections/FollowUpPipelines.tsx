"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { loadLiveCashDiscountDashboard, type ScanInfo } from "@/lib/cash-discount-live-dashboard";
import { resolveTallyConnectionId } from "@/lib/resolve-tally-connection";
import {
  createPipelines, listPipelines, runPipelineAction,
  type FollowupPipeline, type PipelineAction, type ReminderMessage,
} from "@/lib/followups-client";

type Company = { id: string; connectionId: string; companyName: string; financialYear: string };

// One unpaid invoice as the live analysis reports it (Cash Discount page's data).
type DueInvoice = {
  id: string;
  followUpStatus: "needs_follow_up" | "escalate" | "needs_review";
  paymentCategory: "advance_rtgs" | "same_day_rtgs" | null;
  ageDays: number | null;
  ageLabel: string;
  dueDate: string | null;
  partyLedgerName: string;
  partyPhone: string | null;
  linkedInvoiceNumber: string | null;
  linkedInvoiceDate: string | null;
  originalInvoiceAmount: number;
  outstandingAmount: number;
  amountReceived: number;
  narration: string | null;
};
type FollowUpPayload = {
  kpis?: { paymentFollowUps?: number; paymentFollowUpAmount?: number };
  tabs?: { paymentFollowUps?: DueInvoice[] };
};

type Sort = "priority" | "most_overdue" | "highest_outstanding" | "oldest_invoice" | "customer";
const PAGE_SIZE = 25;
const MAX_SELECTED = 50;

const STATUS_LABEL: Record<FollowupPipeline["status"], string> = {
  active: "Active", paused: "Paused", review: "Needs review", settled: "Settled",
  finished: "Finished", stopped: "Stopped", sending: "Sending", uncertain: "Delivery uncertain",
};
const DUE_STATUS: Record<DueInvoice["followUpStatus"], { label: string; tone: string }> = {
  needs_follow_up: { label: "Needs follow-up", tone: "bg-amber-100 text-amber-900" },
  escalate: { label: "Escalate", tone: "bg-red-100 text-red-900" },
  needs_review: { label: "Needs review", tone: "bg-slate-200 text-slate-800" },
};
const TYPE_LABEL: Record<string, string> = { advance_rtgs: "Advance RTGS", same_day_rtgs: "Same-day RTGS" };

const inr = (value: number | null) =>
  value == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);

function isDue(row: FollowupPipeline) {
  return row.status === "active" && !!row.next_due_at && Date.parse(row.next_due_at) <= Date.now();
}

function tenDigits(value: string | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 10 ? digits : "";
}

export function FollowUpPipelines() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [rows, setRows] = useState<FollowupPipeline[]>([]);
  const [messages, setMessages] = useState<ReminderMessage[]>([]);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [due, setDue] = useState<DueInvoice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanLine, setScanLine] = useState("");
  const [scanInfo, setScanInfo] = useState<ScanInfo | null>(null);
  const [scanError, setScanError] = useState("");
  const [scannedAt, setScannedAt] = useState<Date | null>(null);

  const [query, setQuery] = useState("");
  const [paymentType, setPaymentType] = useState("all");
  const [sort, setSort] = useState<Sort>("priority");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [starting, setStarting] = useState(false);
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState("");
  const [everyDays, setEveryDays] = useState("3");
  const [limit, setLimit] = useState("3");
  const [startBusy, setStartBusy] = useState(false);

  const company = companies.find((c) => c.id === companyId) ?? companies[0] ?? null;

  const refresh = useCallback(async () => {
    const data = await listPipelines();
    setRows(data.pipelines);
    setMessages(data.messages);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const connectorId = await resolveTallyConnectionId();
        const response = await apiFetch(`/api/tally/companies?connectionId=${encodeURIComponent(connectorId)}`, { cache: "no-store" });
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

  const scan = useCallback(async () => {
    if (!company) return;
    setScanning(true);
    setScanError("");
    setScanLine("Starting...");
    try {
      const payload = await loadLiveCashDiscountDashboard<FollowUpPayload>({
        connectionId: company.connectionId,
        companyName: company.companyName,
        financialYear: company.financialYear,
        onProgress: setScanLine,
        onScanInfo: setScanInfo,
      });
      setDue(payload.tabs?.paymentFollowUps ?? []);
      setScannedAt(new Date());
      setSelected(new Set());
      setPage(1);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "Could not read Tally.");
    } finally {
      setScanning(false);
      setScanLine("");
    }
  }, [company?.connectionId, company?.companyName, company?.financialYear]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening the page scans once; the connector keeps a saved copy of Tally's
  // vouchers, so repeat scans take seconds.
  useEffect(() => { void scan(); }, [scan]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = due.filter((row) =>
      (paymentType === "all" || (paymentType === "other" ? !row.paymentCategory : row.paymentCategory === paymentType)) &&
      (!needle || row.partyLedgerName.toLowerCase().includes(needle) || String(row.linkedInvoiceNumber ?? "").toLowerCase().includes(needle)));
    const sorted = [...filtered];
    if (sort === "most_overdue") sorted.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
    else if (sort === "highest_outstanding") sorted.sort((a, b) => b.outstandingAmount - a.outstandingAmount);
    else if (sort === "oldest_invoice") sorted.sort((a, b) => String(a.linkedInvoiceDate ?? "9999").localeCompare(String(b.linkedInvoiceDate ?? "9999")));
    else if (sort === "customer") sorted.sort((a, b) => a.partyLedgerName.localeCompare(b.partyLedgerName));
    return sorted;
  }, [due, query, paymentType, sort]);

  useEffect(() => { setPage(1); }, [query, paymentType, sort]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const totals = useMemo(() => ({
    needs: due.filter((row) => row.followUpStatus === "needs_follow_up").length,
    escalate: due.filter((row) => row.followUpStatus === "escalate").length,
    review: due.filter((row) => row.followUpStatus === "needs_review").length,
    outstanding: due.reduce((sum, row) => sum + row.outstandingAmount, 0),
  }), [due]);
  const selectedRows = due.filter((row) => selected.has(row.id));

  const toggle = (row: DueInvoice) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(row.id)) next.delete(row.id);
    else if (next.size < MAX_SELECTED && row.linkedInvoiceNumber) next.add(row.id);
    return next;
  });
  const togglePage = () => setSelected((current) => {
    const next = new Set(current);
    const selectable = pageRows.filter((row) => row.linkedInvoiceNumber);
    const allOn = selectable.every((row) => next.has(row.id));
    for (const row of selectable) {
      if (allOn) next.delete(row.id);
      else if (next.size < MAX_SELECTED) next.add(row.id);
    }
    return next;
  });

  const openStart = () => {
    setPhones(Object.fromEntries(selectedRows.map((row) => [row.id, tenDigits(row.partyPhone)])));
    setTemplate((current) => current || messages[0]?.key || "");
    setStarting(true);
  };

  const submitStart = async () => {
    if (!company || !selectedRows.length) return;
    if (!template) return setNotice({ tone: "error", text: "Choose a reminder message." });
    setStartBusy(true);
    setNotice(null);
    try {
      const result = await createPipelines({
        connectionId: company.connectionId,
        companyName: company.companyName,
        financialYear: company.financialYear,
        plan: { name: "Standard", stages: [{ name: "Reminder", template, delay: 0, every: Number(everyDays) || 3, unit: "days", limit: Number(limit) || 3 }] },
        invoices: selectedRows.map((row) => ({
          customer: row.partyLedgerName,
          invoice: row.linkedInvoiceNumber ?? "",
          invoiceDate: row.linkedInvoiceDate ?? "",
          recipient: phones[row.id] ?? "",
          narration: row.narration ?? "",
        })),
      });
      const problems = result.skipped.map((entry) => `${entry.invoice}: ${entry.reason}`).join(" · ");
      setNotice({
        tone: result.skipped.length && !result.created.length ? "error" : "ok",
        text: `${result.created.length} reminder(s) started. Nothing is sent until you press Send.${problems ? ` Skipped — ${problems}` : ""}`,
      });
      if (result.created.length) { setStarting(false); setSelected(new Set()); }
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not start the reminders." });
    } finally {
      setStartBusy(false);
    }
  };

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

  const field = "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm";
  const card = "rounded-lg border border-slate-200 bg-white p-4";

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Payment follow-ups</h1>
          <p className="text-sm text-slate-600">Unpaid invoices past their terms, straight from Tally. Every send re-checks the outstanding amount first, and nothing is sent until you press Send.</p>
        </div>
        <div className="flex items-center gap-2">
          {companies.length > 1 && (
            <select className={field} value={company?.id ?? ""} onChange={(e) => setCompanyId(e.target.value)}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.companyName}</option>)}
            </select>
          )}
          <button className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm disabled:opacity-50" disabled={scanning || !company} onClick={() => void scan()}>
            {scanning ? "Scanning…" : "Rescan Tally"}
          </button>
        </div>
      </header>

      {(scanning || scanInfo) && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {scanInfo ? <strong>{scanInfo.label}. </strong> : null}{scanInfo?.detail}{scanning && scanLine ? ` ${scanLine}` : ""}
          {!scanning && scannedAt ? ` Scanned at ${scannedAt.toLocaleTimeString("en-IN")}.` : ""}
        </p>
      )}
      {scanError && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{scanError}</p>}
      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          {notice.text}
        </p>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Needs follow-up", totals.needs, "Up to 30 days overdue"],
          ["Escalate", totals.escalate, "More than 30 days overdue"],
          ["Needs review", totals.review, "Dates or allocations unclear"],
          ["Outstanding", inr(totals.outstanding), `${due.length} invoice(s)`],
        ].map(([label, value, note]) => (
          <div key={String(label)} className={card}>
            <div className="text-xs uppercase text-slate-500">{label}</div>
            <div className="mt-1 text-2xl font-semibold">{value}</div>
            <div className="text-xs text-slate-500">{note}</div>
          </div>
        ))}
      </section>

      <section className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${field} w-64`} type="search" placeholder="Search customer or invoice" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className={field} value={paymentType} onChange={(e) => setPaymentType(e.target.value)}>
            <option value="all">All payment types</option>
            <option value="advance_rtgs">Advance RTGS</option>
            <option value="same_day_rtgs">Same-day RTGS</option>
            <option value="other">Other terms</option>
          </select>
          <select className={field} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="priority">Priority</option>
            <option value="most_overdue">Most overdue</option>
            <option value="highest_outstanding">Highest outstanding</option>
            <option value="oldest_invoice">Oldest invoice</option>
            <option value="customer">Customer</option>
          </select>
          <div className="ml-auto flex items-center gap-2 text-sm">
            {selectedRows.length > 0 && <span className="text-slate-600">{selectedRows.length} selected</span>}
            <button className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={!selectedRows.length} onClick={openStart}>
              Start reminders
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="w-8 p-2"><input type="checkbox" aria-label="Select this page" checked={pageRows.length > 0 && pageRows.filter((r) => r.linkedInvoiceNumber).every((r) => selected.has(r.id))} onChange={togglePage} /></th>
                <th className="p-2">Customer</th><th className="p-2">Invoice</th><th className="p-2">Terms</th>
                <th className="p-2 text-right">Outstanding</th><th className="p-2">Overdue</th><th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {scanning && !due.length && <tr><td className="p-4 text-slate-500" colSpan={7}>Reading Tally…</td></tr>}
              {!scanning && !visible.length && <tr><td className="p-4 text-slate-500" colSpan={7}>{due.length ? "No invoices match the filters." : "No invoices are due for a follow-up."}</td></tr>}
              {pageRows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 align-top">
                  <td className="p-2"><input type="checkbox" aria-label={`Select ${row.linkedInvoiceNumber ?? row.partyLedgerName}`} disabled={!row.linkedInvoiceNumber} checked={selected.has(row.id)} onChange={() => toggle(row)} /></td>
                  <td className="p-2">{row.partyLedgerName}<div className="text-xs text-slate-500">{row.partyPhone ? `+${tenDigits(row.partyPhone) ? "91" + tenDigits(row.partyPhone) : row.partyPhone}` : "No phone in Tally"}</div></td>
                  <td className="p-2">{row.linkedInvoiceNumber ?? "—"}<div className="text-xs text-slate-500">{row.linkedInvoiceDate ?? ""}</div></td>
                  <td className="p-2">{row.paymentCategory ? TYPE_LABEL[row.paymentCategory] : "—"}{row.dueDate && <div className="text-xs text-slate-500">Due {row.dueDate}</div>}</td>
                  <td className="p-2 text-right">{inr(row.outstandingAmount)}{row.amountReceived > 0.5 && <div className="text-xs text-slate-500">of {inr(row.originalInvoiceAmount)}</div>}</td>
                  <td className="p-2">{row.ageLabel}</td>
                  <td className="p-2"><span className={`rounded-full px-2 py-0.5 text-xs ${DUE_STATUS[row.followUpStatus].tone}`}>{DUE_STATUS[row.followUpStatus].label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length > PAGE_SIZE && (
          <div className="flex items-center justify-between text-sm text-slate-600">
            <span>{(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, visible.length)} of {visible.length}</span>
            <div className="flex gap-2">
              <button className="underline disabled:opacity-40" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>Previous</button>
              <button className="underline disabled:opacity-40" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>Next</button>
            </div>
          </div>
        )}
      </section>

      {starting && (
        <section className={`${card} space-y-3`}>
          <h2 className="text-sm font-medium">Start reminders for {selectedRows.length} invoice(s)</h2>
          {messages.length === 0 ? (
            <p className="text-sm text-amber-800">No WhatsApp reminder template is registered for this deployment yet (FOLLOWUP_WHATSAPP_TEMPLATES_JSON), so reminders cannot be started.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <select className={field} value={template} onChange={(e) => setTemplate(e.target.value)}>
                  <option value="">Message…</option>
                  {messages.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                </select>
                <label>Repeat every <input className={`${field} w-14`} value={everyDays} onChange={(e) => setEveryDays(e.target.value)} /> days</label>
                <label>Up to <input className={`${field} w-14`} value={limit} onChange={(e) => setLimit(e.target.value)} /> reminders</label>
              </div>
              <table className="w-full text-left text-sm">
                <tbody>
                  {selectedRows.map((row) => (
                    <tr key={row.id} className="border-t border-slate-100">
                      <td className="p-1">{row.partyLedgerName}</td>
                      <td className="p-1">{row.linkedInvoiceNumber}</td>
                      <td className="p-1">{inr(row.outstandingAmount)}</td>
                      <td className="p-1"><input className={`${field} w-44`} placeholder="WhatsApp, 10 digits" value={phones[row.id] ?? ""} onChange={(e) => setPhones((p) => ({ ...p, [row.id]: e.target.value }))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex gap-3 text-sm">
                <button className="rounded-md bg-slate-900 px-3 py-1.5 text-white disabled:opacity-50" disabled={startBusy || !template} onClick={() => void submitStart()}>
                  {startBusy ? "Checking Tally…" : "Verify & start reminders"}
                </button>
                <button className="underline" disabled={startBusy} onClick={() => setStarting(false)}>Cancel</button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Reminders</h2>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr><th className="p-2">Customer</th><th className="p-2">Invoice</th><th className="p-2">Outstanding</th><th className="p-2">Status</th><th className="p-2">Next</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td className="p-4 text-slate-500" colSpan={6}>No reminders yet. Select invoices above and press Start reminders.</td></tr>}
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
        </div>
      </section>
    </div>
  );
}
