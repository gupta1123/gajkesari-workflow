#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { suggestLedgers } from "./suggest.mjs";
import { loadLocalDb, saveLocalDb, upsertLedgers } from "./store.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const nxt = argv[i+1];
    if (!nxt || nxt.startsWith("--")) { args[key] = true; }
    else { args[key] = nxt; i++; }
  }
  return args;
}
function readInputFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  // Try JSON array or single object
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  } catch {
    // Try JSONL
    return raw.split(/\r?\n/).filter(Boolean).map((line)=> JSON.parse(line));
  }
}
function ensureMockData({ appUserDataPath, baseDir } = {}) {
  const db = loadLocalDb({ appUserDataPath, baseDir });
  // If no companies, create mock fixture
  if (Object.keys(db.companies).length === 0) {
    const mockLedgers = [
      { name: "Aarav Steel Traders", guid: "m1", parent: "Sundry Debtors" },
      { name: "Bharat Steel Traders", guid: "m2", parent: "Sundry Debtors" },
      { name: "Aarav Steel Traders Pvt Ltd", guid: "m3", parent: "Sundry Debtors" },
      { name: "Cash", guid: "m4", parent: "Cash-in-Hand" },
      { name: "Bank Charges", guid: "m5", parent: "Indirect Expenses" },
      { name: "Suspense", guid: "m6", parent: "Suspense A/c" },
      { name: "Gajkesari Enterprises", guid: "m7", parent: "Sundry Creditors" },
    ];
    upsertLedgers({ db, companyName: "Mock Company", companyGuid: "mock-guid-123", ledgers: mockLedgers });
    saveLocalDb(db, { appUserDataPath, baseDir });
    return { createdMock: true, companyName: "Mock Company", companyGuid: "mock-guid-123" };
  }
  return { createdMock: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputFile = args["input"] || args["in"] || null;
  const outputFile = args["output"] || args["out"] || null;
  const singleNarration = args["narration"] || args["query"] || args["ledger"] || null;
  const topK = args["top-k"] || args["topK"] || null;
  const noAi = !!args["no-ai"] || !!args["noAi"] || args["ai"] === "false";
  const useMock = !!args["mock"] || !!args["mocked"] || !!args["fixture"];
  const companyId = args["companyId"] || args["company"] || null;

  const baseDir = args["baseDir"] || process.env.LOCAL_MATCHING_BASE_DIR || null;
  const appUserDataPath = args["userData"] || null;

  if (useMock) {
    ensureMockData({ appUserDataPath, baseDir });
  }

  let inputs = [];
  if (singleNarration) {
    inputs = [{ narration: singleNarration, companyId, topK }];
  } else if (inputFile) {
    if (!fs.existsSync(inputFile)) {
      console.error(`Input file not found: ${inputFile}`);
      process.exit(1);
    }
    inputs = readInputFile(inputFile);
    // Normalize: allow simple string array
    inputs = inputs.map((item)=>{
      if (typeof item === "string") return { narration: item, companyId, topK };
      return { companyId, topK, ...item };
    });
  } else {
    console.error(`Usage:
  npm run local-matching:suggest -- --narration "UPI Aarav Steel" --top-k 10 --no-ai
  npm run local-matching:suggest -- --input file.json --output out.json --top-k 10
  npm run local-matching:suggest -- --mock --narration "Test"  # mocked fixture without Tally

Input schema (single or array, or JSONL):
  { narration, amount, date, direction, accountId, companyId, topK } or { ledger: "string"} or "plain string"
Output schema:
  { query, companyId, suggestions: [{ ledgerId, ledgerName, parentGroup, rank, localScore, vectorScore, aiScore, confidence, source, reasons, needsReview }] }

No secrets are read from input; OPENROUTER_API_KEY is read from env only at runtime and never written to output.`);
    process.exit(1);
  }

  const totalStart = performance.now();
  const results = [];
  for (let idx = 0; idx < inputs.length; idx++) {
    const inp = inputs[idx];
    const q = inp.narration || inp.query || inp.ledger || inp.ledgerName || "";
    const t0 = performance.now();
    const res = await suggestLedgers({
      narration: q,
      query: q,
      amount: inp.amount,
      date: inp.date,
      direction: inp.direction,
      accountId: inp.accountId,
      companyId: inp.companyId || companyId,
      companyName: inp.companyName,
      companyGuid: inp.companyGuid,
      topK: inp.topK || topK,
      useAI: noAi ? false : (inp.useAI ?? undefined),
      appUserDataPath,
      baseDir,
    });
    const t1 = performance.now();
    results.push({ input: inp, output: res, latencyMs: Number((t1-t0).toFixed(3)), index: idx });
    // Log per-row latency
    console.log(`[${idx+1}/${inputs.length}] query="${q.slice(0,60)}" -> ${res.suggestions.length} suggestions ${ (t1-t0).toFixed(1)}ms ${res.isEmpty?"(empty)":""}`);
  }
  const totalMs = performance.now() - totalStart;
  const throughput = inputs.length / (totalMs/1000);

  const summary = {
    meta: {
      totalInputs: inputs.length,
      totalMs: Number(totalMs.toFixed(2)),
      throughputPerSec: Number(throughput.toFixed(2)),
      topK: topK || "default(10)",
      aiDisabled: noAi,
      mockMode: useMock,
      generatedAt: new Date().toISOString(),
      // Never include secrets
    },
    results,
  };

  if (outputFile) {
    fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(summary, null, 2), "utf8");
    console.log(`\nWrote ${results.length} results to ${outputFile} (total ${totalMs.toFixed(1)}ms, ${throughput.toFixed(2)} rows/s)`);
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }

  // Example schema file if requested
  if (args["example"]) {
    const exampleIn = { narration: "UPI DR Aarav Steel Traders 5000", amount: 5000, date: "2026-09-12", direction: "debit", companyId: "mock-guid-123", topK: 10 };
    const exampleOut = { query: "UPI DR Aarav Steel Traders 5000", companyId: "mock-guid-123", suggestions: [{ ledgerId: "ledger:aarav steel traders", ledgerName: "Aarav Steel Traders", parentGroup: "Sundry Debtors", rank:1, localScore:0.92, vectorScore:0.8, aiScore:null, confidence:0.92, source:"deterministic", reasons:["exact normalized match"], needsReview:false }] };
    fs.writeFileSync("local-matching-example-input.json", JSON.stringify(exampleIn, null,2));
    fs.writeFileSync("local-matching-example-output.json", JSON.stringify(exampleOut, null,2));
    console.log("Wrote example input/output");
  }
}

main().catch((e)=>{
  console.error(`CLI failed: ${e.message || String(e)}`);
  if(process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
