import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrouper } from '../src/grouper.js';
import { createStorage } from '../src/storage.js';
import { normalizeGroupRule } from '../src/group-rules.js';
import { createChromeStorage, createTabs, createTabGroups } from './helpers/chrome-mock.js';

const JIRA = 'https://x.atlassian.net/browse/';

const grule = (overrides = {}) =>
  normalizeGroupRule({
    id: 'jira',
    name: 'Jira',
    regex: '/browse/([A-Z]+-\\d+)',
    titleTemplate: '$1',
    color: 'blue',
    siteOrigin: 'https://x.atlassian.net',
    statusEnabled: true,
    statusFields: [{ selector: '#status' }],
    ...overrides,
  });

/** statusReader stub: `answers` maps tabId -> value string (or null for a miss). */
function stubReader(answers = {}, { access = true } = {}) {
  const calls = [];
  return {
    calls,
    answers,
    async hasAccess() {
      return access;
    },
    async read(tabId, fields, opts) {
      calls.push({ tabId, opts });
      const value = answers[tabId];
      if (value === undefined) return null;
      return {
        results: fields.map((f, i) => ({ value: i === 0 ? value ?? '' : '', raw: value ?? '', element: 'span#status', matched: value ? 1 : 0, error: value ? null : 'matched-nothing' })),
        matchedTotal: value ? 1 : 0,
        valueCount: value ? 1 : 0,
        complete: Boolean(value),
      };
    },
  };
}

async function setup({ rules = [grule()], reader = stubReader(), pending = () => false, limit = 0, random = () => 0.5 } = {}) {
  const chromeStorage = createChromeStorage();
  const storage = createStorage(chromeStorage);
  await storage.saveGroupRules(rules);
  await storage.setMaxTitleLength(limit);
  const tabGroups = createTabGroups();
  const tabs = createTabs([], tabGroups);
  const warnings = [];
  const logger = { error: (...a) => { throw new Error(a.join(' ')); }, warn: (...a) => warnings.push(a.join(' ')) };
  const grouper = createGrouper({ storage, tabs, tabGroups, statusReader: reader, isPendingClose: pending, random, logger });
  await grouper.start();
  return { storage, tabs, tabGroups, grouper, reader, warnings };
}

test('matching tab gets a titled, coloured group; same ticket joins it; other tickets and windows get their own', async () => {
  const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ statusEnabled: false })] });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  const r1 = await grouper.evaluateTab(a);
  assert.equal(r1.created, true);
  const g = await tabGroups.get(r1.groupId);
  assert.equal(g.title, 'ABC-123');
  assert.equal(g.color, 'blue');
  assert.equal((await tabs.get(a.id)).groupId, r1.groupId);

  const b = tabs._add({ url: JIRA + 'ABC-123?focusedCommentId=1' });
  const r2 = await grouper.evaluateTab(b);
  assert.equal(r2.created, false);
  assert.equal(r2.groupId, r1.groupId);
  const again = await grouper.evaluateTab(await tabs.get(b.id));
  assert.equal(again.moved, false, 'already in the group: nothing to do');

  const c = tabs._add({ url: JIRA + 'ABC-124' });
  assert.notEqual((await grouper.evaluateTab(c)).groupId, r1.groupId);
  const d = tabs._add({ url: JIRA + 'ABC-123', windowId: 2 });
  const r4 = await grouper.evaluateTab(d);
  assert.notEqual(r4.groupId, r1.groupId, 'groups are per window');
  assert.equal((await tabGroups.get(r4.groupId)).windowId, 2);
});

test('fixed title: one shared group, chosen colour even with random on', async () => {
  const { tabs, tabGroups, grouper } = await setup({
    rules: [grule({ regex: 'github\\.com/', titleTemplate: 'GitHub', color: 'green', randomColor: true, statusEnabled: false })],
    random: () => 0.99,
  });
  const a = await grouper.evaluateTab(tabs._add({ url: 'https://github.com/a/b' }));
  const b = await grouper.evaluateTab(tabs._add({ url: 'https://github.com/c/d/pull/1' }));
  assert.equal(a.groupId, b.groupId);
  assert.equal((await tabGroups.get(a.groupId)).color, 'green');
});

test('random colour applies to dynamic titles at creation only', async () => {
  const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ randomColor: true, statusEnabled: false })], random: () => 0.99 });
  const r = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-1' }));
  assert.equal((await tabGroups.get(r.groupId)).color, 'orange');
});

test('ignored: chrome:// urls, pinned tabs, tabs pending close, no matching rule', async () => {
  const { tabs, grouper } = await setup({ pending: (id) => id === 3 });
  assert.equal((await grouper.evaluateTab(tabs._add({ url: 'chrome://extensions', title: 'browse/ABC-1' }))).reason, 'ignored-url');
  assert.equal((await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-1', pinned: true }))).reason, 'pinned');
  assert.equal((await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-1' }))).reason, 'pending-close');
  assert.equal((await grouper.evaluateTab(tabs._add({ url: 'https://example.com' }))).reason, 'no-rule');
});

test('two concurrent evaluations for one ticket create exactly one group', async () => {
  const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ statusEnabled: false })] });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  const b = tabs._add({ url: JIRA + 'ABC-123' });
  const [ra, rb] = await Promise.all([grouper.evaluateTab(a), grouper.evaluateTab(b)]);
  assert.equal(ra.groupId, rb.groupId);
  assert.equal(Object.keys(tabGroups._all()).length, 1);
});

test('adoption by title: exact; " - status" only with status on (status recovered); head… only with a limit', async () => {
  // Fresh record each time: simulate "record empty" by making groups by hand before evaluating.
  {
    const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ statusEnabled: false })] });
    const existing = tabs._add({ url: 'https://other.example' });
    const gid = tabGroups._handMade(1, 'ABC-123', existing);
    const r = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-123' }));
    assert.equal(r.groupId, gid, 'exact title adopted');
    assert.equal(r.created, false);
  }
  {
    const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ statusEnabled: false })] });
    tabGroups._handMade(1, 'ABC-123 - Done', tabs._add({ url: 'https://other.example' }));
    const r = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-123' }));
    assert.equal(r.created, true, 'status form not adopted when status is off');
  }
  {
    const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ statusEnabled: true })], reader: stubReader({}) });
    const gid = tabGroups._handMade(1, 'ABC-123 - Done', tabs._add({ url: 'https://other.example' }));
    const r = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-123' }));
    assert.equal(r.groupId, gid);
    assert.equal(grouper.getRecord()[1]['ABC-123'].status, 'Done', 'status recovered from the adopted title');
  }
  {
    const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ regex: '/browse/([A-Z]+-\\d+-[a-z]+)', statusEnabled: false })] });
    tabGroups._handMade(1, 'ABC-123-…', tabs._add({ url: 'https://other.example' }));
    const r = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-123-longsuffix' }));
    assert.equal(r.created, true, 'shortened form not adopted without a limit');
  }
  {
    const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ regex: '/browse/([A-Z]+-\\d+-[a-z]+)', statusEnabled: false })], limit: 12 });
    const gid = tabGroups._handMade(1, 'ABC-123-…', tabs._add({ url: 'https://other.example' }));
    const r = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-123-longsuffix' }));
    assert.equal(r.groupId, gid, 'shortened form adopted with a limit');
  }
  {
    const { tabs, grouper } = await setup({ rules: [grule({ regex: 'github\\.com/', titleTemplate: 'GitHub', statusEnabled: false })] });
    const { tabGroups } = { tabGroups: null };
    void tabGroups;
    const r = await grouper.evaluateTab(tabs._add({ url: 'https://github.com/x' }));
    assert.equal(r.created, true);
  }
});

test('hand-made "GitHub - Docs" is never adopted by fixed rule "GitHub", even with status on', async () => {
  const { tabs, tabGroups, grouper } = await setup({
    rules: [grule({ regex: 'github\\.com/', titleTemplate: 'GitHub', statusEnabled: false })],
  });
  const docs = tabGroups._handMade(1, 'GitHub - Docs', tabs._add({ url: 'https://docs.github.com' }));
  const r = await grouper.evaluateTab(tabs._add({ url: 'https://github.com/x' }));
  assert.notEqual(r.groupId, docs);
  assert.equal((await tabGroups.get(docs)).title, 'GitHub - Docs');
});

test('a recorded group that vanished is recreated; onGroupRemoved forgets the record', async () => {
  const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ statusEnabled: false })] });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  const r1 = await grouper.evaluateTab(a);
  tabGroups._dissolve(r1.groupId, await tabs.query({}));
  tabs._update(a.id, { groupId: -1 });
  await grouper.onGroupRemoved(r1.groupId);
  assert.deepEqual(grouper.getRecord(), {});
  const r2 = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-123' }));
  assert.equal(r2.created, true);
  assert.notEqual(r2.groupId, r1.groupId);
});

test('SPA navigation: URL change on a complete tab moves it to the new ticket group', async () => {
  const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ statusEnabled: false })] });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  const r1 = await grouper.evaluateTab(a);
  const r2 = await grouper.evaluateTab(tabs._update(a.id, { url: JIRA + 'ABC-124' }));
  assert.notEqual(r2.groupId, r1.groupId);
  assert.equal((await tabGroups.get(r2.groupId)).title, 'ABC-124');
  assert.equal((await tabs.get(a.id)).groupId, r2.groupId);
});

// ---------------- status ----------------

test('status read on load is applied to the title and recorded; identical status is a no-op', async () => {
  const reader = stubReader();
  const { tabs, tabGroups, grouper } = await setup({ reader });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  reader.answers[a.id] = 'In Progress';
  const r = await grouper.evaluateTab(a);
  await grouper.idle();
  assert.equal((await tabGroups.get(r.groupId)).title, 'ABC-123 - In Progress');
  assert.equal(grouper.getRecord()[1]['ABC-123'].status, 'In Progress');
  assert.equal(reader.calls[0].opts.watch, true);
  assert.equal(reader.calls[0].opts.timeoutMs, 10_000);

  const before = tabGroups._updateCalls;
  const res = await grouper.applyStatus({ tabId: a.id, windowId: 1, baseTitle: 'ABC-123', status: 'In Progress' });
  assert.deepEqual(res, { applied: false, reason: 'unchanged' });
  assert.equal(tabGroups._updateCalls, before, 'no API call for an unchanged status');
});

test('a failed or empty read never clears an existing suffix', async () => {
  const reader = stubReader();
  const { tabs, tabGroups, grouper } = await setup({ reader });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  reader.answers[a.id] = 'Done';
  const r = await grouper.evaluateTab(a);
  await grouper.idle();
  reader.answers[a.id] = null; // matched nothing
  await grouper.evaluateTab(await tabs.get(a.id));
  await grouper.idle();
  assert.equal((await tabGroups.get(r.groupId)).title, 'ABC-123 - Done');
  delete reader.answers[a.id]; // read failed entirely
  await grouper.evaluateTab(await tabs.get(a.id));
  await grouper.idle();
  assert.equal((await tabGroups.get(r.groupId)).title, 'ABC-123 - Done');
  assert.equal((await grouper.applyStatus({ tabId: a.id, windowId: 1, baseTitle: 'ABC-123', status: '' })).reason, 'empty');
});

test('no page access: status is skipped with a warning, grouping still happens', async () => {
  const reader = stubReader({}, { access: false });
  const { tabs, tabGroups, grouper, warnings } = await setup({ reader });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  reader.answers[a.id] = 'Done';
  const r = await grouper.evaluateTab(a);
  await grouper.idle();
  assert.equal((await tabGroups.get(r.groupId)).title, 'ABC-123');
  assert.equal(reader.calls.length, 0, 'never injects into an ungranted origin');
  assert.ok(warnings.some((w) => w.includes('no access')));
});

test('status refused for an unrecorded group and for a tab dragged into another ticket group', async () => {
  const reader = stubReader();
  const { tabs, tabGroups, grouper, warnings } = await setup({ reader });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  const b = tabs._add({ url: JIRA + 'ABC-124' });
  const ra = await grouper.evaluateTab(a);
  const rb = await grouper.evaluateTab(b);
  await grouper.idle();

  // Hand-made group is not in the record.
  const hand = tabs._add({ url: JIRA + 'ZZZ-1' });
  tabGroups._handMade(1, 'My stuff', hand);
  assert.equal((await grouper.applyStatus({ tabId: hand.id, windowId: 1, baseTitle: 'ZZZ-1', status: 'X' })).reason, 'unrecorded');

  // Drag ABC-124's tab into ABC-123's group, then its status arrives.
  await tabs.group({ tabIds: [b.id], groupId: ra.groupId });
  const res = await grouper.applyStatus({ tabId: b.id, windowId: 1, baseTitle: 'ABC-124', status: 'Blocked' });
  assert.equal(res.reason, 'mismatched-group');
  assert.equal((await tabGroups.get(ra.groupId)).title, 'ABC-123');
  assert.ok(warnings.some((w) => w.includes('refusing to rename')));
  void rb;
});

test('status update on a group that disappeared drops the record entry', async () => {
  const reader = stubReader();
  const { tabs, tabGroups, grouper } = await setup({ reader });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  const r = await grouper.evaluateTab(a);
  await grouper.idle();
  // Group vanishes but the tab (stale) still claims the id.
  tabGroups._dissolve(r.groupId, []);
  const res = await grouper.applyStatus({ tabId: a.id, windowId: 1, baseTitle: 'ABC-123', status: 'Done' });
  assert.equal(res.reason, 'group-gone');
  assert.deepEqual(grouper.getRecord(), {});
});

test('observer reports: applied when consistent, ignored when ungrouped, no longer matching, or recorded elsewhere', async () => {
  const reader = stubReader();
  const { tabs, tabGroups, grouper } = await setup({ reader });
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  const r = await grouper.evaluateTab(a);
  await grouper.idle();
  const results = (v) => [{ value: v }];

  assert.equal((await grouper.onStatusReport({ id: a.id }, results('Review'))).applied, true);
  assert.equal((await tabGroups.get(r.groupId)).title, 'ABC-123 - Review');

  // Navigated away (SPA) without re-grouping yet: URL no longer matches a status rule.
  tabs._update(a.id, { url: 'https://x.atlassian.net/secure/Dashboard.jspa' });
  assert.equal((await grouper.onStatusReport({ id: a.id }, results('Stale'))).reason, 'no-status-rule');

  // Now in ABC-124 but still sitting in ABC-123's group (recorded elsewhere).
  tabs._update(a.id, { url: JIRA + 'ABC-124' });
  assert.equal((await grouper.onStatusReport({ id: a.id }, results('Wrong'))).reason, 'mismatched-group');
  assert.equal((await tabGroups.get(r.groupId)).title, 'ABC-123 - Review');

  // Ungrouped tab.
  await tabs.ungroup(a.id);
  assert.equal((await grouper.onStatusReport({ id: a.id }, results('X'))).reason, 'ungrouped');
  assert.equal((await grouper.onStatusReport({ id: 999 }, results('X'))).reason, 'tab-gone');
  assert.equal((await grouper.onStatusReport(null, results('X'))).reason, 'no-sender');
});

test('setTitleLimit retitles every recorded group and reports how many changed', async () => {
  const reader = stubReader();
  const { tabs, tabGroups, grouper } = await setup({ reader, rules: [grule({ regex: '/browse/([A-Z]+-\\d+)' })] });
  const a = tabs._add({ url: JIRA + 'LONGPROJECTNAME-1234567' });
  const b = tabs._add({ url: JIRA + 'ABC-1' });
  reader.answers[a.id] = 'In Progress';
  reader.answers[b.id] = 'Done';
  const ra = await grouper.evaluateTab(a);
  const rb = await grouper.evaluateTab(b);
  await grouper.idle();
  const res = await grouper.setTitleLimit(20);
  assert.equal(res.limit, 20);
  assert.equal(res.changed, 1, 'only the long one needed shortening');
  assert.equal((await tabGroups.get(ra.groupId)).title, 'LONGPROJ… - In Progress');
  assert.equal((await tabGroups.get(rb.groupId)).title, 'ABC-1 - Done');
  // New groups honour the limit too.
  const c = tabs._add({ url: JIRA + 'ANOTHERLONGPROJECT-99' });
  const rc = await grouper.evaluateTab(c);
  assert.equal((await tabGroups.get(rc.groupId)).title, 'ANOTHERLONGPROJECT-…');
  assert.equal((await grouper.setTitleLimit(0)).changed, 2);
});

test('testRule: dry run reports match, status, final title, and never groups or watches', async () => {
  const reader = stubReader();
  const { tabs, tabGroups, grouper } = await setup({ reader, rules: [] });
  const tab = tabs._add({ url: JIRA + 'ABC-123', title: 'ABC-123 Fix the thing' });
  reader.answers[tab.id] = 'In Progress';
  const form = { regex: '/browse/([A-Z]+-\\d+)', titleTemplate: '$1', statusEnabled: true, statusFields: [{ selector: '#status' }] };
  const r = await grouper.testRule(form, tab);
  assert.equal(r.matched, true);
  assert.equal(r.baseTitle, 'ABC-123');
  assert.equal(r.status, 'In Progress');
  assert.equal(r.finalTitle, 'ABC-123 - In Progress');
  assert.equal(r.fixed, false);
  assert.equal(r.fields[0].element, 'span#status');
  assert.equal(reader.calls[0].opts.watch, false);
  assert.equal(reader.calls[0].opts.timeoutMs, 3000);
  assert.deepEqual(tabGroups._all(), {}, 'nothing grouped');

  const miss = await grouper.testRule({ regex: 'gitlab', titleTemplate: 'x' }, tab);
  assert.equal(miss.error, 'regex-no-match');
  assert.equal(miss.url, JIRA + 'ABC-123');
  assert.equal((await grouper.testRule(form, { id: 1, url: 'chrome://extensions', title: '' })).error, 'browser-page');
  assert.equal((await grouper.testRule({ regex: '(', titleTemplate: 'x' }, tab)).error, 'invalid-regex');
  assert.equal((await grouper.testRule({ regex: 'browse', titleTemplate: '' }, tab)).error, 'empty-title');
  const fixed = await grouper.testRule({ regex: 'atlassian', titleTemplate: 'Jira' }, tab);
  assert.equal(fixed.fixed, true);
  assert.equal(fixed.finalTitle, 'Jira');
});

test('testRule without page access reports access-not-granted but still resolves the title', async () => {
  const reader = stubReader({}, { access: false });
  const { tabs, grouper } = await setup({ reader, rules: [] });
  const tab = tabs._add({ url: JIRA + 'ABC-123' });
  const r = await grouper.testRule({ regex: '/browse/([A-Z]+-\\d+)', titleTemplate: '$1', statusEnabled: true }, tab);
  assert.equal(r.error, 'access-not-granted');
  assert.equal(r.origin, 'https://x.atlassian.net');
  assert.equal(r.finalTitle, 'ABC-123');
});

test('invalid regex rule is skipped with a warning and does not block later rules', async () => {
  const { tabs, grouper, warnings } = await setup({ rules: [grule({ id: 'bad', regex: '(' }), grule({ id: 'ok', statusEnabled: false })] });
  assert.ok(warnings.some((w) => w.includes('skipped')));
  const r = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-1' }));
  assert.equal(r.ruleId, 'ok');
});

test('record survives a worker restart (new grouper over the same session storage)', async () => {
  const chromeStorage = createChromeStorage();
  const storage = createStorage(chromeStorage);
  await storage.saveGroupRules([grule({ statusEnabled: false })]);
  const tabGroups = createTabGroups();
  const tabs = createTabs([], tabGroups);
  const logger = { error: () => {}, warn: () => {} };
  const g1 = createGrouper({ storage, tabs, tabGroups, logger });
  await g1.start();
  const a = tabs._add({ url: JIRA + 'ABC-123' });
  const r1 = await g1.evaluateTab(a);

  const g2 = createGrouper({ storage, tabs, tabGroups, logger });
  await g2.start();
  const r2 = await g2.evaluateTab(tabs._add({ url: JIRA + 'ABC-123' }));
  assert.equal(r2.groupId, r1.groupId);
  assert.equal(r2.created, false);
});

// ---------------- AWS console ----------------

const CONSOLE = 'https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1';
const awsSettings = (overrides = {}) => ({ enabled: true, ...overrides });

/** Reader stub for AWS: answers[tabId] = [accountLabelText, roleText|''] */
function awsReader(answers = {}, { access = true } = {}) {
  const calls = [];
  return {
    calls,
    answers,
    async hasAccess() {
      return access;
    },
    async read(tabId, fields, opts) {
      calls.push({ tabId, fields, opts });
      const a = answers[tabId];
      if (!a) return null;
      const [label, roleText] = a;
      return {
        results: [
          { value: label, raw: label, element: 'span[data-testid="account-label"]', matched: label ? 1 : 0, error: label ? null : 'matched-nothing' },
          { value: roleText ? roleText.split('/')[0] : '', raw: roleText, element: 'span.globalNav-2246', matched: 3, error: roleText ? null : 'keep-no-match' },
        ],
        matchedTotal: 4,
        valueCount: (label ? 1 : 0) + (roleText ? 1 : 0),
        complete: Boolean(label && roleText),
      };
    },
  };
}

async function setupAws({ settings = awsSettings(), rules = [], reader = awsReader(), random = () => 0.5 } = {}) {
  const ctx = await setup({ rules, reader, random });
  await ctx.storage.setAwsSettings(settings);
  await ctx.grouper.onRulesChanged();
  return ctx;
}

test('AWS: console tab is grouped by account and role with a random colour; same account/role joins', async () => {
  const reader = awsReader();
  const { tabs, tabGroups, grouper } = await setupAws({ reader, random: () => 0.99 });
  const a = tabs._add({ url: CONSOLE });
  reader.answers[a.id] = ['Acme Dev (123456789012)', 'AdminRole/jane'];
  const r = await grouper.evaluateTab(a);
  assert.equal(r.aws, true);
  assert.equal(r.pending, true);
  await grouper.idle();
  const gid = (await tabs.get(a.id)).groupId;
  assert.notEqual(gid, -1);
  const g = await tabGroups.get(gid);
  assert.equal(g.title, 'Acme Dev · AdminRole');
  assert.equal(g.color, 'orange', 'random colour (0.99 -> last)');
  assert.equal(reader.calls[0].opts.watch, false);
  assert.equal(reader.calls[0].fields[1].pickMatching, true);

  const b = tabs._add({ url: 'https://console.aws.amazon.com/s3/buckets' });
  reader.answers[b.id] = ['Acme Dev (123456789012)', 'AdminRole/jane'];
  await grouper.evaluateTab(b);
  await grouper.idle();
  assert.equal((await tabs.get(b.id)).groupId, gid, 'second console tab for the same account/role joined');
  assert.equal(grouper.getRecord()[1]['Acme Dev · AdminRole'].ruleId, 'aws-console');

  const c = tabs._add({ url: CONSOLE });
  reader.answers[c.id] = ['Prod (111111111111)', 'ReadOnly/jane'];
  await grouper.evaluateTab(c);
  await grouper.idle();
  assert.notEqual((await tabs.get(c.id)).groupId, gid);
  assert.equal((await tabGroups.get((await tabs.get(c.id)).groupId)).title, 'Prod · ReadOnly');
});

test('AWS: chosen fields and separator shape the title', async () => {
  const reader = awsReader();
  const { tabs, tabGroups, grouper } = await setupAws({
    reader,
    settings: awsSettings({ fields: { account: true, accountId: true, role: true, user: true, region: true }, separator: ' - ' }),
  });
  const a = tabs._add({ url: CONSOLE });
  reader.answers[a.id] = ['Acme Dev (123456789012)', 'AdminRole/jane'];
  await grouper.evaluateTab(a);
  await grouper.idle();
  assert.equal((await tabGroups.get((await tabs.get(a.id)).groupId)).title, 'Acme Dev - 123456789012 - AdminRole - jane - us-east-1');
});

test('AWS: partial read groups with what was found; nothing read means no group', async () => {
  const reader = awsReader();
  const { tabs, tabGroups, grouper, warnings } = await setupAws({ reader });
  const a = tabs._add({ url: CONSOLE });
  reader.answers[a.id] = ['Acme Dev (123456789012)', ''];
  await grouper.evaluateTab(a);
  await grouper.idle();
  assert.equal((await tabGroups.get((await tabs.get(a.id)).groupId)).title, 'Acme Dev');

  const b = tabs._add({ url: CONSOLE });
  reader.answers[b.id] = ['', ''];
  await grouper.evaluateTab(b);
  await grouper.idle();
  assert.equal((await tabs.get(b.id)).groupId, -1);
  assert.ok(warnings.some((w) => w.includes('none of the chosen fields')));
});

test('AWS: takes precedence over grouping rules; disabled falls back to rules; no access warns', async () => {
  const awsRule = grule({ id: 'aws-rule', regex: 'console\\.aws\\.amazon\\.com', titleTemplate: 'AWS', statusEnabled: false });
  {
    const reader = awsReader();
    const { tabs, tabGroups, grouper } = await setupAws({ reader, rules: [awsRule] });
    const a = tabs._add({ url: CONSOLE });
    reader.answers[a.id] = ['Dev (222222222222)', 'Admin/me'];
    await grouper.evaluateTab(a);
    await grouper.idle();
    assert.equal((await tabGroups.get((await tabs.get(a.id)).groupId)).title, 'Dev · Admin');
  }
  {
    const { tabs, tabGroups, grouper } = await setupAws({ settings: awsSettings({ enabled: false }), rules: [awsRule] });
    const a = tabs._add({ url: CONSOLE });
    const r = await grouper.evaluateTab(a);
    assert.equal(r.aws, undefined);
    assert.equal((await tabGroups.get(r.groupId)).title, 'AWS');
  }
  {
    const reader = awsReader({}, { access: false });
    const { tabs, grouper, warnings } = await setupAws({ reader });
    const a = tabs._add({ url: CONSOLE });
    const r = await grouper.evaluateTab(a);
    assert.deepEqual(r, { matched: true, aws: true, grouped: false, reason: 'no-access' });
    assert.ok(warnings.some((w) => w.includes('AWS console tab not grouped')));
    assert.equal(reader.calls.length, 0);
  }
});

test('AWS: tab that left the console or got pinned before the read finished is not grouped', async () => {
  const reader = awsReader();
  const { tabs, grouper } = await setupAws({ reader });
  const a = tabs._add({ url: CONSOLE });
  reader.answers[a.id] = ['Dev (222222222222)', 'Admin/me'];
  reader.read = async function (tabId, fields, opts) {
    tabs._update(a.id, { url: 'https://example.com' }); // navigated away during the read
    return awsReader({ [a.id]: ['Dev (222222222222)', 'Admin/me'] }).read(tabId, fields, opts);
  };
  await grouper.evaluateTab(a);
  await grouper.idle();
  assert.equal((await tabs.get(a.id)).groupId, -1);
});

test('AWS: testAws dry run reports fields and title; not-aws and access errors', async () => {
  const reader = awsReader();
  const { tabs, tabGroups, grouper } = await setupAws({ reader });
  const a = tabs._add({ url: CONSOLE });
  reader.answers[a.id] = ['Acme Dev (123456789012)', 'AdminRole/jane'];
  const r = await grouper.testAws(a);
  assert.equal(r.matched, true);
  assert.deepEqual(r.info, { account: 'Acme Dev', accountId: '123456789012', role: 'AdminRole', user: 'jane', region: 'us-east-1' });
  assert.equal(r.groupTitle, 'Acme Dev · AdminRole');
  assert.equal(r.finalTitle, 'Acme Dev · AdminRole');
  assert.equal(reader.calls[0].opts.timeoutMs, 3000);
  assert.deepEqual(tabGroups._all(), {}, 'dry run groups nothing');

  const override = await grouper.testAws(a, { enabled: true, fields: { account: false, accountId: true, role: true } });
  assert.equal(override.groupTitle, '123456789012 · AdminRole', 'unsaved settings can be tested');

  assert.equal((await grouper.testAws(tabs._add({ url: 'https://example.com' }))).error, 'not-aws');
  assert.equal((await grouper.testAws({ id: 1, url: 'chrome://extensions' })).error, 'browser-page');
  const noRead = tabs._add({ url: CONSOLE });
  assert.equal((await grouper.testAws(noRead)).error, 'read-failed');
  const { tabs: t2, grouper: g2 } = await setupAws({ reader: awsReader({}, { access: false }) });
  assert.equal((await g2.testAws(t2._add({ url: CONSOLE }))).error, 'access-not-granted');
});

test('applyToAll runs every open tab through the rules and reports counts', async () => {
  const { tabs, grouper } = await setup({ rules: [grule({ statusEnabled: false })] });
  tabs._add({ url: JIRA + 'ABC-1' });
  tabs._add({ url: JIRA + 'ABC-2' });
  tabs._add({ url: 'https://example.com' });
  tabs._add({ url: JIRA + 'ABC-3', pinned: true });
  const r = await grouper.applyToAll();
  assert.equal(r.tabs, 4);
  assert.equal(r.grouped, 2);
  assert.equal(r.pendingReads, 0);
});

test('colour by title gives the same colour to the same ticket in two windows', async () => {
  const { tabs, tabGroups, grouper } = await setup({ rules: [grule({ colorMode: 'title', statusEnabled: false })], random: () => 0.1 });
  const a = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-123' }));
  const b = await grouper.evaluateTab(tabs._add({ url: JIRA + 'ABC-123', windowId: 2 }));
  assert.equal((await tabGroups.get(a.groupId)).color, (await tabGroups.get(b.groupId)).color);
});
