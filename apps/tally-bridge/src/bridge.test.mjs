import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollectionExportXml,
  buildPurchaseVoucherXml,
  buildRequestedLedgerFormula,
  classifyOpenBillReferenceKind,
  classifyTaxLedgers,
  findBankLedgersFromMasters,
  fetchCustomerOpenBillsFromTally,
  openBillBlockRequiresVoucherFallback,
  parseTallyImportResult,
  purchaseVoucherReadbackComparison,
  strictBankTransactionCandidates,
} from "./bridge.mjs";

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

test("zero targeted bills avoids the voucher export", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames: ["Customer A"], queryPurpose: "bank_statement_match" }, { exportCollection: async (_url, options) => { calls.push(options); return "<ENVELOPE><STATUS>1</STATUS></ENVELOPE>"; } });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.result.openBills, []);
  assert.equal(result.result.queryDiagnostics.voucherFallbackUsed, false);
});

test("complete Bill data avoids the voucher fallback", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames: ["Customer A"] }, { exportCollection: async (_url, options) => { calls.push(options); return '<ENVELOPE><STATUS>1</STATUS><BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><BILLTYPE>New Ref</BILLTYPE><OPENINGBALANCE>500</OPENINGBALANCE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL></ENVELOPE>'; } });
  assert.equal(calls.length, 1);
  assert.equal(result.result.openBills[0].pendingAmount, 500);
});

test("incomplete Bill data performs a targeted voucher fallback", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames: ["Customer A"], queryPurpose: "bank_statement_match" }, { exportCollection: async (_url, options) => { calls.push(options); return options.tallyType === "Bill" ? '<ENVELOPE><BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><OPENINGBALANCE>500</OPENINGBALANCE></BILL></ENVELOPE>' : '<ENVELOPE><STATUS>1</STATUS></ENVELOPE>'; } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.tallyType), ["Bill", "Voucher"]);
  assert.equal(result.result.queryDiagnostics.voucherFallbackUsed, true);
});

test("large ledger sets use one full Bill collection", async () => {
  const calls = [];
  const ledgerNames = Array.from({ length: 51 }, (_, index) => `Customer ${index + 1}`);
  const result = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames, queryPurpose: "bank_statement_match" }, { exportCollection: async (_url, options) => { calls.push(options); return "<ENVELOPE><STATUS>1</STATUS></ENVELOPE>"; } });
  assert.equal(calls.length, 1);
  assert.equal(result.result.queryDiagnostics.billQueryMode, "full");
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

test("strict bank presence uses exact reference independently of a wrong selected party", () => {
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
});

test("strict bank presence requires the exact party when no usable reference exists", () => {
  const result = strictBankTransactionCandidates(
    [bankVoucher({ party: "Actual Customer" })],
    {
      voucherDate: "2026-08-01",
      amount: 1250,
      expectedDirection: "incoming",
      counterpartyLedgerName: "Wrong Customer",
    },
    "ICICI Current Account",
    new Set()
  );
  assert.equal(result.baseCandidateCount, 1);
  assert.equal(result.candidates.length, 0);
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
