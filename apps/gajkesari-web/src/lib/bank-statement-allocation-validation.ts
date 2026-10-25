import type { FifoBillAllocation, FifoOpenBill } from "./bank-statement-bill-allocation";

export type BillSourceState = {
  openBills: FifoOpenBill[];
  existingAdvances: Array<{ referenceName: string; pendingAdvanceAmount: number }>;
};

type ReviewedAllocation = {
  status: string;
  caseType: string;
  allocations: FifoBillAllocation[];
  sourceBillState?: BillSourceState;
};

type AllocationCheckRow = {
  transactionId: string;
  ledgerName: string;
  draft?: ReviewedAllocation;
};

const referenceKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function stateSignature(state: BillSourceState, advancesOnly = false) {
  const bills = advancesOnly ? [] : state.openBills
    .map(bill => `${referenceKey(bill.referenceName)}:${Number(bill.pendingAmount).toFixed(2)}`).sort();
  const advances = state.existingAdvances
    .map(advance => `${referenceKey(advance.referenceName)}:${Number(advance.pendingAdvanceAmount).toFixed(2)}`).sort();
  return `${bills.join("|")}::${advances.join("|")}`;
}

// candidateBills can already include reservations for earlier statement rows.
// Only the untouched source snapshot can be compared with a fresh Tally read.
// Capacity is checked across the selected batch, independent of display order.
export function validateAllocationBatch(
  rows: AllocationCheckRow[],
  freshByLedger: Map<string, BillSourceState>
): Array<{ transactionId: string; reason: string }> {
  const consumed = new Map<string, Map<string, number>>();
  return rows.flatMap(({ transactionId, ledgerName, draft }) => {
    const reject = (reason: string) => [{ transactionId, reason }];
    if (!draft || draft.status !== "ready_to_post") return reject("Review this payment's bill allocation before posting.");
    const fresh = freshByLedger.get(ledgerName);
    if (!fresh) return reject(`Could not check the latest open bills for ${ledgerName}. Please check Tally again.`);
    const source = draft.sourceBillState;
    if (!source) return reject("Check Tally again to refresh this payment's bill allocation before posting.");
    const manual = draft.caseType === "manual_review";
    if (stateSignature(source, manual) !== stateSignature(fresh, manual)) {
      return reject(manual
        ? "Existing advances changed in Tally. Review this payment's allocation again."
        : "The open bills or advances changed in Tally. Review this payment's allocation again.");
    }

    const bills = new Map<string, FifoOpenBill[]>();
    for (const bill of fresh.openBills) {
      const key = referenceKey(bill.referenceName);
      bills.set(key, [...(bills.get(key) || []), bill]);
    }
    const ledgerKey = ledgerName.trim().replace(/\s+/g, " ").toLowerCase();
    const previous = consumed.get(ledgerKey) || new Map<string, number>();
    const next = new Map(previous);
    for (const allocation of draft.allocations) {
      if (allocation.referenceType !== "Agst Ref") continue;
      const key = referenceKey(allocation.referenceName);
      const candidates = bills.get(key) || [];
      if (candidates.length === 0) return reject(`Bill ${allocation.referenceName} is no longer open in Tally.`);
      if (candidates.length !== 1) return reject(`More than one open bill matches ${allocation.referenceName}. Review the bill before posting.`);
      const pending = Number(candidates[0].pendingAmount);
      const allocated = Number(allocation.allocatedAmount);
      if (!Number.isFinite(pending) || !Number.isFinite(allocated) || allocated <= 0) {
        return reject(`The amount allocated to bill ${allocation.referenceName} needs review.`);
      }
      const total = Math.round(((next.get(key) || 0) + allocated) * 100) / 100;
      if (total - pending >= 0.005) {
        return reject(`These payments allocate more than the amount still pending on bill ${allocation.referenceName}. Review their allocations.`);
      }
      next.set(key, total);
    }
    consumed.set(ledgerKey, next);
    return [];
  });
}
