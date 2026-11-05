import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTitle, parseTitle, normalizeStatus, composeStatus, clampLimit, ELLIPSIS } from '../src/titles.js';

test('clampLimit: 0 means none, 1..11 raised to 12, others floored', () => {
  assert.equal(clampLimit(0), 0);
  assert.equal(clampLimit(-5), 0);
  assert.equal(clampLimit('abc'), 0);
  assert.equal(clampLimit(1), 12);
  assert.equal(clampLimit(11), 12);
  assert.equal(clampLimit(12), 12);
  assert.equal(clampLimit(32.9), 32);
});

test('buildTitle: spec examples', () => {
  const base = 'perimeterx-lambda-at-edge pipeline #18395616';
  assert.equal(buildTitle(base, 'Blocked', 0), 'perimeterx-lambda-at-edge pipeline #18395616 - Blocked');
  assert.equal(buildTitle(base, 'Blocked', 32), 'perimeterx-lambda-at-… - Blocked');
  assert.equal(buildTitle(base, 'Blocked', 20), 'perimeter… - Blocked');
});

test('buildTitle: no status, under limit, base never below 8, status never cut, trailing space trimmed', () => {
  assert.equal(buildTitle('ABC-123', '', 0), 'ABC-123');
  assert.equal(buildTitle('ABC-123', null, 12), 'ABC-123');
  assert.equal(buildTitle('ABC-123', 'In Progress', 100), 'ABC-123 - In Progress');
  // limit 12 with a long status: base kept at 8 chars even though the result exceeds 12
  assert.equal(buildTitle('INC0010042-extra', 'In Progress', 12), 'INC00100… - In Progress');
  // base shorter than 8 never gets cut at all
  assert.equal(buildTitle('ABC-123', 'A very long status indeed', 12), 'ABC-123 - A very long status indeed');
  // trailing whitespace trimmed before the ellipsis
  assert.equal(buildTitle('abcdefg hijkl mno', 'X', 12), `abcdefg${ELLIPSIS} - X`);
  // limit under 12 is raised to 12
  assert.equal(buildTitle('abcdefghijklmnop', '', 5), 'abcdefghijk…');
});

test('normalizeStatus collapses whitespace and caps at 80', () => {
  assert.equal(normalizeStatus('  In \n Progress  '), 'In Progress');
  const long = 'x'.repeat(200);
  const capped = normalizeStatus(long);
  assert.equal(capped.length, 80);
  assert.ok(capped.endsWith(ELLIPSIS));
  assert.equal(normalizeStatus('y'.repeat(80)).length, 80);
  assert.equal(normalizeStatus(null), '');
});

test('composeStatus joins labelled values and omits empty fields', () => {
  const fields = [{ label: '' }, { label: 'CI' }, { label: 'X' }];
  assert.equal(composeStatus(fields, ['Open', 'passed', '']), 'Open · CI passed');
  assert.equal(composeStatus(fields, ['', '', '']), '');
  assert.equal(composeStatus(fields, [null, 'failed']), 'CI failed');
});

test('parseTitle: exact always; status form only with status enabled', () => {
  assert.deepEqual(parseTitle('ABC-123', 'ABC-123'), { status: null, shortened: false });
  assert.equal(parseTitle('ABC-123 - Done', 'ABC-123'), null);
  assert.deepEqual(parseTitle('ABC-123 - Done', 'ABC-123', { statusEnabled: true }), { status: 'Done', shortened: false });
  assert.equal(parseTitle('ABC-1234', 'ABC-123', { statusEnabled: true }), null);
  assert.equal(parseTitle('GitHub - Docs', 'GitHub'), null, 'fixed rule without status must not adopt a hand-made group');
});

test('parseTitle: shortened forms only with a limit on, head >= 3, base starts with head', () => {
  assert.equal(parseTitle('perimeter…', 'perimeterx-lambda'), null, 'no limit');
  assert.deepEqual(parseTitle('perimeter…', 'perimeterx-lambda', { limit: 20 }), { status: null, shortened: true });
  assert.deepEqual(parseTitle('perimeter… - Blocked', 'perimeterx-lambda', { limit: 20, statusEnabled: true }), {
    status: 'Blocked',
    shortened: true,
  });
  assert.equal(parseTitle('perimeter… - Blocked', 'perimeterx-lambda', { limit: 20 }), null, 'status form needs status enabled');
  assert.equal(parseTitle('pe…', 'perimeterx', { limit: 20 }), null, 'head too short');
  assert.equal(parseTitle('xyz…', 'perimeterx', { limit: 20 }), null, 'base does not start with head');
  assert.equal(parseTitle('perimeterx…', 'perimeterx', { limit: 20 }), null, 'head must be shorter than base');
});
