import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../components/bank-statements/BankStatementsPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function descendants(node) {
  const nodes = [];
  (function visit(current) { nodes.push(current); ts.forEachChild(current, visit); })(node);
  return nodes;
}
const nodes = descendants(ast);
const picker = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
const opening = node => ts.isJsxElement(node) ? node.openingElement : node;
const element = (scope, tag, marker) => descendants(scope).find(n =>
  (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && opening(n).tagName.getText(ast) === tag &&
  opening(n).attributes.getText(ast).includes(marker));
function handler(node, name, context) {
  const attr = opening(node).attributes.properties.find(a => a.name?.getText(ast) === name);
  assert.ok(attr?.initializer?.expression, `${name} handler must exist`);
  const code = ts.transpileModule(`const handler = ${attr.initializer.expression.getText(ast)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(context), `${code}; return handler;`)(...Object.values(context));
}
class Element {
  constructor(toggle = false) { this.toggle = toggle; }
  closest(selector) { return this.toggle && selector.includes('data-ledger-editor-toggle') ? this : null; }
}
const transactionInput = element(picker('LedgerReviewSelect'), 'input', 'Search or choose transaction ledger');

test('moving focus to the close or switch toggle leaves dismissal to its click handler', () => {
  let cancellations = 0;
  const blur = handler(transactionInput, 'onBlur', {
    Node: Element, Element, rootRef: { current: { contains: () => false } },
    popoverRef: { current: { contains: () => false } },
    setOpen: () => {}, onCancel: () => cancellations++,
  });
  blur({ relatedTarget: new Element(true) });
  assert.equal(cancellations, 0, 'blur must not remove the editor before the toggle click');
  blur({ relatedTarget: new Element() });
  assert.equal(cancellations, 1, 'leaving the editor still dismisses it');
});

test('close click never reopens an editor even if a prior dismissal already cleared its state', () => {
  const button = nodes.find(n => ts.isJsxElement(n) &&
    n.openingElement.attributes.getText(ast).includes('data-ledger-editor-toggle'));
  let editing = new Set();
  handler(button, 'onClick', {
    isEditingLedger: true, transaction: { id: 'one' }, setReviewActionStage: () => {},
    setEditingLedgerIds: update => { editing = update(editing); },
  })();
  assert.equal(editing.size, 0);
});

test('clicking an SVG inside a table button never invokes the row action', () => {
  const row = element(ast, 'tr', 'selectReviewTransaction');
  const svg = new Element();
  svg.closest = () => ({});
  let actions = 0;
  handler(row, 'onClick', {
    Element, reviewActionStage: 'ledger', statementReviewLocked: false, transaction: { id: 'one' },
    setEditingLedgerIds: () => actions++, openPostingReviewAction: () => actions++,
  })({ target: svg });
  assert.equal(actions, 0);
});

test('Escape in either ledger picker is consumed before it reaches page shortcuts', () => {
  for (const input of [transactionInput, element(picker('LedgerSearchSelect'), 'input', 'bank-ledger-listbox')]) {
    let stopped = false;
    let closed = false;
    handler(input, 'onKeyDown', {
      setOpen: value => { closed = value === false; }, setQuery: () => {},
      setHasSearchStarted: () => {}, onCancel: () => {},
    })({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => { stopped = true; } });
    assert.equal(closed, true);
    assert.equal(stopped, true);
  }
});

test('portal menu clicks stop before reaching transaction row handlers', () => {
  const menu = element(picker('LedgerReviewSelect'), 'div', 'transaction-ledger-listbox');
  let stopped = false;
  handler(menu, 'onClick', {})({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
});
