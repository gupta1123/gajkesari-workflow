import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollectionExportXml,
  buildBankVoucherBatchXml,
  buildBankVoucherXml,
  buildPurchaseVoucherXml,
  buildRequestedLedgerFormula,
  classifyOpenBillReferenceKind,
  classifyTaxLedgers,
  findBankLedgersFromMasters,
  fetchCustomerOpenBillsFromTally,
  getBankVoucherCommandBatchKey,
  matchBankStatementInTally,
  openBillBlockRequiresVoucherFallback,
  parseBankStatementMasterCollection,
  parseLedgerClosingBalance,
  parseTallyImportResult,
  purchaseVoucherReadbackComparison,
  reconcileBankTransactionsInTally,
  strictBankTransactionCandidates,
} from "./bridge.mjs";

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

test("direct party posting creates an Advance without settling an existing bill", () => {
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

test("zero targeted bills avoids the voucher export", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally({ tallyUrl: "http://127.0.0.1:9000" }, { ledgerNames: ["Customer A"], queryPurpose: "bank_statement_match" }, { exportCollection: async (_url, options) => { calls.push(options); return "<ENVELOPE><STATUS>1</STATUS></ENVELOPE>"; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tallyType, "Bill");
  assert.equal(calls[0].filterNames, undefined);
  assert.deepEqual(result.result.openBills, []);
  assert.equal(result.result.queryDiagnostics.billQueryMode, "full");
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

test("statement reconciliation uses one complete export when top-level references match", async () => {
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

  assert.equal(calls.length, 1);
  assert.match(calls[0].fetchFields, /BankAllocations/);
  assert.equal(outcome.result.transactions[0].verificationStatus, "found");
  assert.equal(outcome.result.queryDiagnostics.detailBatchCount, 0);
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

  assert.equal(calls.length, 1);
  assert.match(calls[0].fetchFields, /BankAllocations/);
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
        if (options.tallyType === "Voucher") {
          return '<ENVELOPE><VOUCHER><DATE>20260801</DATE><EFFECTIVEDATE>20260801</EFFECTIVEDATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER><REFERENCE>UTR-FOUND-1</REFERENCE><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME><MASTERID>101</MASTERID><ALLLEDGERENTRIES.LIST><LEDGERNAME>ICICI Current Account</LEDGERNAME><AMOUNT>-1250</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME><AMOUNT>1250</AMOUNT><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER></ENVELOPE>';
        }
        return '<ENVELOPE><BILL NAME="INV-B-1"><LEDGERNAME>Customer B</LEDGERNAME><BILLTYPE>New Ref</BILLTYPE><DATE>20260720</DATE><OPENINGBALANCE>500</OPENINGBALANCE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL></ENVELOPE>';
      },
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(outcome.result.transactions[0].verificationStatus, "found");
  assert.equal(outcome.result.transactions[1].verificationStatus, "missing");
  assert.deepEqual(outcome.result.billLedgerNames, ["Customer B"]);
  assert.equal(outcome.result.openBillsByLedger["Customer B"].openBills.length, 1);
  assert.equal(outcome.result.openBillsByLedger["Customer A"], undefined);
  assert.equal(outcome.result.matchDiagnostics.openBillCheck.requestedLedgerCount, 1);
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
