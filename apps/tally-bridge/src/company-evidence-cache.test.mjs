import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RECONCILE_EVERY_MS, dropVouchersMissingFrom, emptyEvidenceCache, evidenceCachePath, loadEvidenceCache,
  needsKeyReconcile, planEvidenceRefresh, saveEvidenceCache, shiftIsoDate, storeVouchers,
} from "./company-evidence-cache.mjs";

const cached = (overrides = {}) => ({
  ...emptyEvidenceCache({ companyName: "Acme", companyGuid: "g1" }),
  altVchId: 100, coveredFrom: "2026-04-01", coveredTo: "2026-10-28", ...overrides,
});
const plan = (cache, counters, extra = {}) =>
  planEvidenceRefresh({ cache, counters: { altVchId: 100, ...counters }, companyGuid: "g1", neededFrom: "2026-04-01", asOfDate: "2026-10-28", ...extra });

test("a first scan reads the whole window", () => {
  const result = plan(null, {});
  assert.equal(result.mode, "rebuilt");
  assert.deepEqual(result.ranges, [{ from: "2026-04-01", to: "2026-10-28" }]);
});

test("an unchanged counter reads nothing", () => {
  const result = plan(cached(), {});
  assert.equal(result.mode, "unchanged");
  assert.equal(result.deltaAfter, null);
  assert.deepEqual(result.ranges, []);
});

test("a moved counter reads only vouchers changed after the saved one", () => {
  const result = plan(cached(), { altVchId: 107 });
  assert.equal(result.mode, "delta");
  assert.equal(result.deltaAfter, 100);
  assert.deepEqual(result.ranges, []);
});

test("a counter that went backwards discards the cache", () => {
  assert.equal(plan(cached(), { altVchId: 90 }).mode, "rebuilt");
});

test("a different company GUID discards the cache", () => {
  const result = planEvidenceRefresh({ cache: cached(), counters: { altVchId: 100 }, companyGuid: "other", neededFrom: "2026-04-01", asOfDate: "2026-10-28" });
  assert.equal(result.mode, "rebuilt");
});

test("an older open bill extends the window backwards, and a later date forwards", () => {
  const result = plan(cached(), {}, { neededFrom: "2026-01-15", asOfDate: "2026-11-02" });
  assert.equal(result.mode, "extended");
  assert.deepEqual(result.ranges, [{ from: "2026-01-15", to: "2026-03-31" }, { from: "2026-10-29", to: "2026-11-02" }]);
});

test("deletes are caught by a counter gap or by the hourly check", () => {
  const now = Date.now();
  const fresh = cached({ lastReconciledAt: now });
  assert.equal(needsKeyReconcile({ cache: fresh, counterMovedBy: 3, deltaCount: 3, now }), false);
  assert.equal(needsKeyReconcile({ cache: fresh, counterMovedBy: 3, deltaCount: 2, now }), true);
  assert.equal(needsKeyReconcile({ cache: fresh, counterMovedBy: 1, deltaCount: 1, now: now + RECONCILE_EVERY_MS }), true);
});

test("vouchers Tally no longer lists are dropped, only inside the window", () => {
  const cache = cached();
  storeVouchers(cache, [
    { key: "1", alterId: 1, date: "2026-06-01", xml: "a" },
    { key: "2", alterId: 2, date: "2026-06-02", xml: "b" },
    { key: "3", alterId: 3, date: "2025-01-01", xml: "c" },
  ]);
  assert.equal(dropVouchersMissingFrom(cache, new Set(["1"]), { from: "2026-04-01", to: "2026-10-28" }), 1);
  assert.deepEqual(Object.keys(cache.vouchers).sort(), ["1", "3"]);
});

test("the cache round-trips through disk and ignores an unreadable file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-cache-"));
  const file = evidenceCachePath(dir, "Acme");
  assert.equal(loadEvidenceCache(file), null);
  const cache = cached();
  storeVouchers(cache, [{ key: "1", alterId: 1, date: "2026-06-01", xml: "a" }]);
  saveEvidenceCache(file, cache);
  assert.equal(loadEvidenceCache(file).vouchers["1"].xml, "a");
  fs.writeFileSync(file, "{broken");
  assert.equal(loadEvidenceCache(file), null);
  assert.equal(shiftIsoDate("2026-03-01", -1), "2026-02-28");
});
