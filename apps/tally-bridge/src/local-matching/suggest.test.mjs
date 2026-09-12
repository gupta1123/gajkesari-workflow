import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadLocalDb, saveLocalDb, upsertLedgers } from "./store.mjs";
import { suggestLedgers, suggestLedgersBatch } from "./suggest.mjs";

function tmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gajkesari-vector-only-test-"));
}

function clean(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {}
}

function seedDb(baseDir) {
  const db = loadLocalDb({ baseDir });
  upsertLedgers({
    db,
    companyName: "TestCo",
    companyGuid: "test-guid",
    ledgers: [
      { name: "Aarav Steel Traders", guid: "g1", parent: "Sundry Debtors" },
      { name: "Bharat Steel Traders", guid: "g2", parent: "Sundry Debtors" },
    ],
  });
  saveLocalDb(db, { baseDir });
  return db;
}

test("empty query returns no result without invoking another search method", async () => {
  const baseDir = tmpBase();
  seedDb(baseDir);
  const result = await suggestLedgers({ query: "", companyId: "test-guid", baseDir });
  assert.equal(result.isEmpty, true);
  assert.equal(result.emptyReason, "empty_query");
  assert.equal(result.meta.searchMode, "vector_only");
  assert.equal(result.meta.vectorEngine, "zvec");
  assert.equal(result.meta.usedAI, true);
  clean(baseDir);
});
test("missing vector index never falls back to name or full-text matching", async () => {
  const baseDir = tmpBase();
  seedDb(baseDir);
  const result = await suggestLedgers({
    query: "Aarav Steel Traders",
    companyId: "test-guid",
    baseDir,
  });
  assert.equal(result.isEmpty, true);
  assert.equal(result.emptyReason, "vector_search_not_ready");
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.meta.searchMode, "vector_only");
  assert.equal(result.meta.vectorEngine, "zvec");
  clean(baseDir);
});

test("AI and force-FTS inputs cannot enable alternate matching", async () => {
  const baseDir = tmpBase();
  seedDb(baseDir);
  const previousForceFts = process.env.LOCAL_MATCHING_FORCE_FTS;
  process.env.LOCAL_MATCHING_FORCE_FTS = "true";
  const result = await suggestLedgers({
    narration: "Aarav",
    companyId: "test-guid",
    useAI: true,
    baseDir,
  });
  assert.equal(result.isEmpty, true);
  assert.equal(result.meta.usedAI, true);
  assert.equal(result.meta.vectorEngine, "zvec");
  assert.equal(result.meta.searchMode, "vector_only");
  if (previousForceFts == null) delete process.env.LOCAL_MATCHING_FORCE_FTS;
  else process.env.LOCAL_MATCHING_FORCE_FTS = previousForceFts;
  clean(baseDir);
});

test("result limit remains capped without exposing another search path", async () => {
  const baseDir = tmpBase();
  seedDb(baseDir);
  const result = await suggestLedgers({
    narration: "Steel",
    companyId: "test-guid",
    topK: 100,
    baseDir,
  });
  assert.equal(result.isEmpty, true);
  assert.equal(result.meta.searchMode, "vector_only");
  assert.ok(!JSON.stringify(result).includes("fts"));
  assert.ok(!JSON.stringify(result).includes("deterministic"));
  clean(baseDir);
});

test("batch vector search validates its bounded request", async () => {
  await assert.rejects(() => suggestLedgersBatch({ queries: [] }), /1-256 queries/);
  await assert.rejects(() => suggestLedgersBatch({ queries: Array(257).fill("ledger") }), /1-256 queries/);
  await assert.rejects(() => suggestLedgersBatch({ queries: ["ledger", " "] }), /must contain text/);
});

test("batch vector search does not invoke embeddings when the index is unavailable", async () => {
  const baseDir = tmpBase();
  seedDb(baseDir);
  let embeddingCalls = 0;
  const results = await suggestLedgersBatch({
    queries: ["Aarav", "Bharat"],
    companyId: "test-guid",
    baseDir,
    embedTexts: async () => { embeddingCalls += 1; return []; },
  });
  assert.equal(embeddingCalls, 0);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.emptyReason === "vector_search_not_ready"));
  assert.ok(results.every((result) => result.meta.searchMode === "vector_only"));
  clean(baseDir);
});
