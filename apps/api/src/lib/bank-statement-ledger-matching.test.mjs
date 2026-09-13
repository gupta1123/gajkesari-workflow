import assert from "node:assert/strict";
import test from "node:test";

import {
  bankNarrationMatchingQueries,
  shortlistBankLedgersForTransaction,
  suggestBankLedgersForTransactions,
} from "./bank-statement-ledger-matching.ts";

function ledger(name, parent = "Sundry Creditors") {
  return { tally_name: name, parent_name: parent };
}

test("PNB slash narration retrieves ledgers without a parsed counterparty", () => {
  const description = "NRTGS/PUNBR52026090511997279/5282432411/SHRI MAA S";
  const queries = bankNarrationMatchingQueries(description);
  assert.ok(queries.includes("shree maa"));

  const matches = shortlistBankLedgersForTransaction(
    [ledger("Shree Maa Steels Private Limited"), ledger("Unrelated Traders")],
    { description },
    null
  );
  assert.equal(matches[0]?.tally_name, "Shree Maa Steels Private Limited");
});

test("raw narration remains usable when deterministic counterparty parsing returns null", () => {
  const matches = shortlistBankLedgersForTransaction(
    [ledger("Chaman Metals"), ledger("Cash Discount")],
    { description: "NRTGS/PUNBR52026090511997093/5282432017/CHAMAN MET" },
    null
  );
  assert.equal(matches[0]?.tally_name, "Chaman Metals");
});

test("routing references are excluded from narration retrieval queries", () => {
  const queries = bankNarrationMatchingQueries("NRTGS/PUNBR52026090511997279/5282432411/SHRI MAA STEELS");
  assert.ok(queries.every((query) => !/520260905|5282432411/i.test(query)));
});

test("complete connector vector shortlists do not read the cloud master catalogue", async () => {
  let cloudReads = 0;
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const suggestions = await suggestBankLedgersForTransactions({
      supabase: {
        from() {
          cloudReads += 1;
          throw new Error("cloud catalogue must not be read");
        },
      },
      ownerUserId: "user-1",
      connectionId: "connection-1",
      companyName: "Example Company",
      vectorCandidates: [[{
        ledgerName: "Shree Maa Steels Private Limited",
        tallyGuid: "ledger-guid-1",
        parentGroup: "Sundry Debtors",
        vectorScore: 0.91,
        rank: 1,
      }]],
      transactions: [{
        accountId: "account-1",
        transaction: {
          description: "RTGS SHREE MAA STEELS",
          category: "customer_receipt",
          counterpartyName: "Shree Maa Steels",
        },
      }],
    });
    assert.equal(cloudReads, 0);
    assert.equal(suggestions.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});
