import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadLocalDb, saveLocalDb, upsertLedgers } from "./store.mjs";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, getVectorEngine, getVectorStatus, vectoriseCompany } from "./vector.mjs";

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
