import type { CaseDoc, FieldKey, Mismatch, MismatchValue } from "@/types/pipeline";
import { getFieldKeysForDocType, shouldConsiderFieldKey } from "@/lib/document-schema";
import {
  DEFAULT_COMPARISON_OPTIONS,
  getComparableFieldValue,
  normalizeComparableValue,
  PRIMARY_COMPARISON_FIELDS,
} from "@/lib/comparison";
import type { ComparisonOptions } from "@/types/pipeline";

const PRESENCE_CHECK_FIELDS = new Set<FieldKey>(["eWayBillNumber"]);

function shouldExpectField(doc: CaseDoc, field: FieldKey) {
  return (
    shouldConsiderFieldKey(field, doc.type) &&
    getFieldKeysForDocType(doc.type).includes(field)
  );
}

function buildMismatch(
  field: FieldKey,
  docs: CaseDoc[],
  comparisonOptions: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
): Omit<Mismatch, "analysis" | "fixPlan"> | null {
  const values = docs
    .filter((doc) => shouldExpectField(doc, field))
    .map((doc) => ({
      docId: doc.id,
      value: getComparableFieldValue(doc, field),
    }));
  const populated = values.filter((entry) => entry.value !== undefined && entry.value !== null && String(entry.value).trim() !== "");
  const missing = values.filter((entry) => entry.value === undefined || entry.value === null || String(entry.value).trim() === "");
  const unique = new Set(
    populated
      .map((entry) => normalizeComparableValue(entry.value, comparisonOptions))
      .filter(Boolean)
  );
  const hasConflictingValues = populated.length >= 2 && unique.size > 1;
  const hasRequiredFieldGap =
    PRESENCE_CHECK_FIELDS.has(field) && populated.length >= 1 && missing.length >= 1;

  if (!hasConflictingValues && !hasRequiredFieldGap) return null;

  return {
    id: `mismatch-${field}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    field,
    values: (hasRequiredFieldGap ? values : populated) as MismatchValue[],
  };
}

export function verifyCaseDocuments(
  docs: CaseDoc[],
  comparisonOptions: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
): Omit<Mismatch, "analysis" | "fixPlan">[] {
  const mismatches: Omit<Mismatch, "analysis" | "fixPlan">[] = [];

  for (const field of PRIMARY_COMPARISON_FIELDS) {
    const docTypesWithField = [...new Set(docs.map(d => d.type))];
    const shouldCheck = docTypesWithField.some(dt => shouldConsiderFieldKey(field, dt));
    if (!shouldCheck) continue;
    
    const mismatch = buildMismatch(field, docs, comparisonOptions);
    if (mismatch) mismatches.push(mismatch);
  }

  return mismatches;
}
