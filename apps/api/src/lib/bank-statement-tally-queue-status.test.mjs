import assert from "node:assert/strict";
import test from "node:test";
import { summarizeBankStatementQueueCommands } from "./bank-statement-tally-queue-status.ts";

test("queue summary distinguishes prepared work from completed Tally actions", () => {
  assert.deepEqual(summarizeBankStatementQueueCommands([
    { status: "succeeded" },
    { status: "failed" },
    { status: "claimed" },
    { status: "queued" },
  ]), {
    commandCount: 4,
    queuedCount: 1,
    runningCount: 1,
    succeededCount: 1,
    failedCount: 1,
    needsCheckCount: 0,
    acceptedCount: 0,
    terminalCount: 2,
  });
});

test("accepted but unconfirmed posts do not fail the batch summary", () => {
  const summary = summarizeBankStatementQueueCommands([
    ...Array.from({ length: 17 }, () => ({ command_type: "post_bank_voucher", status: "succeeded", result: { verificationStatus: "verified" } })),
    { command_type: "post_bank_voucher", status: "failed", reconciliation_required: true,
      result: { importSummary: { created: 18, errors: 0 }, batchSize: 18 } },
  ]);
  assert.equal(summary.failedCount, 0);
  assert.equal(summary.needsCheckCount, 1);
  assert.equal(summary.succeededCount, 17);
  assert.equal(summary.acceptedCount, 18);
  assert.equal(summary.terminalCount, 18);
});
