import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("./bank-voucher-bill-policy.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { validateBankVoucherBillPolicy } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

test("explicit direct posting allows bill-wise parties without pretending matching was verified", () => {
  assert.equal(validateBankVoucherBillPolicy({directPosting:true, requiresBillMatching:true,
    billMatchingVerified:false, allocationCount:0}), null);
});

test("direct posting rejects bill allocations, including Advances", () => {
  for (const billMatchingVerified of [true, false]) {
    assert.equal(validateBankVoucherBillPolicy({directPosting:true, requiresBillMatching:true,
      billMatchingVerified, allocationCount:1}), "invalidBillAllocation");
  }
});

test("reviewed mode retains its existing bill matching requirement", () => {
  assert.equal(validateBankVoucherBillPolicy({directPosting:false, requiresBillMatching:true,
    billMatchingVerified:false, allocationCount:0}), "billMatchingNotVerified");
  assert.equal(validateBankVoucherBillPolicy({directPosting:false, requiresBillMatching:true,
    billMatchingVerified:true, allocationCount:1}), null);
});

test("queue wiring preserves mandatory connector duplicate preflight for direct vouchers", async () => {
  const route = await readFile(new URL("../app/api/bank-statements/tally/queue/route.ts", import.meta.url), "utf8");
  assert.match(route, /directPosting: transaction\?\.directPosting === true/);
  assert.match(route, /const billPolicyError = validateBankVoucherBillPolicy/);
  assert.match(route, /if \(billPolicyError\) return skipTransaction\(transaction, billPolicyError\)/);
  assert.match(route, /preflightVerifyExisting: true/);
});
