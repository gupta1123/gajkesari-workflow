"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import type { ReminderMessage, ReminderStage } from "@/lib/followups-client";

type Plan = { id: string; name: string; stages: ReminderStage[] };
type Draft = { name: string; stages: ReminderStage[] };

// Kalika's standard schedule, the starting point for a new plan.
const STANDARD: ReminderStage[] = [
  { name: "First reminder", template: "", delay: 0, every: 1, unit: "days", limit: 1 },
  { name: "Regular follow-up", template: "", delay: 2, every: 2, unit: "days", limit: 3 },
  { name: "Final reminders", template: "", delay: 1, every: 1, unit: "days", limit: 3 },
];
const STANDARD_NAME = "Standard payment reminders";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { error?: string }).error || "Request failed.");
  return payload as T;
}

const SAMPLE = { customer: "Shree Traders", company: "your company", invoice: "INV/26-27/0412", invoice_date: "12 Oct 2026", outstanding: "1,25,000.00" };
const fill = (text: string) => text.replace(/\{\{(customer|company|invoice|invoice_date|outstanding)\}\}/g, (_, k: keyof typeof SAMPLE) => SAMPLE[k]);
const total = (stages: ReminderStage[]) => stages.reduce((sum, s) => sum + s.limit, 0);

export function PaymentReminderSettings() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [messages, setMessages] = useState<ReminderMessage[]>([]);
  const [draft, setDraft] = useState<Draft>({ name: STANDARD_NAME, stages: STANDARD });
  const [snapshot, setSnapshot] = useState("");
  const [editing, setEditing] = useState("");
  const [removing, setRemoving] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const withMessage = useCallback((stages: ReminderStage[], key: string) => stages.map((s) => ({ ...s, template: s.template || key })), []);
  const snap = (d: Draft) => JSON.stringify([d.name.trim(), d.stages.map((s) => [s.name, s.template, s.delay, s.every, s.unit, s.limit])]);

  const load = useCallback(async () => {
    const data = await call<{ plans: Plan[]; messages: ReminderMessage[] }>("/api/settings/payment-reminders", { cache: "no-store" });
    setPlans(data.plans);
    setMessages(data.messages);
    return data;
  }, []);

  useEffect(() => {
    load().then((data) => {
      const first = data.plans[0];
      const next = first
        ? { name: first.name, stages: first.stages }
        : { name: STANDARD_NAME, stages: withMessage(STANDARD, data.messages[0]?.key ?? "") };
      setEditing(first?.id ?? "");
      setDraft(next);
      setSnapshot(first ? snap(next) : "");
    }).catch((error) => setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not load the reminder plans." }));
  }, [load, withMessage]);

  const messageKey = draft.stages[0]?.template || messages[0]?.key || "";
  const message = messages.find((m) => m.key === messageKey);
  const dirty = snap(draft) !== snapshot;
  const incomplete = !draft.name.trim() || !messageKey || draft.stages.some((s) => !s.name.trim());

  const patchStage = (index: number, change: Partial<ReminderStage>) =>
    setDraft((d) => ({ ...d, stages: d.stages.map((s, i) => (i === index ? { ...s, ...change } : s)) }));
  const setMessage = (key: string) => setDraft((d) => ({ ...d, stages: d.stages.map((s) => ({ ...s, template: key })) }));

  const open = (plan: Plan) => { setEditing(plan.id); const d = { name: plan.name, stages: plan.stages }; setDraft(d); setSnapshot(snap(d)); setNotice(null); setRemoving(null); };
  const startNew = () => { setEditing(""); setDraft({ name: "New reminder plan", stages: withMessage(STANDARD, messageKey) }); setSnapshot(""); setNotice(null); setRemoving(null); };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await call("/api/settings/payment-reminders", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name.trim(), stages: withMessage(draft.stages, messageKey) }),
      });
      const data = await load();
      const mine = data.plans.find((p) => p.name === draft.name.trim());
      if (mine) setEditing(mine.id);
      setSnapshot(snap(draft));
      setNotice({ tone: "ok", text: "Saved. Start reminders now offers this plan." });
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not save the plan." });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const plan = plans.find((p) => p.id === editing);
    if (!plan || !window.confirm(`Delete "${plan.name}"? Reminders that already started keep running.`)) return;
    try {
      await call(`/api/settings/payment-reminders?id=${encodeURIComponent(plan.id)}`, { method: "DELETE" });
      await load();
      startNew();
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not delete the plan." });
    }
  };

  const sampleText = useMemo(() => (message ? fill(message.text) : ""), [message]);

  return (
    <div className="set-body">

      {notice && <div className={`alert ${notice.tone === "ok" ? "ok" : "err"}`}>{notice.text}</div>}

      <section className="set-block">
        {plans.length > 0 && (
          <>
            <h3>Saved plans</h3>
            <div className="plans" style={{ marginBottom: 16 }}>
              {plans.map((plan) => <button key={plan.id} aria-pressed={editing === plan.id} onClick={() => open(plan)}>{plan.name}</button>)}
              <button aria-pressed={editing === ""} onClick={startNew}>Start a new plan</button>
            </div>
          </>
        )}
        <label className="f" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#51483f", maxWidth: 360 }}>
          Plan name
          <input type="text" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
      </section>

      <section className="set-block">
        <h3>Message</h3>
        {messages.length === 0 ? (
          <div className="alert warn" style={{ margin: 0 }}>No WhatsApp message is available yet. Ask your administrator to register one, then reload this page.</div>
        ) : (
          <div className="msgrow">
            <label className="f" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#51483f" }}>
              Message to send
              <select value={messageKey} onChange={(e) => setMessage(e.target.value)} style={{ minWidth: 240 }}>
                {messages.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
              </select>
            </label>
            <div className="wa mini" aria-label="Message preview">
              <div className="wa-body"><div className="wa-msg">{sampleText.split("\n").map((line, i) => <span key={i}>{line}<br /></span>)}</div></div>
            </div>
          </div>
        )}
      </section>

      <section className="set-block">
        <h3>Schedule</h3>
        <ol className="rail">
          {draft.stages.map((stage, index) => (
            <li key={index}>
              <span className="pin">{index + 1}</span>
              <div className="stagebox compact">
                <div className="stagehead">
                  <input type="text" aria-label={`Name of stage ${index + 1}`} value={stage.name} onChange={(e) => patchStage(index, { name: e.target.value })} />
                  {draft.stages.length > 1 && (removing === index ? (
                    <span className="confirm">Remove this stage?
                      <button onClick={() => { setDraft((d) => ({ ...d, stages: d.stages.filter((_, i) => i !== index) })); setRemoving(null); }}>Remove</button>
                      <button onClick={() => setRemoving(null)}>Keep</button>
                    </span>
                  ) : <button className="rm" onClick={() => setRemoving(index)}>Remove</button>)}
                </div>
                <p className="sentence">
                  {index === 0 && stage.delay === 0 ? "Start right away" : <>Wait <input type="number" min={0} aria-label="Wait" value={stage.delay} onChange={(e) => patchStage(index, { delay: Math.max(0, Number(e.target.value)) })} /></>}
                  {" "}
                  <select aria-label="Unit" value={stage.unit} onChange={(e) => patchStage(index, { unit: e.target.value as ReminderStage["unit"] })}>
                    <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
                  </select>
                  {index === 0 && stage.delay === 0 ? <button className="lnk" onClick={() => patchStage(index, { delay: 1 })}>add a wait</button> : null}
                  , then send <input type="number" min={1} max={100} aria-label="Messages" value={stage.limit} onChange={(e) => patchStage(index, { limit: Math.min(100, Math.max(1, Number(e.target.value))) })} /> message{stage.limit === 1 ? "" : "s"}
                  {stage.limit > 1 && <>, one every <input type="number" min={1} aria-label="Repeat every" value={stage.every} onChange={(e) => patchStage(index, { every: Math.max(1, Number(e.target.value)) })} /> {stage.unit}</>}.
                </p>
              </div>
            </li>
          ))}
        </ol>
        <button className="btn" disabled={draft.stages.length >= 8} onClick={() => setDraft((d) => ({ ...d, stages: [...d.stages, { name: "Another reminder", template: messageKey, delay: 1, every: 1, unit: "days", limit: 1 }] }))}>Add a stage</button>
      </section>

      <div className="stickybar" role="region" aria-label="Save changes">
        <span className="status">{incomplete && dirty ? "Give the plan a name, a message and a name for every stage." : dirty ? "You have changes that are not saved." : "All changes saved."}</span>
        <span style={{ flex: 1 }} />
        {editing && <button className="btn lg" onClick={() => void remove()}>Delete plan</button>}
        <button className="btn lg primary" disabled={saving || incomplete || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save plan"}</button>
      </div>
    </div>
  );
}
