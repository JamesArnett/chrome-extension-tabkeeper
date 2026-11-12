import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSettingsImport, hasBroadMatch } from '../src/import-settings.js';

const closeRule = {
  id: 'existing', name: 'Imported close', enabled: true, title: null,
  url: { mode: 'startsWith', pattern: 'https://', caseSensitive: false },
  delaySeconds: 0, groupAfterSeconds: 0,
};

test('imports create disabled copies with a minimum delay and keep settings separate', () => {
  const input = { rules: [closeRule], groupRules: [{
    id: 'existing-group', name: 'Imported group', enabled: true, regex: 'example', titleTemplate: 'Example',
  }], closeSettings: { maxOpen: { enabled: true, value: 1, unit: 'minutes' }, neverClose: [] },
  awsSettings: { enabled: true }, settings: { maxTitleLength: 30 } };
  const plan = prepareSettingsImport(JSON.stringify(input));
  assert.equal(plan.rules[0].enabled, false);
  assert.equal(plan.rules[0].delaySeconds, 60);
  assert.notEqual(plan.rules[0].id, 'existing');
  assert.equal(plan.groupRules[0].enabled, false);
  assert.notEqual(plan.groupRules[0].id, 'existing-group');
  assert.equal(plan.closeSettings.maxOpen.enabled, true);
  assert.equal(plan.awsSettings.enabled, true);
  assert.equal(plan.maxTitleLength, 30);
  assert.equal(input.rules[0].delaySeconds, 0);
  assert.equal(hasBroadMatch(plan.rules[0]), true);
});

test('legacy arrays, duplicate IDs and invalid entries are handled without overwriting a rule', () => {
  const plan = prepareSettingsImport(JSON.stringify([closeRule, closeRule, { name: 'Invalid' }]));
  assert.equal(plan.rules.length, 2);
  assert.notEqual(plan.rules[0].id, plan.rules[1].id);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.closeSettings, null);
  assert.equal(prepareSettingsImport('{"settings":{"maxTitleLength":20}}').errors.length, 0);
  assert.throws(() => prepareSettingsImport('null'));
  assert.throws(() => prepareSettingsImport('not JSON'));
});

test('unsafe imported regexes are rejected across close, grouping, status and AWS settings', () => {
  const plan = prepareSettingsImport(JSON.stringify({
    rules: [{ ...closeRule, url: { mode: 'regex', pattern: '(a+)+$', caseSensitive: false } }],
    groupRules: [
      { regex: '(a|aa)+$', titleTemplate: 'Unsafe' },
      { regex: 'example', titleTemplate: 'Unsafe status', statusEnabled: true, siteOrigin: 'https://example.com', statusFields: [{ keepOnly: '(x+)+$' }] },
    ],
    awsSettings: { urlPattern: '(a+)+$' },
  }));
  assert.deepEqual(plan.rules, []);
  assert.deepEqual(plan.groupRules, []);
  assert.equal(plan.awsSettings, null);
  assert.equal(plan.errors.length, 4);
});
