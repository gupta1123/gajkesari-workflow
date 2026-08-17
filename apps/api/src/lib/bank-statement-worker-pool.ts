export type BankStatementWorkerPool = "local" | "remote";

function normalizeWorkerPool(value: string | undefined): BankStatementWorkerPool | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "local" || normalized === "remote" ? normalized : null;
}

export function getBankStatementWorkerPool(): BankStatementWorkerPool {
  const configured = normalizeWorkerPool(process.env.BANK_STATEMENT_WORKER_POOL);
  if (configured) return configured;

  const appBaseUrl =
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "";
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(appBaseUrl)) {
    return "local";
  }

  return process.env.NODE_ENV === "production" ? "remote" : "local";
}

export function createBankStatementJobResult() {
  return { workerPool: getBankStatementWorkerPool() };
}
