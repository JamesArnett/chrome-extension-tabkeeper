import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStatusCore, el, fakeDoc } from './helpers/status-core.js';

const core = loadStatusCore();

test('splitSelectorList respects quotes, parentheses and brackets', () => {
  assert.deepEqual(core.splitSelectorList('a, b , c'), ['a', 'b', 'c']);
  assert.deepEqual(core.splitSelectorList(':is(a, b) .x, [data-x="1,2"] span, .y'), [':is(a, b) .x', '[data-x="1,2"] span', '.y']);
  assert.deepEqual(core.splitSelectorList("[title='a,b'], c"), ["[title='a,b']", 'c']);
  assert.deepEqual(core.splitSelectorList(''), []);
  assert.deepEqual(core.splitSelectorList(' ,, a ,'), ['a']);
});

test('textOf: select option text, input value, textContent, whitespace collapsed', () => {
  const opt = el('option', {}, { text: '  In \n Progress ', selected: true });
  const select = el('select', {}, { value: 'ip', children: [el('option', {}, { text: 'Open' }), opt] });
  assert.equal(core.textOf(select), 'In Progress');
  const emptySelect = el('select', {}, { value: 'fallback', children: [el('option', {}, { text: '', selected: true })] });
  assert.equal(core.textOf(emptySelect), 'fallback');
  assert.equal(core.textOf(el('input', {}, { value: ' Active ' })), 'Active');
  assert.equal(core.textOf(el('textarea', {}, { value: 'a  b' })), 'a b');
  assert.equal(core.textOf(el('span', {}, { text: ' Done\t' })), 'Done');
  assert.equal(core.textOf(el('span', {}, { text: '   ' })), '');
});

test('applyKeepOnly: capture kept, whole match without group, no match, empty capture, bad regex', () => {
  assert.deepEqual(core.applyKeepOnly('Pipeline #18395789 passed', '#\\d+\\s+(\\S+)'), { value: 'passed', error: null });
  assert.deepEqual(core.applyKeepOnly('Status: Done', 'done'), { value: 'Done', error: null });
  assert.deepEqual(core.applyKeepOnly('Status: Done', 'open'), { value: '', error: 'keep-no-match' });
  assert.deepEqual(core.applyKeepOnly('Done', '(x)?Done'), { value: '', error: 'keep-empty' });
  assert.deepEqual(core.applyKeepOnly('Done', '('), { value: '', error: 'invalid-keep-regex' });
  assert.deepEqual(core.applyKeepOnly('Done', ''), { value: 'Done', error: null });
});

test('describeElement prefers id, data-testid, aria-label, then classes; two identifiable ancestors', () => {
  const button = el('button', { 'data-testid': 'status-btn', class: 'a b c' }, { text: 'Open' });
  const inner = el('div', {}, { children: [button] }); // unidentifiable, skipped
  const form = el('form', { class: 'issue   view' }, { children: [inner] });
  const status = el('div', { id: 'status' }, { children: [form] });
  const page = el('section', { 'aria-label': 'Page' }, { children: [status] });
  el('body', {}, { children: [page] });
  assert.equal(core.describeElement(button), 'button[data-testid="status-btn"] (inside form.issue.view › div#status)');
  assert.equal(core.describeElement(el('span', { class: 'x' })), 'span.x');
  assert.equal(core.describeElement(el('i', {})), 'i');
});

test('readField: alternatives tried in written order, not page order', () => {
  const doc = fakeDoc({
    '.badge': [el('span', { class: 'badge' }, { text: 'Beta' })],
    '[data-testid="state"]': [el('span', { 'data-testid': 'state' }, { text: 'Merged' })],
  });
  const r = core.readField(doc, { selector: '[data-testid="state"], .badge' });
  assert.equal(r.value, 'Merged');
  assert.equal(r.element, 'span[data-testid="state"]');
  assert.equal(r.matched, 1);
  const generic = core.readField(doc, { selector: '.badge, [data-testid="state"]' });
  assert.equal(generic.value, 'Beta', 'written order is honoured even when it is the wrong choice');
});

test('readField: invalid alternatives skipped; error codes', () => {
  const doc = fakeDoc({
    '.wrapper': [el('div', { class: 'wrapper' }, { text: '  ' }), el('div', { class: 'wrapper' }, { text: '' })],
    '.good': [el('b', {}, { text: 'OK' })],
  });
  assert.equal(core.readField(doc, { selector: '.bad!!, .good' }).value, 'OK');
  assert.equal(core.readField(doc, { selector: '.bad!!, .worse!!' }).error, 'invalid-selector');
  const noText = core.readField(doc, { selector: '.wrapper' });
  assert.equal(noText.error, 'matched-no-text');
  assert.equal(noText.matched, 2);
  assert.equal(core.readField(doc, { selector: '.nope' }).error, 'matched-nothing');
  const keep = core.readField(doc, { selector: '.good', keepOnly: 'zzz' });
  assert.equal(keep.error, 'keep-no-match');
  assert.equal(keep.raw, 'OK');
});

test('readField uses the default Jira selector for a blank selector', () => {
  const doc = fakeDoc({ '#status-val': [el('span', { id: 'status-val' }, { text: 'To Do' })] });
  assert.equal(core.readField(doc, { selector: '' }).value, 'To Do');
});

test('readFields aggregates counts and joinValues labels values', () => {
  const doc = fakeDoc({
    '.state': [el('span', {}, { text: 'Open' })],
    '.pipe': [el('span', {}, { text: 'Pipeline #1 passed' })],
    '.missing': [],
  });
  const fields = [{ selector: '.state' }, { selector: '.pipe', keepOnly: '#\\d+\\s+(\\S+)', label: 'CI' }, { selector: '.missing', label: 'X' }];
  const r = core.readFields(doc, fields);
  assert.equal(r.valueCount, 2);
  assert.equal(r.matchedTotal, 2);
  assert.equal(r.complete, false);
  assert.equal(core.joinValues(fields, r.results), 'Open · CI passed');
});

test('pickMatching: first element whose text satisfies keep-only wins, not the first with text', () => {
  const doc = fakeDoc({
    '#nav span': [
      el('span', {}, { text: 'Services' }),
      el('span', { 'data-testid': 'account-label' }, { text: 'Acme Dev (123456789012)' }),
      el('span', { class: 'globalNav-2246' }, { text: 'AdminRole/jane' }),
    ],
  });
  const r = core.readField(doc, { selector: '#nav span', keepOnly: '^([A-Za-z0-9+=,.@_-]+)/[A-Za-z0-9+=,.@_-]+$', pickMatching: true });
  assert.equal(r.value, 'AdminRole');
  assert.equal(r.raw, 'AdminRole/jane');
  assert.equal(r.element, 'span.globalNav-2246');
  assert.equal(r.matched, 3);

  const none = core.readField(doc, { selector: '#nav span', keepOnly: '^role:(\\w+)$', pickMatching: true });
  assert.equal(none.error, 'keep-no-match');
  assert.equal(none.raw, 'Services', 'reports the first text so the user sees what was there');

  const plain = core.readField(doc, { selector: '#nav span', keepOnly: '^([A-Za-z0-9+=,.@_-]+)/[A-Za-z0-9+=,.@_-]+$' });
  assert.equal(plain.error, 'keep-no-match', 'without pickMatching the first text is used and fails');
});
