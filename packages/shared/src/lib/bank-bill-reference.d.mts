export type BankBillReferenceResult = {
  status: "none" | "matched" | "ambiguous" | "unresolved";
  referenceName: string | null;
  candidateReferences: string[];
  matchKind: "full" | "short" | null;
};
export function resolveBankBillReference(
  bills: ReadonlyArray<{ referenceName: string }>,
  transaction?: { narration?: string | null; referenceNumber?: string | null }
): BankBillReferenceResult;
