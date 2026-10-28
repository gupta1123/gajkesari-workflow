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
type Section = "customers" | "reminders" | "rules";

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

  return (
    <div className="enroll" style={{ maxWidth: 820 }}>
      <div className="eh">
        <small>Cash Discounts and Payment Follow-ups</small>
        <h3>Which ledgers are customers</h3>
        <p>Both pages read open bills only for these customers. {matched != null && <b>{matched.toLocaleString("en-IN")} ledgers match right now.</b>}</p>
      </div>
      <div className="eb">
        {notice && <div className={`alert ${notice.tone}`} style={{ margin: 0 }}>{notice.text}</div>}
        <div>
          <b style={{ fontSize: 12 }}>How to decide</b>
          {MODES.map((mode) => (
            <label key={mode.value} style={{ display: "flex", gap: 8, margin: "8px 0", fontSize: 12, cursor: "pointer" }}>
              <input type="radio" name="scope-mode" checked={scope.mode === mode.value}
                onChange={() => setScope({ ...scope, mode: mode.value, detectSalesLinkedExceptions: mode.value === "automatic" })} />
              <span><b>{mode.label}</b><span className="csub">{mode.hint}</span></span>
            </label>
          ))}
        </div>
        <div>
          <b style={{ fontSize: 12 }}>Customer groups</b>
          <div style={{ border: "1px solid #e8e2db", borderRadius: 8, maxHeight: 200, overflowY: "auto", padding: 8, marginTop: 8 }}>
            {loading && <span className="muted" style={{ fontSize: 12 }}>Reading groups from Tally…</span>}
            {groupNames.map((name) => (
              <label key={name} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0", cursor: "pointer" }}>
                <input type="checkbox" checked={scope.selectedGroupNames.includes(name)} onChange={() => setScope({ ...scope, selectedGroupNames: toggleName(scope.selectedGroupNames, name) })} />
                {name}
              </label>
            ))}
          </div>
          <label style={{ display: "flex", gap: 8, fontSize: 12, marginTop: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={scope.includeNestedGroups} onChange={(e) => setScope({ ...scope, includeNestedGroups: e.target.checked })} />
            Include groups nested under the selected ones
          </label>
        </div>
        <div>
          <b style={{ fontSize: 12 }}>Leave out these groups</b>
          <div style={{ border: "1px solid #e8e2db", borderRadius: 8, maxHeight: 140, overflowY: "auto", padding: 8, marginTop: 8 }}>
            {groupNames.map((name) => (
              <label key={name} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0", cursor: "pointer" }}>
                <input type="checkbox" checked={scope.excludedGroupNames.includes(name)} onChange={() => setScope({ ...scope, excludedGroupNames: toggleName(scope.excludedGroupNames, name) })} />
                {name}
              </label>
            ))}
          </div>
        </div>
        <label className="f" style={{ maxWidth: "none" }}>
          <span>Leave out these ledgers (one name per line)</span>
          <textarea value={excludedText} onChange={(e) => setExcludedText(e.target.value)} rows={4}
            style={{ border: "1px solid #ded8d0", borderRadius: 8, padding: 10, fontSize: 12, fontFamily: "inherit" }} />
        </label>
      </div>
      <div className="ef">
        <button className="btn lg primary" disabled={saving || loading} onClick={() => void save()}>{saving ? "Saving…" : "Save customer scope"}</button>
      </div>
    </div>
  );
}

function CashDiscountRules() {
  const rows = [
    ["RTGS advance", "1.5%", "Narration says the customer paid by RTGS in advance."],
    ["RTGS same day", "1%", "Narration says the customer pays by RTGS on the invoice day."],
  ];
  return (
    <div className="enroll" style={{ maxWidth: 820 }}>
      <div className="eh"><small>Cash Discounts</small><h3>Discount rules</h3>
        <p>These follow Kalika’s logic and are fixed in the system. A debit note is only created when you press Create.</p></div>
      <div className="eb">
        <table className="grid" style={{ minWidth: 0 }}>
          <thead><tr><th>Payment type</th><th style={{ width: 90 }}>Discount</th><th>When it applies</th></tr></thead>
          <tbody>{rows.map(([type, rate, when]) => <tr key={type}><td><b>{type}</b></td><td className="num">{rate}</td><td>{when}</td></tr>)}</tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Regular credit invoices (30 days) have no discount; they appear under Payment Follow-ups once overdue.</p>
      </div>
    </div>
  );
}

export function CollectionsSettings() {
  const [section, setSection] = useState<Section>("customers");
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
  const tabs: Array<[Section, string]> = [["customers", "Customers"], ["reminders", "Payment reminders"], ["rules", "Cash discount rules"]];

  return (
    <div className="fu">
      <div className="page">
        <header className="ph">
          <div className="ph-top">
            <div className="ph-title"><h1>Settings</h1><span className="ph-dot">·</span><span className="ph-sub">Cash Discounts and Payment Follow-ups</span></div>
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
        <div className="tabbar" style={{ marginBottom: 16 }}>
          <div className="tabs">
            {tabs.map(([key, label]) => <button key={key} className={`tab${section === key ? " active" : ""}`} onClick={() => setSection(key)}>{label}</button>)}
          </div>
        </div>
        {section === "customers" && (company ? <CustomerScope key={company.id} company={company} /> : <p className="empty">Connect a Tally company to edit the customer scope.</p>)}
        {section === "reminders" && <PaymentReminderSettings />}
        {section === "rules" && <CashDiscountRules />}
      </div>
    </div>
  );
}
