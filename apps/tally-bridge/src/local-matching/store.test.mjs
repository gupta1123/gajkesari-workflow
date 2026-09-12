import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLocalDb, saveLocalDb, getLocalDbPaths, upsertLedgers, getStatusForCompany, normalizeCompanyKey } from "./store.mjs";

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gajkesari-local-matching-test-"));
}
function clean(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

test("persistence survives restart (save and reload)", () => {
  const base = tmpBase();
  const db = loadLocalDb({ baseDir: base });
  const ledgers = [{ name: "Customer A", guid: "g1", parent: "Sundry Debtors" }];
  const { counts } = upsertLedgers({ db, companyName: "TestCo", companyGuid: "guid-test", ledgers });
  assert.equal(counts.added, 1);
  saveLocalDb(db, { baseDir: base });
  const reloaded = loadLocalDb({ baseDir: base });
  const status = getStatusForCompany(reloaded, { companyName: "TestCo", companyGuid: "guid-test" });
  assert.equal(status.ledgerCount, 1);
  assert.equal(status.exists, true);
  // ensure file not in install dir / app.asar
  const paths = getLocalDbPaths({ baseDir: base });
  assert.ok(!paths.dbPath.includes("app.asar"));
  assert.ok(!paths.dbPath.includes("payload-clean"));
  assert.ok(paths.dbPath.includes("local-matching"));
  clean(base);
});

test("idempotent repeated sync (no duplicates)", () => {
  const base = tmpBase();
  const db = loadLocalDb({ baseDir: base });
  const ledgers = [
    { name: "Ledger One", guid: "l1", parent: "Sundry Debtors" },
    { name: "Ledger Two", guid: "l2", parent: "Sundry Creditors" },
  ];
  const first = upsertLedgers({ db, companyName: "Co1", companyGuid: "g1", ledgers });
  assert.deepEqual(first.counts, { added: 2, updated: 0, unchanged: 0, deleted: 0, inactive: 0, error: 0, total: 2, active: 2 });
  saveLocalDb(db, { baseDir: base });
  const second = upsertLedgers({ db, companyName: "Co1", companyGuid: "g1", ledgers });
  assert.deepEqual(second.counts, { added: 0, updated: 0, unchanged: 2, deleted: 0, inactive: 0, error: 0, total: 2, active: 2 });
  // ensure no duplicate keys
  const entry = db.companies[normalizeCompanyKey({ companyGuid: "g1", companyName: "Co1" })];
  assert.equal(Object.keys(entry.ledgers).length, 2);
  clean(base);
});

test("new and altered records are detected", () => {
  const base = tmpBase();
  const db = loadLocalDb({ baseDir: base });
  upsertLedgers({ db, companyName: "Co2", companyGuid: "g2", ledgers: [{ name: "A", guid: "a1", parent: "P1" }] });
  saveLocalDb(db, { baseDir: base });
  // alter A parent, add B
  const res = upsertLedgers({ db, companyName: "Co2", companyGuid: "g2", ledgers: [
    { name: "A", guid: "a1", parent: "P2" },
    { name: "B", guid: "b1", parent: "P1" },
  ]});
  assert.equal(res.counts.added, 1);
  assert.equal(res.counts.updated, 1);
  assert.equal(res.counts.unchanged, 0);
  const entry = db.companies[normalizeCompanyKey({ companyGuid: "g2", companyName: "Co2" })];
  assert.equal(entry.ledgers[Object.keys(entry.ledgers).find((k)=> entry.ledgers[k].tally_name==="A")].parent_name, "P2");
  clean(base);
});

test("missing/deleted records are marked inactive", () => {
  const base = tmpBase();
  const db = loadLocalDb({ baseDir: base });
  upsertLedgers({ db, companyName: "Co3", companyGuid: "g3", ledgers: [
    { name: "Keep", guid: "k1", parent: "P" },
    { name: "DeleteMe", guid: "d1", parent: "P" },
  ]});
  const res = upsertLedgers({ db, companyName: "Co3", companyGuid: "g3", ledgers: [
    { name: "Keep", guid: "k1", parent: "P" },
  ]});
  assert.equal(res.counts.deleted, 1);
  assert.equal(res.counts.active, 1);
  const entry = db.companies[normalizeCompanyKey({ companyGuid: "g3", companyName: "Co3" })];
  const deleted = Object.values(entry.ledgers).find((l)=> l.tally_name==="DeleteMe");
  assert.equal(deleted.is_active, false);
  clean(base);
});

test("stable company identity prevents duplicate company records", () => {
  const base = tmpBase();
  const db = loadLocalDb({ baseDir: base });
  upsertLedgers({ db, companyName: "My Company", companyGuid: "GUID-123", ledgers: [{ name: "L1", guid: "g1" }] });
  upsertLedgers({ db, companyName: "my company", companyGuid: "guid-123", ledgers: [{ name: "L1", guid: "g1" }, { name: "L2", guid: "g2" }] });
  // same guid case-insensitive should be same company
  assert.equal(Object.keys(db.companies).length, 1);
  const status = getStatusForCompany(db, { companyName: "My Company", companyGuid: "GUID-123" });
  assert.equal(status.ledgerCount, 2);
  clean(base);
});

test("persist sync cursor AlterID and safe fallback", () => {
  const base = tmpBase();
  const db = loadLocalDb({ baseDir: base });
  const res = upsertLedgers({ db, companyName: "Co4", companyGuid: "g4", ledgers: [
    { name: "L1", guid: "g1", alterID: "100", masterID: "10" },
    { name: "L2", guid: "g2", alterID: "105", masterID: "11" },
  ], cursor: { lastAlterID: "105" } });
  assert.equal(res.entry.syncCursor.lastAlterID, "105");
  assert.equal(res.entry.lastSyncAt != null, true);
  saveLocalDb(db, { baseDir: base });
  const reloaded = loadLocalDb({ baseDir: base });
  const entry = reloaded.companies[normalizeCompanyKey({ companyGuid: "g4", companyName: "Co4" })];
  assert.equal(entry.syncCursor.lastAlterID, "105");
  clean(base);
});

test("database stored under stable user-data, never install dir", () => {
  const { dbPath, dir } = getLocalDbPaths({});
  assert.ok(!dbPath.includes("C:\\Gajkesari\\tally-bridge"));
  assert.ok(!dbPath.includes("payload-clean"));
  assert.ok(!dbPath.includes("app.asar"));
  assert.ok(dir.includes("local-matching"));
});

test("versioned migrations and backup-safe write", () => {
  const base = tmpBase();
  const db = loadLocalDb({ baseDir: base });
  const { dbPath, backupPath } = getLocalDbPaths({ baseDir: base });
  upsertLedgers({ db, companyName: "Co5", companyGuid: "g5", ledgers: [{ name: "L1", guid: "g1" }] });
  saveLocalDb(db, { baseDir: base });
  assert.ok(fs.existsSync(dbPath));
  const firstContent = fs.readFileSync(dbPath, "utf8");
  // second save should create backup
  upsertLedgers({ db, companyName: "Co5", companyGuid: "g5", ledgers: [{ name: "L2", guid: "g2" }] });
  saveLocalDb(db, { baseDir: base });
  assert.ok(fs.existsSync(backupPath));
  const backup = fs.readFileSync(backupPath, "utf8");
  assert.equal(backup, firstContent);
  // migrations: ensure version present
  const loaded = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  assert.equal(loaded.version, 1);
  clean(base);
});
