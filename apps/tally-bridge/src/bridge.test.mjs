import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { candidateIdentity, duplicateContext } from '../../../packages/shared/src/lib/bank-duplicate-resolution.mjs';

import {
  buildCollectionExportXml,
  buildBankVoucherBatchXml,
  buildBankVoucherXml,
  buildPurchaseVoucherXml,
  buildRequestedLedgerFormula,
  classifyOpenBillReferenceKind,
  classifyTaxLedgers,
  createExclusiveScheduler,
  decodeTallyResponseBytes,
  findBankLedgersFromMasters,
  fetchCustomerOpenBillsFromTally,
  getBankVoucherCommandBatchKey,
  matchBankStatementInTally,
  openBillBlockRequiresVoucherFallback,
  parseBankStatementMasterCollection,
  parseLedgerClosingBalance,
  parseTallyImportResult,
  postBankVoucher,
  runBankVoucherCommandBatch,
  purchaseVoucherReadbackComparison,
  reconcileBankTransactionsInTally,
  verifyBankTransactionInTally,
  refreshCachedBankVouchers,
  resolveBankVoucherLedgerIdentities,
  partitionBankVoucherLedgerIdentities,
  strictBankTransactionCandidates,
  indexBankVouchersByDate,
  fetchAvailableCompanies,
  testTally,
  buildTallyXmlRequest,
} from "./bridge.mjs";

function decodeRequestBody(body) {
  return Buffer.isBuffer(body) ? decodeTallyResponseBytes(body) : String(body);
}

// Real names verified against TallyPrime: UTF-8 requests fail or return "?".
const UNICODE_LEDGER_NAMES = [
  "Shree Balaji Steel Traders – Jalna",
  "Om Sai Hardware — Aurangabad",
  "Mahalaxmi Enterprises ‑ Nashik",
  "Kalyani Construction Co. Pune",
  "Patil’s Building Materials",
  "श्री गणेश ट्रेडर्स - Jalna",
  "R.K. Steels & Co – Beed",
];

test("Tally requests are sent as UTF-16LE with a BOM", () => {
  const request = buildTallyXmlRequest(`<NAME>${UNICODE_LEDGER_NAMES[0]}</NAME>`);
  assert.equal(request.headers["Content-Type"], "text/xml; charset=utf-16");
  assert.deepEqual([...request.body.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(decodeRequestBody(request.body), `<NAME>${UNICODE_LEDGER_NAMES[0]}</NAME>`);
});

test("master parsing keeps exact Unicode, line-break and spacing in ledger names", () => {
  const names = [...UNICODE_LEDGER_NAMES, "Renuka Transport\r\n", "Sai  Krupa Traders"];
  const xml = `<ENVELOPE>${names.map((name, index) =>
    `<LEDGER NAME="${name.replaceAll("&", "&amp;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;")}"><GUID>g-${index}</GUID></LEDGER>`
  ).join("")}</ENVELOPE>`;
  const utf16Reply = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
  const parsed = parseBankStatementMasterCollection(decodeTallyResponseBytes(utf16Reply), "LEDGER");
  assert.deepEqual(parsed.map((master) => master.name), names);
});

test("bank voucher XML posts exact ledger names without trimming", () => {
  for (const name of [...UNICODE_LEDGER_NAMES, "Renuka Transport\r\n"]) {
    const xml = buildBankVoucherXml({
      companyName: "Test Co", voucherType: "Receipt", voucherDate: "2026-09-24", amount: 1,
      bankLedgerName: "Axis Bank", counterpartyLedgerName: name, counterpartyIsPartyLedger: true,
    }, "Test Co");
    const expected = name.replaceAll("&", "&amp;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
    assert.ok(xml.includes(`<LEDGERNAME>${expected}</LEDGERNAME>`), name);
  }
});

test("stored '?' ledger name resolves by GUID to the exact live Unicode name", () => {
  const [resolved] = resolveBankVoucherLedgerIdentities([{
    bankLedgerName: "Axis Bank", bankLedgerGuid: "bank-guid",
    counterpartyLedgerName: "Shree Balaji Steel Traders ? Jalna", counterpartyLedgerGuid: "party-guid",
  }], [
    { name: "Axis Bank", guid: "bank-guid" },
    { name: UNICODE_LEDGER_NAMES[0], guid: "party-guid" },
  ]);
  assert.equal(resolved.counterpartyLedgerName, UNICODE_LEDGER_NAMES[0]);
});

test("operational voucher provider bootstraps once then requests a statement-scoped bank snapshot", async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "gajkesari-voucher-provider-"));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const calls = [];
  const fullXml = '<ENVELOPE><COLLECTION><VOUCHER><DATE>20260801</DATE><EFFECTIVEDATE>20260801</EFFECTIVEDATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER><REFERENCE>UTR-1</REFERENCE><PARTYLEDGERNAME>Customer</PARTYLEDGERNAME><MASTERID>10</MASTERID><ALTERID>20</ALTERID><GUID>v-1</GUID><ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>-100</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER></COLLECTION></ENVELOPE>';
  const request = {
    companyName: "Company", bankLedgerName: "Bank", dateFrom: "2026-08-01", dateTo: "2026-08-01",
    transactions: [{ referenceNumber: "UTR-1" }],
  };
  const dependencies = {
    localMatchingBaseDir: baseDir,
    companyGuid: "company-guid",
    exportCollection: async (_url, options) => { calls.push(options); return fullXml; },
  };
  const first = await refreshCachedBankVouchers("http://tally", request, dependencies);
  assert.equal(first.diagnostics.refreshMode, "full_snapshot");
  assert.equal(first.vouchers.length, 1);
  const second = await refreshCachedBankVouchers("http://tally", request, dependencies);
  assert.equal(second.diagnostics.refreshMode, "scoped_snapshot");
  assert.equal(calls[1].tallyType, "Vouchers : Ledger");
  assert.equal(calls[1].dateFrom, request.dateFrom);
  assert.equal(calls[1].dateTo, request.dateTo);
  assert.equal(calls[1].formulae, undefined);
});

test("Tally response decoding preserves Unicode ledger punctuation", () => {
  const xml = '<LEDGER NAME="Task Metcorp Global (Opc) Private Limited – Jalna"></LEDGER>';
  assert.equal(decodeTallyResponseBytes(Buffer.from(xml, "utf8")), xml);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
  assert.equal(decodeTallyResponseBytes(utf16), xml);
});

test("bank posting resolves a stale cached name by stable Tally GUID", () => {
  const [resolved] = resolveBankVoucherLedgerIdentities([{
    bankLedgerName: "HDFC Bank",
    bankLedgerGuid: "bank-guid",
    counterpartyLedgerName: "Task Metcorp Global (Opc) Private Limited ? Jalna",
    counterpartyLedgerGuid: "party-guid",
  }], [
    { name: "HDFC Bank", guid: "BANK-GUID" },
    { name: "Task Metcorp Global (Opc) Private Limited – Jalna", guid: "PARTY-GUID" },
  ]);
  assert.equal(resolved.counterpartyLedgerName, "Task Metcorp Global (Opc) Private Limited – Jalna");
  assert.throws(() => resolveBankVoucherLedgerIdentities([{
    bankLedgerName: "HDFC Bank", bankLedgerGuid: "bank-guid",
    counterpartyLedgerName: "Missing", counterpartyLedgerGuid: "missing-guid",
  }], [{ name: "HDFC Bank", guid: "bank-guid" }]), /not present in the active Tally company/);
});

test("one missing ledger does not reject other bank posting rows", () => {
  const results = partitionBankVoucherLedgerIdentities([
    { bankLedgerName: "Bank", counterpartyLedgerName: "Suspense" },
    { bankLedgerName: "Bank", counterpartyLedgerName: "Missing" },
    { bankLedgerName: "Bank", counterpartyLedgerName: "Customer" },
  ], [{ name: "Bank" }, { name: "Suspense" }, { name: "Customer" }]);
  assert.equal(results[0].error, null);
  assert.match(results[1].error, /Counterparty ledger 'Missing'/);
  assert.equal(results[2].error, null);
});

test("direct receipt and payment XML contain no bill reference or Advance allocation", () => {
  for (const voucherType of ["Receipt", "Payment"]) {
    const xml = buildBankVoucherXml({
      voucherType, voucherDate: "2026-08-24", bankLedgerName: "Axis Bank",
      counterpartyLedgerName: "Test Party", counterpartyIsPartyLedger: true,
      amount: 20000, referenceNumber: "DIRECT-TEST", billAllocations: [],
    }, "Test Company");
    assert.match(xml, /Test Party/);
    assert.match(xml, /Axis Bank/);
    assert.doesNotMatch(xml, /BILLALLOCATIONS\.LIST|<BILLTYPE>|Advance|Agst Ref/);
  }
});

test("cancelled and expired interactive work never enters Tally", async () => {
  const scheduler = createExclusiveScheduler();
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const first = scheduler(async () => { started(); await new Promise((resolve) => { release = resolve; }); }, "background");
  await ready;
  let invoked = false;
  const controller = new AbortController();
  const cancelled = scheduler(() => { invoked = true; }, "interactive", { signal: controller.signal });
  const cancellation = assert.rejects(cancelled);
  controller.abort();
  await cancellation;
  const expired = scheduler(() => { invoked = true; }, "interactive", { deadlineAt: Date.now() + 20 });
  await assert.rejects(expired, /timed out|deadline|expired|wait/i);
  release();
  await first;
  assert.equal(invoked, false);
  assert.equal(await scheduler(() => "next", "interactive"), "next");
  scheduler.stop();
});

test("readiness uses one small current-company query, not a ledger export", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(decodeRequestBody(options.body));
    return new Response("<ENVELOPE><RESULT>Gajkesari</RESULT></ENVELOPE>");
  });
  const result = await testTally("http://tally.invalid");
  assert.equal(result.companyName, "Gajkesari");
  assert.equal(result.companyLoaded, true);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /\$\$CurrentCompany/);
  assert.doesNotMatch(bodies[0], /<COLLECTION|SVCURRENTCOMPANY|Ledger/i);
});

test("different company GUIDs with the same name are not silently collapsed", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(
    '<ENVELOPE><STATUS>1</STATUS><COMPANY NAME="Same"><GUID>guid-a</GUID></COMPANY><COMPANY NAME="Same"><GUID>guid-b</GUID></COMPANY></ENVELOPE>'
  ));
  const companies = await fetchAvailableCompanies("http://tally.invalid", "Same");
  assert.deepEqual(companies.map((company) => company.guid), ["guid-a", "guid-b"]);
  assert.equal(companies.filter((company) => company.isActive).length, 2);
});

for (const size of [9227, 12000]) {
  test(`indexed matching preserves exact identities and reservations for ${size} vouchers`, () => {
    const vouchers = Array.from({ length: size }, (_, index) => ({
      ...bankVoucher({ reference: `UTR-${index % 100}`, party: `Party ${index % 7}` }),
      date: `202608${String(index % 28 + 1).padStart(2, "0")}`,
      effectiveDate: `202608${String(index % 28 + 1).padStart(2, "0")}`,
    }));
    const byDate = indexBankVouchersByDate(vouchers);
    const reserved = new Set([0, 100, 2800]);
    for (let index = 0; index < 35; index += 1) {
      const transaction = {
        voucherDate: `2026-08-${String(index % 28 + 1).padStart(2, "0")}`,
        amount: 1250, expectedDirection: "incoming",
        referenceNumber: index % 2 ? `UTR-${index % 100}` : "",
        counterpartyLedgerName: index % 3 ? `Party ${index % 7}` : "Suspense",
      };
      const baseline = strictBankTransactionCandidates(vouchers, transaction, "ICICI Current Account", reserved);
      const indexed = strictBankTransactionCandidates(vouchers, transaction, "ICICI Current Account", reserved, byDate);
      assert.deepEqual(indexed, baseline);
    }
    assert.ok(Math.max(...[...byDate.values()].map((rows) => rows.length)) < size / 20);
  });
}

test("interactive Tally work runs before queued background work", async () => {
  const scheduler = createExclusiveScheduler();
  const order = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = scheduler(async () => {
    order.push("background-1");
    markFirstStarted();
    await firstBlocked;
  }, "background");
  await firstStarted;
  const second = scheduler(() => order.push("background-2"), "background");
  const interactive = scheduler(() => order.push("interactive"), "interactive");
  releaseFirst();
  await Promise.all([first, second, interactive]);

  assert.deepEqual(order, ["background-1", "interactive", "background-2"]);
});

test("bank-statement master parser keeps lean ledger identity and targeted bank details", () => {
  const lean = parseBankStatementMasterCollection(
    '<ENVELOPE><LEDGER NAME="Customer A"><PARENT>Sundry Debtors</PARENT><GUID>L-1</GUID><ISBILLWISEON>Yes</ISBILLWISEON><EMAIL>unused@example.com</EMAIL></LEDGER></ENVELOPE>',
    "LEDGER"
  );
  assert.equal(lean.length, 1);
  assert.equal(lean[0].name, "Customer A");
  assert.equal(lean[0].parent, "Sundry Debtors");
  assert.equal(lean[0].raw.billWiseEnabled, true);
  assert.equal(lean[0].email, undefined);

  const detailed = parseBankStatementMasterCollection(
    '<ENVELOPE><LEDGER NAME="State Bank"><PARENT>Bank Accounts</PARENT><GUID>B-1</GUID><BANKNAME>SBI</BANKNAME><BANKACCOUNTNUMBER>1234</BANKACCOUNTNUMBER><IFSCCODE>SBIN0001</IFSCCODE><CLOSINGBALANCE>500 Cr</CLOSINGBALANCE></LEDGER></ENVELOPE>',
    "LEDGER",
    { bankDetails: true }
  );
  assert.equal(detailed[0].bankName, "SBI");
  assert.equal(detailed[0].bankAccountNumber, "1234");
  assert.equal(detailed[0].closingBalance, 500);
  assert.equal(detailed[0].closingBalanceType, "Cr");
});

test("ledger closing balances preserve Tally Dr and Cr meaning", () => {
  assert.deepEqual(parseLedgerClosingBalance("1,24,500.00 Dr"), {
    amount: 124500,
    type: "Dr",
    raw: "1,24,500.00 Dr",
  });
  assert.deepEqual(parseLedgerClosingBalance("842300 Cr"), {
    amount: 842300,
    type: "Cr",
    raw: "842300 Cr",
  });
  assert.deepEqual(parseLedgerClosingBalance("-950"), {
    amount: 950,
    type: "Dr",
    raw: "-950",
  });
  assert.deepEqual(parseLedgerClosingBalance(""), {
    amount: null,
    type: null,
    raw: null,
  });
});

test("outgoing supplier payments create Payment vouchers with bill allocations", () => {
  const xml = buildBankVoucherXml({
    companyName: "Solution Nyx",
    voucherType: "Payment",
    voucherDate: "2026-08-17",
    bankLedgerName: "State Bank of India",
    counterpartyLedgerName: "Mahavir Steel Corporation",
    counterpartyIsPartyLedger: true,
    bankLedgerEntryIsDebit: false,
    amount: 94000,
    referenceNumber: "SB61708260002",
    billAllocations: [
      { referenceType: "Agst Ref", referenceName: "MSC/26-27/403", amount: 75000 },
      { referenceType: "Agst Ref", referenceName: "MSC/26-27/404", amount: 19000 },
    ],
  });

  assert.match(xml, /<VOUCHERTYPENAME>Payment<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<LEDGERNAME>Mahavir Steel Corporation<\/LEDGERNAME>/);
  assert.match(xml, /<NAME>MSC\/26-27\/403<\/NAME>/);
  assert.match(xml, /<NAME>MSC\/26-27\/404<\/NAME>/);
  assert.match(xml, /<LEDGERNAME>State Bank of India<\/LEDGERNAME>/);
});

test("explicitly requested Advance allocation does not settle an existing bill", () => {
  const xml = buildBankVoucherXml({
    companyName: "Solution Nyx",
    voucherType: "Receipt",
    voucherDate: "2026-08-17",
    bankLedgerName: "State Bank of India",
    counterpartyLedgerName: "Aarohi Steel Distributors",
    counterpartyIsPartyLedger: true,
    bankLedgerEntryIsDebit: true,
    amount: 5977,
    referenceNumber: "SBS01010900001",
    billAllocations: [
      { referenceType: "Advance", referenceName: "ADV-20260817-0900001", amount: 5977 },
    ],
  });

  assert.match(xml, /<VOUCHERTYPENAME>Receipt<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<NAME>ADV-20260817-0900001<\/NAME>/);
  assert.match(xml, /<BILLTYPE>Advance<\/BILLTYPE>/);
  assert.doesNotMatch(xml, /<BILLTYPE>Agst Ref<\/BILLTYPE>/);
});

test("bank voucher supports Tally's documented Data import envelope", () => {
  const xml = buildBankVoucherXml(
    {
      companyName: "Solution Nyx",
      voucherType: "Receipt",
      voucherDate: "2026-08-11",
      bankLedgerName: "State Bank of India",
      counterpartyLedgerName: "Indus Metal Recovery",
      bankLedgerEntryIsDebit: true,
      amount: 140000,
      referenceNumber: "SBIN1108260001",
    },
    null,
    { legacyEnvelope: true }
  );

  assert.match(xml, /<HEADER><VERSION>1<\/VERSION><TALLYREQUEST>Import<\/TALLYREQUEST><TYPE>Data<\/TYPE><ID>Vouchers<\/ID><\/HEADER>/);
  assert.match(xml, /<BODY><DESC><STATICVARIABLES>/);
  assert.match(xml, /<\/DESC><DATA><TALLYMESSAGE/);
  assert.doesNotMatch(xml, /<IMPORTDATA>|<REQUESTDESC>|<REQUESTDATA>/);
  assert.match(xml, /<DATE>20260811<\/DATE>/);
  assert.match(xml, /<EFFECTIVEDATE>20260811<\/EFFECTIVEDATE>/);
});

test("bank voucher batch puts every voucher in one documented Tally request", () => {
  const payload = {
    companyName: "Solution Nyx",
    voucherType: "Receipt",
    voucherDate: "2026-08-11",
    bankLedgerName: "State Bank of India",
    counterpartyLedgerName: "Indus Metal Recovery",
    counterpartyIsPartyLedger: true,
    bankLedgerEntryIsDebit: true,
    amount: 140000,
  };
  const xml = buildBankVoucherBatchXml(
    Array.from({ length: 50 }, (_, index) => ({
      ...payload,
      referenceNumber: `BATCH-REF-${index + 1}`,
    })),
    null
  );

  assert.equal((xml.match(/<TALLYMESSAGE\b/g) || []).length, 50);
  assert.equal((xml.match(/<VOUCHER\b/g) || []).length, 50);
  assert.match(xml, /<TALLYREQUEST>Import<\/TALLYREQUEST>/);
  assert.match(xml, /<DESC><STATICVARIABLES>/);
  assert.doesNotMatch(xml, /<IMPORTDATA>|<REQUESTDESC>|<REQUESTDATA>/);
  assert.match(xml, /<VOUCHERNUMBER>BATCH-REF-1<\/VOUCHERNUMBER>/);
  assert.match(xml, /<VOUCHERNUMBER>BATCH-REF-50<\/VOUCHERNUMBER>/);
});

test("bank voucher batch supports mixed voucher types and bill allocation modes", () => {
  const common = {
    companyName: "Solution Nyx",
    voucherDate: "2026-08-22",
    bankLedgerName: "Axis Bank",
    amount: 1000,
  };
  const xml = buildBankVoucherBatchXml(
    [
      {
        ...common,
        voucherType: "Receipt",
        counterpartyLedgerName: "Customer A",
        counterpartyIsPartyLedger: true,
        bankLedgerEntryIsDebit: true,
        referenceNumber: "MIXED-RECEIPT-BILL",
        billAllocations: [{ referenceName: "INV-1", referenceType: "Agst Ref", amount: 1000 }],
      },
      {
        ...common,
        voucherType: "Payment",
        counterpartyLedgerName: "Bank Charges",
        counterpartyIsPartyLedger: false,
        bankLedgerEntryIsDebit: false,
        referenceNumber: "MIXED-PAYMENT-PLAIN",
      },
      {
        ...common,
        voucherType: "Contra",
        counterpartyLedgerName: "Cash",
        counterpartyIsPartyLedger: false,
        bankLedgerEntryIsDebit: true,
        referenceNumber: "MIXED-CONTRA",
      },
    ],
    null
  );

  assert.equal((xml.match(/<TALLYMESSAGE\b/g) || []).length, 3);
  assert.match(xml, /<VOUCHERTYPENAME>Receipt<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<VOUCHERTYPENAME>Payment<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<VOUCHERTYPENAME>Contra<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<BILLTYPE>Agst Ref<\/BILLTYPE>/);

  const mixedKeys = [
    { voucherType: "Receipt", billAllocations: [{ referenceName: "INV-1" }] },
    { voucherType: "Payment", billAllocations: [] },
    { voucherType: "Contra" },
  ].map((variant) =>
    getBankVoucherCommandBatchKey(
      { ...common, ...variant },
      null
    )
  );
  assert.equal(new Set(mixedKeys).size, 1);
});


test("outgoing Contra vouchers debit the destination and credit the statement bank", () => {
  const xml = buildBankVoucherXml({
    companyName: "Solution Nyx",
    voucherType: "Contra",
    voucherDate: "2026-08-17",
    bankLedgerName: "State Bank of India",
    counterpartyLedgerName: "HDFC Bank",
    bankLedgerEntryIsDebit: false,
    amount: 50000,
    referenceNumber: "TRANSFER-1",
  });

  assert.match(xml, /<VOUCHERTYPENAME>Contra<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<LEDGERNAME>HDFC Bank<\/LEDGERNAME>[\s\S]*?<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
  assert.match(xml, /<LEDGERNAME>State Bank of India<\/LEDGERNAME>[\s\S]*?<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/);
  assert.ok(xml.indexOf("<LEDGERNAME>HDFC Bank</LEDGERNAME>") < xml.indexOf("<LEDGERNAME>State Bank of India</LEDGERNAME>"));
});

test("incoming Contra vouchers debit the statement bank and credit the source account", () => {
  const xml = buildBankVoucherXml({
    companyName: "Solution Nyx",
    voucherType: "Contra",
    voucherDate: "2026-08-17",
    bankLedgerName: "State Bank of India",
    counterpartyLedgerName: "Cash",
    bankLedgerEntryIsDebit: true,
    amount: 25000,
    referenceNumber: "CASH-DEPOSIT-1",
  });

  assert.match(xml, /<VOUCHERTYPENAME>Contra<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<LEDGERNAME>State Bank of India<\/LEDGERNAME>[\s\S]*?<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
  assert.match(xml, /<LEDGERNAME>Cash<\/LEDGERNAME>[\s\S]*?<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/);
  assert.ok(xml.indexOf("<LEDGERNAME>State Bank of India</LEDGERNAME>") < xml.indexOf("<LEDGERNAME>Cash</LEDGERNAME>"));
});

test("collection exports apply Tally-side formula filters", () => {
  const xml = buildCollectionExportXml({ collectionName: "Filtered Bills", tallyType: "Bill", fetchFields: "Name,LedgerName,ClosingBalance", companyName: "Solution Nyx", dateTo: "2026-08-17", formulae: [{ name: "RequestedLedger", formula: '$$IsEqual:$LedgerName:"Customer A"' }], filterNames: ["RequestedLedger"] });
  assert.match(xml, /<FILTER>RequestedLedger<\/FILTER>/);
  assert.match(xml, /<SYSTEM TYPE="Formulae" NAME="RequestedLedger"/);
  assert.match(xml, /<SVTODATE TYPE="Date">20260817<\/SVTODATE>/);
});

test("ledger filters remain targeted and deduplicated", () => {
  const formula = buildRequestedLedgerFormula(["Customer A", "Customer A", "Customer B"], ["$LedgerName"]);
  assert.equal((formula.match(/Customer A/g) || []).length, 1);
  assert.equal((formula.match(/Customer B/g) || []).length, 1);
});

test("voucher fallback is required only for incomplete Bill exports", () => {
  const complete = '<BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><BILLTYPE>New Ref</BILLTYPE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL>';
  const incomplete = '<BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><OPENINGBALANCE>500</OPENINGBALANCE></BILL>';
  assert.equal(openBillBlockRequiresVoucherFallback(complete), false);
  assert.equal(openBillBlockRequiresVoucherFallback(incomplete), true);
});

const billCollection = (bills = "") => `<ENVELOPE><STATUS>1</STATUS><COLLECTION>${bills}</COLLECTION></ENVELOPE>`;

test("zero ledger-scoped bills avoids the voucher export", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames: ["Customer A"], queryPurpose: "bank_statement_match" }, { exportCollection: async (_url, options) => { calls.push(options); return billCollection(); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tallyType, "Bills");
  assert.equal(calls[0].childOf, '"Customer A"');
  assert.equal(calls[0].filterNames, undefined);
  assert.deepEqual(result.result.openBills, []);
  assert.equal(result.result.queryDiagnostics.billQueryMode, "ledger_child_of");
  assert.equal(result.result.byLedger["Customer A"].complete, true);
  assert.equal(result.result.queryDiagnostics.voucherFallbackUsed, false);
});

test("complete Bill data avoids the voucher fallback", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames: ["Customer A"] }, { exportCollection: async (_url, options) => { calls.push(options); return '<ENVELOPE><STATUS>1</STATUS><BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><BILLTYPE>New Ref</BILLTYPE><OPENINGBALANCE>500</OPENINGBALANCE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL></ENVELOPE>'; } });
  assert.equal(calls.length, 1);
  assert.equal(result.result.openBills[0].pendingAmount, 500);
});

test("incomplete bank Bill data is held, never a voucher-history fallback", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames: ["Customer A"], queryPurpose: "bank_statement_match" }, { exportCollection: async (_url, options) => { calls.push(options); return billCollection('<BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><OPENINGBALANCE>500</OPENINGBALANCE></BILL>'); } });
  assert.equal(calls.length, 1);
  assert.equal(result.result.byLedger["Customer A"].complete, false);
  assert.match(result.result.byLedger["Customer A"].error, /pending bill balance/);
  assert.equal(result.result.openBills, undefined);
  assert.equal(result.result.queryDiagnostics.voucherFallbackUsed, false);
});

test("51 ledgers stay sequential and ledger-scoped, even with full_snapshot requested", async () => {
  const calls = [];
  let active = 0;
  const ledgerNames = Array.from({ length: 51 }, (_, index) => `Customer ${index + 1}`);
  const result = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames, queryPurpose: "bank_statement_match", queryStrategy: "full_snapshot" }, { exportCollection: async (_url, options) => {
    assert.equal(++active, 1); calls.push(options); await Promise.resolve(); active--; return billCollection();
  } });
  assert.equal(calls.length, 51);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.childOf, JSON.stringify(ledgerNames[index]));
    assert.equal(call.tallyType, "Bills");
    assert.equal(call.filterNames, undefined);
    assert.equal(call.formulae, undefined);
    assert.equal(call.timeoutMs <= 20000, true);
    assert.equal(call.maxResponseBytes, 8 * 1024 * 1024);
  }
  assert.equal(result.result.queryDiagnostics.billQueryMode, "ledger_child_of");
});

test("native IsAdvance and remaining balance are authoritative without voucher evidence", async () => {
  const ledgerNames = ['A & B "Ltd"', 'A-B', 'AB'];
  const calls = [];
  const outcome = await fetchCustomerOpenBillsFromTally({}, { ledgerNames, queryPurpose: "bank_statement_match" }, {
    exportCollection: async (_url, options) => { calls.push(options); return billCollection(
      '<BILL NAME="ADV-named-invoice"><ISADVANCE>No</ISADVANCE><BILLDATE>20260801</BILLDATE><OPENINGBALANCE>-125000</OPENINGBALANCE><CLOSINGBALANCE>-20000</CLOSINGBALANCE></BILL>' +
      '<BILL NAME="Receipt-123"><ISADVANCE>Yes</ISADVANCE><CLOSINGBALANCE>30000</CLOSINGBALANCE></BILL>'); },
  });
  assert.equal(calls.length, 3, "punctuation-distinct ledgers are not merged");
  assert.match(buildCollectionExportXml(calls[0]), /CHILD OF : &quot;A &amp; B \\&quot;Ltd\\&quot;&quot;/);
  const bucket = outcome.result.byLedger[ledgerNames[0]];
  assert.equal(bucket.complete, true);
  assert.equal(bucket.openBills[0].pendingAmount, 20000);
  assert.equal(bucket.openBills[0].originalAmount, 125000);
  assert.equal(bucket.openBills[0].invoiceDate, "2026-08-01");
  assert.equal(bucket.existingAdvances[0].pendingAdvanceAmount, 30000);
  assert.equal(outcome.result.queryDiagnostics.voucherBatchCount, 0);
});

test("partial or unscoped bill XML holds only that ledger, not complete ledgers", async () => {
  const responses = [
    billCollection('<BILL NAME="INV"><PARENT>Wrong ledger</PARENT><ISADVANCE>No</ISADVANCE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL>'),
    billCollection('<BILL NAME="INV"><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL>'),
    '<ENVELOPE><STATUS>1</STATUS></ENVELOPE>',
    billCollection(),
  ];
  const { result } = await fetchCustomerOpenBillsFromTally({}, { ledgerNames: ["A", "B", "C", "D"], queryPurpose: "bank_statement_match" }, {
    exportCollection: async () => responses.shift(),
  });
  for (const name of ["A", "B", "C"]) assert.equal(result.byLedger[name].complete, false);
  assert.equal(result.byLedger.D.complete, true);
  assert.deepEqual(result.byLedger.D.openBills, []);
  assert.equal(result.queryDiagnostics.incompleteLedgerCount, 3);
});

test("timeout stops subsequent reads but preserves completed ledger buckets", async () => {
  let count = 0;
  const { result } = await fetchCustomerOpenBillsFromTally({}, { ledgerNames: ["A", "B", "C"], queryPurpose: "bank_statement_match" }, {
    exportCollection: async () => { if (++count === 2) throw new Error("Tally timed out"); return billCollection(); },
  });
  assert.equal(count, 2);
  assert.equal(result.byLedger.A.complete, true);
  assert.equal(result.byLedger.B.complete, false);
  assert.equal(result.byLedger.C.complete, false);
  assert.match(result.byLedger.C.error, /stopped.*timed out/);
});

test("bank bill response byte limit is enforced before parsing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(8 * 1024 * 1024 + 1)));
  const { result } = await fetchCustomerOpenBillsFromTally({}, { ledgerNames: ["A"], queryPurpose: "bank_statement_match" });
  assert.equal(result.byLedger.A.complete, false);
  assert.match(result.byLedger.A.error, /safe response size/);
});

test("combined ledger results remain bounded for the live socket", async () => {
  let calls = 0;
  const { result } = await fetchCustomerOpenBillsFromTally({}, { ledgerNames: ["A", "B", "C"], queryPurpose: "bank_statement_match" }, {
    exportCollection: async () => { calls++; return billCollection(`<BILL NAME="${"x".repeat(1500000)}"><ISADVANCE>No</ISADVANCE><CLOSINGBALANCE>100</CLOSINGBALANCE></BILL>`); },
  });
  assert.equal(calls, 2);
  assert.equal(result.byLedger.A.complete, true);
  assert.equal(result.byLedger.B.complete, false);
  assert.equal(result.byLedger.C.complete, false);
  assert.match(result.byLedger.B.error, /safe bill-result size/);
  assert.ok(result.queryDiagnostics.billResultBytes < 4 * 1024 * 1024);
});

test("malformed bank response cannot mark every row missing", async () => {
  await assert.rejects(() => reconcileBankTransactionsInTally({}, {
    bankLedgerName: "Bank", includeBalanceProof: false,
    transactions: [{ transactionId: "A", voucherDate: "2026-08-24", amount: 100, expectedDirection: "incoming" }],
  }, { exportCollection: async () => '<ENVELOPE><STATUS>1</STATUS></ENVELOPE>' }), /Duplicate checking could not be completed/);
});

test("a failed Bill query is not reported as an empty result", async () => {
  await assert.rejects(() => fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames: ["Customer A"] }, { exportCollection: async () => { throw new Error("Tally timed out"); } }), /Tally timed out/);
});

function bankVoucher({ reference = "", party = "Customer A" } = {}) {
  return {
    date: "20260801",
    effectiveDate: "20260801",
    reference,
    bankReferences: reference ? [reference] : [],
    partyLedgerName: party,
    ledgerNames: [party, "ICICI Current Account"],
    ledgerEntries: [
      { ledgerName: "ICICI Current Account", amount: 1250, isDebit: true },
      { ledgerName: party, amount: 1250, isDebit: false },
    ],
  };
}

test("strict bank presence retains the exact reference but holds a wrong selected party", () => {
  const result = strictBankTransactionCandidates(
    [bankVoucher({ reference: "UTR-123456", party: "Actual Customer" })],
    {
      voucherDate: "2026-08-01",
      amount: 1250,
      expectedDirection: "incoming",
      referenceNumber: "UTR-123456",
      counterpartyLedgerName: "Wrong Customer",
    },
    "ICICI Current Account",
    new Set()
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.hasUsableReference, true);
  assert.equal(result.identityInsufficient, true);
  assert.deepEqual(result.referenceConflicts, ["party"]);
});

test("a clearly different party without a matching reference is a separate transaction", () => {
  const result = strictBankTransactionCandidates(
    [bankVoucher({ party: "Actual Customer" })],
    {
      voucherDate: "2026-08-01",
      amount: 1250,
      expectedDirection: "incoming",
      counterpartyLedgerName: "Other Customer",
    },
    "ICICI Current Account",
    new Set()
  );
  assert.equal(result.baseCandidateCount, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.identityInsufficient, false);
  assert.equal(result.hasUsableCounterparty, true);
});

test("strict bank presence marks same-date amount evidence insufficient for Suspense", () => {
  const result = strictBankTransactionCandidates(
    [bankVoucher({ party: "Actual Customer" })],
    {
      voucherDate: "2026-08-01",
      amount: 1250,
      expectedDirection: "incoming",
      counterpartyLedgerName: "Suspense",
    },
    "ICICI Current Account",
    new Set()
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.identityInsufficient, true);
});

test("numeric bank references verify Suspense only with exact date, bank amount and direction", () => {
  const transaction = { voucherDate: "2026-08-01", amount: 1250, expectedDirection: "incoming",
    referenceNumber: "1967486047", counterpartyLedgerName: "Suspense" };
  const voucher = bankVoucher({ reference: "1967486047", party: "Suspense" });
  const check = (vouchers, row = transaction) => strictBankTransactionCandidates(vouchers, row, "ICICI Current Account", new Set());
  assert.equal(check([voucher]).hasUsableReference, true);
  assert.equal(check([voucher]).identityInsufficient, false);
  assert.equal(check([voucher]).candidates.length, 1);
  assert.equal(check([voucher], { ...transaction, amount: 1251 }).identityInsufficient, true);
  assert.equal(check([voucher], { ...transaction, expectedDirection: "outgoing" }).identityInsufficient, true);
  assert.equal(check([{ ...voucher, date: "20260731", effectiveDate: "20260731" }]).candidates.length, 0);
  assert.equal(check([voucher], { ...transaction, referenceNumber: "1967486048" }).candidates.length, 0);
  assert.equal(check([bankVoucher({ reference: "00000000", party: "Suspense" })], { ...transaction, referenceNumber: "00000000" }).identityInsufficient, true);
});

test("duplicate numeric references remain ambiguous rather than confirming either voucher", async () => {
  const voucher = bankVoucher({ reference: "1967486047", party: "Suspense" });
  const result = await reconcileBankTransactionsInTally({}, { bankLedgerName: "ICICI Current Account", includeBalanceProof: false,
    transactions: [{ transactionId: "txn", voucherDate: "2026-08-01", amount: 1250, expectedDirection: "incoming",
      referenceNumber: "1967486047", counterpartyLedgerName: "Suspense" }] },
    { voucherProvider: async () => ({ vouchers: [voucher, voucher], diagnostics: {} }) });
  assert.equal(result.result.transactions[0].verificationStatus, "ambiguous");
});

test("a repeated strong reference is ambiguous and a cross-date reference is still found", () => {
  const transaction = {
    voucherDate: "2026-08-01",
    amount: 1250,
    expectedDirection: "incoming",
    referenceNumber: "UTR-123456",
    counterpartyLedgerName: "Customer A",
  };
  const first = bankVoucher({ reference: "UTR-123456" });
  const otherDate = {
    ...bankVoucher({ reference: "UTR-123456" }),
    date: "20260731",
    effectiveDate: "20260731",
  };
  const one = strictBankTransactionCandidates(
    [otherDate], transaction, "ICICI Current Account", new Set()
  );
  assert.equal(one.candidates.length, 1);
  const repeated = strictBankTransactionCandidates(
    [first, otherDate], transaction, "ICICI Current Account", new Set()
  );
  assert.equal(repeated.candidates.length, 2);
});

const MANUAL_BANK_TRANSACTION = {
  transactionId: "manual-row", voucherDate: "2026-08-01", amount: 1250,
  expectedDirection: "incoming", counterpartyLedgerName: "Customer A",
};

async function checkManualBankVouchers(vouchers, transaction = {}) {
  const outcome = await reconcileBankTransactionsInTally({}, {
    bankLedgerName: "ICICI Current Account", includeBalanceProof: false,
    transactions: [{ ...MANUAL_BANK_TRANSACTION, ...transaction }],
  }, { voucherProvider: async () => ({ vouchers, diagnostics: {} }) });
  return outcome.result.transactions[0];
}

test("voucher evidence contains the actual bank entry amount, ledger and direction", async () => {
  const row = await checkManualBankVouchers([bankVoucher()]);
  assert.equal(row.matches[0].amount, 1250);
  assert.equal(row.matches[0].bankLedgerName, "ICICI Current Account");
  assert.equal(row.matches[0].direction, "incoming");
  assert.equal(row.matches[0].partyLedgerName, "Customer A");
});

test("same-date same-amount different-ledger receipts and payments proceed without a duplicate warning", async () => {
  for (const expectedDirection of ["incoming", "outgoing"]) {
    const voucher = bankVoucher({ party: "Arvind Industrial Components" });
    if (expectedDirection === "outgoing") voucher.ledgerEntries = voucher.ledgerEntries.map(entry => ({ ...entry, isDebit: !entry.isDebit }));
    for (const referenceNumber of [undefined, "UTR-123456", "NEFT-ICICI-171A17A86A895CCDCF57"]) {
      const result = await checkManualBankVouchers([voucher], { expectedDirection, counterpartyLedgerName: "BluePeak Fabricators", referenceNumber });
      assert.equal(result.verificationStatus, "missing");
      assert.equal(result.matchCount, 0);
      assert.deepEqual(result.matches, []);
      assert.equal(result.reason, "No matching entry found in Tally.");
    }
  }
});

test("the Axis BluePeak 1101.11 receipt is new despite the same-day Arvind receipt", async () => {
  const voucher = { ...bankVoucher({ party: "Arvind Industrial Components" }), date: "20261008", effectiveDate: "20261008",
    ledgerNames: ["Arvind Industrial Components", "Axis Bank - 7440012233"],
    ledgerEntries: [{ ledgerName: "Axis Bank - 7440012233", amount: -1101.11, isDebit: true },
      { ledgerName: "Arvind Industrial Components", amount: 1101.11, isDebit: false }] };
  const result = await reconcileBankTransactionsInTally({}, { bankLedgerName: "Axis Bank - 7440012233", includeBalanceProof: false,
    transactions: [{ transactionId: "bluepeak", voucherDate: "2026-10-08", amount: 1101.11, expectedDirection: "incoming", referenceNumber: null, counterpartyLedgerName: "BluePeak Fabricators" }] },
    { voucherProvider: async () => ({ vouchers: [voucher], diagnostics: {} }) });
  assert.equal(result.result.transactions[0].verificationStatus, "missing");
  assert.deepEqual(result.result.transactions[0].matches, []);
});

test("the same known party still detects a manual duplicate among different-party coincidences", async () => {
  const result = await checkManualBankVouchers([bankVoucher({ party: "Other Customer" }), bankVoucher()]);
  assert.equal(result.verificationStatus, "found");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].partyLedgerName, "Customer A");
});

test("unavailable party evidence stays under review rather than assuming a different party", async () => {
  const voucher = { ...bankVoucher(), partyLedgerName: "", ledgerNames: ["ICICI Current Account"] };
  assert.equal((await checkManualBankVouchers([voucher])).verificationStatus, "ambiguous");
  const withoutPartyField = { ...bankVoucher({ party: "Other Customer" }), partyLedgerName: "" };
  assert.equal((await checkManualBankVouchers([withoutPartyField])).verificationStatus, "missing");
});

test("an exact reference identifies a party conflict instead of confirming a full match", async () => {
  const row = await checkManualBankVouchers([bankVoucher({ party: "Arvind", reference: "UTR-123456" })], { counterpartyLedgerName: "BluePeak", referenceNumber: "UTR-123456" });
  assert.equal(row.verificationStatus, "ambiguous");
  assert.equal(row.matchBasis, "reference");
  assert.deepEqual(row.referenceConflicts, ["party"]);
  assert.match(row.reason, /different party ledger/);
});

test("generated tracking references do not hide a unique manually entered voucher", async () => {
  const referenceNumber = "NEFT-ICICI-171A17A86A895CCDCF57";
  for (const metadata of [{}, { bankReferenceNumber: null, referenceSource: "generated" }]) {
    const row = await checkManualBankVouchers([bankVoucher()], { referenceNumber, ...metadata });
    assert.equal(row.verificationStatus, "found");
    assert.equal(row.matchBasis, "date_bank_amount_direction_party");
  }
});

test("a PDF UTR still permits a unique manual voucher without a recorded UTR", async () => {
  const row = await checkManualBankVouchers([bankVoucher()], { referenceNumber: "UTR-123456" });
  assert.equal(row.verificationStatus, "found");
});

test("a generated tracking reference still identifies an earlier app posting", async () => {
  const referenceNumber = "NEFT-ICICI-171A17A86A895CCDCF57";
  const row = await checkManualBankVouchers([bankVoucher({ reference: referenceNumber })], {
    referenceNumber, bankReferenceNumber: null, referenceSource: "generated", counterpartyLedgerName: "Suspense",
  });
  assert.equal(row.verificationStatus, "found");
  assert.equal(row.matchBasis, "reference");
});

test("uncertain manual candidates and multiple party matches are held for review", async () => {
  for (const [vouchers, counterpartyLedgerName] of [
    [[bankVoucher()], "Suspense"],
    [[bankVoucher({ party: "Suspense" })], "Customer A"],
    [[bankVoucher(), bankVoucher()], "Customer A"],
  ]) {
    const row = await checkManualBankVouchers(vouchers, { referenceNumber: "UTR-123456", counterpartyLedgerName });
    assert.equal(row.verificationStatus, "ambiguous");
    assert.equal(row.voucherId, null);
    assert.equal(row.reason, "Possible existing entry — please review.");
  }
});

test("a different genuine UTR is a separate transaction even with the same party and amount", async () => {
  for (const voucher of [
    bankVoucher({ reference: "UTR-999999" }),
    { ...bankVoucher(), bankReferences: ["UTR-999999"] },
    { ...bankVoucher(), narration: "UTR: UTR-999999" },
    { ...bankVoucher(), narration: "Bank transfer UTR999999" },
  ]) {
    const row = await checkManualBankVouchers([voucher], { referenceNumber: "UTR-123456" });
    assert.equal(row.verificationStatus, "missing");
  }
});

test("an invoice or unfamiliar manual reference is reviewed instead of treated as a different bank UTR", async () => {
  for (const reference of ["INV-2026-1001", "CUSTOM-123456"]) {
    const row = await checkManualBankVouchers([bankVoucher({ reference })], { referenceNumber: "UTR-123456" });
    assert.equal(row.verificationStatus, "ambiguous");
    assert.equal(row.voucherId, null);
  }
});

test("reference matches in bank details and narration tolerate spacing but never substrings", async () => {
  for (const voucher of [
    { ...bankVoucher(), bankReferences: ["utr 123-456"] },
    { ...bankVoucher(), narration: "Bank receipt. UTR: utr 123-456. Thank you." },
  ]) {
    const row = await checkManualBankVouchers([voucher], { referenceNumber: "UTR123456", counterpartyLedgerName: "Suspense" });
    assert.equal(row.verificationStatus, "found");
    assert.equal(row.matchBasis, "reference");
  }
  for (const narration of ["UTR: XUTR123456", "UTR: UTR1234567"]) {
    const row = await checkManualBankVouchers([{ ...bankVoucher(), narration }], {
      referenceNumber: "UTR123456", counterpartyLedgerName: "Suspense",
    });
    assert.notEqual(row.verificationStatus, "found");
  }
});

test("manual matching requires the bank, date, amount and accounting direction", async () => {
  for (const voucher of [
    { ...bankVoucher(), date: "20260802", effectiveDate: "20260802" },
    { ...bankVoucher(), ledgerEntries: [{ ledgerName: "Other Bank", amount: 1250, isDebit: true }] },
    { ...bankVoucher(), ledgerEntries: [{ ledgerName: "ICICI Current Account", amount: 1251, isDebit: true }] },
    { ...bankVoucher(), ledgerEntries: [{ ledgerName: "ICICI Current Account", amount: 1250, isDebit: false }] },
  ]) {
    assert.equal((await checkManualBankVouchers([voucher])).verificationStatus, "missing");
  }
  assert.equal((await checkManualBankVouchers([])).verificationStatus, "missing");
});

test("repeated rows with the same reliable UTR cannot reuse reservations as permission to post", async () => {
  const transaction = { ...MANUAL_BANK_TRANSACTION, referenceNumber: "UTR-123456" };
  const outcome = await reconcileBankTransactionsInTally({}, {
    bankLedgerName: "ICICI Current Account", includeBalanceProof: false,
    transactions: [transaction, { ...transaction, transactionId: "repeat-row" }],
  }, { voucherProvider: async () => ({ vouchers: [bankVoucher({ reference: "UTR-123456" })], diagnostics: {} }) });
  assert.deepEqual(outcome.result.transactions.map((row) => row.verificationStatus), ["found", "found"]);
});

test("a reserved manual voucher holds an indistinguishable second row for review", async () => {
  const outcome = await reconcileBankTransactionsInTally({}, {
    bankLedgerName: "ICICI Current Account", includeBalanceProof: false,
    transactions: [MANUAL_BANK_TRANSACTION, { ...MANUAL_BANK_TRANSACTION, transactionId: "second-row" }],
  }, { voucherProvider: async () => ({ vouchers: [bankVoucher()], diagnostics: {} }) });
  assert.deepEqual(outcome.result.transactions.map((row) => row.verificationStatus), ["found", "ambiguous"]);
});

test("single-voucher checks also hold multiple reference matches instead of confirming either", async () => {
  const voucherXml = '<VOUCHER><DATE>20260801</DATE><REFERENCE>1967486047</REFERENCE><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>ICICI Current Account</LEDGERNAME><AMOUNT>-1250</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER>';
  const { result } = await verifyBankTransactionInTally({}, {
    ...MANUAL_BANK_TRANSACTION, bankLedgerName: "ICICI Current Account", referenceNumber: "1967486047",
  }, { exportCollection: async () => `<ENVELOPE>${voucherXml}${voucherXml.replace('<DATE>', '<MASTERID>2</MASTERID><DATE>')}</ENVELOPE>` });
  assert.equal(result.verificationStatus, "ambiguous");
  assert.equal(result.voucherId, null);
});

test("cross-date identity reads cannot change the statement-period bank movement", async () => {
  const outcome = await reconcileBankTransactionsInTally({}, {
    bankLedgerName: "ICICI Current Account", includeBalanceProof: false,
    transactions: [{ ...MANUAL_BANK_TRANSACTION, referenceNumber: "UTR-123456" }],
  }, { voucherProvider: async () => ({ vouchers: [bankVoucher(), {
    ...bankVoucher({ reference: "UTR-999999" }), date: "20260731", effectiveDate: "20260731",
  }], diagnostics: {} }) });
  assert.equal(outcome.result.balanceProof.tallyMovement, -1250);
});

test("the primary export finds manual vouchers even when Tally would exclude a Reference-only lookup", async () => {
  for (const referenceNumber of ["NEFT-ICICI-171A17A86A895CCDCF57", "UTR-123456"]) {
    const calls = [];
    const outcome = await reconcileBankTransactionsInTally({}, {
      bankLedgerName: "ICICI Current Account", includeBalanceProof: false,
      transactions: [{ ...MANUAL_BANK_TRANSACTION, referenceNumber }],
    }, { exportCollection: async (_url, options) => {
      calls.push(options);
      if (options.formulae?.some(({ formula }) => formula.includes("$Reference"))) {
        return "<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>";
      }
      return '<ENVELOPE><VOUCHER><DATE>20260801</DATE><MASTERID>101</MASTERID><VOUCHERNUMBER>MANUAL-1</VOUCHERNUMBER><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>ICICI Current Account</LEDGERNAME><AMOUNT>-1250</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME><AMOUNT>1250</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER></ENVELOPE>';
    } });
    assert.equal(outcome.result.transactions[0].verificationStatus, "found");
    assert.equal(outcome.result.transactions[0].voucherId, "101");
    assert.equal(calls[0].formulae, undefined);
    assert.equal(calls.length, referenceNumber.startsWith("NEFT-ICICI-") ? 1 : 2);
  }
});

test("an incomplete or unavailable duplicate read never becomes missing", async () => {
  for (const exportCollection of [
    async () => "<ENVELOPE><COLLECTION>",
    async () => "<ENVELOPE><LINEERROR>Read failed</LINEERROR></ENVELOPE>",
    async () => { throw new Error("Tally unavailable"); },
  ]) {
    await assert.rejects(reconcileBankTransactionsInTally({}, {
      bankLedgerName: "ICICI Current Account", includeBalanceProof: false,
      transactions: [MANUAL_BANK_TRANSACTION],
    }, { exportCollection }));
  }
});

test("statement reconciliation reads manual entries and finds financial-year references independently of amount", async () => {
  const calls = [];
  const outcome = await reconcileBankTransactionsInTally(
    { tallyUrl: "http://127.0.0.1:9000" },
    {
      companyName: "Solution Nyx",
      bankLedgerName: "ICICI Current Account",
      includeBalanceProof: false,
      transactions: [{
        transactionId: "txn-1",
        voucherDate: "2026-08-01",
        amount: 1250,
        debitAmount: 0,
        creditAmount: 1250,
        expectedDirection: "incoming",
        referenceNumber: "UTR-123456",
        counterpartyLedgerName: "Customer A",
      }],
    },
    {
      exportCollection: async (_url, options) => {
        calls.push(options);
        return '<ENVELOPE><VOUCHER><DATE>20260801</DATE><EFFECTIVEDATE>20260801</EFFECTIVEDATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER><REFERENCE>UTR-123456</REFERENCE><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME><MASTERID>101</MASTERID><ALLLEDGERENTRIES.LIST><LEDGERNAME>ICICI Current Account</LEDGERNAME><AMOUNT>-1250</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME><AMOUNT>1250</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER></ENVELOPE>';
      },
    }
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0].fetchFields, /AllLedgerEntries\.BankAllocations\.\*/);
  assert.equal(calls[0].tallyType, "Vouchers : Ledger");
  assert.equal(calls[0].childOf, '"ICICI Current Account"');
  assert.equal(calls[0].dateFrom, "2026-08-01");
  assert.equal(calls[0].dateTo, "2026-08-01");
  assert.equal(calls[0].formulae, undefined);
  assert.equal(calls[1].dateFrom, "2026-04-01");
  assert.equal(calls[1].dateTo, "2027-03-31");
  assert.equal(calls[1].tallyType, "Vouchers : Ledger");
  assert.equal(calls[1].childOf, '\"ICICI Current Account\"');
  assert.equal(calls[1].formulae, undefined);
  assert.equal(calls[1].filterNames, undefined);
  assert.equal(outcome.result.transactions[0].verificationStatus, "found");
  assert.equal(outcome.result.queryDiagnostics.detailBatchCount, 0);
  assert.equal(outcome.result.queryDiagnostics.queryMode, "bank_ledger_plus_financial_year_reference");
});

test("statement reconciliation reads bank allocations from the primary export", async () => {
  const calls = [];
  const outcome = await reconcileBankTransactionsInTally(
    { tallyUrl: "http://127.0.0.1:9000" },
    {
      companyName: "Solution Nyx",
      bankLedgerName: "ICICI Current Account",
      includeBalanceProof: false,
      transactions: [{
        transactionId: "txn-1",
        voucherDate: "2026-08-01",
        amount: 1250,
        debitAmount: 0,
        creditAmount: 1250,
        expectedDirection: "incoming",
        referenceNumber: "UTR-123456",
        counterpartyLedgerName: "Customer A",
      }],
    },
    {
      exportCollection: async (_url, options) => {
        calls.push(options);
        return '<ENVELOPE><VOUCHER><DATE>20260801</DATE><EFFECTIVEDATE>20260801</EFFECTIVEDATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME><MASTERID>101</MASTERID><ALLLEDGERENTRIES.LIST><LEDGERNAME>ICICI Current Account</LEDGERNAME><AMOUNT>-1250</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><BANKALLOCATIONS.LIST><INSTRUMENTNUMBER>UTR-123456</INSTRUMENTNUMBER></BANKALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME><AMOUNT>1250</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER></ENVELOPE>';
      },
    }
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0].fetchFields, /AllLedgerEntries\.BankAllocations\.\*/);
  assert.equal(outcome.result.transactions[0].verificationStatus, "found");
  assert.equal(outcome.result.queryDiagnostics.detailedVoucherCount, 0);
  assert.equal(outcome.result.queryDiagnostics.primaryIncludesBankReferences, true);
});

test("live statement matching verifies vouchers and fetches bills in one connector operation", async () => {
  const calls = [];
  const outcome = await matchBankStatementInTally(
    { tallyUrl: "http://127.0.0.1:9000" },
    {
      companyName: "Solution Nyx",
      bankLedgerName: "ICICI Current Account",
      includeBalanceProof: false,
      asOfDate: "2026-08-01",
      billEligibleTransactionIds: ["txn-found", "txn-missing"],
      transactions: [
        {
          transactionId: "txn-found",
          voucherDate: "2026-08-01",
          amount: 1250,
          expectedDirection: "incoming",
          referenceNumber: "UTR-FOUND-1",
          counterpartyLedgerName: "Customer A",
        },
        {
          transactionId: "txn-missing",
          voucherDate: "2026-08-01",
          amount: 500,
          expectedDirection: "incoming",
          referenceNumber: "UTR-MISSING-1",
          counterpartyLedgerName: "Customer B",
        },
      ],
    },
    {
      exportCollection: async (_url, options) => {
        calls.push(options);
        if (options.tallyType === "Vouchers : Ledger") {
          return '<ENVELOPE><VOUCHER><DATE>20260801</DATE><EFFECTIVEDATE>20260801</EFFECTIVEDATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER><REFERENCE>UTR-FOUND-1</REFERENCE><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME><MASTERID>101</MASTERID><ALLLEDGERENTRIES.LIST><LEDGERNAME>ICICI Current Account</LEDGERNAME><AMOUNT>-1250</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME><AMOUNT>1250</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER></ENVELOPE>';
        }
        return billCollection('<BILL NAME="INV-B-1"><LEDGERNAME>Customer B</LEDGERNAME><ISADVANCE>No</ISADVANCE><BILLDATE>20260720</BILLDATE><OPENINGBALANCE>500</OPENINGBALANCE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL>');
      },
    }
  );

  assert.equal(calls.length, 3);
  assert.equal(outcome.result.transactions[0].verificationStatus, "found");
  assert.equal(outcome.result.transactions[1].verificationStatus, "missing");
  assert.deepEqual(outcome.result.billLedgerNames, ["Customer B"]);
  assert.equal(outcome.result.openBillsByLedger["Customer B"].openBills.length, 1);
  assert.equal(outcome.result.openBillsByLedger["Customer A"], undefined);
  assert.equal(outcome.result.matchDiagnostics.openBillCheck.requestedLedgerCount, 1);
});

test("Suspense and non-bill-wise rows get duplicate checking but no bill reads", async () => {
  const calls = [];
  const { result } = await matchBankStatementInTally({}, {
    bankLedgerName: "Bank", includeBalanceProof: false,
    billEligibleTransactionIds: ["party", "suspense"],
    transactions: ["party", "suspense", "direct"].map((id) => ({
      transactionId: id, voucherDate: "2026-08-24", amount: 100,
      expectedDirection: "incoming", referenceNumber: id,
      counterpartyLedgerName: id === "party" ? "Customer" : id === "suspense" ? "Suspense" : "Interest Income",
    })),
  }, { exportCollection: async (_url, options) => { calls.push(options); return billCollection(); } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.childOf), ['"Bank"', '"Customer"']);
  assert.equal(result.transactions.length, 3);
  assert.ok(result.transactions.every((row) => row.verificationStatus === "missing"));
  assert.deepEqual(result.billLedgerNames, ["Customer"]);
});

test("open-bill classification preserves invoices and recovers exported advances", () => {
  assert.equal(
    classifyOpenBillReferenceKind({ billType: "Advance", referenceName: "RCPT-1" }),
    "advance"
  );
  assert.equal(
    classifyOpenBillReferenceKind({ referenceName: "ADV-0007", sourceVoucherType: "Receipt" }),
    "advance"
  );
  assert.equal(
    classifyOpenBillReferenceKind({ referenceName: "ADV-0007", knownInvoice: true }),
    "bill"
  );
  assert.equal(
    classifyOpenBillReferenceKind({ referenceName: "INV-0007", sourceVoucherType: "Sales" }),
    "bill"
  );
});

test("bank discovery returns ledgers nested below Bank Accounts, never groups", () => {
  const groups = [
    { name: "Current Assets", parent: "Primary" },
    { name: "Bank Accounts", parent: "Current Assets" },
    { name: "QA Current Accounts", parent: "Bank Accounts" },
    { name: "Deeply Nested Banks", parent: "QA Current Accounts" },
    { name: "Sundry Debtors", parent: "Current Assets" },
  ];
  const ledgers = [
    { name: "Direct Bank", parent: "Bank Accounts" },
    { name: "Nested HDFC Bank", parent: "QA Current Accounts" },
    { name: "Deep Bank", parent: "Deeply Nested Banks" },
    { name: "Ordinary Customer", parent: "Sundry Debtors" },
    { name: "Metadata Bank", parent: "Current Assets", bankAccountNumber: "50123456789" },
  ];

  assert.deepEqual(
    findBankLedgersFromMasters(ledgers, groups).map((item) => item.name),
    ["Direct Bank", "Nested HDFC Bank", "Deep Bank", "Metadata Bank"]
  );
});

test("bank discovery terminates safely when custom group ancestry contains a cycle", () => {
  const groups = [
    { name: "Cycle A", parent: "Cycle B" },
    { name: "Cycle B", parent: "Cycle A" },
  ];
  const ledgers = [{ name: "Not A Bank", parent: "Cycle A" }];

  assert.deepEqual(findBankLedgersFromMasters(ledgers, groups), []);
});

function ledger(name, { dutyHead = "", taxType = "", parent = "Duties & Taxes" } = {}) {
  return {
    name,
    guid: `guid:${name}`,
    parent,
    raw: { dutyHead, taxType },
  };
}

test("GST and withholding ledgers are classified independently", () => {
  const inputCgst = ledger("Input CGST 9%", { dutyHead: "CGST", taxType: "GST" });
  const inputSgst = ledger("Input SGST 9%", { dutyHead: "SGST/UTGST", taxType: "GST" });
  const tdsPayable = ledger("TDS Payable - Scrap", { taxType: "TDS" });
  const tcsReceivable = ledger("TCS Receivable", { taxType: "TCS" });
  const roundOff = ledger("Round Off");

  const result = classifyTaxLedgers([
    inputCgst,
    inputSgst,
    tdsPayable,
    tcsReceivable,
    roundOff,
  ]);

  assert.deepEqual(result.gstLedgers.map((item) => item.name), [
    "Input CGST 9%",
    "Input SGST 9%",
  ]);
  assert.deepEqual(result.taxLedgers.map((item) => item.name), [
    "TDS Payable - Scrap",
    "TCS Receivable",
  ]);
});

test("Purchase vouchers use Tally's item-invoice envelope and allocation tags", () => {
  const xml = buildPurchaseVoucherXml({
    companyName: "Solution Nyx",
    voucherDate: "2026-07-29",
    supplierInvoiceDate: "2026-07-28",
    supplierInvoiceNumber: "VIS/26-27/0142",
    supplierLedgerName: "Vertex Industrial Supplies",
    sourceDocumentPath: "C:\\Gajkesari Documents\\VIS-0142.pdf",
    sourceDocumentName: "VIS-0142.pdf",
    sourceDocumentSha256: "ABC123",
    sourceDocumentId: "file-1",
    sourceDocumentReference: "https://app.example/cases/case-1?sourceFileId=file-1",
    postingId: "internal-posting-id",
    finalPayableAmount: 292500,
    items: [{
      stockItemName: "M S Scrap & Sponge Iron",
      purchaseLedgerName: "M.S. Scrap Purchase",
      description: "Mild Steel Scrap - HMS",
      hsn: "72044900",
      quantity: 10,
      unit: "MTS",
      rate: 25000,
      taxableAmount: 250000,
    }],
    charges: [
      { kind: "freight", name: "Transportation Inward @ 18.00%", amount: 1000 },
      { kind: "cgst", name: "Input ITC CGST 9%", amount: 22590 },
      { kind: "sgst", name: "Input ITC SGST 9%", amount: 22590 },
    ],
    withholdings: [
      { kind: "tds_194q", name: "TDS Payable @ 0.10% (194Q)", amount: 250 },
      { kind: "transport_tds", name: "Tds on Goods Transport", amount: 10 },
      { kind: "cgst_tds", name: "CGST TDS PAYABLE 1%", amount: 2500 },
      { kind: "sgst_tds", name: "SGST TDS PAYABLE 1%", amount: 2500 },
    ],
  });

  assert.match(xml, /<TALLYREQUEST>Import<\/TALLYREQUEST><TYPE>Data<\/TYPE><ID>Vouchers<\/ID>/);
  assert.match(xml, /<DATA><TALLYMESSAGE/);
  assert.match(xml, /<LEDGERENTRIES\.LIST>/);
  assert.doesNotMatch(xml, /<ALLLEDGERENTRIES\.LIST>/);
  assert.match(xml, /<BATCHALLOCATIONS\.LIST><GODOWNNAME>Main Location<\/GODOWNNAME>/);
  assert.match(xml, /<GSTHSNINFERAPPLICABILITY>Specify Details Here<\/GSTHSNINFERAPPLICABILITY>/);
  assert.match(xml, /<GSTHSNNAME>72044900<\/GSTHSNNAME>/);
  assert.match(xml, /<DATE>20260729<\/DATE>/);
  assert.match(xml, /<REFERENCEDATE>20260728<\/REFERENCEDATE>/);
  assert.match(
    xml,
    /<BILLALLOCATIONS\.LIST><NAME>VIS\/26-27\/0142<\/NAME><BILLTYPE>New Ref<\/BILLTYPE><BILLDATE>20260729<\/BILLDATE><AMOUNT>292500\.00<\/AMOUNT><\/BILLALLOCATIONS\.LIST>/
  );
  assert.match(xml, /<LEDGERNAME>Transportation Inward @ 18\.00%<\/LEDGERNAME>/);
  assert.match(xml, /<LEDGERNAME>TDS Payable @ 0\.10% \(194Q\)<\/LEDGERNAME>/);
  assert.match(xml, /<LEDGERNAME>CGST TDS PAYABLE 1%<\/LEDGERNAME>/);
  assert.match(xml, /<UDF:GAJKESARISOURCEDOCUMENTPATH\.LIST[^>]*INDEX="30001">/);
  assert.match(xml, /C:\\Gajkesari Documents\\VIS-0142\.pdf/);
  assert.match(xml, /<UDF:GAJKESARISOURCEDOCUMENTSHA256[^>]*>ABC123<\/UDF:GAJKESARISOURCEDOCUMENTSHA256>/);
  assert.match(xml, /<UDF:GAJKESARISOURCEDOCUMENTID[^>]*>file-1<\/UDF:GAJKESARISOURCEDOCUMENTID>/);
  assert.doesNotMatch(xml, /Source: https:\/\/app\.example/);
  assert.doesNotMatch(xml, /Posting: internal-posting-id/);
});

test("Tally import exceptions are reported as failures", () => {
  const outcome = parseTallyImportResult(
    "<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>1</EXCEPTIONS></RESPONSE>",
    200
  );

  assert.equal(outcome.success, false);
  assert.equal(outcome.result.exceptions, 1);
  assert.match(outcome.error, /1 import exception/);
});

test("Purchase voucher verification includes the attached source PDF identity", () => {
  const payload = {
    voucherDate: "2026-07-29",
    supplierInvoiceDate: "2026-07-28",
    supplierInvoiceNumber: "VIS/26-27/0142",
    supplierLedgerName: "Vertex Industrial Supplies",
    finalPayableAmount: 292500,
    items: [],
    charges: [],
    withholdings: [],
    sourceDocumentPath: "C:\\Gajkesari Documents\\VIS-0142.pdf",
    sourceDocumentName: "VIS-0142.pdf",
    sourceDocumentSha256: "ABC123",
    sourceDocumentId: "file-1",
  };
  const voucher = {
    date: "20260729",
    referenceDate: "20260728",
    inventoryEntries: [],
    ledgerEntries: [{
      ledgerName: "Vertex Industrial Supplies",
      amount: 292500,
    }],
    billAllocations: [{
      referenceName: "VIS/26-27/0142",
      billType: "New Ref",
      billDate: "20260729",
      amount: 292500,
    }],
    sourceDocumentPath: payload.sourceDocumentPath,
    sourceDocumentName: payload.sourceDocumentName,
    sourceDocumentSha256: payload.sourceDocumentSha256,
    sourceDocumentId: payload.sourceDocumentId,
  };

  assert.deepEqual(purchaseVoucherReadbackComparison(voucher, payload), []);
  assert.ok(
    purchaseVoucherReadbackComparison(
      { ...voucher, sourceDocumentSha256: null },
      payload
    ).some((difference) => /checksum/i.test(difference))
  );
  assert.ok(
    purchaseVoucherReadbackComparison(
      {
        ...voucher,
        billAllocations: [{ ...voucher.billAllocations[0], billDate: "20260728" }],
      },
      payload
    ).some((difference) => /outstanding bill date/i.test(difference))
  );
});


const bank='ICICI Bank - 8822014500',reference='UTIBN26300002502';
const row={transactionId:'changed-payment',voucherDate:'2026-10-25',amount:2382.5,
  expectedDirection:'outgoing',bankLedgerName:bank,counterpartyLedgerName:'Deccan Sponge and Minerals',
  referenceNumber:reference,bankReferenceNumber:reference,voucherType:'Payment'};
function voucher({amount=2383.5,direction='outgoing',ref=reference,name=bank,date='20261025'}={}) {
  return {date,effectiveDate:date,voucherType:'Payment',voucherNumber:'5310',masterId:'28778',reference:ref,
    bankReferences:[],partyLedgerName:row.counterpartyLedgerName,ledgerNames:[name,row.counterpartyLedgerName],
    ledgerEntries:[{ledgerName:name,amount:direction==='incoming'?-amount:amount,isDebit:direction==='incoming'},
      {ledgerName:row.counterpartyLedgerName,amount:direction==='incoming'?amount:-amount,isDebit:direction!=='incoming'}]};
}
async function check(vouchers, transaction=row) {
  return (await reconcileBankTransactionsInTally({}, {bankLedgerName:bank,includeBalanceProof:false,transactions:[transaction]},
    {voucherProvider:async()=>({vouchers,diagnostics:{}})})).result.transactions[0];
}
function xml(v) {
  return `<ENVELOPE><COLLECTION><VOUCHER><DATE>${v.date}</DATE><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><MASTERID>${v.masterId}</MASTERID><VOUCHERNUMBER>${v.voucherNumber}</VOUCHERNUMBER><REFERENCE>${v.reference}</REFERENCE><PARTYLEDGERNAME>${v.partyLedgerName}</PARTYLEDGERNAME>${v.ledgerEntries.map(e=>`<ALLLEDGERENTRIES.LIST><LEDGERNAME>${e.ledgerName}</LEDGERNAME><AMOUNT>${e.amount}</AMOUNT><ISDEEMEDPOSITIVE>${e.isDebit?'Yes':'No'}</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST>`).join('')}</VOUCHER></COLLECTION></ENVELOPE>`;
}

function partyEditedVoucher(options={}) {
  const v=voucher({amount:2382.5,...options});
  return {...v,partyLedgerName:'Balaji Alloy Traders',ledgerNames:[bank,'Balaji Alloy Traders'],
    ledgerEntries:v.ledgerEntries.map(e=>({...e,ledgerName:e.ledgerName===row.counterpartyLedgerName?'Balaji Alloy Traders':e.ledgerName}))};
}

async function separateDecision(existing=voucher({amount:2382.5,ref:''})) {
  const transaction={...row,referenceNumber:'',bankReferenceNumber:null};
  const observation=await check([existing],transaction);
  return {action:'separate',context:duplicateContext(transaction,bank,row.counterpartyLedgerName),
    candidates:[candidateIdentity(observation.matches[0])],decidedBy:'owner',decidedAt:'2026-10-25T12:00:00Z'};
}

test('a reviewed separate payment is missing in both the batch screen and final single check',async()=>{
  const existing=voucher({amount:2382.5,ref:''}),duplicateResolution=await separateDecision(existing);
  const transactions=[{...row,transactionId:'original',referenceNumber:'',bankReferenceNumber:null},
    {...row,transactionId:'separate',referenceNumber:'',bankReferenceNumber:null,duplicateResolution}];
  const outcome=await reconcileBankTransactionsInTally({}, {bankLedgerName:bank,includeBalanceProof:false,transactions},
    {voucherProvider:async()=>({vouchers:[existing],diagnostics:{}})});
  assert.deepEqual(outcome.result.transactions.map(r=>r.verificationStatus),['found','missing']);
  assert.equal((await verifyBankTransactionInTally({},transactions[1],{exportCollection:async()=>xml(existing)})).result.verificationStatus,'missing');
});

test('edited or deleted reviewed vouchers invalidate a separate-payment decision',async()=>{
  const duplicateResolution=await separateDecision();
  for(const vouchers of [[],[voucher({amount:2383.5,ref:''})],[partyEditedVoucher({ref:''})],[voucher({amount:2382.5,ref:'UTR123456'})]]){
    const result=await check(vouchers,{...row,referenceNumber:'',bankReferenceNumber:null,duplicateResolution});
    assert.equal(result.verificationStatus,'ambiguous');assert.match(result.reason,/reviewed.*changed or is unavailable/);
  }
});

test('the separate-payment choice never overrides a genuine bank UTR',async()=>{
  const existing=voucher({amount:2382.5,ref:''}),duplicateResolution=await separateDecision(existing);
  const result=await check([existing],{...row,duplicateResolution});
  assert.equal(result.verificationStatus,'ambiguous');
});

test('a newly appeared manual payment stays visible despite approval of another voucher',async()=>{
  const existing=voucher({amount:2382.5,ref:''}),duplicateResolution=await separateDecision(existing);
  const newer={...existing,masterId:'new-manual',voucherNumber:'new-manual'};
  const result=await check([existing,newer],{...row,referenceNumber:'',bankReferenceNumber:null,duplicateResolution});
  assert.equal(result.verificationStatus,'found');assert.equal(result.voucherNumber,'new-manual');
});

test('retrying a posted separate payment finds its own tracking reference instead of creating again',async()=>{
  const existing=voucher({amount:2382.5,ref:''}),duplicateResolution=await separateDecision(existing);
  const tracking='PMT-ICICI-AAAAAAAAAAAAAAAAAAAA';
  const posted={...voucher({amount:2382.5,ref:tracking}),masterId:'new-posted',voucherNumber:'new-posted'};
  const transaction={...row,referenceNumber:tracking,bankReferenceNumber:null,referenceSource:'generated',duplicateResolution};
  const result=await check([existing,posted],transaction);
  assert.equal(result.verificationStatus,'found');assert.equal(result.voucherNumber,'new-posted');
});

test('same-UTR party changes retain both parties and require review for payments and receipts',async()=>{
  for(const direction of ['outgoing','incoming']){
    const result=await check([partyEditedVoucher({direction})],{...row,expectedDirection:direction});
    assert.equal(result.verificationStatus,'ambiguous');assert.deepEqual(result.referenceConflicts,['party']);
    assert.equal(result.matches[0].partyLedgerName,'Balaji Alloy Traders');
    assert.equal(result.matches[0].voucherNumber,'5310');assert.equal(result.voucherId,null);
    assert.match(result.reason,/different party ledger/);
    assert.match(result.reason,/Statement party: Deccan Sponge and Minerals; Tally party: Balaji Alloy Traders/);
  }
});

test('party conflicts preserve amount and direction conflicts instead of hiding them',async()=>{
  const result=await check([partyEditedVoucher({amount:2383.5,direction:'incoming'})]);
  assert.equal(result.verificationStatus,'ambiguous');
  assert.deepEqual(result.referenceConflicts,['amount','direction','party']);
  assert.match(result.reason,/different amount/);assert.match(result.reason,/direction/);assert.match(result.reason,/party ledger/);
  assert.match(result.reason,/2,382.50.*2,383.50/);
});

test('unknown statement parties do not invent a same-UTR party mismatch',async()=>{
  for(const counterpartyLedgerName of ['', 'Suspense', 'Suspense A/c']){
    assert.equal((await check([partyEditedVoucher()],{...row,counterpartyLedgerName})).verificationStatus,'found');
  }
  const original=voucher({amount:2382.5});
  assert.equal((await check([original],{...row,counterpartyLedgerName:'  deccan sponge and minerals  '})).verificationStatus,'found');
});

test('a party conflict cannot block a genuinely different UTR or another bank',async()=>{
  assert.equal((await check([partyEditedVoucher({ref:'UTIBN26300999999'})])).verificationStatus,'missing');
  const otherBank=partyEditedVoucher();otherBank.ledgerNames=['Other Bank','Balaji Alloy Traders'];
  otherBank.ledgerEntries=otherBank.ledgerEntries.map(e=>({...e,ledgerName:e.ledgerName===bank?'Other Bank':e.ledgerName}));
  assert.equal((await check([otherBank])).verificationStatus,'missing');
});

test('live screen rechecks refresh a changed party and never prepare bill allocation',async(t)=>{
  const baseDir=fs.mkdtempSync(path.join(os.tmpdir(),'gajkesari-party-conflict-'));
  t.after(()=>fs.rmSync(baseDir,{recursive:true,force:true}));
  let changed=false;let billReads=0;
  const dependencies={localMatchingBaseDir:baseDir,voucherProvider:refreshCachedBankVouchers,
    exportCollection:async(_url,options)=>{
      if(options.tallyType!=='Vouchers : Ledger'){billReads++;throw Error('Conflict must not load bills');}
      return xml(changed?partyEditedVoucher():voucher({amount:2382.5}));
    }};
  const request={bankLedgerName:bank,includeBalanceProof:false,transactions:[row],billEligibleTransactionIds:[row.transactionId]};
  assert.equal((await matchBankStatementInTally({},request,dependencies)).result.transactions[0].verificationStatus,'found');
  changed=true;
  for(let i=0;i<2;i++){
    const {result}=await matchBankStatementInTally({},request,dependencies);
    assert.equal(result.transactions[0].verificationStatus,'ambiguous');
    assert.deepEqual(result.transactions[0].referenceConflicts,['party']);assert.deepEqual(result.billLedgerNames,[]);
  }
  assert.equal(billReads,0);
});

test('single-payment final preflight blocks a same-UTR party change without importing',async()=>{
  let imports=0;const blocked=()=>{imports++;throw Error('must not import')};
  const execute=new Function('resolveBankVoucherLedgerPayloads','validateBankVoucherBillAllocationsLive',
    'verifyBankTransactionInTally','buildBankVoucherXml','invokeTallyXml',`return (${postBankVoucher.toString()});`)(
    async(_,rows)=>rows,async(_,rows)=>rows,
    (config,payload)=>verifyBankTransactionInTally(config,payload,{exportCollection:async()=>xml(partyEditedVoucher())}),blocked,blocked);
  const result=await execute('http://unused',row,'Solution Nyx');
  assert.equal(result.outcome.success,false);assert.equal(result.outcome.result.possibleDuplicateInTally,true);
  assert.match(result.outcome.error,/different party ledger/);assert.equal(result.xml,null);assert.equal(imports,0);
});

test('batch final preflight holds a party conflict and skips an exact existing row without import',async()=>{
  const outcomes=[],imports=[];
  const dependencies={getBankVoucherCommandBatchKey,
    resolveBankVoucherLedgerPayloads:async(_,rows)=>rows.map(payload=>({payload})),
    validateBankVoucherBillAllocationsLive:async(_,rows)=>rows,assertCommandTarget:async()=>{},
    reconcileBankTransactionsInTally:async(config,payload)=>reconcileBankTransactionsInTally(config,payload,
      {voucherProvider:async()=>({vouchers:[partyEditedVoucher()],diagnostics:{}})}),
    sendCommandResult:async(_,command,outcome)=>outcomes.push({command,outcome}),
    sendCommandResults:async(_,rows)=>outcomes.push(...rows),
    buildBankVoucherBatchXml:()=>{imports.push('build');throw Error('must not build')},
    console:{log(){},warn(){},error(){}},
  };
  const execute=new Function(...Object.keys(dependencies),`return (${runBankVoucherCommandBatch.toString()});`)(...Object.values(dependencies));
  await execute({tallyUrl:'http://unused',companyName:'Solution Nyx'},[
    {id:'party-conflict',payload:row},
    {id:'exact',payload:{...row,transactionId:'exact',counterpartyLedgerName:'Balaji Alloy Traders'}},
  ]);
  assert.equal(outcomes.length,2);assert.equal(imports.length,0);
  const conflict=outcomes.find(r=>r.command.id==='party-conflict').outcome;
  assert.equal(conflict.success,false);assert.deepEqual(conflict.result.duplicateCheck.referenceConflicts,['party']);
  const exact=outcomes.find(r=>r.command.id==='exact').outcome;
  assert.equal(exact.success,true);assert.equal(exact.result.alreadyInTally,true);assert.equal(exact.result.created,0);
});

test('changed Tally payment retains the same-UTR candidate and both real amounts',async()=>{
  const result=await check([voucher()]);
  assert.equal(result.verificationStatus,'ambiguous');assert.equal(result.matchBasis,'reference');
  assert.deepEqual(result.referenceConflicts,['amount']);assert.equal(result.voucherNumber,null);
  assert.equal(result.matches[0].voucherNumber,'5310');assert.equal(result.matches[0].amount,2383.5);
  assert.match(result.reason,/same reference.*different amount/);assert.match(result.reason,/2,382.50.*2,383.50/);
});

test('single-voucher final checks return the same conflict as the statement check',async()=>{
  const {result}=await verifyBankTransactionInTally({},row,{exportCollection:async()=>xml(voucher())});
  assert.equal(result.verificationStatus,'ambiguous');assert.deepEqual(result.referenceConflicts,['amount']);
  assert.equal(result.matches[0].amount,2383.5);assert.equal(result.voucherId,null);
});

test('incoming receipts and reversed directions also require review for the same reference',async()=>{
  const incoming=await check([voucher({direction:'incoming'})],{...row,expectedDirection:'incoming'});
  assert.equal(incoming.verificationStatus,'ambiguous');assert.equal(incoming.matches[0].amount,2383.5);
  const reversed=await check([voucher({direction:'incoming',amount:2382.5})]);
  assert.equal(reversed.verificationStatus,'ambiguous');assert.deepEqual(reversed.referenceConflicts,['direction']);
});

test('bank-allocation and narration references cannot lose a changed amount',async()=>{
  for(const v of [{...voucher({ref:''}),bankReferences:[reference]},
    {...voucher({ref:''}),narration:'Bank payment UTR: '+reference}]) {
    assert.equal((await check([v])).verificationStatus,'ambiguous');
  }
});

test('exact matching and conflicting vouchers with one UTR cannot confirm either',async()=>{
  const result=await check([voucher(),{...voucher({amount:2382.5}),masterId:'other',voucherNumber:'other'}]);
  assert.equal(result.verificationStatus,'ambiguous');assert.equal(result.matchCount,2);
  assert.equal(result.duplicateInTally,true);
});

test('same references in other banks and different genuine UTRs do not block new payments',async()=>{
  for(const v of [voucher({name:'Another Bank'}),voucher({ref:'UTIBN26300999999'})]) {
    assert.equal((await check([v])).verificationStatus,'missing');
  }
  assert.equal((await check([voucher({amount:2382.5})])).verificationStatus,'found');
});

test('numeric and generated references retain their existing date scope',async()=>{
  for(const ref of ['1967486047','PMT-ICICI-6AFE8144CC2DB5FEABCF']) {
    const transaction={...row,referenceNumber:ref,bankReferenceNumber:ref.startsWith('PMT-')?null:ref};
    assert.equal((await check([voucher({ref})],transaction)).verificationStatus,'ambiguous');
    assert.equal((await check([voucher({ref,date:'20261024'})],transaction)).verificationStatus,'missing');
  }
});

test('same-amount receipts with another known party and no matching UTR stay new',async()=>{
  const result=await check([voucher({amount:2382.5,ref:''})],{...row,referenceNumber:null,bankReferenceNumber:null,counterpartyLedgerName:'Another Supplier'});
  assert.equal(result.verificationStatus,'missing');
});

test('single-payment execution returns before building or importing a conflicting voucher',async()=>{
  let imports=0;
  const blocked=()=>{imports++;throw new Error('must not import a conflict')};
  const execute=new Function('resolveBankVoucherLedgerPayloads','validateBankVoucherBillAllocationsLive',
    'verifyBankTransactionInTally','buildBankVoucherXml','invokeTallyXml',`return (${postBankVoucher.toString()});`)(
    async(_,rows)=>rows,async(_,rows)=>rows,async()=>({success:true,result:await check([voucher()])}),blocked,blocked);
  const result=await execute('http://unused',row,'Solution Nyx');
  assert.equal(result.outcome.success,false);assert.equal(result.outcome.result.possibleDuplicateInTally,true);
  assert.equal(result.xml,null);assert.equal(imports,0);assert.match(result.outcome.error,/different amount/);
});

test('batch final preflight blocks the changed payment and skips the genuine existing one without import',async()=>{
  const outcomes=[],imports=[];
  const dependencies={getBankVoucherCommandBatchKey,
    resolveBankVoucherLedgerPayloads:async(_,rows)=>rows.map(payload=>({payload})),
    validateBankVoucherBillAllocationsLive:async(_,rows)=>rows,assertCommandTarget:async()=>{},
    reconcileBankTransactionsInTally:async(config,payload)=>reconcileBankTransactionsInTally(config,payload,
      {voucherProvider:async()=>({vouchers:[voucher()],diagnostics:{}})}),
    sendCommandResult:async(_,command,outcome)=>outcomes.push({command,outcome}),
    sendCommandResults:async(_,rows)=>outcomes.push(...rows),
    buildBankVoucherBatchXml:()=>{imports.push('build');throw Error('must not build conflicting batch')},
    console:{log(){},warn(){},error(){}},
  };
  const execute=new Function(...Object.keys(dependencies),`return (${runBankVoucherCommandBatch.toString()});`)(...Object.values(dependencies));
  await execute({tallyUrl:'http://unused',companyName:'Solution Nyx'},[
    {id:'changed',payload:row},
    {id:'existing',payload:{...row,transactionId:'existing',amount:2383.5}},
  ]);
  assert.equal(outcomes.length,2);assert.equal(imports.length,0);
  const changed=outcomes.find(r=>r.command.id==='changed').outcome;
  assert.equal(changed.success,false);assert.equal(changed.result.duplicateCheck.verificationStatus,'ambiguous');
  const existing=outcomes.find(r=>r.command.id==='existing').outcome;
  assert.equal(existing.success,true);assert.equal(existing.result.alreadyInTally,true);assert.equal(existing.result.created,0);
});


// The exporter must model the date scope. Returning every fixture for every
// query would hide an amount filter that excludes the edited voucher in Tally.
function movedPaymentExport(content, calls = []) {
  return async (_url, options) => {
    calls.push(options);
    if (options.dateFrom === '2026-10-25' && options.dateTo === '2026-10-25') {
      return '<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>';
    }
    assert.equal(options.dateFrom, '2026-04-01');
    assert.equal(options.dateTo, '2027-03-31');
    assert.equal(options.tallyType, 'Vouchers : Ledger');
    assert.equal(options.childOf, '"ICICI Bank - 8822014500"');
    assert.equal(options.formulae, undefined, 'An amount filter would hide this same-UTR voucher');
    return content;
  };
}

test('date-and-amount edits are found in the actual wider-date export before deciding presence', async () => {
  const calls=[];
  const check=await verifyBankTransactionInTally({}, row, {
    exportCollection:movedPaymentExport(xml(voucher({date:'20261024'})), calls),
  });
  assert.equal(calls.length,2);
  assert.equal(check.result.verificationStatus,'ambiguous');
  assert.equal(check.result.matches[0].voucherNumber,'5310');
  assert.equal(check.result.matches[0].date,'2026-10-24');
  assert.equal(check.result.matches[0].amount,2383.5);
  assert.deepEqual(check.result.referenceConflicts,['amount']);
});

test('wider-date lookup retains changed amounts when the UTR is in bank details or narration', async () => {
  const original=xml(voucher({date:'20261024'}));
  for(const content of [
    original.replace('<REFERENCE>'+reference+'</REFERENCE>', '<REFERENCE></REFERENCE><NARRATION>UTR: '+reference+'</NARRATION>'),
    original.replace('<REFERENCE>'+reference+'</REFERENCE>', '<REFERENCE></REFERENCE>').replace('<AMOUNT>2383.5</AMOUNT>', '<AMOUNT>2383.5</AMOUNT><BANKALLOCATIONS.LIST><INSTRUMENTNUMBER>'+reference+'</INSTRUMENTNUMBER></BANKALLOCATIONS.LIST>'),
  ]) {
    const check=await verifyBankTransactionInTally({},row,{exportCollection:movedPaymentExport(content)});
    assert.equal(check.result.verificationStatus,'ambiguous');
    assert.equal(check.result.matches[0].amount,2383.5);
  }
});

test('wider-date conflicts do not turn unrelated references into duplicate warnings', async () => {
  const check=await reconcileBankTransactionsInTally({}, {bankLedgerName:bank,includeBalanceProof:false,
    transactions:[row,{...row,transactionId:'new-payment',referenceNumber:'UTIBN26300999999',bankReferenceNumber:'UTIBN26300999999'}]},
    {exportCollection:movedPaymentExport(xml(voucher({date:'20261024'})))});
  assert.deepEqual(check.result.transactions.map(r=>r.verificationStatus),['ambiguous','missing']);
  assert.equal(check.result.balanceProof.tallyMovement,0);
});

test('an incomplete wider-date read fails instead of authorising another payment', async () => {
  await assert.rejects(verifyBankTransactionInTally({},row,{exportCollection:movedPaymentExport('<ENVELOPE><COLLECTION>')}), /complete financial-year/);
});

test('final posting preflight stops a changed date and amount without building an import', async () => {
  let imports=0;
  const blocked=()=>{imports++;throw Error('must not import')};
  const execute=new Function('resolveBankVoucherLedgerPayloads','validateBankVoucherBillAllocationsLive',
    'verifyBankTransactionInTally','buildBankVoucherXml','invokeTallyXml',`return (${postBankVoucher.toString()});`)(
    async(_,rows)=>rows,async(_,rows)=>rows,
    (config,payload)=>verifyBankTransactionInTally(config,payload,{exportCollection:movedPaymentExport(xml(voucher({date:'20261024'})))}),
    blocked,blocked);
  const result=await execute('http://unused',row,'Solution Nyx');
  assert.equal(result.outcome.success,false);
  assert.equal(result.outcome.result.possibleDuplicateInTally,true);
  assert.equal(result.outcome.result.duplicateCheck.matches[0].voucherNumber,'5310');
  assert.equal(result.xml,null);assert.equal(imports,0);
});

test('the live match operation rechecks a moved and edited UTR even with a warm voucher cache', async (t) => {
  const baseDir=fs.mkdtempSync(path.join(os.tmpdir(),'gajkesari-moved-utr-'));
  t.after(()=>fs.rmSync(baseDir,{recursive:true,force:true}));
  let edited=false;const calls=[];
  const dependencies={localMatchingBaseDir:baseDir,companyGuid:'test-company',
    voucherProvider:refreshCachedBankVouchers,exportCollection:async(_url,options)=>{
      calls.push(options);
      if(options.tallyType!=='Vouchers : Ledger')return '<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>';
      if(!edited)return xml(voucher({amount:2382.5}));
      return options.dateFrom==='2026-04-01' ? xml(voucher({date:'20261024'})) : '<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>';
    }};
  const request={companyName:'Solution Nyx',bankLedgerName:bank,includeBalanceProof:false,
    billEligibleTransactionIds:[row.transactionId],transactions:[row]};
  assert.equal((await matchBankStatementInTally({},request,dependencies)).result.transactions[0].verificationStatus,'found');
  edited=true;const {result}=await matchBankStatementInTally({},request,dependencies);
  assert.equal(result.transactions[0].verificationStatus,'ambiguous');
  assert.equal(result.transactions[0].matches[0].date,'2026-10-24');
  assert.equal(result.transactions[0].matches[0].amount,2383.5);
  assert.deepEqual(result.billLedgerNames,[],'A conflicting payment must not open bill allocation');
  assert.equal(calls.length,2);assert.equal(calls[1].dateFrom,'2026-04-01');
  assert.equal(calls[1].dateTo,'2027-03-31');assert.equal(calls[1].formulae,undefined);
});

test('live matching removes a deleted out-of-period UTR instead of trusting the warm cache', async (t) => {
  const baseDir=fs.mkdtempSync(path.join(os.tmpdir(),'gajkesari-deleted-utr-'));
  t.after(()=>fs.rmSync(baseDir,{recursive:true,force:true}));
  let deleted=false;
  const dependencies={localMatchingBaseDir:baseDir,voucherProvider:refreshCachedBankVouchers,
    exportCollection:async()=>deleted ? '<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>' : xml(voucher({date:'20261024',amount:2382.5}))};
  const request={bankLedgerName:bank,includeBalanceProof:false,transactions:[row]};
  assert.equal((await matchBankStatementInTally({},request,dependencies)).result.transactions[0].verificationStatus,'found');
  deleted=true;
  assert.equal((await matchBankStatementInTally({},request,dependencies)).result.transactions[0].verificationStatus,'missing');
});

test('live matching refuses an incomplete fresh UTR read despite a previously complete cache', async (t) => {
  const baseDir=fs.mkdtempSync(path.join(os.tmpdir(),'gajkesari-incomplete-utr-'));
  t.after(()=>fs.rmSync(baseDir,{recursive:true,force:true}));
  let incomplete=false;
  const dependencies={localMatchingBaseDir:baseDir,voucherProvider:refreshCachedBankVouchers,
    exportCollection:async(_url,options)=>incomplete && options.dateFrom==='2026-04-01'
      ? '<ENVELOPE><COLLECTION>' : xml(voucher({amount:2382.5}))};
  const request={bankLedgerName:bank,includeBalanceProof:false,transactions:[row]};
  await matchBankStatementInTally({},request,dependencies);incomplete=true;
  await assert.rejects(matchBankStatementInTally({},request,dependencies),/complete voucher collection/);
});
