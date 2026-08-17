"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";

type CompanyOption = {
  id: string;
  connectionId: string;
  companyName: string;
  financialYear: string;
  status: string;
  bridgeConnected: boolean;
  tallyReachable: boolean;
  companyLoaded: boolean;
  bankAccountCount: number | null;
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
};

function uniqueCompanyOptions(options: CompanyOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.companyName.trim().toLowerCase()}::${option.financialYear.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatCompanyOptionLabel(company: CompanyOption) {
  return [company.companyName, company.financialYear].filter(Boolean).join(" - ");
}

type CashDiscountRule = {
  id: string;
  ruleName: string;
  discountType: string;
  discountValue: number;
  eligibilityDays: number;
  graceDays: number;
  missedCdTreatment: string;
  label: string;
};

type DebitNoteProposal = {
  id: string;
  sourceKind?: "tally_open_bill" | "supabase_proposal" | null;
  issueType?: "discount_shortfall" | "invoice_unpaid" | "partial_unpaid" | null;
  canCreateDebitNote?: boolean | null;
  expectedDiscount?: number | null;
  pendingAmount?: number | null;
  connectionId?: string | null;
  companyName?: string | null;
  financialYear?: string | null;
  partyLedgerName: string;
  partyGstin: string | null;
  partyEmail: string | null;
  partyPhone: string | null;
  partyContactPerson: string | null;
  partyAddress: string | null;
  linkedInvoiceNumber: string | null;
  linkedInvoiceDate: string | null;
  originalInvoiceAmount: number | null;
  cashDiscountRuleId?: string | null;
  cashDiscountRuleName?: string | null;
  amountReceived: number | null;
  recoverableAmount: number;
  remainingRecoverableAmount: number | null;
  receiptDate: string | null;
  discountDeadline: string | null;
  debitNoteDate: string;
  status: string;
  tallyVoucherGuid: string | null;
  tallyVoucherId: string | null;
  tallyVoucherNumber: string | null;
  tallyVoucherDate: string | null;
  lastError: string | null;
  narration: string | null;
  tallyOpenReferenceName: string | null;
  createdInTallyAt: string | null;
  communicationStatus: string | null;
  communicationRecipient?: string | null;
  communicationSentAt?: string | null;
  reasonCode?: string | null;
  gstMode?: string | null;
};

type TallyMaster = {
  name: string;
  parent?: string | null;
  type?: string | null;
  billWiseEnabled?: boolean | null;
  phone?: string | null;
};

type WhatsappSendResult = {
  phoneSaveCommandId?: string | null;
  phoneSaveConnectionId?: string | null;
  phoneSaveQueueError?: string | null;
};

type TallyCommand = {
  id: string;
  connectionId?: string;
  status: "queued" | "claimed" | "succeeded" | "failed" | "canceled";
  error?: string | null;
};

type LiveTallyConnection = {
  id: string;
  status: string;
  lastCompanyName?: string | null;
  companyLoaded?: boolean;
  tallyReachable?: boolean;
};

type DashboardPayload = {
  setupRequired?: boolean;
  error?: string;
  company?: {
    companyName: string;
    status: string;
    tallyReachable: boolean;
    companyLoaded: boolean;
    lastHeartbeatAt: string | null;
  };
  kpis?: Record<string, number | null>;
  tabs?: {
    overduePayments?: unknown[];
    cashDiscountTracker?: DebitNoteProposal[];
    debitNoteQueue?: DebitNoteProposal[];
  };
  rules?: CashDiscountRule[];
  notes?: string[];
};

type ActiveView = "needsAction" | "done" | "rules";

function formatMoney(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("en-IN", {


    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function daysPast(value?: string | null) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.floor((today.getTime() - date.getTime()) / 86_400_000));
}

function sumRecoverable(values: DebitNoteProposal[]) {
  return values.reduce((total, item) => total + (Number(item.recoverableAmount) || 0), 0);
}

function statusClass(value?: string) {
  if (value === "created_in_tally") return "border-emerald-250 bg-emerald-50 text-emerald-800";
  if (value === "queued_in_tally" || value === "approved") return "border-amber-250 bg-amber-50 text-amber-800";
  if (value === "failed") return "border-red-250 bg-red-50 text-red-800";
  return "border-slate-200 bg-white text-slate-500";
}

function messageStatusClass(value?: string | null) {
  if (value === "sent") return "border-emerald-250 bg-emerald-50 text-emerald-800";
  if (value === "failed") return "border-red-255 bg-red-50 text-red-800";
  return "border-slate-200 bg-white text-slate-500";
}

function proposalStatusLabel(value: string) {
  return value.replace(/_/g, " ");
}

function actionStatusLabel(proposal: DebitNoteProposal) {
  if (proposal.lastError) return "Retry";
  if (proposal.status === "approved" || proposal.status === "queued_in_tally") return "Queued";
  if (proposal.sourceKind === "tally_open_bill") return "Ready";
  return proposalStatusLabel(proposal.status);
}

function isPendingDebitNote(proposal: DebitNoteProposal) {
  return ["draft", "pending_approval", "approved", "queued_in_tally", "failed"].includes(proposal.status);
}

function isCreatedDebitNote(proposal: DebitNoteProposal) {
  return proposal.status === "created_in_tally";
}

function shortText(value?: string | null, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeCompanyName(value?: string | null) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function calculateShortfall(proposal: DebitNoteProposal) {
  if (typeof proposal.originalInvoiceAmount !== "number" || typeof proposal.amountReceived !== "number") return null;
  return proposal.originalInvoiceAmount - proposal.amountReceived;
}

function issueLabel(proposal: DebitNoteProposal) {
  if (proposal.lastError) return "Tally action failed";
  if (proposal.status === "queued_in_tally" || proposal.status === "approved") return "Creating debit note";
  if (proposal.issueType === "invoice_unpaid") return "Invoice still unpaid";
  if (proposal.issueType === "partial_unpaid") return "Payment partially pending";
  return "Late short payment";
}

function createButtonLabel(proposal: DebitNoteProposal) {
  const status = proposal.status;
  if (status === "failed") return "Retry";
  if (status === "approved" || status === "queued_in_tally") return "Queued";
  return "Create debit note";
}

function canCreateInTally(proposal: DebitNoteProposal) {
  if (proposal.canCreateDebitNote === false) return false;
  return ["draft", "pending_approval", "failed"].includes(proposal.status);
}

function messageLabel(proposal: DebitNoteProposal) {
  if (proposal.communicationStatus === "sent") return "Sent";
  if (proposal.communicationStatus === "failed") return "Retry";
  if (!proposal.partyPhone) return "No phone";
  return "Send";
}

function contactStatus(proposal: DebitNoteProposal) {
  if (proposal.partyPhone) return "WhatsApp ready";
  if (proposal.partyEmail) return "Email only";
  return "No contact";
}

function getTenDigitPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}

function ContactMeta({ proposal }: { proposal: DebitNoteProposal }) {
  const items = [proposal.partyEmail, proposal.partyPhone, proposal.partyGstin].filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="mt-1 max-w-[280px] truncate text-xs text-[#8a7f72]">
      {items.join(" / ")}
    </div>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#e5ddd0] bg-white shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
      <div className="flex flex-col gap-3 border-b border-[#e5ddd0] px-5 py-4.5 sm:flex-row sm:items-center sm:justify-between bg-[#fcfbfa]/80 rounded-t-2xl">
        <div>
          <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#1a1a1a]">{title}</h3>
          {description ? <p className="mt-0.5 text-[11px] font-semibold text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function WorkflowButton({
  active,
  count,
  detail,
  label,
  onClick,
}: {
  active: boolean;
  count: number | string;
  detail: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`min-h-28 rounded-2xl border p-5 text-left transition-all duration-300 ${
        active
          ? "border-[#2d2d2d] bg-[#2d2d2d] text-[#f7f7f5] shadow-lg shadow-black/10"
          : "border-[#e5ddd0] bg-white text-[#1a1a1a] hover:border-[#cbd5e1] hover:bg-[#faf8f4] shadow-[0_2px_8px_rgba(0,0,0,0.02)]"
      }`}
      onClick={onClick}
      type="button"
    >
      <span className={`text-[10px] font-bold uppercase tracking-wider ${active ? "text-amber-300" : "text-slate-400"}`}>
        {label}
      </span>
      <span className="mt-3 block text-3xl font-black tracking-tight leading-none">{count}</span>
      <span className={`mt-2.5 block text-xs font-semibold leading-relaxed ${active ? "text-slate-300" : "text-slate-500"}`}>{detail}</span>
    </button>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-[#e5ddd0] bg-white px-4 py-12 text-center text-xs font-semibold text-slate-400">
      {children}
    </div>
  );
}

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || `Request failed with status ${response.status}`;
}

function wait(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isDebtorLedger(master: TallyMaster) {
  return String(master.parent ?? "").trim().toLowerCase() === "sundry debtors";
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function CollectionsDashboardPage() {
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [liveTallyConnection, setLiveTallyConnection] = useState<LiveTallyConnection | null>(null);
  const [checkingLiveTallyCompany, setCheckingLiveTallyCompany] = useState(true);
  const [activeView, setActiveView] = useState<ActiveView>("needsAction");
  const [loading, setLoading] = useState(true);
  const [savingRule, setSavingRule] = useState(false);
  const [approvingId, setApprovingId] = useState("");
  const [bulkCreating, setBulkCreating] = useState(false);
  const [sendingWhatsappId, setSendingWhatsappId] = useState("");
  const [bulkSendingWhatsapp, setBulkSendingWhatsapp] = useState(false);
  const [selectedPendingIds, setSelectedPendingIds] = useState<Set<string>>(() => new Set());
  const [selectedCreatedIds, setSelectedCreatedIds] = useState<Set<string>>(() => new Set());
  const [whatsappDialogProposals, setWhatsappDialogProposals] = useState<DebitNoteProposal[]>([]);
  const [whatsappPhoneInputs, setWhatsappPhoneInputs] = useState<Record<string, string>>({});
  const [whatsappSaveToTally, setWhatsappSaveToTally] = useState(true);
  const [whatsappDialogSending, setWhatsappDialogSending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const initialLoadStartedRef = useRef(false);
  const lastLoadedConnectionRef = useRef("");

  const selectedCompany = useMemo(
    () =>
      companies.find((company) => company.id === selectedCompanyId) ??
      companies.find((company) => company.connectionId === selectedConnectionId) ??
      companies[0] ??
      null,
    [companies, selectedCompanyId, selectedConnectionId]
  );

  const loadCompanies = useCallback(async () => {
    const response = await apiFetch("/api/tally/companies", { cache: "no-store" });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { companies?: CompanyOption[]; selectedCompanyId?: string | null };
    const nextCompanies = uniqueCompanyOptions(payload.companies ?? []);
    setCompanies(nextCompanies);
    setSelectedCompanyId((current) =>
      current && nextCompanies.some((company) => company.id === current)
        ? current
        : payload.selectedCompanyId || nextCompanies[0]?.id || ""
    );
    setSelectedConnectionId((current) => {
      const selectedOption =
        nextCompanies.find((company) => company.id === selectedCompanyId) ??
        nextCompanies.find((company) => company.id === payload.selectedCompanyId) ??
        nextCompanies[0];
      if (selectedOption) return selectedOption.connectionId;
      return nextCompanies.some((company) => company.connectionId === current) ? current : "";
    });
    return nextCompanies;
  }, [selectedCompanyId]);

  const loadDashboard = useCallback(
    async (connectionId = selectedConnectionId, companyName = selectedCompany?.companyName ?? "") => {
      if (!connectionId) {
        setDashboard(null);
        return;
      }
      const params = new URLSearchParams({ connectionId });
      if (companyName) params.set("companyName", companyName);
      const response = await apiFetch(`/api/collections/dashboard?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as DashboardPayload;
      if (!response.ok) throw new Error(payload.error || `Request failed with status ${response.status}`);
      setDashboard(payload);
    },
    [selectedCompany?.companyName, selectedConnectionId]
  );

  const loadDebtorLedgers = useCallback(async (connectionId: string) => {
    const response = await apiFetch(`/api/tally/connections/${connectionId}/masters?type=ledger&limit=5000`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { masters?: TallyMaster[] };
    return (payload.masters ?? []).filter(isDebtorLedger).map((master) => master.name).filter(Boolean);
  }, []);

  const pollCommand = useCallback(async (connectionId: string, commandId: string) => {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await wait(1000);
      const response = await apiFetch(
        `/api/tally/connections/${connectionId}/commands?${new URLSearchParams({
          ids: commandId,
          limit: "1",
        }).toString()}`,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as { commands?: TallyCommand[] };
      const command = payload.commands?.find((item) => item.id === commandId);
      if (command?.status === "succeeded") return;
      if (command?.status === "failed" || command?.status === "canceled") {
        throw new Error(command.error || "Tally open-bill scan failed.");
      }
    }
    throw new Error("Tally open-bill scan timed out. Keep the connector open and refresh again.");
  }, []);

  const refreshLiveTallyCompany = useCallback(async (connectionId: string) => {
    if (!connectionId) {
      setLiveTallyConnection(null);
      setCheckingLiveTallyCompany(false);
      return null;
    }
    setCheckingLiveTallyCompany(true);
    try {
      const response = await apiFetch(`/api/tally/connections/${connectionId}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as { connection?: LiveTallyConnection };
      const nextConnection = payload.connection ?? null;
      setLiveTallyConnection(nextConnection);
      return nextConnection;
    } finally {
      setCheckingLiveTallyCompany(false);
    }
  }, []);

  const syncCurrentCompanyLedgers = useCallback(
    async (connectionId: string, companyName?: string | null) => {
      const response = await apiFetch(`/api/tally/connections/${connectionId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandType: "sync_masters",
          payload: {
            companyName,
            requestedMasterTypes: ["ledger"],
          },
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as { command?: TallyCommand };
      if (!payload.command?.id) throw new Error("Tally ledger sync could not be started.");
      await pollCommand(connectionId, payload.command.id);
    },
    [pollCommand]
  );

  const refreshTallyOpenBills = useCallback(
    async (connectionId: string, companyName?: string | null) => {
      // Refresh the ledger list first. A connection may have previously synced a
      // different company, in which case using its old debtor list would omit
      // valid bills or query the wrong parties.
      await syncCurrentCompanyLedgers(connectionId, companyName);
      const ledgerNames = await loadDebtorLedgers(connectionId);
      if (ledgerNames.length === 0) return;

      // One page refresh can require several Tally commands when there are many
      // customer ledgers. Keep those commands together so the dashboard can use
      // this refresh as one consistent snapshot rather than mixing old chunks.
      const scanId = crypto.randomUUID();

      for (const chunk of chunkValues(ledgerNames, 80)) {
        const response = await apiFetch(`/api/tally/connections/${connectionId}/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandType: "fetch_customer_open_bills",
            payload: {
              ledgerName: chunk[0],
              ledgerNames: chunk,
              companyName,
              scanId,
            },
          }),
        });
        if (!response.ok) throw new Error(await readError(response));
        const payload = (await response.json()) as { command?: TallyCommand };
        if (payload.command?.id) {
          await pollCommand(connectionId, payload.command.id);
        }
      }
    },
    [loadDebtorLedgers, pollCommand, syncCurrentCompanyLedgers]
  );

  const refreshAll = useCallback(
    async (options?: { quiet?: boolean; refreshTally?: boolean }) => {
      try {
        if (!options?.quiet) setLoading(true);
        setMessage(null);
        setDashboard(null);
        const nextCompanies = await loadCompanies();
        const company =
          nextCompanies.find((item) => item.id === selectedCompanyId) ??
          nextCompanies.find((item) => item.connectionId === selectedConnectionId) ??
          nextCompanies[0] ??
          null;
        const connectionId = company?.connectionId || selectedConnectionId || "";
        if (company) setSelectedCompanyId(company.id);
        if (connectionId) setSelectedConnectionId(connectionId);
        if (connectionId) await refreshLiveTallyCompany(connectionId);
        // Set this before the asynchronous Tally scan so the selection effect
        // does not start a second, overlapping scan for the same company.
        lastLoadedConnectionRef.current = `${connectionId}::${company?.companyName ?? ""}`;
        if (connectionId && options?.refreshTally !== false) {
          await refreshTallyOpenBills(connectionId, company?.companyName);
        }
        await loadDashboard(connectionId, company?.companyName);
        lastLoadedConnectionRef.current = `${connectionId}::${company?.companyName ?? ""}`;
      } catch (error) {
        setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not load Cash Discounts data." });
      } finally {
        setLoading(false);
      }
    },
    [loadCompanies, loadDashboard, refreshLiveTallyCompany, refreshTallyOpenBills, selectedCompanyId, selectedConnectionId]
  );

  async function createDefaultRule() {
    if (!selectedConnectionId) return;
    try {
      setSavingRule(true);
      const response = await apiFetch("/api/collections/cash-discount-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: selectedConnectionId,
          ruleName: "2% CD within 15 days",
          discountType: "percentage",
          discountValue: 2,
          eligibilityDays: 15,
          graceDays: 0,
          paymentCondition: "full_payment",
          missedCdTreatment: "debit_note_proposal",
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage({ tone: "success", text: "Cash Discount rule added." });
      await loadDashboard();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not add rule." });
    } finally {
      setSavingRule(false);
    }
  }

  async function approveTallySuggestion(proposal: DebitNoteProposal) {
    const response = await apiFetch("/api/collections/tally-debit-notes/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId: selectedConnectionId,
        companyName: selectedCompany?.companyName ?? proposal.companyName,
        proposal: {
          ...proposal,
          financialYear: selectedCompany?.financialYear ?? proposal.financialYear,
        },
      }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json().catch(() => ({}))) as { command?: TallyCommand };
    return payload.command ?? null;
  }

  async function createDebitNoteForProposal(proposal: DebitNoteProposal) {
    const id = proposal.id;
    let command: TallyCommand | null = null;
    if (proposal.sourceKind === "tally_open_bill" || id.startsWith("tally:")) {
      command = await approveTallySuggestion(proposal);
    } else {
      const response = await apiFetch(`/api/collections/debit-note-proposals/${id}/approve`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json().catch(() => ({}))) as { command?: TallyCommand };
      command = payload.command ?? null;
    }

    const commandConnectionId = command?.connectionId ?? selectedConnectionId;
    if (command?.id && commandConnectionId) {
      await pollCommand(commandConnectionId, command.id);
    } else {
      await wait(1800);
    }
  }

  async function approveProposal(proposal: DebitNoteProposal) {
    if (!tallyCompanyVerified) {
      setMessage({ tone: "error", text: `Tally is open to ${activeTallyCompanyName || "another company"}. Switch it to ${selectedCompany?.companyName || "the selected company"}, refresh, then create the debit note.` });
      return;
    }
    const id = proposal.id;
    try {
      setApprovingId(id);
      setMessage({ tone: "info", text: "Creating debit note in Tally..." });
      await createDebitNoteForProposal(proposal);
      if (selectedConnectionId) {
        await refreshTallyOpenBills(selectedConnectionId, selectedCompany?.companyName);
        await loadDashboard(selectedConnectionId, selectedCompany?.companyName);
      } else {
        await loadDashboard();
      }
      setActiveView("done");
      setMessage({ tone: "success", text: "Debit note created in Tally." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not approve proposal." });
    } finally {
      setApprovingId("");
    }
  }

  async function sendWhatsappForProposal(
    proposal: DebitNoteProposal,
    options?: { recipientPhone?: string; savePhoneToTally?: boolean; connectionId?: string }
  ) {
    const response = await apiFetch(`/api/collections/debit-note-proposals/${proposal.id}/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options ?? {}),
    });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json().catch(() => ({}))) as WhatsappSendResult;
  }

  async function readTallyLedgerPhone(connectionId: string, ledgerName: string) {
    const response = await apiFetch(`/api/tally/connections/${connectionId}/masters?type=ledger&limit=5000`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { masters?: TallyMaster[] };
    const ledger = (payload.masters ?? []).find(
      (master) => master.name.trim().toLowerCase() === ledgerName.trim().toLowerCase()
    );
    return ledger?.phone ?? null;
  }

  function openWhatsappDialog(proposalsToSend: DebitNoteProposal[]) {
    const sendable = proposalsToSend.filter((proposal) => proposal.communicationStatus !== "sent");
    if (sendable.length === 0) return;
    const nextInputs: Record<string, string> = {};
    for (const proposal of sendable) {
      if (!proposal.partyPhone) nextInputs[proposal.id] = "";
    }
    setWhatsappDialogProposals(sendable);
    setWhatsappPhoneInputs(nextInputs);
    setWhatsappSaveToTally(true);
    setMessage(null);
  }

  async function sendWhatsappFromDialog() {
    if (whatsappDialogProposals.length === 0) return;

    for (const proposal of whatsappDialogProposals) {
      if (proposal.partyPhone) continue;
      const phone = getTenDigitPhone(whatsappPhoneInputs[proposal.id] ?? "");
      if (!phone) {
        setMessage({ tone: "error", text: "Enter valid 10-digit WhatsApp numbers for all selected debit notes." });
        return;
      }
    }

    try {
      setWhatsappDialogSending(true);
      setBulkSendingWhatsapp(whatsappDialogProposals.length > 1);
      const pendingTallyPhoneSaves: Array<{ ledgerName: string; phone: string; commandId: string; connectionId: string }> = [];
      let requestedTallyPhoneSaves = 0;
      let failedTallyPhoneQueues = 0;
      for (const proposal of whatsappDialogProposals) {
        setSendingWhatsappId(proposal.id);
        const phone = proposal.partyPhone ? undefined : getTenDigitPhone(whatsappPhoneInputs[proposal.id] ?? "");
        const sendResult = await sendWhatsappForProposal(
          proposal,
          phone
            ? {
                recipientPhone: phone,
                savePhoneToTally: whatsappSaveToTally,
                connectionId: selectedConnectionId,
              }
            : undefined
        );
        if (phone && sendResult.phoneSaveCommandId && sendResult.phoneSaveConnectionId) {
          requestedTallyPhoneSaves += 1;
          pendingTallyPhoneSaves.push({
            ledgerName: proposal.partyLedgerName,
            phone,
            commandId: sendResult.phoneSaveCommandId,
            connectionId: sendResult.phoneSaveConnectionId,
          });
        } else if (phone && whatsappSaveToTally) {
          requestedTallyPhoneSaves += 1;
          failedTallyPhoneQueues += 1;
        }
      }

      let verifiedTallyPhoneSaves = 0;
      if (pendingTallyPhoneSaves.length > 0 && selectedConnectionId) {
        for (const save of pendingTallyPhoneSaves) {
          await pollCommand(save.connectionId, save.commandId);
        }
        await syncCurrentCompanyLedgers(selectedConnectionId, selectedCompany?.companyName);
        for (const save of pendingTallyPhoneSaves) {
          const storedPhone = await readTallyLedgerPhone(selectedConnectionId, save.ledgerName);
          if (getTenDigitPhone(storedPhone ?? "") === save.phone) verifiedTallyPhoneSaves += 1;
        }
      }
      setMessage({
        tone: "success",
        text: `${
          whatsappDialogProposals.length === 1
            ? "WhatsApp message sent."
            : `${whatsappDialogProposals.length} WhatsApp messages sent.`
        }${
          requestedTallyPhoneSaves === 0
            ? ""
            : failedTallyPhoneQueues === 0 && verifiedTallyPhoneSaves === requestedTallyPhoneSaves
              ? ` ${verifiedTallyPhoneSaves === 1 ? "Number was" : "Numbers were"} saved and verified in Tally.`
              : ` ${requestedTallyPhoneSaves - verifiedTallyPhoneSaves} number${requestedTallyPhoneSaves - verifiedTallyPhoneSaves === 1 ? " was" : "s were"} not saved or verified in Tally.`
        }`,
      });
      setWhatsappDialogProposals([]);
      setWhatsappPhoneInputs({});
      setSelectedCreatedIds(new Set());
      await loadDashboard();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not send WhatsApp message." });
      await loadDashboard().catch(() => undefined);
    } finally {
      setWhatsappDialogSending(false);
      setBulkSendingWhatsapp(false);
      setSendingWhatsappId("");
    }
  }

  function chooseView(view: ActiveView) {
    setActiveView(view);
  }

  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!selectedConnectionId) {
      setLiveTallyConnection(null);
      setCheckingLiveTallyCompany(false);
      return;
    }
    void refreshLiveTallyCompany(selectedConnectionId).catch(() => undefined);
  }, [refreshLiveTallyCompany, selectedConnectionId]);

  useEffect(() => {
    if (!selectedConnectionId) return;
    const company = selectedCompany;
    const loadKey = `${selectedConnectionId}::${company?.companyName ?? ""}`;
    if (lastLoadedConnectionRef.current === loadKey) return;
    lastLoadedConnectionRef.current = loadKey;
    void (async () => {
      setLoading(true);
      setDashboard(null);
      try {
        // A company switch must read a new live snapshot. Loading the old saved
        // scan here can show bills belonging to the previously selected company.
        await refreshTallyOpenBills(selectedConnectionId, company?.companyName);
        await loadDashboard(selectedConnectionId, company?.companyName);
      } catch (error) {
        setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not load Cash Discounts data." });
      } finally {
        setLoading(false);
      }
    })();
  }, [loadDashboard, refreshTallyOpenBills, selectedCompany, selectedConnectionId]);

  const proposals = dashboard?.tabs?.debitNoteQueue ?? [];
  const rules = dashboard?.rules ?? [];

  const activeTallyCompanyName = liveTallyConnection?.lastCompanyName?.trim() ?? "";
  const tallyCompanyVerified = Boolean(
    !checkingLiveTallyCompany &&
      selectedCompany?.companyName &&
      activeTallyCompanyName &&
      liveTallyConnection?.tallyReachable === true &&
      liveTallyConnection?.companyLoaded === true &&
      normalizeCompanyName(selectedCompany.companyName) === normalizeCompanyName(activeTallyCompanyName)
  );

  const pendingProposals = proposals.filter(isPendingDebitNote);
  const createdProposals = proposals.filter(isCreatedDebitNote);
  const selectablePendingProposals = tallyCompanyVerified ? pendingProposals.filter(canCreateInTally) : [];
  const selectedPendingProposals = selectablePendingProposals.filter((proposal) => selectedPendingIds.has(proposal.id));
  const selectableCreatedProposals = createdProposals.filter((proposal) => proposal.communicationStatus !== "sent");
  const selectedCreatedProposals = selectableCreatedProposals.filter((proposal) => selectedCreatedIds.has(proposal.id));
  const allPendingSelected =
    selectablePendingProposals.length > 0 && selectablePendingProposals.every((proposal) => selectedPendingIds.has(proposal.id));
  const allCreatedSelected =
    selectableCreatedProposals.length > 0 && selectableCreatedProposals.every((proposal) => selectedCreatedIds.has(proposal.id));
  const pendingRecoverableTotal = sumRecoverable(pendingProposals);
  const createdRecoverableTotal = sumRecoverable(createdProposals);
  const activeRule = rules[0];
  const companyReady = tallyCompanyVerified;
  const whatsappDialogMissingCount = whatsappDialogProposals.filter((proposal) => !proposal.partyPhone).length;

  function togglePendingSelection(id: string, checked: boolean) {
    setSelectedPendingIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllPending(checked: boolean) {
    setSelectedPendingIds((current) => {
      const next = new Set(current);
      for (const proposal of selectablePendingProposals) {
        if (checked) next.add(proposal.id);
        else next.delete(proposal.id);
      }
      return next;
    });
  }

  function toggleCreatedSelection(id: string, checked: boolean) {
    setSelectedCreatedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllCreated(checked: boolean) {
    setSelectedCreatedIds((current) => {
      const next = new Set(current);
      for (const proposal of selectableCreatedProposals) {
        if (checked) next.add(proposal.id);
        else next.delete(proposal.id);
      }
      return next;
    });
  }

  async function approveSelectedProposals() {
    if (!tallyCompanyVerified) {
      setMessage({ tone: "error", text: `Tally is open to ${activeTallyCompanyName || "another company"}. Switch it to ${selectedCompany?.companyName || "the selected company"}, refresh, then create debit notes.` });
      return;
    }
    if (selectedPendingProposals.length === 0) return;
    const confirmed = window.confirm(
      `Create ${selectedPendingProposals.length} debit note${selectedPendingProposals.length === 1 ? "" : "s"} in Tally?`
    );
    if (!confirmed) return;

    try {
      setBulkCreating(true);
      setMessage({ tone: "info", text: `Creating ${selectedPendingProposals.length} debit notes in Tally...` });
      for (const proposal of selectedPendingProposals) {
        setApprovingId(proposal.id);
        await createDebitNoteForProposal(proposal);
      }
      if (selectedConnectionId) {
        await refreshTallyOpenBills(selectedConnectionId, selectedCompany?.companyName);
        await loadDashboard(selectedConnectionId, selectedCompany?.companyName);
      } else {
        await loadDashboard();
      }
      setSelectedPendingIds(new Set());
      setActiveView("done");
      setMessage({ tone: "success", text: `${selectedPendingProposals.length} debit notes created in Tally.` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not create selected debit notes." });
      await loadDashboard().catch(() => undefined);
    } finally {
      setApprovingId("");
      setBulkCreating(false);
    }
  }

  async function sendSelectedWhatsappMessages() {
    if (selectedCreatedProposals.length === 0) return;
    openWhatsappDialog(selectedCreatedProposals);
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col overflow-y-auto px-6 pb-8 pt-5 text-[#1a1a1a] animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-8 border-b border-[#e5ddd0] pb-6 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-6">
        <div>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200/50 text-[10px] font-bold uppercase tracking-wider text-amber-800">
            <Sparkles className="h-3 w-3 text-amber-600 animate-spin duration-3000" />
            Collections Ledgers
          </div>
          <h1 className="text-3xl font-black tracking-tight text-[#1a1a1a] mt-2 flex items-center gap-2">
            Cash Discounts
          </h1>
          <p className="text-xs font-semibold text-slate-500 mt-1">
            Review, track, and post debit notes for missed cash discounts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 xl:justify-end">
          <label className="w-full sm:w-[280px]">
            <span className="sr-only">Company</span>
            <select
              className="h-10 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#1a1a1a] shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
              onChange={(event) => {
                const company = companies.find((item) => item.id === event.target.value) ?? null;
                setSelectedCompanyId(event.target.value);
                setSelectedConnectionId(company?.connectionId || "");
              }}
              value={selectedCompany?.id || selectedCompanyId}
            >
              {companies.length === 0 ? <option value="">No Tally company found</option> : null}
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {formatCompanyOptionLabel(company)}
                </option>
              ))}
            </select>
          </label>

          <div className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs text-slate-500 shadow-sm">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold ${
                companyReady
                  ? "border-emerald-250 bg-emerald-50 text-emerald-800"
                  : "border-amber-250 bg-amber-50 text-amber-800"
              }`}
            >
              {companyReady ? <CheckCircle2 className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
              {checkingLiveTallyCompany ? "Checking Tally" : companyReady ? "Tally company verified" : "Switch company in Tally"}
            </span>
            <span className="hidden h-4 w-px bg-[#e5ddd0] sm:block" />
            <span className="whitespace-nowrap font-semibold">
              Gajkesari: {selectedCompany?.companyName || "Not selected"} · Tally: {checkingLiveTallyCompany ? "Checking…" : activeTallyCompanyName || "Not detected"}
            </span>
          </div>

          <button
            className="inline-flex h-10 w-fit items-center justify-center gap-2 rounded-xl border border-[#e5ddd0] bg-white px-4 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all"
            onClick={() => void refreshAll()}
            type="button"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Refresh
          </button>
        </div>
      </div>

      {message ? (
        <div
          className={`mb-6 rounded-xl border px-4 py-3 text-sm font-medium ${message.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : message.tone === "info"
                ? "border-sky-200 bg-sky-50 text-sky-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
        >
          {message.text}
        </div>
      ) : null}

      {dashboard?.setupRequired ? (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800 shadow-sm">
          Cash Discounts tables are not ready. Run the database migration.
        </div>
      ) : null}

      <section className="mb-6">
        <div className="grid gap-4 md:grid-cols-3">
          <WorkflowButton
            active={activeView === "needsAction"}
            count={pendingProposals.length}
            detail={`${formatMoney(pendingRecoverableTotal)} recoverable`}
            label="To create"
            onClick={() => chooseView("needsAction")}
          />
          <WorkflowButton
            active={activeView === "done"}
            count={createdProposals.length}
            detail={`${formatMoney(createdRecoverableTotal)} created in Tally`}
            label="Created"
            onClick={() => chooseView("done")}
          />
          <WorkflowButton
            active={activeView === "rules"}
            count={rules.length}
            detail={activeRule ? `${activeRule.discountValue}% within ${activeRule.eligibilityDays} days` : "No active rule"}
            label={rules.length === 1 ? "Rule" : "Rules"}
            onClick={() => chooseView("rules")}
          />
        </div>
      </section>

      {activeView === "needsAction" ? (
        <Section
          action={
            selectedPendingProposals.length > 0 ? (
              <button
                className="inline-flex h-8.5 items-center justify-center gap-1.5 rounded-xl bg-[#2d2d2d] px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={bulkCreating}
                onClick={() => void approveSelectedProposals()}
                type="button"
              >
                {bulkCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Create {selectedPendingProposals.length} debit notes
              </button>
            ) : null
          }
          description={`${formatMoney(pendingRecoverableTotal)} can be recovered from open Tally bills.`}
          title="To create"
        >
          {pendingProposals.length === 0 ? (
            <EmptyState>
              Nothing needs action right now.
            </EmptyState>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white shadow-sm">
              <div className="max-h-[calc(100vh-430px)] overflow-auto">
                <table className="w-full min-w-[1120px] border-collapse text-left">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-[#e5ddd0] bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <th className="w-10 px-4 py-3.5">
                        <input
                          aria-label="Select all debit notes to create"
                          checked={allPendingSelected}
                          className="h-4 w-4 rounded border-[#d6cabb] text-[#2d2d2d] focus:ring-[#2d2d2d]"
                          disabled={selectablePendingProposals.length === 0 || bulkCreating}
                          onChange={(event) => toggleAllPending(event.target.checked)}
                          type="checkbox"
                        />
                      </th>
                      <th className="px-4 py-3.5">Customer</th>
                      <th className="w-56 px-4 py-3.5">Invoice</th>
                      <th className="w-56 px-4 py-3.5">Why now</th>
                      <th className="w-40 px-4 py-3.5 text-right">Debit note</th>
                      <th className="w-32 px-4 py-3.5">Status</th>
                      <th className="w-48 px-4 py-3.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#e5ddd0] text-xs font-semibold text-slate-600">
                    {pendingProposals.map((proposal) => {
                      const shortfall = calculateShortfall(proposal);
                      const createEnabled = tallyCompanyVerified && canCreateInTally(proposal);
                      const displayAmount = proposal.recoverableAmount;
                      const lateByDays = daysPast(proposal.discountDeadline);

                      return (
                        <tr className="align-top hover:bg-[#fcfbfa]/60 transition-colors" key={proposal.id}>
                          <td className="px-4 py-4">
                            <input
                              aria-label={`Select debit note for ${proposal.partyLedgerName}`}
                              checked={selectedPendingIds.has(proposal.id)}
                              className="h-4 w-4 rounded border-[#d6cabb] text-[#2d2d2d] focus:ring-[#2d2d2d] disabled:opacity-40"
                              disabled={!createEnabled || bulkCreating}
                              onChange={(event) => togglePendingSelection(proposal.id, event.target.checked)}
                              type="checkbox"
                            />
                          </td>
                          <td className="px-4 py-4">
                            <div className="max-w-[280px] truncate text-sm font-semibold text-[#1a1a1a]" title={proposal.partyLedgerName}>
                              {proposal.partyLedgerName}
                            </div>
                            <div className="mt-1 inline-flex rounded-full border border-[#e5ddd0] bg-[#fcfbfa] px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                              {contactStatus(proposal)}
                            </div>
                            {proposal.lastError ? (
                              <div className="mt-1 max-w-[280px] truncate text-[11px] text-red-600 font-semibold">
                                {proposal.lastError}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-4 py-4">
                            <div className="truncate text-sm font-semibold text-[#1a1a1a]" title={proposal.linkedInvoiceNumber ?? ""}>
                              {shortText(proposal.linkedInvoiceNumber, "No invoice")}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500">{formatDate(proposal.linkedInvoiceDate)}</div>
                            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                              <span className="rounded-full bg-[#f7f4ee] px-2 py-0.5 text-slate-600">
                                Invoice {formatMoney(proposal.originalInvoiceAmount)}
                              </span>
                              {typeof proposal.pendingAmount === "number" ? (
                                <span className="rounded-full bg-[#fff7ed] px-2 py-0.5 text-amber-800">
                                  Pending {formatMoney(proposal.pendingAmount)}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="text-sm font-semibold text-[#1a1a1a]">{issueLabel(proposal)}</div>
                            <div className="mt-1 text-[11px] text-slate-500">
                              Discount expired {formatDate(proposal.discountDeadline)}
                              {lateByDays !== null ? ` - ${lateByDays} day${lateByDays === 1 ? "" : "s"} late` : ""}
                            </div>
                            {proposal.issueType === "discount_shortfall" && typeof shortfall === "number" && shortfall > 0 ? (
                              <div className="mt-1 text-[11px] text-slate-400">
                                Received {formatMoney(proposal.amountReceived)} of {formatMoney(proposal.originalInvoiceAmount)}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-4 py-4 text-right">
                            <div className="tabular-nums text-sm font-semibold text-[#1a1a1a]">{formatMoney(displayAmount)}</div>
                            <div className="mt-1 text-[11px] font-medium text-slate-400">
                              {proposal.cashDiscountRuleName || "Cash discount"}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusClass(proposal.status)}`}>
                              {actionStatusLabel(proposal)}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-right">
                            <button
                              className="inline-flex min-h-8.5 min-w-[150px] items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-[#2d2d2d] px-4 py-2 text-xs font-bold leading-none text-white shadow-sm transition-all hover:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={!createEnabled || approvingId === proposal.id}
                              onClick={() => {
                                if (createEnabled) void approveProposal(proposal);
                              }}
                              type="button"
                            >
                              {approvingId === proposal.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Send className="h-3.5 w-3.5" />
                              )}
                              {createButtonLabel(proposal)}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Section>
      ) : null}

      {activeView === "done" ? (
        <Section
          action={
            selectedCreatedProposals.length > 0 ? (
              <button
                className="inline-flex h-8.5 items-center justify-center gap-1.5 rounded-xl border border-[#e5ddd0] bg-white px-4 text-xs font-bold text-[#5a5046] shadow-sm transition-all hover:bg-[#faf8f4] hover:text-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={bulkSendingWhatsapp}
                onClick={() => void sendSelectedWhatsappMessages()}
                type="button"
              >
                {bulkSendingWhatsapp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
                Send WhatsApp ({selectedCreatedProposals.length})
              </button>
            ) : null
          }
          description={`${formatMoney(createdRecoverableTotal)} posted as debit notes.`}
          title="Created"
        >
          {createdProposals.length === 0 ? (
            <EmptyState>Nothing completed yet.</EmptyState>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white shadow-sm">
              <div className="max-h-[calc(100vh-430px)] overflow-auto">
                <table className="w-full min-w-[1120px] border-collapse text-left">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-[#e5ddd0] bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <th className="w-10 px-4 py-3.5">
                        <input
                          aria-label="Select all debit notes for WhatsApp"
                          checked={allCreatedSelected}
                          className="h-4 w-4 rounded border-[#d6cabb] text-[#2d2d2d] focus:ring-[#2d2d2d]"
                          disabled={selectableCreatedProposals.length === 0 || bulkSendingWhatsapp}
                          onChange={(event) => toggleAllCreated(event.target.checked)}
                          type="checkbox"
                        />
                      </th>
                      <th className="px-4 py-3.5">Customer</th>
                      <th className="w-52 px-4 py-3.5">Debit note</th>
                      <th className="w-52 px-4 py-3.5">Linked invoice</th>
                      <th className="w-32 px-4 py-3.5 text-right">Amount</th>
                      <th className="w-40 px-4 py-3.5">Result</th>
                      <th className="w-40 px-4 py-3.5 text-right">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#e5ddd0] text-xs font-semibold text-slate-600">
                    {createdProposals.map((proposal) => {
                      const canMessage = proposal.communicationStatus !== "sent";
                      const sending = sendingWhatsappId === proposal.id;

                      return (
                        <tr className="align-top hover:bg-[#fcfbfa]/60 transition-colors" key={proposal.id}>
                          <td className="px-4 py-4">
                            <input
                              aria-label={`Select WhatsApp for ${proposal.partyLedgerName}`}
                              checked={selectedCreatedIds.has(proposal.id)}
                              className="h-4 w-4 rounded border-[#d6cabb] text-[#2d2d2d] focus:ring-[#2d2d2d] disabled:opacity-40"
                              disabled={proposal.communicationStatus === "sent" || bulkSendingWhatsapp}
                              onChange={(event) => toggleCreatedSelection(proposal.id, event.target.checked)}
                              type="checkbox"
                            />
                          </td>
                          <td className="px-4 py-4">
                            <div className="max-w-[260px] truncate text-sm font-semibold text-[#1a1a1a]" title={proposal.partyLedgerName}>
                              {proposal.partyLedgerName}
                            </div>
                            <ContactMeta proposal={proposal} />
                          </td>
                          <td className="px-4 py-4">
                            <div className="truncate text-sm font-semibold text-[#1a1a1a]" title={proposal.tallyVoucherNumber ?? ""}>
                              {shortText(proposal.tallyVoucherNumber, "Debit note created")}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500">
                              {formatDate(proposal.createdInTallyAt ?? proposal.tallyVoucherDate)}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="truncate text-sm font-semibold text-[#1a1a1a]">{shortText(proposal.linkedInvoiceNumber, "No invoice")}</div>
                            <div className="mt-1 text-[11px] text-slate-500">{formatDate(proposal.linkedInvoiceDate)}</div>
                            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                              <span className="rounded-full bg-[#f7f4ee] px-2 py-0.5 text-slate-600">
                                Invoice {formatMoney(proposal.originalInvoiceAmount)}
                              </span>
                              {typeof proposal.amountReceived === "number" ? (
                                <span className="rounded-full bg-[#eefcf5] px-2 py-0.5 text-emerald-800">
                                  Received {formatMoney(proposal.amountReceived)}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums text-sm font-semibold text-[#1a1a1a]">
                            {formatMoney(proposal.recoverableAmount)}
                          </td>
                          <td className="px-4 py-4">
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusClass(proposal.status)}`}>
                              Created in Tally
                            </span>
                          </td>
                          <td className="px-4 py-4 text-right">
                            <div className="flex items-center justify-end gap-2.5">
                              <span
                                className={`hidden rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider lg:inline-flex ${messageStatusClass(proposal.communicationStatus)}`}
                              >
                                {proposal.communicationStatus === "sent" ? "Sent" : proposal.communicationStatus === "failed" ? "Failed" : "Not sent"}
                              </span>
                              <button
                                className="inline-flex h-8.5 items-center justify-center gap-1.5 rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm disabled:cursor-not-allowed disabled:opacity-50 transition-all"
                                disabled={!canMessage || sending}
                                onClick={() => openWhatsappDialog([proposal])}
                                type="button"
                              >
                                {sending ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <MessageCircle className="h-3.5 w-3.5" />
                                )}
                                {messageLabel(proposal)}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Section>
      ) : null}

      {activeView === "rules" ? (
        <Section
          action={
            <button
              className="inline-flex h-8.5 items-center gap-1.5 rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm disabled:cursor-not-allowed disabled:opacity-50 transition-all"
              disabled={!selectedConnectionId || savingRule}
              onClick={() => void createDefaultRule()}
              type="button"
            >
              {savingRule ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Settings2 className="h-3.5 w-3.5" />}
              Add default rule
            </button>
          }
          description="Keep the active recovery rule simple and visible."
          title="Rules"
        >
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            {rules.length === 0 ? (
              <div className="col-span-full">
                <EmptyState>No rule configured.</EmptyState>
              </div>
            ) : (
              rules.map((rule) => (
                <div className="rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-sm" key={rule.id}>
                  <div className="text-sm font-extrabold text-[#1a1a1a]">{rule.ruleName}</div>
                  <div className="mt-2 text-xs font-semibold text-slate-400">
                    {rule.discountValue}% within {rule.eligibilityDays} days - {rule.missedCdTreatment.replace(/_/g, " ")}
                  </div>
                </div>
              ))
            )}
          </div>
        </Section>
      ) : null}

      {whatsappDialogProposals.length > 0 ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-2xl rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-[#1a1a1a]">Send WhatsApp</h3>
                <p className="mt-1 text-xs font-medium text-slate-500">
                  {whatsappDialogProposals.length} debit note{whatsappDialogProposals.length === 1 ? "" : "s"} selected.
                  {whatsappDialogMissingCount > 0
                    ? ` Add ${whatsappDialogMissingCount} missing number${whatsappDialogMissingCount === 1 ? "" : "s"} before sending.`
                    : " Ready to send."}
                </p>
              </div>
              <button
                className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-[#faf8f4]"
                disabled={whatsappDialogSending}
                onClick={() => setWhatsappDialogProposals([])}
                type="button"
              >
                Close
              </button>
            </div>
            <div className="mt-5 max-h-[360px] overflow-auto rounded-2xl border border-[#e5ddd0]">
              <table className="w-full min-w-[620px] border-collapse text-left">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-[#e5ddd0] bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    <th className="px-3 py-3">Customer</th>
                    <th className="w-44 px-3 py-3">Debit note</th>
                    <th className="w-28 px-3 py-3 text-right">Amount</th>
                    <th className="w-52 px-3 py-3">WhatsApp number</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e5ddd0] text-xs font-semibold text-slate-600">
                  {whatsappDialogProposals.map((proposal) => {
                    const inputValue = whatsappPhoneInputs[proposal.id] ?? "";
                    const inputInvalid = Boolean(inputValue) && !getTenDigitPhone(inputValue);

                    return (
                      <tr className="align-top" key={proposal.id}>
                        <td className="px-3 py-3">
                          <div className="max-w-[220px] truncate text-sm font-semibold text-[#1a1a1a]" title={proposal.partyLedgerName}>
                            {proposal.partyLedgerName}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="max-w-[170px] truncate text-xs font-semibold text-slate-600" title={proposal.tallyVoucherNumber ?? ""}>
                            {shortText(proposal.tallyVoucherNumber, "Debit note")}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-sm font-semibold text-[#1a1a1a]">
                          {formatMoney(proposal.recoverableAmount)}
                        </td>
                        <td className="px-3 py-2.5">
                          {proposal.partyPhone ? (
                            <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                              {proposal.partyPhone}
                            </span>
                          ) : (
                            <div>
                              <input
                                className="h-9 w-full rounded-xl border border-[#e5ddd0] bg-white px-3 text-sm font-semibold text-[#1a1a1a] outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                                inputMode="tel"
                                maxLength={14}
                                onChange={(event) =>
                                  setWhatsappPhoneInputs((current) => ({
                                    ...current,
                                    [proposal.id]: event.target.value,
                                  }))
                                }
                                placeholder="9765723830"
                                value={inputValue}
                              />
                              {inputInvalid ? (
                                <span className="mt-1 block text-[11px] font-semibold text-red-600">
                                  Enter a valid 10-digit number.
                                </span>
                              ) : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {whatsappDialogMissingCount > 0 ? (
              <label className="mt-4 flex items-start gap-3 rounded-xl border border-[#e5ddd0] bg-[#fcfbfa] p-3 text-xs font-semibold text-[#5a5046]">
                <input
                  checked={whatsappSaveToTally}
                  className="mt-0.5 h-4 w-4 rounded border-[#d6cabb] text-[#2d2d2d] focus:ring-[#2d2d2d]"
                  onChange={(event) => setWhatsappSaveToTally(event.target.checked)}
                  type="checkbox"
                />
                <span>Also save entered numbers to the matching customer ledgers in Tally. We will verify each save before confirming it.</span>
              </label>
            ) : null}

            <div className="mt-5 flex justify-end gap-3">
              <button
                className="inline-flex h-9 items-center justify-center rounded-xl border border-[#e5ddd0] bg-white px-4 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4]"
                disabled={whatsappDialogSending}
                onClick={() => setWhatsappDialogProposals([])}
                type="button"
              >
                Cancel
              </button>
              <button
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-[#2d2d2d] px-4 text-xs font-bold text-white hover:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={whatsappDialogSending}
                onClick={() => void sendWhatsappFromDialog()}
                type="button"
              >
                {whatsappDialogSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
                Send WhatsApp
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
