// Recover debit, credit and balance from physical PDF columns. These values are
// authoritative because Markdown conversion and AI can collapse empty cells.
function normalizedText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function center(item) {
  return Number(item.x) + Number(item.width) / 2;
}

function money(parts) {
  const value = parts
    .filter(part => !/^[-–—*]+$/.test(part.text))
    .sort((left, right) => right.y - left.y || left.x - right.x)
    .map((part) => part.text)
    .join("")
    .replace(/\s/g, "");
  if (!value || value === "-") return null;
  if (!/^-?\d[\d,]*\.\d{2}(?:Dr\.?|Cr\.?)?$/i.test(value)) {
    throw new Error("Uncertain PDF amount cell");
  }
  return Number(value.replace(/,/g, "").replace(/(?:Dr\.?|Cr\.?)$/i, "")) *
    (/Dr\.?$/i.test(value) ? -1 : 1);
}

function header(items, ...names) {
  for (const name of names) {
    const found = items.find(item => item.text.toLowerCase() === name.toLowerCase());
    if (found) return found;
  }
  return undefined;
}

function rowBounds(anchors, index) {
  const distances = anchors
    .slice(0, -1)
    .map((anchor, anchorIndex) => anchor.y - anchors[anchorIndex + 1].y)
    .filter((value) => value > 2)
    .sort((left, right) => left - right);
  const typical = distances.length ? distances[Math.floor(distances.length / 2)] : 72;
  const current = anchors[index];
  const previous = anchors[index - 1];
  const next = anchors[index + 1];
  return {
    top: previous ? (previous.y + current.y) / 2 : current.y + Math.max(16, typical / 2),
    bottom: next ? (current.y + next.y) / 2 : current.y - Math.max(48, typical * 1.15),
  };
}

function ruledRowBounds(page, anchor, fallback, layout) {
  const rules = (page.horizontalRules || []).filter(line =>
    line.left < (layout.reference ?? layout.postDate) && line.right > layout.balance);
  const above = rules.filter(line => line.y > anchor.y + 1).sort((a,b) => a.y-b.y)[0];
  const below = rules.filter(line => line.y < anchor.y - 1).sort((a,b) => b.y-a.y)[0];
  return above && below ? {top:above.y, bottom:below.y} : fallback;
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[-/ ](?:\d{1,2}|[A-Za-z]{3,9})[-/ ]\d{2,4})(?:\s+(.+))?$/;

function columnCell(items, target, left, right, bounds) {
  return items.filter((item) => {
    const itemCenter = center(item);
    return item.y < bounds.top && item.y > bounds.bottom && itemCenter >= left && itemCenter < right &&
      Math.abs(itemCenter - target) <= Math.max(target - left, right - target);
  });
}

function detectPnbLayout(items, page) {
  const debit = header(items, "dr amount");
  const credit = header(items, "cr amount");
  const reference = header(items, "txn no.", "txn no");
  const date = header(items, "txn date");
  const description = header(items, "description", "narration", "particulars");
  const balance = header(items, "balance");
  if (!debit || !credit || !reference || !date || !description || !balance) return null;
  const headerY = [debit, credit, reference, date, description, balance].map((item) => item.y);
  if (Math.max(...headerY) - Math.min(...headerY) > 20) return null;
  const gap = center(credit) - center(debit);
  if (gap < 30 || Math.abs(center(balance) - center(credit) - gap) > gap * 0.2) return null;
  return {
    type: "pnb",
    referenceKind: "bank_transaction_id",
    debit: center(debit),
    credit: center(credit),
    balance: center(balance),
    reference: center(reference),
    date: center(date),
    description: center(description),
    descriptionRight: header(items, "branch name")?.x ?? null,
    gap,
    width: page.width,
  };
}

function detectCentralBankLayout(items, page) {
  const debit = header(items, "debit", "debit (inr)", "dr amount", "withdrawal", "paid out");
  if (!debit) return null;
  items = items.filter(item => Math.abs(item.y-debit.y)<22);
  const postDate = header(items, "post date", "posting date", "transaction date", "txn date", "date");
  const valueDate = header(items, "value", "value date");
  const credit = header(items, "credit", "credit (inr)", "cr amount", "deposit", "paid in");
  const balance = header(items, "balance", "balance (inr)");
  const reference = header(items, "bank reference", "reference", "reference no.", "utr", "chq no.", "cheque number", "cheque no.");
  const description = header(items, "transaction description", "description", "particular", "particulars", "narration", "details");
  if (!postDate || !debit || !credit || !balance || !description) return null;
  const headerY = [postDate, debit, credit, balance, description].map((item) => item.y);
  if (Math.max(...headerY) - Math.min(...headerY) > 20) return null;
  if (!(center(debit) < center(credit) && center(credit) < center(balance))) return null;
  return {
    type: /^(?:post|posting) date$/i.test(postDate.text) ? "central_bank" : "generic_statement",
    postDate: center(postDate),
    valueDate: valueDate ? center(valueDate) : null,
    description: center(description),
    reference: reference ? center(reference) : null,
    referenceKind: reference && /chq|cheque/i.test(reference.text) ? "cheque" : reference ? "reference" : null,
    descriptionRight: reference ? reference.x - Math.min(20, reference.width / 2) : null,
    debit: center(debit),
    credit: center(credit),
    balance: center(balance),
    width: page.width,
  };
}

function extractPnbRows(items, page, layout) {
  const references = items
    .filter((item) => /^[A-Z][A-Z0-9]{5,}$/i.test(item.text) && Math.abs(center(item) - layout.reference) < 28)
    .sort((left, right) => right.y - left.y);
  const rows = [];
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const date = items.find((item) => /^\d{2}-\d{2}-\d{4}$/.test(item.text) && Math.abs(item.y - reference.y) < 4 && Math.abs(center(item) - layout.date) < 28);
    if (!date) {
      throw new Error("PNB transaction/date alignment is uncertain");
    }
    const bounds = ruledRowBounds(page, reference, rowBounds(references, index), layout);
    const debitAmount = money(columnCell(items, layout.debit, layout.debit - layout.gap / 2, layout.debit + layout.gap / 2, bounds));
    const creditAmount = money(columnCell(items, layout.credit, layout.credit - layout.gap / 2, layout.credit + layout.gap / 2, bounds));
    const balanceAmount = money(columnCell(items, layout.balance, layout.balance - layout.gap / 2, layout.balance + layout.gap / 2, bounds));
    if (Number(debitAmount > 0) + Number(creditAmount > 0) !== 1 || balanceAmount === null) {
      throw new Error("PNB transaction columns are incomplete");
    }
    // Printed table rules enclose the entire wrapped narration. A fixed text
    // window clips long party names and can attach a line to the previous row.
    const narrationBounds = bounds;
    const narration = columnCell(
      items,
      layout.description,
      (layout.date + layout.description) / 2,
      layout.descriptionRight ?? layout.debit - layout.gap / 2,
      narrationBounds
    )
      .sort((left, right) => right.y - left.y || left.x - right.x)
      .map((item) => item.text)
      .join(" ")
      .trim();
    if (!narration) throw new Error("PNB transaction narration is incomplete");
    rows.push({
      reference: reference.text.toUpperCase(),
      sourceDate: date.text,
      narration,
      debitAmount,
      creditAmount,
      balanceAmount,
      page: page.pageNumber,
    });
  }
  return rows;
}

function extractCentralBankRows(items, page, layout) {
  // Some PDF producers emit date and narration as one text item (e.g. SVC).
  // Split only items originating in the physical date column.
  items = items.flatMap(item => {
    const match = item.x < (layout.postDate + layout.description) / 2 ? item.text.match(DATE_PREFIX) : null;
    if (!match?.[2]) return [item];
    return [{...item,text:match[1],width:Math.min(item.width,50)},
      {...item,text:match[2],x:layout.description-20,width:Math.max(1,item.width-50)}];
  });
  const dates = items
    .filter((item) => DATE_PREFIX.test(item.text) && !item.text.match(DATE_PREFIX)?.[2] && Math.abs(center(item) - layout.postDate) < 28)
    .sort((left, right) => right.y - left.y);
  const debitCreditBoundary = (layout.debit + layout.credit) / 2;
  const creditBalanceBoundary = (layout.credit + layout.balance) / 2;
  const rows = [];
  for (let index = 0; index < dates.length; index += 1) {
    const bounds = rowBounds(dates, index);
    const debitAmount = money(columnCell(items, layout.debit, layout.debit - (layout.credit - layout.debit) / 2, debitCreditBoundary, bounds));
    const creditAmount = money(columnCell(items, layout.credit, debitCreditBoundary, creditBalanceBoundary, bounds));
    const balanceAmount = money(columnCell(items, layout.balance, creditBalanceBoundary, page.width + 1, bounds));
    const narration = columnCell(
      items,
      layout.description,
      layout.valueDate
        ? (layout.valueDate + layout.description) / 2
        : (layout.postDate + layout.description) / 2,
      layout.descriptionRight ?? layout.debit - 20,
      layout.reference ? { ...bounds, bottom: Math.max(bounds.bottom, dates[index].y - 20) } : bounds
    )
      .sort((left, right) => right.y - left.y || left.x - right.x)
      .map((item) => item.text)
      .join(" ")
      .trim();
    if (!debitAmount && !creditAmount && /^(?:(?:by|to)\s+)?(?:opening balance|closing balance)$/i.test(narration)) {
      if (/opening/i.test(narration) && balanceAmount !== null) page.openingBalance = balanceAmount;
      continue;
    }
    if (Number(debitAmount > 0) + Number(creditAmount > 0) !== 1 || balanceAmount === null) {
      throw new Error("Central Bank transaction columns are incomplete");
    }
    rows.push({
      reference: layout.reference ? items.filter(item => Math.abs(item.y - dates[index].y) < 4 &&
        center(item) > layout.descriptionRight && center(item) < layout.debit - 20)
        .sort((left, right) => left.x - right.x).map(item => item.text).join('').replace(/^[-–—]+$/, '') : "",
      sourceDate: dates[index].text,
      valueDate: layout.valueDate ? items.find(item => Math.abs(item.y-dates[index].y)<4 && Math.abs(center(item)-layout.valueDate)<20 && DATE_PREFIX.test(item.text))?.text ?? dates[index].text : dates[index].text,
      narration,
      debitAmount,
      creditAmount,
      balanceAmount,
      page: page.pageNumber,
    });
  }
  return rows;
}

// HDFC prints each heading as separate words ("Debit" "Amount") and wraps the
// first column over two lines, so no single item matches a heading name.
function wordPair(items, first, second) {
  for (const a of items) {
    if (a.text.toLowerCase() !== first) continue;
    const b = items.find(item => item.text.toLowerCase() === second && Math.abs(item.y - a.y) < 3 && item.x > a.x && item.x - (a.x + a.width) < 12);
    if (b) return { left: a.x, right: b.x + b.width, y: a.y };
  }
  return null;
}

function detectHdfcLayout(items, page) {
  const debit = wordPair(items, "debit", "amount");
  const credit = wordPair(items, "credit", "amount");
  const balanceItem = items.find(item => item.text.toLowerCase() === "closing balance");
  // The summary table below also prints "Closing" "Balance" as two words, so prefer the one-piece heading.
  const balance = balanceItem ? { left: balanceItem.x, right: balanceItem.x + balanceItem.width, y: balanceItem.y } : wordPair(items, "closing", "balance");
  const reference = wordPair(items, "reference", "no.");
  const valueDate = wordPair(items, "value", "date");
  if (!debit || !credit || !balance || !reference || !valueDate) return null;
  if (Math.max(debit.y, credit.y, balance.y, reference.y, valueDate.y) - Math.min(debit.y, credit.y, balance.y, reference.y, valueDate.y) > 3) return null;
  if (!(debit.right < credit.left && credit.right < balance.left)) return null;
  const headerY = debit.y;
  const dateHead = items.find(item => item.text.toLowerCase() === "transaction" && Math.abs(item.y - headerY) < 3 && item.x < reference.left);
  const descriptionHead = items.find(item => item.text.toLowerCase() === "transaction" && Math.abs(item.y - headerY) < 3 && dateHead && item.x > dateHead.x + 10 && item.x < reference.left);
  const below = word => items.some(item => item.text.toLowerCase() === word && item.y < headerY && headerY - item.y < 16);
  if (!dateHead || !descriptionHead || !below("date") || !below("description")) return null;
  const summary = wordPair(items, "statement", "summary");
  return {
    type: "hdfc_statement",
    date: center(dateHead),
    descriptionLeft: descriptionHead.x - 2,
    referenceLeft: reference.left - 4,
    referenceRight: valueDate.left - 2,
    valueDate: (valueDate.left + valueDate.right) / 2,
    debitLeft: valueDate.right + 8,
    creditLeft: (debit.right + credit.left) / 2,
    balanceLeft: (credit.right + balance.left) / 2,
    headerY,
    summaryY: summary ? summary.y : null,
    referenceKind: "reference",
    width: page.width,
  };
}

function extractHdfcRows(items, page, layout) {
  const dates = items
    .filter(item => /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(item.text) && Math.abs(center(item) - layout.date) < 28 && item.y < layout.headerY - 5)
    // A transaction row also prints its value date on the same line; this skips
    // the printed-on timestamp in the page footer.
    .filter(item => items.some(other => other !== item && /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(other.text) && Math.abs(other.y - item.y) < 4 && Math.abs(center(other) - layout.valueDate) < 28))
    .sort((left, right) => right.y - left.y);
  const rows = [];
  for (let index = 0; index < dates.length; index += 1) {
    const bounds = rowBounds(dates, index);
    // The two-line heading ("Transaction" / "Date") must stay outside the first row.
    bounds.top = Math.min(bounds.top, layout.headerY - 10);
    if (index === dates.length - 1 && layout.summaryY !== null) bounds.bottom = Math.max(bounds.bottom, layout.summaryY);
    const cell = (left, right) => columnCell(items, (left + right) / 2, left, right, bounds);
    const debitAmount = money(cell(layout.debitLeft, layout.creditLeft));
    const creditAmount = money(cell(layout.creditLeft, layout.balanceLeft));
    const balanceAmount = money(cell(layout.balanceLeft, page.width + 1));
    if (Number(debitAmount > 0) + Number(creditAmount > 0) !== 1 || balanceAmount === null) {
      throw new Error("HDFC transaction columns are incomplete");
    }
    // Wrapped narration and reference lines hang below the line that carries the date.
    const wrapBounds = { top: Math.min(bounds.top, dates[index].y + 5), bottom: dates[index + 1] ? dates[index + 1].y + 5 : bounds.bottom };
    const text = (left, right) => columnCell(items, (left + right) / 2, left, right, wrapBounds).sort((a, b) => b.y - a.y || a.x - b.x).map(item => item.text).join(" ").trim();
    const narration = text(layout.descriptionLeft, layout.referenceLeft);
    if (!narration) throw new Error("HDFC transaction narration is incomplete");
    const valueDate = items.find(item => /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(item.text) && Math.abs(item.y - dates[index].y) < 4 && Math.abs(center(item) - layout.valueDate) < 28);
    rows.push({
      reference: text(layout.referenceLeft, layout.referenceRight).replace(/\s+/g, ""),
      sourceDate: dates[index].text,
      valueDate: valueDate?.text,
      narration,
      debitAmount,
      creditAmount,
      balanceAmount,
      page: page.pageNumber,
    });
  }
  return rows;
}

export function extractBankStatementPhysicalColumns(pages) {
  let layout = null;
  let detected = false;
  const rows = [];
  let openingBalance = null;
  for (const page of pages) {
    const items = page.items
      .filter((item) => item.str?.trim())
      .map((item) => ({ text: normalizedText(item.str), x: item.transform[4], y: item.transform[5], width: item.width }));
    const detectedLayout = detectPnbLayout(items, page) || detectHdfcLayout(items, page) || detectCentralBankLayout(items, page);
    if (detectedLayout) {
      if (layout && layout.type !== detectedLayout.type) throw new Error("Bank statement layout changed between pages");
      layout = detectedLayout;
      detected = true;
    }
    if (!layout) continue;
    if (Math.abs(page.width - layout.width) > 1) throw new Error(`${layout.type === "pnb" ? "PNB" : "bank statement"} continuation page width changed`);
    rows.push(...(layout.type === "pnb" ? extractPnbRows(items, page, layout) : layout.type === "hdfc_statement" ? extractHdfcRows(items, page, layout) : extractCentralBankRows(items, page, layout)));
    if (openingBalance === null && page.openingBalance !== undefined) openingBalance = page.openingBalance;
  }
  if (detected && rows.length === 0) throw new Error("Physical transaction columns were detected but no complete rows were found");
  // PNB can print one Txn No. on several postings (for example a payment plus a
  // small charge). Only a repeated reference with identical amounts and balance
  // means the same physical row was read twice.
  if (detected && layout?.type === "pnb" && new Set(rows.map((row) => [row.reference, row.debitAmount, row.creditAmount, row.balanceAmount].join("|"))).size !== rows.length) {
    throw new Error("PNB transaction references are incomplete or duplicated");
  }
  return { detected, layout: layout?.type ?? null, referenceKind:layout?.referenceKind??null, matchByOrder: false, rows, openingBalance };
}

export const extractPnbPhysicalColumns = extractBankStatementPhysicalColumns;

// Recover printed row rules using the PDF graphics transform, rather than
// assuming the text is vertically centered in a fixed-height row.
function horizontalRules(operatorList, OPS) {
  let matrix = [1,0,0,1,0,0]; const stack = []; const segments = []; let imageArea=0;
  const point = (x,y) => [matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]];
  const line = (a,b) => {if(Math.abs(a[1]-b[1])<0.3 && Math.abs(a[0]-b[0])>10) segments.push({y:(a[1]+b[1])/2,left:Math.min(a[0],b[0]),right:Math.max(a[0],b[0])});};
  for(let i=0;i<operatorList.fnArray.length;i++) {
    const op=operatorList.fnArray[i],args=operatorList.argsArray[i];
    if(op===OPS.save) stack.push([...matrix]);
    else if(op===OPS.restore) matrix=stack.pop()||matrix;
    else if(op===OPS.transform) {const [a,b,c,d,e,f]=matrix,[g,h,j,k,l,m]=args;matrix=[a*g+c*h,b*g+d*h,a*j+c*k,b*j+d*k,a*l+c*m+e,b*l+d*m+f];}
    else if([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintJpegXObject].includes(op)) imageArea=Math.max(imageArea,Math.abs(matrix[0]*matrix[3]-matrix[1]*matrix[2]));
    else if(op===OPS.constructPath) {
      const [ops,coords]=args; let index=0,previous=null;
      for(const command of ops) {
        if(command===OPS.moveTo) previous=point(coords[index++],coords[index++]);
        else if(command===OPS.lineTo) {const next=point(coords[index++],coords[index++]);if(previous)line(previous,next);previous=next;}
        else if(command===OPS.rectangle) {const [x,y,w,h]=coords.slice(index,index+4);index+=4;line(point(x,y),point(x+w,y));line(point(x,y+h),point(x+w,y+h));previous=null;}
        else if(command===OPS.curveTo) {index+=6;previous=null;}
        else if(command===OPS.curveTo2||command===OPS.curveTo3) {index+=4;previous=null;}
      }
    }
  }
  const grouped = new Map();
  for(const s of segments) {const key=Math.round(s.y*2)/2;const old=grouped.get(key);grouped.set(key,{y:key,left:Math.min(old?.left??s.left,s.left),right:Math.max(old?.right??s.right,s.right)});}
  return {rules:[...grouped.values()],imageArea};
}

export async function readBankStatementPhysicalColumns(bytes, workerSrc, maxPages = 300) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
  try {
    if (pdf.numPages > maxPages) throw new Error("PDF page limit exceeded");
    const pages = [];
    const imageOnlyPages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      const operators = await page.getOperatorList();
      const geometry = horizontalRules(operators,pdfjs.OPS);
      const width=page.view[2]-page.view[0],height=page.view[3]-page.view[1];
      if(text.items.map(item=>item.str||'').join('').trim().length<40 && geometry.imageArea>width*height*0.4)imageOnlyPages.push(pageNumber);
      pages.push({ pageNumber, width, items: text.items, horizontalRules: geometry.rules });
      page.cleanup();
    }
    return {...extractBankStatementPhysicalColumns(pages),imageOnlyPages};
  } finally {
    await pdf.destroy();
  }
}

export const readPnbPhysicalColumns = readBankStatementPhysicalColumns;
