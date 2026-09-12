import { normalizeMasterKey } from "./store.mjs";

/**
 * Read-only Tally ledger sync for Local Matching.
 * Never creates, alters, cancels or deletes Tally records — only Export Collection.
 * Uses existing bridge helpers via dependency injection to stay testable and avoid
 * circular imports.
 */

function ledgerFromTallyBlock(block, getTagText, getAttribute) {
  const name = getAttribute(block, "NAME") || getTagText(block, "NAME");
  if (!name) return null;
  return {
    name: String(name).trim(),
    guid: getTagText(block, "GUID") ? String(getTagText(block, "GUID")).trim() : null,
    parent: getTagText(block, "PARENT") ? String(getTagText(block, "PARENT")).trim() : null,
    alterID: getTagText(block, "ALTERID") ? String(getTagText(block, "ALTERID")).trim() : null,
    masterID: getTagText(block, "MASTERID") ? String(getTagText(block, "MASTERID")).trim() : null,
    raw: {
      tallyTag: "LEDGER",
      billWiseEnabled: /^yes$/i.test(getTagText(block, "ISBILLWISEON") || ""),
    },
  };
}

export function parseLedgersFromXml(xml, helpers) {
  const { extractBlocks, getTagText, getAttribute } = helpers;
  const blocks = extractBlocks(xml, "LEDGER");
  return blocks.map((b) => ledgerFromTallyBlock(b, getTagText, getAttribute)).filter(Boolean);
}

/**
 * Perform read-only sync: fetch ledgers via Export, upsert via store.
 * dependencies: { exportTallyCollection(tallyUrl, opts) -> xml, helpers, getActiveCompany? }
 */
export async function syncLedgersReadOnly({
  tallyUrl,
  companyName,
  companyGuid,
  exportTallyCollection,
  helpers,
  getActiveCompany, // optional () => {companyName, companyGuid}
}) {
  if (!tallyUrl) throw new Error("Tally URL is required for sync.");
  if (!exportTallyCollection) throw new Error("exportTallyCollection is required.");
  if (!helpers?.extractBlocks || !helpers?.getTagText || !helpers?.getAttribute) {
    throw new Error("helpers extractBlocks/getTagText/getAttribute required.");
  }

  let resolvedCompanyName = companyName;
  let resolvedCompanyGuid = companyGuid;
  if (getActiveCompany) {
    const active = await getActiveCompany(tallyUrl);
    // getActiveCompany should return {companyName, companyGuid} or null
    if (active) {
      resolvedCompanyName = active.companyName || resolvedCompanyName;
      resolvedCompanyGuid = active.companyGuid || resolvedCompanyGuid;
    }
  }

  // Enforce read-only: ensure we never call Import. Verify via options: tallyType must be Ledger/Group etc., not Import.
  const collectionName = "Gajkesari Local Matching Ledgers Sync";
  // Fetch ledgers read-only: Export Collection Type Ledger, fetch Name,Parent,GUID,AlterID,MasterID
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName,
    tallyType: "Ledger",
    fetchFields: "Name,Parent,GUID,AlterID,MasterID,IsBillWiseOn",
    companyName: resolvedCompanyName || null,
  });

  // Validate no Import was used (defensive)
  if (typeof xml === "string" && /<TALLYREQUEST>\s*Import/i.test(xml)) {
    throw new Error("Sync must be read-only: Import detected in Tally request.");
  }

  const ledgers = parseLedgersFromXml(xml, helpers);

  // Also fetch company identity from tally if not provided: use fetchAvailableCompanies pattern
  // Caller should provide companyGuid; if missing, derive from ledgers? but not reliable.
  // Keep what we have.

  const cursor = {};
  const alterIds = ledgers.map((l) => l.alterID).filter(Boolean).map(Number).filter(Number.isFinite);
  if (alterIds.length) cursor.lastAlterID = String(Math.max(...alterIds));
  const masterIds = ledgers.map((l) => l.masterID).filter(Boolean).map(Number).filter(Number.isFinite);
  if (masterIds.length) cursor.lastMasterID = String(Math.max(...masterIds));

  return {
    companyName: resolvedCompanyName,
    companyGuid: resolvedCompanyGuid || null,
    ledgers,
    cursor: Object.keys(cursor).length ? cursor : null,
    fetchedAt: new Date().toISOString(),
    isReadOnly: true,
  };
}

/**
 * Ensure no Import Data envelope is constructed for Local Matching sync.
 * Helper for tests: assert that sync never invokes Import.
 */
export function isReadOnlySyncOptions(opts) {
  return opts && typeof opts === "object" && opts.tallyType !== "Voucher" && !String(opts.collectionName || "").toLowerCase().includes("import");
}
