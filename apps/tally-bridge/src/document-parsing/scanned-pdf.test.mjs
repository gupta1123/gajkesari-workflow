import test from 'node:test';
import assert from 'node:assert/strict';
import {ocrWordsToPdfItems,validateOcrPhysicalRows} from './scanned-pdf.mjs';
test('OCR joins split dates and monetary cells, preserving word order without expanding names',()=>{
 const word=(text,x,y,width=20,height=10)=>({text,x,y,width,height});
 const lines=[{words:[word('24/1',20,100),word('0/2026',40,100,30),word('ACME',100,101,30),word('AND',135,100),word('SONS',160,100,30),word('1',300,100,5),word('150.00',305,100,30)]}];
 const items=ocrWordsToPdfItems(lines,1,800);
 assert.deepEqual(items.map(i=>i.str),['24/10/2026','ACME','AND','SONS','1150.00']);
 assert.equal(new Set(items.map(i=>i.transform[5])).size,1);
});
test('OCR merges table headings without merging distant transaction columns',()=>{
 const word=(text,x,width=30)=>({text,x,y:100,width,height:10});
 const items=ocrWordsToPdfItems([{words:[word('Txn',20,15),word('Date',40,20),word('Dr',300,15),word('Amount',320,35),word('100',450),word('200.00',550)]}],1,800);
 assert.deepEqual(items.map(i=>i.str),['Txn Date','Dr Amount','100','200.00']);
});
test('OCR with no usable rows or a corrupted nonnumeric reference requires a clearer source',()=>{
 assert.throws(()=>validateOcrPhysicalRows({detected:true,rows:[]}),{code:'ocr_review_required'});
 assert.throws(()=>validateOcrPhysicalRows({detected:true,rows:[{reference:'REFOOOI'}]}),{code:'ocr_review_required'});
 assert.doesNotThrow(()=>validateOcrPhysicalRows({detected:true,rows:[{reference:'0012345'},{reference:''}]}));
});
