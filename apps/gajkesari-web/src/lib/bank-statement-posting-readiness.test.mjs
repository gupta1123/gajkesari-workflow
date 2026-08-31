import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("./bank-statement-posting-readiness.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { isReadyForTallyPosting } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const ready = (overrides = {}) => ({
  ledgerName: "Customer A", ledgerNeedsReview: false,
  presence: { status: "missing" }, billRequired: false, amount: 20000,
  ...overrides,
});
const allocation = (overrides = {}) => ({
  status: "ready_to_post", requiresUserReview: false, isEligibleForPosting: true,
  unallocatedAmount: 0,
  allocations: [{ referenceName: "INV-1", allocatedAmount: 20000 }],
  ...overrides,
});

test("mixed 30-row batch posts 25 ready rows and retains 5 blocked rows", () => {
  const rows = Array.from({ length: 30 }, (_, id) => ({ id, ...ready() }));
  for (const id of [0, 1]) Object.assign(rows[id], {
    billRequired: true,
    allocation: allocation({ status: "needs_review", requiresUserReview: true, isEligibleForPosting: false, unallocatedAmount: 20000 }),
  });
  for (const id of [27, 28, 29]) rows[id].ledgerName = "";
  const selected = rows.filter(isReadyForTallyPosting);
  assert.equal(selected.length, 25);
  assert.deepEqual(selected.map((row) => row.id), Array.from({ length: 25 }, (_, i) => i + 2));
  assert.equal(rows.length, 30, "filtering must not discard held rows from the statement");
});

test("unknown, failed, found, and ambiguous checks are excluded independently", () => {
  for (const status of [undefined, "not_checked", "checking", "failed", "found", "ambiguous"]) {
    assert.equal(isReadyForTallyPosting(ready({ presence: status ? { status } : undefined })), false);
  }
  assert.equal(isReadyForTallyPosting(ready({ presence: { status: "missing", duplicateInTally: true } })), false);
  assert.equal([ready(), ready({ presence: { status: "ambiguous" } })].filter(isReadyForTallyPosting).length, 1);
});

test("direct posting permits unchecked normal, party and Suspense vouchers without allocations", () => {
  for (const ledgerName of ["Customer A", "Supplier B", "Bank Charges", "Suspense"]) {
    for (const billRequired of [true, false]) {
      assert.equal(isReadyForTallyPosting(ready({
        ledgerName, billRequired, directPosting: true, presence: undefined,
      })), true);
    }
  }
});

test("direct posting never bypasses known duplicates, failed checks or allocation review", () => {
  for (const status of ["checking", "failed", "found", "ambiguous"]) {
    assert.equal(isReadyForTallyPosting(ready({ directPosting: true, presence: { status } })), false);
  }
  for (const overrides of [
    { ledgerName: "" }, { ledgerNeedsReview: true }, { amount: 0 }, { amount: NaN },
    { allocation: allocation() }, { allocation: allocation({status: "stale_data"}) },
    { presence: {status: "missing", duplicateInTally: true} },
  ]) assert.equal(isReadyForTallyPosting(ready({directPosting: true, ...overrides})), false);
});

test("missing ledgers and unresolved ledger confirmation are not ready", () => {
  assert.equal(isReadyForTallyPosting(ready({ ledgerName: "  " })), false);
  assert.equal(isReadyForTallyPosting(ready({ ledgerNeedsReview: true })), false);
  assert.equal(isReadyForTallyPosting(ready()), true);
});

test("an existing Suspense ledger is eligible for receipts and payments without bill allocation", () => {
  for (const amount of [13750, 9750]) {
    assert.equal(isReadyForTallyPosting(ready({ ledgerName: "Suspense", amount })), true);
  }
});

test("Suspense receipt badge does not report a missing ledger", async () => {
  const page = await readFile(new URL("../components/bank-statements/BankStatementsPage.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["getBillAllocationBadgeText", "getBillAllocationSubtext"]);
  const functions = ast.statements.filter((n) => ts.isFunctionDeclaration(n) && names.has(n.name?.text));
  const exported = functions.map((n) => "export " + n.getText(ast)).join("\n");
  const stubs = `
    const isIncomingReceiptRow = t => Number(t.creditAmount) > 0;
    const isOutgoingPaymentRow = t => Number(t.debitAmount) > 0;
    const isSuspenseLedgerName = name => name === 'Suspense';
    const isBillMatchEligibleTransaction = () => false;
    const getPartyBillMatchContext = () => ({eligible:false, partyKind:null, reason:''});
  `;
  const compiled = ts.transpileModule(stubs + exported, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const badges = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
  const receipt = { selectedLedgerName: "Suspense", creditAmount: "13750", debitAmount: "" };
  assert.equal(badges.getBillAllocationBadgeText(receipt, []), "Post to Suspense");
  assert.match(badges.getBillAllocationSubtext(undefined, receipt, []), /Will post to Suspense/);
  assert.equal(badges.getBillAllocationBadgeText({...receipt, selectedLedgerName: ""}, []), "Needs Ledger");
});

test("bill-wise rows require a completed, balanced reviewed allocation", () => {
  assert.equal(isReadyForTallyPosting(ready({ billRequired: true })), false);
  for (const overrides of [
    { status: "stale_data" }, { status: "needs_review" },
    { requiresUserReview: true }, { isEligibleForPosting: false },
    { unallocatedAmount: 1 }, { unallocatedAmount: NaN },
    { allocations: [] },
    { allocations: [{ referenceName: "INV-1", allocatedAmount: 19000 }] },
    { allocations: [{ referenceName: "", allocatedAmount: 20000 }] },
    { allocations: [{ referenceName: "INV-1", allocatedAmount: NaN }] },
  ]) assert.equal(isReadyForTallyPosting(ready({ billRequired: true, allocation: allocation(overrides) })), false);
  assert.equal(isReadyForTallyPosting(ready({ billRequired: true, allocation: allocation() })), true);
});

test("reviewed advances and split allocations remain eligible", () => {
  for (const allocations of [
    [{ referenceName: "ADV-1", allocatedAmount: 20000 }],
    [{ referenceName: "INV-1", allocatedAmount: 15000 }, { referenceName: "ADV-2", allocatedAmount: 5000 }],
  ]) assert.equal(isReadyForTallyPosting(ready({ billRequired: true, allocation: allocation({ allocations }) })), true);
});

test("receipt/payment scopes and subsequent batches contain only ready unposted rows", () => {
  const rows = [
    { id: "receipt", direction: "receipt", ...ready() },
    { id: "payment", direction: "payment", ...ready() },
    { id: "held", direction: "receipt", ...ready({ ledgerName: "" }) },
  ];
  const eligible = rows.filter(isReadyForTallyPosting);
  assert.deepEqual(eligible.filter((r) => r.direction === "receipt").map((r) => r.id), ["receipt"]);
  assert.deepEqual(eligible.filter((r) => r.direction === "payment").map((r) => r.id), ["payment"]);
  rows[0].presence.status = rows[1].presence.status = "found";
  assert.equal(rows.filter(isReadyForTallyPosting).length, 0);
  rows[2].ledgerName = "Reviewed Customer";
  assert.deepEqual(rows.filter(isReadyForTallyPosting).map((r) => r.id), ["held"]);
});

test("UI and submission use ready scopes, with no unresolved advance fallback", async () => {
  const page = await readFile(new URL("../components/bank-statements/BankStatementsPage.tsx", import.meta.url), "utf8");
  for (const name of ["selectedPostingTransactions", "selectedTallyWorkTransactions"]) {
    assert.match(page, new RegExp(`const ${name} = [\\s\\S]*?\\? readyReceiptTransactions[\\s\\S]*?\\? readyPaymentTransactions[\\s\\S]*?: readyPostingTransactions;`));
  }
  assert.doesNotMatch(page, /Review ambiguous Tally matches before sending anything/);
  assert.doesNotMatch(page, /buildDirectAdvanceAllocation\(reviewedTransaction\)/);
  assert.match(page, /held for review — not included in posting/);
  assert.match(page, /const directPosting = !billMatchingRequested/);
  assert.match(page, /async function matchPendingBills\(\) \{\s*setBillMatchingRequested\(true\)/);
  assert.match(page, /!directPosting && billAllocation\?\.status === "ready_to_post"/);
  assert.equal((page.match(/setBillMatchingRequested\(false\)/g) || []).length, 2,
    "only clearing or loading a statement resets direct mode; failed checks must not reset it");
});
