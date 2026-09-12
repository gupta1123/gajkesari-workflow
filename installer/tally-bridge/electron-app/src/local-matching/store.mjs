#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCAL_DB_VERSION = 1;
export const LOCAL_DB_SCHEMA_VERSION = 1;

const CONFIG_DIR = path.join(os.homedir(), ".gajkesari-tally-bridge");

function defaultBaseDir({ appUserDataPath } = {}) {
  if (appUserDataPath && typeof appUserDataPath === "string" && appUserDataPath.trim()) {
    return path.join(appUserDataPath.trim(), "local-matching");
  }
  if (process.env.GAJKESARI_LOCAL_MATCHING_DIR) {
    return path.resolve(process.env.GAJKESARI_LOCAL_MATCHING_DIR);
  }
  // Stable user-data: Electron userData OR homedir config
  // Do NOT use installDir / app.asar / temp
  return path.join(CONFIG_DIR, "local-matching");
}

export function getLocalDbPaths({ appUserDataPath, baseDir } = {}) {
  const dir = baseDir ? path.resolve(baseDir) : defaultBaseDir({ appUserDataPath });
  return {
    dir,
    dbPath: path.join(dir, "db.json"),
    backupPath: path.join(dir, "db.json.bak"),
    lockPath: path.join(dir, ".lock"),
    vectorDir: path.join(dir, "vectors"),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeAtomic(filePath, data, backupPath) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    if (fs.existsSync(filePath) && backupPath) {
      try { fs.copyFileSync(filePath, backupPath); } catch {}
    }
    fs.renameSync(tmpPath, filePath);
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true }); } catch {}
  }
}

export function normalizeCompanyKey({ companyGuid, companyName }) {
  const guid = String(companyGuid || "").trim().toLowerCase();
  if (guid) return `guid:${guid}`;
  const name = String(companyName || "").trim().toLowerCase().replace(/\s+/g, " ");
  return `name:${name || "unknown"}`;
}

export function normalizeMasterKey({ name, guid }) {
  const source = guid ? String(guid).trim() : String(name).trim();
  return `ledger:${source.toLowerCase().replace(/\s+/g, " ")}`;
}

function migrateDb(raw) {
  if (!raw || typeof raw !== "object") {
    return { version: LOCAL_DB_VERSION, schemaVersion: LOCAL_DB_SCHEMA_VERSION, companies: {}, meta: { createdAt: new Date().toISOString() } };
  }
  // v1 initial — ensure fields
  if (!raw.version) raw.version = LOCAL_DB_VERSION;
  if (!raw.schemaVersion) raw.schemaVersion = LOCAL_DB_SCHEMA_VERSION;
  if (!raw.companies || typeof raw.companies !== "object") raw.companies = {};
  if (!raw.meta) raw.meta = { createdAt: new Date().toISOString() };
  // Ensure companies structure
  for (const [k, v] of Object.entries(raw.companies)) {
    if (!v.ledgers || typeof v.ledgers !== "object") v.ledgers = {};
    if (!v.syncHistory) v.syncHistory = {};
    if (!v.vector) v.vector = { status: "idle", lastVectorisedAt: null, vectorCount: 0, engine: "fts", error: null };
  }
  return raw;
}

export function loadLocalDb({ appUserDataPath, baseDir } = {}) {
  const { dbPath } = getLocalDbPaths({ appUserDataPath, baseDir });
  const raw = readJsonSafe(dbPath, null);
  if (!raw) {
    return { version: LOCAL_DB_VERSION, schemaVersion: LOCAL_DB_SCHEMA_VERSION, companies: {}, meta: { createdAt: new Date().toISOString() } };
  }
  const migrated = migrateDb(raw);
  // If migration changed version, persist lazily on next save
  return migrated;
}

export function saveLocalDb(db, { appUserDataPath, baseDir } = {}) {
  const { dbPath, backupPath } = getLocalDbPaths({ appUserDataPath, baseDir });
  const toSave = { ...db, version: LOCAL_DB_VERSION, schemaVersion: LOCAL_DB_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
  writeAtomic(dbPath, toSave, backupPath);
  return toSave;
}

export function getCompanyEntry(db, companyKey) {
  return db.companies[companyKey] || null;
}

export function upsertLedgers({ db, companyName, companyGuid, ledgers, cursor }) {
  const companyKey = normalizeCompanyKey({ companyGuid, companyName });
  const now = new Date().toISOString();
  let entry = db.companies[companyKey];
  if (!entry) {
    entry = {
      companyName: String(companyName || "").trim(),
      companyGuid: companyGuid ? String(companyGuid).trim() : null,
      createdAt: now,
      lastSyncAt: null,
      ledgerCount: 0,
      syncCursor: cursor || null,
      ledgers: {},
      syncHistory: { lastCounts: null, lastError: null },
      vector: { status: "idle", lastVectorisedAt: null, vectorCount: 0, engine: "fts", error: null, incremental: true },
    };
    db.companies[companyKey] = entry;
  } else {
    // update identity if changed (guid/name evolution)
    entry.companyName = String(companyName || entry.companyName).trim();
    if (companyGuid) entry.companyGuid = String(companyGuid).trim();
  }

  const incomingKeys = new Set();
  let added = 0, updated = 0, unchanged = 0;
  const seenAlterIds = [];

  for (const ledger of ledgers) {
    const name = String(ledger.name || "").trim();
    if (!name) continue;
    const guid = ledger.guid ? String(ledger.guid).trim() : null;
    const parent = ledger.parent ? String(ledger.parent).trim() : null;
    const masterKey = normalizeMasterKey({ name, guid });
    incomingKeys.add(masterKey);
    const alterID = ledger.alterID ? String(ledger.alterID).trim() : null;
    const masterID = ledger.masterID ? String(ledger.masterID).trim() : null;
    if (alterID) seenAlterIds.push(alterID);
    const existing = entry.ledgers[masterKey];
    const payload = {
      tally_name: name,
      tally_guid: guid,
      parent_name: parent,
      master_key: masterKey,
      alterID,
      masterID,
      is_active: true,
      lastSeen: now,
      raw_payload: ledger.raw || {},
    };
    if (!existing) {
      entry.ledgers[masterKey] = payload;
      added += 1;
    } else {
      const isSame = existing.tally_name === payload.tally_name
        && (existing.tally_guid || "") === (payload.tally_guid || "")
        && (existing.parent_name || "") === (payload.parent_name || "")
        && (existing.alterID || "") === (payload.alterID || "")
        && (existing.masterID || "") === (payload.masterID || "");
      if (!isSame) {
        entry.ledgers[masterKey] = { ...existing, ...payload, updatedAt: now };
        updated += 1;
      } else {
        // preserve but refresh lastSeen and keep active
        existing.lastSeen = now;
        existing.is_active = true;
        unchanged += 1;
      }
    }
  }

  let deleted = 0;
  for (const [key, ledger] of Object.entries(entry.ledgers)) {
    if (!incomingKeys.has(key) && ledger.is_active) {
      ledger.is_active = false;
      ledger.deletedAt = now;
      deleted += 1;
    }
  }

  // cursor persistence: keep max alterID if available, with full fallback
  let syncCursor = entry.syncCursor || {};
  if (cursor && typeof cursor === "object") {
    syncCursor = { ...syncCursor, ...cursor, updatedAt: now };
  }
  if (seenAlterIds.length) {
    const maxAlter = seenAlterIds.map((v) => Number(v)).filter(Number.isFinite).sort((a,b)=>b-a)[0];
    if (Number.isFinite(maxAlter)) syncCursor.lastAlterID = String(maxAlter);
  }
  entry.syncCursor = syncCursor;
  entry.lastSyncAt = now;
  entry.ledgerCount = Object.values(entry.ledgers).filter((l) => l.is_active).length;
  const total = Object.keys(entry.ledgers).length;
  const counts = { added, updated, unchanged, deleted, inactive: deleted, error: 0, total, active: entry.ledgerCount };
  entry.syncHistory.lastCounts = counts;
  entry.syncHistory.lastSyncAt = now;
  entry.syncHistory.lastError = null;

  return { companyKey, counts, entry };
}

export function markSyncError({ db, companyName, companyGuid, error }) {
  const companyKey = normalizeCompanyKey({ companyGuid, companyName });
  const entry = db.companies[companyKey] || { companyName, companyGuid, ledgers: {}, syncHistory: {} };
  if (!db.companies[companyKey]) db.companies[companyKey] = entry;
  entry.syncHistory.lastError = String(error || "Sync failed").slice(0, 2000);
  entry.syncHistory.lastCounts = { added: 0, updated: 0, unchanged: 0, deleted: 0, inactive: 0, error: 1, total: 0, active: 0, errorMessage: entry.syncHistory.lastError };
  return entry;
}

export function getStatusForCompany(db, { companyName, companyGuid }) {
  const key = normalizeCompanyKey({ companyGuid, companyName });
  const entry = db.companies[key];
  if (!entry) {
    return {
      exists: false,
      companyKey: key,
      companyName: companyName || null,
      companyGuid: companyGuid || null,
      ledgerCount: 0,
      lastSyncAt: null,
      syncCounts: null,
      vector: { status: "idle", lastVectorisedAt: null, vectorCount: 0, engine: "fts" },
      dbPath: getLocalDbPaths({}).dbPath,
    };
  }
  return {
    exists: true,
    companyKey: key,
    companyName: entry.companyName,
    companyGuid: entry.companyGuid,
    ledgerCount: entry.ledgerCount,
    lastSyncAt: entry.lastSyncAt,
    syncCounts: entry.syncHistory.lastCounts,
    syncCursor: entry.syncCursor,
    vector: entry.vector || { status: "idle", lastVectorisedAt: null, vectorCount: 0, engine: "fts" },
    dbPath: getLocalDbPaths({}).dbPath,
  };
}

export function getAllCompaniesStatus(db) {
  return Object.entries(db.companies).map(([key, entry]) => ({
    companyKey: key,
    companyName: entry.companyName,
    companyGuid: entry.companyGuid,
    ledgerCount: entry.ledgerCount,
    lastSyncAt: entry.lastSyncAt,
  }));
}

export function ensureDbIntegrity(db) {
  // backup-safe: called on load, ensures structure
  return migrateDb(db);
}
