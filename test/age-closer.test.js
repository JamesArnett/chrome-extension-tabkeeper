import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgeCloser,
  normalizeCloseSettings,
  defaultCloseSettings,
  limitMs,
  describeLimit,
  decideClose,
  exemptionReason,
  AGE_RULE_IDS,
} from '../src/age-closer.js';
import { createStorage } from '../src/storage.js';
import { createChromeStorage, createTabs, createClock } from './helpers/chrome-mock.js';

const H = 3_600_000;
const D = 24 * H;

test('settings normalise with sane fallbacks', () => {
  const d = defaultCloseSettings();
  assert.equal(d.maxOpen.enabled, false);
  const s = normalizeCloseSettings({ maxOpen: { enabled: true, value: '3', unit: 'weeks' }, maxIdle: { enabled: true, value: 0 } });
  assert.equal('countdownGroupsAtEnd' in s, false, 'superseded option is dropped');
  assert.deepEqual(s.maxOpen, { enabled: true, value: 3, unit: 'hours' }, 'numeric string accepted, unknown unit falls back');
  assert.deepEqual(s.maxIdle, { enabled: true, value: 2, unit: 'days' }, 'zero falls back');
  assert.equal(normalizeCloseSettings({ maxOpen: { enabled: true, value: 45, unit: 'minutes' } }).maxOpen.value, 45);
});

test('limitMs and describeLimit', () => {
  assert.equal(limitMs({ enabled: false, value: 5, unit: 'hours' }), 0);
  assert.equal(limitMs({ enabled: true, value: 2, unit: 'days' }), 2 * D);
  assert.equal(limitMs({ enabled: true, value: 1, unit: 'minutes' }), 60_000);
  assert.equal(describeLimit({ value: 1, unit: 'days' }), '1 day');
  assert.equal(describeLimit({ value: 30, unit: 'minutes' }), '30 minutes');
});

test('decideClose: open limit, idle limit from lastAccessed, neither', () => {
  const settings = normalizeCloseSettings({ maxOpen: { enabled: true, value: 8, unit: 'hours' }, maxIdle: { enabled: true, value: 2, unit: 'days' } });
  const now = 10 * D;
  assert.equal(decideClose({ lastAccessed: now }, { now, firstSeen: now - 9 * H, settings }), 'open');
  assert.equal(decideClose({ lastAccessed: now - 3 * D }, { now, firstSeen: now - H, settings }), 'idle');
  assert.equal(decideClose({ lastAccessed: now - H }, { now, firstSeen: now - H, settings }), null);
  assert.equal(decideClose({}, { now, firstSeen: now - 3 * D, settings: normalizeCloseSettings({ maxIdle: { enabled: true, value: 2, unit: 'days' } }) }), 'idle', 'no lastAccessed: idle counts from first seen');
  assert.equal(decideClose({ lastAccessed: now - 3 * D }, { now, firstSeen: now - 3 * D, settings: defaultCloseSettings() }), null, 'both disabled');
});

test('exemptions: pinned, active, audible, pending close, blocked', () => {
  assert.equal(exemptionReason({ id: 1, pinned: true }), 'pinned');
  assert.equal(exemptionReason({ id: 1, active: true }), 'active');
  assert.equal(exemptionReason({ id: 1, audible: true }), 'audible');
  assert.equal(exemptionReason({ id: 1 }, { isPendingClose: () => true }), 'pending-close');
  assert.equal(exemptionReason({ id: 1 }, { blocked: new Set([1]) }), 'unsaved-input');
  assert.equal(exemptionReason({ id: 1 }), null);
});

for (const [name, change] of Object.entries({
  active: async ({ tabs, tab }) => tabs._update(tab.id, { active: true }),
  pinned: async ({ tabs, tab }) => tabs._update(tab.id, { pinned: true }),
  audible: async ({ tabs, tab }) => tabs._update(tab.id, { audible: true }),
  'recently used': async ({ tabs, tab, clock }) => tabs._update(tab.id, { lastAccessed: clock.now() }),
  paused: async ({ storage }) => storage.setPaused(true),
  'age closing disabled': async ({ storage }) => storage.setCloseSettings(defaultCloseSettings()),
  'never-close entry added': async ({ storage }) => storage.setCloseSettings({ maxIdle: { enabled: true, value: 1, unit: 'minutes' }, neverClose: ['protected.example'] }),
})) {
  test(`sweep preserves a later tab when it becomes ${name} during the sweep`, async () => {
    const ctx = await setup({ settings: { maxIdle: { enabled: true, value: 1, unit: 'minutes' } } });
    const { tabs, clock, sweep } = ctx;
    const first = tabs._add({ url: 'https://old.example', lastAccessed: clock.now() - H });
    const tab = tabs._add({ url: 'https://protected.example', lastAccessed: clock.now() - H });
    const remove = tabs.remove;
    tabs.remove = async (id) => {
      await remove(id);
      if (id === first.id) await change({ ...ctx, tab });
    };
    const result = await sweep();
    assert.deepEqual(result.closed.map((e) => e.tabId), [first.id]);
    assert.equal(tabs._has(tab.id), true);
  });
}

async function setup({ settings, paused = false } = {}) {
  const chromeStorage = createChromeStorage();
  const storage = createStorage(chromeStorage);
  await storage.setCloseSettings(settings ?? { maxOpen: { enabled: true, value: 8, unit: 'hours' }, maxIdle: { enabled: true, value: 2, unit: 'days' } });
  await storage.setPaused(paused);
  const tabs = createTabs([]);
  const clock = createClock(100 * D);
  const warnings = [];
  const closer = createAgeCloser({
    storage,
    tabs,
    now: clock.now,
    setTimeout: clock.setTimeout,
    isPendingClose: (id) => id === 999,
    logger: { warn: (...a) => warnings.push(a.join(' ')), error: () => {} },
  });
  await closer.start();
  /** Run a sweep while advancing the fake clock past the confirmation delays. */
  const sweep = async () => {
    const p = closer.sweep();
    for (let i = 0; i < 20; i++) await clock.advance(1500);
    return p;
  };
  return { storage, tabs, clock, closer, sweep, warnings };
}

test('first sweep records first-seen for existing tabs and closes nothing; later sweeps close old tabs and log them', async () => {
  const { tabs, clock, closer, sweep, storage } = await setup();
  const a = tabs._add({ title: 'Old doc', url: 'https://docs.example/a', lastAccessed: clock.now() });
  const b = tabs._add({ title: 'Fresh', url: 'https://b.example', lastAccessed: clock.now() });
  const r1 = await sweep();
  assert.deepEqual(r1.closed, []);
  assert.deepEqual(Object.keys(closer.getFirstSeen()).sort(), [String(a.id), String(b.id)]);

  await clock.advance(9 * H);
  tabs._update(b.id, { lastAccessed: clock.now() });
  // b is as old as a but was just used; only the open limit matters, and it hits both... so make b newer.
  await closer.noteRemoved(b.id);
  await closer.noteCreated(b.id);
  const r2 = await sweep();
  assert.deepEqual(r2.closed, [{ tabId: a.id, why: 'open' }]);
  assert.equal(tabs._has(a.id), false);
  assert.equal(tabs._has(b.id), true);
  const log = await storage.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].ruleId, AGE_RULE_IDS.open);
  assert.equal(log[0].ruleName, 'Open longer than 8 hours');
  assert.equal(log[0].title, 'Old doc');
  assert.equal(String(a.id) in closer.getFirstSeen(), false, 'first-seen entry dropped after close');
});

test('idle limit uses lastAccessed; exempt tabs survive', async () => {
  const { tabs, clock, sweep, storage } = await setup({ settings: { maxIdle: { enabled: true, value: 2, unit: 'days' } } });
  const stale = tabs._add({ title: 'stale', lastAccessed: clock.now() - 3 * D });
  const pinned = tabs._add({ title: 'pinned', pinned: true, lastAccessed: clock.now() - 3 * D });
  const active = tabs._add({ title: 'active', active: true, lastAccessed: clock.now() - 3 * D });
  const audible = tabs._add({ title: 'music', audible: true, lastAccessed: clock.now() - 3 * D });
  const pending = tabs._add({ id: 999, title: 'rule countdown', lastAccessed: clock.now() - 3 * D });
  const recent = tabs._add({ title: 'recent', lastAccessed: clock.now() - H });
  const r = await sweep();
  assert.deepEqual(r.closed, [{ tabId: stale.id, why: 'idle' }]);
  for (const t of [pinned, active, audible, pending, recent]) assert.equal(tabs._has(t.id), true, t.title);
  assert.equal((await storage.getLog())[0].ruleName, 'Not used for 2 days');
});

test('a tab that resists closing is marked exempt and never retried', async () => {
  const { tabs, clock, closer, sweep, warnings } = await setup({ settings: { maxIdle: { enabled: true, value: 1, unit: 'hours' } } });
  const form = tabs._add({ title: 'unsaved form', sticky: true, lastAccessed: clock.now() - 2 * H });
  const r = await sweep();
  assert.deepEqual(r.closed, []);
  assert.deepEqual(r.blocked, [form.id]);
  assert.equal(closer.isBlocked(form.id), true);
  assert.ok(warnings.some((w) => w.includes('resisted closing')));
  const again = await sweep();
  assert.deepEqual(again.blocked, [], 'not retried');
  assert.equal(tabs._removed.length, 0);
});

test('paused: nothing closes; disabled limits: nothing closes but first-seen is still tracked', async () => {
  {
    const { tabs, clock, sweep } = await setup({ paused: true });
    tabs._add({ lastAccessed: clock.now() - 10 * D });
    const r = await sweep();
    assert.equal(r.skipped, 'paused');
  }
  {
    const { tabs, clock, closer, sweep } = await setup({ settings: {} });
    const t = tabs._add({ lastAccessed: clock.now() - 10 * D });
    const r = await sweep();
    assert.deepEqual(r.closed, []);
    assert.ok(String(t.id) in closer.getFirstSeen());
  }
});

test('first-seen survives a worker restart via session storage; removed tabs are forgotten', async () => {
  const chromeStorage = createChromeStorage();
  const storage = createStorage(chromeStorage);
  await storage.setCloseSettings({ maxOpen: { enabled: true, value: 1, unit: 'hours' } });
  const tabs = createTabs([]);
  const clock = createClock(100 * D);
  const mk = () => createAgeCloser({ storage, tabs, now: clock.now, setTimeout: clock.setTimeout, logger: { warn() {}, error() {} } });
  const c1 = mk();
  await c1.start();
  const a = tabs._add({ lastAccessed: clock.now() });
  await c1.noteCreated(a.id);
  await clock.advance(2 * H);
  const c2 = mk();
  await c2.start();
  assert.equal(c2.getFirstSeen()[a.id], clock.now() - 2 * H, 'timestamp restored');
  const p = c2.sweep();
  await clock.advance(1500);
  const r = await p;
  assert.deepEqual(r.closed, [{ tabId: a.id, why: 'open' }]);
  await c2.noteRemoved(12345);
  assert.deepEqual(Object.keys(c2.getFirstSeen()), []);
});

test('settings changes are picked up without restart', async () => {
  const { tabs, clock, closer, sweep, storage } = await setup({ settings: {} });
  const t = tabs._add({ lastAccessed: clock.now() - 10 * D });
  await sweep();
  assert.equal(tabs._has(t.id), true);
  await storage.setCloseSettings({ maxIdle: { enabled: true, value: 1, unit: 'days' } });
  await closer.onSettingsChanged();
  await sweep();
  assert.equal(tabs._has(t.id), false);
});

test('never-close list: parsed from lines, matched against URL and title, exempts from age closing', async () => {
  const { parseNeverClose, matchesNeverClose } = await import('../src/age-closer.js');
  assert.deepEqual(parseNeverClose('  mail.example.com \n\nGitLab\nmail.EXAMPLE.com\n'), ['mail.example.com', 'GitLab']);
  assert.equal(parseNeverClose('').length, 0);
  assert.equal(matchesNeverClose({ url: 'https://mail.example.com/inbox', title: 'Inbox' }, ['mail.example.com']), true);
  assert.equal(matchesNeverClose({ url: 'https://x.example', title: 'My GitLab board' }, ['gitlab']), true, 'title, case-insensitive');
  assert.equal(matchesNeverClose({ url: 'https://x.example', title: 'y' }, ['gitlab']), false);
  assert.equal(matchesNeverClose({ url: 'https://x.example', title: 'y' }, []), false);

  const settings = normalizeCloseSettings({ maxIdle: { enabled: true, value: 1, unit: 'hours' }, neverClose: ['calendar', '', 'calendar'] });
  assert.deepEqual(settings.neverClose, ['calendar']);
  assert.equal(settings.collapseClosingGroup, true, 'collapse defaults on');
  assert.equal(exemptionReason({ id: 1, url: 'https://calendar.example/', title: 'x' }, { neverClose: settings.neverClose }), 'never-close');

  const { tabs, clock, sweep, storage } = await setup({ settings: { maxIdle: { enabled: true, value: 1, unit: 'hours' }, neverClose: ['keep-me'] } });
  const protectedTab = tabs._add({ title: 'keep-me please', lastAccessed: clock.now() - 3 * H });
  const other = tabs._add({ title: 'other', lastAccessed: clock.now() - 3 * H });
  const r = await sweep();
  assert.deepEqual(r.closed, [{ tabId: other.id, why: 'idle' }]);
  assert.equal(tabs._has(protectedTab.id), true);
  void storage;
});
