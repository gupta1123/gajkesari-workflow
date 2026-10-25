import assert from "node:assert/strict";
import test from "node:test";
import { validateAllocationBatch } from "./bank-statement-allocation-validation.ts";
import { allocateReceiptByFifo, applyFifoAllocationsToBills } from "./bank-statement-bill-allocation.ts";

const source = { openBills: [{ referenceName: "SI/9284/04028", pendingAmount: 84004 }], existingAdvances: [] };
function planned(id, amount, available = source.openBills, ledgerName = "Balaji") {
  const allocation = allocateReceiptByFifo(amount, available, "ADV-" + id);
  return { transactionId: id, ledgerName, draft: {
    status: "ready_to_post", caseType: "partial_settlement", sourceBillState: structuredClone(source),
    candidateBills: structuredClone(available), allocations: allocation.allocations,
  } };
}
function pair() {
  const first = planned("first", 1371.25);
  const second = planned("second", 3493.75, applyFifoAllocationsToBills(source.openBills, first.draft.allocations));
  return [first, second];
}
const fresh = () => new Map([["Balaji", structuredClone(source)]]);

test("the real Balaji two-payment case passes against unchanged Tally bills", () => {
  const rows = pair();
  assert.equal(rows[1].draft.candidateBills[0].pendingAmount, 82632.75);
  assert.deepEqual(validateAllocationBatch(rows, fresh()), []);
  assert.equal(source.openBills[0].pendingAmount, 84004, "validation never mutates Tally's source state");
});
test("reordered rows and posting only the later payment do not invent a Tally change", () => {
  const rows = pair();
  assert.deepEqual(validateAllocationBatch(rows.reverse(), fresh()), []);
  assert.deepEqual(validateAllocationBatch([rows[0]], fresh()), []);
});
test("a real balance change remains blocked even when enough money is still pending", () => {
  const live = fresh(); live.get("Balaji").openBills[0].pendingAmount -= 1000;
  const errors = validateAllocationBatch(pair(), live);
  assert.deepEqual(errors.map(r => r.transactionId), ["first", "second"]);
  assert.match(errors[0].reason, /changed in Tally/);
});
test("manual allocations still cannot over-allocate a bill across multiple rows", () => {
  const first = planned("first", 60000), second = planned("second", 30000);
  first.draft.caseType = second.draft.caseType = "manual_review";
  const errors = validateAllocationBatch([first, second], fresh());
  assert.equal(errors.length, 1); assert.equal(errors[0].transactionId, "second");
  assert.match(errors[0].reason, /more than the amount still pending/);
});
test("the same bill number in different ledgers has independent capacity", () => {
  const rows = [planned("a", 60000), planned("b", 60000, source.openBills, "Other supplier")];
  assert.deepEqual(validateAllocationBatch(rows, new Map([...fresh(), ["Other supplier", structuredClone(source)]])), []);
});
test("closed bills, new advances, missing live reads and missing snapshots stop posting", () => {
  for (const mutate of [s => {s.openBills = []}, s => {s.existingAdvances.push({referenceName:"ADV-NEW",pendingAdvanceAmount:100})}]) {
    const live = fresh(); mutate(live.get("Balaji"));
    assert.equal(validateAllocationBatch(pair(), live).length, 2);
  }
  assert.equal(validateAllocationBatch(pair(), new Map()).length, 2);
  const row = planned("old", 100); delete row.draft.sourceBillState;
  assert.match(validateAllocationBatch([row], fresh())[0].reason, /Check Tally again/);
});
test("manual review allows new bills but still rejects changed advances and removed selected bills", () => {
  const row = planned("manual", 100); row.draft.caseType = "manual_review";
  const live = fresh(); live.get("Balaji").openBills.push({referenceName:"NEW-BILL",pendingAmount:500});
  assert.deepEqual(validateAllocationBatch([row], live), []);
  live.get("Balaji").openBills.shift();
  assert.match(validateAllocationBatch([row], live)[0].reason, /no longer open/);
  live.get("Balaji").existingAdvances.push({referenceName:"ADV-NEW",pendingAdvanceAmount:100});
  assert.match(validateAllocationBatch([row], live)[0].reason, /advances changed/);
});
test("fully consumed bills and advance remainders pass using the original snapshot", () => {
  const first = planned("first", 84004);
  const second = planned("advance", 1000, applyFifoAllocationsToBills(source.openBills, first.draft.allocations));
  assert.equal(second.draft.allocations[0].referenceType, "Advance");
  assert.deepEqual(validateAllocationBatch([first, second], fresh()), []);
});
test("one bad row does not invalidate or consume capacity for an unrelated valid row", () => {
  const bad = planned("bad", 100), good = planned("good", 100);
  bad.draft.allocations = [{referenceType:"Agst Ref",referenceName:"MISSING",allocatedAmount:100}];
  bad.draft.caseType = "manual_review";
  assert.deepEqual(validateAllocationBatch([bad, good], fresh()).map(r => r.transactionId), ["bad"]);
});
test("rounding, invalid amounts and ambiguous bill identities are handled safely", () => {
  const row = planned("invalid", 100);
  row.draft.allocations[0].allocatedAmount = NaN;
  assert.match(validateAllocationBatch([row], fresh())[0].reason, /amount allocated/);
  const live = fresh(); live.get("Balaji").openBills.push({referenceName:"SI928404028",pendingAmount:100});
  const manual = planned("manual", 100); manual.draft.caseType = "manual_review";
  assert.match(validateAllocationBatch([manual], live)[0].reason, /More than one open bill/);
});
