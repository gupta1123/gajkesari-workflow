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

const DEFAULT_SCOPE: Scope = {
  mode: "automatic", selectedGroupNames: ["Sundry Debtors"], includeNestedGroups: true,
  detectSalesLinkedExceptions: true, excludedGroupNames: [], excludedLedgerNames: [],
};

const MODES: Array<{ value: Scope["mode"]; label: string; hint: string }> = [
  { value: "automatic", label: "Automatic", hint: "The chosen groups, plus ledgers that Tally sales show are customers. The count below is for the groups only, so a scan can add a few more." },
  { value: "custom", label: "Custom", hint: "The chosen groups only, minus anything you leave out." },
  { value: "strict", label: "Strict", hint: "Exactly the chosen groups. Nothing is added or guessed." },
];

const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((name) => b.includes(name));

function CustomerScope({ company }: { company: Company }) {
  const [saved, setSaved] = useState<{ scope: Scope; excluded: string }>({ scope: DEFAULT_SCOPE, excluded: "" });
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  const [excludedText, setExcludedText] = useState("");
  const [groups, setGroups] = useState<ScopeMaster[]>([]);
  const [ledgers, setLedgers] = useState<ScopeMaster[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [previewSearch, setPreviewSearch] = useState("");
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
        if (live) {
          const text = loaded.excludedLedgerNames.join("\n");
          setSaved({ scope: loaded, excluded: text });
          setScope(loaded);
          setExcludedText(text);
        }
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

  const excludedLedgerNames = useMemo(() => excludedText.split("\n").map((n) => n.trim()).filter(Boolean), [excludedText]);
  const effective = useMemo<Scope>(() => ({ ...scope, excludedLedgerNames }), [scope, excludedLedgerNames]);
  const dirty = !sameSet(scope.selectedGroupNames, saved.scope.selectedGroupNames) || !sameSet(scope.excludedGroupNames, saved.scope.excludedGroupNames)
    || scope.mode !== saved.scope.mode || scope.includeNestedGroups !== saved.scope.includeNestedGroups
    || !sameSet(excludedLedgerNames, saved.scope.excludedLedgerNames);

  // Groups that can hold customers: the chosen groups and everything inside them.
  const debtorGroups = useMemo(() => {
    const roots = new Set([...scope.selectedGroupNames, "Sundry Debtors"].map(key));
    const inside = new Set(roots);
    for (let changed = true; changed;) {
      changed = false;
      for (const group of groups) {
        if (!inside.has(key(group.name)) && group.parent && inside.has(key(group.parent))) { inside.add(key(group.name)); changed = true; }
      }
    }
    return inside;
  }, [groups, scope.selectedGroupNames]);

  const groupRows = useMemo(() => {
    const names = [...new Set([...groups.map((g) => g.name), ...scope.selectedGroupNames, ...scope.excludedGroupNames])];
    const needle = groupSearch.trim().toLowerCase();
    const rank = (name: string) => (scope.selectedGroupNames.includes(name) ? 0 : scope.excludedGroupNames.includes(name) ? 1 : 2);
    return names
      .filter((name) => (showAll || rank(name) < 2 || debtorGroups.has(key(name))) && (!needle || name.toLowerCase().includes(needle)))
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [groups, scope, showAll, debtorGroups, groupSearch]);
  const hiddenGroups = Math.max(0, groups.length - groupRows.length);

  const matched = useMemo(
    () => (ledgers.length ? resolveScopedLedgers({ groups, ledgers }, effective) : null),
    [groups, ledgers, effective]
  );
  const previewAll = useMemo(() => {
    const needle = previewSearch.trim().toLowerCase();
    return (matched ?? []).filter((l) => !needle || l.name.toLowerCase().includes(needle));
  }, [matched, previewSearch]);
  const previewRows = useMemo(() => previewAll.slice(0, 60), [previewAll]);

  const [pickedGroups, setPickedGroups] = useState<Set<string>>(new Set());
  const [pickedLedgers, setPickedLedgers] = useState<Set<string>>(new Set());
  const flip = (set: Set<string>, name: string) => { const next = new Set(set); if (!next.delete(name)) next.add(name); return next; };

  // One action for every ticked group, so a long list is not changed row by row.
  const bulkGroups = (choice: "count" | "leave" | "none") => {
    const names = [...pickedGroups];
    setScope((current) => {
      const counted = current.selectedGroupNames.filter((n) => !names.includes(n));
      const left = current.excludedGroupNames.filter((n) => !names.includes(n));
      return { ...current, selectedGroupNames: choice === "count" ? [...counted, ...names] : counted, excludedGroupNames: choice === "leave" ? [...left, ...names] : left };
    });
    setPickedGroups(new Set());
  };
  const leaveOutPicked = () => {
    const names = [...pickedLedgers];
    setExcludedText((text) => [...text.split("\n").map((n) => n.trim()).filter(Boolean), ...names].join("\n"));
    setPickedLedgers(new Set());
  };

  const setGroup = (name: string, choice: "none" | "count" | "leave") => setScope((current) => ({
    ...current,
    selectedGroupNames: choice === "count" ? [...new Set([...current.selectedGroupNames, name])] : current.selectedGroupNames.filter((n) => n !== name),
    excludedGroupNames: choice === "leave" ? [...new Set([...current.excludedGroupNames, name])] : current.excludedGroupNames.filter((n) => n !== name),
  }));

  const save = async () => {
    if (!scope.selectedGroupNames.length) return setNotice({ tone: "err", text: "Choose at least one group to count as customers." });
    setSaving(true);
    setNotice(null);
    try {
      const response = await apiFetch("/api/settings/cash-discount-customer-scope", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: company.connectionId, companyName: company.companyName, settings: effective }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not save.");
      setSaved({ scope: effective, excluded: excludedText });
      setNotice({ tone: "ok", text: "Saved. Cash Discounts and Payment Follow-ups use this on their next scan." });
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => { setScope(saved.scope); setExcludedText(saved.excluded); setNotice(null); };

  return (
    <div className="set-body">
      <h2>Customers</h2>
      <p className="set-lead">Cash Discounts and Payment Follow-ups only read bills from the ledgers counted as customers. Fix this if a customer is missing or a supplier shows up by mistake.</p>
      {notice && <div className={`alert ${notice.tone}`}>{notice.text}</div>}

      <section className="set-block">
        <div className="matchnote">
          <b>{matched == null ? (loading ? "…" : "–") : matched.length.toLocaleString("en-IN")}</b>
          <span>{matched == null ? "ledgers once Tally has been read" : "ledgers are counted as customers"}</span>
        </div>
      </section>

      <section className="set-block">
        <h3>Groups</h3>
        <p className="why">Count the groups where your customers live (usually Sundry Debtors). Leave out a group to remove its ledgers from the count.</p>
        <div className="chips" aria-label="Chosen groups">
          {scope.selectedGroupNames.map((name) => (
            <span className="chip" key={`c-${name}`}>{name}<button aria-label={`Stop counting ${name}`} onClick={() => setGroup(name, "none")}>×</button></span>
          ))}
          {scope.excludedGroupNames.map((name) => (
            <span className="chip out" key={`o-${name}`}>Leaving out {name}<button aria-label={`Stop leaving out ${name}`} onClick={() => setGroup(name, "none")}>×</button></span>
          ))}
          {!scope.selectedGroupNames.length && <span className="muted" style={{ fontSize: 12 }}>No group chosen yet.</span>}
        </div>
        <div className="grouplist">
          <input type="search" aria-label="Find a group" placeholder="Find a group" value={groupSearch} onChange={(e) => setGroupSearch(e.target.value)} />
          <div className="selbar">
            <label className="tick" style={{ margin: 0 }}>
              <input type="checkbox" aria-label="Tick all groups shown"
                checked={groupRows.length > 0 && groupRows.every((n) => pickedGroups.has(n))}
                onChange={(e) => setPickedGroups(e.target.checked ? new Set(groupRows) : new Set())} />
              {pickedGroups.size ? `${pickedGroups.size} ticked` : `Tick all ${groupRows.length} shown`}
            </label>
            {pickedGroups.size > 0 && (
              <span className="bulk">
                <button className="btn primary" onClick={() => bulkGroups("count")}>Count them</button>
                <button className="btn" onClick={() => bulkGroups("leave")}>Leave them out</button>
                <button className="btn" onClick={() => bulkGroups("none")}>Clear choice</button>
              </span>
            )}
          </div>
          <ul>
            {groupRows.map((name) => {
              const choice = scope.selectedGroupNames.includes(name) ? "count" : scope.excludedGroupNames.includes(name) ? "leave" : "none";
              return (
                <li key={name}>
                  <input type="checkbox" aria-label={`Tick ${name}`} checked={pickedGroups.has(name)} onChange={() => setPickedGroups(flip(pickedGroups, name))} />
                  <span className="gname">{name}</span>
                  <span className="seg" role="group" aria-label={name}>
                    <button aria-pressed={choice === "count"} onClick={() => setGroup(name, choice === "count" ? "none" : "count")}>Count</button>
                    <button aria-pressed={choice === "leave"} onClick={() => setGroup(name, choice === "leave" ? "none" : "leave")}>Leave out</button>
                  </span>
                </li>
              );
            })}
            {loading && <li className="muted" style={{ fontSize: 12 }}>Reading groups from Tally…</li>}
            {!loading && !groupRows.length && <li className="muted" style={{ fontSize: 12 }}>No group matches.</li>}
          </ul>
          <button className="lnk" style={{ margin: "8px 4px 4px" }} onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show only groups that can hold customers" : hiddenGroups > 0 ? `Show all ${groups.length} groups (${hiddenGroups} more, such as expenses)` : "Show all groups"}
          </button>
        </div>
        <label className="tick">
          <input type="checkbox" checked={scope.includeNestedGroups} onChange={(e) => setScope({ ...scope, includeNestedGroups: e.target.checked })} />
          Also include groups that sit inside the chosen ones
        </label>
      </section>

      <section className="set-block">
        <h3>How customers are found</h3>
        <div className="choice">
          {MODES.map((mode) => (
            <label key={mode.value}>
              <input type="radio" name="scope-mode" checked={scope.mode === mode.value}
                onChange={() => setScope({ ...scope, mode: mode.value, detectSalesLinkedExceptions: mode.value === "automatic" })} />
              <span><b>{mode.label}</b><small>{mode.hint}</small></span>
            </label>
          ))}
        </div>
      </section>

      <section className="set-block">
        <h3>Check who is included</h3>
        <p className="why">Search the ledgers that will be read. If someone is missing, count their group above. If someone should not be here, leave them out below.</p>
        <input type="search" aria-label="Search counted customers" placeholder="Search customer names" value={previewSearch} onChange={(e) => setPreviewSearch(e.target.value)}
          style={{ width: "100%", maxWidth: 360 }} />
        {previewAll.length > 0 && (
          <div className="selbar" style={{ marginTop: 10 }}>
            <label className="tick" style={{ margin: 0 }}>
              <input type="checkbox" aria-label="Tick all customers shown"
                checked={previewRows.length > 0 && previewRows.every((l) => pickedLedgers.has(l.name))}
                onChange={(e) => setPickedLedgers(e.target.checked ? new Set(previewRows.map((l) => l.name)) : new Set())} />
              {pickedLedgers.size ? `${pickedLedgers.size} ticked` : `Tick the ${previewRows.length} shown`}
            </label>
            {previewAll.length > previewRows.length && (
              <button className="lnk" style={{ margin: 0 }} onClick={() => setPickedLedgers(new Set(previewAll.map((l) => l.name)))}>
                Tick all {previewAll.length.toLocaleString("en-IN")} matching
              </button>
            )}
            {pickedLedgers.size > 0 && (
              <span className="bulk">
                <button className="btn primary" onClick={leaveOutPicked}>Leave out {pickedLedgers.size.toLocaleString("en-IN")}</button>
                <button className="btn" onClick={() => setPickedLedgers(new Set())}>Clear ticks</button>
              </span>
            )}
          </div>
        )}
        <ul className="preview">
          {previewRows.map((ledger) => (
            <li key={ledger.name}>
              <label className="rowtick">
                <input type="checkbox" aria-label={`Tick ${ledger.name}`} checked={pickedLedgers.has(ledger.name)} onChange={() => setPickedLedgers(flip(pickedLedgers, ledger.name))} />
                <span>{ledger.name}</span>
              </label>
              <span className="muted">{ledger.parent}</span>
            </li>
          ))}
          {matched && !previewRows.length && <li className="muted">No counted ledger matches “{previewSearch}”.</li>}
          {!matched && <li className="muted">Customers appear here once Tally has been read.</li>}
        </ul>
        {matched && matched.length > previewRows.length && !previewSearch && <p className="why" style={{ marginTop: 8 }}>Showing the first {previewRows.length}. Search to find a specific customer.</p>}
        <label className="f" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#51483f", marginTop: 16 }}>
          Ledgers left out, one per line
          <textarea value={excludedText} onChange={(e) => setExcludedText(e.target.value)} rows={3}
            style={{ width: "100%", border: "1px solid #ded8d0", borderRadius: 10, padding: 10, fontSize: 13, fontFamily: "inherit", background: "#fff" }} />
        </label>
      </section>

      <div className="stickybar" role="region" aria-label="Save changes">
        <span className="status">{dirty ? "You have changes that are not saved." : "All changes saved."}</span>
        <span style={{ flex: 1 }} />
        {dirty && <button className="btn lg" disabled={saving} onClick={discard}>Discard</button>}
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
