import { resolveBankBillReference } from "./bill-reference.mjs";

function normalized(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function amountFor(transaction) {
  return Math.max(0, Number(transaction.amount) || 0, Number(transaction.creditAmount) || 0, Number(transaction.debitAmount) || 0);
}

function referenceToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function orderBills(bills, preferredReference = "") {
  const preferredKey = normalized(preferredReference);
  return [...(bills || [])].sort((left, right) =>
    (normalized(left.referenceName) === preferredKey ? -1 : 0) -
      (normalized(right.referenceName) === preferredKey ? -1 : 0) ||
    String(left.dueDate || left.invoiceDate || "9999-12-31").localeCompare(
      String(right.dueDate || right.invoiceDate || "9999-12-31")
    ) || String(left.referenceName || "").localeCompare(String(right.referenceName || ""))
  );
}

function allocate(amount, bills, advanceReference, preferredReference) {
  let remaining = Number(amount.toFixed(2));
  const allocations = [];
  for (const bill of orderBills(bills, preferredReference)) {
    if (remaining <= 0.005) break;
    const pending = Number(Math.max(0, Number(bill.pendingAmount) || 0).toFixed(2));
    if (pending <= 0.005) continue;
    const used = Number(Math.min(remaining, pending).toFixed(2));
    remaining = Number(Math.max(0, remaining - used).toFixed(2));
    allocations.push({
      referenceType: "Agst Ref",
      referenceName: bill.referenceName,
      voucherNumber: bill.voucherNumber || null,
      invoiceDate: bill.invoiceDate || null,
      dueDate: bill.dueDate || null,
      previousPendingAmount: pending,
      allocatedAmount: used,
      pendingAmountAfterAllocation: Number((pending - used).toFixed(2)),
      statusAfterAllocation: pending - used <= 0.005 ? "cleared" : "partially_settled",
    });
  }
  if (remaining > 0.005) allocations.push({
    referenceType: "Advance",
    referenceName: advanceReference,
    allocatedAmount: remaining,
    pendingAmountAfterAllocation: remaining,
    statusAfterAllocation: "advance",
  });
  return { allocations, newAdvanceAmount: remaining };
}

function consume(bills, allocations) {
  const used = new Map();
  for (const item of allocations) {
    if (item.referenceType !== "Agst Ref") continue;
    const key = normalized(item.referenceName);
    used.set(key, Number(((used.get(key) || 0) + item.allocatedAmount).toFixed(2)));
  }
  return (bills || []).flatMap((bill) => {
    const pendingAmount = Number(Math.max(0,
      Number(bill.pendingAmount || 0) - (used.get(normalized(bill.referenceName)) || 0)
    ).toFixed(2));
    return pendingAmount > 0.005 ? [{ ...bill, pendingAmount }] : [];
  });
}

export function planChronologicalBillAllocations({ transactions, verificationRows, openBillsByLedger }) {
  const verificationById = new Map((verificationRows || []).map((row) => [String(row.transactionId || ""), row]));
  const working = new Map();
  const plans = {};
  const ordered = [...(transactions || [])].sort((left, right) =>
    normalized(left.counterpartyLedgerName).localeCompare(normalized(right.counterpartyLedgerName)) ||
    String(left.voucherDate || "").localeCompare(String(right.voucherDate || "")) ||
    String(left.transactionId || "").localeCompare(String(right.transactionId || ""))
  );
  for (const transaction of ordered) {
    const transactionId = String(transaction.transactionId || "");
    if (!transactionId || verificationById.get(transactionId)?.verificationStatus !== "missing") continue;
    const ledgerName = String(transaction.counterpartyLedgerName || "").trim();
    const bucket = openBillsByLedger?.[ledgerName];
    if (!ledgerName || !bucket || bucket.complete === false || bucket.error) continue;
    const ledgerKey = normalized(ledgerName);
    const bills = working.get(ledgerKey) || (bucket.openBills || []).map((bill) => ({ ...bill }));
    const amount = amountFor(transaction);
    if (amount <= 0 || (bucket.existingAdvances || []).length > 0) continue;
    const reference = resolveBankBillReference(bills, transaction);
    // Leave uncertain invoice references to the browser's review flow. Falling
    // back to FIFO here would silently select an invoice the user did not name.
    if (["ambiguous", "unresolved"].includes(reference.status)) continue;
    const date = String(transaction.voucherDate || "").replace(/-/g, "");
    const suffix = referenceToken(transaction.referenceNumber || transactionId).slice(-8) || transactionId.slice(0, 8);
    const allocation = allocate(
      amount,
      bills,
      `ADV-${date}-${suffix}`.slice(0, 80),
      reference.referenceName
    );
    const totalAllocatedAmount = Number(allocation.allocations.reduce((sum, item) => sum + item.allocatedAmount, 0).toFixed(2));
    plans[transactionId] = {
      receiptAmount: amount,
      totalAllocatedAmount,
      newAdvanceAmount: allocation.newAdvanceAmount,
      unallocatedAmount: Number(Math.max(0, amount - totalAllocatedAmount).toFixed(2)),
      allocations: allocation.allocations,
      candidateBills: orderBills(bills, reference.referenceName),
      existingAdvances: bucket.existingAdvances || [],
      source: "connector_chronological_fifo",
    };
    working.set(ledgerKey, consume(bills, allocation.allocations));
  }
  return plans;
}
