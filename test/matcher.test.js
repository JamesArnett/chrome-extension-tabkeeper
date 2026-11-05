import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileCondition, compileRule, compileRules, ruleMatches, findMatchingRule } from '../src/matcher.js';

const cond = (mode, pattern, caseSensitive = false) => ({ mode, pattern, caseSensitive });

test('simple modes, case-insensitive by default', () => {
  assert.equal(compileCondition(cond('contains', 'zoom'))('Launch Meeting - Zoom'), true);
  assert.equal(compileCondition(cond('startsWith', 'launch'))('Launch Meeting - Zoom'), true);
  assert.equal(compileCondition(cond('endsWith', 'ZOOM'))('Launch Meeting - Zoom'), true);
  assert.equal(compileCondition(cond('equals', 'launch meeting - zoom'))('Launch Meeting - Zoom'), true);
  assert.equal(compileCondition(cond('contains', 'teams'))('Launch Meeting - Zoom'), false);
});

test('case-sensitive flag is honoured', () => {
  assert.equal(compileCondition(cond('contains', 'zoom', true))('Launch Meeting - Zoom'), false);
  assert.equal(compileCondition(cond('equals', 'Zoom', true))('Zoom'), true);
  assert.equal(compileCondition(cond('regex', '^zoom$', true))('Zoom'), false);
  assert.equal(compileCondition(cond('regex', '^zoom$', false))('Zoom'), true);
});

test('regex mode has no sticky state across calls', () => {
  const fn = compileCondition(cond('regex', 'a+'));
  assert.equal(fn('aaa'), true);
  assert.equal(fn('aaa'), true);
  assert.equal(fn('bbb'), false);
});

test('absent condition compiles to null; bad mode or regex throws', () => {
  assert.equal(compileCondition(null), null);
  assert.throws(() => compileCondition(cond('glob', '*')), /Unknown match mode/);
  assert.throws(() => compileCondition(cond('regex', '(')));
});

test('compileRule marks invalid rules and ruleMatches never matches them', () => {
  const broken = compileRule({ id: 'b', enabled: true, title: cond('regex', '('), url: null });
  assert.ok(broken.error);
  assert.equal(ruleMatches(broken, { title: '(', url: '' }), false);

  const empty = compileRule({ id: 'e', enabled: true, title: null, url: null });
  assert.match(empty.error, /no conditions/);
});

test('both conditions must match when both are set', () => {
  const c = compileRule({
    id: 'r',
    enabled: true,
    title: cond('contains', 'zoom'),
    url: cond('startsWith', 'https://us02web.zoom.us/'),
  });
  assert.equal(ruleMatches(c, { title: 'Zoom', url: 'https://us02web.zoom.us/j/123' }), true);
  assert.equal(ruleMatches(c, { title: 'Zoom', url: 'https://example.com' }), false);
  assert.equal(ruleMatches(c, { title: 'Other', url: 'https://us02web.zoom.us/j/123' }), false);
});

test('ruleMatches tolerates missing title/url', () => {
  const c = compileRule({ id: 'r', enabled: true, title: cond('equals', ''), url: null });
  // equals '' against missing title -> '' === '' is true, but such a rule fails validation anyway.
  assert.equal(ruleMatches(c, {}), true);
  const d = compileRule({ id: 'r', enabled: true, title: cond('contains', 'x'), url: null });
  assert.equal(ruleMatches(d, { url: 'x' }), false);
});

test('findMatchingRule returns the first enabled match in order and skips disabled rules', () => {
  const rules = compileRules([
    { id: 'disabled', enabled: false, title: cond('contains', 'zoom'), url: null },
    { id: 'first', enabled: true, title: cond('contains', 'zoom'), url: null },
    { id: 'second', enabled: true, title: cond('contains', 'meeting'), url: null },
  ]);
  assert.equal(findMatchingRule(rules, { title: 'Zoom Meeting', url: '' }).id, 'first');
  assert.equal(findMatchingRule(rules, { title: 'Teams Meeting', url: '' }).id, 'second');
  assert.equal(findMatchingRule(rules, { title: 'Nothing', url: '' }), null);
});
