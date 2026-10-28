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

type LiveLedger = ScopeMaster & { gstin?: string | null };
type LedgerBucket = { complete?: boolean; openBills?: unknown[]; settledBills?: unknown[] };

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
    const read = await runCashDiscountLiveRequest<{ byLedger?: Record<string, LedgerBucket> }>({
      connectionId, companyName, financialYear, signal, onProgress,
      operation: "fetch_customer_open_bills",
      payload: { companyName, financialYear, ledgerNames },
    });
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
