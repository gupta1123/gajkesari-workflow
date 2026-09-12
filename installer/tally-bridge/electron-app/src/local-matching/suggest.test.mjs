import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadLocalDb, saveLocalDb, upsertLedgers } from "./store.mjs";
import { suggestLedgers } from "./suggest.mjs";

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
