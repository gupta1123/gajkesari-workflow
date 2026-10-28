"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import type { ReminderMessage, ReminderStage } from "@/lib/followups-client";

type Plan = { id: string; name: string; stages: ReminderStage[] };

// Kalika's standard schedule, offered as the starting point for a new plan.
const STANDARD: ReminderStage[] = [
  { name: "First reminder", template: "", delay: 0, every: 1, unit: "days", limit: 1 },
  { name: "Regular follow-up", template: "", delay: 2, every: 2, unit: "days", limit: 3 },
  { name: "Final reminders", template: "", delay: 1, every: 1, unit: "days", limit: 3 },
];

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { error?: string }).error || "Request failed.");
  return payload as T;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function sentence(stage: ReminderStage, index: number) {
  const unit = stage.unit.replace(/s$/, "");
  const wait = stage.delay === 0
    ? index === 0 ? "Right away" : "Immediately after the previous stage"
    : `${plural(stage.delay, unit)} after ${index === 0 ? "the reminder starts" : "the previous stage"}`;
  if (stage.limit === 1) return `${wait}, one message.`;
  return `${wait}, then every ${plural(stage.every, unit)} until ${stage.limit} messages have gone out.`;
}

export function PaymentReminderSettings() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [messages, setMessages] = useState<ReminderMessage[]>([]);
  const [name, setName] = useState("Standard payment reminders");
  const [stages, setStages] = useState<ReminderStage[]>(STANDARD);
  const [editing, setEditing] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const fillTemplate = useCallback((rows: ReminderStage[], key: string) => rows.map((s) => (s.template ? s : { ...s, template: key })), []);

  const load = useCallback(async () => {
    const data = await call<{ plans: Plan[]; messages: ReminderMessage[] }>("/api/settings/payment-reminders", { cache: "no-store" });
    setPlans(data.plans);
    setMessages(data.messages);
    setStages((current) => fillTemplate(current, data.messages[0]?.key ?? ""));
  }, [fillTemplate]);

  useEffect(() => {
    load().catch((error) => setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not load the reminder plans." }));
  }, [load]);

  const patch = (index: number, change: Partial<ReminderStage>) =>
    setStages((rows) => rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  const edit = (plan: Plan) => { setEditing(plan.id); setName(plan.name); setStages(plan.stages); setNotice(null); };
  const startNew = () => { setEditing(""); setName("New reminder plan"); setStages(fillTemplate(STANDARD, messages[0]?.key ?? "")); setNotice(null); };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await call("/api/settings/payment-reminders", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, stages }),
      });
      setNotice({ tone: "ok", text: "Saved. Start reminders now offers this plan." });
      await load();
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
      startNew();
      await load();
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : "Could not delete the plan." });
    }
  };

  const total = stages.reduce((sum, s) => sum + s.limit, 0);

  return (
    <div className="set-body">
      <h2>Payment reminders</h2>
      <p className="set-lead">
        A plan is the schedule a reminder follows. Each stage waits, sends its messages, then hands over to the next one.
        Nothing is sent on its own: every message waits for your review and Send.
      </p>

      {notice && <div className={`alert ${notice.tone === "ok" ? "ok" : "err"}`}>{notice.text}</div>}
      {messages.length === 0 && <div className="alert warn">No WhatsApp message is registered yet, so reminders cannot be started.</div>}

      <section className="set-block">
        <h3>Plan</h3>
        <p className="why">Pick a saved plan to change it, or begin a new one from the standard schedule.</p>
        <div className="plans">
          {plans.map((plan) => <button key={plan.id} aria-pressed={editing === plan.id} onClick={() => edit(plan)}>{plan.name}</button>)}
          <button aria-pressed={editing === ""} onClick={startNew}>New plan</button>
        </div>
        <label className="f" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "#6f655a", maxWidth: 360, marginTop: 14 }}>
          Plan name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </label>
      </section>

      <section className="set-block">
        <h3>Stages</h3>
        <p className="why">{plural(stages.length, "stage")}, {plural(total, "message")} in total for each invoice.</p>
        <ol className="rail">
          {stages.map((stage, index) => (
            <li key={index}>
              <span className="pin">{index + 1}</span>
              <div className="stagebox">
                <div className="row">
                  <label style={{ flex: "1 1 160px" }}>Stage name
                    <input type="text" value={stage.name} onChange={(e) => patch(index, { name: e.target.value })} />
                  </label>
                  <label style={{ flex: "1 1 160px" }}>Message
                    <select value={stage.template} onChange={(e) => patch(index, { template: e.target.value })}>
                      <option value="">Choose a message</option>
                      {messages.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                    </select>
                  </label>
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  <label>Wait<input type="number" min={0} value={stage.delay} onChange={(e) => patch(index, { delay: Math.max(0, Number(e.target.value)) })} /></label>
                  <label>Repeat every<input type="number" min={1} value={stage.every} onChange={(e) => patch(index, { every: Math.max(1, Number(e.target.value)) })} /></label>
                  <label>Unit
                    <select value={stage.unit} onChange={(e) => patch(index, { unit: e.target.value as ReminderStage["unit"] })}>
                      <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
                    </select>
                  </label>
                  <label>Up to<input type="number" min={1} max={100} value={stage.limit} onChange={(e) => patch(index, { limit: Math.min(100, Math.max(1, Number(e.target.value))) })} /></label>
                  {stages.length > 1 && <button className="rm" onClick={() => setStages(stages.filter((_, i) => i !== index))}>Remove stage</button>}
                </div>
                <p className="sum">{sentence(stage, index)}</p>
              </div>
            </li>
          ))}
        </ol>
        <button className="btn" disabled={stages.length >= 8} onClick={() => setStages([...stages, { name: "Another reminder", template: messages[0]?.key ?? "", delay: 1, every: 1, unit: "days", limit: 1 }])}>Add a stage</button>
      </section>

      <div className="savebar">
        <button className="btn lg primary" disabled={saving || !name.trim() || stages.some((s) => !s.template || !s.name.trim())} onClick={() => void save()}>
          {saving ? "Saving…" : "Save plan"}
        </button>
        {editing && <button className="btn lg" onClick={() => void remove()}>Delete plan</button>}
        <span className="status">{stages.some((s) => !s.template) ? "Choose a message for every stage to save." : ""}</span>
      </div>
    </div>
  );
}
