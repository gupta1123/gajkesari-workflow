"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { runCashDiscountLiveRequest } from "@/lib/cash-discount-live";
import { resolveScopedLedgers, type ScopeMaster } from "@/lib/cash-discount-scope-ledgers";
import { resolveTallyConnectionId } from "@/lib/resolve-tally-connection";
import { PaymentReminderSettings } from "./PaymentReminderSettings";
import "./followups.css";

type Company = { id: string; connectionId: string; companyName: string; financialYear: string };
type Scope = {
  mode: "automatic" | "custom" | "strict";
  selectedGroupNames: string[];
  includeNestedGroups: boolean;
  detectSalesLinkedExceptions: boolean;
  excludedGroupNames: string[];
  excludedLedgerNames: string[];
};
export type Section = "customers" | "reminders" | "rules";
type State = "in" | "out" | "none";

const DEFAULT_SCOPE: Scope = {
  mode: "automatic", selectedGroupNames: ["Sundry Debtors"], includeNestedGroups: true,
  detectSalesLinkedExceptions: true, excludedGroupNames: [], excludedLedgerNames: [],
};

const key = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((name) => b.some((other) => key(other) === key(name)));
const LEDGER_CAP = 100;

function push<T>(map: Map<string, T[]>, k: string, value: T) {
  const list = map.get(k);
  if (list) list.push(value); else map.set(k, [value]);
}

function CustomerScope({ company }: { company: Company }) {
  const [saved, setSaved] = useState<Scope>(DEFAULT_SCOPE);
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  const [groups, setGroups] = useState<ScopeMaster[]>([]);
  const [ledgers, setLedgers] = useState<ScopeMaster[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [more, setMore] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const query = useMemo(() => new URLSearchParams({ connectionId: company.connectionId, companyName: company.companyName }).toString(), [company]);

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      setNotice(null);
      try {
        const response = await apiFetch(`/api/settings/cash-discount-customer-scope?${query}`, { cache: "no-store" });
        // 409: the scope table is not installed yet, so the default applies.
        if (!response.ok && response.status !== 409) throw new Error("Could not load the saved customer choices.");
        const loaded: Scope = response.status === 409 ? DEFAULT_SCOPE : { ...DEFAULT_SCOPE, ...((await response.json()).settings ?? {}) };
        if (live) { setSaved(loaded); setScope(loaded); }
      } catch (error) {
        if (live) setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not load the saved customer choices." });
      }
      try {
        const masters = await runCashDiscountLiveRequest<{ ledgers?: ScopeMaster[]; groups?: ScopeMaster[] }>({
          connectionId: company.connectionId, companyName: company.companyName, financialYear: company.financialYear,
          operation: "ledger_masters", payload: { requestedMasterTypes: ["ledger", "group"] },
        });
        if (live) { setGroups(masters.groups ?? []); setLedgers(masters.ledgers ?? []); }
      } catch (error) {
        if (live) setNotice({ tone: "warn", text: `Tally's groups could not be read (${error instanceof Error ? error.message : "unknown error"}). Your saved choices still apply.` });
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [query, company]);

  // The group tree: parents, children, the ledgers directly inside each group, and ledger totals.
  const tree = useMemo(() => {
    const byKey = new Map<string, ScopeMaster>();
    for (const g of groups) byKey.set(key(g.name), g);
    const children = new Map<string, string[]>();
    const ledgersIn = new Map<string, ScopeMaster[]>();
    const roots: string[] = [];
    for (const g of groups) {
      const k = key(g.name);
      const p = key(g.parent);
      if (p && p !== k && byKey.has(p)) push(children, p, k); else roots.push(k);
    }
    for (const l of ledgers) push(ledgersIn, key(l.parent), l);
    const totals = new Map<string, number>();
    const total = (k: string, seen = new Set<string>()): number => {
      if (totals.has(k)) return totals.get(k)!;
      if (seen.has(k)) return 0;
      seen.add(k);
      const sum = (ledgersIn.get(k)?.length ?? 0) + (children.get(k) ?? []).reduce((n, c) => n + total(c, seen), 0);
      totals.set(k, sum);
      return sum;
    };
    for (const g of groups) total(key(g.name));
    return { byKey, children, ledgersIn, roots, totals };
  }, [groups, ledgers]);

  const descend = useCallback((names: string[], nested: boolean) => {
    const result = new Set(names.map(key));
    if (!nested) return result;
    const queue = [...result];
    while (queue.length) for (const child of tree.children.get(queue.pop()!) ?? []) if (!result.has(child)) { result.add(child); queue.push(child); }
    return result;
  }, [tree]);

  const outLedgers = useMemo(() => new Set(scope.excludedLedgerNames.map(key)), [scope.excludedLedgerNames]);
  const inSet = useMemo(() => descend(scope.selectedGroupNames, scope.includeNestedGroups), [descend, scope.selectedGroupNames, scope.includeNestedGroups]);
  const outSet = useMemo(() => descend(scope.excludedGroupNames, scope.includeNestedGroups), [descend, scope.excludedGroupNames, scope.includeNestedGroups]);
  const pickedKeys = useMemo(() => new Set(scope.selectedGroupNames.map(key)), [scope.selectedGroupNames]);
  const leftKeys = useMemo(() => new Set(scope.excludedGroupNames.map(key)), [scope.excludedGroupNames]);

  const groupState = (k: string): State => (outSet.has(k) ? "out" : inSet.has(k) ? "in" : "none");
  const ledgerState = (l: ScopeMaster): State => {
    const parent = key(l.parent);
    if (outLedgers.has(key(l.name)) || outSet.has(parent)) return "out";
    return inSet.has(parent) ? "in" : "none";
  };

  // Open the chosen groups once the tree is known, so the page starts on the customers.
  useEffect(() => {
    if (groups.length) setOpen(new Set(saved.selectedGroupNames.map(key)));
  }, [groups.length, saved.selectedGroupNames]);

  const matched = useMemo(
    () => (ledgers.length ? resolveScopedLedgers({ groups, ledgers }, scope) : null),
    [groups, ledgers, scope]
  );

  const needle = search.trim().toLowerCase();
  // With a search: which groups to show, and the ledgers / groups that match it.
  const found = useMemo(() => {
    if (!needle) return null;
    const show = new Set<string>();
    const below = new Set<string>();
    const walk = (k: string, seen: Set<string>): boolean => {
      if (seen.has(k)) return false;
      seen.add(k);
      const own = (tree.byKey.get(k)?.name ?? "").toLowerCase().includes(needle);
      const ledgerHit = (tree.ledgersIn.get(k) ?? []).some((l) => l.name.toLowerCase().includes(needle));
      let childHit = false;
      for (const c of tree.children.get(k) ?? []) if (walk(c, seen)) childHit = true;
      if (own || ledgerHit || childHit) show.add(k);
      if (ledgerHit || childHit) below.add(k);
      return own || ledgerHit || childHit;
    };
    for (const root of tree.roots) walk(root, new Set());
    const groupHits = groups.filter((g) => g.name.toLowerCase().includes(needle)).map((g) => g.name);
    const ledgerHits = (matched ?? []).filter((l) => l.name.toLowerCase().includes(needle)).map((l) => l.name);
    return { show, below, groupHits, ledgerHits };
  }, [needle, tree, groups, matched]);

  // Only the chosen groups are shown; their subgroups and ledgers sit beneath them.
  const rootKeys = useMemo(() => {
    const picks = scope.selectedGroupNames.map(key).filter((k) => tree.byKey.has(k));
    const inside = new Set(picks.flatMap((k) => [...descend([tree.byKey.get(k)!.name], true)].filter((d) => d !== k)));
    return [...new Set(picks)].filter((k) => !inside.has(k));
  }, [tree, scope.selectedGroupNames, descend]);

  const pathOf = (k: string) => {
    const trail: string[] = [];
    let cur = key(tree.byKey.get(k)?.parent);
    for (let i = 0; cur && tree.byKey.has(cur) && i < 12; i++) { trail.unshift(tree.byKey.get(cur)!.name); cur = key(tree.byKey.get(cur)!.parent); }
    return trail.join(" › ");
  };

  const addable = useMemo(() => groups
    .filter((g) => !inSet.has(key(g.name)))
    .map((g) => ({ name: g.name, path: pathOf(key(g.name)) }))
    .sort((x, y) => x.name.localeCompare(y.name)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [groups, inSet, tree]);

  const dirty = !sameSet(scope.selectedGroupNames, saved.selectedGroupNames) || !sameSet(scope.excludedGroupNames, saved.excludedGroupNames)
    || !sameSet(scope.excludedLedgerNames, saved.excludedLedgerNames) || scope.mode !== saved.mode || scope.includeNestedGroups !== saved.includeNestedGroups;

  const chooseGroup = (name: string, choice: "count" | "leave") => setScope((cur) => {
    const k = key(name);
    const without = (list: string[]) => list.filter((n) => key(n) !== k);
    const wasCount = cur.selectedGroupNames.some((n) => key(n) === k);
    const wasLeave = cur.excludedGroupNames.some((n) => key(n) === k);
    return {
      ...cur,
      selectedGroupNames: choice === "count" && !wasCount ? [...without(cur.selectedGroupNames), name] : without(cur.selectedGroupNames),
      excludedGroupNames: choice === "leave" && !wasLeave ? [...without(cur.excludedGroupNames), name] : without(cur.excludedGroupNames),
    };
  });
  const toggleGroup = (name: string) => setScope((cur) => {
    const k = key(name);
    const without = (list: string[]) => list.filter((n) => key(n) !== k);
    const picked = cur.selectedGroupNames.some((n) => key(n) === k);
    const left = cur.excludedGroupNames.some((n) => key(n) === k);
    if (outSet.has(k) ? !left : inSet.has(k)) {
      // Checked now: untick it.
      return picked ? { ...cur, selectedGroupNames: without(cur.selectedGroupNames) } : { ...cur, excludedGroupNames: [...cur.excludedGroupNames, name] };
    }
    return { ...cur, excludedGroupNames: without(cur.excludedGroupNames), selectedGroupNames: inSet.has(k) ? cur.selectedGroupNames : [...cur.selectedGroupNames, name] };
  });
  const setGroups_ = (names: string[], choice: "count" | "leave") => setScope((cur) => {
    const ks = new Set(names.map(key));
    const without = (list: string[]) => list.filter((n) => !ks.has(key(n)));
    return {
      ...cur,
      selectedGroupNames: choice === "count" ? [...without(cur.selectedGroupNames), ...names] : without(cur.selectedGroupNames),
      excludedGroupNames: choice === "leave" ? [...without(cur.excludedGroupNames), ...names] : without(cur.excludedGroupNames),
    };
  });
  const leaveLedgers = (names: string[]) => setScope((cur) => ({ ...cur, excludedLedgerNames: [...new Set([...cur.excludedLedgerNames, ...names])] }));
  const countLedger = (name: string) => setScope((cur) => ({ ...cur, excludedLedgerNames: cur.excludedLedgerNames.filter((n) => key(n) !== key(name)) }));

  const toggleOpen = (k: string) => setOpen((cur) => { const next = new Set(cur); if (!next.delete(k)) next.add(k); return next; });

  const save = async () => {
    if (!scope.selectedGroupNames.length) return setNotice({ tone: "err", text: "Choose at least one group to count as customers." });
    setSaving(true);
    setNotice(null);
    try {
      const response = await apiFetch("/api/settings/cash-discount-customer-scope", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: company.connectionId, companyName: company.companyName, settings: scope }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not save.");
      setSaved(scope);
      setNotice({ tone: "ok", text: "Saved. Cash Discounts and Payment Follow-ups use this on their next scan." });
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  };

  const renderGroup = (k: string, depth: number, inherited: State): React.ReactNode => {
    const group = tree.byKey.get(k);
    if (!group || (found && !found.show.has(k))) return null;
    const state = groupState(k);
    const explicitIn = pickedKeys.has(k);
    const explicitOut = leftKeys.has(k);
    const partial = state === "in" && outSet.size > 0 && [...descend([group.name], true)].some((d) => d !== k && outSet.has(d));
    const kids = tree.children.get(k) ?? [];
    const direct = tree.ledgersIn.get(k) ?? [];
    const expandable = kids.length > 0 || direct.length > 0;
    const isOpen = found ? found.below.has(k) : open.has(k);
    const via = state === "out" && !explicitOut ? "left out with its parent" : "";
    const shownLedgers = (found ? direct.filter((l) => l.name.toLowerCase().includes(needle)) : direct);
    const limit = more.has(k) ? shownLedgers.length : LEDGER_CAP;
    return (
      <li key={k} className="tnode">
        <div className={`trow ${state}`} style={{ paddingLeft: 6 + depth * 20 }}>
          <button className="chev" aria-label={isOpen ? "Collapse" : "Expand"} aria-expanded={isOpen} disabled={!expandable} onClick={() => toggleOpen(k)}>{expandable ? (isOpen ? "▾" : "▸") : ""}</button>
          <input type="checkbox" aria-label={`Count ${group.name} as customers`} checked={state === "in"} disabled={state === "out" && !leftKeys.has(k)}
            ref={(el) => { if (el) el.indeterminate = partial; }} onChange={() => toggleGroup(group.name)} />
          <span className="tname">{group.name}{depth === 0 && pathOf(k) && <small className="tpath">in {pathOf(k)}</small>}</span>
          <span className="tmeta">{(tree.totals.get(k) ?? 0).toLocaleString("en-IN")} ledgers{via ? `, ${via}` : ""}</span>
        </div>
        {isOpen && (
          <ul className="tlist">
            {kids.map((c) => renderGroup(c, depth + 1, state))}
            {shownLedgers.slice(0, limit).map((l) => {
              const ls = ledgerState(l);
              return (
                <li key={`l-${l.name}`} className="trow ledger" style={{ paddingLeft: 6 + (depth + 1) * 20 }}>
                  <span className="chev" />
                  <label className="rowtick" title={ls === "none" ? "Count this ledger's group first" : ""}>
                    <input type="checkbox" checked={ls === "in"} disabled={ls === "none" || (ls === "out" && outSet.has(key(l.parent)))}
                      onChange={() => (ls === "in" ? leaveLedgers([l.name]) : countLedger(l.name))} />
                    <span className={ls === "out" ? "struck" : ""}>{l.name}</span>
                  </label>
                </li>
              );
            })}
            {shownLedgers.length > limit && (
              <li className="trow ledger" style={{ paddingLeft: 6 + (depth + 1) * 20 }}>
                <span className="chev" />
                <button className="lnk" onClick={() => setMore(new Set(more).add(k))}>Show all {shownLedgers.length.toLocaleString("en-IN")} ledgers in {group.name}</button>
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="set-body">
      <h2>Customers</h2>
      <p className="set-lead">Cash Discounts and Payment Follow-ups only read bills from ledgers counted as customers. Counting a group also counts every subgroup and ledger inside it.</p>
      {notice && <div className={`alert ${notice.tone}`}>{notice.text}</div>}

      <section className="set-block">
        <div className="matchnote">
          <b>{matched == null ? (loading ? "…" : "–") : matched.length.toLocaleString("en-IN")}</b>
          <span>{matched == null ? "ledgers once Tally has been read" : "ledgers are counted as customers"}</span>
        </div>
      </section>

      <section className="set-block">
        <h3>Groups and ledgers</h3>
        <p className="why">Ticked groups are counted as customers, with everything inside them. Open a group to see its subgroups and ledgers, and untick any you want to leave out.</p>
        <div className="tree">
          <input type="search" aria-label="Search groups and ledgers" placeholder="Search a group or a customer" value={search} onChange={(e) => setSearch(e.target.value)} />
          {found && (found.groupHits.length > 0 || found.ledgerHits.length > 0) && (
            <div className="selbar">
              <span>{found.groupHits.length} group{found.groupHits.length === 1 ? "" : "s"} and {found.ledgerHits.length.toLocaleString("en-IN")} counted ledger{found.ledgerHits.length === 1 ? "" : "s"} match</span>
              <span className="bulk">
                {found.groupHits.length > 0 && <button className="btn" onClick={() => setGroups_(found.groupHits, "count")}>Count the groups</button>}
                {found.groupHits.length > 0 && <button className="btn" onClick={() => setGroups_(found.groupHits, "leave")}>Leave the groups out</button>}
                {found.ledgerHits.length > 0 && <button className="btn primary" onClick={() => leaveLedgers(found.ledgerHits)}>Leave out {found.ledgerHits.length.toLocaleString("en-IN")} ledgers</button>}
              </span>
            </div>
          )}
          <ul className="tlist root">
            {rootKeys.map((k) => renderGroup(k, 0, "none"))}
            {loading && <li className="muted" style={{ fontSize: 12, padding: 8 }}>Reading groups from Tally…</li>}
            {!loading && found && found.show.size === 0 && <li className="muted" style={{ fontSize: 12, padding: 8 }}>Nothing matches “{search}”.</li>}
          </ul>
          {addable.length > 0 && !needle && (
            <label className="addgroup">
              <span>Another group holds customers?</span>
              <select value="" aria-label="Add another group" onChange={(e) => { if (e.target.value) { setScope((cur) => ({ ...cur, selectedGroupNames: [...cur.selectedGroupNames, e.target.value] })); setOpen((cur) => new Set(cur).add(key(e.target.value))); } }}>
                <option value="">Add a group from Tally…</option>
                {addable.map((g) => <option key={g.name} value={g.name}>{g.name}{g.path ? `  (in ${g.path})` : ""}</option>)}
              </select>
            </label>
          )}
        </div>
      </section>

      <section className="set-block">
        <label className="tick">
          <input type="checkbox" checked={scope.mode === "automatic"}
            onChange={(e) => setScope({ ...scope, mode: e.target.checked ? "automatic" : saved.mode === "strict" ? "strict" : "custom", detectSalesLinkedExceptions: e.target.checked })} />
          <span>Also add ledgers that Tally sales show are customers<small className="why" style={{ display: "block", margin: "2px 0 0" }}>These are found during a scan, so they are not in the count above.</small></span>
        </label>
      </section>

      <div className="stickybar" role="region" aria-label="Save changes">
        <span className="status">{dirty ? "You have changes that are not saved." : "All changes saved."}</span>
        <span style={{ flex: 1 }} />
        {dirty && <button className="btn lg" disabled={saving} onClick={() => { setScope(saved); setNotice(null); }}>Discard</button>}
        <button className="btn lg primary" disabled={saving || loading || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save customers"}</button>
      </div>
    </div>
  );
}

function CashDiscountRules() {
  const rows = [
    ["RTGS advance", "1.5%", "The narration says the customer paid by RTGS in advance."],
    ["RTGS same day", "1%", "The narration says the customer pays by RTGS on the invoice day."],
  ];
  return (
    <div className="set-body">
      <h2>Cash discount rules</h2>
      <p className="set-lead">These are fixed and follow Kalika’s logic. A debit note is created in Tally only when you press Create.</p>
      <section className="set-block">
        <table className="ratetable">
          <thead><tr><th>Payment type</th><th>Discount</th><th>When it applies</th></tr></thead>
          <tbody>{rows.map(([type, rate, when]) => <tr key={type}><td><b>{type}</b></td><td className="rate">{rate}</td><td>{when}</td></tr>)}</tbody>
        </table>
      </section>
      <section className="set-block">
        <p className="why" style={{ margin: 0 }}>Regular credit invoices (30 days) get no discount. Once overdue they appear under Payment Follow-ups.</p>
      </section>
    </div>
  );
}

export function CollectionsSettings({ initial = "customers" }: { initial?: Section }) {
  const [section, setSection] = useState<Section>(initial);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const connectorId = await resolveTallyConnectionId();
      const response = await apiFetch(`/api/tally/companies?connectionId=${encodeURIComponent(connectorId)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load companies.");
      setCompanies(payload.companies ?? []);
      setCompanyId(payload.selectedCompanyId || payload.companies?.[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load companies.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const company = companies.find((c) => c.id === companyId) ?? companies[0] ?? null;
  const sections: Array<[Section, string]> = [["customers", "Customers"], ["reminders", "Payment reminders"], ["rules", "Cash discount rules"]];

  return (
    <div className="fu">
      <div className="page">
        <header className="ph">
          <div className="ph-top">
            <div className="ph-title"><h1>Settings</h1></div>
            {section === "customers" && companies.length > 1 && (
              <div className="ph-actions">
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#6f655a" }}>
                  Company
                  <select className="cs" aria-label="Company" value={company?.id ?? ""} onChange={(e) => setCompanyId(e.target.value)}>
                    {companies.map((c) => <option key={c.id} value={c.id}>{c.companyName} · {c.financialYear}</option>)}
                  </select>
                </label>
              </div>
            )}
          </div>
        </header>
        {error && <div className="alert err">{error}</div>}
        <div className="set">
          <nav className="set-nav" aria-label="Settings sections">
            {sections.map(([k, label]) => <button key={k} aria-current={section === k ? "page" : undefined} onClick={() => setSection(k)}>{label}</button>)}
          </nav>
          <div>
            {section === "customers" && (company ? <CustomerScope key={company.id} company={company} /> : <p className="empty">Connect a Tally company to choose customers.</p>)}
            {section === "reminders" && <PaymentReminderSettings />}
            {section === "rules" && <CashDiscountRules />}
          </div>
        </div>
      </div>
    </div>
  );
}
