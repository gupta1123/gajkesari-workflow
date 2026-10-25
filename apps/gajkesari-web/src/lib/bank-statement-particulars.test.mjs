import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../components/bank-statements/BankStatementsPage.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=new Set(['getTransactionPartyTitle','getTransactionMode','formatDataLabel']);
const declarations=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.has(n.name?.text)).map(n=>n.getText(ast)).join('\n');
const scope={};vm.createContext(scope);
vm.runInContext(ts.transpileModule(declarations+'\nthis.title=getTransactionPartyTitle;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,scope);
const row={counterpartyName:'',transactionType:'neft',category:'receipt',description:'NEFT-IN/SWASTIK BUILD MART',selectedLedgerName:'Another company',suggestedLedgerName:'Suggested company'};
test('Particulars preserves an extracted short name independently of changing Tally ledgers',()=>{
 assert.equal(scope.title({...row,counterpartyName:'SWASTIK BUILD MA'}),'SWASTIK BUILD MA');
 assert.equal(scope.title({...row,counterpartyName:'SWASTIK BUILD MA',selectedLedgerName:'Changed ledger'}),'SWASTIK BUILD MA');
});
test('missing extracted party shows the bank narration rather than a selected or suggested ledger',()=>{
 assert.equal(scope.title(row),row.description);
 assert.equal(scope.title({...row,selectedLedgerName:'New selection'}),row.description);
});
test('unnamed interest is not described as a credit when it may be a payment',()=>{
 assert.equal(scope.title({...row,transactionType:'unknown',category:'payment',description:'AUTO INTEREST PAYMENT ON TERM LOAN'}),'Interest');
});
