import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStatusCore, el, fakeDoc } from './helpers/status-core.js';
import {
  normalizeAwsSettings,
  defaultAwsSettings,
  compileAwsPattern,
  isAwsConsoleUrl,
  regionFromUrl,
  parseAccountLabel,
  parseRole,
  composeAwsTitle,
  parseAwsRead,
  awsReadFields,
  accountIdFromUrl,
  AWS_SAMPLE_INFO,
  AWS_ROLE_PATTERN,
} from '../src/aws.js';

test('defaults: disabled, account + role shown, middle dot separator', () => {
  const d = defaultAwsSettings();
  assert.equal(d.enabled, false);
  assert.deepEqual(d.fields, { account: true, accountId: false, role: true, user: false, region: false });
  assert.equal(d.separator, ' · ');
  assert.equal(composeAwsTitle(d, AWS_SAMPLE_INFO), 'Acme Dev · AdminRole');
});

test('normalizeAwsSettings coerces and falls back', () => {
  const s = normalizeAwsSettings({ enabled: 1, fields: { user: 1, bogus: true }, separator: '::', selectors: { role: '  .r ', account: '' }, urlPattern: '  ' });
  assert.equal(s.enabled, true);
  assert.equal(s.fields.user, true);
  assert.equal(s.fields.account, true);
  assert.equal('bogus' in s.fields, false);
  assert.equal(s.separator, ' · ', 'unknown separator falls back');
  assert.equal(s.selectors.role, '.r');
  assert.equal(s.selectors.account, defaultAwsSettings().selectors.account, 'empty selector falls back');
  assert.equal(s.urlPattern, defaultAwsSettings().urlPattern);
  assert.equal(normalizeAwsSettings(null).enabled, false);
});

test('console URL matching: regional and global hosts, not signin or other sites', () => {
  for (const url of [
    'https://console.aws.amazon.com/console/home',
    'https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#Instances:',
    'https://eu-west-2.console.aws.amazon.com/s3/buckets',
    'https://123456789012-abcd1234.us-west-2.console.aws.amazon.com/console/home?region=us-west-2#',
  ]) assert.equal(isAwsConsoleUrl(url), true, url);
  for (const url of [
    'https://signin.aws.amazon.com/signin',
    'https://aws.amazon.com/console/',
    'https://evil.com/console.aws.amazon.com/',
    'http://console.aws.amazon.com/',
    'https://console.amazonaws-us-gov.com/',
  ]) assert.equal(isAwsConsoleUrl(url), false, url);
  assert.equal(compileAwsPattern({ urlPattern: '(' }), null);
});

test('regionFromUrl prefers ?region=, then the subdomain', () => {
  assert.equal(regionFromUrl('https://us-east-1.console.aws.amazon.com/ec2/home?region=eu-central-1'), 'eu-central-1');
  assert.equal(regionFromUrl('https://ap-southeast-2.console.aws.amazon.com/s3/'), 'ap-southeast-2');
  assert.equal(regionFromUrl('https://console.aws.amazon.com/console/home'), '');
  assert.equal(regionFromUrl('https://123456789012-abcd1234.us-west-2.console.aws.amazon.com/console/home'), 'us-west-2', 'multi-session host without ?region=');
  assert.equal(regionFromUrl('https://us-gov-west-1.console.amazonaws-us-gov.com/'), 'us-gov-west-1');
  assert.equal(regionFromUrl('not a url'), '');
});

test('parseAccountLabel', () => {
  assert.deepEqual(parseAccountLabel('Acme Dev (123456789012)'), { account: 'Acme Dev', accountId: '123456789012' });
  assert.deepEqual(parseAccountLabel('  Prod   Payments  ( 123456789012 )'.replace('( ', '(').replace(' )', ')')), { account: 'Prod Payments', accountId: '123456789012' });
  assert.deepEqual(parseAccountLabel('123456789012'), { account: '', accountId: '123456789012' });
  assert.deepEqual(parseAccountLabel('Just a name'), { account: 'Just a name', accountId: '' });
  assert.deepEqual(parseAccountLabel(''), { account: '', accountId: '' });
});

test('parseRole splits at the first slash', () => {
  assert.deepEqual(parseRole('AdminRole/jane'), { role: 'AdminRole', user: 'jane' });
  assert.deepEqual(parseRole('AWSReservedSSO_Admin_abc/james@example.com'), { role: 'AWSReservedSSO_Admin_abc', user: 'james@example.com' });
  assert.deepEqual(parseRole('root'), { role: 'root', user: '' });
  assert.deepEqual(parseRole(''), { role: '', user: '' });
  assert.match('AdminRole/jane', new RegExp(AWS_ROLE_PATTERN));
  assert.doesNotMatch('Services', new RegExp(AWS_ROLE_PATTERN));
  assert.doesNotMatch('EC2 / Instances', new RegExp(AWS_ROLE_PATTERN));
});

test('composeAwsTitle: field order fixed, empties skipped, separator applied', () => {
  const all = normalizeAwsSettings({ fields: { account: true, accountId: true, role: true, user: true, region: true }, separator: ' - ' });
  assert.equal(composeAwsTitle(all, AWS_SAMPLE_INFO), 'Acme Dev - 123456789012 - AdminRole - jane - us-east-1');
  const roleOnly = normalizeAwsSettings({ fields: { account: false, role: true } });
  assert.equal(composeAwsTitle(roleOnly, AWS_SAMPLE_INFO), 'AdminRole');
  assert.equal(composeAwsTitle(defaultAwsSettings(), { account: 'Acme Dev', role: '' }), 'Acme Dev', 'partial read');
  assert.equal(composeAwsTitle(defaultAwsSettings(), {}), '');
  assert.equal(composeAwsTitle(normalizeAwsSettings({ fields: { account: false, role: false } }), AWS_SAMPLE_INFO), '');
});

test('awsReadFields + parseAwsRead turn reader results into info', () => {
  const fields = awsReadFields(defaultAwsSettings());
  assert.equal(fields.length, 2);
  assert.equal(fields[1].pickMatching, true);
  assert.equal(fields[1].keepOnly, AWS_ROLE_PATTERN);
  const info = parseAwsRead(
    { results: [{ value: 'Acme Dev (123456789012)', raw: 'Acme Dev (123456789012)' }, { value: 'AdminRole', raw: 'AdminRole/jane' }] },
    'https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1',
  );
  assert.deepEqual(info, AWS_SAMPLE_INFO);
  assert.deepEqual(parseAwsRead(null, 'https://console.aws.amazon.com/'), { account: '', accountId: '', role: '', user: '', region: '' });
});

test('AWS reader accepts root sessions after unrelated navigation text', () => {
  const core = loadStatusCore();
  const settings = normalizeAwsSettings({ selectors: { account: '#account', role: '#nav span' } });
  const doc = fakeDoc({
    '#account': [el('span', {}, { text: 'Acme Dev (123456789012)' })],
    '#nav span': [el('span', {}, { text: 'Recently visited' }), el('span', {}, { text: 'root' })],
  });
  const read = core.readFields(doc, awsReadFields(settings));
  const info = parseAwsRead(read, 'https://us-west-2.console.aws.amazon.com/');
  assert.equal(info.role, 'root');
  assert.equal(info.user, '');
  assert.equal(composeAwsTitle(settings, info), 'Acme Dev · root');
});

test('AWS reader diagnostic text is never used as a role or user after a failed match', () => {
  const core = loadStatusCore();
  const settings = normalizeAwsSettings({ selectors: { account: '#account', role: '#nav span' } });
  for (const text of ['Recently visited', 'Services', 'EC2 / Instances']) {
    const read = core.readFields(fakeDoc({
      '#account': [el('span', {}, { text: 'Acme Dev (123456789012)' })],
      '#nav span': [el('span', {}, { text })],
    }), awsReadFields(settings));
    assert.equal(read.results[1].raw, text, 'diagnostic raw text is retained');
    assert.equal(read.results[1].error, 'keep-no-match');
    const info = parseAwsRead(read, 'https://us-west-2.console.aws.amazon.com/');
    assert.equal(info.role, '', text);
    assert.equal(info.user, '', text);
    assert.equal(composeAwsTitle(settings, info), 'Acme Dev');
  }
});

test('account id falls back to the hostname prefix when the label lacks it', () => {
  const url = 'https://123456789012-abcd1234.us-west-2.console.aws.amazon.com/console/home?region=us-west-2#';
  assert.equal(accountIdFromUrl(url), '123456789012');
  assert.equal(accountIdFromUrl('https://us-east-1.console.aws.amazon.com/'), '');
  assert.equal(regionFromUrl(url), 'us-west-2');
  const info = parseAwsRead({ results: [{ value: 'Acme Dev', raw: 'Acme Dev' }, { value: 'AdminRole', raw: 'AdminRole/jane' }] }, url);
  assert.equal(info.accountId, '123456789012');
  assert.equal(info.account, 'Acme Dev');
  const labelWins = parseAwsRead({ results: [{ value: 'x (999999999999)', raw: 'x (999999999999)' }, { value: '', raw: '' }] }, url);
  assert.equal(labelWins.accountId, '999999999999');
});

test('a stored copy of the old default URL pattern is upgraded to the current default', () => {
  const legacy = '^https://([a-z0-9-]+\\.)?console\\.aws\\.amazon\\.com/';
  const s = normalizeAwsSettings({ urlPattern: legacy });
  assert.equal(s.urlPattern, defaultAwsSettings().urlPattern);
  assert.equal(
    compileAwsPattern(s).test('https://123456789012-abcd1234.us-west-2.console.aws.amazon.com/console/home?region=us-west-2#'),
    true,
  );
  assert.equal(normalizeAwsSettings({ urlPattern: '^https://my-proxy\\.example/' }).urlPattern, '^https://my-proxy\\.example/', 'real customisations are kept');
});
