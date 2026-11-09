import { apiFetch } from "@/lib/api-client";
import { runCashDiscountLiveRequest } from "@/lib/cash-discount-live";
import { chunk, resolveScopedLedgers, type CustomerScope, type ScopeMaster } from "@/lib/cash-discount-scope-ledgers";

// The connector answers one small, filtered open-bills question at a time.
const LEDGERS_PER_READ = 50;

// How the open bills were read, so the page can say so plainly.
export type ScanInfo = { mode: "fast" | "batch"; label: string; detail: string };

export const DEFAULT_CUSTOMER_SCOPE: CustomerScope = {
  mode: "automatic",
  selectedGroupNames: ["Sundry Debtors"],
  includeNestedGroups: true,
  excludedGroupNames: [],
  excludedLedgerNames: [],
};

// "2026-27" -> "2026-04-01". Limiting the voucher history Tally scans keeps one
// read inside Tally's own 60-second export limit on large companies.
export function financialYearStart(financialYear: string | null | undefined) {
  const match = /^(\d{4})\s*-\s*\d{2,4}$/.exec(String(financialYear ?? "").trim());
  return match ? `${match[1]}-04-01` : null;
}

type LiveLedger = ScopeMaster & { gstin?: string | null };
// Only the contact details travel with the scan, so the request stays small.
function contactFields(ledger: LiveLedger) {
  const raw = ((ledger as { raw?: Record<string, unknown> }).raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["phone", "email", "contactPerson"]) if (raw[key]) out[key] = raw[key];
  return out;
}
type LedgerBucket = { complete?: boolean; openBills?: unknown[]; settledBills?: unknown[] };

// Says how much of the scan came from the connector's local copy of Tally's vouchers.
function describeCache(cache: { mode?: string; vouchersRead?: number; cachedVouchers?: number } | undefined, customerCount: number) {
  const base = `Read ${customerCount} customers in one pass.`;
  if (cache?.mode === "unchanged") return `${base} Nothing changed in Tally since the last scan, so saved vouchers were reused.`;
  if (cache?.mode === "delta") return `${base} Only ${cache.vouchersRead ?? 0} changed voucher(s) were read; the rest came from the saved copy.`;
  if (cache?.mode === "rebuilt") return `${base} First scan: all vouchers were read and saved, so later scans will be much faster.`;
  return base;
}

// Tally serves one request at a time; a batch that queued behind the previous
// export is safe to repeat after a short pause.
async function withBusyRetry<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const busy = error instanceof Error && /tally is busy/i.test(error.message);
      if (!busy || attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      signal?.throwIfAborted();
    }
  }
}

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || `Request failed with status ${response.status}`;
}

export async function loadCustomerScope(connectionId: string, companyName: string): Promise<CustomerScope> {
  const params = new URLSearchParams({ connectionId, companyName });
  const response = await apiFetch(`/api/settings/cash-discount-customer-scope?${params}`, { cache: "no-store" });
  // 409 = the scope table has not been installed yet: use the default scope.
  if (response.status === 409) return DEFAULT_CUSTOMER_SCOPE;
  if (!response.ok) throw new Error(await readError(response));
  const payload = (await response.json()) as { settings?: Partial<CustomerScope> };
  return { ...DEFAULT_CUSTOMER_SCOPE, ...payload.settings };
}

// Tally answers one request at a time, so a second scan for the same company
// (a refresh click racing the page load) would only queue behind the first and
// fail with "Tally is busy". Callers share the scan that is already running.
const scansInFlight = new Map<string, Promise<unknown>>();

export function loadLiveCashDiscountDashboard<T>(params: LiveReadParams): Promise<T> {
  const key = `${params.connectionId}::${params.companyName}::${params.financialYear ?? ""}`;
  const running = scansInFlight.get(key);
  if (running) return running as Promise<T>;
  const scan = runLiveCashDiscountDashboard<T>(params).finally(() => scansInFlight.delete(key));
  scansInFlight.set(key, scan);
  return scan;
}

export type LiveReadParams = {
  connectionId: string;
  companyName: string;
  financialYear?: string | null;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onScanInfo?: (info: ScanInfo) => void;
};

export type LiveOpenBills = { customers: LiveLedger[]; byLedger: Record<string, LedgerBucket> };

// Cash Discount and follow-ups read the same data; callers on the same company
// share one running read so Tally is never asked twice at once.
const readsInFlight = new Map<string, Promise<LiveOpenBills>>();

export function readLiveOpenBills(params: LiveReadParams): Promise<LiveOpenBills> {
  const key = `${params.connectionId}::${params.companyName}::${params.financialYear ?? ""}`;
  const running = readsInFlight.get(key);
  if (running) return running;
  const read = readLiveOpenBillsNow(params).finally(() => readsInFlight.delete(key));
  readsInFlight.set(key, read);
  return read;
}

/**
 * Reads the in-scope customers' open bills live from Tally. A whole-company scan
 * is tried first; connectors without it fall back to per-customer batches.
 * Nothing partial is ever returned: a failed read fails the whole refresh.
 */
async function readLiveOpenBillsNow(params: LiveReadParams): Promise<LiveOpenBills> {
  const { connectionId, companyName, signal, onProgress, onScanInfo } = params;
  const financialYear = params.financialYear ?? null;
  const scope = await loadCustomerScope(connectionId, companyName);
  const dateFrom = financialYearStart(financialYear);

  onProgress?.("Reading customers from Tally...");
  const masters = await withBusyRetry(signal, () => runCashDiscountLiveRequest<{ ledgers?: LiveLedger[]; groups?: ScopeMaster[] }>({
    connectionId, companyName, financialYear, signal, onProgress,
    operation: "ledger_masters",
    payload: { requestedMasterTypes: ["ledger", "group"] },
  }));
  const customers = resolveScopedLedgers({ groups: masters.groups ?? [], ledgers: masters.ledgers ?? [] }, scope) as LiveLedger[];
  if (!customers.length) throw new Error("No customers match the Cash Discount customer scope. Review it in Settings.");

  const byLedger: Record<string, LedgerBucket> = {};

  // Preferred: one whole-company read inside the connector. Older connectors
  // reject it immediately, and then we fall back to per-customer batches.
  let scanned = false;
  try {
    onScanInfo?.({ mode: "fast", label: "Fast scan", detail: `Reading all ${customers.length} customers in one pass.` });
    onProgress?.("Fast scan: reading the whole company from Tally...");
    const read = await withBusyRetry(signal, () => runCashDiscountLiveRequest<{ byLedger?: Record<string, LedgerBucket>; queryDiagnostics?: { evidenceCache?: { mode?: string; vouchersRead?: number; cachedVouchers?: number } } }>({
      connectionId, companyName, financialYear, signal, onProgress,
      operation: "fetch_customer_open_bills",
      payload: { companyName, financialYear, queryStrategy: "company_scan", ledgerNames: [], scopeLedgerNames: customers.map((customer) => customer.name) },
    }));
    Object.assign(byLedger, read.byLedger ?? {});
    scanned = true;
    onScanInfo?.({ mode: "fast", label: "Fast scan", detail: describeCache(read.queryDiagnostics?.evidenceCache, customers.length) });
  } catch (error) {
    if (!(error instanceof Error) || !/requires ledgerName/i.test(error.message)) throw error;
  }

  const batches = scanned ? [] : chunk(customers.map((customer) => customer.name), LEDGERS_PER_READ);
  if (!scanned) onScanInfo?.({
    mode: "batch",
    label: "Batch mode (slower)",
    detail: `${customers.length} customers in ${batches.length} reads of up to ${LEDGERS_PER_READ}. This connector version cannot scan the whole company in one pass; update the connector for the fast scan.`,
  });
  for (const [index, ledgerNames] of batches.entries()) {
    signal?.throwIfAborted();
    onProgress?.(`Batch mode: read ${index + 1} of ${batches.length} (${index * LEDGERS_PER_READ + ledgerNames.length} of ${customers.length} customers)...`);
    const read = await withBusyRetry(signal, () => runCashDiscountLiveRequest<{ byLedger?: Record<string, LedgerBucket> }>({
      connectionId, companyName, financialYear, signal, onProgress,
      operation: "fetch_customer_open_bills",
      payload: { companyName, financialYear, ledgerNames, ...(dateFrom ? { dateFrom } : {}) },
    }));
    Object.assign(byLedger, read.byLedger ?? {});
  }

  return { customers, byLedger };
}

/** Reads the open bills, then has the API analyse them for the Cash Discount page. */
async function runLiveCashDiscountDashboard<T>(params: LiveReadParams): Promise<T> {
  const { connectionId, companyName, signal, onProgress } = params;
  const financialYear = params.financialYear ?? null;
  const { customers, byLedger } = await readLiveOpenBills(params);
  onProgress?.("Analysing...");
  const response = await apiFetch("/api/collections/live/analyse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      connectionId,
      companyName,
      financialYear,
      scan: {
        financialYear,
        openBillsResult: { result: { byLedger } },
        ledgers: customers.map((customer) => ({ name: customer.name, parent: customer.parent ?? null, gstin: customer.gstin ?? null, raw: contactFields(customer) })),
        scanSummary: { complete: true, customerCount: customers.length },
      },
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

/**
 * Queues one Cash Discount debit note. The customer's bills are re-read from
 * Tally just now and the server re-checks eligibility on that fresh evidence
 * before it queues the create command, so a stale dashboard row can never post.
 */
export async function queueLiveDebitNote(params: {
  connectionId: string;
  companyName: string;
  financialYear?: string | null;
  proposal: { partyLedgerName: string; linkedInvoiceNumber: string | null };
}) {
  const { connectionId, companyName, proposal } = params;
  const financialYear = params.financialYear ?? null;
  const masters = await withBusyRetry(undefined, () => runCashDiscountLiveRequest<{ ledgers?: LiveLedger[] }>({
    connectionId, companyName, financialYear,
    operation: "ledger_masters",
    payload: { requestedMasterTypes: ["ledger"] },
  }));
  const ledger = (masters.ledgers ?? []).find((entry) => entry.name === proposal.partyLedgerName);
  const read = await withBusyRetry(undefined, () => runCashDiscountLiveRequest<{ byLedger?: Record<string, LedgerBucket> }>({
    connectionId, companyName, financialYear,
    operation: "fetch_customer_open_bills",
    payload: { companyName, financialYear, ledgerNames: [proposal.partyLedgerName] },
  }));
  const response = await apiFetch("/api/collections/live/prepare-debit-note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connectionId,
      companyName,
      queue: true,
      proposal: { partyLedgerName: proposal.partyLedgerName, linkedInvoiceNumber: proposal.linkedInvoiceNumber, financialYear },
      scan: {
        financialYear,
        openBillsResult: { result: { byLedger: read.byLedger ?? {} } },
        ledgers: ledger ? [{ name: ledger.name, parent: ledger.parent ?? null, gstin: ledger.gstin ?? null, raw: (ledger as { raw?: unknown }).raw ?? {} }] : [],
        scanSummary: { complete: true, customerCount: 1 },
      },
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as { command?: { id: string; connectionId?: string } };
}
