import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSarif, summarizeOsv } from '../scripts/security-report.mjs';
import { makeBadges } from '../scripts/repo-metrics.mjs';
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

test('OSV count treats aliases as one advisory for each affected package', () => {
  assert.deepEqual(summarizeOsv({ results: [{ packages: [
    { package: { name: 'first' }, vulnerabilities: [{ id: 'CVE-1' }, { id: 'GHSA-1' }], groups: [{ ids: ['CVE-1', 'GHSA-1'] }] },
    { package: { name: 'second' }, vulnerabilities: [{ id: 'CVE-1' }], groups: [{ ids: ['CVE-1'] }] },
    { package: { name: 'clean' } },
  ] }] }), { packages: 3, vulnerabilities: 2 });
});

test('missing reports and failed tests cannot produce optimistic badges', () => {
  for (const b of Object.values(makeBadges({}))) {
    assert.equal(b.message, 'unavailable');
    assert.equal(b.color, 'lightgrey');
  }
  const badges = makeBadges({
    unit: { coverage: { coveredLinePercent: 99 }, tests: { tests: 10, passed: 9, success: false } },
    codeql: { findings: 2 }, dependencies: { vulnerabilities: 1 },
  });
  assert.equal(badges.coverage.message, 'unavailable');
  assert.equal(badges.tests.message, '9/10 passed');
  assert.equal(badges.tests.color, 'red');
  assert.equal(badges.codeql.color, 'red');
  assert.equal(badges.dependencies.color, 'red');
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
