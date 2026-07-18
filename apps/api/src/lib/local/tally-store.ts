import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createBridgeToken,
  createPairingCode,
  createPairingExpiry,
  hashSecret,
  type TallyConnectionRow,
  type TallyConnectionStatus,
} from "@/lib/tally/connections";
import type {
  TallyBridgeCommandRow,
  TallyBridgeCommandType,
} from "@/lib/tally/commands";
import { LOCAL_USER_ID } from "./mode";

type LocalConnectionRow = TallyConnectionRow & {
  bridge_token_hash: string | null;
};

type LocalState = {
  connections: LocalConnectionRow[];
  commands: TallyBridgeCommandRow[];
  events: Record<string, unknown>[];
};

const STORE_PATH = path.join(process.cwd(), ".local-data", "tally-store.json");

const CONNECTION_FIELDS = [
  "id",
  "owner_user_id",
  "display_name",
  "status",
  "tally_url",
  "pairing_code_hash",
  "pairing_code_expires_at",
  "paired_at",
  "bridge_name",
  "bridge_version",
  "bridge_machine_id",
  "last_heartbeat_at",
  "last_tested_at",
  "last_tally_reachable",
  "last_company_loaded",
  "last_company_name",
  "last_error",
  "created_at",
  "updated_at",
] as const;

async function readState(): Promise<LocalState> {
  try {
    return JSON.parse(await readFile(STORE_PATH, "utf8")) as LocalState;
  } catch {
    return { connections: [], commands: [], events: [] };
  }
}

async function writeState(state: LocalState) {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function publicConnection(row: LocalConnectionRow): TallyConnectionRow {
  return Object.fromEntries(CONNECTION_FIELDS.map((field) => [field, row[field]])) as TallyConnectionRow;
}

function nowIso() {
  return new Date().toISOString();
}

export async function listLocalTallyConnections(ownerUserId = LOCAL_USER_ID) {
  const state = await readState();
  return state.connections
    .filter((connection) => connection.owner_user_id === ownerUserId)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .map(publicConnection);
}

export async function createLocalTallyConnection(input: {
  displayName: string;
  tallyUrl: string;
  ownerUserId?: string;
}) {
  const state = await readState();
  const createdAt = nowIso();
  const pairingCode = createPairingCode();
  const row: LocalConnectionRow = {
    id: randomUUID(),
    owner_user_id: input.ownerUserId ?? LOCAL_USER_ID,
    display_name: input.displayName,
    status: "waiting_for_bridge",
    tally_url: input.tallyUrl,
    pairing_code_hash: hashSecret(pairingCode),
    pairing_code_expires_at: createPairingExpiry(),
    paired_at: null,
    bridge_token_hash: null,
    bridge_name: null,
    bridge_version: null,
    bridge_machine_id: null,
    last_heartbeat_at: null,
    last_tested_at: null,
    last_tally_reachable: null,
    last_company_loaded: null,
    last_company_name: null,
    last_error: null,
    created_at: createdAt,
    updated_at: createdAt,
  };

  state.connections.unshift(row);
  await writeState(state);
  return { connection: publicConnection(row), pairingCode };
}

export async function getLocalTallyConnection(connectionId: string, ownerUserId = LOCAL_USER_ID) {
  const state = await readState();
  const row = state.connections.find(
    (connection) => connection.id === connectionId && connection.owner_user_id === ownerUserId
  );
  return row ? publicConnection(row) : null;
}

export async function pairLocalTallyConnection(input: {
  connectionId: string;
  pairingCode: string;
  bridgeName: string;
  bridgeVersion: string;
  bridgeMachineId: string;
}) {
  const state = await readState();
  const row = state.connections.find((connection) => connection.id === input.connectionId);
  if (!row) return { error: "Tally connection not found.", status: 404 as const };
  if (!row.pairing_code_hash || !row.pairing_code_expires_at) {
    return { error: "This connection does not have an active pairing code.", status: 409 as const };
  }
  if (new Date(row.pairing_code_expires_at).getTime() <= Date.now()) {
    row.pairing_code_hash = null;
    row.pairing_code_expires_at = null;
    row.status = "waiting_for_bridge";
    row.last_error = "Pairing code expired.";
    row.updated_at = nowIso();
    await writeState(state);
    return { error: "Pairing code expired.", status: 410 as const };
  }
  if (hashSecret(input.pairingCode) !== row.pairing_code_hash) {
    return { error: "Invalid pairing code.", status: 401 as const };
  }

  const bridgeToken = createBridgeToken();
  const now = nowIso();
  row.status = "bridge_connected";
  row.pairing_code_hash = null;
  row.pairing_code_expires_at = null;
  row.paired_at = now;
  row.bridge_token_hash = hashSecret(bridgeToken);
  row.bridge_name = input.bridgeName;
  row.bridge_version = input.bridgeVersion;
  row.bridge_machine_id = input.bridgeMachineId;
  row.last_heartbeat_at = now;
  row.last_error = null;
  row.updated_at = now;
  await writeState(state);

  return { connection: publicConnection(row), bridgeToken };
}

export async function getLocalConnectionForBridge(connectionId: string, token: string) {
  const state = await readState();
  const row = state.connections.find((connection) => connection.id === connectionId);
  if (!row?.bridge_token_hash || hashSecret(token) !== row.bridge_token_hash) {
    return null;
  }
  return row;
}

export async function updateLocalTallyHeartbeat(input: {
  connectionId: string;
  token: string;
  status: TallyConnectionStatus;
  tallyUrl?: string | null;
  bridgeVersion?: string | null;
  tallyReachable: boolean;
  companyLoaded: boolean;
  companyName?: string | null;
  error?: string | null;
}) {
  const state = await readState();
  const row = state.connections.find((connection) => connection.id === input.connectionId);
  if (!row?.bridge_token_hash || hashSecret(input.token) !== row.bridge_token_hash) {
    return null;
  }

  const now = nowIso();
  row.status = input.status;
  row.tally_url = input.tallyUrl || row.tally_url;
  row.bridge_version = input.bridgeVersion || row.bridge_version;
  row.last_heartbeat_at = now;
  row.last_tested_at = now;
  row.last_tally_reachable = input.tallyReachable;
  row.last_company_loaded = input.companyLoaded;
  row.last_company_name = input.companyName || null;
  row.last_error = input.error || null;
  row.updated_at = now;
  await writeState(state);
  return publicConnection(row);
}

export async function disconnectLocalTallyConnection(connectionId: string, ownerUserId = LOCAL_USER_ID) {
  const state = await readState();
  const row = state.connections.find(
    (connection) => connection.id === connectionId && connection.owner_user_id === ownerUserId
  );
  if (!row) return null;

  row.status = "waiting_for_bridge";
  row.pairing_code_hash = null;
  row.pairing_code_expires_at = null;
  row.bridge_token_hash = null;
  row.paired_at = null;
  row.bridge_name = null;
  row.bridge_version = null;
  row.bridge_machine_id = null;
  row.last_heartbeat_at = null;
  row.last_tested_at = null;
  row.last_tally_reachable = null;
  row.last_company_loaded = null;
  row.last_company_name = null;
  row.last_error = "Disconnected by user.";
  row.updated_at = nowIso();
  await writeState(state);
  return publicConnection(row);
}

export async function createLocalTallyCommand(input: {
  connectionId: string;
  ownerUserId?: string;
  commandType: TallyBridgeCommandType;
  payload: Record<string, unknown>;
  priority?: number;
}) {
  const state = await readState();
  const now = nowIso();
  const command: TallyBridgeCommandRow = {
    id: randomUUID(),
    connection_id: input.connectionId,
    owner_user_id: input.ownerUserId ?? LOCAL_USER_ID,
    command_type: input.commandType,
    status: "queued",
    priority: input.priority ?? 10,
    payload: input.payload,
    result: null,
    error: null,
    attempts: 0,
    max_attempts: 3,
    available_at: now,
    claimed_at: null,
    completed_at: null,
    bridge_version: null,
    created_at: now,
    updated_at: now,
  };
  state.commands.unshift(command);
  await writeState(state);
  return command;
}

export async function listLocalTallyCommands(input: {
  connectionId: string;
  ownerUserId?: string;
  ids?: string[];
  limit?: number;
}) {
  const state = await readState();
  const ids = new Set(input.ids ?? []);
  return state.commands
    .filter((command) => command.connection_id === input.connectionId)
    .filter((command) => command.owner_user_id === (input.ownerUserId ?? LOCAL_USER_ID))
    .filter((command) => ids.size === 0 || ids.has(command.id))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, input.limit ?? 20);
}

export async function claimNextLocalTallyCommand(input: {
  connectionId: string;
  token: string;
  bridgeVersion?: string | null;
}) {
  const state = await readState();
  const row = state.connections.find((connection) => connection.id === input.connectionId);
  if (!row?.bridge_token_hash || hashSecret(input.token) !== row.bridge_token_hash) {
    return { unauthorized: true, command: null };
  }

  const now = nowIso();
  const command = state.commands
    .filter((entry) => entry.connection_id === input.connectionId)
    .filter((entry) => entry.status === "queued")
    .filter((entry) => entry.available_at <= now)
    .sort((left, right) => right.priority - left.priority || left.created_at.localeCompare(right.created_at))[0];

  if (!command) return { command: null };

  command.status = "claimed";
  command.claimed_at = now;
  command.attempts += 1;
  command.bridge_version = input.bridgeVersion ?? null;
  command.updated_at = now;
  await writeState(state);
  return { command };
}

export async function completeLocalTallyCommand(input: {
  connectionId: string;
  token: string;
  commandId: string;
  success: boolean;
  result: Record<string, unknown>;
  error: string | null;
}) {
  const state = await readState();
  const row = state.connections.find((connection) => connection.id === input.connectionId);
  if (!row?.bridge_token_hash || hashSecret(input.token) !== row.bridge_token_hash) {
    return { unauthorized: true, command: null };
  }

  const command = state.commands.find(
    (entry) => entry.id === input.commandId && entry.connection_id === input.connectionId
  );
  if (!command) return { command: null };

  command.status = input.success ? "succeeded" : "failed";
  command.result = input.result;
  command.error = input.error;
  command.completed_at = nowIso();
  command.updated_at = command.completed_at;
  await writeState(state);
  return { command };
}
