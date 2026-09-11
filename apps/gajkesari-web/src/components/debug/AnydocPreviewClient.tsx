"use client";

import { useState, useCallback } from "react";

function normalizePnbTable(headers: string[], rows: string[][]): { headers: string[]; rows: string[][] } {
  // PNB Anydoc bug: header "Cheque No. Dr Amount" is fused and has 2 empty cols
  const hasFused = headers.some((h) => h.toLowerCase().includes("cheque") && h.toLowerCase().includes("dr amount"));
  if (!hasFused) return { headers, rows };
  // headers currently filtered (no outer empties): ["Txn No.","Txn Date","Description","Branch Name","Cheque No. Dr Amount","Cr Amount","Balance","KIMS Remarks"] (8)
  // rows are same 8: ["S...","05-09-2026","NRTGS...","-","4,00,000.00","","12,77,22,917...",""]
  // split fused header into two and split corresponding row cell
  const idx = headers.findIndex((h) => h.toLowerCase().includes("cheque") && h.toLowerCase().includes("dr amount"));
  if (idx === -1) return { headers, rows };
  const newHeaders = [...headers.slice(0, idx), "Cheque No.", "Dr Amount", ...headers.slice(idx + 1)];
  const newRows = rows.map((r) => {
    const cell = r[idx] || "";
    // cell is Dr Amount (e.g. "4,00,000.00") or empty; Cheque is empty for PNB
    const isAmount = /[\d,]+\.\d{2}/.test(cell) && cell !== "-";
    const cheque = "";
    const dr = isAmount ? cell : "";
    return [...r.slice(0, idx), cheque, dr, ...r.slice(idx + 1)];
  });
  return { headers: newHeaders, rows: newRows };
}

function parseAllTables(md: string): { headers: string[]; rows: string[][]; startLine: number }[] {
  const lines = md.split("\n");
  const tables: { headers: string[]; rows: string[][]; startLine: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1] || "";
    const isHeader = line.includes("|") && line.split("|").filter(Boolean).length >= 2;
    const isSep = /\|\s*:?-{2,}:?\s*\|/.test(next) || /^\s*\|?(\s*:?-+:?\s*\|)+\s*$/.test(next);
    if (isHeader && isSep) {
      // keep empty cols for alignment, then normalize
      const rawHeaders = line.split("|").slice(1, -1).map((c) => c.trim());
      const rawRows: string[][] = [];
      const startLine = i;
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        const row = lines[i].split("|").slice(1, -1).map((c) => c.trim());
        if (row.every((c) => /^:?-+:?$/.test(c))) { i++; continue; }
        rawRows.push(row);
        i++;
      }
      if (rawHeaders.length >= 2 && rawRows.length > 0) {
        // remove columns where header is empty (PNB has 2 empties between Txn Date and Description, and one between Cr Amount and Balance)
        const keepIdx = rawHeaders.map((h, idx) => ({ h, idx })).filter((x) => x.h !== "").map((x) => x.idx);
        let headers = keepIdx.map((idx) => rawHeaders[idx]);
        let rows = rawRows.map((r) => keepIdx.map((idx) => r[idx] ?? ""));
        // fix fused header
        const normalized = normalizePnbTable(headers, rows);
        headers = normalized.headers;
        rows = normalized.rows;
        tables.push({ headers, rows, startLine });
      }
    } else {
      i++;
    }
  }
  return tables;
}

function isTransactionTable(t: { headers: string[] }): boolean {
  const h = t.headers.map((x) => x.toLowerCase());
  const hasDate = h.some((x) => x.includes("date"));
  const hasDesc = h.some((x) => x.includes("description") || x.includes("narration") || x.includes("particular") || x.includes("details") || x.includes("remarks"));
  const hasAmount = h.some((x) => x.includes("debit") || x.includes("credit") || x.includes("amount") || x.includes("balance") || x === "dr" || x === "cr");
  return hasDate && hasDesc && hasAmount;
}

function extractBrokenTransactions(md: string): string[][] {
  const afterPage1 = md.split(/Page No\s*1/i)[1] || "";
  if (!afterPage1) return [];
  const re = /(?:NRTGS|NEFT|RTGS|IMPS)[\s\S]*?\d{1,2}[-/]\d{1,2}[-/]\d{2,4}[\s\S]*?Dr\./g;
  const matches = [...afterPage1.matchAll(re)];
  return matches.map((m) => {
    const txt = m[0].replace(/\s+/g, " ").trim();
    const date = (txt.match(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/) || [""])[0];
    const amounts = [...txt.matchAll(/\d{1,3}(?:,\d{2,3})+\.\d{2}/g)].map((x) => x[0]);
    const txn = (txt.match(/\b[US]\d{5,}\b/) || [""])[0];
    const bal = amounts.length >= 2 ? amounts[amounts.length - 1] : "";
    const amt = amounts.length >= 1 ? amounts[0] : "";
    const desc = txt.slice(0, 140);
    // 9 cols after normalize: Txn No | Txn Date | Description | Branch Name | Cheque No. | Dr Amount | Cr Amount | Balance | KIMS Remarks
    return [txn, date, desc, "-", "", amt, "", bal, ""];
  });
}

export function AnydocPreviewClient() {
  const [fileName, setFileName] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [result, setResult] = useState<{ success: boolean; markdownText: string; hasMarkdownTables: boolean; tableCount: number; executionTimeMs: number; format: string; error?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"table" | "json">("table");

  const markdown = result?.markdownText || "";
  const allTables = markdown ? parseAllTables(markdown) : [];
  const rawTxTables = allTables.filter(isTransactionTable);
  const brokenTxRows = markdown ? extractBrokenTransactions(markdown) : [];
  // merge all transaction tables (HDFC has 5 pages) + broken rows (PNB page 2) into one table for preview
  let txTables: { headers: string[]; rows: string[][] }[] = [];
  if (rawTxTables.length > 0) {
    const baseHeaders = rawTxTables[0].headers;
    let mergedRows = rawTxTables.flatMap((t) => t.rows);
    if (brokenTxRows.length > 0) {
      const existingTxns = new Set(mergedRows.map((r) => r[0]));
      const newRows = brokenTxRows.filter((r) => !existingTxns.has(r[0]));
      mergedRows = [...mergedRows, ...newRows];
    }
    txTables = [{ headers: baseHeaders, rows: mergedRows }];
  } else if (brokenTxRows.length > 0) {
    // fallback if no pipe table but broken found
    txTables = [{ headers: ["Txn No.", "Txn Date", "Description", "Branch", "Cheque", "Dr Amount", "Cr Amount", "Balance"], rows: brokenTxRows }];
  }
  const brokenRows = brokenTxRows;
  const typedJson = txTables.length ? txTables[0].rows.map((row) => Object.fromEntries(txTables[0].headers.map((h, i) => [h, row[i] ?? ""]))) : null;

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      setPdfUrl(URL.createObjectURL(file));
    } else {
      if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(null); }
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/debug/anydoc-preview", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "AnyDoc failed");
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [pdfUrl]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  }, [handleFile]);

  return (
    <div className="min-h-screen bg-white">
      <div className="grid grid-cols-1 lg:grid-cols-2 min-h-screen">
        <div className="border-r flex flex-col">
          <div className="p-6 border-b">
            <h1 className="text-sm font-semibold">Upload</h1>
            {fileName && <p className="text-xs text-zinc-500 mt-1 truncate">{fileName}</p>}
          </div>
          <div className="flex-1 p-6 flex flex-col gap-4 overflow-hidden">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-2 p-4 text-center shrink-0 ${dragOver ? "border-zinc-900 bg-zinc-50" : "border-zinc-200"}`}
            >
              <p className="text-xs text-zinc-600">Drag & drop or <label className="cursor-pointer underline font-medium">browse <input type="file" className="hidden" accept=".csv,.txt,.md,.pdf,.xlsx,.xls,.docx,.doc" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} /></label> to replace</p>
              {fileName && <p className="text-xs text-zinc-500 truncate max-w-full">{fileName}</p>}
              {loading && <p className="text-xs text-zinc-500">Running real Anydoc…</p>}
              {result && <p className="text-xs text-zinc-500">{result.success ? `✓ ${result.format} • ${result.executionTimeMs}ms • tx tables ${txTables.length}/${allTables.length} • broken rows ${brokenRows.length}` : `✗ ${result.error}`}</p>}
              {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
            <div className="flex-1 border rounded-xl overflow-hidden bg-zinc-50 min-h-[400px]">
              {pdfUrl ? (
                <iframe src={pdfUrl} className="w-full h-full min-h-[500px] bg-white" title="PDF preview" />
              ) : fileName ? (
                <div className="h-full flex items-center justify-center text-sm text-zinc-400 p-8 text-center">No PDF preview — CSV/TXT file selected</div>
              ) : (
                <div className="h-full flex items-center justify-center text-sm text-zinc-400">No file uploaded</div>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col min-h-0">
          <div className="p-6 border-b">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Preview — transaction tables only</h2>
                <p className="text-xs text-zinc-500 mt-1">Deterministic — no AI {brokenRows.length > 0 ? `• ${brokenRows.length} broken rows detected (multipage)` : ""}</p>
              </div>
              <div className="flex bg-zinc-100 rounded-full p-1 gap-1">
                <button onClick={() => setActiveTab("table")} className={`text-xs px-3 py-1.5 rounded-full font-medium ${activeTab === "table" ? "bg-zinc-900 text-white" : "text-zinc-600"}`}>Table</button>
                <button onClick={() => setActiveTab("json")} className={`text-xs px-3 py-1.5 rounded-full font-medium ${activeTab === "json" ? "bg-zinc-900 text-white" : "text-zinc-600"}`}>Typed JSON</button>
              </div>
            </div>
          </div>
          <div className="flex-1 p-6 overflow-auto bg-zinc-50/50">
            {loading ? (
              <div className="h-full flex items-center justify-center text-sm text-zinc-400 border-2 border-dashed rounded-xl bg-white">Processing…</div>
            ) : !result ? (
              <div className="h-full flex items-center justify-center text-sm text-zinc-400 border-2 border-dashed rounded-xl bg-white">No file uploaded</div>
            ) : !result.success ? (
              <div className="border rounded-xl p-6 text-sm bg-white">
                <p className="font-medium text-red-600">Anydoc failed</p>
                <p className="text-zinc-600 mt-1">{result.error}</p>
              </div>
            ) : txTables.length === 0 ? (
              <div className="border rounded-xl p-6 text-sm bg-white text-zinc-600">
                No transaction table detected — found {allTables.length} table(s) but none matched. Broken rows: {brokenRows.length}
                {brokenRows.length > 0 && <pre className="mt-3 bg-zinc-900 text-white p-3 rounded text-xs whitespace-pre-wrap">{brokenRows.slice(0, 5).join("\n").slice(0, 2000)}</pre>}
              </div>
            ) : activeTab === "table" ? (
              <div className="space-y-6">
                {txTables.map((t, ti) => (
                  <div key={ti} className="border rounded-xl overflow-auto bg-white shadow-sm">
                    <div className="px-3 py-2 bg-zinc-50 text-xs text-zinc-500 border-b">Transaction table {txTables.length > 1 ? `${ti + 1}/${txTables.length}` : ""} — {t.rows.length} rows</div>
                    <table className="w-full text-[13px] border-collapse">
                      <thead className="sticky top-0 bg-zinc-900 text-white">
                        <tr>{t.headers.map((h, i) => <th key={i} className="text-left p-3 font-semibold whitespace-nowrap tracking-tight">{h}</th>)}</tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100">
                        {t.rows.map((row, ri) => (
                          <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-zinc-50/70"}>
                            {row.map((cell, ci) => {
                              const isAmount = /^-?[\d,]*\.?\d+$/.test(cell.replace(/,/g, "")) && cell !== "";
                              const isDesc = t.headers[ci]?.toLowerCase().includes("description") || t.headers[ci]?.toLowerCase().includes("narration");
                              return <td key={ci} className={`p-3 border-t border-zinc-100 align-top ${isAmount ? "text-right font-mono tabular-nums" : ""} ${isDesc ? "min-w-[220px] max-w-[380px] whitespace-normal break-words leading-relaxed" : "whitespace-nowrap"}`} title={cell}>{cell || <span className="text-zinc-300">—</span>}</td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
                {brokenRows.length > 0 && (
                  <div className="border border-amber-200 bg-amber-50 rounded-xl p-4">
                    <p className="text-xs font-medium text-amber-800">⚠️ {brokenRows.length} transaction rows found outside tables (multipage broken) — Anydoc missed them</p>
                    <pre className="mt-2 text-xs whitespace-pre-wrap bg-white border rounded p-3 max-h-[200px] overflow-auto">{brokenRows.slice(0, 8).join("\n")}</pre>
                    <p className="text-xs text-amber-700 mt-2">Your logic only shows pipe tables → misses these. This is why multipage fails.</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">Typed JSON from transaction table(s) — no LLM</p>
                <pre className="border rounded-xl p-4 bg-zinc-900 text-emerald-300 text-xs overflow-auto max-h-[600px] whitespace-pre-wrap break-words">{JSON.stringify(typedJson, null, 2).slice(0, 30000)}</pre>
                {brokenRows.length > 0 && <p className="text-xs text-amber-600">Note: {brokenRows.length} broken rows not in JSON — they were outside any table.</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
