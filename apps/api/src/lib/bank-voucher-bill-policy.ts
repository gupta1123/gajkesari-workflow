// Direct vouchers intentionally omit bill references; the connector still runs
// the authoritative duplicate preflight before importing any bank voucher.
export function validateBankVoucherBillPolicy(input: {
  directPosting: boolean;
  requiresBillMatching: boolean;
  billMatchingVerified: boolean;
  allocationCount: number;
}): "invalidBillAllocation" | "billMatchingNotVerified" | null {
  if (input.directPosting) {
    return input.allocationCount === 0 ? null : "invalidBillAllocation";
  }
  if (input.requiresBillMatching && !input.billMatchingVerified) return "billMatchingNotVerified";
  return null;
}
