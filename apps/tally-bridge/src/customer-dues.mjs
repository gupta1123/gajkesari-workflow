import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { RECONCILE_EVERY_MS } from "./company-evidence-cache.mjs";

const SCHEMA = 1;

function sameCounters(left, right) {
  return left.altVchId === right.altVchId && left.altMstId === right.altMstId;
}

export function createCustomerDues({ dir, normalizeLedger, readActiveCompany, readCounters, scan, today, onStatus = () => {} }) {
  const snapshots = new Map();
  let running = null;
  let progress = "";
  let failure = null;
  const directory = (company) => path.join(dir, createHash("sha256")
    .update(JSON.stringify([company.tallyUrl, company.guid, company.financialYear])).digest("hex"));
  const filename = (company) => path.join(directory(company), "dues.json");

  function get(company) {
    const key = filename(company);
    if (!snapshots.has(key)) {
      let saved = null;
      try {
        const value = JSON.parse(fs.readFileSync(key, "utf8"));
        if (value.schema === SCHEMA && Array.isArray(value.buckets) && value.counters) saved = value;
      } catch {
        // A missing or unreadable snapshot can be prepared again from Tally.
      }
      snapshots.set(key, saved);
    }
    return snapshots.get(key);
  }

  function isCurrent(snapshot, date, counters) {
    return snapshot?.asOfDate === date && sameCounters(snapshot.counters, counters) &&
      Date.now() - Date.parse(snapshot.preparedAt) < RECONCILE_EVERY_MS;
  }

  function status(company) {
    if (!company) return { status: "no_company" };
    const saved = get(company);
    return {
      status: running ? "checking" : saved ? "prepared" : "not_prepared",
      companyName: company.companyName,
      financialYear: company.financialYear,
      checkedAt: saved?.checkedAt ?? null,
      lastError: failure?.file === filename(company) ? failure.message : null,
      progress,
    };
  }

  function prepare({ full = false, automatic = false } = {}) {
    if (running) return running;
    let file;
    const report = (message) => { progress = message; onStatus(); };
    running = (async () => {
      const company = await readActiveCompany();
      if (!company) {
        if (automatic) return null;
        throw new Error("Open a company in Tally Prime and try again.");
      }
      const saved = get(company);
      if (automatic && !saved) return company;
      file = filename(company);
      if (failure?.file === file) failure = null;
      report("Checking Tally for changes…");
      const date = today();
      const before = await readCounters(company);
      let snapshot;
      if (!full && isCurrent(saved, date, before)) {
        snapshot = { ...saved, checkedAt: new Date().toISOString() };
      } else {
        const result = await scan(company, {
          date, counters: before, cacheDir: directory(company), forceRebuild: full, onProgress: report,
        });
        const active = await readActiveCompany();
        if (!active || directory(active) !== directory(company)) throw new Error("The active company in Tally changed. Check customer dues again.");
        const after = await readCounters(company);
        if (today() !== date || !sameCounters(before, after)) throw new Error("Tally changed during the scan. Check customer dues again.");
        const checkedAt = new Date().toISOString();
        const buckets = Object.values(result.byLedger);
        snapshot = {
          schema: SCHEMA, asOfDate: date, counters: before, checkedAt, preparedAt: checkedAt, buckets,
        };
        fs.mkdirSync(directory(company), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(snapshot));
        fs.renameSync(temp, file);
      }
      snapshots.set(file, snapshot);
      return company;
    })().catch((error) => {
      if (file) failure = { file, message: error.message };
      throw error;
    }).finally(() => { running = null; progress = ""; onStatus(); });
    onStatus();
    return running;
  }

  async function read(company, ledgerNames, verifyCounters) {
    const saved = get(company);
    if (!saved || saved.asOfDate !== today()) return null;
    const counters = await verifyCounters();
    if (!isCurrent(saved, today(), counters)) return null;
    const indexed = new Map(saved.buckets.map((bucket) => [normalizeLedger(bucket.ledgerName), bucket]));
    const byLedger = Object.fromEntries(ledgerNames.map((name) => {
      const bucket = indexed.get(normalizeLedger(name));
      return [name, bucket
        ? { ...bucket, ledgerName: name }
        : { ledgerName: name, openBills: [], existingAdvances: [], rawCount: 0 }];
    }));
    const ledgerName = ledgerNames[0];
    return {
      ledgerName, ledgerNames, byLedger,
      openBills: byLedger[ledgerName].openBills,
      existingAdvances: byLedger[ledgerName].existingAdvances,
      rawCount: Object.values(byLedger).reduce((sum, bucket) => sum + bucket.rawCount, 0),
      dataSource: "prepared_customer_dues",
      checkedAt: new Date().toISOString(),
      queryDiagnostics: { scanMode: "prepared_customer_dues", evidenceCache: { mode: "unchanged" } },
    };
  }

  function summary(company) {
    const saved = get(company);
    return { status: status(company).status, preparedAt: saved?.preparedAt ?? null, checkedAt: saved?.checkedAt ?? null,
      customers: saved?.buckets.length ?? null,
      openBills: saved ? saved.buckets.reduce((count, bucket) => count + bucket.openBills.length, 0) : null };
  }
  return { prepare, read, status, summary };
}
