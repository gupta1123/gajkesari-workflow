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
  { value: "automatic", label: "Automatic", hint: "Customers under the selected groups, plus ledgers that Tally sales show are customers." },
  { value: "custom", label: "Custom", hint: "Only the groups you select, with your exclusions." },
  { value: "strict", label: "Strict", hint: "Only the selected groups. No exceptions are detected." },
];

const toggleName = (list: string[], name: string) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);

function CustomerScope({ company }: { company: Company }) {
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  const [groups, setGroups] = useState<ScopeMaster[]>([]);
  const [ledgers, setLedgers] = useState<ScopeMaster[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [excludedText, setExcludedText] = useState("");
  const [includeSearch, setIncludeSearch] = useState("");
  const [excludeSearch, setExcludeSearch] = useState("");
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
        const saved = response.status === 409 ? DEFAULT_SCOPE : { ...DEFAULT_SCOPE, ...((await response.json()).settings ?? {}) };
        if (!response.ok && response.status !== 409) throw new Error("Could not load the customer scope.");
        if (live) { setScope(saved); setExcludedText(saved.excludedLedgerNames.join("\n")); }
      } catch (error) {
        if (live) setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not load the customer scope." });
      }
      try {
        const masters = await runCashDiscountLiveRequest<{ ledgers?: ScopeMaster[]; groups?: ScopeMaster[] }>({
          connectionId: company.connectionId, companyName: company.companyName, financialYear: company.financialYear,
          operation: "ledger_masters", payload: { requestedMasterTypes: ["ledger", "group"] },
        });
        if (live) { setGroups(masters.groups ?? []); setLedgers(masters.ledgers ?? []); }
      } catch (error) {
        if (live) setNotice({ tone: "warn", text: `Groups could not be read from Tally (${error instanceof Error ? error.message : "unknown error"}). You can still edit the saved lists.` });
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [query, company]);

  const groupNames = useMemo(() => [...new Set([...groups.map((g) => g.name), ...scope.selectedGroupNames, ...scope.excludedGroupNames])].sort((a, b) => a.localeCompare(b)), [groups, scope]);
  const excludedLedgerNames = useMemo(() => excludedText.split("\n").map((n) => n.trim()).filter(Boolean), [excludedText]);
  const matched = useMemo(
    () => (ledgers.length ? resolveScopedLedgers({ groups, ledgers }, { ...scope, excludedLedgerNames }).length : null),
    [groups, ledgers, scope, excludedLedgerNames]
  );

  const save = async () => {
    if (!scope.selectedGroupNames.length) return setNotice({ tone: "err", text: "Select at least one customer group." });
    setSaving(true);
    setNotice(null);
    try {
      const response = await apiFetch("/api/settings/cash-discount-customer-scope", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: company.connectionId, companyName: company.companyName, settings: { ...scope, excludedLedgerNames } }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not save.");
      setNotice({ tone: "ok", text: "Saved. The next scan of Cash Discounts and Payment Follow-ups uses this scope." });
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  };

  const pick = (list: string[], field: "selectedGroupNames" | "excludedGroupNames", search: string) => (
    <div className="picker-list">
      {list.filter((n) => n.toLowerCase().includes(search.toLowerCase())).map((name) => (
        <label key={name}>
          <input type="checkbox" checked={scope[field].includes(name)} onChange={() => setScope({ ...scope, [field]: toggleName(scope[field], name) })} />
          {name}
        </label>
      ))}
      {loading && <span className="muted" style={{ fontSize: 12, padding: 8, display: "block" }}>Reading groups from Tally…</span>}
    </div>
  );

  return (
    <div className="set-body">
      <h2>Customers</h2>
      <p className="set-lead">Cash Discounts and Payment Follow-ups only look at bills from the ledgers you count as customers. Change this if a customer is missing, or a supplier shows up by mistake.</p>
      {notice && <div className={`alert ${notice.tone}`}>{notice.text}</div>}

      <section className="set-block">
        <div className="matchnote"><b>{matched == null ? "…" : matched.toLocaleString("en-IN")}</b><span>ledgers are counted as customers with the current choices.</span></div>
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
        <h3>Groups</h3>
        <p className="why">Tick the Tally groups whose ledgers are customers, and any groups to leave out.</p>
        <div className="picker">
          <div className="picker-col">
            <header>Count as customers <span>{scope.selectedGroupNames.length} chosen</span></header>
            <input type="search" placeholder="Find a group" value={includeSearch} onChange={(e) => setIncludeSearch(e.target.value)} />
            {pick(groupNames, "selectedGroupNames", includeSearch)}
          </div>
          <div className="picker-col">
            <header>Leave out <span>{scope.excludedGroupNames.length} chosen</span></header>
            <input type="search" placeholder="Find a group" value={excludeSearch} onChange={(e) => setExcludeSearch(e.target.value)} />
            {pick(groupNames, "excludedGroupNames", excludeSearch)}
          </div>
        </div>
        <label style={{ display: "flex", gap: 8, fontSize: 13, marginTop: 14, cursor: "pointer" }}>
          <input type="checkbox" checked={scope.includeNestedGroups} onChange={(e) => setScope({ ...scope, includeNestedGroups: e.target.checked })} />
          Include groups that sit inside the chosen ones
        </label>
      </section>

      <section className="set-block">
        <h3>Individual ledgers to leave out</h3>
        <p className="why">One ledger name per line, exactly as it appears in Tally.</p>
        <textarea value={excludedText} onChange={(e) => setExcludedText(e.target.value)} rows={4}
          style={{ width: "100%", border: "1px solid #ded8d0", borderRadius: 10, padding: 10, fontSize: 13, fontFamily: "inherit", background: "#fff" }} />
      </section>

      <div className="savebar">
        <button className="btn lg primary" disabled={saving || loading} onClick={() => void save()}>{saving ? "Saving…" : "Save customers"}</button>
        <span className="status">The next scan uses what you save.</span>
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
            <div className="ph-actions">
              {companies.length > 1 && (
                <select className="cs" aria-label="Company" value={company?.id ?? ""} onChange={(e) => setCompanyId(e.target.value)}>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.companyName} · {c.financialYear}</option>)}
                </select>
              )}
            </div>
          </div>
        </header>
        {error && <div className="alert err">{error}</div>}
        <div className="set">
          <nav className="set-nav" aria-label="Settings sections">
            {sections.map(([key, label]) => <button key={key} aria-current={section === key ? "page" : undefined} onClick={() => setSection(key)}>{label}</button>)}
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
