import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type CashDiscountCustomerScopeMode = "automatic" | "custom" | "strict";

export type CashDiscountCustomerScope = {
  mode: CashDiscountCustomerScopeMode;
  selectedGroupNames: string[];
  includeNestedGroups: boolean;
  detectSalesLinkedExceptions: boolean;
  excludedGroupNames: string[];
  excludedLedgerNames: string[];
};

type ScopeRow = {
  connection_id?: string;
  updated_at?: string | null;
  company_name_key?: string;
  mode: CashDiscountCustomerScopeMode;
  selected_group_names: string[] | null;
  include_nested_groups: boolean;
  detect_sales_linked_exceptions: boolean;
  excluded_group_names: string[] | null;
  excluded_ledger_names: string[] | null;
};

export const DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE: CashDiscountCustomerScope = {
  mode: "automatic",
  selectedGroupNames: ["Sundry Debtors"],
  includeNestedGroups: true,
  detectSalesLinkedExceptions: true,
  excludedGroupNames: [],
  excludedLedgerNames: [],
};

function cleanNames(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const name = typeof item === "string" ? item.trim().slice(0, 240) : "";
    const key = name.toLowerCase().replace(/\s+/g, " ");
    if (!name || seen.has(key)) return [];
    seen.add(key);
    return [name];
  }).slice(0, 200);
}

export function normalizeCashDiscountCustomerScope(input: unknown): CashDiscountCustomerScope {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const mode: CashDiscountCustomerScopeMode =
    record.mode === "custom" || record.mode === "strict" ? record.mode : "automatic";
  const selectedGroupNames = cleanNames(
    record.selectedGroupNames,
    DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE.selectedGroupNames
  );
  return {
    mode,
    selectedGroupNames: selectedGroupNames.length > 0
      ? selectedGroupNames
      : [...DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE.selectedGroupNames],
    includeNestedGroups: record.includeNestedGroups !== false,
    detectSalesLinkedExceptions:
      mode !== "strict" && record.detectSalesLinkedExceptions !== false,
    excludedGroupNames: cleanNames(record.excludedGroupNames),
    excludedLedgerNames: cleanNames(record.excludedLedgerNames),
  };
}

function fromRow(row: ScopeRow | null) {
  if (!row) return { ...DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE };
  return normalizeCashDiscountCustomerScope({
    mode: row.mode,
    selectedGroupNames: row.selected_group_names,
    includeNestedGroups: row.include_nested_groups,
    detectSalesLinkedExceptions: row.detect_sales_linked_exceptions,
    excludedGroupNames: row.excluded_group_names,
    excludedLedgerNames: row.excluded_ledger_names,
  });
}

function serializedError(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const record = error as Record<string, unknown>;
  return [record.message, record.details, record.hint, record.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export function isCashDiscountCustomerScopeSchemaMissing(error: unknown) {
  return /cash_discount_customer_scope_settings|schema cache|does not exist|PGRST205/i.test(
    serializedError(error)
  );
}

const SCOPE_COLUMNS =
  "connection_id, company_name_key, updated_at, mode, selected_group_names, include_nested_groups, detect_sales_linked_exceptions, excluded_group_names, excluded_ledger_names";

function companyNameKey(companyName: string) {
  return companyName.trim().toLowerCase().replace(/\s+/g, " ");
}

// A scope is saved against the connector connection that saved it, but a re-pair creates a new
// connection. Scopes are therefore read per company across the owner's connections: the current
// connection's row wins, otherwise the most recently saved one.
function preferredRow(rows: ScopeRow[], connectionId: string) {
  return [...rows].sort((left, right) => {
    const leftCurrent = left.connection_id === connectionId ? 1 : 0;
    const rightCurrent = right.connection_id === connectionId ? 1 : 0;
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
    return String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""));
  })[0] ?? null;
}

export async function getCashDiscountCustomerScope(params: {
  ownerUserId: string;
  connectionId: string;
  companyName: string;
}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("cash_discount_customer_scope_settings")
    .select(SCOPE_COLUMNS)
    .eq("owner_user_id", params.ownerUserId)
    .eq("company_name_key", companyNameKey(params.companyName));
  if (error) throw error;
  return fromRow(preferredRow((data ?? []) as ScopeRow[], params.connectionId));
}

export async function getCashDiscountCustomerScopeOrDefault(params: {
  ownerUserId: string;
  connectionId: string;
  companyName: string;
}) {
  try {
    return await getCashDiscountCustomerScope(params);
  } catch (error) {
    if (isCashDiscountCustomerScopeSchemaMissing(error)) {
      return { ...DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE };
    }
    throw error;
  }
}

export async function getCashDiscountCustomerScopesByCompany(params: {
  ownerUserId: string;
  connectionId: string;
}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("cash_discount_customer_scope_settings")
    .select(SCOPE_COLUMNS)
    .eq("owner_user_id", params.ownerUserId);
  if (error) {
    if (isCashDiscountCustomerScopeSchemaMissing(error)) return {};
    throw error;
  }
  const rowsByCompany = new Map<string, ScopeRow[]>();
  for (const row of (data ?? []) as ScopeRow[]) {
    const key = String(row.company_name_key ?? "").trim();
    if (key) rowsByCompany.set(key, [...(rowsByCompany.get(key) ?? []), row]);
  }
  return Object.fromEntries(
    [...rowsByCompany].map(([key, rows]) => [key, fromRow(preferredRow(rows, params.connectionId))] as const)
  );
}

export async function saveCashDiscountCustomerScope(params: {
  ownerUserId: string;
  connectionId: string;
  companyName: string;
  settings: CashDiscountCustomerScope;
}) {
  const settings = normalizeCashDiscountCustomerScope(params.settings);
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("cash_discount_customer_scope_settings")
    .upsert({
      owner_user_id: params.ownerUserId,
      connection_id: params.connectionId,
      company_name: params.companyName.trim(),
      company_name_key: params.companyName.trim().toLowerCase().replace(/\s+/g, " "),
      mode: settings.mode,
      selected_group_names: settings.selectedGroupNames,
      include_nested_groups: settings.includeNestedGroups,
      detect_sales_linked_exceptions: settings.detectSalesLinkedExceptions,
      excluded_group_names: settings.excludedGroupNames,
      excluded_ledger_names: settings.excludedLedgerNames,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_user_id,connection_id,company_name_key" })
    .select("mode, selected_group_names, include_nested_groups, detect_sales_linked_exceptions, excluded_group_names, excluded_ledger_names")
    .single();
  if (error) throw error;

  // Older connections' copies would otherwise be stale fallbacks for this company.
  const { error: cleanupError } = await supabase
    .from("cash_discount_customer_scope_settings")
    .delete()
    .eq("owner_user_id", params.ownerUserId)
    .eq("company_name_key", companyNameKey(params.companyName))
    .neq("connection_id", params.connectionId);
  if (cleanupError) throw cleanupError;
  return fromRow(data as ScopeRow);
}
