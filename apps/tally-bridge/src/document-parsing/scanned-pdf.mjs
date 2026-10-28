import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
const script=fileURLToPath(new URL('./windows-ocr.ps1',import.meta.url));

const phrases=new Set(['txn no.','txn no','txn date','dr amount','cr amount','post date','posting date','transaction date','value date','transaction description','reference no.','bank reference','debit amount','credit amount','closing balance','chq no.','cheque number','balance (inr)','debit (inr)','credit (inr)']);
export function validateOcrPhysicalRows(physical) {
  if(!physical.detected||!physical.rows.length || physical.rows.some(row=>row.reference&&!/\d/.test(row.reference))) {
    const error=new Error('The scanned statement has unreadable entries or references. Please upload a clearer scan or a text PDF.');
    error.code='ocr_review_required';
    throw error;
  }
}
export function ocrWordsToPdfItems(lines,scale,pageHeight) {
  const words=lines.flatMap(line=>line.words||[]).filter(w=>w.text?.trim());
  const bands=[];
  for(const word of words.sort((a,b)=>a.y-b.y||a.x-b.x)) {
    const band=bands.find(b=>Math.abs(b.y-word.y)<Math.max(5,word.height*0.45));
    if(band)band.words.push(word);else bands.push({y:word.y,words:[word]});
  }
  const items=[];
  for(const band of bands) {
    const row=band.words.sort((a,b)=>a.x-b.x);
    const bottoms=row.map(w=>w.y+w.height).sort((a,b)=>a-b);
    const baseline=pageHeight-bottoms[Math.floor(bottoms.length/2)]/scale;
    for(let i=0;i<row.length;) {
      let size=1,text=row[i].text;
      for(const n of [3,2]) {
        const group=row.slice(i,i+n);if(group.length!==n)continue;
        if(group.some((w,j)=>j>0&&w.x-(group[j-1].x+group[j-1].width)>Math.max(24,w.height*2)))continue;
        const phrase=group.map(w=>w.text).join(' ');
        const joined=group.map(w=>w.text).join('');
        const date=/^(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}-\d{2}-\d{2})$/.test(joined);
        const splitNumber=/^\d+$/.test(group[0].text)&&group.slice(1).every(w=>/^[\d,.]+$/.test(w.text))&&/^\d[\d,]*\.\d{2}$/.test(joined)&&group.every((w,j)=>!j||w.x-(group[j-1].x+group[j-1].width)<w.height*0.6);
        if(date||splitNumber) {size=n;text=joined;break;}
        if(phrases.has(phrase.toLowerCase())||/^\d{1,2} [A-Za-z]{3,9} \d{2,4}$/.test(phrase)||/^- \d[\d,]*\.\d{2}$/.test(phrase)) {size=n;text=phrase.replace(/^- /,'-');break;}
      }
      const group=row.slice(i,i+size),x=Math.min(...group.map(w=>w.x)),right=Math.max(...group.map(w=>w.x+w.width));
      items.push({str:text,width:(right-x)/scale,transform:[1,0,0,1,x/scale,baseline]});i+=size;
    }
  }
  return items;
}

export async function readScannedPdf(bytes,extractPhysicalColumns,{maxPages=30}={}) {
  if(process.platform!=='win32') {const e=new Error('This scanned statement needs OCR. Please use a text PDF or run the Windows connector.');e.code='ocr_unavailable';throw e;}
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const {createCanvas}=await import('@napi-rs/canvas');
  const pdf=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true,verbosity:0}).promise;
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gajkesari-ocr-'));
  try {
    if(pdf.numPages>maxPages)throw new Error(`Scanned statements are limited to ${maxPages} pages per upload. Please split this PDF.`);
    const pages=[],texts=[],languages=new Set();
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++) {
      const page=await pdf.getPage(pageNumber),height=page.view[3]-page.view[1],width=page.view[2]-page.view[0];
      const scale=Math.min(3,2600/Math.max(width,height)),viewport=page.getViewport({scale});
      const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const imagePath=path.join(temp,`page-${pageNumber}.png`),jsonPath=path.join(temp,`page-${pageNumber}.json`);
      await fs.writeFile(imagePath,canvas.toBuffer('image/png'));
      await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-InputPath',imagePath,'-OutputPath',jsonPath],{windowsHide:true,timeout:45000,maxBuffer:1024*1024});
      const result=JSON.parse(await fs.readFile(jsonPath,'utf8'));languages.add(result.language);
      texts.push(result.lines.map(l=>l.text).join('\n'));
      pages.push({pageNumber,width,items:ocrWordsToPdfItems(result.lines,scale,height)});
      page.cleanup();
    }
    const physical=extractPhysicalColumns(pages);
    validateOcrPhysicalRows(physical);
    const safe=value=>String(value??'').replace(/\|/g,' ');
    const markdown=[texts.join('\n'),physical.openingBalance===null?'':`Opening balance ${physical.openingBalance}`,
      '|Date|Description|Reference|Debit|Credit|Balance|','|---|---|---|---|---|---|',
      ...physical.rows.map(r=>`|${r.sourceDate}|${safe(r.narration)}|${safe(r.reference)}|${r.debitAmount??''}|${r.creditAmount??''}|${r.balanceAmount??''}|`)].join('\n');
    return {physical,markdown,pages:pdf.numPages,languages:[...languages]};
  } finally {
    await pdf.destroy();
    // Only the unique directory created by mkdtemp above is removed.
    if(path.dirname(path.resolve(temp))!==path.resolve(os.tmpdir()))throw new Error('Unexpected OCR temporary directory');
    await fs.rm(temp,{recursive:true,force:true});
  }
}
