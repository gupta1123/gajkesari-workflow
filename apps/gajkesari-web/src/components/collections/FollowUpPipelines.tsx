"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { loadLiveCashDiscountDashboard, type ScanInfo } from "@/lib/cash-discount-live-dashboard";
import { resolveTallyConnectionId } from "@/lib/resolve-tally-connection";
import {
  createPipelines, listPipelines, runPipelineAction,
  type FollowupAttempt, type FollowupPipeline, type PipelineAction, type ReminderMessage, type ReminderStage,
} from "@/lib/followups-client";
import { InvoicePanel, type PanelDate, type PanelTone } from "./InvoicePanel";
import { readCompaniesCache, writeCompaniesCache } from "@/lib/company-cache";
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
  dueDate?: string | null;
  amountReceived?: number | null;
  lastReceiptDate?: string | null;
  receipts?: Array<{ date: string | null; amount: number; voucherNumber: string | null; voucherType: string | null }>;
  partyEmail?: string | null;
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

function billStatus(row: DueInvoice): { label: string; tone: PanelTone } {
  const part = (row.amountReceived ?? 0) > 0.005;
  if (kindOf(row) === "unclear") return { label: part ? "Part paid, terms unclear" : "Terms unclear", tone: "warn" };
  const days = row.ageDays ?? 0;
  const base = part ? "Part paid" : "Unpaid";
  if (days > 0) return { label: `${base}, overdue ${days} days`, tone: days > 30 ? "bad" : "warn" };
  return { label: `${base}, due today`, tone: "quiet" };
}

// Dates in the order they happened, each saying what it means for collection.
function billDates(row: DueInvoice): PanelDate[] {
  const days = row.ageDays ?? 0;
  const list: PanelDate[] = [{ label: "Invoice date", date: row.linkedInvoiceDate }];
  if (row.lastReceiptDate) list.push({ label: "Last payment", date: row.lastReceiptDate, tone: "ok" });
  list.push({
    label: "Payment due",
    date: row.dueDate,
    note: kindOf(row) === "unclear" ? "Due date could not be worked out" : days > 0 ? `${days} day${days === 1 ? "" : "s"} overdue` : "Due today",
    tone: kindOf(row) === "unclear" ? "warn" : days > 30 ? "bad" : days > 0 ? "warn" : "quiet",
  });
  return list.filter((d) => d.date || d.label === "Payment due").sort((x, y) => String(x.date ?? "9999").localeCompare(String(y.date ?? "9999")));
}

function ageCell(row: DueInvoice) {
  if (kindOf(row) === "unclear") return <span className="muted">Terms unclear</span>;
  const days = row.ageDays ?? 0;
  if (days > 0) return <span className={days > 30 ? "age-bad" : "age-warn"}>{row.ageLabel || `Overdue ${days} days`}</span>;
  return <span>{row.ageLabel || "Due today"}</span>;
}

type ListedInvoice = { invoice: string; invoice_date: string | null; outstanding: number };

// Same one-line list the server sends: oldest five, then "and N more".
function invoiceListLine(invoices: ListedInvoice[]) {
  const sorted = [...invoices].sort((a, b) => String(a.invoice_date ?? "9999").localeCompare(String(b.invoice_date ?? "9999")));
  const parts = sorted.slice(0, 5).map((item) => {
    const date = item.invoice_date ? new Date(`${item.invoice_date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "";
    return `${item.invoice} ₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(item.outstanding)}${date ? ` (${date})` : ""}`;
  });
  const rest = sorted.length - parts.length;
  return `${parts.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}`;
}

const SUMMARY_KEY = "payment_reminder_summary";
// Two or more invoices go out as the summary message; one uses the stage's own message.
const templateKeyFor = (row: { invoices?: ListedInvoice[] | null }, stageTemplate: string | undefined) =>
  row.invoices && row.invoices.length > 1 ? SUMMARY_KEY : stageTemplate;

function messageText(template: string | undefined, row: { customer: string; invoice: string; invoice_date: string | null; outstanding: number | null; invoices?: ListedInvoice[] | null }, company: string) {
  const values: Record<string, string> = {
    customer: row.customer, company, invoice: row.invoice, invoice_date: fmtDate(row.invoice_date),
    outstanding: new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(row.outstanding ?? 0),
    invoice_count: String(row.invoices?.length ?? 1),
    invoice_list: row.invoices?.length ? invoiceListLine(row.invoices) : row.invoice,
  };
  return (template ?? "").replace(/\{\{(customer|company|invoice|invoice_date|outstanding|invoice_count|invoice_list)\}\}/g, (_, key: string) => values[key]);
}

type CustomerGroup = { name: string; phone: string; invoices: DueInvoice[]; total: number; maxAge: number; oldest: string };

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
  const [enrolling, setEnrolling] = useState<{ ids: string[]; once: boolean; customers?: boolean } | null>(null);
  const [view, setView] = useState<"invoice" | "customer">("customer");
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [billId, setBillId] = useState("");
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [template, setTemplate] = useState("");
  const [savedPlans, setSavedPlans] = useState<Array<{ id: string; name: string; stages: ReminderStage[] }>>([]);
  const [planId, setPlanId] = useState("");
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
    // Start from the last known company so the scan can begin straight away,
    // then confirm the list. Reminders and plans load alongside, not after.
    const cached = readCompaniesCache<Company>();
    if (cached) { setCompanies(cached.companies); setCompanyId(cached.selectedCompanyId); }
    const plansLoaded = apiFetch("/api/settings/payment-reminders", { cache: "no-store" })
      .then(async (response) => { if (response.ok) setSavedPlans((await response.json()).plans ?? []); })
      .catch(() => undefined);
    const remindersLoaded = refresh().catch((error) => {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not load reminders." });
    });
    (async () => {
      try {
        // A remembered connector skips the lookup; if it no longer answers, look it up again.
        const fetchCompanies = async (id: string) => {
          const reply = await apiFetch(`/api/tally/companies?connectionId=${encodeURIComponent(id)}`, { cache: "no-store" });
          return { response: reply, payload: await reply.json() };
        };
        const remembered = cached?.companies[0]?.connectionId;
        let { response, payload } = remembered ? await fetchCompanies(remembered) : await fetchCompanies(await resolveTallyConnectionId());
        if (remembered && (!response.ok || !(payload.companies ?? []).length)) ({ response, payload } = await fetchCompanies(await resolveTallyConnectionId()));
        if (response.ok) {
          const list: Company[] = payload.companies ?? [];
          const chosen: string = payload.selectedCompanyId || list[0]?.id || "";
          setCompanies(list);
          setCompanyId((current) => (current && list.some((c) => c.id === current) ? current : chosen));
          writeCompaniesCache(list, chosen);
        }
      } catch (error) {
        setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not load companies." });
      }
      await Promise.all([plansLoaded, remindersLoaded]);
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
    (row: DueInvoice) => rows.find((p) => p.customer === row.partyLedgerName && isOpen(p) && (
      p.kind === "customer" ? p.invoices?.some((i) => i.invoice === row.linkedInvoiceNumber) : p.invoice === row.linkedInvoiceNumber
    )),
    [rows]
  );
  const customerPipeline = useCallback(
    (name: string) => rows.find((p) => p.kind === "customer" && p.customer === name && isOpen(p)),
    [rows]
  );

  const visibleDues = useMemo(() => {
    const filtered = due.filter((row) => kind === "all" || kindOf(row) === kind);
    const sorted = [...filtered];
    if (sort === "priority") sorted.sort((a, b) => Math.floor((b.ageDays ?? -1) / 30) - Math.floor((a.ageDays ?? -1) / 30) || b.outstandingAmount - a.outstandingAmount);
    else if (sort === "most_overdue") sorted.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
    else if (sort === "highest") sorted.sort((a, b) => b.outstandingAmount - a.outstandingAmount);
    else if (sort === "oldest") sorted.sort((a, b) => String(a.linkedInvoiceDate ?? "9999").localeCompare(String(b.linkedInvoiceDate ?? "9999")));
    else sorted.sort((a, b) => a.partyLedgerName.localeCompare(b.partyLedgerName));
    return sorted;
  }, [due, kind, sort]);

  // Invoices with unclear payment terms stay out of customer messages; they need a person's eye first.
  const groups = useMemo(() => {
    const byName = new Map<string, CustomerGroup>();
    for (const row of visibleDues) {
      if (!row.linkedInvoiceNumber || kindOf(row) === "unclear") continue;
      const group = byName.get(row.partyLedgerName) ?? { name: row.partyLedgerName, phone: "", invoices: [], total: 0, maxAge: -1, oldest: "9999" };
      group.invoices.push(row);
      group.total += row.outstandingAmount;
      group.maxAge = Math.max(group.maxAge, row.ageDays ?? -1);
      group.oldest = [group.oldest, row.linkedInvoiceDate ?? "9999"].sort()[0];
      group.phone ||= tenDigits(row.partyPhone);
      byName.set(row.partyLedgerName, group);
    }
    const list = [...byName.values()];
    if (sort === "highest") list.sort((a, b) => b.total - a.total);
    else if (sort === "oldest") list.sort((a, b) => a.oldest.localeCompare(b.oldest));
    else if (sort === "customer") list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => Math.floor(b.maxAge / 30) - Math.floor(a.maxAge / 30) || b.total - a.total);
    return list;
  }, [visibleDues, sort]);
  const byCustomer = tab === "dues" && view === "customer";

  const dueReminders = useMemo(() => rows.filter(isDue), [rows]);
  const tabRows: Array<DueInvoice | FollowupPipeline | CustomerGroup> =
    tab === "dues" ? (byCustomer ? groups : visibleDues) : tab === "due" ? dueReminders : tab === "pipelines" ? rows : [];
  const total = tab === "history" ? attempts.length : tabRows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const slice = <T,>(list: T[]) => list.slice((safePage - 1) * pageSize, safePage * pageSize);
  const pageDues = tab === "dues" && !byCustomer ? slice(visibleDues) : [];
  const pageGroups = byCustomer ? slice(groups) : [];
  const pagePipes = tab === "due" ? slice(dueReminders) : tab === "pipelines" ? slice(rows) : [];
  const pageIds = byCustomer
    ? pageGroups.map((group) => `c:${group.name}`)
    : tab === "dues" ? pageDues.filter((row) => row.linkedInvoiceNumber).map((row) => row.id) : pagePipes.map((row) => row.id);

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

  // One message per customer: ids are customer names, phones are keyed by name.
  const openEnrollCustomers = (names: string[], once: boolean) => {
    const chosen = groups.filter((group) => names.includes(group.name) && !customerPipeline(group.name));
    if (!chosen.length) return say("warn", "Those customers already have a reminder running.");
    setPhones(Object.fromEntries(chosen.map((group) => [group.name, group.phone])));
    setTemplate((current) => current || messages[0]?.key || "");
    setEnrolling({ ids: chosen.map((group) => group.name), once, customers: true });
    setEnrollError("");
  };

  const chosenPlan = savedPlans.find((plan) => plan.id === planId);

  const submitEnroll = async () => {
    if (!company || !enrolling) return;
    const chosen = enrolling.customers
      ? groups.filter((group) => enrolling.ids.includes(group.name)).flatMap((group) => group.invoices.map((row) => ({ ...row, partyPhone: phones[group.name] ?? "" })))
      : due.filter((row) => enrolling.ids.includes(row.id));
    if (!template) return setEnrollError("No WhatsApp reminder message is configured yet. Ask your administrator to register an approved template.");
    const phoneOf = (row: DueInvoice) => (enrolling.customers ? phones[row.partyLedgerName] : phones[row.id]) ?? "";
    const missing = [...new Set(chosen.filter((row) => !/^[6-9]\d{9}$/.test(phoneOf(row))).map((row) => row.partyLedgerName))];
    if (missing.length) return setEnrollError(`Enter a valid 10-digit mobile number for ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}.`);
    setEnrollBusy(true);
    setEnrollError("");
    try {
      const result = await createPipelines({
        connectionId: company.connectionId,
        companyName: company.companyName,
        financialYear: company.financialYear,
        mode: enrolling.customers ? "customer" : "invoice",
        plan: {
          name: enrolling.once ? "Send once" : chosenPlan?.name ?? "Standard",
          stages: enrolling.once
            ? [{ name: "One-time message", template, delay: 0, every: 1, unit: "days", limit: 1 }]
            : chosenPlan
              ? chosenPlan.stages
              : STANDARD_STAGES.map((stage) => ({ ...stage, template })),
        },
        invoices: chosen.map((row) => ({
          customer: row.partyLedgerName,
          invoice: row.linkedInvoiceNumber ?? "",
          invoiceDate: row.linkedInvoiceDate ?? "",
          recipient: phoneOf(row),
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
  const messageFor = (key: string | undefined) => messages.find((m) => m.key === key)?.text;
  const detail = rows.find((row) => row.id === detailId);
  const focusRow = review ? rows.find((row) => row.id === review.focus) : undefined;
  const billRow = due.find((row) => row.id === billId);
  const enrollRows = enrolling && !enrolling.customers ? due.filter((row) => enrolling.ids.includes(row.id)) : [];
  const enrollGroups = enrolling?.customers ? groups.filter((group) => enrolling.ids.includes(group.name)) : [];
  const selGroups = groups.filter((group) => selected.has(`c:${group.name}`));
  const startableGroups = selGroups.filter((group) => !customerPipeline(group.name));

  const bulkBar = selectedCount > 0 && !enrolling && (
    <div className="bulkbar">
      <span className="bb-count">{selectedCount} selected</span><span className="bb-sep" />
      {byCustomer ? (
        <>
          <button className="bb pri" disabled={!startableGroups.length} onClick={() => openEnrollCustomers(startableGroups.map((group) => group.name), false)}>Start reminders<small>{startableGroups.length}</small></button>
          <button className="bb" disabled={!startableGroups.length} onClick={() => openEnrollCustomers(startableGroups.map((group) => group.name), true)}>Send once<small>{startableGroups.length}</small></button>
          {startableGroups.some((group) => !group.phone) && <button className="bb warn" onClick={() => openEnrollCustomers(startableGroups.map((group) => group.name), false)}>⚠ {startableGroups.filter((group) => !group.phone).length} no contact</button>}
        </>
      ) : tab === "dues" ? (
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
                <select aria-label="Group invoices" value={view} onChange={(e) => { setView(e.target.value as "invoice" | "customer"); setSelected(new Set()); setPage(1); }}>
                  <option value="customer">By customer</option>
                  <option value="invoice">By invoice</option>
                </select>
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
              <small>{enrolling.once ? "Send once" : enrolling.customers ? "Customer reminders" : "Invoice reminders"}</small>
              {enrolling.customers ? (
                <>
                  <h3>{enrollGroups.length === 1 ? enrollGroups[0].name : `${enrollGroups.length} customers`}</h3>
                  <p>{enrollGroups.reduce((sum, group) => sum + group.invoices.length, 0)} invoices · Outstanding {money(enrollGroups.reduce((sum, group) => sum + group.total, 0))}</p>
                </>
              ) : (
                <>
              <h3>{enrollRows.length === 1 ? enrollRows[0].partyLedgerName : `${enrollRows.length} invoices`}</h3>
              <p>{enrollRows.length === 1 ? `${enrollRows[0].linkedInvoiceNumber} · ${fmtDate(enrollRows[0].linkedInvoiceDate)} · Outstanding ${money(enrollRows[0].outstandingAmount)}` : `Outstanding ${money(enrollRows.reduce((sum, row) => sum + row.outstandingAmount, 0))}`}</p>
                </>
              )}
            </div>
            <div className="eb">
              {enrollGroups.map((group) => (
                <label className="f" key={group.name}>
                  <span>{enrollGroups.length > 1 ? `${group.name} · ${group.invoices.length} invoice${group.invoices.length === 1 ? "" : "s"}` : "Customer’s WhatsApp number"}{group.phone ? " (on file)" : ""}</span>
                  <input type="tel" inputMode="numeric" maxLength={10} placeholder="10-digit mobile number" value={phones[group.name] ?? ""}
                    onChange={(e) => setPhones((current) => ({ ...current, [group.name]: e.target.value.replace(/D/g, "").slice(-10) }))} />
                </label>
              ))}
              {enrollGroups[0] && (() => {
                const first = enrollGroups[0];
                const listed = first.invoices.map((row) => ({ invoice: row.linkedInvoiceNumber ?? "", invoice_date: row.linkedInvoiceDate, outstanding: row.outstandingAmount }));
                const text = messageText(listed.length > 1 ? messageFor(SUMMARY_KEY) : messageFor(template), { customer: first.name, invoice: listed[0]?.invoice ?? "", invoice_date: listed[0]?.invoice_date ?? null, outstanding: first.total, invoices: listed }, company?.companyName ?? "");
                return text ? <WhatsappBubble name={first.name} phone={phones[first.name] ?? ""} text={text} /> : null;
              })()}
              {enrollRows.map((row) => (
                <label className="f" key={row.id}>
                  <span>{enrollRows.length > 1 ? `${row.partyLedgerName} · ${row.linkedInvoiceNumber}` : "Customer’s WhatsApp number"}{tenDigits(row.partyPhone) ? " (on file)" : ""}</span>
                  <input type="tel" inputMode="numeric" maxLength={10} placeholder="10-digit mobile number" value={phones[row.id] ?? ""}
                    onChange={(e) => setPhones((current) => ({ ...current, [row.id]: e.target.value.replace(/\D/g, "").slice(-10) }))} />
                </label>
              ))}
              {!enrolling.customers && <label className="f">
                <span>WhatsApp message</span>
                <select value={template} onChange={(e) => setTemplate(e.target.value)}>
                  {messages.length === 0 && <option value="">No WhatsApp reminder message is configured yet</option>}
                  {messages.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                </select>
              </label>}
              {!enrolling.once && savedPlans.length > 0 && (
                <label className="f">
                  <span>Reminder plan</span>
                  <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
                    <option value="">Standard schedule</option>
                    {savedPlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
                  </select>
                </label>
              )}
              {!enrolling.once && (
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7, color: "#51483f" }}>
                  {(chosenPlan?.stages ?? STANDARD_STAGES).map((stage) => (
                    <li key={stage.name}>
                      <b>{stage.name}</b>{" "}
                      {stage.delay === 0 ? "starts right away" : `starts ${stage.delay} ${stage.unit} later`}
                      {stage.limit === 1 ? ", one message" : `, every ${stage.every} ${stage.unit}, up to ${stage.limit} messages`}
                    </li>
                  ))}
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
              {tab === "dues" && (byCustomer ? "One message per customer lists all their unpaid invoices. Invoices with unclear payment terms are left out." : "Open invoices read from Tally. Select invoices to start reminders in bulk.")}
              {tab === "due" && "Reminders that are due now. Tally is checked before each one is sent."}
              {tab === "pipelines" && "Every reminder journey, running or finished."}
              {tab === "history" && "Every WhatsApp reminder, newest first."}
            </p>
            <div className="flat">
              {scanning && tab === "dues" && !due.length ? <div className="skel" /> : byCustomer ? (
                <div className="cg" role="table" aria-label="Customers with unpaid invoices">
                  <div className="cg-row cg-head" role="row">
                    <input type="checkbox" aria-label="Select all on this page" checked={pageIds.length > 0 && pageIds.every((id) => selected.has(id))} onChange={(e) => togglePage(e.target.checked)} />
                    <span>Customer</span><span className="r">Invoices</span><span className="r">Outstanding</span><span>Oldest overdue</span><span>Reminders</span>
                  </div>
                  {pageGroups.map((group) => {
                    const pipe = customerPipeline(group.name);
                    const open = opened.has(group.name);
                    return (
                      <div key={group.name} className={`cg-group${open ? " open" : ""}`}>
                        <div className="cg-row" role="row">
                          <input type="checkbox" aria-label={`Select ${group.name}`} checked={selected.has(`c:${group.name}`)} onChange={(e) => toggle(`c:${group.name}`, e.target.checked)} />
                          <button className="cg-name" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} invoices of ${group.name}`}
                            onClick={() => setOpened((current) => { const next = new Set(current); if (open) next.delete(group.name); else next.add(group.name); return next; })}>
                            <svg className="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            <span><b title={group.name}>{group.name}</b>{!group.phone && <small>No contact on file</small>}</span>
                          </button>
                          <span className="r num">{group.invoices.length}</span>
                          <span className="r num">{money(group.total)}</span>
                          <span>{group.maxAge > 0 ? <span className={group.maxAge > 30 ? "age-bad" : "age-warn"}>{group.maxAge} days</span> : "Due today"}</span>
                          <span>{pipe
                            ? <span className="pill pill-stone">{STATUS_LABEL[pipe.status]}</span>
                            : <button className="btn" onClick={() => openEnrollCustomers([group.name], false)}>Remind customer</button>}</span>
                        </div>
                        {open && (
                          <div className="cg-sub">
                            {group.invoices.map((row) => (
                              <button key={row.id} className="cg-inv" onClick={() => setBillId(row.id)}>
                                <span className="cg-invno">{row.linkedInvoiceNumber}<small>{fmtDate(row.linkedInvoiceDate)}</small></span>
                                <span className="r num">{money(row.outstandingAmount)}</span>
                                <span>{ageCell(row)}</span>
                                {(row.amountReceived ?? 0) > 0.005 && <span className="pill pill-amber">Part paid</span>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!pageGroups.length && <div className="empty cg-empty">{scanError ? "Tally could not be read." : "No customers have unpaid invoices that need a follow-up."}</div>}
                </div>
              ) : tab === "dues" ? (
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
                          <td>{row.linkedInvoiceNumber ? <button className="lnk" style={{ textDecoration: "none" }} onClick={() => setBillId(row.id)}>{row.linkedInvoiceNumber}</button> : "—"}<span className="csub">{fmtDate(row.linkedInvoiceDate)}</span></td>
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

      {billRow && (
        <InvoicePanel
          invoice={billRow.linkedInvoiceNumber ?? "Invoice"}
          customer={billRow.partyLedgerName}
          status={billStatus(billRow)}
          invoiceAmount={billRow.originalInvoiceAmount}
          received={billRow.amountReceived ?? Math.max(billRow.originalInvoiceAmount - billRow.outstandingAmount, 0)}
          outstanding={billRow.outstandingAmount}
          dates={billDates(billRow)}
          receipts={(billRow.receipts ?? []).map((r) => ({ date: r.date, amount: r.amount, reference: [r.voucherType, r.voucherNumber].filter(Boolean).join(" ") || null }))}
          facts={[
            { label: "Payment terms", value: KIND_LABEL[kindOf(billRow)] },
            { label: "WhatsApp", value: tenDigits(billRow.partyPhone) ? maskPhone(`91${tenDigits(billRow.partyPhone)}`) : "No number on file" },
            ...(billRow.partyEmail ? [{ label: "Email", value: billRow.partyEmail }] : []),
            { label: "Reminders", value: pipelineFor(billRow) ? STATUS_LABEL[pipelineFor(billRow)!.status] : "Not started" },
          ]}
          narration={billRow.narration}
          onClose={() => setBillId("")}
        >
          {!pipelineFor(billRow) && billRow.linkedInvoiceNumber && (
            <button className="btn primary" onClick={() => { setBillId(""); openEnroll([billRow.id], false); }}>Start reminders</button>
          )}
        </InvoicePanel>
      )}

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
                          <b style={{ display: "block" }}>{row.customer}</b><span className="muted">{row.kind === "customer" ? row.invoice : row.invoice} · {money(row.outstanding)}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <p style={{ fontSize: 12, color: "#756b60", margin: "0 0 12px" }}>To {maskPhone(focusRow.recipient)}. This is exactly what the customer will receive.</p>
              <WhatsappBubble name={focusRow.customer} phone={focusRow.recipient} text={messageText(messageFor(templateKeyFor(focusRow, focusRow.stages[focusRow.stage_index]?.template)), focusRow, focusRow.company_name) || "No message template is configured."} />
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
                {detail.kind === "customer"
                  ? <div><dt>Invoices</dt><dd>{(detail.invoices ?? []).map((i) => `${i.invoice} ${money(i.outstanding)}`).join(", ")}</dd></div>
                  : <div><dt>Invoice date</dt><dd>{fmtDate(detail.invoice_date)}</dd></div>}
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
