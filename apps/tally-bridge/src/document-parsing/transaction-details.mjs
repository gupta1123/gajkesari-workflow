// Source-only transaction details. Never consult a Tally ledger or expand a
// printed name to an inferred company identity.
const clean = value => String(value ?? "").replace(/\s+/g," ").trim();
const compact = value => clean(value).replace(/\s/g,"").toUpperCase();
const BANK_CODES = "AXOD|AXOB|BKID|HDFC|ICIC|CBIN|UTIB|MAHB|SBIN|KKBK|INDB|IDFB|PUNB|YESB|FDRL|BARB|IOBA|CNRB|CIUB|AUBL|UBIN|PSPC|COSB|VVSB|MSBL|JSBP|DCBL|MAHG|RATN|DEUT|TJSB|SVCB|IBKL";
const bankTransfer = new RegExp(`(?:${BANK_CODES})(?:[A-Z]{1,2}[0-9]|[1-9])[A-Z0-9]{9,}`,"i");
const ifsc = /^[A-Z]{4}0[A-Z0-9]{6}$/i;
const nonParty = /^(?:CHQ\s+DEP\b|CHEQUE\s+(?:DEPOSIT|CLEARING)\b|(?:AUTO\s+)?(?:TERM\s+LOAN|INTEREST\s+PAYMENT)\b|AUTO INTEREST\b|LOAN RECOVERY\b|BANK\s+(?:COMMISSION|CHARGES?)\b|COMM ON\b|CIR CHARGE COLLECTION\b|GST\b|CGST\b|SGST\b|IGST\b|ATM\b|CASH (?:WITHDRAWAL|DEPOSIT)\b)|\bINT\.?\s*COLL\b/i;

function usableParty(value) {
  const text = clean(value).replace(/^[\s:;\-/]+|[\s:;\-]+$/g,"");
  if (!text || !/\p{L}/u.test(text) || /^[\d\s*Xx]+$/.test(text) || /\d{5,}/.test(text) || ifsc.test(compact(text))) return null;
  if (/^(?:REF(?:ERENCE)?\b|UTR\b|UPI\b|NEFT\b|RTGS\b|IMPS\b|TRANSFER\b|PAYMENT\b|RECEIPT\b|UNKNOWN\b|USER\d*$)/i.test(text)) return null;
  return text;
}

export function extractTransferReference(description) {
  const text = compact(description);
  const explicit = text.match(/\/XUTR\/([A-Z0-9]+)/)?.[1];
  if (explicit) return explicit;
  const imps = text.match(/IMPS(?:P2A|[-/]?(?:IN|OUT)?[-/]?)(\d{12})/);
  if (imps) return imps[1];
  // PNB embeds a routing envelope before // and repeats the actual UTR after it.
  const repeated = text.includes("//") ? text.split("//")[1].split("/")[0] : null;
  if (repeated && /\d/.test(repeated) && repeated.length >= 12) return repeated;
  const segments = text.split('/');
  const candidate = segments.find(s => bankTransfer.test(s));
  return candidate?.match(bankTransfer)?.[0] ?? null;
}

export function extractPotentialPartyName(description, {accountHolderName=""}={}) {
  const text = clean(description);
  if (!text || nonParty.test(text)) return {name:null,method:"no_named_party",confidence:null};
  let candidate = null, method = "printed_text";
  const neftOut = text.match(/^NEFT[_ -]*OUT\s*:[^/]+\/([^/]+)/i);
  if (/^(?:To|From):[X*\d]+:/i.test(text)) {candidate=text.replace(/^(?:To|From):[X*\d]+:/i,"");method="masked_account_transfer";}
  else if (neftOut) {candidate=neftOut[1];method="transfer_path";}
  else if (/^(?:N?RTGS|NEFT[_ -]*IN|IMPS\s*[-/]\s*IN)\s*[:/]/i.test(text)) {
    candidate=text.split('/').at(-1);method="transfer_path";
  } else if (/^IMPSP2A\d{12}/i.test(text)) {
    candidate=text.replace(/^IMPSP2A\d{12}\s*/i,"");method="imps";
  } else if (/^IMPS\s*-\s*\d{12}\s*-/i.test(text)) {
    candidate=text.replace(/^IMPS\s*-\s*\d{12}\s*-/i,"").split(/\s*-\s*/)[0];method="imps";
  } else if (/^\d{6,}\s*-\s*TPT\s*-/i.test(text)) {
    const body=text.replace(/^\d{6,}\s*-\s*TPT\s*-\s*/i,"");
    const parts=body.split(/\s*-\s*/);
    const memo=/^(?:part payment|payment|pay|bill|trf|transfer|HDFC[A-Z0-9]+|NB[A-Z0-9]+)$|\bto\b/i.test(parts[0]);
    candidate=memo&&parts.length>1?parts.slice(1).join('-'):body;method="account_transfer";
  } else if (/^(?:FT|NEFT)\s*-/i.test(text) && !/^NEFT\s+(?:Cr|Dr)\s*-/i.test(text)) {
    candidate=text.match(/(?:^|-\s*)\d[\d\s]{5,}\s*-\s*(.+)$/)?.[1] ?? null;method="account_transfer";
  } else if (/^(?:RTGS|NEFT)\s+(?:Cr|Dr)\s*-/i.test(text)) {
    const body=text.replace(/^(?:RTGS|NEFT)\s+(?:Cr|Dr)\s*-\s*/i,"");
    const route=body.match(/^[A-Z]{4}0[A-Z0-9]{6}\s*-\s*/i);
    if (route) {
      candidate=body.slice(route[0].length).split(/\s*-\s*CBX\s+Internet/i)[0];
      const owner=compact(accountHolderName).replace(/[^\p{L}\p{N}]/gu,'');
      if(owner) {
        for(const separator of candidate.matchAll(/\s*-\s*/g)) {
          const segment=compact(candidate.slice(separator.index+separator[0].length).split(/\s*-\s*/)[0]).replace(/[^\p{L}\p{N}]/gu,'');
          let prefix=0;while(prefix<owner.length&&owner[prefix]===segment[prefix])prefix++;
          if(segment===owner || (Math.min(segment.length,owner.length)>=12 && prefix>=Math.min(14,segment.length,owner.length))) {candidate=candidate.slice(0,separator.index);break;}
        }
      }
      // A generic credit contains the account holder between party and UTR.
      // Preserve hyphens within the party; strip only an explicit trailing reference.
      candidate=candidate.replace(new RegExp(`\\s*-\\s*(?:(?:${BANK_CODES})[A-Z0-9]{10,}|IN\\d{10,}|CMS\\d{8,}).*$`,"i"),"");
      method="ifsc_transfer";
    }
  } else if (/^ADVANCE PAYMENT OF IMPORT BILL\s*-/i.test(text)) {
    candidate=text.split(/\s*-\s*/)[2];method="import_payment";
  } else if (/^(?:RTGS|NEFT)/i.test(text)) {
    candidate=text.replace(/^(?:RTGS|NEFT)\s*/i,"");
    const explicit=candidate.search(/\s*\/XUTR\//i);
    if(explicit>=0) candidate=candidate.slice(0,explicit);
    else {
      // Locate a bank UTR without assuming the party is separated by a space.
      const collapsed=candidate.replace(/\s/g,"");const ref=collapsed.match(bankTransfer);
      if(ref) {let offset=0,letters=0;while(offset<candidate.length && letters<ref.index) {if(!/\s/.test(candidate[offset]))letters++;offset++;}candidate=candidate.slice(0,offset);}
    }
    candidate=candidate.replace(/\s+CIF\s+ID\s*$/i,"");method="bank_transfer";
  } else if (/^(?:Credit\s+from|Receipt\s+from|Payment\s+to|Transfer\s+(?:to|from))\s+/i.test(text)) {
    candidate=text.replace(/^(?:Credit\s+from|Receipt\s+from|Payment\s+to|Transfer\s+(?:to|from))\s+/i,"");method="named_description";
  } else if (/^UPI[\s/:-]/i.test(text)) {
    const parts=text.split('/').map(clean);
    candidate=parts.find((p,i)=>i>0 && !/^(?:CR|DR|P2A|P2M)$/i.test(p) && !p.includes('@') && usableParty(p));method="upi_path";
  } else if (!/\d{4,}/.test(text) && text.length<=160 && !/^(?:payment|receipt|transfer|deposit|withdrawal|interest|charges?)(?:\s|$)/i.test(text)) candidate=text;
  const name=usableParty(candidate);
  return {name,method:name?method:"unclear_party",confidence:name?(method==="printed_text"?0.75:0.9):null};
}

export function enrichBankStatementTransactions(transactions, {physicalLayout=null,bankName="",accountHolderName="",printedReferenceKind=null}={}) {
  return transactions.map(row=> {
    const party=extractPotentialPartyName(row.description,{accountHolderName});
    const original=clean(row.reference_number)||null;
    const transfer=extractTransferReference(row.description);
    const pnb=physicalLayout==="pnb" || /Punjab National/i.test(bankName);
    const cheque=!pnb && printedReferenceKind==="cheque" ? original : null;
    return {...row,counterparty_name:row.counterparty_name||party.name,
      reference_number:original||transfer,
      transfer_reference:transfer,bank_transaction_id:pnb?original:null,cheque_number:cheque,
      raw_payload:{...row.raw_payload,sourcePrintedReference:original,
        extractedParty:{...party,source:"statement_narration",fullNameVerified:false},
        extractedReferences:{printedReference:original,transferReference:transfer,bankTransactionId:pnb?original:null,chequeNumber:cheque}}};
  });
}

export function validatePrintedStatementSummary(markdown,transactions,openingBalance=null,orientation="forward") {
  const lines=String(markdown||"").split(/\r?\n/), checks=[],issues=[];
  const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(clean);
  const number=value=>{const v=String(value||'').replace(/[,\s]/g,'');return /^-?\d+(?:\.\d+)?$/.test(v)?Number(v):null;};
  for(let i=0;i<lines.length;i++) {
    const heads=cells(lines[i]).map(h=>h.toLowerCase());
    if(!heads.includes('debit count')||!heads.includes('credit count'))continue;
    let j=i+1;while(j<lines.length&&(!lines[j].trim()||/^[|\s:-]+$/.test(lines[j])))j++;
    const values=cells(lines[j]||'');
    const closingBalance = transactions[orientation==='reverse'?0:transactions.length-1]?.balance_amount ?? null;
    for(const [name,actual] of [['debit count',transactions.filter(r=>r.debit_amount>0).length],['credit count',transactions.filter(r=>r.credit_amount>0).length],['total debit',transactions.reduce((n,r)=>n+(r.debit_amount||0),0)],['total credit',transactions.reduce((n,r)=>n+(r.credit_amount||0),0)],['opening balance',openingBalance],['closing balance',closingBalance]]) {
      const index=heads.indexOf(name),expected=index>=0?number(values[index]):null;
      if(expected===null||actual===null)continue;
      const ok=Math.abs(expected-actual)<0.01;checks.push({field:name,expected,actual,ok});if(!ok)issues.push(name);
    }
  }
  return {status:issues.length?'failed':checks.length?'verified':'unavailable',checks,issues};
}
