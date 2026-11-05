import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasCaptureGroup,
  normalizeOrigin,
  originOf,
  normalizeGroupRule,
  validateGroupRule,
  compileGroupRules,
  matchGroupRules,
  resolveBaseTitle,
  isIgnoredUrl,
  pickColor,
  GROUP_COLORS,
  summarizeStatusFields,
  colorForTitle,
  COLOR_MODES,
} from '../src/group-rules.js';

const rule = (overrides = {}) =>
  normalizeGroupRule({ id: 'g1', name: 'Jira', regex: '/browse/([A-Z]+-\\d+)', titleTemplate: '$1', color: 'blue', ...overrides });

test('hasCaptureGroup detects unescaped capturing parens only', () => {
  assert.equal(hasCaptureGroup('/browse/([A-Z]+-\\d+)'), true);
  assert.equal(hasCaptureGroup('github\\.com/'), false);
  assert.equal(hasCaptureGroup('(?:pull|issues)'), false);
  assert.equal(hasCaptureGroup('\\(not a group\\)'), false);
  assert.equal(hasCaptureGroup('[(]'), false);
  assert.equal(hasCaptureGroup('(?:a)(b)'), true);
});

test('normalizeOrigin accepts bare hosts, URLs with paths, rejects non-http', () => {
  assert.equal(normalizeOrigin('jira.example.com'), 'https://jira.example.com');
  assert.equal(normalizeOrigin('http://localhost:8080/some/path?x=1'), 'http://localhost:8080');
  assert.equal(normalizeOrigin(' https://gitlab.example.com/ '), 'https://gitlab.example.com');
  assert.equal(normalizeOrigin('chrome://extensions'), '');
  assert.equal(normalizeOrigin('ftp://files.example.com'), '');
  assert.equal(normalizeOrigin(''), '');
  assert.equal(originOf('https://a.b/c?d'), 'https://a.b');
  assert.equal(originOf('data:text/html,x'), '');
});

test('normalizeGroupRule defaults name to the template and keeps at least one status field', () => {
  const r = normalizeGroupRule({ regex: 'x', titleTemplate: ' Fixed ', color: 'nope', statusFields: [] });
  assert.equal(r.name, 'Fixed');
  assert.equal(r.color, 'blue');
  assert.equal(r.statusFields.length, 1);
  assert.equal(r.enabled, true);
  assert.equal(r.siteOrigin, '');
});

test('validateGroupRule: regex required and must compile; template required for save only', () => {
  assert.ok(validateGroupRule(rule({ regex: '' })).errors.regex);
  assert.match(validateGroupRule(rule({ regex: '(' })).errors.regex, /does not compile/);
  assert.ok(validateGroupRule(rule({ titleTemplate: '' })).errors.titleTemplate);
  assert.equal(validateGroupRule(rule({ titleTemplate: '' }), { forTest: true }).valid, true);
  assert.equal(validateGroupRule(rule()).valid, true);
});

test('validateGroupRule: $N without a capturing group is explained', () => {
  const { errors } = validateGroupRule(rule({ regex: 'github\\.com/', titleTemplate: '$1' }));
  assert.match(errors.titleTemplate, /no capturing group/);
  assert.equal(validateGroupRule(rule({ regex: 'github\\.com/', titleTemplate: 'GitHub' })).valid, true);
});

test('validateGroupRule: status fields probed per alternative, keep-only compiled, origin required', () => {
  const probe = (sel) => !sel.includes('!!');
  const split = (s) => s.split(',').map((x) => x.trim());
  const r = rule({
    statusEnabled: true,
    statusFields: [
      { selector: '#ok, .also!!bad', keepOnly: '' },
      { selector: '#fine', keepOnly: '(' },
    ],
    siteOrigin: '',
  });
  const { errors } = validateGroupRule(r, { probeSelector: probe, splitSelectorList: split });
  assert.match(errors.field1, /Field 1: not a valid CSS selector: \.also!!bad/);
  assert.match(errors.field2, /Field 2: "keep only" regex does not compile/);
  assert.ok(errors.siteOrigin);
  const ok = rule({ statusEnabled: true, statusFields: [{ selector: '#ok' }], siteOrigin: 'jira.example.com' });
  assert.equal(validateGroupRule(ok, { probeSelector: probe, splitSelectorList: split }).valid, true);
});

test('matching: URL first, then title; first enabled rule wins; invalid regex skipped; chrome:// ignored', () => {
  const compiled = compileGroupRules([
    rule({ id: 'broken', regex: '(' }),
    rule({ id: 'off', enabled: false, regex: 'browse' }),
    rule({ id: 'title-only', regex: '\\b(INC\\d{7,})\\b', titleTemplate: '$1' }),
    rule({ id: 'jira' }),
    rule({ id: 'jira2', regex: 'browse' }),
  ]);
  assert.equal(compiled[0].regex, null);
  assert.ok(compiled[0].error);

  const m = matchGroupRules(compiled, { url: 'https://x.atlassian.net/browse/ABC-123', title: 'INC0010042 - whatever' });
  assert.equal(m.rule.id, 'jira', 'URL match beats title match even though title rule is earlier');
  assert.equal(m.matchedOn, 'url');

  const t = matchGroupRules(compiled, { url: 'https://sn.example.com/nav_to.do', title: 'INC0010042 | ServiceNow' });
  assert.equal(t.rule.id, 'title-only');
  assert.equal(t.matchedOn, 'title');
  assert.equal(t.match[1], 'INC0010042');

  assert.equal(matchGroupRules(compiled, { url: 'chrome://extensions', title: 'browse' }), null);
  assert.equal(matchGroupRules(compiled, { url: 'about:blank', title: 'browse' }), null);
  assert.equal(matchGroupRules(compiled, { url: 'https://nothing.example', title: 'nothing' }), null);
  assert.equal(isIgnoredUrl('chrome-extension://abc/popup.html'), true);
});

test('resolveBaseTitle: expansion, whitespace, fallbacks, fixed verbatim', () => {
  const dyn = rule({ regex: 'github\\.com/[^/]+/([^/]+)/pull/(\\d+)', titleTemplate: '$1#$2' });
  const m = new RegExp(dyn.regex).exec('https://github.com/octocat/hello-world/pull/42');
  assert.equal(resolveBaseTitle(dyn, m), 'hello-world#42');

  const spaced = rule({ regex: '(a)?(b)?', titleTemplate: ' $1   $2  $3 ' });
  assert.equal(resolveBaseTitle(spaced, new RegExp(spaced.regex).exec('b')), 'b');

  const empty = rule({ name: 'Fallback', regex: '(x)?', titleTemplate: '$1' });
  assert.equal(resolveBaseTitle(empty, new RegExp(empty.regex).exec('zzz')), 'Fallback');
  const noName = normalizeGroupRule({ id: 'n', regex: '(x)?', titleTemplate: '$1' });
  assert.equal(noName.name, '$1', 'name defaults to template');
  assert.equal(resolveBaseTitle({ ...noName, name: '' }, new RegExp(noName.regex).exec('zzz')), '$1', 'raw template as last resort');

  assert.equal(resolveBaseTitle(rule({ regex: 'github\\.com/', titleTemplate: 'GitHub' }), ['github.com/']), 'GitHub');
});

test('pickColor: random only for dynamic titles', () => {
  const dyn = rule({ randomColor: true, color: 'blue' });
  assert.equal(pickColor(dyn, () => 0.99), GROUP_COLORS[GROUP_COLORS.length - 1]);
  assert.equal(GROUP_COLORS.length, 9, 'all nine chrome.tabGroups colours');
  assert.equal(pickColor(dyn, () => 0), 'grey');
  const fixed = rule({ randomColor: true, color: 'green', regex: 'github', titleTemplate: 'GitHub' });
  assert.equal(pickColor(fixed, () => 0.99), 'green');
  assert.equal(pickColor(rule({ color: 'pink' }), () => 0.99), 'pink');
});

test('summarizeStatusFields', () => {
  assert.equal(
    summarizeStatusFields([
      { selector: '.state', keepOnly: '', label: '' },
      { selector: '.mr-pipeline-title', keepOnly: '#\\d+\\s+(\\S+)', label: 'CI' },
    ]),
    '.state · CI: .mr-pipeline-title → /#\\d+\\s+(\\S+)/',
  );
});

test('colour modes: fixed, random, and stable colour by title; legacy randomColor maps to random', () => {
  assert.deepEqual(COLOR_MODES, ['fixed', 'random', 'title']);
  assert.equal(normalizeGroupRule({ regex: 'x', titleTemplate: '$1', randomColor: true }).colorMode, 'random');
  assert.equal(normalizeGroupRule({ regex: 'x', titleTemplate: '$1' }).colorMode, 'fixed');
  assert.equal(normalizeGroupRule({ regex: 'x', titleTemplate: '$1', colorMode: 'title' }).colorMode, 'title');

  const byTitle = rule({ colorMode: 'title', color: 'blue' });
  const a = pickColor(byTitle, () => 0.99, 'ABC-123');
  assert.equal(pickColor(byTitle, () => 0.01, 'ABC-123'), a, 'same title, same colour regardless of randomness');
  assert.ok(GROUP_COLORS.includes(a));
  assert.equal(colorForTitle('ABC-123'), a);
  const seen = new Set(['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', 'ABC-5', 'XYZ-9', 'proj!17', 'hello-world#42'].map(colorForTitle));
  assert.ok(seen.size >= 3, 'different titles spread over colours');

  const fixedTitle = rule({ colorMode: 'title', color: 'green', regex: 'github', titleTemplate: 'GitHub' });
  assert.equal(pickColor(fixedTitle, () => 0.5, 'GitHub'), 'green', 'fixed titles keep the chosen colour');
  assert.equal(pickColor(rule({ colorMode: 'random' }), () => 0.99, 'x'), GROUP_COLORS.at(-1));
});
