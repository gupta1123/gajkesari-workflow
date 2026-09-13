import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getLocalDbPaths } from "./store.mjs";

export const OPERATIONAL_CACHE_SCHEMA_VERSION = 1;

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function cachePath(options = {}) {
  return path.join(getLocalDbPaths(options).dir, "operational-cache.json");
}

function blankDb() {
  return { schemaVersion: OPERATIONAL_CACHE_SCHEMA_VERSION, partitions: {}, updatedAt: null };
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  try { fs.renameSync(temporary, filePath); }
  finally { try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch {} }
}

export function loadOperationalCache(options = {}) {
  const filePath = cachePath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return blankDb();
    parsed.schemaVersion = OPERATIONAL_CACHE_SCHEMA_VERSION;
    parsed.partitions ||= {};
    return parsed;
  } catch { return blankDb(); }
}

export function saveOperationalCache(db, options = {}) {
  db.schemaVersion = OPERATIONAL_CACHE_SCHEMA_VERSION;
  db.updatedAt = new Date().toISOString();
  atomicWrite(cachePath(options), db);
  return db;
}

export function financialYearRange(value) {
  const text = String(value || "").slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("A valid date is required for the voucher cache.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  return { key: `${startYear}-${String(startYear + 1).slice(-2)}`, dateFrom: `${startYear}-04-01`, dateTo: `${startYear + 1}-03-31` };
}

export function voucherPartitionKey({ companyGuid, companyName, bankLedgerGuid, bankLedgerName, financialYear }) {
  const identity = [companyGuid || companyName, bankLedgerGuid || bankLedgerName, financialYear].map(normalize).join("|");
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

export function ensureVoucherPartition(db, identity) {
  const key = voucherPartitionKey(identity);
  let partition = db.partitions[key];
  if (!partition) {
    partition = {
      ...identity,
      createdAt: new Date().toISOString(),
      lastRefreshAt: null,
      lastFullRefreshAt: null,
      cursor: { lastAlterId: null, lastMasterId: null },
      vouchers: {},
      billCache: {},
      status: "empty",
    };
    db.partitions[key] = partition;
  }
  return { key, partition };
}

function voucherIdentity(voucher) {
  const stable = String(voucher.guid || voucher.masterId || "").trim();
  if (stable) return `voucher:${stable.toLowerCase()}`;
  return `voucher:${createHash("sha256").update([
    voucher.voucherType, voucher.voucherNumber, voucher.date || voucher.effectiveDate, voucher.reference,
  ].map(normalize).join("|")).digest("hex").slice(0, 32)}`;
}

function minimalVoucher(voucher, now) {
  return {
    date: voucher.date || null,
    effectiveDate: voucher.effectiveDate || null,
    voucherType: voucher.voucherType || null,
    voucherNumber: voucher.voucherNumber || null,
    reference: voucher.reference || null,
    narration: voucher.narration || null,
    partyLedgerName: voucher.partyLedgerName || null,
    ledgerNames: Array.isArray(voucher.ledgerNames) ? voucher.ledgerNames : [],
    ledgerEntries: Array.isArray(voucher.ledgerEntries) ? voucher.ledgerEntries : [],
    bankReferences: Array.isArray(voucher.bankReferences) ? voucher.bankReferences : [],
    billAllocations: Array.isArray(voucher.billAllocations) ? voucher.billAllocations : [],
    masterId: voucher.masterId || null,
    alterId: voucher.alterId || null,
    guid: voucher.guid || null,
    isCancelled: voucher.isCancelled || null,
    isActive: true,
    lastSeenAt: now,
  };
}

function voucherTouchesLedger(voucher, ledgerName) {
  const target = normalize(ledgerName);
  return Boolean(target) && [voucher.partyLedgerName, ...(voucher.ledgerNames || [])].some((name) => normalize(name) === target);
}

function voucherDate(voucher) {
  return String(voucher?.effectiveDate || voucher?.date || "")
    .replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")
    .slice(0, 10);
}

export function upsertVoucherPartition(
  partition,
  vouchers,
  { mode = "delta", bankLedgerName, dateFrom, dateTo } = {}
) {
  const now = new Date().toISOString();
  const seen = new Set();
  const affectedPartyNames = new Set();
  let added = 0, updated = 0, unchanged = 0, deleted = 0;
  let maxAlterId = Number(partition.cursor?.lastAlterId) || 0;
  let maxMasterId = Number(partition.cursor?.lastMasterId) || 0;
  const markAffectedParties = (voucher) => {
    if (!voucher) return;
    for (const name of [voucher.partyLedgerName, ...(voucher.ledgerNames || [])]) {
      if (name && normalize(name) !== normalize(bankLedgerName)) affectedPartyNames.add(String(name).trim());
    }
  };

  for (const voucher of vouchers || []) {
    const key = voucherIdentity(voucher);
    seen.add(key);
    const belongsToBank = voucherTouchesLedger(voucher, bankLedgerName) && !/^yes$/i.test(String(voucher.isCancelled || ""));
    const previous = partition.vouchers[key];
    const numericAlterId = Number(voucher.alterId);
    const numericMasterId = Number(voucher.masterId);
    if (Number.isFinite(numericAlterId)) maxAlterId = Math.max(maxAlterId, numericAlterId);
    if (Number.isFinite(numericMasterId)) maxMasterId = Math.max(maxMasterId, numericMasterId);
    if (!belongsToBank) {
      if (previous?.isActive) {
        previous.isActive = false;
        previous.deletedAt = now;
        deleted += 1;
        // Tally emits cancelled vouchers without their ledger entries, so use
        // the cached identity to invalidate the correct bill bucket.
        markAffectedParties(previous);
      }
      continue;
    }
    const next = minimalVoucher(voucher, now);
    if (!previous) {
      partition.vouchers[key] = next;
      added += 1;
      markAffectedParties(next);
    }
    else {
      const changed = JSON.stringify({ ...previous, lastSeenAt: null }) !== JSON.stringify({ ...next, lastSeenAt: null });
      partition.vouchers[key] = { ...previous, ...next, updatedAt: changed ? now : previous.updatedAt };
      if (changed) {
        updated += 1;
        markAffectedParties(previous);
        markAffectedParties(next);
      } else unchanged += 1;
    }
  }

  if (mode === "full_snapshot") {
    for (const [key, voucher] of Object.entries(partition.vouchers)) {
      if (voucher.isActive && !seen.has(key)) {
        voucher.isActive = false;
        voucher.deletedAt = now;
        deleted += 1;
        markAffectedParties(voucher);
      }
    }
    partition.lastFullRefreshAt = now;
  } else if (mode === "scoped_snapshot" && dateFrom && dateTo) {
    for (const [key, voucher] of Object.entries(partition.vouchers)) {
      const date = voucherDate(voucher);
      if (voucher.isActive && date >= dateFrom && date <= dateTo && !seen.has(key)) {
        voucher.isActive = false;
        voucher.deletedAt = now;
        deleted += 1;
        markAffectedParties(voucher);
      }
    }
  }
  // A scoped snapshot has not observed other company dates, so it must not
  // advance the global cursor and hide unrelated changes from a later refresh.
  if (mode !== "scoped_snapshot") {
    partition.cursor = { lastAlterId: String(maxAlterId), lastMasterId: String(maxMasterId) };
  }
  partition.lastRefreshAt = now;
  partition.status = "ready";
  for (const name of affectedPartyNames) invalidateBillCache(partition, name, now);
  const active = Object.values(partition.vouchers).filter((voucher) => voucher.isActive).length;
  partition.voucherCount = active;
  partition.lastCounts = { added, updated, unchanged, deleted, active, mode };
  return { counts: partition.lastCounts, affectedPartyNames: [...affectedPartyNames] };
}

export function activeVouchers(partition, { dateFrom, dateTo } = {}) {
  return Object.values(partition?.vouchers || {}).filter((voucher) => {
    if (!voucher.isActive) return false;
    const date = String(voucher.effectiveDate || voucher.date || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3").slice(0, 10);
    return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
  });
}

function billKey(ledgerName) { return normalize(ledgerName); }

export function invalidateBillCache(partition, ledgerName, at = new Date().toISOString()) {
  const key = billKey(ledgerName);
  if (!key || !partition.billCache?.[key]) return;
  partition.billCache[key].invalidatedAt = at;
}

export function getCachedBillBucket(partition, ledgerName) {
  const item = partition?.billCache?.[billKey(ledgerName)];
  if (!item?.complete || !item.verifiedAt) return null;
  if (item.invalidatedAt && Date.parse(item.invalidatedAt) >= Date.parse(item.verifiedAt)) return null;
  return item.bucket || null;
}

export function putCachedBillBucket(partition, ledgerName, bucket) {
  partition.billCache ||= {};
  partition.billCache[billKey(ledgerName)] = {
    ledgerName,
    complete: bucket?.complete !== false && !bucket?.error,
    verifiedAt: new Date().toISOString(),
    invalidatedAt: null,
    bucket,
  };
}

export function operationalStatus(db, { companyGuid, companyName } = {}) {
  const partitions = Object.values(db.partitions || {}).filter((partition) =>
    companyGuid ? normalize(partition.companyGuid) === normalize(companyGuid) : !companyName || normalize(partition.companyName) === normalize(companyName)
  );
  return {
    partitionCount: partitions.length,
    voucherCount: partitions.reduce((sum, partition) => sum + Number(partition.voucherCount || 0), 0),
    status: partitions.length ? (partitions.some((partition) => partition.status === "refreshing") ? "refreshing" : "ready") : "not_indexed",
    lastUpdatedAt: partitions.map((partition) => partition.lastRefreshAt).filter(Boolean).sort().at(-1) || null,
    partitions: partitions.map((partition) => ({
      bankLedgerName: partition.bankLedgerName,
      financialYear: partition.financialYear,
      voucherCount: partition.voucherCount || 0,
      lastUpdatedAt: partition.lastRefreshAt,
      lastFullRefreshAt: partition.lastFullRefreshAt,
      counts: partition.lastCounts || null,
    })),
  };
}
