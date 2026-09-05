// Recover the PNB transaction grid from physical PDF columns, never from the
// changing number of empty Markdown cells. Other layouts retain their pipeline.
function money(parts) {
  const value=parts.sort((a,b)=>b.y-a.y||a.x-b.x).map(p=>p.text).join('').replace(/\s/g,'');
  if(!value||value==='-')return null;
  if(!/^\d[\d,]*\.\d{2}(?:Dr\.?|Cr\.?)?$/i.test(value))throw new Error('Uncertain PDF amount cell');
  return Number(value.replace(/,/g,'').replace(/(?:Dr\.?|Cr\.?)$/i,''))*(/Dr\.?$/i.test(value)?-1:1);
}
export function extractPnbPhysicalColumns(pages) {
  let layout=null;const rows=[];let detected=false;
  for(const page of pages){
    const items=page.items.filter(i=>i.str?.trim()).map(i=>({text:i.str.trim(),x:i.transform[4],y:i.transform[5],width:i.width}));
    const header=text=>items.find(i=>i.text.toLowerCase()===text);
    const debit=header('dr amount'),credit=header('cr amount'),reference=header('txn no.'),date=header('txn date'),balance=header('balance');
    if(debit&&credit&&reference&&date&&balance){
      const center=i=>i.x+i.width/2;
      if(Math.max(...[debit,credit,reference,date,balance].map(i=>i.y))-Math.min(...[debit,credit,reference,date,balance].map(i=>i.y))>20)continue;
      const gap=center(credit)-center(debit);
      if(gap<30||Math.abs(center(balance)-center(credit)-gap)>gap*.2)continue;
      layout={debit:center(debit),credit:center(credit),balance:center(balance),ref:center(reference),date:center(date),gap,width:page.width};detected=true;
    }
    if(!layout)continue;
    if(Math.abs(page.width-layout.width)>1)throw new Error('PNB continuation page width changed');
    const refs=items.filter(i=>/^T\d{5,}$/.test(i.text)&&Math.abs(i.x+i.width/2-layout.ref)<25).sort((a,b)=>b.y-a.y);
    if(!refs.length)continue;
    for(let index=0;index<refs.length;index++){
      const ref=refs[index];
      if(!items.some(i=>/^\d{2}-\d{2}-\d{4}$/.test(i.text)&&Math.abs(i.y-ref.y)<3&&Math.abs(i.x+i.width/2-layout.date)<25))throw new Error('PNB transaction/date alignment is uncertain');
      const above=index?(refs[index-1].y-ref.y)/2:40;
      const below=index+1<refs.length?(ref.y-refs[index+1].y)/2:40;
      const cell=x=>items.filter(i=>i.y<ref.y+above&&i.y>ref.y-below&&i.x>=x-layout.gap/2&&i.x+i.width<=x+layout.gap/2+1);
      const debitAmount=money(cell(layout.debit)),creditAmount=money(cell(layout.credit)),balanceAmount=money(cell(layout.balance));
      if(Number(debitAmount>0)+Number(creditAmount>0)!==1||balanceAmount===null)throw new Error('PNB transaction columns are incomplete');
      rows.push({reference:ref.text,debitAmount,creditAmount,balanceAmount,page:page.pageNumber});
    }
  }
  if(detected&&(!rows.length||new Set(rows.map(r=>r.reference)).size!==rows.length))throw new Error('PNB transaction references are incomplete or duplicated');
  return {detected,rows,openingBalance:null};
}
export async function readPnbPhysicalColumns(bytes,workerSrc,maxPages=300) {
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  if(workerSrc)pdfjs.GlobalWorkerOptions.workerSrc=workerSrc;
  const pdf=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:true,verbosity:0}).promise;
  try{
    if(pdf.numPages>maxPages)throw new Error('PDF page limit exceeded');
    const pages=[];
    for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n);const text=await page.getTextContent();pages.push({pageNumber:n,width:page.view[2]-page.view[0],items:text.items});page.cleanup();}
    return extractPnbPhysicalColumns(pages);
  }finally{await pdf.destroy();}
}
