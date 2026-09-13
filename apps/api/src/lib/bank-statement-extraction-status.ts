type ExtractionStatusInput = {
  effectiveImportStatus: string;
  processing?: boolean;
  transactionCount: number;
  extractionDiagnostics?: Record<string, unknown> | null;
  legacyRequiresManualExtraction?: boolean;
};

export function isBankStatementExtractionIncomplete({
  effectiveImportStatus,
  processing = false,
  transactionCount,
  extractionDiagnostics,
  legacyRequiresManualExtraction = false,
}: ExtractionStatusInput) {
  if (processing) return false;
  if (effectiveImportStatus === "failed") return true;
  if (transactionCount <= 0) return true;

  const coverageComplete = extractionDiagnostics?.coverageComplete;
  if (coverageComplete === true) return false;
  if (coverageComplete === false) return true;

  // Older jobs did not record page coverage. Preserve their explicit/manual
  // extraction flag, but do not confuse a ledger-review status with failed
  // extraction when modern coverage evidence says the document is complete.
  return legacyRequiresManualExtraction || effectiveImportStatus === "manual_review_required";
}
