// Local cache of the invoice and receipt vouchers behind the Cash Discount scan.
//
// Reading every voucher costs Tally about 45 s on a large company. Tally also
// keeps two company-wide change counters: AltVchID moves whenever any voucher
// is created, edited or deleted. The cache remembers the highest AltVchID it
// has seen, so a later scan reads only vouchers changed since (about 4 s), or
// nothing at all when the counter has not moved.
//
// Open bills are NOT cached: Tally computes them and they are cheap to read.
// Vouchers are cached for every customer, not only the scoped ones, so a
// change in the customer scope never needs a rescan.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const EVIDENCE_CACHE_SCHEMA = 1;
// Deleted vouchers leave no trace in the counter, so keys are re-listed at
// least this often even when the counter looks consistent.
export const RECONCILE_EVERY_MS = 60 * 60 * 1000;

const DAY_MS = 86_400_000;

export function shiftIsoDate(iso, days) {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function evidenceCachePath(dir, companyName) {
  const id = createHash("sha1").update(String(companyName ?? "").trim().toLowerCase()).digest("hex").slice(0, 16);
  return path.join(dir, "evidence-cache", `${id}.json`);
}

export function emptyEvidenceCache({ companyName, companyGuid = null }) {
  return {
    schema: EVIDENCE_CACHE_SCHEMA,
    companyName,
    companyGuid,
    altVchId: 0,
    altMstId: 0,
    coveredFrom: null,
    coveredTo: null,
    lastReconciledAt: 0,
    vouchers: {},
  };
}

export function loadEvidenceCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed?.schema === EVIDENCE_CACHE_SCHEMA && parsed.vouchers && typeof parsed.vouchers === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveEvidenceCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cache));
  fs.renameSync(temp, file);
}

/**
 * Decides what must be read from Tally to bring the cache up to date.
 * Returns { mode, reason, ranges, deltaAfter }:
 *  - ranges: date windows to read in full (everything in them)
 *  - deltaAfter: read vouchers with AlterID above this over the whole window, or null
 * mode: "rebuilt" (cache discarded), "extended" (window grew), "delta"
 * (vouchers changed), "unchanged" (nothing to read).
 */
export function planEvidenceRefresh({ cache, counters, companyGuid, neededFrom, asOfDate }) {
  const rebuild = (reason) => ({ mode: "rebuilt", reason, ranges: [{ from: neededFrom, to: asOfDate }], deltaAfter: null, cache: null });
  if (!cache) return rebuild("first scan of this company");
  if (cache.companyGuid && companyGuid && cache.companyGuid !== companyGuid) return rebuild("a different company is open under this name");
  if (counters.altVchId < cache.altVchId) return rebuild("Tally's change counter went backwards (company restored)");
  if (!cache.coveredFrom || !cache.coveredTo) return rebuild("cache has no coverage recorded");

  const ranges = [];
  if (neededFrom < cache.coveredFrom) ranges.push({ from: neededFrom, to: shiftIsoDate(cache.coveredFrom, -1) });
  if (asOfDate > cache.coveredTo) ranges.push({ from: shiftIsoDate(cache.coveredTo, 1), to: asOfDate });
  const changed = counters.altVchId > cache.altVchId;
  if (!ranges.length && !changed) return { mode: "unchanged", reason: "no voucher changed in Tally", ranges, deltaAfter: null, cache };
  return {
    mode: ranges.length ? "extended" : "delta",
    reason: ranges.length ? "the date window grew" : `${counters.altVchId - cache.altVchId} voucher change(s) in Tally`,
    ranges,
    deltaAfter: changed ? cache.altVchId : null,
    cache,
  };
}

// A delete moves the counter but leaves no voucher to read, so a delta that
// returns fewer vouchers than the counter moved by may hide one.
export function needsKeyReconcile({ cache, counterMovedBy, deltaCount, now = Date.now() }) {
  if (now - (cache.lastReconciledAt || 0) >= RECONCILE_EVERY_MS) return true;
  return counterMovedBy > deltaCount;
}

export function storeVouchers(cache, entries) {
  for (const entry of entries) cache.vouchers[entry.key] = { alterId: entry.alterId, date: entry.date, xml: entry.xml };
}

// Removes cached vouchers dated inside [from, to] that Tally no longer lists.
export function dropVouchersMissingFrom(cache, presentKeys, { from, to }) {
  let removed = 0;
  for (const [key, voucher] of Object.entries(cache.vouchers)) {
    if (voucher.date && voucher.date >= from && voucher.date <= to && !presentKeys.has(key)) {
      delete cache.vouchers[key];
      removed += 1;
    }
  }
  return removed;
}
