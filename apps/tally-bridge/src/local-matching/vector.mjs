import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getLocalDbPaths, normalizeCompanyKey, saveLocalDb } from "./store.mjs";

export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 512;
const VECTOR_VERSION = 3;
const BATCH_SIZE = 256;

const packageCandidates = () => [
  path.join(process.cwd(), "node_modules", "@zvec", "zvec", "package.json"),
  path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "..", "node_modules", "@zvec", "zvec", "package.json"),
  path.join(process.cwd(), "resources", "app", "node_modules", "@zvec", "zvec", "package.json"),
];

export function isZvecAvailable() {
  try { return packageCandidates().some((candidate) => fs.existsSync(candidate)); } catch { return false; }
}

export function getZvecPackageVersion() {
  try {
    for (const candidate of packageCandidates()) {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8")).version || null;
    }
  } catch {}
  return null;
}

export function getVectorEngine() {
  const available = isZvecAvailable();
  return { engine: "zvec", available, version: getZvecPackageVersion(), model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS,
    reason: available ? "AI semantic vector search is available" : "Zvec is not installed" };
}

async function loadZvec() {
  try { return await import("@zvec/zvec"); }
  catch (error) {
    try {
      const alternate = path.join(process.cwd(), "resources", "app", "node_modules", "@zvec", "zvec");
      if (fs.existsSync(alternate)) return await import(alternate);
    } catch {}
    throw Object.assign(new Error(`Zvec unavailable: ${error.message || String(error)}`), { code: "ZVEC_UNAVAILABLE" });
  }
}

function getCollectionPath(vectorDir, companyKey) {
  return path.join(vectorDir, "zvec", companyKey.replace(/[:]/g, "_"));
}

function getManifestPath(vectorDir, companyKey) {
  return path.join(vectorDir, "zvec", `${companyKey.replace(/[:]/g, "_")}.manifest.json`);
}

function ledgerFingerprint(ledger) {
  return crypto.createHash("sha256").update(JSON.stringify([
    ledger.master_key, ledger.tally_name, ledger.parent_name || "", Boolean(ledger.is_active),
  ])).digest("hex");
}

function emptyManifest() {
  return { version: VECTOR_VERSION, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, fingerprints: {} };
}

function loadManifest(vectorDir, companyKey) {
  const file = getManifestPath(vectorDir, companyKey);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.version === VECTOR_VERSION && value.model === EMBEDDING_MODEL && value.dimensions === EMBEDDING_DIMENSIONS && value.fingerprints) return value;
  } catch {}
  return null;
}

function saveManifest(vectorDir, companyKey, manifest) {
  const file = getManifestPath(vectorDir, companyKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function safeDocumentId(masterKey) {
  return `ledger_${crypto.createHash("sha256").update(String(masterKey)).digest("hex").slice(0, 32)}`;
}

function embeddingText(ledger) {
  return `Ledger: ${ledger.tally_name}\nGroup: ${ledger.parent_name || "Unspecified"}`;
}

function validateEmbedding(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding provider returned an invalid vector; expected ${EMBEDDING_DIMENSIONS} finite values.`);
  }
  return vector;
}

function apiFrom(mod) {
  return {
    create: mod.ZVecCreateAndOpen || mod.createAndOpen || mod.create_and_open || mod.default?.ZVecCreateAndOpen,
    open: mod.ZVecOpen || mod.open || mod.default?.ZVecOpen || mod.default?.open,
    Schema: mod.ZVecCollectionSchema || mod.CollectionSchema || mod.default?.CollectionSchema,
    DataType: mod.ZVecDataType || mod.DataType || mod.default?.DataType,
    IndexType: mod.ZVecIndexType || mod.IndexType || { FLAT: 3 },
    Metric: mod.ZVecMetricType || mod.MetricType || { COSINE: 3 },
  };
}

async function createCollection(vectorDir, companyKey) {
  const api = apiFrom(await loadZvec());
  if (!api.create || !api.Schema) throw new Error("Installed Zvec API is not compatible with this connector.");
  const target = getCollectionPath(vectorDir, companyKey);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  const schema = new api.Schema({
    name: `ledgers_${companyKey.replace(/[^a-z0-9]/gi, "_")}`,
    fields: [
      { name: "ledgerName", dataType: api.DataType?.STRING ?? 2 },
      { name: "parentGroup", dataType: api.DataType?.STRING ?? 2 },
      { name: "isActive", dataType: api.DataType?.BOOL ?? 3 },
      { name: "tallyGuid", dataType: api.DataType?.STRING ?? 2 },
      { name: "masterKey", dataType: api.DataType?.STRING ?? 2 },
    ],
    vectors: [{ name: "embedding", dataType: api.DataType?.VECTOR_FP32 ?? 23, dimension: EMBEDDING_DIMENSIONS,
      indexParam: { indexType: api.IndexType.FLAT ?? 3, metricType: api.Metric.COSINE ?? 3 } }],
  });
  const collection = await api.create(target, schema);
  if (!collection) throw new Error("Zvec could not create the ledger collection.");
  return collection;
}

async function openCollection(vectorDir, companyKey) {
  const api = apiFrom(await loadZvec());
  const target = getCollectionPath(vectorDir, companyKey);
  if (!api.open || !fs.existsSync(target)) return null;
  try { return await api.open(target); } catch { return null; }
}

export function getVectorStatus(db, { companyName, companyGuid }) {
  const key = normalizeCompanyKey({ companyGuid, companyName });
  const value = db.companies[key]?.vector || { status: "idle", lastVectorisedAt: null, vectorCount: 0, engine: "zvec", error: null };
  return { companyKey: key, ...value, engine: "zvec", engineDetail: getVectorEngine(), isZvecAvailable: isZvecAvailable(), zvecVersion: getZvecPackageVersion() };
}

export async function vectoriseCompany({ db, companyName, companyGuid, appUserDataPath, baseDir, onProgress, embedTexts } = {}) {
  const key = normalizeCompanyKey({ companyGuid, companyName });
  const entry = db.companies[key];
  if (!entry) throw new Error("No local ledgers found for this company. Sync first.");
  if (!isZvecAvailable()) throw new Error("Zvec is unavailable. Reinstall the latest connector.");
  if (typeof embedTexts !== "function") throw new Error("Secure AI embedding service is unavailable. Reconnect the connector and try again.");
  const ledgers = Object.values(entry.ledgers || {}).filter((ledger) => ledger.is_active);
  const { vectorDir } = getLocalDbPaths({ appUserDataPath, baseDir });
  const startedAt = Date.now();
  const target = getCollectionPath(vectorDir, key);
  let manifest = loadManifest(vectorDir, key);
  let collection;
  if (!manifest && fs.existsSync(target) && entry.vector?.status === "indexing" &&
      entry.vector?.embeddingModel === EMBEDDING_MODEL && entry.vector?.dimensions === EMBEDDING_DIMENSIONS) {
    const completed = Math.max(0, Math.min(Number(entry.vector.indexedCount) || 0, ledgers.length));
    manifest = emptyManifest();
    for (const ledger of ledgers.slice(0, completed)) manifest.fingerprints[ledger.master_key] = ledgerFingerprint(ledger);
    saveManifest(vectorDir, key, manifest);
  }
  if (manifest) collection = await openCollection(vectorDir, key);
  if (!collection) {
    manifest = emptyManifest();
    collection = await createCollection(vectorDir, key);
    saveManifest(vectorDir, key, manifest);
  }
  const pendingLedgers = ledgers.filter((ledger) => manifest.fingerprints[ledger.master_key] !== ledgerFingerprint(ledger));
  const alreadyDone = ledgers.length - pendingLedgers.length;
  entry.vector = { status: "indexing", engine: "zvec", embeddingModel: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS,
    version: VECTOR_VERSION, vectorCount: alreadyDone, indexedCount: alreadyDone,
    progress: { done: alreadyDone, total: ledgers.length }, error: null };
  saveLocalDb(db, { appUserDataPath, baseDir });
  onProgress?.({ phase: "embedding", done: alreadyDone, total: ledgers.length });
  try {
    for (let offset = 0; offset < pendingLedgers.length; offset += BATCH_SIZE) {
      const batch = pendingLedgers.slice(offset, offset + BATCH_SIZE);
      const embeddings = await embedTexts(batch.map(embeddingText), "search_document");
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) throw new Error("Embedding provider returned the wrong number of vectors.");
      const documents = batch.map((ledger, index) => ({
        id: safeDocumentId(ledger.master_key), vectors: { embedding: validateEmbedding(embeddings[index]) },
        fields: { ledgerName: ledger.tally_name, parentGroup: ledger.parent_name || "", isActive: true,
          tallyGuid: ledger.tally_guid || "", masterKey: ledger.master_key },
      }));
      if (collection.upsert) await collection.upsert(documents);
      else if (collection.upsertSync) collection.upsertSync(documents);
      else if (collection.insert) await collection.insert(documents);
      else if (collection.insertSync) collection.insertSync(documents);
      else throw new Error("Installed Zvec does not support document insertion.");
      for (const ledger of batch) manifest.fingerprints[ledger.master_key] = ledgerFingerprint(ledger);
      saveManifest(vectorDir, key, manifest);
      const done = Math.min(alreadyDone + offset + batch.length, ledgers.length);
      entry.vector.progress = { done, total: ledgers.length };
      entry.vector.indexedCount = done;
      entry.vector.vectorCount = done;
      saveLocalDb(db, { appUserDataPath, baseDir });
      onProgress?.({ phase: "embedding", done, total: ledgers.length });
    }
    try { if (collection.optimize) await collection.optimize(); else collection.optimizeSync?.(); } catch {}
    entry.vector = { status: "ready", engine: "zvec", embeddingModel: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS,
      embeddingSource: "openrouter", version: VECTOR_VERSION, lastVectorisedAt: new Date().toISOString(), vectorCount: ledgers.length,
      indexedCount: ledgers.length, progress: { done: ledgers.length, total: ledgers.length },
      result: { elapsedMs: Date.now() - startedAt, mode: pendingLedgers.length ? "incremental" : "up-to-date",
        embeddedCount: pendingLedgers.length, skippedCount: alreadyDone, docCount: ledgers.length }, error: null, zvecVersion: getZvecPackageVersion() };
    saveLocalDb(db, { appUserDataPath, baseDir });
    return { ...entry.vector, companyKey: key };
  } catch (error) {
    entry.vector = { ...entry.vector, status: "error", vectorCount: 0, error: error instanceof Error ? error.message : String(error) };
    saveLocalDb(db, { appUserDataPath, baseDir });
    throw error;
  } finally {
    try { if (collection?.closeSync) collection.closeSync(); else await collection?.close?.(); } catch {}
  }
}

export async function clearVectorIndex({ db, companyName, companyGuid, appUserDataPath, baseDir }) {
  const key = normalizeCompanyKey({ companyGuid, companyName });
  const { vectorDir } = getLocalDbPaths({ appUserDataPath, baseDir });
  const target = getCollectionPath(vectorDir, key);
  const manifest = getManifestPath(vectorDir, key);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  if (fs.existsSync(manifest)) fs.rmSync(manifest, { force: true });
  if (db.companies[key]) {
    db.companies[key].vector = { status: "idle", lastVectorisedAt: null, vectorCount: 0, engine: "zvec", error: null };
    saveLocalDb(db, { appUserDataPath, baseDir });
  }
  return { cleared: true };
}

export async function queryZvec({ vectorDir, companyKey, embedding, topK = 10 }) {
  const vector = validateEmbedding(embedding);
  const api = apiFrom(await loadZvec());
  const target = getCollectionPath(vectorDir, companyKey);
  if (!fs.existsSync(target)) throw new Error("Vectorise the ledgers before searching.");
  let collection;
  try {
    collection = api.open ? await api.open(target) : await api.create?.(target);
    if (!collection?.query) throw new Error("Installed Zvec does not support vector queries.");
    const response = await collection.query({ fieldName: "embedding", vector, topk: topK });
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.results)) return response.results;
    if (Array.isArray(response?.docs)) return response.docs;
    if (Array.isArray(response?.data)) return response.data;
    return [];
  } finally {
    try { if (collection?.closeSync) collection.closeSync(); else await collection?.close?.(); } catch {}
  }
}
