import { apiFetch } from "@/lib/api-client";
import { runCashDiscountLiveRequest } from "@/lib/cash-discount-live";
import { chunk, resolveScopedLedgers, type CustomerScope, type ScopeMaster } from "@/lib/cash-discount-scope-ledgers";

// The connector answers one small, filtered open-bills question at a time.
const LEDGERS_PER_READ = 10;

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
  const match = /^(d{4})s*-s*d{2,4}$/.exec(String(financialYear ?? "").trim());
  return match ? `${match[1]}-04-01` : null;
}

type LiveLedger = ScopeMaster & { gstin?: string | null };
type LedgerBucket = { complete?: boolean; openBills?: unknown[]; settledBills?: unknown[] };

// Tally serves one request at a time; a batch that queued behind the previous
// export is safe to repeat after a short pause.
async function withBusyRetry<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const busy = error instanceof Error && /tally is busy/i.test(error.message);
      if (!busy || attempt >= 4) throw error;
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

/**
 * Reads the in-scope customers' open bills live from Tally (deployed connector
 * operations only), then has the API analyse the merged scan. Nothing partial
 * is ever analysed: a failed batch fails the whole refresh.
 */
export async function loadLiveCashDiscountDashboard<T>(params: {
  connectionId: string;
  companyName: string;
  financialYear?: string | null;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<T> {
  const { connectionId, companyName, signal, onProgress } = params;
  const financialYear = params.financialYear ?? null;
  const scope = await loadCustomerScope(connectionId, companyName);
  const dateFrom = financialYearStart(financialYear);

  onProgress?.("Reading customers from Tally...");
  const masters = await runCashDiscountLiveRequest<{ ledgers?: LiveLedger[]; groups?: ScopeMaster[] }>({
    connectionId, companyName, financialYear, signal, onProgress,
    operation: "ledger_masters",
    payload: { requestedMasterTypes: ["ledger", "group"] },
  });
  const customers = resolveScopedLedgers({ groups: masters.groups ?? [], ledgers: masters.ledgers ?? [] }, scope) as LiveLedger[];
  if (!customers.length) throw new Error("No customers match the Cash Discount customer scope. Review it in Settings.");

  const byLedger: Record<string, LedgerBucket> = {};
  const batches = chunk(customers.map((customer) => customer.name), LEDGERS_PER_READ);
  for (const [index, ledgerNames] of batches.entries()) {
    signal?.throwIfAborted();
    onProgress?.(`Reading open bills ${index * LEDGERS_PER_READ + ledgerNames.length} of ${customers.length} customers...`);
    const read = await withBusyRetry(signal, () => runCashDiscountLiveRequest<{ byLedger?: Record<string, LedgerBucket> }>({
      connectionId, companyName, financialYear, signal, onProgress,
      operation: "fetch_customer_open_bills",
      payload: { companyName, financialYear, ledgerNames, ...(dateFrom ? { dateFrom } : {}) },
    }));
    Object.assign(byLedger, read.byLedger ?? {});
  }

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
        ledgers: customers.map((customer) => ({ name: customer.name, parent: customer.parent ?? null, gstin: customer.gstin ?? null, raw: {} })),
        scanSummary: { complete: true, customerCount: customers.length },
      },
    }),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}
