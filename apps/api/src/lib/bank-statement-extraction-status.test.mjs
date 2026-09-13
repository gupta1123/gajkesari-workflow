import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("./bank-statement-extraction-status.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { isBankStatementExtractionIncomplete } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

test("complete extraction is not failed merely because ledger review is required", () => {
  assert.equal(isBankStatementExtractionIncomplete({
    effectiveImportStatus: "manual_review_required",
    transactionCount: 150,
    extractionDiagnostics: { coverageComplete: true, unresolvedPages: [] },
  }), false);
});

test("incomplete coverage and zero-row results remain blocked", () => {
  assert.equal(isBankStatementExtractionIncomplete({
    effectiveImportStatus: "manual_review_required",
    transactionCount: 150,
    extractionDiagnostics: { coverageComplete: false, unresolvedPages: [8] },
  }), true);
  assert.equal(isBankStatementExtractionIncomplete({
    effectiveImportStatus: "ready_to_review",
    transactionCount: 0,
    extractionDiagnostics: { coverageComplete: true },
  }), true);
});

test("legacy explicit extraction-review flags remain conservative without coverage evidence", () => {
  assert.equal(isBankStatementExtractionIncomplete({
    effectiveImportStatus: "ready_to_review",
    transactionCount: 10,
    extractionDiagnostics: {},
    legacyRequiresManualExtraction: true,
  }), true);
});

test("metadata polling does not repeat full Tally-ledger resolution", async () => {
  const route = await readFile(
    new URL("../app/api/bank-statements/imports/[id]/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /const bankLedgerResolution = processing \|\| !includeTransactions/);
  assert.match(route, /source: processing \? "analysis_processing" : "metadata_only"/);
});

test("bank-ledger resolution uses the active connector cache regardless of cache age", async () => {
  const route = await readFile(
    new URL("../app/api/bank-statements/imports/[id]/route.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(route, /tallyMasterFreshnessCutoff/);
  assert.match(route, /\.eq\("is_active", true\)/);
  assert.match(route, /query\.eq\("company_dataset_id", companyDatasetId\)/);
});
