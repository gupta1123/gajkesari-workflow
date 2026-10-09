type Ledger = { name: string; parent?: string | null };
const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function isBankChargeDescription(description: string) {
  return /\bbank\s+(?:commission|charges?|fees?)\b|\bbank\b.*\bservice\s+charge\b/i.test(description);
}

export function resolveBankChargeLedger(description: string, ledgers: Ledger[]) {
  if (!isBankChargeDescription(description)) return null;
  const names = /\bcommission\b/i.test(description)
    ? ["bank commission", "bank charges", "bank fees"]
    : ["bank charges", "bank fees", "bank commission"];
  for (const name of names) {
    const matches = ledgers.filter(ledger => normalized(ledger.name) === name &&
      (!ledger.parent || /expense/i.test(ledger.parent)));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

export function bankChargeNeedsReview(description: string, ledgerName: string, explicitlySelected: boolean) {
  return isBankChargeDescription(description) && /suspense/i.test(ledgerName) && !explicitlySelected;
}
