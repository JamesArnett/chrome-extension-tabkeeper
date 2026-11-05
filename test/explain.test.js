import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainClose } from '../src/explain.js';
import { normalizeCloseSettings } from '../src/age-closer.js';

const rules = [
  { id: 'okta', name: 'Okta login', enabled: true, title: { mode: 'contains', pattern: 'okta', caseSensitive: false }, url: null, delaySeconds: 30, groupAfterSeconds: 5 },
  { id: 'zoom', name: 'Zoom', enabled: true, title: { mode: 'contains', pattern: 'zoom', caseSensitive: false }, url: null, delaySeconds: 5, groupAfterSeconds: 0 },
  { id: 'quiet', name: 'Quiet', enabled: true, title: { mode: 'contains', pattern: 'quiet', caseSensitive: false }, url: null, delaySeconds: 5, groupAfterSeconds: 5 },
  { id: 'off', name: 'Off', enabled: false, title: { mode: 'contains', pattern: 'zoom', caseSensitive: false }, url: null, delaySeconds: 1 },
];

test('explainClose: matching rule with grace, immediate grouping, and never-grouped variants', () => {
  const a = explainClose({ id: 1, title: 'Okta sign in', url: 'https://x' }, { rules });
  assert.equal(a.rule.id, 'okta');
  assert.equal(a.level, 'close');
  assert.match(a.lines[0], /closes 30 s after it matched, and moves to the Closing group after 5 s/);
  assert.match(explainClose({ id: 1, title: 'zoom' }, { rules }).lines[0], /straight away/);
  assert.match(explainClose({ id: 1, title: 'quiet' }, { rules }).lines[0], /without being moved/);
});

test('explainClose: no match, pinned, kept rule', () => {
  const none = explainClose({ id: 1, title: 'nothing' }, { rules });
  assert.equal(none.rule, null);
  assert.equal(none.level, 'none');
  assert.equal(none.lines[0], 'No close rule matches this tab.');
  assert.equal(explainClose({ id: 1, title: 'zoom', pinned: true }, { rules }).lines[0], 'Close rules skip pinned tabs.');
  const kept = explainClose({ id: 1, title: 'zoom' }, { rules, keptRuleIds: ['zoom'] });
  assert.equal(kept.rule, null, 'kept rule is skipped');
  assert.equal(kept.keptRules[0].id, 'zoom');
  assert.match(kept.lines[1], /pressed Keep/);
});

test('explainClose: age-based closing off, applies, or exempt', () => {
  const off = explainClose({ id: 1, title: 'x' }, { rules: [], closeSettings: normalizeCloseSettings({}) });
  assert.equal(off.lines.at(-1), 'Age-based closing is off.');
  const on = normalizeCloseSettings({ maxOpen: { enabled: true, value: 8, unit: 'hours' }, maxIdle: { enabled: true, value: 2, unit: 'days' }, neverClose: ['mail'] });
  const applies = explainClose({ id: 1, title: 'x', url: 'https://y' }, { rules: [], closeSettings: on });
  assert.equal(applies.level, 'quiet');
  assert.match(applies.lines.at(-1), /open longer than 8 hours or not used for 2 days/);
  assert.match(explainClose({ id: 1, title: 'x', url: 'https://mail.example' }, { rules: [], closeSettings: on }).lines.at(-1), /never-close list/);
  assert.match(explainClose({ id: 1, title: 'x', audible: true }, { rules: [], closeSettings: on }).lines.at(-1), /playing audio/);
  assert.match(explainClose({ id: 1, title: 'x' }, { rules: [], closeSettings: on, isPendingClose: () => true }).lines.at(-1), /already counting down/);
});
