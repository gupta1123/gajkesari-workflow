const BANK_STATEMENT_COMPANY_SELECTION_KEY =
  "gajkesari.bankStatements.selectedCompany.v1";
const SELECTED_CONNECTION_STORAGE_KEY = "gajkesari:selected-tally-connection";

type StoredTallyCompanySelection = {
  id?: unknown;
  connectionId?: unknown;
  companyName?: unknown;
  financialYear?: unknown;
};

export function readPreferredTallyConnectionId() {
  if (typeof window === "undefined") return null;

  try {
    const selectedConnectorId = window.localStorage
      .getItem(SELECTED_CONNECTION_STORAGE_KEY)
      ?.trim();
    if (selectedConnectorId) return selectedConnectorId;

    const raw = window.localStorage.getItem(
      BANK_STATEMENT_COMPANY_SELECTION_KEY
    );
    if (!raw) return null;

    const selection = JSON.parse(raw) as StoredTallyCompanySelection;
    return typeof selection.connectionId === "string" &&
      selection.connectionId.trim()
      ? selection.connectionId.trim()
      : null;
  } catch {
    return null;
  }
}
