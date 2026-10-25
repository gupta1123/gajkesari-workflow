import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../components/bank-statements/BankStatementsPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
const buttons = [];
function visit(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name) {
    declarations.set(node.name.getText(ast), node);
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Button') buttons.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
const names = ['billAllocationReviewTransactions', 'billAllocationReviewIndex', 'billAllocationReviewHasNext',
  'openAdjacentBillAllocation', 'completeBillAllocationReview', 'closeBillAllocationReview'];
const code = ts.transpileModule(names.map(name => {
  const node = declarations.get(name);
  assert.ok(node, `Missing ${name}`);
  return ts.isVariableDeclaration(node) ? `const ${node.getText(ast)};` : node.getText(ast);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const row = id => ({ id });
function review({ rows = ['a', 'bank-charge', 'b'], eligible = ['a', 'b'], active = 'a',
  draft = { requiresUserReview: false, unallocatedAmount: 0 }, pageSize = 50 } = {}) {
  const allocations = { [active]: draft, b: { requiresUserReview: false, unallocatedAmount: 0, allocations: ['invoice-b'] } };
  const state = { drawerId: active, selectedId: active, page: 1, stage: 'posting' };
  const scrolls = [];
  const context = {
    useMemo: compute => compute(), partyBillAllocationReviewTransactions: eligible.map(row),
    filteredTransactionIndexById: new Map(rows.map((id, index) => [id, index])),
    billAllocationReviewTransactionId: active, billAllocationReviewTransaction: row(active),
    billAllocationReviewDraft: draft, billAllocationsByTransactionId: allocations, rowsPerPage: pageSize,
    selectReviewTransaction: id => { state.selectedId = id; state.stage = 'ledger'; },
    setReviewActionStage: stage => { state.stage = stage; },
    setBillAllocationReviewTransactionId: id => { state.drawerId = id; },
    setReviewPage: update => { state.page = update(state.page); },
    scrollReviewTransactionIntoView: id => scrolls.push(id), showToast: () => {},
  };
  const handlers = new Function(...Object.keys(context), `${code}; return {
    completeBillAllocationReview, openAdjacentBillAllocation, hasNext: billAllocationReviewHasNext
  };`)(...Object.values(context));
  return { ...handlers, state, scrolls, allocations };
}

test('Done and next keeps the drawer open on the next allocation and retains saved drafts', () => {
  const current = review();
  const before = structuredClone(current.allocations);
  assert.equal(current.hasNext, true);
  current.completeBillAllocationReview();
  assert.deepEqual(current.state, { drawerId: 'b', selectedId: 'b', page: 1, stage: 'posting' });
  assert.deepEqual(current.allocations, before);
  assert.deepEqual(current.scrolls, ['b']);
});

test('navigation skips filtered-out allocation rows and entries without bill allocation', () => {
  const current = review({ rows: ['a', 'bank-charge', 'c'], eligible: ['a', 'b', 'c'] });
  current.completeBillAllocationReview();
  assert.equal(current.state.drawerId, 'c');
});

test('editing a row out of the active filter still advances from its original position', () => {
  const current = review({ rows: ['b'], eligible: ['a', 'b'] });
  current.completeBillAllocationReview();
  assert.equal(current.state.drawerId, 'b');
});

test('advancing across a table page selects and scrolls to the next allocation', () => {
  const current = review({ pageSize: 2 });
  current.completeBillAllocationReview();
  assert.equal(current.state.page, 2);
  assert.equal(current.state.selectedId, 'b');
  assert.deepEqual(current.scrolls, ['b']);
});

test('the last allocation shows Done and closes even when other table rows follow', () => {
  const current = review({ rows: ['a', 'bank-charge'], eligible: ['a'] });
  assert.equal(current.hasNext, false);
  current.completeBillAllocationReview();
  assert.equal(current.state.drawerId, null);
  assert.equal(current.state.selectedId, 'a');
});

test('missing, incomplete and unreviewed allocations do not advance or close', () => {
  for (const draft of [null, { requiresUserReview: true, unallocatedAmount: 0 },
    { requiresUserReview: false, unallocatedAmount: 10 },
    { requiresUserReview: false, unallocatedAmount: -10 }]) {
    const current = review({ draft });
    current.completeBillAllocationReview();
    assert.equal(current.state.drawerId, 'a');
    assert.deepEqual(current.scrolls, []);
  }
});

test('header navigation selects the same allocation sequence in both directions', () => {
  const current = review({ rows: ['a', 'bank-charge', 'b'], active: 'b' });
  current.openAdjacentBillAllocation(-1);
  assert.equal(current.state.drawerId, 'a');
  assert.equal(current.state.selectedId, 'a');
  assert.equal(current.state.stage, 'posting');
});

test('the allocation footer invokes allocation navigation and labels the next eligible entry', () => {
  const button = buttons.find(node => node.openingElement.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'onClick' &&
    attribute.initializer?.getText(ast) === '{completeBillAllocationReview}'));
  assert.ok(button, 'allocation completion must use its own navigation handler');
  assert.match(button.getText(ast), /billAllocationReviewHasNext\s*\? "Done & next"\s*: "Done"/);
});
