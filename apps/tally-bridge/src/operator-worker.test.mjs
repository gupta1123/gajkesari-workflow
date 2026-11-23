import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLiveCashDiscountDashboard,
  resolveScopedLedgers,
} from "./operator-analysis.generated.mjs";
import { summarizeDashboard } from "./operator-worker.mjs";

test("remote totals match the dashboard for aged unpaid sales and zero eligible discounts", () => {
  const ledgers = resolveScopedLedgers(
    {
      groups: [],
      ledgers: [
        { name: "Acme", parent: "Debtors" },
        { name: "Bank", parent: "Banks" },
      ],
    },
    {
      selectedGroupNames: ["Debtors"],
      includeNestedGroups: true,
      excludedGroupNames: [],
      excludedLedgerNames: [],
    },
  );
  assert.deepEqual(
    ledgers.map((r) => r.name),
    ["Acme"],
  );
  const byLedger = {
    Acme: {
      complete: true,
      openBills: [
        {
          kind: "receivable",
          sourceVoucherType: "Sales",
          referenceName: "A",
          invoiceDate: "2020-04-10",
          dueDate: "2020-05-10",
          originalAmount: 500,
          pendingAmount: 500,
        },
      ],
    },
  };
  const dashboard = buildLiveCashDiscountDashboard({
    connectionId: "pc",
    companyName: "Company",
    financialYear: "2020-21",
    proposalRows: [],
    scan: { ledgers, openBillsResult: { byLedger } },
    followUps: false,
  });
  const job = {
    operation: "followups",
    dataset: { company_name: "Company", financial_year: "2020-21" },
    parameters: {},
  };
  const follow = summarizeDashboard(dashboard, job, ledgers, byLedger);
  assert.equal(follow.confirmedOutstanding, 500);
  assert.equal(
    follow.confirmedOutstanding,
    dashboard.kpis.paymentFollowUpAmount,
  );
  assert.equal(follow.overdue31plus, 1);
  const discount = summarizeDashboard(
    dashboard,
    { ...job, operation: "discount" },
    ledgers,
    byLedger,
  );
  assert.equal(discount.recoveryCandidates, 0);
  assert.equal(discount.analyzedInvoices, 1);
  assert.ok(discount.evidence[0].reason);
  const other = summarizeDashboard(
    dashboard,
    { ...job, parameters: { customer: "Another customer" } },
    ledgers,
    byLedger,
  );
  assert.equal(other.confirmedOutstanding, 0);
});
