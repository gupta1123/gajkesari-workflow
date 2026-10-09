import type { SupabaseClient } from "@supabase/supabase-js";

export const existingVoucherClaimReason = "This Tally voucher already accounts for another statement entry. Check whether this row is a separate transaction.";

export function existingVoucherClaimConflict(result: Record<string, unknown>, transactionId: string,
  claims: Array<{ source_transaction_id: string | null }>) {
  const check = result.duplicateCheck as Record<string, unknown> | undefined;
  return result.alreadyInTally === true && Number(result.created ?? 0) === 0 &&
    check?.matchBasis !== "reference" && claims.some(claim => claim.source_transaction_id !== transactionId);
}

export function heldExistingVoucherResult(result: Record<string, unknown>) {
  const check = result.duplicateCheck as Record<string, unknown> | undefined;
  return { ...result, alreadyInTally: false, created: 0, verificationStatus: "ambiguous",
    possibleDuplicateInTally: true, reconciliationRequired: true,
    duplicateCheck: { ...check, verificationStatus: "ambiguous", reason: existingVoucherClaimReason } };
}

// Same-batch reservations live in the connector. This also protects matches
// whose owning row was already confirmed and therefore was not queued again.
export async function protectExistingVoucherClaim(db: SupabaseClient, scope: {
  ownerId: string; companyDatasetId: string; transactionId: string; commandId: string;
}, result: Record<string, unknown>) {
  const check = result.duplicateCheck as Record<string, unknown> | undefined;
  const voucherId = result.voucherId ?? check?.voucherId;
  if (result.alreadyInTally !== true || Number(result.created ?? 0) !== 0 ||
    check?.matchBasis === "reference" || !voucherId || !scope.transactionId) return result;
  const { data: claims, error } = await db.from("bank_transaction_posting_log")
    .select("source_transaction_id").eq("owner_user_id", scope.ownerId)
    .eq("company_dataset_id", scope.companyDatasetId).eq("status", "verified")
    .eq("tally_voucher_id", String(voucherId)).neq("command_id", scope.commandId);
  if (error) throw error;
  return existingVoucherClaimConflict(result, scope.transactionId, claims ?? []) ? heldExistingVoucherResult(result) : result;
}
