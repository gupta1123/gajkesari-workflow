import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_SECRET = process.env.WORKER_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";

const args = process.argv.slice(2);
const shouldReingest = args.includes("--reingest");
const includeReingestRequired = args.includes("--include-reingest-required");
const selectedCaseName = getFlagValue("case");
const fixturePath = path.resolve(getFlagValue("fixtures") || "quality/packet-regression-cases.json");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

if (shouldReingest && !WORKER_SECRET) {
  throw new Error("Missing WORKER_SECRET. It is required when using --reingest.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function getFlagValue(name) {
  const prefix = `--${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

async function loadFixtures() {
  const raw = await readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw);
  const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
  if (selectedCaseName) {
    return cases.filter((entry) => entry.name === selectedCaseName || entry.caseId === selectedCaseName);
  }
  return cases.filter((entry) => shouldReingest || includeReingestRequired || !entry.requiresReingest);
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  const compact = String(value).replace(/[₹$€£,\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(compact)) return null;
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAmountExpectation(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "amount" in value);
}

function valuesMatch(actual, expected) {
  if (isAmountExpectation(expected)) {
    const actualAmount = parseAmount(actual);
    const expectedAmount = parseAmount(expected.amount);
    return (
      actualAmount !== null &&
      expectedAmount !== null &&
      Math.abs(actualAmount - expectedAmount) <= Math.max(0.01, Math.abs(expectedAmount) * 0.0001)
    );
  }

  if (expected && typeof expected === "object" && Array.isArray(expected.oneOf)) {
    return expected.oneOf.some((candidate) => valuesMatch(actual, candidate));
  }

  return String(actual ?? "") === String(expected ?? "");
}

function formatExpected(expected) {
  if (isAmountExpectation(expected)) return String(expected.amount);
  if (expected && typeof expected === "object" && Array.isArray(expected.oneOf)) return expected.oneOf.join(" | ");
  return String(expected ?? "");
}

function assertValue(errors, pathLabel, actual, expected) {
  if (!valuesMatch(actual, expected)) {
    errors.push(`${pathLabel}: expected ${formatExpected(expected)}, got ${actual ?? "<missing>"}`);
  }
}

function getLineItems(document) {
  return Array.isArray(document.extracted_fields?.__lineItems) ? document.extracted_fields.__lineItems : [];
}

function findLineItem(document, lineExpectation) {
  const lineItems = getLineItems(document);
  const match = lineExpectation.match || {};
  return lineItems.find((item) =>
    Object.entries(match).every(([field, expected]) => valuesMatch(item[field], expected))
  );
}

async function reingestCase(regressionCase) {
  const { data: caseRow, error: caseError } = await supabase
    .from("packet_cases")
    .select("id, owner_user_id, display_name, processing_meta")
    .eq("id", regressionCase.caseId)
    .single();
  if (caseError) throw caseError;

  const comparisonOptions = caseRow.processing_meta?.comparisonOptions ?? { considerFormatting: false };
  const analysisMode = caseRow.processing_meta?.analysisMode === "smart_split" ? "smart_split" : "standard";
  const { data: job, error: jobError } = await supabase
    .from("packet_processing_jobs")
    .insert({
      case_id: regressionCase.caseId,
      owner_user_id: caseRow.owner_user_id,
      job_type: "case_analysis",
      status: "running",
      attempt_count: 1,
      max_attempts: 1,
      progress: 0,
      stage: `Running packet regression ${regressionCase.name}`,
      error: null,
      locked_at: new Date().toISOString(),
      locked_by: "packet-quality-regressions",
      started_at: new Date().toISOString(),
      result: {
        regression: regressionCase.name,
        analysisMode,
        comparisonOptions,
      },
    })
    .select("*")
    .single();
  if (jobError) throw jobError;

  const response = await fetch(`${APP_BASE_URL}/api/internal/jobs/${job.id}/run`, {
    method: "POST",
    headers: {
      "x-worker-secret": WORKER_SECRET,
    },
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`${regressionCase.name}: job ${job.id} failed ${response.status}: ${responseText}`);
  }

  return job.id;
}

async function fetchCaseState(caseId) {
  const [
    { data: caseRow, error: caseError },
    { data: documents, error: docsError },
    { data: mismatches, error: mismatchError },
  ] = await Promise.all([
    supabase
      .from("packet_cases")
      .select("id, display_name, status, document_count, mismatch_count, risk_score, processing_meta")
      .eq("id", caseId)
      .single(),
    supabase
      .from("packet_documents")
      .select("id, document_type, title, source_file_name, source_hint, extracted_fields")
      .eq("case_id", caseId)
      .order("created_at", { ascending: true }),
    supabase
      .from("packet_mismatches")
      .select("field_name, values_json")
      .eq("case_id", caseId)
      .order("field_name", { ascending: true }),
  ]);

  if (caseError) throw caseError;
  if (docsError) throw docsError;
  if (mismatchError) throw mismatchError;

  return { caseRow, documents: documents || [], mismatches: mismatches || [] };
}

function textContains(actual, expected) {
  return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
}

function documentMatchesExpectation(document, expectedDocument) {
  if (expectedDocument.type && document.document_type !== expectedDocument.type) return false;
  if (expectedDocument.titleIncludes && !textContains(document.title, expectedDocument.titleIncludes)) return false;
  if (expectedDocument.sourceFileName && !valuesMatch(document.source_file_name, expectedDocument.sourceFileName)) return false;
  if (expectedDocument.sourceHintIncludes && !textContains(document.source_hint, expectedDocument.sourceHintIncludes)) return false;
  return true;
}

function validateRegressionCase(regressionCase, state) {
  const errors = [];
  const expectedCase = regressionCase.expectCase || {};

  if ("status" in expectedCase) {
    assertValue(errors, `${regressionCase.name}.case.status`, state.caseRow.status, expectedCase.status);
  }

  if ("mismatchCount" in expectedCase) {
    assertValue(errors, `${regressionCase.name}.case.mismatch_count`, state.caseRow.mismatch_count, {
      amount: expectedCase.mismatchCount,
    });
  }

  if ("maxMismatchCount" in expectedCase && state.caseRow.mismatch_count > expectedCase.maxMismatchCount) {
    errors.push(
      `${regressionCase.name}.case.mismatch_count: expected <= ${expectedCase.maxMismatchCount}, got ${state.caseRow.mismatch_count}`
    );
  }

  if (Array.isArray(expectedCase.missingDocTypes)) {
    const actual = state.caseRow.processing_meta?.missingDocumentGroups ?? [];
    const actualSorted = [...actual].sort();
    const expectedSorted = [...expectedCase.missingDocTypes].sort();
    if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
      errors.push(
        `${regressionCase.name}.case.missingDocTypes: expected ${expectedSorted.join(", ") || "<none>"}, got ${actualSorted.join(", ") || "<none>"}`
      );
    }
  }

  for (const forbiddenMissingDocType of expectedCase.forbiddenMissingDocTypes || []) {
    const actual = state.caseRow.processing_meta?.missingDocumentGroups ?? [];
    if (actual.includes(forbiddenMissingDocType)) {
      errors.push(
        `${regressionCase.name}.case.missingDocTypes: expected not to include ${forbiddenMissingDocType}`
      );
    }
  }

  if (expectedCase.mismatchCount === 0 && state.mismatches.length > 0) {
    errors.push(
      `${regressionCase.name}.packet_mismatches: expected no rows, got ${state.mismatches
        .map((entry) => entry.field_name)
        .join(", ")}`
    );
  }

  for (const [documentType, expectedCount] of Object.entries(regressionCase.documentTypeCounts || {})) {
    const actualCount = state.documents.filter((document) => document.document_type === documentType).length;
    assertValue(
      errors,
      `${regressionCase.name}.documentTypeCounts.${documentType}`,
      actualCount,
      { amount: expectedCount }
    );
  }

  for (const [documentType, maxCount] of Object.entries(regressionCase.maxDocumentTypeCounts || {})) {
    const actualCount = state.documents.filter((document) => document.document_type === documentType).length;
    if (actualCount > maxCount) {
      errors.push(
        `${regressionCase.name}.maxDocumentTypeCounts.${documentType}: expected <= ${maxCount}, got ${actualCount}`
      );
    }
  }

  for (const forbiddenField of regressionCase.forbiddenMismatchFields || []) {
    const matchingMismatches = state.mismatches.filter((entry) => entry.field_name === forbiddenField);
    if (matchingMismatches.length > 0) {
      errors.push(
        `${regressionCase.name}.packet_mismatches.${forbiddenField}: expected no rows, got ${matchingMismatches.length}`
      );
    }
  }

  for (const expectedDocument of regressionCase.documents || []) {
    const document = state.documents.find((entry) => documentMatchesExpectation(entry, expectedDocument));
    if (!document) {
      errors.push(
        `${regressionCase.name}.${expectedDocument.type ?? "document"}${expectedDocument.titleIncludes ? ` title~${expectedDocument.titleIncludes}` : ""}: document not found`
      );
      continue;
    }

    for (const [field, expected] of Object.entries(expectedDocument.fields || {})) {
      assertValue(
        errors,
        `${regressionCase.name}.${expectedDocument.type}.fields.${field}`,
        document.extracted_fields?.[field],
        expected
      );
    }

    if ("lineItemCount" in expectedDocument) {
      assertValue(
        errors,
        `${regressionCase.name}.${expectedDocument.type}.lineItemCount`,
        getLineItems(document).length,
        { amount: expectedDocument.lineItemCount }
      );
    }

    for (const lineExpectation of expectedDocument.lineItems || []) {
      const lineItem = findLineItem(document, lineExpectation);
      const matchLabel = Object.entries(lineExpectation.match || {})
        .map(([key, value]) => `${key}=${formatExpected(value)}`)
        .join(",");
      if (!lineItem) {
        errors.push(`${regressionCase.name}.${expectedDocument.type}.lineItems[${matchLabel}]: line not found`);
        continue;
      }

      for (const [field, expected] of Object.entries(lineExpectation.fields || {})) {
        assertValue(
          errors,
          `${regressionCase.name}.${expectedDocument.type}.lineItems[${matchLabel}].${field}`,
          lineItem[field],
          expected
        );
      }
    }
  }

  return errors;
}

async function main() {
  const regressionCases = await loadFixtures();
  if (!regressionCases.length) {
    throw new Error(selectedCaseName ? `No regression cases matched ${selectedCaseName}` : "No regression cases configured.");
  }

  const failures = [];
  const summaries = [];

  for (const regressionCase of regressionCases) {
    let jobId = null;
    if (shouldReingest) {
      jobId = await reingestCase(regressionCase);
    }

    const state = await fetchCaseState(regressionCase.caseId);
    const errors = validateRegressionCase(regressionCase, state);
    summaries.push({
      name: regressionCase.name,
      caseId: regressionCase.caseId,
      jobId,
      status: state.caseRow.status,
      mismatchCount: state.caseRow.mismatch_count,
      documents: state.documents.map((document) => document.document_type),
      errors,
    });

    failures.push(...errors);
  }

  console.log(JSON.stringify({ ok: failures.length === 0, reingest: shouldReingest, summaries }, null, 2));

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
