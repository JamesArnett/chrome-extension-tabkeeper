import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSarif, summarizeOsv } from '../scripts/security-report.mjs';
import reporter from '../scripts/coverage-reporter.mjs';

const sarif = (results, extra = {}) => ({ version: '2.1.0', runs: [{
  tool: { driver: { rules: [
    { id: 'high', properties: { 'security-severity': '8.1' } },
    { id: 'medium', properties: { 'security-severity': '5.0' } },
  ] } }, results, ...extra,
}] });

test('CodeQL gate counts lower severity findings but blocks high severity and errors', () => {
  assert.deepEqual(summarizeSarif([sarif([
    { ruleId: 'high', level: 'warning' }, { ruleId: 'medium', level: 'warning' },
    { ruleId: 'other', level: 'error' }, { ruleId: 'high', suppressions: [{ status: 'accepted' }] },
    { ruleId: 'high', kind: 'pass' },
  ])]), { findings: 3, blocking: 2 });
});

test('incomplete security reports cannot become a clean result', () => {
  assert.throws(() => summarizeSarif([]), /No CodeQL/);
  assert.throws(() => summarizeSarif([sarif([], { invocations: [{ executionSuccessful: false }] })]), /incomplete/);
  assert.throws(() => summarizeSarif([{ version: '2.1.0', runs: [] }]), /Invalid/);
  assert.throws(() => summarizeOsv({}), /Invalid/);
});

test('CodeQL extension rules supply severity and default levels when results omit them', () => {
  const tool = { driver: { rules: [{ id: 'high', properties: { 'security-severity': '1.0' } }] }, extensions: [
    { name: 'metadata' },
    { name: 'queries', rules: [
      { id: 'high', properties: { 'security-severity': '7.5' } },
      { id: 'error', defaultConfiguration: { level: 'error' } },
      { id: 'medium', properties: { 'security-severity': '5.0' } },
    ] },
  ] };
  const results = [
    { ruleId: 'high', rule: { id: 'high', index: 0, toolComponent: { index: 1 } } },
    { rule: { index: 1, toolComponent: { index: 1 } } },
    { rule: { id: 'medium', toolComponent: { name: 'queries' } } },
    { rule: { index: 1, toolComponent: { index: 1 } }, level: 'warning' },
  ];
  assert.deepEqual(summarizeSarif([sarif(results, { tool })]), { findings: 4, blocking: 2 });
});

test('SARIF driver indexes and named component references resolve rule defaults', () => {
  const tool = { driver: { name: 'driver', rules: [
    { id: 'driver-error', defaultConfiguration: { level: 'error' } },
  ] }, extensions: [{ name: 'queries', guid: 'queries-guid', rules: [
    { id: 'extension-high', guid: 'rule-guid', properties: { 'security-severity': '8.0' } },
  ] }] };
  const results = [
    { ruleIndex: 0 },
    { rule: { id: 'driver-error', toolComponent: { name: 'driver' } } },
    { rule: { guid: 'rule-guid', toolComponent: { guid: 'queries-guid' } } },
  ];
  assert.deepEqual(summarizeSarif([sarif(results, { tool })]), { findings: 3, blocking: 3 });
});

test('OSV count treats aliases as one advisory for each affected package', () => {
  assert.deepEqual(summarizeOsv({ results: [{ packages: [
    { package: { name: 'first' }, vulnerabilities: [{ id: 'CVE-1' }, { id: 'GHSA-1' }], groups: [{ ids: ['CVE-1', 'GHSA-1'] }] },
    { package: { name: 'second' }, vulnerabilities: [{ id: 'CVE-1' }], groups: [{ ids: ['CVE-1'] }] },
    { package: { name: 'clean' } },
  ] }] }), { packages: 3, vulnerabilities: 2 });
});

test('coverage reporter uses the final aggregate summary and rejects partial runs', async () => {
  async function* events() {
    yield { type: 'test:summary', data: { file: 'one.js', counts: { tests: 1 }, success: true } };
    yield { type: 'test:coverage', data: { summary: { totals: { coveredLinePercent: 94.5 } } } };
    yield { type: 'test:summary', data: { counts: { tests: 3, passed: 3 }, success: true } };
  }
  const output = [];
  for await (const item of reporter(events())) output.push(item);
  assert.equal(JSON.parse(output.join('')).tests.tests, 3);
  await assert.rejects(async () => {
    for await (const item of reporter([])) void item;
  }, /Incomplete/);
});
