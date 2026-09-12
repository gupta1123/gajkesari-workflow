import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocumentLocal } from "./parser.mjs";

test("parses CSV to Markdown by default", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gajkesari-anydoc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, "sales.csv");
  fs.writeFileSync(input, "Invoice,Amount\nINV-1,1250\n", "utf8");
  const result = await parseDocumentLocal({ filePath: input });
  assert.equal(result.outputFormat, "markdown");
  assert.match(result.content, /Invoice/);
  assert.match(result.content, /1250/);
  assert.equal(result.metadata.processing, "local");
  assert.equal(result.metadata.ocrUsed, false);
});

test("returns structured JSON for an RTF document", async () => {
  const bytes = Buffer.from(String.raw`{\rtf1\ansi{\b Quarterly Report}\par Revenue increased.}`);
  const result = await parseDocumentLocal({ bytes, fileName: "report.rtf", output: "json" });
  assert.equal(result.outputFormat, "json");
  assert.equal(result.metadata.structured, true);
  assert.ok(Array.isArray(result.content.blocks));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("rejects unknown output formats", async () => {
  await assert.rejects(
    parseDocumentLocal({ bytes: Buffer.from("a,b\n1,2"), fileName: "test.csv", output: "xml" }),
    /markdown.*json/i
  );
});
