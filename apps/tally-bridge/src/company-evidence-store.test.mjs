import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyEvidenceCache, evidenceCachePath, saveEvidenceCache, storeVouchers } from "./company-evidence-cache.mjs";
import { closeEvidenceStores, evidenceDbPath, getEvidenceStore, loadSqliteDriver } from "./company-evidence-store.mjs";

const sqliteAvailable = Boolean(loadSqliteDriver());
const backends = sqliteAvailable ? ["json", "sqlite"] : ["json"];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evidence-store-"));
}

const entry = (key, date, alterId = 1) => ({ key, alterId, date, xml: `<VOUCHER>${key}</VOUCHER>` });

for (const backend of backends) {
  test(`${backend}: starts empty, then keeps vouchers and counters across a reopen`, () => {
    const dir = tempDir();
    const store = getEvidenceStore({ dir, companyName: "Acme", backend });
    assert.equal(store.backend, backend);
    assert.equal(store.meta, null);
    const meta = store.reset({ companyName: "Acme", companyGuid: "g1" });
    store.put([entry("1", "2026-04-02"), entry("2", "2026-05-10"), entry("3", "")]);
    Object.assign(meta, { altVchId: 42, altMstId: 7, coveredFrom: "2026-04-01", coveredTo: "2026-06-30", lastReconciledAt: 123 });
    store.commit();
    closeEvidenceStores();

    const reopened = getEvidenceStore({ dir, companyName: "Acme", backend });
    assert.equal(reopened.count(), 3);
    assert.deepEqual(
      [reopened.meta.altVchId, reopened.meta.altMstId, reopened.meta.coveredFrom, reopened.meta.coveredTo, reopened.meta.companyGuid, reopened.meta.lastReconciledAt],
      [42, 7, "2026-04-01", "2026-06-30", "g1", 123]
    );
    closeEvidenceStores();
  });

  test(`${backend}: put replaces a changed voucher in place`, () => {
    const store = getEvidenceStore({ dir: tempDir(), companyName: "Acme", backend });
    store.reset({ companyName: "Acme" });
    store.put([entry("1", "2026-04-02", 1)]);
    store.put([{ key: "1", alterId: 9, date: "2026-04-02", xml: "<VOUCHER>edited</VOUCHER>" }]);
    assert.equal(store.count(), 1);
    assert.deepEqual(store.window("2026-04-01", "2026-04-30"), ["<VOUCHER>edited</VOUCHER>"]);
    closeEvidenceStores();
  });

  test(`${backend}: window keeps undated vouchers and filters the rest by date`, () => {
    const store = getEvidenceStore({ dir: tempDir(), companyName: "Acme", backend });
    store.reset({ companyName: "Acme" });
    store.put([entry("a", "2026-03-31"), entry("b", "2026-04-01"), entry("c", "2026-04-30"), entry("d", "2026-05-01"), entry("u", "")]);
    assert.deepEqual(store.window("2026-04-01", "2026-04-30").sort(), ["<VOUCHER>b</VOUCHER>", "<VOUCHER>c</VOUCHER>", "<VOUCHER>u</VOUCHER>"]);
    closeEvidenceStores();
  });

  test(`${backend}: dropMissing removes only dated vouchers inside the range that Tally no longer lists`, () => {
    const store = getEvidenceStore({ dir: tempDir(), companyName: "Acme", backend });
    store.reset({ companyName: "Acme" });
    store.put([entry("keep", "2026-04-10"), entry("gone", "2026-04-11"), entry("outside", "2026-01-01"), entry("undated", "")]);
    const removed = store.dropMissing(new Set(["keep"]), { from: "2026-04-01", to: "2026-04-30" });
    assert.equal(removed, 1);
    assert.equal(store.count(), 3);
    closeEvidenceStores();
  });

  test(`${backend}: reset discards vouchers and counters`, () => {
    const store = getEvidenceStore({ dir: tempDir(), companyName: "Acme", backend });
    const meta = store.reset({ companyName: "Acme", companyGuid: "g1" });
    store.put([entry("1", "2026-04-02")]);
    meta.altVchId = 10;
    store.commit();
    const fresh = store.reset({ companyName: "Acme", companyGuid: "g2" });
    assert.equal(store.count(), 0);
    assert.equal(fresh.altVchId, 0);
    assert.equal(fresh.companyGuid, "g2");
    closeEvidenceStores();
  });

  test(`${backend}: counters are not saved until commit, so an interrupted scan is re-read`, () => {
    const dir = tempDir();
    const store = getEvidenceStore({ dir, companyName: "Acme", backend });
    const meta = store.reset({ companyName: "Acme" });
    Object.assign(meta, { altVchId: 5, coveredFrom: "2026-04-01", coveredTo: "2026-04-30" });
    store.commit();
    store.put([entry("late", "2026-04-20", 6)]);
    meta.altVchId = 6;
    closeEvidenceStores(); // the scan died before commit
    const reopened = getEvidenceStore({ dir, companyName: "Acme", backend });
    if (backend === "sqlite") assert.equal(reopened.meta.altVchId, 5);
    closeEvidenceStores();
  });
}

test("sqlite: imports an existing JSON cache once and sets the old file aside", { skip: !sqliteAvailable }, () => {
  const dir = tempDir();
  const legacy = emptyEvidenceCache({ companyName: "Acme", companyGuid: "g1" });
  Object.assign(legacy, { altVchId: 99, altMstId: 3, coveredFrom: "2026-04-01", coveredTo: "2026-09-30", lastReconciledAt: 55 });
  storeVouchers(legacy, [entry("1", "2026-04-02"), entry("2", "2026-05-02")]);
  const file = evidenceCachePath(dir, "Acme");
  saveEvidenceCache(file, legacy);

  const store = getEvidenceStore({ dir, companyName: "Acme", backend: "sqlite" });
  assert.equal(store.backend, "sqlite");
  assert.equal(store.count(), 2);
  assert.equal(store.meta.altVchId, 99);
  assert.equal(store.meta.companyGuid, "g1");
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.imported`), true);
  closeEvidenceStores();
});

test("sqlite: a damaged database file is replaced with an empty one", { skip: !sqliteAvailable }, () => {
  const dir = tempDir();
  const file = evidenceDbPath(dir, "Acme");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "this is not a database");
  const store = getEvidenceStore({ dir, companyName: "Acme", backend: "sqlite" });
  assert.equal(store.backend, "sqlite");
  assert.equal(store.meta, null);
  assert.equal(store.count(), 0);
  closeEvidenceStores();
});

test("falls back to JSON when asked for it", () => {
  const store = getEvidenceStore({ dir: tempDir(), companyName: "Acme", backend: "json" });
  assert.equal(store.backend, "json");
  closeEvidenceStores();
});
