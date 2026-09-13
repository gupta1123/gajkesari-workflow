import { performance } from "node:perf_hooks";

import { suggestLedgersBatch } from "../local-matching/suggest.mjs";
import { parseDocumentLocal } from "./parser.mjs";

const MAX_VECTOR_BATCH_SIZE = 256;

export async function parseDocumentAndSuggestLedgers(payload = {}, options = {}) {
  const parse = options.parseDocument || parseDocumentLocal;
  const suggestBatch = options.suggestLedgersBatch || suggestLedgersBatch;
  const startedAt = performance.now();
  const parseStartedAt = performance.now();
  const parsed = await parse({ ...payload, output: "json" });
  const parseMs = performance.now() - parseStartedAt;
  const transactions = Array.isArray(parsed?.content?.transactions)
    ? parsed.content.transactions
    : [];
  const queries = transactions.map((transaction) => String(transaction?.description || "").trim());

  if (!queries.length) throw new Error("The document contains no transactions to match.");
  if (queries.some((query) => !query)) {
    throw new Error("Every parsed transaction must have a description for vector search.");
  }

  const searchStartedAt = performance.now();
  const matches = [];
  for (let offset = 0; offset < queries.length; offset += MAX_VECTOR_BATCH_SIZE) {
    matches.push(...await suggestBatch({
      queries: queries.slice(offset, offset + MAX_VECTOR_BATCH_SIZE),
      companyId: payload.companyId || payload.companyGuid || null,
      companyName: payload.companyName || null,
      companyGuid: payload.companyGuid || null,
      topK: payload.topK || payload.top_k || 10,
      appUserDataPath: options.appUserDataPath,
      baseDir: options.baseDir,
      embedTexts: options.embedTexts,
    }));
  }
  const vectorSearchMs = performance.now() - searchStartedAt;

  return {
    schemaVersion: 2,
    parsed,
    // Do not repeat every parsed transaction with suggestions attached. The
    // worker consumes `parsed.content.transactions` and the same-position
    // `matching` array; keeping both representations nearly doubled the result.
    matching: matches,
    timing: {
      parseMs: Number(parseMs.toFixed(2)),
      vectorSearchMs: Number(vectorSearchMs.toFixed(2)),
      totalMs: Number((performance.now() - startedAt).toFixed(2)),
    },
  };
}
