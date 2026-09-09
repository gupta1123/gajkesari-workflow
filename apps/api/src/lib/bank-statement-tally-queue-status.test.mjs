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
    terminalCount: 2,
  });
});
