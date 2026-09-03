import assert from "node:assert/strict";
import { test } from "node:test";
import { createPdfPreviewRequestGate, pdfPreviewNotice } from "./pdf-preview-state.ts";

const base = { checking: false, required: false, verified: false, error: null };
test("checking an ordinary PDF never displays a password prompt", () => {
  assert.equal(pdfPreviewNotice({ ...base, checking: true }), "checking");
});
test("network and preview errors are ordinary errors, not password prompts", () => {
  assert.equal(pdfPreviewNotice({ ...base, error: "Network unavailable" }), "error");
});
test("only a confirmed password requirement shows the password form", () => {
  assert.equal(pdfPreviewNotice(base), "none");
  assert.equal(pdfPreviewNotice({ ...base, required: true }), "password");
  assert.equal(pdfPreviewNotice({ ...base, required: true, error: "Incorrect password" }), "password");
  assert.equal(pdfPreviewNotice({ ...base, required: true, verified: true }), "unlocked");
});
test("retrying a protected PDF shows neutral checking progress", () => {
  assert.equal(pdfPreviewNotice({ ...base, required: true, checking: true }), "checking");
});
test("a new request invalidates late responses from the previous one", () => {
  const gate = createPdfPreviewRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
});
test("clearing or switching files invalidates an in-flight check", () => {
  const gate = createPdfPreviewRequestGate();
  const first = gate.begin();
  gate.cancel();
  assert.equal(first.isCurrent(), false);
  assert.equal(first.signal.aborted, true);
  const second = gate.begin();
  assert.equal(second.isCurrent(), true);
});
