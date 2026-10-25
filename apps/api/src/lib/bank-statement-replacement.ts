import type { SupabaseClient } from "@supabase/supabase-js";
import { queueTallyCommandAndWake } from "./tally/queue-command.ts";

type Command = { id?: string; status?: string; payload: Record<string, unknown>; result?: Record<string, unknown> | null };
type Prior = { fingerprint: string; status: string; command_id: string | null };
type Posting = { payload: Record<string, unknown> };
const identityFields = ["transactionId", "fingerprint", "voucherDate", "amount", "bankLedgerName", "counterpartyLedgerName", "expectedDirection", "referenceNumber", "bankReferenceNumber"] as const;
export class ReplacementCheckError extends Error {}

export function replacementIdentity(payload: Record<string, unknown>) {
  return Object.fromEntries(identityFields.map(key => [key, payload[key] ?? null]));
}

export function assertReplacementMissing(command: Command, expected: Record<string, unknown>[]) {
  if (command.status !== "succeeded") throw new ReplacementCheckError("We could not check the previously posted payments. Keep Tally and the connector open, then recheck. Nothing was posted.");
  const rows = command.result?.transactions;
  if (!Array.isArray(rows) || rows.length !== expected.length ||
    new Set(rows.map(row => row?.transactionId)).size !== expected.length) {
    throw new ReplacementCheckError("Tally returned an incomplete check. Recheck Tally before posting. Nothing was posted.");
  }
  for (const transaction of expected) {
    const row = rows.find(value => value?.transactionId === transaction.transactionId);
    if (!row || row.verificationStatus !== "missing" || row.duplicateInTally === true ||
      Number(row.matchCount ?? 0) !== 0 || (Array.isArray(row.matches) && row.matches.length > 0)) {
      throw new ReplacementCheckError("A previously posted payment is present or needs review in Tally. Recheck Tally before posting. Nothing was posted.");
    }
  }
}

// A saved success is not permission to post again. Read Tally after this Post
// action, then let the database validate the same evidence under its lock.
export async function verifyBankReplacements(input: {
  db: SupabaseClient; owner: string; dataset: string; connection: string;
  target: Record<string, unknown>; commands: Posting[]; prior: Prior[];
  wait?: (ms: number) => Promise<void>;
}) {
  const prior = new Map(input.prior.filter(row => row.status === "verified").map(row => [row.fingerprint, row]));
  const replacements = input.commands.filter(command => prior.has(String(command.payload.fingerprint)));
  if (!replacements.length) return;
  const ids = replacements.map(command => prior.get(String(command.payload.fingerprint))?.command_id).filter((id): id is string => Boolean(id));
  if (ids.length !== replacements.length) throw new ReplacementCheckError("The earlier posting record needs review. Nothing was posted.");
  const { data: originals, error } = await input.db.from("tally_bridge_commands")
    .select("id,status,payload").in("id", ids).eq("owner_user_id", input.owner)
    .eq("company_dataset_id", input.dataset).eq("command_type", "post_bank_voucher");
  if (error) throw error;
  const byId = new Map((originals ?? []).map(command => [command.id, command]));
  const previousCommands: Record<string, string> = {};
  const expected = replacements.map(command => {
    const oldId = prior.get(String(command.payload.fingerprint))!.command_id!;
    const original = byId.get(oldId);
    if (!original || original.status !== "succeeded" ||
      JSON.stringify(replacementIdentity(original.payload)) !== JSON.stringify(replacementIdentity(command.payload))) {
      throw new ReplacementCheckError("This payment's earlier posting has different details or needs review. Check the original Tally voucher before posting. Nothing was posted.");
    }
    previousCommands[String(command.payload.transactionId)] = oldId;
    return replacementIdentity(command.payload);
  });
  const queued = await queueTallyCommandAndWake<{ id: string }>({
    supabase: input.db, ownerUserId: input.owner, companyDatasetId: input.dataset,
    connectionId: input.connection, commandType: "verify_bank_transaction", priority: 5,
    payload: { target: input.target, companyName: input.target.companyName,
      bankLedgerName: replacements[0].payload.bankLedgerName, includeBalanceProof: false,
      replacementVerification: true, previousPostingCommands: previousCommands, transactions: expected },
  });
  const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 60; attempt++) {
    const { data: check, error: readError } = await input.db.from("tally_bridge_commands")
      .select("id,status,payload,result").eq("id", queued.command.id).eq("owner_user_id", input.owner)
      .eq("company_dataset_id", input.dataset).eq("connection_id", input.connection).single();
    if (readError) throw readError;
    if (check && !["queued", "claimed"].includes(check.status)) {
      assertReplacementMissing(check, expected);
      for (const command of replacements) {
        command.payload.replacementVerificationCommandId = check.id;
        command.payload.replacesPostingCommandId = previousCommands[String(command.payload.transactionId)];
      }
      return;
    }
    await wait(500);
  }
  throw new ReplacementCheckError("Tally is still checking the previously posted payments. Nothing was posted. Keep the connector open and try again after the check finishes.");
}
