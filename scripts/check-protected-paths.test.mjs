import assert from "node:assert/strict";
import test from "node:test";

import { classify } from "./check-protected-paths.mjs";

const none = () => "";

test("bank statement, bridge, gateway and command code are protected", () => {
  const files = [
    "apps/api/src/app/api/bank-statements/tally/queue/route.ts",
    "apps/api/src/lib/bank-statements.ts",
    "apps/api/worker/process-packet-jobs.mjs",
    "apps/gajkesari-web/src/components/bank-statements/BankStatementsPage.tsx",
    "apps/tally-bridge/src/bridge.mjs",
    "apps/cash-discount-gateway/src/server.mjs",
    "apps/gajkesari-web/src/lib/cash-discount-live.ts",
    "apps/api/src/app/api/tally/bridge/commands/next/route.ts",
    "apps/api/src/lib/tally/commands.ts",
    "apps/api/src/lib/api/request-auth.ts",
  ];
  const violations = classify(files.map((file) => ({ status: "M", file })), none);
  assert.deepEqual(violations.map((v) => v.file), files);
});

test("new follow-up code is allowed", () => {
  const files = [
    "apps/api/src/app/api/collections/follow-ups/pipelines/route.ts",
    "apps/api/src/lib/followups/messages.ts",
    "apps/gajkesari-web/src/components/collections/FollowUpPipelines.tsx",
    "apps/gajkesari-web/src/lib/followups-live.ts",
  ];
  assert.deepEqual(classify(files.map((file) => ({ status: "A", file })), none), []);
});

test("existing migrations are immutable", () => {
  const file = "supabase/migrations/20260910143000_bank_import_idempotency_and_queue_completion.sql";
  assert.equal(classify([{ status: "M", file }], none).length, 1);
  assert.equal(classify([{ status: "D", file }], none).length, 1);
});

test("a new migration may not rewrite shared command or bank objects", () => {
  const file = "supabase/migrations/20261101000000_followups.sql";
  const rewrite = "alter table public.tally_bridge_commands drop constraint tally_bridge_commands_command_type_check;";
  assert.equal(classify([{ status: "A", file }], () => rewrite).length, 1);
  const bank = "create table x (source uuid references public.bank_transactions(id));";
  assert.equal(classify([{ status: "A", file }], () => bank).length, 1);
  assert.deepEqual(classify([{ status: "A", file }], () => "create table public.followups (id uuid);"), []);
});

test("a reviewed exception can be allow-listed", () => {
  const file = "apps/api/src/lib/tally/commands.ts";
  assert.deepEqual(classify([{ status: "M", file }], none, new Set([file])), []);
});
