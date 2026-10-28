// Turns a saved Cash Discount customer scope into the customer ledgers to read
// from Tally. Pure: works on the account groups and ledgers Tally returns.

export type ScopeMaster = { name: string; parent?: string | null };

export type CustomerScope = {
  mode: "automatic" | "custom" | "strict";
  selectedGroupNames: string[];
  includeNestedGroups: boolean;
  excludedGroupNames: string[];
  excludedLedgerNames: string[];
};

const key = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function groupsUnder(roots: string[], groups: ScopeMaster[], includeNested: boolean) {
  const result = new Set(roots.map(key));
  if (!includeNested) return result;
  for (let changed = true; changed;) {
    changed = false;
    for (const group of groups) {
      if (!result.has(key(group.name)) && group.parent && result.has(key(group.parent))) {
        result.add(key(group.name));
        changed = true;
      }
    }
  }
  return result;
}

export function resolveScopedLedgers(masters: { groups: ScopeMaster[]; ledgers: ScopeMaster[] }, scope: CustomerScope) {
  const included = groupsUnder(scope.selectedGroupNames, masters.groups, scope.includeNestedGroups);
  const excludedGroups = groupsUnder(scope.excludedGroupNames, masters.groups, scope.includeNestedGroups);
  const excludedLedgers = new Set(scope.excludedLedgerNames.map(key));
  const seen = new Set<string>();
  return masters.ledgers.filter((ledger) => {
    const id = key(ledger.name);
    if (!id || seen.has(id)) return false;
    const parent = key(ledger.parent);
    if (!included.has(parent) || excludedGroups.has(parent) || excludedLedgers.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function chunk<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}
