export type TallyBridgeCommandType =
  | "alter_ledger"
  | "create_ledger"
  | "fetch_bank_ledgers"
  | "sync_masters"
  | "post_bank_voucher"
  | "fetch_customer_open_bills"
  | "create_debit_note"
  | "export_debit_note_pdf"
  | "verify_bank_transaction";

export type TallyBridgeCommandStatus =
  | "queued"
  | "claimed"
  | "succeeded"
  | "failed"
  | "canceled";

export type TallyBridgeCommandRow = {
  id: string;
  connection_id: string;
  owner_user_id: string;
  command_type: TallyBridgeCommandType;
  status: TallyBridgeCommandStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  available_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  bridge_version: string | null;
  created_at: string;
  updated_at: string;
};

export const TALLY_BRIDGE_COMMAND_TYPES: TallyBridgeCommandType[] = [
  "alter_ledger",
  "create_ledger",
  "fetch_bank_ledgers",
  "sync_masters",
  "post_bank_voucher",
  "fetch_customer_open_bills",
  "create_debit_note",
  "export_debit_note_pdf",
  "verify_bank_transaction",
];

export function serializeTallyBridgeCommand(row: TallyBridgeCommandRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    commandType: row.command_type,
    status: row.status,
    priority: row.priority,
    payload: row.payload,
    result: row.result,
    error: row.error,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    bridgeVersion: row.bridge_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
