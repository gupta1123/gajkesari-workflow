"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import type { ReminderMessage, ReminderStage } from "@/lib/followups-client";

type Plan = { id: string; name: string; stages: ReminderStage[] };

const blankStage = (template = ""): ReminderStage => ({ name: "Reminder", template, delay: 1, every: 3, unit: "days", limit: 3 });

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { error?: string }).error || "Request failed.");
  return payload as T;
}

export function PaymentReminderSettings() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [messages, setMessages] = useState<ReminderMessage[]>([]);
  const [name, setName] = useState("");
  const [stages, setStages] = useState<ReminderStage[]>([blankStage()]);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const data = await call<{ plans: Plan[]; messages: ReminderMessage[] }>("/api/settings/payment-reminders", { cache: "no-store" });
    setPlans(data.plans);
    setMessages(data.messages);
    setStages((current) => current.map((s) => (s.template ? s : { ...s, template: data.messages[0]?.key ?? "" })));
  }, []);

  useEffect(() => {
    load().catch((error) => setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load settings." }));
  }, [load]);

  const patch = (index: number, change: Partial<ReminderStage>) =>
    setStages((rows) => rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await call("/api/settings/payment-reminders", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, stages }),
      });
      setNotice({ tone: "ok", text: "Plan saved." });
      await load();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save the plan." });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (plan: Plan) => {
    if (!window.confirm(`Delete the plan "${plan.name}"? Reminders already created are not affected.`)) return;
    try {
      await call(`/api/settings/payment-reminders?id=${encodeURIComponent(plan.id)}`, { method: "DELETE" });
      await load();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not delete the plan." });
    }
  };

  const field = "rounded-md border border-slate-300 px-2 py-1.5 text-sm";

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Payment reminder plans</h1>
        <p className="text-sm text-slate-600">
          A plan is a list of stages. Each stage waits, then sends up to a limit of reminders at a fixed interval. Reminders are sent only when you press Send.
        </p>
      </header>

      {notice && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${notice.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>{notice.text}</p>
      )}
      {messages.length === 0 && <p className="text-sm text-amber-700">No WhatsApp reminder template is configured yet.</p>}

      <section className="space-y-3 rounded-lg border border-slate-200 p-4">
        <input className={`${field} w-full`} placeholder="Plan name" value={name} onChange={(e) => setName(e.target.value)} />
        {stages.map((stage, index) => (
          <div key={index} className="grid gap-2 md:grid-cols-6">
            <input className={field} placeholder="Stage name" value={stage.name} onChange={(e) => patch(index, { name: e.target.value })} />
            <select className={field} value={stage.template} onChange={(e) => patch(index, { template: e.target.value })}>
              <option value="">Message…</option>
              {messages.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
            </select>
            <label className="text-sm">Wait <input className={`${field} w-14`} type="number" min={0} value={stage.delay} onChange={(e) => patch(index, { delay: Number(e.target.value) })} /></label>
            <label className="text-sm">Every <input className={`${field} w-14`} type="number" min={1} value={stage.every} onChange={(e) => patch(index, { every: Number(e.target.value) })} /></label>
            <select className={field} value={stage.unit} onChange={(e) => patch(index, { unit: e.target.value as ReminderStage["unit"] })}>
              <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
            </select>
            <label className="text-sm">Up to <input className={`${field} w-14`} type="number" min={1} max={100} value={stage.limit} onChange={(e) => patch(index, { limit: Number(e.target.value) })} /></label>
          </div>
        ))}
        <div className="flex gap-3">
          <button className="text-sm underline disabled:opacity-50" disabled={stages.length >= 8} onClick={() => setStages([...stages, blankStage(messages[0]?.key)])}>Add stage</button>
          {stages.length > 1 && <button className="text-sm text-red-700 underline" onClick={() => setStages(stages.slice(0, -1))}>Remove last stage</button>}
          <button className="ml-auto rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={saving || !name.trim()} onClick={save}>
            {saving ? "Saving…" : "Save plan"}
          </button>
        </div>
      </section>

      <section className="space-y-2">
        {plans.length === 0 && <p className="text-sm text-slate-500">No saved plans yet.</p>}
        {plans.map((plan) => (
          <div key={plan.id} className="flex items-center justify-between rounded-md border border-slate-200 p-3 text-sm">
            <div>
              <div className="font-medium">{plan.name}</div>
              <div className="text-xs text-slate-500">{plan.stages.map((s) => `${s.name} ×${s.limit}`).join(" → ")}</div>
            </div>
            <div className="space-x-3">
              <button className="underline" onClick={() => { setName(plan.name); setStages(plan.stages); }}>Edit</button>
              <button className="text-red-700 underline" onClick={() => remove(plan)}>Delete</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
