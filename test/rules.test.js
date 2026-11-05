import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCondition,
  validateRule,
  normalizeRule,
  importRules,
  exportRules,
  summarizeRule,
  suggestFieldsFromTab,
  MAX_PATTERN_LENGTH,
  MAX_NAME_LENGTH,
  MAX_DELAY_SECONDS,
} from '../src/rules.js';

const base = () => ({
  id: 'r1',
  name: 'Zoom',
  enabled: true,
  title: { mode: 'contains', pattern: 'Zoom', caseSensitive: false },
  url: null,
  delaySeconds: 5,
  groupAfterSeconds: 0,
  createdAt: 1,
});

test('validateCondition accepts absent conditions', () => {
  assert.equal(validateCondition(null), null);
  assert.equal(validateCondition(undefined), null);
});

test('validateCondition rejects bad modes, empty and oversized patterns', () => {
  assert.match(validateCondition({ mode: 'glob', pattern: 'x', caseSensitive: false }), /Unknown match mode/);
  assert.match(validateCondition({ mode: 'contains', pattern: '', caseSensitive: false }), /required/);
  assert.match(
    validateCondition({ mode: 'contains', pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1), caseSensitive: false }),
    /characters or fewer/,
  );
});

test('validateCondition reports invalid regex', () => {
  assert.match(validateCondition({ mode: 'regex', pattern: '(', caseSensitive: false }), /Invalid regex/);
  assert.equal(validateCondition({ mode: 'regex', pattern: '^https://.*zoom', caseSensitive: false }), null);
});

test('validateRule passes a well-formed rule', () => {
  assert.deepEqual(validateRule(base()), { valid: true, errors: {} });
});

test('validateRule requires a name and at least one condition', () => {
  const r = base();
  r.name = '  ';
  r.title = null;
  const { valid, errors } = validateRule(r);
  assert.equal(valid, false);
  assert.ok(errors.name);
  assert.ok(errors.conditions);
});

test('validateRule bounds the delay', () => {
  for (const bad of [-1, 1.5, MAX_DELAY_SECONDS + 1, '5', NaN]) {
    const r = base();
    r.delaySeconds = bad;
    assert.equal(validateRule(r).valid, false, `delay ${bad} should fail`);
  }
  for (const ok of [0, 1, MAX_DELAY_SECONDS]) {
    const r = base();
    r.delaySeconds = ok;
    assert.equal(validateRule(r).valid, true, `delay ${ok} should pass`);
  }
});

test('normalizeRule fills defaults and coerces form values', () => {
  const r = normalizeRule({
    name: '  AWS  ',
    url: { mode: 'startsWith', pattern: 'https://signin.aws', caseSensitive: 'yes' },
    title: { mode: 'contains', pattern: '' },
    delaySeconds: '12',
  });
  assert.ok(r.id);
  assert.equal(r.name, 'AWS');
  assert.equal(r.enabled, true);
  assert.equal(r.title, null, 'empty pattern becomes no condition');
  assert.deepEqual(r.url, { mode: 'startsWith', pattern: 'https://signin.aws', caseSensitive: true });
  assert.equal(r.delaySeconds, 12);
  assert.ok(Number.isFinite(r.createdAt));
});

test('normalizeRule turns non-numeric delay strings into NaN so validation fails', () => {
  assert.ok(Number.isNaN(normalizeRule({ delaySeconds: 'abc' }).delaySeconds));
  assert.ok(Number.isNaN(normalizeRule({ delaySeconds: '1.5' }).delaySeconds));
  assert.equal(normalizeRule({ delaySeconds: '' }).delaySeconds, 60);
});

test('export then import round-trips valid rules', () => {
  const rules = [base(), { ...base(), id: 'r2', name: 'Two', title: null, url: { mode: 'regex', pattern: 'aws', caseSensitive: false } }];
  const { rules: imported, errors } = importRules(exportRules(rules));
  assert.deepEqual(errors, []);
  assert.deepEqual(imported, rules);
});

test('importRules accepts a bare array and reports invalid entries individually', () => {
  const text = JSON.stringify([base(), { name: 'Broken', title: { mode: 'regex', pattern: '[' } }, { id: 'x' }]);
  const { rules, errors } = importRules(text);
  assert.equal(rules.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Rule 2 \("Broken"\): Invalid regex/);
  assert.match(errors[1], /Rule 3:/);
});

test('importRules rejects non-JSON and wrong shapes', () => {
  assert.deepEqual(importRules('nope').errors, ['Not valid JSON']);
  assert.equal(importRules('{"foo":1}').errors.length, 1);
});

test('summarizeRule describes both conditions', () => {
  const r = base();
  r.url = { mode: 'regex', pattern: '^https://x', caseSensitive: true };
  assert.equal(summarizeRule(r), 'title contains "Zoom" and URL matches regex "^https://x" (case-sensitive)');
});

test('suggestFieldsFromTab uses the title and the site origin only', () => {
  const fields = suggestFieldsFromTab({
    title: '  Launch Meeting - Zoom ',
    url: 'https://us02web.zoom.us/j/123456789?pwd=abc#frag',
  });
  assert.deepEqual(fields, {
    name: 'Launch Meeting - Zoom',
    titleMode: 'contains',
    titlePattern: 'Launch Meeting - Zoom',
    titleCase: false,
    urlMode: 'startsWith',
    urlPattern: 'https://us02web.zoom.us/',
    urlCase: false,
    delay: '60',
    groupAfter: '0',
  });
});

test('suggestFieldsFromTab ignores non-http URLs and falls back to the origin for a name', () => {
  assert.equal(suggestFieldsFromTab({ title: 'Payload', url: 'data:text/html,<title>Payload</title>' }).urlPattern, '');
  assert.equal(suggestFieldsFromTab({ title: 'Extensions', url: 'chrome://extensions/' }).urlPattern, '');
  const untitled = suggestFieldsFromTab({ title: '', url: 'https://signin.aws.amazon.com/oauth?x=1' });
  assert.equal(untitled.name, 'https://signin.aws.amazon.com/');
  assert.equal(untitled.titlePattern, '');
});

test('suggestFieldsFromTab returns null when there is nothing usable and caps lengths', () => {
  assert.equal(suggestFieldsFromTab(null), null);
  assert.equal(suggestFieldsFromTab({ title: '', url: 'about:blank' }), null);
  assert.equal(suggestFieldsFromTab({ title: '   ', url: 'chrome://newtab/' }), null);
  const long = suggestFieldsFromTab({ title: 'x'.repeat(1000), url: 'https://a.example/' });
  assert.equal(long.name.length, MAX_NAME_LENGTH);
  assert.equal(long.titlePattern.length, MAX_PATTERN_LENGTH);
});

test('groupAfterSeconds: optional for old rules, coerced from forms, bounded', () => {
  const legacy = { ...base() };
  delete legacy.groupAfterSeconds;
  assert.equal(validateRule(legacy).valid, true, 'rules saved before the field existed stay valid');
  assert.equal(normalizeRule({ ...base(), groupAfterSeconds: '10' }).groupAfterSeconds, 10);
  assert.equal(normalizeRule({ ...base(), groupAfterSeconds: '' }).groupAfterSeconds, 0);
  assert.equal(validateRule({ ...base(), groupAfterSeconds: -1 }).valid, false);
  assert.equal(validateRule({ ...base(), groupAfterSeconds: 2.5 }).valid, false);
  assert.equal(validateRule({ ...base(), groupAfterSeconds: 30 }).valid, true);
});

test('new close rules default to a 60 second delay', async () => {
  const { newRule, DEFAULT_DELAY_SECONDS } = await import('../src/rules.js');
  assert.equal(DEFAULT_DELAY_SECONDS, 60);
  assert.equal(newRule().delaySeconds, 60);
  assert.equal(normalizeRule({ delaySeconds: 5 }).delaySeconds, 5, 'existing rules keep their own delay');
});
