
import { getLocalDbPaths, loadLocalDb } from "./store.mjs";
import { isZvecAvailable, queryZvec, queryZvecBatch } from "./vector.mjs";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

function clampTopK(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_TOP_K;
  return Math.max(1, Math.min(MAX_TOP_K, Math.floor(number)));
}
function resolveCompany(db, { companyId, companyName, companyGuid }) {
  const companies = Object.entries(db.companies || {});
  const exact = companies.find(([key, entry]) =>
    (companyId && (
      key.toLowerCase() === String(companyId).toLowerCase() ||
      entry.companyGuid?.toLowerCase() === String(companyId).toLowerCase() ||
      entry.companyName?.toLowerCase() === String(companyId).toLowerCase()
    )) ||
    (companyName && entry.companyName?.toLowerCase() === String(companyName).toLowerCase()) ||
    (companyGuid && entry.companyGuid?.toLowerCase() === String(companyGuid).toLowerCase())
  );
  if (exact) return { key: exact[0], entry: exact[1] };

  companies.sort((left, right) =>
    new Date(right[1].lastSyncAt || 0).getTime() - new Date(left[1].lastSyncAt || 0).getTime()
  );
  return companies.length ? { key: companies[0][0], entry: companies[0][1] } : null;
}

function normalizeVectorScore(document) {
  if (typeof document.score === "number") return Math.max(0, Math.min(1, document.score));
  if (typeof document.distance === "number") return Math.max(0, Math.min(1, 1 - document.distance));
  return 0;
}

function findLedger(document, activeLedgers) {
  const fields = document.fields || document.field || {};
  const masterKey = fields.masterKey || fields.master_key || document.masterKey || document.key || null;
  if (masterKey) {
    const match = activeLedgers.find((ledger) => ledger.master_key === masterKey);
    if (match) return match;
  }
  if (document.id) {
    const safeId = String(document.id);
    const byId = activeLedgers.find((ledger) =>
      String(ledger.master_key).replace(/[^a-zA-Z0-9._-]+/g, "_") === safeId
    );
    if (byId) return byId;
  }
  if (fields.ledgerName) {
    return activeLedgers.find((ledger) => ledger.tally_name === fields.ledgerName) || null;
  }
  return null;
}

function emptyResult({ query, companyId = null, companyName = null, reason, error = null, totalActive = 0 }) {
  return {
    query,
    companyId,
    companyName,
    suggestions: [],
    isEmpty: true,
    emptyReason: reason,
    meta: {
      topK: 0,
      totalActive,
      retrieved: 0,
      vectorEngine: "zvec",
      searchMode: "vector_only",
      usedAI: true,
      embeddingModel: "openai/text-embedding-3-small",
      vectorError: error,
    },
  };
}

function resultFromDocuments({ searchQuery, company, activeLedgers, documents, limit }) {
  const suggestions = (Array.isArray(documents) ? documents : [])
    .map((document) => ({ document, ledger: findLedger(document, activeLedgers) }))
    .filter((item) => item.ledger)
    .slice(0, limit)
    .map(({ document, ledger }, index) => {
      const confidence = normalizeVectorScore(document);
      return {
        ledgerId: ledger.master_key,
        ledgerName: ledger.tally_name,
        parentGroup: ledger.parent_name || null,
        rank: index + 1,
        localScore: 0,
        vectorScore: Number(confidence.toFixed(4)),
        aiScore: null,
        confidence: Number(confidence.toFixed(4)),
        source: "zvec",
        retrievalSource: "zvec",
        reasons: ["vector similarity"],
        needsReview: confidence < 0.6,
        isActive: true,
        tallyGuid: ledger.tally_guid || null,
      };
    });

  return {
    query: searchQuery,
    companyId: company.key,
    companyName: company.entry.companyName,
    companyGuid: company.entry.companyGuid,
    suggestions,
    isEmpty: suggestions.length === 0,
    emptyReason: suggestions.length ? null : "no_vector_candidates",
    meta: {
      topK: limit,
      totalActive: activeLedgers.length,
      retrieved: suggestions.length,
      vectorEngine: "zvec",
      searchMode: "vector_only",
      usedAI: true,
      embeddingModel: "openai/text-embedding-3-small",
      vectorError: null,
    },
  };
}

export async function suggestLedgers({
  narration,
  ledgerQuery,
  query,
  companyId,
  companyName,
  companyGuid,
  topK,
  appUserDataPath,
  baseDir,
  embedTexts,
} = {}) {
  const searchQuery = String(query || narration || ledgerQuery || "").trim();
  if (!searchQuery) return emptyResult({ query: "", companyId, companyName, reason: "empty_query" });

  let db;
  try {
    db = loadLocalDb({ appUserDataPath, baseDir });
  } catch {
    db = { companies: {} };
  }

  const company = resolveCompany(db, { companyId, companyName, companyGuid });
  if (!company) {
    return emptyResult({ query: searchQuery, companyId, companyName, reason: "no_company_data" });
  }

  const activeLedgers = Object.values(company.entry.ledgers || {}).filter((ledger) => ledger.is_active);
  if (!activeLedgers.length) {
    return emptyResult({
      query: searchQuery,
      companyId: company.key,
      companyName: company.entry.companyName,
      reason: "no_active_ledgers",
    });
  }

  const { vectorDir } = getLocalDbPaths({ appUserDataPath, baseDir });
  if (!isZvecAvailable() || company.entry.vector?.status !== "ready") {
    return emptyResult({
      query: searchQuery,
      companyId: company.key,
      companyName: company.entry.companyName,
      reason: "vector_search_not_ready",
      totalActive: activeLedgers.length,
    });
  }

  const limit = clampTopK(topK);
  let documents;
  try {
    if (typeof embedTexts !== "function") throw new Error("Secure AI embedding service is unavailable.");
    const embeddings = await embedTexts([searchQuery], "search_query");
    documents = await queryZvec({ vectorDir, companyKey: company.key, embedding: embeddings?.[0], topK: limit });
  } catch (error) {
    return emptyResult({
      query: searchQuery,
      companyId: company.key,
      companyName: company.entry.companyName,
      reason: "vector_search_unavailable",
      error: error instanceof Error ? error.message : String(error),
      totalActive: activeLedgers.length,
    });
  }

  return resultFromDocuments({ searchQuery, company, activeLedgers, documents, limit });
}

export async function suggestLedgersBatch({ queries, companyId, companyName, companyGuid, topK, appUserDataPath, baseDir, embedTexts } = {}) {
  if (!Array.isArray(queries) || queries.length === 0 || queries.length > 256) {
    throw new Error("Vector search batch requires 1-256 queries.");
  }
  const searchQueries = queries.map((value) => String(value ?? "").trim());
  if (searchQueries.some((value) => !value)) throw new Error("Every vector search query must contain text.");

  let db;
  try { db = loadLocalDb({ appUserDataPath, baseDir }); } catch { db = { companies: {} }; }
  const company = resolveCompany(db, { companyId, companyName, companyGuid });
  if (!company) return searchQueries.map((searchQuery) => emptyResult({ query: searchQuery, companyId, companyName, reason: "no_company_data" }));

  const activeLedgers = Object.values(company.entry.ledgers || {}).filter((ledger) => ledger.is_active);
  if (!activeLedgers.length) return searchQueries.map((searchQuery) => emptyResult({ query: searchQuery, companyId: company.key, companyName: company.entry.companyName, reason: "no_active_ledgers" }));
  if (!isZvecAvailable() || company.entry.vector?.status !== "ready") {
    return searchQueries.map((searchQuery) => emptyResult({ query: searchQuery, companyId: company.key, companyName: company.entry.companyName, reason: "vector_search_not_ready", totalActive: activeLedgers.length }));
  }

  const limit = clampTopK(topK);
  try {
    if (typeof embedTexts !== "function") throw new Error("Secure AI embedding service is unavailable.");
    const embeddings = await embedTexts(searchQueries, "search_query");
    if (!Array.isArray(embeddings) || embeddings.length !== searchQueries.length) throw new Error("The AI embedding service returned an incomplete batch.");
    const { vectorDir } = getLocalDbPaths({ appUserDataPath, baseDir });
    const batches = await queryZvecBatch({ vectorDir, companyKey: company.key, embeddings, topK: limit });
    return searchQueries.map((searchQuery, index) => resultFromDocuments({ searchQuery, company, activeLedgers, documents: batches[index], limit }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return searchQueries.map((searchQuery) => emptyResult({ query: searchQuery, companyId: company.key, companyName: company.entry.companyName, reason: "vector_search_unavailable", error: message, totalActive: activeLedgers.length }));
  }
}
