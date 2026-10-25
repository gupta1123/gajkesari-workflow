import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { validateAllocationBatch } from "./bank-statement-allocation-validation.ts";
import { allocateReceiptByFifo } from "./bank-statement-bill-allocation.ts";

const source = await readFile(new URL("../components/bank-statements/BankStatementsPage.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let send;
(function visit(n) { if (ts.isFunctionDeclaration(n) && n.name?.text === "sendToTally") send = n; ts.forEachChild(n, visit); })(ast);
const code = ts.transpileModule(send.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ readFails = false } = {}) {
  const baseline = { openBills: [{ referenceName: "INV-1", pendingAmount: 1000 }], existingAdvances: [] };
  const rows = ["review", "ready"].map(id => ({ id, selectedLedgerName: id, transactionDate: "2026-10-25" }));
  const state = {
    checked: true, presence: { review: {status:"missing"}, ready: {status:"missing"}, old1: {status:"found",voucherNumber:"5309"}, old2: {status:"found",voucherNumber:"5310"} },
    outgoing: { old1: {status:"found"}, old2: {status:"found"} },
    allocations: Object.fromEntries(rows.map(row => [row.id, {status:"ready_to_post",caseType:"partial_settlement",allocations:allocateReceiptByFifo(100,baseline.openBills,"ADV").allocations,sourceBillState:structuredClone(baseline)}])),
    banner: null, apiCalls: 0,
  };
  const context = {
    preview: {import:{id:"test"}}, previewExtractionIncomplete:false,
    readyReceiptTransactions:[], readyPaymentTransactions:rows, readyPostingTransactions:rows,
    validTransactions:[...rows,{id:"old1"},{id:"old2"}], tallyPresenceByTransactionId:state.presence,
    tallyConnectionId:"test-connection", bankLedgerName:"Test Bank", transactionsNeedingTallyWork:rows,
    commandConnection:{id:"test-connection"}, directPosting:false, ledgerMasters:[],
    billAllocationsByTransactionId:state.allocations, validateAllocationBatch,
    isBillMatchEligibleTransaction:()=>true, getEffectiveTransactionDate:row=>row.transactionDate,
    fetchOpenBillsForLedgers:async()=>{
      if(readFails) throw new Error("Tally read unavailable");
      return new Map([["review",{openBills:[{referenceName:"INV-1",pendingAmount:900}],existingAdvances:[]}],["ready",baseline]]);
    },
    setBillAllocationsByTransactionId:update=>{state.allocations=update(state.allocations)},
    setOutgoingVerificationsByTransactionId:value=>{state.outgoing=value},
    setTallyPresenceByTransactionId:value=>{state.presence=value},
    setTallyCheckAttempted:value=>{state.checked=value}, setTallyBalanceProof:()=>{},
    setBanner:value=>{state.banner=value}, showToast:()=>{},
    apiFetch:async()=>{state.apiCalls++;throw Error("No API call is allowed for blocked allocations")},
    console:{error:()=>{}},
  };
  return { state, send: new Function("context", `with(context){${code};return sendToTally;}`)(context) };
}

test("a real bill change flags only the affected row and preserves existing-voucher checks", async () => {
  const f = fixture();
  await f.send("post_all");
  assert.equal(f.state.allocations.review.status, "stale_data");
  assert.equal(f.state.allocations.ready.status, "ready_to_post");
  assert.equal(f.state.presence.old1.voucherNumber, "5309");
  assert.equal(f.state.presence.old2.voucherNumber, "5310");
  assert.equal(f.state.outgoing.old1.status, "found");
  assert.equal(f.state.checked, true);
  assert.equal(f.state.apiCalls, 0);
  assert.match(f.state.banner.text, /1 entry needs bill allocation review\. Nothing was posted/);
});
test("an unavailable bill read stops posting without erasing previous Tally checks", async () => {
  const f = fixture({readFails:true});
  await f.send("post_all");
  assert.equal(f.state.presence.old1.status, "found");
  assert.equal(f.state.checked, true);
  assert.equal(f.state.apiCalls, 0);
  assert.match(f.state.banner.text, /could not check the latest bill balances\. Nothing was posted/);
});
