import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getLocalDbPaths, loadLocalDb, saveLocalDb, upsertLedgers } from "./store.mjs";
import { closeZvecCollections, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, getVectorEngine, getVectorStatus, queryZvec, vectoriseCompany } from "./vector.mjs";

function tmpBase() { return fs.mkdtempSync(path.join(os.tmpdir(), "gajkesari-vector-test-")); }
function clean(directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} }

test("semantic vector configuration uses the selected OpenRouter model", () => {
  assert.equal(EMBEDDING_MODEL, "openai/text-embedding-3-small");
  assert.equal(EMBEDDING_DIMENSIONS, 512);
  const engine = getVectorEngine();
  assert.equal(engine.engine, "zvec");
  assert.equal(engine.model, EMBEDDING_MODEL);
  assert.equal(engine.dimensions, EMBEDDING_DIMENSIONS);
});

test("vectorisation cannot silently use a local or full-text fallback", async () => {
  const baseDir = tmpBase();
  const db = loadLocalDb({ baseDir });
  upsertLedgers({ db, companyName: "VecCo", companyGuid: "vec-guid", ledgers: [{ name: "Customer A", guid: "a1" }] });
  saveLocalDb(db, { baseDir });
  await assert.rejects(
    () => vectoriseCompany({ db, companyName: "VecCo", companyGuid: "vec-guid", baseDir }),
    /embedding service|Zvec is unavailable/i,
  );
  const status = getVectorStatus(db, { companyName: "VecCo", companyGuid: "vec-guid" });
  assert.notEqual(status.engine, "fts");
  clean(baseDir);
});

test("empty companies still require a ledger sync", async () => {
  const baseDir = tmpBase();
  const db = loadLocalDb({ baseDir });
  await assert.rejects(() => vectoriseCompany({ db, companyName: "Missing", companyGuid: "missing", baseDir }), /Sync first/);
  clean(baseDir);
});

test("an open Zvec collection remains queryable until connector shutdown", { skip: !getVectorEngine().available }, async () => {
  const baseDir = tmpBase();
  const db = loadLocalDb({ baseDir });
  upsertLedgers({ db, companyName: "CacheCo", companyGuid: "cache-guid", ledgers: [{ name: "Cached Customer", guid: "cache-1" }] });
  const embedding = Array(EMBEDDING_DIMENSIONS).fill(0);
  embedding[0] = 1;
  await vectoriseCompany({
    db,
    companyName: "CacheCo",
    companyGuid: "cache-guid",
    baseDir,
    embedTexts: async (inputs) => inputs.map(() => embedding),
  });
  const { vectorDir } = getLocalDbPaths({ baseDir });
  const options = { vectorDir, companyKey: "guid:cache-guid", embedding, topK: 1 };
  assert.equal((await queryZvec(options)).length, 1);
  assert.equal((await queryZvec(options)).length, 1);
  await closeZvecCollections();
  clean(baseDir);
});

test("full reconciliation removes inactive ledgers from the persistent vector index", { skip: !getVectorEngine().available }, async () => {
  const baseDir = tmpBase();
  const db = loadLocalDb({ baseDir });
  upsertLedgers({
    db,
    companyName: "DeleteCo",
    companyGuid: "delete-guid",
    ledgers: [{ name: "Keep Customer", guid: "keep-1" }, { name: "Deleted Customer", guid: "delete-1" }],
    mode: "full_snapshot",
  });
  const keepEmbedding = Array(EMBEDDING_DIMENSIONS).fill(0);
  keepEmbedding[0] = 1;
  const deleteEmbedding = Array(EMBEDDING_DIMENSIONS).fill(0);
  deleteEmbedding[1] = 1;
  await vectoriseCompany({
    db,
    companyName: "DeleteCo",
    companyGuid: "delete-guid",
    baseDir,
    embedTexts: async (inputs) => inputs.map((input) => input.includes("Deleted Customer") ? deleteEmbedding : keepEmbedding),
  });
  upsertLedgers({
    db,
    companyName: "DeleteCo",
    companyGuid: "delete-guid",
    ledgers: [{ name: "Keep Customer", guid: "keep-1" }],
    mode: "full_snapshot",
  });
  const result = await vectoriseCompany({
    db,
    companyName: "DeleteCo",
    companyGuid: "delete-guid",
    baseDir,
    embedTexts: async () => { throw new Error("deletion cleanup must not request embeddings"); },
  });
  assert.equal(result.result.deletedCount, 1);
  assert.equal(result.result.embeddedCount, 0);
  assert.equal(result.vectorCount, 1);
  const { vectorDir } = getLocalDbPaths({ baseDir });
  assert.equal((await queryZvec({ vectorDir, companyKey: "guid:delete-guid", embedding: deleteEmbedding, topK: 10 })).length, 1);
  assert.equal((await queryZvec({ vectorDir, companyKey: "guid:delete-guid", embedding: deleteEmbedding, topK: 10 }))[0].fields.ledgerName, "Keep Customer");
  await closeZvecCollections();
  clean(baseDir);
});
