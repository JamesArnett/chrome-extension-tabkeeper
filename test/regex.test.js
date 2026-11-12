import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRegex, MAX_REGEX_INPUT } from '../src/regex.js';
import { compileRule, ruleMatches } from '../src/matcher.js';
import { compileGroupRules, matchGroupRules, validateGroupRule, normalizeGroupRule } from '../src/group-rules.js';
import { compileAwsPattern, defaultAwsSettings, isAwsConsoleUrl } from '../src/aws.js';
import { PRESETS } from '../src/presets.js';

test('regex checks reject risky repetition and backreferences before matching', () => {
  for (const pattern of ['(a+)+$', '(?:x|xx)*$', '((a+))+$', '(a?){2,}', '(a)\\1', '(?<x>a)\\k<x>', 'a{100000}', 'x'.repeat(501)]) {
    assert.throws(() => compileRegex(pattern), undefined, pattern);
  }
  for (const pattern of ['[()+*]+', '\\(+', '(a+)?', '(?:foo|bar)', '(?<=x)y', '(?<name>x+)', 'x+?']) {
    assert.ok(compileRegex(pattern), pattern);
  }
});

test('built-in grouping and status patterns pass the shared safety checks', () => {
  for (const preset of PRESETS) {
    assert.ok(compileRegex(preset.regex));
    for (const field of preset.statusFields) if (field.keepOnly) assert.ok(compileRegex(field.keepOnly));
  }
  const aws = defaultAwsSettings();
  const regex = compileAwsPattern(aws);
  assert.ok(regex);
  assert.equal(isAwsConsoleUrl('https://123456789012-abcd1234.us-east-1.console.aws.amazon.com/home', regex), true);
});

test('saved and synced rules receive the same checks and oversized subjects never match a truncated prefix', () => {
  const unsafe = { enabled: true, title: null, url: { mode: 'regex', pattern: '(a+)+$', caseSensitive: false } };
  assert.ok(compileRule(unsafe).error);
  const safe = compileRule({ ...unsafe, url: { mode: 'regex', pattern: '^https://', caseSensitive: false } });
  const url = 'https://example.com/' + 'x'.repeat(MAX_REGEX_INPUT);
  assert.equal(ruleMatches(safe, { url }), false);
  const groups = compileGroupRules([{ enabled: true, regex: '^https://' }]);
  assert.equal(matchGroupRules(groups, { url, title: '' }), null);
  assert.equal(isAwsConsoleUrl(url, compileRegex('^https://')), false);
  const group = normalizeGroupRule({ regex: 'safe', titleTemplate: 'Safe', statusEnabled: true,
    siteOrigin: 'https://example.com', statusFields: [{ keepOnly: '(a+)+$' }] });
  assert.equal(validateGroupRule(group).valid, false);
});
