// Storage behind the Cash Discount evidence cache.
//
// The refresh rules live in company-evidence-cache.mjs. This file only decides
// where the vouchers are kept: a SQLite file per company (changed vouchers are
// updated in place), or the older single JSON file when SQLite is unavailable.
// Both give the bridge the same small interface:
//   store.meta                        counters and coverage, or null when empty
//   store.reset({ companyName, companyGuid })   discard everything, return fresh meta
//   store.put(entries)                add or replace vouchers
//   store.dropMissing(keys, range)    delete vouchers in range that Tally no longer lists
//   store.window(from, to)            voucher XML dated inside the range (undated included)
//   store.count()
//   store.commit()                    persist meta (call once a scan has finished)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  EVIDENCE_CACHE_SCHEMA, dropVouchersMissingFrom, emptyEvidenceCache, evidenceCachePath,
  loadEvidenceCache, saveEvidenceCache, storeVouchers,
} from "./company-evidence-cache.mjs";

const require = createRequire(import.meta.url);

// GAJKESARI_SQLITE_PATH points at a better-sqlite3 build for this runtime when the
// package next to the bridge was built for a different one (a dev connector that
// shares the repo's node_modules, for example). Each candidate must actually open.
export function loadSqliteDriver() {
  for (const candidate of [process.env.GAJKESARI_SQLITE_PATH, "better-sqlite3"]) {
    if (!candidate) continue;
    try {
      const Database = require(candidate);
      new Database(":memory:").close();
      return Database;
    } catch { /* try the next one */ }
  }
  return null;
}

export function evidenceDbPath(dir, companyName) {
  const id = createHash("sha1").update(String(companyName ?? "").trim().toLowerCase()).digest("hex").slice(0, 16);
  return path.join(dir, "evidence-cache", `${id}.db`);
}

const META_FIELDS = ["companyName", "companyGuid", "altVchId", "altMstId", "coveredFrom", "coveredTo", "lastReconciledAt"];

function openJsonStore({ dir, companyName }) {
  const file = evidenceCachePath(dir, companyName);
  let cache = loadEvidenceCache(file);
  return {
    backend: "json",
    get meta() { return cache; },
    reset(fresh) { cache = emptyEvidenceCache(fresh); return cache; },
    put(entries) { storeVouchers(cache, entries); },
    dropMissing(keys, range) { return dropVouchersMissingFrom(cache, keys, range); },
    window(from, to) {
      return Object.values(cache.vouchers).filter((v) => !v.date || (v.date >= from && v.date <= to)).map((v) => v.xml);
    },
    count() { return Object.keys(cache.vouchers).length; },
    commit() { saveEvidenceCache(file, cache); },
    close() {},
  };
}

function createSchema(db) {
  db.exec(`
    create table if not exists meta (key text primary key, value text);
    create table if not exists vouchers (key text primary key, alter_id integer not null, date text, xml text not null);
    create index if not exists vouchers_date on vouchers (date);
  `);
}

function readMeta(db) {
  const rows = db.prepare("select key, value from meta").all();
  if (!rows.length) return null;
  const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (Number(meta.schema) !== EVIDENCE_CACHE_SCHEMA) return null;
  return {
    schema: EVIDENCE_CACHE_SCHEMA,
    companyName: meta.companyName ?? null,
    companyGuid: meta.companyGuid || null,
    altVchId: Number(meta.altVchId || 0),
    altMstId: Number(meta.altMstId || 0),
    coveredFrom: meta.coveredFrom || null,
    coveredTo: meta.coveredTo || null,
    lastReconciledAt: Number(meta.lastReconciledAt || 0),
  };
}

function openDatabase(Database, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    createSchema(db);
    readMeta(db);
    return db;
  } catch (error) {
    // Unreadable or damaged: the cache can always be rebuilt from Tally.
    try { db.close(); } catch { /* ignore */ }
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
    const fresh = new Database(file);
    fresh.pragma("journal_mode = WAL");
    fresh.pragma("synchronous = NORMAL");
    createSchema(fresh);
    return fresh;
  }
}

function openSqliteStore({ dir, companyName }, Database) {
  const file = evidenceDbPath(dir, companyName);
  const db = openDatabase(Database, file);
  let meta = readMeta(db);

  const upsert = db.prepare("insert into vouchers (key, alter_id, date, xml) values (?, ?, ?, ?) on conflict(key) do update set alter_id = excluded.alter_id, date = excluded.date, xml = excluded.xml");
  const writeMeta = db.prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value");

  const persistMeta = () => {
    db.transaction(() => {
      writeMeta.run("schema", String(EVIDENCE_CACHE_SCHEMA));
      for (const field of META_FIELDS) writeMeta.run(field, meta[field] == null ? "" : String(meta[field]));
    })();
  };

  // A cache written by the JSON backend is imported once, so a machine that
  // already scanned does not have to read Tally again.
  if (!meta) {
    const legacyFile = evidenceCachePath(dir, companyName);
    const legacy = loadEvidenceCache(legacyFile);
    if (legacy) {
      db.transaction(() => {
        for (const [key, voucher] of Object.entries(legacy.vouchers)) upsert.run(key, voucher.alterId ?? 0, voucher.date ?? "", voucher.xml);
      })();
      meta = { ...legacy };
      delete meta.vouchers;
      persistMeta();
      try { fs.renameSync(legacyFile, `${legacyFile}.imported`); } catch { /* keep the old file */ }
    }
  }

  return {
    backend: "sqlite",
    get meta() { return meta; },
    reset(fresh) {
      db.transaction(() => { db.exec("delete from vouchers; delete from meta;"); })();
      const { vouchers, ...empty } = emptyEvidenceCache(fresh);
      meta = empty;
      return meta;
    },
    put(entries) {
      db.transaction(() => { for (const e of entries) upsert.run(e.key, e.alterId ?? 0, e.date ?? "", e.xml); })();
    },
    dropMissing(keys, { from, to }) {
      const inRange = db.prepare("select key from vouchers where date >= ? and date <= ?").all(from, to);
      const gone = inRange.filter((row) => !keys.has(row.key));
      const remove = db.prepare("delete from vouchers where key = ?");
      db.transaction(() => { for (const row of gone) remove.run(row.key); })();
      return gone.length;
    },
    window(from, to) {
      return db.prepare("select xml from vouchers where date = '' or date is null or (date >= ? and date <= ?)").all(from, to).map((row) => row.xml);
    },
    count() { return db.prepare("select count(*) as n from vouchers").get().n; },
    commit() {
      if (!meta) return;
      persistMeta();
      // Fold the write-ahead log back into the database so the file does not keep growing.
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* a reader holds it; try next time */ }
    },
    close() { try { db.close(); } catch { /* ignore */ } },
  };
}

const openStores = new Map();

/**
 * Opens (once per file) the evidence store for a company. SQLite is used when
 * the driver loads and the database opens; otherwise the JSON file is used.
 * Set GAJKESARI_EVIDENCE_BACKEND=json to force the older storage.
 */
export function getEvidenceStore({ dir, companyName, backend = process.env.GAJKESARI_EVIDENCE_BACKEND || "auto" }) {
  const wantsSqlite = backend !== "json";
  const mapKey = `${wantsSqlite ? "sqlite" : "json"}:${evidenceCachePath(dir, companyName)}`;
  const existing = openStores.get(mapKey);
  if (existing) return existing;
  let store = null;
  if (wantsSqlite) {
    const Database = loadSqliteDriver();
    if (Database) {
      try { store = openSqliteStore({ dir, companyName }, Database); } catch { store = null; }
    }
  }
  store ??= openJsonStore({ dir, companyName });
  openStores.set(mapKey, store);
  return store;
}

export function closeEvidenceStores() {
  for (const store of openStores.values()) store.close();
  openStores.clear();
}
