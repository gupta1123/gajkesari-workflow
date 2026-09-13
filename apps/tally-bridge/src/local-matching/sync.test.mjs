import assert from "node:assert/strict";
import test from "node:test";
import { syncLedgersReadOnly, isReadOnlySyncOptions } from "./sync.mjs";

test("sync is read-only: only Export Collection, never Import", async () => {
  const captured = [];
  const fakeExport = async (tallyUrl, opts) => {
    captured.push({ tallyUrl, opts });
    // Return minimal valid ledger XML
    return `<ENVELOPE><LEDGER NAME="Test Ledger"><PARENT>Sundry Debtors</PARENT><GUID>g1</GUID><ALTERID>100</ALTERID><MASTERID>1</MASTERID></LEDGER></ENVELOPE>`;
  };
  const helpers = {
    extractBlocks: (xml, tag) => {
      const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
      const blocks = []; let m; while((m=re.exec(xml))) blocks.push(m[0]); return blocks;
    },
    getTagText: (block, tag) => {
      const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].trim() : null;
    },
    getAttribute: (block, attr) => {
      const m = block.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i"));
      return m ? m[1].trim() : null;
    },
  };
  const result = await syncLedgersReadOnly({
    tallyUrl: "http://localhost:9000",
    companyName: "TestCo",
    exportTallyCollection: fakeExport,
    helpers,
  });
  assert.equal(captured.length, 2);
  assert.equal(captured[0].opts.tallyType, "Ledger");
  assert.equal(captured[1].opts.tallyType, "Group");
  assert.match(captured[0].opts.fetchFields, /Name.*Parent.*GUID/i);
  assert.ok(captured.every((item) => !String(item.opts.collectionName).toLowerCase().includes("import")));
  assert.equal(result.isReadOnly, true);
  assert.equal(result.ledgers.length, 1);
  assert.equal(result.ledgers[0].name, "Test Ledger");
  // Ensure no Import envelope was built
  assert.ok(captured.every((item) => isReadOnlySyncOptions(item.opts)));
});

test("delta sync applies AlterID filters to both local master collections", async () => {
  const calls = [];
  const helpers = { extractBlocks: () => [], getTagText: () => null, getAttribute: () => null };
  const result = await syncLedgersReadOnly({
    tallyUrl: "http://localhost:9000",
    companyName: "Co",
    mode: "delta",
    cursor: { lastLedgerAlterID: "100", lastGroupAlterID: "50" },
    exportTallyCollection: async (_url, options) => { calls.push(options); return "<ENVELOPE></ENVELOPE>"; },
    helpers,
  });
  assert.equal(result.mode, "delta");
  assert.match(calls[0].formulae[0].formula, /AlterID > 100/);
  assert.match(calls[1].formulae[0].formula, /AlterID > 50/);
});

test("sync persists cursor AlterID and rejects Import", async () => {
  const fakeExport = async () => `<ENVELOPE><LEDGER NAME="A"><PARENT>P</PARENT><GUID>g1</GUID><ALTERID>200</ALTERID><MASTERID>5</MASTERID></LEDGER><LEDGER NAME="B"><PARENT>P</PARENT><GUID>g2</GUID><ALTERID>210</ALTERID><MASTERID>6</MASTERID></LEDGER></ENVELOPE>`;
  const helpers = {
    extractBlocks: (xml, tag) => {
      const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
      const blocks = []; let m; while((m=re.exec(xml))) blocks.push(m[0]); return blocks;
    },
    getTagText: (block, tag) => {
      const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].trim() : null;
    },
    getAttribute: (block, attr) => {
      const m = block.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i"));
      return m ? m[1].trim() : null;
    },
  };
  const result = await syncLedgersReadOnly({
    tallyUrl: "http://localhost:9000",
    companyName: "Co",
    exportTallyCollection: fakeExport,
    helpers,
  });
  assert.equal(result.cursor.lastAlterID, "210");
  assert.equal(result.ledgers.length, 2);
});

test("sync throws if tally not reachable (no silent fallback)", async () => {
  const fakeExport = async () => { throw new Error("ECONNREFUSED"); };
  const helpers = {
    extractBlocks: () => [], getTagText: () => null, getAttribute: () => null,
  };
  await assert.rejects(() => syncLedgersReadOnly({
    tallyUrl: "http://localhost:9000",
    companyName: "Co",
    exportTallyCollection: fakeExport,
    helpers,
  }), /ECONNREFUSED/);
});

test("isReadOnlySyncOptions rejects Import", () => {
  assert.equal(isReadOnlySyncOptions({ tallyType: "Ledger", collectionName: "Gajkesari Local Matching Ledgers Sync" }), true);
  assert.equal(isReadOnlySyncOptions({ tallyType: "Voucher", collectionName: "Import Data" }), false);
});
