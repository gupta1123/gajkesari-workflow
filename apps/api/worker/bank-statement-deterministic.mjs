export function parseAllTables(md) {
  const lines = md.split("\n");
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1] || "";
    const isHeader = line.includes("|") && line.split("|").filter(Boolean).length >= 2;
    const isSep = /\|\s*:?-{2,}:?\s*\|/.test(next) || /^\s*\|?(\s*:?-+:?\s*\|)+\s*$/.test(next);
    if (isHeader && isSep) {
      const rawHeaders = line.split("|").slice(1, -1).map((c) => c.trim());
      const rawRows = [];
      const startLine = i;
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        const row = lines[i].split("|").slice(1, -1).map((c) => c.trim());
        if (row.every((c) => /^:?-+:?$/.test(c))) { i++; continue; }
        rawRows.push(row);
        i++;
      }
      if (rawHeaders.length >= 2 && rawRows.length > 0) {
        const keepIdx = rawHeaders.map((h, idx) => ({ h, idx })).filter((x) => x.h !== "").map((x) => x.idx);
        let headers = keepIdx.map((idx) => rawHeaders[idx]);
        let rows = rawRows.map((r) => keepIdx.map((idx) => r[idx] ?? ""));
        // PNB fused header fix
        const hasFused = headers.some((h) => h.toLowerCase().includes("cheque") && h.toLowerCase().includes("dr amount"));
        if (hasFused) {
          const idx = headers.findIndex((h) => h.toLowerCase().includes("cheque") && h.toLowerCase().includes("dr amount"));
          if (idx !== -1) {
            headers = [...headers.slice(0, idx), "Cheque No.", "Dr Amount", ...headers.slice(idx + 1)];
            rows = rows.map((r) => {
              const cell = r[idx] || "";
              const isAmount = /[\d,]+\.\d{2}/.test(cell) && cell !== "-";
              return [...r.slice(0, idx), "", isAmount ? cell : "", ...r.slice(idx + 1)];
            });
          }
        }
        tables.push({ headers, rows, startLine });
      }
    } else {
      i++;
    }
  }
  return tables;
}

export function isTransactionTable(t) {
  const h = t.headers.map((x) => x.toLowerCase());
  const hasDate = h.some((x) => x.includes("date"));
  const hasDesc = h.some((x) => x.includes("description") || x.includes("narration") || x.includes("particular") || x.includes("details") || x.includes("remarks"));
  const hasAmount = h.some((x) => x.includes("debit") || x.includes("credit") || x.includes("amount") || x.includes("balance") || x === "dr" || x === "cr");
  return hasDate && hasDesc && hasAmount;
}

export function extractBrokenTransactions(md) {
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
    return [txn, date, desc, "-", "", amt, "", bal, ""];
  });
}

function parseDateValue(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d)) return `${y.padStart(4,"0")}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }
  const indian = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (indian) {
    const [, d, m, yRaw] = indian;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d)) return `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }
  const p = new Date(raw);
  if (!isNaN(p.getTime())) return p.toISOString().slice(0,10);
  return null;
}

function parseAmountValue(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const raw = String(v).trim();
  if (!raw) return null;
  const isDR = /\bDR\.?\s*$/i.test(raw);
  const neg = /^\(.*\)$/.test(raw) || /^-/.test(raw) || isDR;
  const cleaned = raw.replace(/\b(?:DR|CR)\.?\s*$/i,"").replace(/[(),₹$€£\s]/g,"").replace(/^-/,"");
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return isFinite(n) ? (neg ? -n : n) : null;
}

function headerIndex(headers, keywords) {
  const lower = headers.map((h) => h.toLowerCase());
  for (let i=0;i<lower.length;i++) for (const k of keywords) if (lower[i].includes(k)) return i;
  return -1;
}

export function deterministicTransactionsFromAnydoc(markdown, openingBalance = null) {
  const all = parseAllTables(markdown);
  const rawTx = all.filter(isTransactionTable);
  const broken = extractBrokenTransactions(markdown);
  let mergedRows = [];
  let headers = [];
  if (rawTx.length > 0) {
    headers = rawTx[0].headers;
    mergedRows = rawTx.flatMap((t) => t.rows);
    if (broken.length) {
      const existing = new Set(mergedRows.map((r) => r[0]));
      const add = broken.filter((r) => !existing.has(r[0]));
      // broken rows are 9 cols matching PNB normalized headers; if headers mismatch, map
      if (add.length && headers.length === 9 && add[0].length === 9) mergedRows = [...mergedRows, ...add];
      else if (add.length) {
        // fallback: just append as is, headers already match
        mergedRows = [...mergedRows, ...add];
      }
    }
  } else if (broken.length) {
    headers = ["Txn No.","Txn Date","Description","Branch Name","Cheque No.","Dr Amount","Cr Amount","Balance","KIMS Remarks"];
    mergedRows = broken;
  } else {
    return null;
  }

  if (mergedRows.length === 0) return null;

  // Map headers to transaction fields
  const idxTxnNo = headerIndex(headers, ["txn no","transaction no"]);
  const idxDate = headerIndex(headers, ["txn date","transaction date","post date","value date"]);
  const idxDesc = headerIndex(headers, ["description","narration","particulars"]);
  const idxDr = headerIndex(headers, ["dr amount","debit"]);
  const idxCr = headerIndex(headers, ["cr amount","credit"]);
  const idxBal = headerIndex(headers, ["balance","closing balance"]);
  const idxRef = headerIndex(headers, ["cheque","reference","utr"]);

  const transactions = mergedRows.map((row, idx) => {
    const txnNo = idxTxnNo >=0 ? row[idxTxnNo] : "";
    const dateRaw = idxDate >=0 ? row[idxDate] : "";
    const desc = idxDesc >=0 ? row[idxDesc] : row.join(" ");
    const drRaw = idxDr >=0 ? row[idxDr] : "";
    const crRaw = idxCr >=0 ? row[idxCr] : "";
    const balRaw = idxBal >=0 ? row[idxBal] : "";
    const refRaw = idxRef >=0 ? row[idxRef] : txnNo;
    const transactionDate = parseDateValue(dateRaw);
    if (!transactionDate || !desc) return null;
    const debit = parseAmountValue(drRaw);
    const credit = parseAmountValue(crRaw);
    const hasDebit = typeof debit === "number" && debit > 0;
    const hasCredit = typeof credit === "number" && credit > 0;
    // Handle single amount column cases where amount may be in either Dr or Cr but row has only one amount and balance sign
    const debitAmount = hasDebit ? debit : null;
    const creditAmount = hasCredit ? credit : (hasDebit ? null : (typeof credit === "number" && credit>0 ? credit : null));
    // For PNB, amounts are already split correctly after normalize, so above holds
    const balance = parseAmountValue(balRaw);
    const amountIssue = hasDebit === hasCredit ? (hasDebit ? "both_debit_and_credit" : "missing_debit_and_credit") : null;
    return {
      row_index: idx+1,
      transaction_date: transactionDate,
      value_date: transactionDate,
      description: desc,
      reference_number: refRaw || txnNo || null,
      debit_amount: debitAmount,
      credit_amount: creditAmount,
      balance_amount: balance,
      transaction_type: "unknown",
      category: amountIssue ? "unknown" : (creditAmount ? "receipt" : "payment"),
      counterparty_name: null,
      suggested_ledger_name: null,
      suggestion_confidence: null,
      suggestion_reason: null,
      confirmed_ledger_name: null,
      additional_charges: [],
      confidence: 0.9,
      raw_payload: { rowNumber: idx+1, source: "deterministic_anydoc", ...(amountIssue?{amountValidationIssue: amountIssue}:{}) }
    };
  }).filter(Boolean);

  if (transactions.length === 0) return null;
  return { headers, transactions };
}
