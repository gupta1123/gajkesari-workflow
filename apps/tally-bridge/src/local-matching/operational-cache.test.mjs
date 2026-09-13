import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeVouchers, ensureVoucherPartition, financialYearRange, getCachedBillBucket,
  loadOperationalCache, putCachedBillBucket, saveOperationalCache, upsertVoucherPartition,
} from "./operational-cache.mjs";

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "gk-operational-cache-")); }
function voucher(overrides = {}) {
  return { guid: "v1", masterId: "1", alterId: "10", date: "20260913", voucherType: "Receipt", voucherNumber: "R-1",
    partyLedgerName: "Customer A", ledgerNames: ["Bank A", "Customer A"], ledgerEntries: [], bankReferences: ["UTR-1"], ...overrides };
}

test("financial year boundaries use the Indian April to March year", () => {
  assert.deepEqual(financialYearRange("2026-09-13"), { key: "2026-27", dateFrom: "2026-04-01", dateTo: "2027-03-31" });
  assert.deepEqual(financialYearRange("2026-02-01"), { key: "2025-26", dateFrom: "2025-04-01", dateTo: "2026-03-31" });
});

test("voucher cache persists, updates incrementally and retires missing full-snapshot rows", () => {
  const baseDir = temp();
  const db = loadOperationalCache({ baseDir });
  const { partition } = ensureVoucherPartition(db, { companyGuid: "c1", companyName: "Co", bankLedgerName: "Bank A", financialYear: "2026-27" });
  assert.equal(upsertVoucherPartition(partition, [voucher()], { mode: "full_snapshot", bankLedgerName: "Bank A" }).counts.added, 1);
  putCachedBillBucket(partition, "Customer A", { complete: true, openBills: [{ referenceName: "I-1" }], existingAdvances: [] });
  assert.ok(getCachedBillBucket(partition, "Customer A"));
  upsertVoucherPartition(partition, [voucher({ alterId: "11", narration: "changed" })], { mode: "delta", bankLedgerName: "Bank A" });
  assert.equal(getCachedBillBucket(partition, "Customer A"), null);
  assert.equal(activeVouchers(partition, { dateFrom: "2026-04-01", dateTo: "2027-03-31" }).length, 1);
  assert.equal(upsertVoucherPartition(partition, [], { mode: "full_snapshot", bankLedgerName: "Bank A" }).counts.deleted, 1);
  saveOperationalCache(db, { baseDir });
  assert.equal(Object.values(loadOperationalCache({ baseDir }).partitions)[0].voucherCount, 0);
  fs.rmSync(baseDir, { recursive: true, force: true });
});

test("a changed voucher that no longer touches the bank is retired", () => {
  const db = loadOperationalCache({ baseDir: temp() });
  const { partition } = ensureVoucherPartition(db, { companyGuid: "c1", bankLedgerName: "Bank A", financialYear: "2026-27" });
  upsertVoucherPartition(partition, [voucher()], { mode: "full_snapshot", bankLedgerName: "Bank A" });
  const result = upsertVoucherPartition(partition, [voucher({ alterId: "12", ledgerNames: ["Cash", "Customer A"] })], { mode: "delta", bankLedgerName: "Bank A" });
  assert.equal(result.counts.deleted, 1);
  assert.equal(partition.voucherCount, 0);
});

test("a sparse cancellation invalidates the previous party bill cache", () => {
  const db = loadOperationalCache({ baseDir: temp() });
  const { partition } = ensureVoucherPartition(db, { companyGuid: "c1", bankLedgerName: "Bank A", financialYear: "2026-27" });
  upsertVoucherPartition(partition, [voucher()], { mode: "full_snapshot", bankLedgerName: "Bank A" });
  putCachedBillBucket(partition, "Customer A", { complete: true, openBills: [], existingAdvances: [] });

  const result = upsertVoucherPartition(partition, [voucher({
    alterId: "12",
    isCancelled: "Yes",
    partyLedgerName: "",
    ledgerNames: [],
    ledgerEntries: [],
  })], { mode: "delta", bankLedgerName: "Bank A" });

  assert.equal(result.counts.deleted, 1);
  assert.deepEqual(result.affectedPartyNames, ["Customer A"]);
  assert.equal(getCachedBillBucket(partition, "Customer A"), null);
});

test("scoped snapshot retires only missing in-range vouchers and preserves the global cursor", () => {
  const db = loadOperationalCache({ baseDir: temp() });
  const { partition } = ensureVoucherPartition(db, { companyGuid: "c1", bankLedgerName: "Bank A", financialYear: "2026-27" });
  upsertVoucherPartition(partition, [
    voucher({ guid: "in-range", date: "20260901", alterId: "20" }),
    voucher({ guid: "outside", date: "20260902", alterId: "30" }),
  ], { mode: "full_snapshot", bankLedgerName: "Bank A" });
  partition.cursor = { lastAlterId: "50", lastMasterId: "40" };

  const result = upsertVoucherPartition(partition, [], {
    mode: "scoped_snapshot", bankLedgerName: "Bank A", dateFrom: "2026-09-01", dateTo: "2026-09-01",
  });

  assert.equal(result.counts.deleted, 1);
  assert.equal(partition.vouchers["voucher:outside"].isActive, true);
  assert.deepEqual(partition.cursor, { lastAlterId: "50", lastMasterId: "40" });
});

test("scoped snapshot keeps bill caches for unchanged vouchers", () => {
  const db = loadOperationalCache({ baseDir: temp() });
  const { partition } = ensureVoucherPartition(db, { companyGuid: "c1", bankLedgerName: "Bank A", financialYear: "2026-27" });
  const cachedVoucher = voucher({ date: "20260901", effectiveDate: "20260901" });
  upsertVoucherPartition(partition, [cachedVoucher], { mode: "full_snapshot", bankLedgerName: "Bank A" });
  putCachedBillBucket(partition, "Customer A", { complete: true, openBills: [], existingAdvances: [] });

  const result = upsertVoucherPartition(partition, [cachedVoucher], {
    mode: "scoped_snapshot", bankLedgerName: "Bank A", dateFrom: "2026-09-01", dateTo: "2026-09-01",
  });

  assert.equal(result.counts.unchanged, 1);
  assert.deepEqual(result.affectedPartyNames, []);
  assert.ok(getCachedBillBucket(partition, "Customer A"));
});
