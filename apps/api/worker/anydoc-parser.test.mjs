import assert from "node:assert/strict";
import test from "node:test";

import { formatAsMarkdownTable, parseWithAnydoc } from "../src/lib/processing/anydoc-parser.ts";

test("formatAsMarkdownTable parses delimited text rows into valid Markdown tables", () => {
  const sampleText = `Date\tNarration\tDebit\tCredit\tBalance
01 Sep 2025\tRTGS FROM ABC METALS\t0\t50000\t150000
02 Sep 2025\tUPI TO SUPPLIER\t10000\t0\t140000`;

  const { markdown, tableCount } = formatAsMarkdownTable(sampleText);
  assert.equal(tableCount, 1);
  assert.ok(markdown.includes("| Date | Narration | Debit | Credit | Balance |"));
  assert.ok(markdown.includes("|---"));
  assert.ok(markdown.includes("| 01 Sep 2025 | RTGS FROM ABC METALS | 0 | 50000 | 150000 |"));
});

test("parseWithAnydoc returns structured Markdown parsing result for text buffers", async () => {
  const csvBuffer = Buffer.from(
    "Date,Narration,Debit,Credit,Balance\n01/09/2025,SALARY DEPOSIT,0,100000,100000"
  );
  const result = await parseWithAnydoc(csvBuffer, "statement.csv");

  assert.equal(result.success, true);
  assert.equal(result.format, "csv");
  assert.equal(result.hasMarkdownTables, true);
  assert.ok(result.markdownText.includes("| Date | Narration | Debit | Credit | Balance |"));
  assert.ok(result.executionTimeMs >= 0);
});
