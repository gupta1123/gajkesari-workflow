import assert from "node:assert/strict";
import test from "node:test";

import { parseDocumentAndSuggestLedgers } from "./parse-and-suggest.mjs";

test("parses once, batches vector retrieval, and returns candidates without duplicating transactions", async () => {
  const transactions = Array.from({ length: 300 }, (_, index) => ({
    description: `Narration ${index + 1}`,
    transaction_date: "2026-09-12",
  }));
  const batches = [];
  const result = await parseDocumentAndSuggestLedgers(
    { base64: "unused", companyName: "Solution Nyx", topK: 10 },
    {
      parseDocument: async (payload) => {
        assert.equal(payload.output, "json");
        return { outputFormat: "json", content: { account: {}, transactions } };
      },
      suggestLedgersBatch: async ({ queries, companyName, topK }) => {
        batches.push(queries.length);
        assert.equal(companyName, "Solution Nyx");
        assert.equal(topK, 10);
        return queries.map((query) => ({
          query,
          suggestions: [{ ledgerName: `Ledger for ${query}`, vectorScore: 0.9 }],
        }));
      },
    }
  );

  assert.deepEqual(batches, [256, 44]);
  assert.equal(result.matching.length, 300);
  assert.equal(result.matching[299].suggestions[0].ledgerName, "Ledger for Narration 300");
  assert.equal("transactions" in result, false);
  assert.equal(result.schemaVersion, 2);
});
