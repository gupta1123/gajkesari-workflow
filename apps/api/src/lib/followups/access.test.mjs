import assert from "node:assert/strict";
import test from "node:test";
import { followupsEnabledFor } from "./access.ts";

test("follow-ups are closed unless the flag and the allowlist both agree", () => {
  assert.equal(followupsEnabledFor("u1", {}), false);
  assert.equal(followupsEnabledFor("u1", { FOLLOWUPS_ENABLED: "true" }), false);
  assert.equal(followupsEnabledFor("u1", { FOLLOWUPS_ALLOWED_OWNERS: "u1" }), false);
  assert.equal(followupsEnabledFor("u1", { FOLLOWUPS_ENABLED: "true", FOLLOWUPS_ALLOWED_OWNERS: "u2, u1" }), true);
  assert.equal(followupsEnabledFor("u3", { FOLLOWUPS_ENABLED: "true", FOLLOWUPS_ALLOWED_OWNERS: "u2,u1" }), false);
  assert.equal(followupsEnabledFor("u3", { FOLLOWUPS_ENABLED: "TRUE", FOLLOWUPS_ALLOWED_OWNERS: "*" }), true);
  assert.equal(followupsEnabledFor("u1", { FOLLOWUPS_ENABLED: "false", FOLLOWUPS_ALLOWED_OWNERS: "*" }), false);
});
