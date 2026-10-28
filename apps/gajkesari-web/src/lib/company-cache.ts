// Last known Tally company list, so a page can start reading data while the
// list is re-checked in the background. Never trusted over the fresh answer.
const KEY = "gajkesari:companies-cache:v1";

type Cached<T> = { companies: T[]; selectedCompanyId: string };

export function readCompaniesCache<T>(): Cached<T> | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const value = raw ? (JSON.parse(raw) as Cached<T>) : null;
    return value && Array.isArray(value.companies) && value.companies.length ? value : null;
  } catch {
    return null;
  }
}

export function writeCompaniesCache<T>(companies: T[], selectedCompanyId: string) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ companies, selectedCompanyId }));
  } catch { /* storage blocked: the page still works, just without the head start */ }
}
