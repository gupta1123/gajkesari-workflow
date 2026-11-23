import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as crypto from "node:crypto";

function fixture() {
  const device = {
    id: "pc",
    installation_ref: "install",
    session_generation: 1,
    owner_user_id: "owner",
  };
  const dataset = {
    id: "data",
    company_guid: "guid",
    financial_year: "2026-27",
    installation_id: "install",
    owner_user_id: "owner",
  };
  const job = {
    id: "job",
    operator_id: "operator",
    connection_id: "pc",
    installation_id: "install",
    generation: 1,
    company_dataset_id: "data",
    company_guid: "guid",
    financial_year: "2026-27",
    status: "queued",
    operation: "followups",
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const state = { granted: true, job, dataset };
  const client = {
    from(table) {
      const rows = table === "tally_company_datasets" ? [dataset] : [job];
      const filters = [];
      let patch,
        mustExist = false;
      const q = {
        select() {
          return q;
        },
        limit() {
          return q;
        },
        order() {
          return q;
        },
        maybeSingle() {
          return q;
        },
        single() {
          mustExist = true;
          return q;
        },
        eq(k, v) {
          filters.push((r) => r[k] === v);
          return q;
        },
        in(k, values) {
          filters.push((r) => values.includes(r[k]));
          return q;
        },
        gt(k, v) {
          filters.push((r) => r[k] > v);
          return q;
        },
        update(values) {
          patch = values;
          return q;
        },
        then(resolve) {
          const row = rows.find((r) => filters.every((f) => f(r)));
          if (row && patch) Object.assign(row, patch);
          resolve({
            data: row ? { ...row } : null,
            error: mustExist && !row ? Error("Missing") : null,
          });
        },
      };
      return q;
    },
  };
  const mocks = {
    "node:crypto": crypto,
    "@/lib/connector-operators": {
      db: () => client,
      device: async (req) =>
        req.headers.get("authorization") === "Bearer paired" ? device : null,
      granted: async () => state.granted,
      jobContext: async () => ({}),
    },
  };
  const filename = fileURLToPath(new URL("./route.ts", import.meta.url));
  const mod = new Module(filename);
  mod.require = (id) => mocks[id];
  mod._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    filename,
  );
  const call = (body, token = "paired") =>
    mod.exports.POST(
      new Request("http://local/api", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        body: JSON.stringify({ generation: 1, connectionId: "pc", ...body }),
      }),
    );
  return { state, call };
}
test("only one simultaneous poll can claim a scoped request", async () => {
  const { call } = fixture();
  const results = await Promise.all([
    call({ action: "poll" }),
    call({ action: "poll" }),
  ]);
  const jobs = (await Promise.all(results.map((r) => r.json()))).filter(
    (r) => r.job,
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.dataset.id, "data");
});
test("connector authentication, generations, installation, expiry, and grants are checked", async () => {
  const { state, call } = fixture();
  assert.equal((await call({ action: "poll" }, "wrong")).status, 401);
  assert.equal((await call({ action: "poll", generation: 2 })).status, 401);
  for (const [key, value] of [
    ["generation", 2],
    ["installation_id", "other"],
    ["expires_at", "2000-01-01"],
  ]) {
    const original = state.job[key];
    state.job[key] = value;
    assert.deepEqual(await (await call({ action: "poll" })).json(), {
      job: null,
    });
    state.job[key] = original;
  }
  const { job } = await (await call({ action: "poll" })).json();
  assert.equal(
    (await call({ action: "finish", id: job.id, claim: "old" })).status,
    409,
  );
  state.granted = false;
  assert.equal(
    (await call({ action: "finish", id: job.id, claim: job.claim })).status,
    409,
  );
});
test("changed fiscal year fails before delivering a job", async () => {
  const { state, call } = fixture();
  state.dataset.financial_year = "2027-28";
  assert.equal((await call({ action: "poll" })).status, 503);
  assert.equal(state.job.status, "failed");
});
