"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { loadLiveCashDiscountDashboard, type ScanInfo } from "@/lib/cash-discount-live-dashboard";
import { resolveTallyConnectionId } from "@/lib/resolve-tally-connection";
import {
  createPipelines, listPipelines, runPipelineAction,
  type FollowupAttempt, type FollowupPipeline, type PipelineAction, type ReminderMessage,
} from "@/lib/followups-client";
import "./followups.css";

type Company = { id: string; connectionId: string; companyName: string; financialYear: string };

// One unpaid invoice as the live analysis reports it (the Cash Discount page's data).
type DueInvoice = {
  id: string;
  followUpStatus: "needs_follow_up" | "escalate" | "needs_review";
  paymentCategory: "advance_rtgs" | "same_day_rtgs" | null;
  ageDays: number | null;
  ageLabel: string;
  partyLedgerName: string;
  partyPhone: string | null;
  linkedInvoiceNumber: string | null;
  linkedInvoiceDate: string | null;
  originalInvoiceAmount: number;
  outstandingAmount: number;
  narration: string | null;
};
type FollowUpPayload = { tabs?: { paymentFollowUps?: DueInvoice[] } };

type Tab = "due" | "dues" | "pipelines" | "history";
type Sort = "priority" | "most_overdue" | "highest" | "oldest" | "customer";
type Kind = "all" | "regular" | "same_day" | "advance" | "unclear";

const MAX_SELECTED = 50;

// Same schedule as Kalika's standard payment reminders.
const STANDARD_STAGES = [
  { name: "First reminder", delay: 0, every: 1, unit: "days" as const, limit: 1 },
  { name: "Regular follow-up", delay: 2, every: 2, unit: "days" as const, limit: 3 },
  { name: "Final reminders", delay: 1, every: 1, unit: "days" as const, limit: 3 },
];
const LIVE = ["active", "paused", "review"];

const STATUS_LABEL: Record<FollowupPipeline["status"], string> = {
  active: "Active", paused: "Paused", review: "Needs review", settled: "Settled",
  finished: "Limit reached", stopped: "Stopped", sending: "Sending", uncertain: "Delivery uncertain",
};
const KIND_LABEL: Record<Exclude<Kind, "all">, string> = {
  regular: "Regular credit", same_day: "Same-day RTGS", advance: "Advance RTGS", unclear: "Unclear terms",
};
const ATTEMPT_LABEL: Record<FollowupAttempt["status"], { label: string; cls: string }> = {
  submitting: { label: "Queued", cls: "pill-stone" },
  accepted: { label: "Submitted", cls: "pill-amber" },
  rejected: { label: "Rejected", cls: "pill-red" },
  uncertain: { label: "Uncertain", cls: "pill-sky" },
};

const money = (value: number | null | undefined) =>
  value == null ? "Not checked" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
const fmtDate = (value: string | null | undefined) =>
  value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const fmtDateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
const maskPhone = (value: string | null | undefined) => (value ? `+91 ${value.slice(-10, -5)} ${value.slice(-5)}` : "—");

function tenDigits(value: string | null | undefined) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 10 ? digits : "";
}

function kindOf(row: DueInvoice): Exclude<Kind, "all"> {
  if (row.followUpStatus === "needs_review") return "unclear";
  if (row.paymentCategory === "advance_rtgs") return "advance";
  if (row.paymentCategory === "same_day_rtgs") return "same_day";
  return "regular";
}

const isDue = (row: FollowupPipeline) =>
  (row.status === "active" && !!row.next_due_at && Date.parse(row.next_due_at) <= Date.now()) || row.status === "review";
const isOpen = (row: FollowupPipeline) => !["settled", "finished", "stopped"].includes(row.status);

function ageCell(row: DueInvoice) {
  if (kindOf(row) === "unclear") return <span className="muted">Terms unclear</span>;
  const days = row.ageDays ?? 0;
  if (days > 0) return <span className={days > 30 ? "age-bad" : "age-warn"}>{row.ageLabel || `Overdue ${days} days`}</span>;
  return <span>{row.ageLabel || "Due today"}</span>;
}

function messageText(template: string | undefined, row: { customer: string; invoice: string; invoice_date: string | null; outstanding: number | null }, company: string) {
  const values: Record<string, string> = {
    customer: row.customer, company, invoice: row.invoice, invoice_date: fmtDate(row.invoice_date),
    outstanding: new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(row.outstanding ?? 0),
  };
  return (template ?? "").replace(/\{\{(customer|company|invoice|invoice_date|outstanding)\}\}/g, (_, key: string) => values[key]);
}

function WhatsappBubble({ name, phone, text }: { name: string; phone: string; text: string }) {
  const initials = name.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="wa">
      <div className="wa-bar"><span className="wa-av">{initials}</span><div className="wa-who"><b>{name}</b><small>{maskPhone(phone)}</small></div></div>
      <div className="wa-body">
        <div className="wa-day">Today</div>
        <div className="wa-msg">{text.split("\n").map((line, index) => <span key={index}>{line}<br /></span>)}</div>
      </div>
    </div>
  );
}

export function FollowUpPipelines() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [rows, setRows] = useState<FollowupPipeline[]>([]);
  const [attempts, setAttempts] = useState<FollowupAttempt[]>([]);
  const [messages, setMessages] = useState<ReminderMessage[]>([]);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const [due, setDue] = useState<DueInvoice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanLine, setScanLine] = useState("");
  const [scanInfo, setScanInfo] = useState<ScanInfo | null>(null);
  const [scanError, setScanError] = useState("");
  const [scannedAt, setScannedAt] = useState<Date | null>(null);

  const [tab, setTab] = useState<Tab>("dues");
  const [kind, setKind] = useState<Kind>("all");
  const [sort, setSort] = useState<Sort>("priority");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmStop, setConfirmStop] = useState(false);
  const [menuId, setMenuId] = useState("");

  // Start-reminders card (replaces the list, like the demo).
  const [enrolling, setEnrolling] = useState<{ ids: string[]; once: boolean } | null>(null);
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState("");
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState("");

  // Review & send drawer.
  const [review, setReview] = useState<{ ids: string[]; focus: string; off: Set<string> } | null>(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState("");
  const [detailId, setDetailId] = useState("");

  const company = companies.find((c) => c.id === companyId) ?? companies[0] ?? null;

  const refresh = useCallback(async () => {
    const data = await listPipelines();
    setRows(data.pipelines);
    setAttempts(data.attempts ?? []);
    setMessages(data.messages);
    return data.pipelines;
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
        setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not load reminders." });
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

  // Opening the page scans once; the connector keeps a saved copy of Tally's vouchers.
  useEffect(() => { void scan(); }, [scan]);

  const pipelineFor = useCallback(
    (row: DueInvoice) => rows.find((p) => p.invoice === row.linkedInvoiceNumber && p.customer === row.partyLedgerName && isOpen(p)),
    [rows]
  );

  const visibleDues = useMemo(() => {
    const filtered = due.filter((row) => kind === "all" || kindOf(row) === kind);
    const sorted = [...filtered];
    if (sort === "priority" || sort === "most_overdue") sorted.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
    else if (sort === "highest") sorted.sort((a, b) => b.outstandingAmount - a.outstandingAmount);
    else if (sort === "oldest") sorted.sort((a, b) => String(a.linkedInvoiceDate ?? "9999").localeCompare(String(b.linkedInvoiceDate ?? "9999")));
    else sorted.sort((a, b) => a.partyLedgerName.localeCompare(b.partyLedgerName));
    return sorted;
  }, [due, kind, sort]);

  const dueReminders = useMemo(() => rows.filter(isDue), [rows]);
  const tabRows: Array<DueInvoice | FollowupPipeline> =
    tab === "dues" ? visibleDues : tab === "due" ? dueReminders : tab === "pipelines" ? rows : [];
  const total = tab === "history" ? attempts.length : tabRows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const slice = <T,>(list: T[]) => list.slice((safePage - 1) * pageSize, safePage * pageSize);
  const pageDues = tab === "dues" ? slice(visibleDues) : [];
  const pagePipes = tab === "due" ? slice(dueReminders) : tab === "pipelines" ? slice(rows) : [];
  const pageIds = tab === "dues" ? pageDues.filter((row) => row.linkedInvoiceNumber).map((row) => row.id) : pagePipes.map((row) => row.id);

  const kpis = useMemo(() => {
    const confirmed = due.filter((row) => kindOf(row) !== "unclear");
    const unclear = due.filter((row) => kindOf(row) === "unclear");
    return {
      early: confirmed.filter((row) => (row.ageDays ?? 0) >= 1 && (row.ageDays ?? 0) <= 30).length,
      late: confirmed.filter((row) => (row.ageDays ?? 0) > 30).length,
      amount: confirmed.reduce((sum, row) => sum + row.outstandingAmount, 0),
      unclear: unclear.length,
      unclearAmount: unclear.reduce((sum, row) => sum + row.outstandingAmount, 0),
    };
  }, [due]);

  const changeTab = (next: Tab) => { setTab(next); setPage(1); setSelected(new Set()); setEnrolling(null); setConfirmStop(false); };
  const toggle = (id: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (!on) next.delete(id);
    else if (next.size < MAX_SELECTED) next.add(id);
    return next;
  });
  const togglePage = (on: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const id of pageIds) {
      if (!on) next.delete(id);
      else if (next.size < MAX_SELECTED) next.add(id);
    }
    return next;
  });

  const say = (tone: "ok" | "warn" | "err", text: string) => setNotice({ tone, text });

  const openEnroll = (ids: string[], once: boolean) => {
    const chosen = due.filter((row) => ids.includes(row.id) && !pipelineFor(row));
    if (!chosen.length) return say("warn", "Those invoices are already in follow-ups.");
    setPhones(Object.fromEntries(chosen.map((row) => [row.id, tenDigits(row.partyPhone)])));
    setTemplate((current) => current || messages[0]?.key || "");
    setEnrolling({ ids: chosen.map((row) => row.id), once });
    setEnrollError("");
  };

  const submitEnroll = async () => {
    if (!company || !enrolling) return;
    const chosen = due.filter((row) => enrolling.ids.includes(row.id));
    if (!template) return setEnrollError("No WhatsApp reminder message is configured yet. Ask your administrator to register an approved template.");
    const missing = chosen.filter((row) => !/^[6-9]\d{9}$/.test(phones[row.id] ?? ""));
    if (missing.length) return setEnrollError(`Enter a valid 10-digit mobile number for ${missing.map((row) => row.partyLedgerName).slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}.`);
    setEnrollBusy(true);
    setEnrollError("");
    try {
      const result = await createPipelines({
        connectionId: company.connectionId,
        companyName: company.companyName,
        financialYear: company.financialYear,
        plan: {
          name: enrolling.once ? "Send once" : "Standard",
          stages: enrolling.once
            ? [{ name: "One-time message", template, delay: 0, every: 1, unit: "days", limit: 1 }]
            : STANDARD_STAGES.map((stage) => ({ ...stage, template })),
        },
        invoices: chosen.map((row) => ({
          customer: row.partyLedgerName,
          invoice: row.linkedInvoiceNumber ?? "",
          invoiceDate: row.linkedInvoiceDate ?? "",
          recipient: phones[row.id],
          narration: row.narration ?? "",
        })),
      });
      const problems = result.skipped.map((entry) => `${entry.invoice}: ${entry.reason}`).join(" · ");
      say(result.skipped.length ? "warn" : "ok", `${result.created.length} reminder(s) started. Nothing is sent until you review and press Send.${problems ? ` Skipped: ${problems}` : ""}`);
      if (result.created.length) { setEnrolling(null); setSelected(new Set()); changeTab("pipelines"); }
      await refresh();
    } catch (error) {
      setEnrollError(error instanceof Error ? error.message : "Could not start the reminders.");
    } finally {
      setEnrollBusy(false);
    }
  };

  const act = async (row: FollowupPipeline, action: PipelineAction) => {
    if (!company) throw new Error("Connect a Tally company first.");
    return runPipelineAction(row, action, company.connectionId);
  };

  const bulkAct = async (action: "pause" | "resume" | "stop" | "check") => {
    const targets = rows.filter((row) => selected.has(row.id) && (
      action === "pause" ? ["active", "review"].includes(row.status)
        : action === "resume" ? row.status === "paused"
          : action === "stop" ? LIVE.includes(row.status)
            : isDue(row) || row.status === "paused"));
    if (!targets.length) return;
    setBusy("bulk");
    let done = 0;
    let failed = "";
    for (const row of targets) {
      try { await act(row, action); done += 1; } catch (error) { failed = error instanceof Error ? error.message : "Action failed."; }
    }
    setBusy("");
    setSelected(new Set());
    setConfirmStop(false);
    say(failed ? "warn" : "ok", `${action === "check" ? "Checked" : action === "pause" ? "Paused" : action === "resume" ? "Resumed" : "Stopped"} ${done} reminder(s) in Tally.${failed ? ` ${failed}` : ""}`);
    await refresh().catch(() => undefined);
  };

  // Review & send: the server re-reads the outstanding amount from Tally first.
  const openReview = async (ids: string[]) => {
    const targets = rows.filter((row) => ids.includes(row.id) && (row.status === "active" || row.status === "review"));
    if (!targets.length) return;
    setBusy("review");
    say("ok", `Checking ${targets.length} invoice(s) in Tally before review…`);
    let failed = "";
    for (const row of targets) {
      try { await act(row, "check"); } catch (error) { failed = error instanceof Error ? error.message : "Check failed."; }
    }
    const fresh = await refresh().catch(() => rows);
    setBusy("");
    const ready = fresh.filter((row) => ids.includes(row.id) && row.status === "active");
    const gone = targets.length - ready.length;
    if (!ready.length) return say(failed ? "err" : "ok", failed || "Nothing left to send. The checked invoices were paid in full or need review.");
    say(failed || gone ? "warn" : "ok", gone ? `${gone} paid in full or held for review. Review the remaining ${ready.length}.` : failed || "Checked in Tally.");
    setSelected(new Set());
    setReview({ ids: ready.map((row) => row.id), focus: ready[0].id, off: new Set() });
  };

  const sendReviewed = async () => {
    if (!review) return;
    const ids = review.ids.filter((id) => !review.off.has(id));
    setSending(true);
    let sent = 0;
    let failed = "";
    for (const id of ids) {
      const row = rows.find((p) => p.id === id);
      if (!row) continue;
      try {
        const result = await act(row, "send");
        if (result.sent) sent += 1; else failed = result.note || "Nothing was sent.";
      } catch (error) { failed = error instanceof Error ? error.message : "Send failed."; }
      await refresh().catch(() => undefined);
    }
    setSending(false);
    setReview(null);
    say(failed ? "warn" : "ok", `${sent} message(s) submitted to WhatsApp.${failed ? ` ${failed}` : ""}`);
    changeTab("history");
  };

  const rowAction = async (row: FollowupPipeline, action: PipelineAction) => {
    setMenuId("");
    setBusy(row.id);
    try {
      const result = await act(row, action);
      say("ok", result.note || `Reminder ${action === "check" ? "checked against Tally" : "updated"}.`);
    } catch (error) {
      say("err", error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy("");
      await refresh().catch(() => undefined);
    }
  };

  const selectedCount = selected.size;
  const selPipes = rows.filter((row) => selected.has(row.id));
  const selDues = due.filter((row) => selected.has(row.id));
  const startable = selDues.filter((row) => !pipelineFor(row));
  const noPhone = startable.filter((row) => !tenDigits(row.partyPhone)).length;
  const tallyOk = !scanError;
  const messageFor = (key: string) => messages.find((m) => m.key === key)?.text;
  const detail = rows.find((row) => row.id === detailId);
  const focusRow = review ? rows.find((row) => row.id === review.focus) : undefined;
  const enrollRows = enrolling ? due.filter((row) => enrolling.ids.includes(row.id)) : [];

  const bulkBar = selectedCount > 0 && !enrolling && (
    <div className="bulkbar">
      <span className="bb-count">{selectedCount} selected</span><span className="bb-sep" />
      {tab === "dues" ? (
        <>
          <button className="bb pri" disabled={!startable.length} onClick={() => openEnroll(startable.map((row) => row.id), false)}>Start reminders<small>{startable.length}</small></button>
          <button className="bb" disabled={!startable.length} onClick={() => openEnroll(startable.map((row) => row.id), true)}>Send once<small>{startable.length}</small></button>
          {noPhone > 0 && <button className="bb warn" onClick={() => openEnroll(startable.map((row) => row.id), false)}>⚠ {noPhone} no contact</button>}
        </>
      ) : (
        <>
          <button className="bb pri" disabled={!selPipes.some(isDue)} onClick={() => void openReview(selPipes.filter(isDue).map((row) => row.id))}>Review &amp; send<small>{selPipes.filter(isDue).length}</small></button>
          <span className="bb-sep" />
          <button className="bb" disabled={!selPipes.some((row) => isDue(row) || row.status === "paused")} onClick={() => void bulkAct("check")}>Check<small>{selPipes.filter((row) => isDue(row) || row.status === "paused").length}</small></button>
          <button className="bb" disabled={!selPipes.some((row) => ["active", "review"].includes(row.status))} onClick={() => void bulkAct("pause")}>Pause<small>{selPipes.filter((row) => ["active", "review"].includes(row.status)).length}</small></button>
          <button className="bb" disabled={!selPipes.some((row) => row.status === "paused")} onClick={() => void bulkAct("resume")}>Resume<small>{selPipes.filter((row) => row.status === "paused").length}</small></button>
          {confirmStop ? (
            <>
              <span className="bb-sep" /><span style={{ fontSize: 12.5 }}>Stop {selPipes.filter((row) => LIVE.includes(row.status)).length} reminder(s)?</span>
              <button className="bb dng" onClick={() => void bulkAct("stop")}>Confirm</button>
              <button className="bb" onClick={() => setConfirmStop(false)}>Cancel</button>
            </>
          ) : (
            <button className="bb dng" disabled={!selPipes.some((row) => LIVE.includes(row.status))} onClick={() => setConfirmStop(true)}>Stop reminders<small>{selPipes.filter((row) => LIVE.includes(row.status)).length}</small></button>
          )}
        </>
      )}
      <button className="bb-x" aria-label="Clear selection" onClick={() => { setSelected(new Set()); setConfirmStop(false); }}>×</button>
    </div>
  );

  return (
    <div className="fu">
      <div className="page">
        <header className="ph">
          <div className="ph-top">
            <div className="ph-title">
              <h1>Payment Follow-ups</h1><span className="ph-dot">·</span><span className="ph-sub">Prioritize overdue payments</span>
            </div>
            <div className="ph-actions">
              {companies.length > 1 && (
                <select className="cs" aria-label="Company" value={company?.id ?? ""} onChange={(e) => setCompanyId(e.target.value)}>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.companyName} · {c.financialYear}</option>)}
                </select>
              )}
              <span className={`hchip${tallyOk ? "" : " bad"}`}>{tallyOk ? "Tally connected" : "Tally not ready"}</span>
              <button className="btn hd" disabled={scanning || !company} onClick={() => void scan()}>
                {scanning ? <><span className="spin" />Refreshing…</> : "Refresh"}
              </button>
            </div>
          </div>
        </header>

        <div className="metaline">
          <span>
            {company ? `FY ${company.financialYear}` : ""}
            {scanning ? ` · ${scanLine || "Checking…"}` : scannedAt ? ` · Checked ${scannedAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}` : ""}
            {scanInfo ? ` · ${scanInfo.label}: ${scanInfo.detail}` : ""}
          </span>
        </div>

        {notice && <div className={`alert ${notice.tone}`} onClick={() => setNotice(null)}>{notice.text}</div>}
        {scanError && <div className="alert err">{scanError}</div>}

        <div className="kpis">
          <div className="kpi"><div className="l">Overdue 1–30 days</div><div className="v">{kpis.early}</div><div className="n">Invoices</div></div>
          <div className="kpi"><div className="l">Outstanding (excluding review)</div><div className="v">{money(kpis.amount)}</div><div className="n">Confirmed invoices</div></div>
          <div className="kpi"><div className="l">Overdue 31+ days</div><div className="v">{kpis.late}</div><div className="n">Invoices</div></div>
          <div className="kpi"><div className="l">Needs review</div><div className="v">{kpis.unclear}</div><div className="n">{money(kpis.unclearAmount)} · unclear terms</div></div>
        </div>

        <div className="tabbar">
          <div className="tabs">
            <button className={`tab${tab === "due" ? " active" : ""}`} onClick={() => changeTab("due")}>Reminders due{dueReminders.length > 0 && <span className="tbadge">{dueReminders.length}</span>}</button>
            <button className={`tab${tab === "dues" ? " active" : ""}`} onClick={() => changeTab("dues")}>Unpaid invoices</button>
            <button className={`tab${tab === "pipelines" ? " active" : ""}`} onClick={() => changeTab("pipelines")}>Reminder tracking</button>
            <button className={`tab${tab === "history" ? " active" : ""}`} onClick={() => changeTab("history")}>Sent messages</button>
          </div>
          <div className="tb-right">
            {enrolling ? (
              <button className="btn" onClick={() => setEnrolling(null)}>← Back to unpaid invoices</button>
            ) : tab === "dues" ? (
              <>
                <select aria-label="Payment type" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setPage(1); }}>
                  <option value="all">All payment types</option>
                  {(Object.keys(KIND_LABEL) as Array<keyof typeof KIND_LABEL>).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
                <label className="sortlbl">Sort
                  <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                    <option value="priority">Priority</option><option value="most_overdue">Most overdue</option>
                    <option value="highest">Highest outstanding</option><option value="oldest">Oldest invoice</option><option value="customer">Customer name</option>
                  </select>
                </label>
              </>
            ) : null}
          </div>
          {bulkBar}
        </div>

        {enrolling ? (
          <div className="enroll">
            <div className="eh">
              <small>{enrolling.once ? "Send once" : "Invoice reminders"}</small>
              <h3>{enrollRows.length === 1 ? enrollRows[0].partyLedgerName : `${enrollRows.length} invoices`}</h3>
              <p>{enrollRows.length === 1 ? `${enrollRows[0].linkedInvoiceNumber} · ${fmtDate(enrollRows[0].linkedInvoiceDate)} · Outstanding ${money(enrollRows[0].outstandingAmount)}` : `Outstanding ${money(enrollRows.reduce((sum, row) => sum + row.outstandingAmount, 0))}`}</p>
            </div>
            <div className="eb">
              {enrollRows.map((row) => (
                <label className="f" key={row.id}>
                  <span>{enrollRows.length > 1 ? `${row.partyLedgerName} · ${row.linkedInvoiceNumber}` : "Customer’s WhatsApp number"}{tenDigits(row.partyPhone) ? " (on file)" : ""}</span>
                  <input type="tel" inputMode="numeric" maxLength={10} placeholder="10-digit mobile number" value={phones[row.id] ?? ""}
                    onChange={(e) => setPhones((current) => ({ ...current, [row.id]: e.target.value.replace(/\D/g, "").slice(-10) }))} />
                </label>
              ))}
              <label className="f">
                <span>WhatsApp message</span>
                <select value={template} onChange={(e) => setTemplate(e.target.value)}>
                  {messages.length === 0 && <option value="">No WhatsApp reminder message is configured yet</option>}
                  {messages.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                </select>
              </label>
              {!enrolling.once && (
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7, color: "#51483f" }}>
                  <li><b>First reminder</b> when you start, one message</li>
                  <li><b>Regular follow-up</b> 2 days later, every 2 days, up to 3 messages</li>
                  <li><b>Final reminders</b> 1 day later, every day, up to 3 messages</li>
                </ol>
              )}
              {enrollError && <div className="alert err" style={{ margin: 0 }}>{enrollError}</div>}
            </div>
            <div className="ef">
              <button className="btn lg primary" style={{ width: "100%" }} disabled={enrollBusy} onClick={() => void submitEnroll()}>
                {enrollBusy ? <><span className="spin" />Verifying…</> : enrolling.once ? "Queue one message" : "Start reminders"}
              </button>
              <p className="enote">The outstanding balance is checked in Tally before this is created. Nothing is sent until you review it and press Send.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="footnote">
              {tab === "dues" && "Open invoices read from Tally. Select invoices to start reminders in bulk."}
              {tab === "due" && "Reminders that are due now. Tally is checked before each one is sent."}
              {tab === "pipelines" && "Every reminder journey, running or finished."}
              {tab === "history" && "Every WhatsApp reminder, newest first."}
            </p>
            <div className="flat">
              {scanning && tab === "dues" && !due.length ? <div className="skel" /> : tab === "dues" ? (
                <table className="grid">
                  <thead><tr>
                    <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all on this page" checked={pageIds.length > 0 && pageIds.every((id) => selected.has(id))} onChange={(e) => togglePage(e.target.checked)} /></th>
                    <th>Customer</th><th style={{ width: "20%" }}>Invoice</th><th className="r" style={{ width: 140 }}>Outstanding</th>
                    <th style={{ width: 170 }}>Payment terms</th><th style={{ width: "15%" }}>Payment age</th><th style={{ width: 150 }}>Reminders</th>
                  </tr></thead>
                  <tbody>
                    {pageDues.map((row) => {
                      const pipe = pipelineFor(row);
                      const phone = tenDigits(row.partyPhone);
                      return (
                        <tr key={row.id}>
                          <td><input type="checkbox" aria-label={`Select ${row.linkedInvoiceNumber}`} disabled={!row.linkedInvoiceNumber} checked={selected.has(row.id)} onChange={(e) => toggle(row.id, e.target.checked)} /></td>
                          <td><span className="cname" title={row.partyLedgerName}>{row.partyLedgerName}</span>{!phone && <span className="csub">No contact on file</span>}</td>
                          <td>{row.linkedInvoiceNumber ?? "—"}<span className="csub">{fmtDate(row.linkedInvoiceDate)}</span></td>
                          <td className="r num">{money(row.outstandingAmount)}</td>
                          <td>{KIND_LABEL[kindOf(row)]}</td>
                          <td>{ageCell(row)}</td>
                          <td>{pipe
                            ? <span className="pill pill-stone">{STATUS_LABEL[pipe.status]}</span>
                            : <button className="btn" disabled={!row.linkedInvoiceNumber} onClick={() => openEnroll([row.id], false)}>Start reminders</button>}</td>
                        </tr>
                      );
                    })}
                    {!pageDues.length && <tr><td colSpan={7} className="empty">{scanError ? "Tally could not be read." : "No unpaid invoices need a follow-up."}</td></tr>}
                  </tbody>
                </table>
              ) : tab === "history" ? (
                <table className="grid p">
                  <thead><tr><th style={{ width: "26%" }}>Customer / invoice</th><th className="r" style={{ width: 150 }}>Amount</th><th style={{ width: "18%" }}>WhatsApp number</th><th style={{ width: "20%" }}>Sent at</th><th>Status</th></tr></thead>
                  <tbody>
                    {slice(attempts).map((attempt) => {
                      const pipe = rows.find((row) => row.id === attempt.pipeline_id);
                      const status = ATTEMPT_LABEL[attempt.status];
                      return (
                        <tr key={attempt.id}>
                          <td><span className="cname">{pipe?.customer ?? "—"}</span><span className="csub">{pipe?.invoice}</span></td>
                          <td className="r num">{money(attempt.outstanding)}</td>
                          <td>{maskPhone(attempt.recipient)}</td>
                          <td>{fmtDateTime(attempt.created_at)}</td>
                          <td><span className={`pill ${status.cls}`}>{status.label}</span>{attempt.error && <span className="snote">{attempt.error}</span>}</td>
                        </tr>
                      );
                    })}
                    {!attempts.length && <tr><td colSpan={5} className="empty">No messages submitted yet.</td></tr>}
                  </tbody>
                </table>
              ) : (
                <table className="grid p">
                  <thead><tr>
                    <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all on this page" checked={pageIds.length > 0 && pageIds.every((id) => selected.has(id))} onChange={(e) => togglePage(e.target.checked)} /></th>
                    <th style={{ width: "22%" }}>Customer / invoice</th><th className="r" style={{ width: 130 }}>Outstanding</th><th style={{ width: "16%" }}>Stage</th>
                    <th style={{ width: "17%" }}>Next reminder</th><th style={{ width: "16%" }}>Status</th><th style={{ width: 200 }} />
                  </tr></thead>
                  <tbody>
                    {pagePipes.map((row) => (
                      <tr key={row.id}>
                        <td><input type="checkbox" aria-label={`Select ${row.invoice}`} checked={selected.has(row.id)} onChange={(e) => toggle(row.id, e.target.checked)} /></td>
                        <td><button className="lnk" style={{ textDecoration: "none", textAlign: "left" }} onClick={() => setDetailId(row.id)}><span className="cname">{row.customer}</span></button><span className="csub">{row.invoice}</span></td>
                        <td className="r num">{money(row.outstanding)}</td>
                        <td>{row.stages[row.stage_index]?.name ?? "—"}<span className="csub">{row.stage_sent} of {row.stages[row.stage_index]?.limit ?? 1} sent</span></td>
                        <td>{row.next_due_at ? fmtDateTime(row.next_due_at) : <span className="muted">None</span>}</td>
                        <td>
                          <span className={`pill ${row.status === "settled" ? "pill-green" : row.status === "review" || row.status === "uncertain" ? "pill-amber" : "pill-stone"}`}>{STATUS_LABEL[row.status]}</span>
                          {row.note && <span className="snote">{row.note}</span>}
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", position: "relative" }}>
                            {(row.status === "active" || row.status === "review") && (
                              <button className="btn" disabled={!!busy || !isDue(row)} title={isDue(row) ? "" : "This reminder is not due yet."} onClick={() => void openReview([row.id])}>Review &amp; send</button>
                            )}
                            <button className="icon-btn" aria-label="More actions" onClick={() => setMenuId(menuId === row.id ? "" : row.id)}>⋯</button>
                            {menuId === row.id && (
                              <div style={{ position: "absolute", right: 0, top: 34, width: 190, background: "#fff", border: "1px solid #ded8d0", borderRadius: 8, boxShadow: "0 12px 28px rgba(0,0,0,.14)", padding: 6, zIndex: 20 }}>
                                {[
                                  { label: "View details", run: () => { setMenuId(""); setDetailId(row.id); }, show: true },
                                  { label: "Check outstanding in Tally", run: () => void rowAction(row, "check"), show: LIVE.includes(row.status) },
                                  { label: "Pause reminders", run: () => void rowAction(row, "pause"), show: row.status === "active" || row.status === "review" },
                                  { label: "Resume reminders", run: () => void rowAction(row, "resume"), show: row.status === "paused" },
                                  { label: "Stop reminders", run: () => void rowAction(row, "stop"), show: LIVE.includes(row.status) },
                                ].filter((item) => item.show).map((item) => (
                                  <button key={item.label} className="btn" style={{ width: "100%", justifyContent: "flex-start", border: 0, background: "none", fontSize: 12 }} onClick={item.run}>{item.label}</button>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!pagePipes.length && <tr><td colSpan={7} className="empty">{tab === "due" ? "No reminders are due right now." : "No reminders started yet. Pick invoices under Unpaid invoices."}</td></tr>}
                  </tbody>
                </table>
              )}
            </div>
            <div className="pager">
              <span>Showing {total ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(total, safePage * pageSize)} of {total}</span>
              <div className="pr">
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>Rows
                  <select aria-label="Rows per page" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                    {[25, 50, 100].map((n) => <option key={n}>{n}</option>)}
                  </select>
                </label>
                <span style={{ minWidth: 72, textAlign: "center" }}>Page {safePage} of {pageCount}</span>
                <button className="pb" aria-label="Previous page" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹</button>
                <button className="pb" aria-label="Next page" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>›</button>
              </div>
            </div>
          </>
        )}
      </div>

      {review && focusRow && (
        <>
          <div className="scrim" onClick={() => !sending && setReview(null)} />
          <aside className="panel" role="dialog" aria-label="Review and send">
            <div className="panel-h">
              <div><h2>Review &amp; send</h2><p>{review.ids.length} reminder{review.ids.length === 1 ? "" : "s"} ready to send · checked in Tally just now</p></div>
              <button className="icon-btn" aria-label="Close" disabled={sending} onClick={() => setReview(null)}>×</button>
            </div>
            <div className="panel-b">
              {review.ids.length > 1 && (
                <div style={{ border: "1px solid #e0d9d0", borderRadius: 10, marginBottom: 14, overflow: "hidden" }}>
                  {review.ids.map((id) => {
                    const row = rows.find((p) => p.id === id);
                    if (!row) return null;
                    return (
                      <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid #eee8e0", fontSize: 12, background: id === review.focus ? "#f1f7f2" : "#fff" }}>
                        <input type="checkbox" checked={!review.off.has(id)} onChange={(e) => setReview((current) => {
                          if (!current) return current;
                          const off = new Set(current.off);
                          if (e.target.checked) off.delete(id); else off.add(id);
                          return { ...current, off };
                        })} />
                        <button style={{ all: "unset", cursor: "pointer", flex: 1, minWidth: 0 }} onClick={() => setReview({ ...review, focus: id })}>
                          <b style={{ display: "block" }}>{row.customer}</b><span className="muted">{row.invoice} · {money(row.outstanding)}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <p style={{ fontSize: 12, color: "#756b60", margin: "0 0 12px" }}>To {maskPhone(focusRow.recipient)}. This is exactly what the customer will receive.</p>
              <WhatsappBubble name={focusRow.customer} phone={focusRow.recipient} text={messageText(messageFor(focusRow.stages[focusRow.stage_index]?.template), focusRow, focusRow.company_name) || "No message template is configured."} />
            </div>
            <div className="panel-f">
              <button className="btn" disabled={sending} onClick={() => setReview(null)}>Cancel</button>
              <button className="btn primary" disabled={sending || review.ids.every((id) => review.off.has(id))} onClick={() => void sendReviewed()}>
                {sending ? <><span className="spin" />Sending…</> : `Send ${review.ids.filter((id) => !review.off.has(id)).length} WhatsApp message${review.ids.filter((id) => !review.off.has(id)).length === 1 ? "" : "s"}`}
              </button>
            </div>
          </aside>
        </>
      )}

      {detail && (
        <>
          <div className="scrim" onClick={() => setDetailId("")} />
          <aside className="panel" role="dialog" aria-label="Invoice reminders">
            <div className="panel-h">
              <div><h2>{detail.invoice}</h2><p>{detail.customer}</p></div>
              <button className="icon-btn" aria-label="Close" onClick={() => setDetailId("")}>×</button>
            </div>
            <div className="panel-b">
              <dl className="facts">
                <div><dt>Status</dt><dd>{STATUS_LABEL[detail.status]}</dd></div>
                <div><dt>Outstanding</dt><dd>{money(detail.outstanding)}</dd></div>
                <div><dt>Invoice date</dt><dd>{fmtDate(detail.invoice_date)}</dd></div>
                <div><dt>WhatsApp</dt><dd>{maskPhone(detail.recipient)}</dd></div>
                <div><dt>Stage</dt><dd>{detail.stages[detail.stage_index]?.name ?? "—"} · {detail.stage_sent} of {detail.stages[detail.stage_index]?.limit ?? 1} sent</dd></div>
                <div><dt>Next reminder</dt><dd>{detail.next_due_at ? fmtDateTime(detail.next_due_at) : "None"}</dd></div>
                <div><dt>Last checked in Tally</dt><dd>{fmtDateTime(detail.verified_at)}</dd></div>
                <div><dt>Plan</dt><dd>{detail.plan_name}</dd></div>
              </dl>
              {detail.note && <div className="alert">{detail.note}</div>}
              <h3 style={{ fontSize: 12, margin: "20px 0 12px" }}>What happened</h3>
              <ul className="tl">
                {attempts.filter((a) => a.pipeline_id === detail.id).map((attempt) => (
                  <li key={attempt.id} className={attempt.status === "rejected" ? "t-warn" : "t-sent"}>
                    <span className="d" /><div><b>Reminder {ATTEMPT_LABEL[attempt.status].label.toLowerCase()}</b><time>{fmtDateTime(attempt.created_at)} · {money(attempt.outstanding)}</time></div>
                  </li>
                ))}
                <li><span className="d" /><div><b>Reminder journey created</b></div></li>
              </ul>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
