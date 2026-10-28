"use client";

import { apiFetch } from "@/lib/api-client";

export type ReminderStage = {
  name: string;
  template: string;
  delay: number;
  every: number;
  unit: "minutes" | "hours" | "days";
  limit: number;
};

export type FollowupPipeline = {
  id: string;
  customer: string;
  invoice: string;
  invoice_date: string | null;
  recipient: string;
  company_name: string;
  plan_name: string;
  stages: ReminderStage[];
  stage_index: number;
  stage_sent: number;
  status: "active" | "paused" | "review" | "settled" | "finished" | "stopped" | "sending" | "uncertain";
  outstanding: number | null;
  next_due_at: string | null;
  verified_at: string | null;
  note: string | null;
  revision: number;
};

export type ReminderMessage = { key: string; name: string; text: string };
export type PipelineAction = "pause" | "resume" | "stop" | "check" | "send";

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { error?: string }).error || "Request failed.");
  return payload as T;
}

export async function listPipelines() {
  return readJson<{ pipelines: FollowupPipeline[]; messages: ReminderMessage[] }>(
    await apiFetch("/api/collections/follow-ups/pipelines", { cache: "no-store" })
  );
}

export async function createPipelines(input: {
  connectionId: string;
  companyName: string;
  financialYear: string;
  plan: { name: string; stages: ReminderStage[] };
  invoices: Array<{ customer: string; invoice: string; invoiceDate: string; recipient: string; narration?: string }>;
}) {
  return readJson<{ created: string[]; skipped: Array<{ invoice: string; reason: string }> }>(
    await apiFetch("/api/collections/follow-ups/pipelines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export type FollowupCandidate = {
  customer: string;
  invoice: string;
  invoiceDate: string | null;
  outstanding: number;
  narration: string;
  paymentCategory: "advance_rtgs" | "same_day_rtgs" | null;
  eligible: boolean;
  ageLabel: string;
};

type CompanyRef = { connectionId: string; companyName: string };

export async function getCustomerScope(company: CompanyRef) {
  const query = new URLSearchParams(company);
  return readJson<{ ledgerNames: string[] }>(await apiFetch(`/api/collections/customer-scope?${query}`, { cache: "no-store" }));
}

export async function saveCustomerScope(company: CompanyRef, ledgerNames: string[]) {
  return readJson<{ ledgerNames: string[] }>(
    await apiFetch("/api/collections/customer-scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...company, ledgerNames }),
    })
  );
}

export async function findCandidates(company: CompanyRef & { financialYear: string }, ledgerNames: string[]) {
  return readJson<{ today: string; candidates: FollowupCandidate[] }>(
    await apiFetch("/api/collections/follow-ups/live-candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...company, ledgerNames }),
    })
  );
}

export async function runPipelineAction(
  pipeline: Pick<FollowupPipeline, "id" | "revision">,
  action: PipelineAction,
  connectionId: string
) {
  return readJson<{ ok?: boolean; sent?: boolean; status?: string; note?: string | null; error?: string }>(
    await apiFetch(`/api/collections/follow-ups/pipelines/${pipeline.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, revision: pipeline.revision, connectionId }),
    })
  );
}
