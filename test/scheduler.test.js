import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, ALARM_PREFIX, GROUP_ALARM_PREFIX, GROUP_COLOR, CLOSING_GROUP_TITLE } from '../src/scheduler.js';
import { createStorage } from '../src/storage.js';
import {
  createChromeStorage,
  createTabs,
  createAlarms,
  createClock,
  createTabGroups,
} from './helpers/chrome-mock.js';

const rule = (id, overrides = {}) => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  title: { mode: 'contains', pattern: id, caseSensitive: false },
  url: null,
  delaySeconds: 5,
  createdAt: 0,
  ...overrides,
});

test('a surviving tab is kept for the triggering rule, released from Closing and never logged', async () => {
  const { tabs, scheduler, storage, clock } = await setup({ rules: [rule('sticky')] });
  const tab = tabs._add({ title: 'sticky', url: 'https://example.com/form', sticky: true });
  await scheduler.evaluateTab(tab);
  await clock.advance(6500);
  await scheduler.idle();
  assert.ok(await tabs.get(tab.id));
  assert.equal((await tabs.get(tab.id)).groupId, -1);
  assert.equal(scheduler.getPending()[tab.id], undefined);
  assert.deepEqual(scheduler.getKept()[tab.id], ['sticky']);
  assert.deepEqual(await storage.getLog(), []);
  await scheduler.rescanAll();
  assert.equal(scheduler.getPending()[tab.id], undefined);
  const restarted = createScheduler({ storage, tabs, alarms: createAlarms(), now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await restarted.start();
  assert.equal(restarted.getPending()[tab.id], undefined);
  await restarted.onTabRemoved(tab.id);
  assert.equal(restarted.getKept()[tab.id], undefined);
});

test('a tab that closes during confirmation is logged exactly once', async () => {
  const { tabs, scheduler, storage, clock } = await setup({ rules: [rule('delayed')] });
  const tab = tabs._add({ title: 'delayed', sticky: true });
  await scheduler.evaluateTab(tab);
  clock.setTimeout(() => tabs._close(tab.id), 5500);
  await clock.advance(6500);
  await scheduler.idle();
  assert.equal((await storage.getLog()).length, 1);
  assert.equal(scheduler.getKept()[tab.id], undefined);
});

test('a rejected close attempt exempts that rule and releases its Closing group', async () => {
  const { tabs, scheduler, storage, clock } = await setup({ rules: [rule('rejected')] });
  const tab = tabs._add({ title: 'rejected' });
  await scheduler.evaluateTab(tab);
  tabs.remove = async () => { throw new Error('Close cancelled'); };
  await clock.advance(5000);
  await scheduler.idle();
  assert.equal((await tabs.get(tab.id)).groupId, -1);
  assert.deepEqual(scheduler.getKept()[tab.id], ['rejected']);
  assert.deepEqual(await storage.getLog(), []);
  await scheduler.rescanAll();
  assert.equal(scheduler.getPending()[tab.id], undefined);
});

async function setup({ rules = [], tabs: initialTabs = [], paused = false, groups = true } = {}) {
  const chromeStorage = createChromeStorage();
  const storage = createStorage(chromeStorage);
  await storage.saveRules(rules);
  await storage.setPaused(paused);
  const tabGroups = groups ? createTabGroups() : null;
  const tabs = createTabs(initialTabs, tabGroups);
  const alarms = createAlarms();
  const clock = createClock();
  const logger = { error: (...a) => { throw new Error(a.join(' ')); }, warn: () => {} };
  const scheduler = createScheduler({
    storage,
    tabs,
    alarms,
    tabGroups,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    logger,
  });
  await scheduler.start();
  return { chromeStorage, storage, tabs, alarms, clock, scheduler, tabGroups };
}

test('matching tab closes after its delay and is logged', async () => {
  const { tabs, clock, scheduler, storage } = await setup({ rules: [rule('zoom')] });
  const tab = tabs._add({ title: 'Launch Meeting - Zoom', url: 'https://zoom.us/j/1' });
  await scheduler.evaluateTab(tab);
  assert.ok(scheduler.getPending()[tab.id]);

  await clock.advance(4999);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), true);

  await clock.advance(1);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), false);
  assert.deepEqual(scheduler.getPending(), {});
  const log = await storage.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].ruleId, 'zoom');
  assert.equal(log[0].title, 'Launch Meeting - Zoom');
});

test('delay 0 closes on the next tick', async () => {
  const { tabs, clock, scheduler } = await setup({ rules: [rule('x', { delaySeconds: 0 })] });
  const tab = tabs._add({ title: 'x' });
  await scheduler.evaluateTab(tab);
  await clock.advance(0);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), false);
});

test('non-matching tabs are ignored', async () => {
  const { tabs, clock, scheduler } = await setup({ rules: [rule('zoom')] });
  const tab = tabs._add({ title: 'GitHub' });
  await scheduler.evaluateTab(tab);
  assert.deepEqual(scheduler.getPending(), {});
  await clock.advance(10_000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), true);
});

test('a queued stale tab snapshot cannot cancel a currently matching countdown', async () => {
  const { tabs, scheduler, clock } = await setup({ rules: [rule('zoom')] });
  const old = tabs._add({ title: 'Loading' });
  const current = tabs._update(old.id, { title: 'zoom ready' });
  await scheduler.evaluateTab(current);
  const deadline = scheduler.getPending()[old.id].deadline;
  await scheduler.evaluateTab(old);
  assert.equal(scheduler.getPending()[old.id].deadline, deadline);
  await clock.advance(5000);
  await scheduler.idle();
  assert.equal(tabs._has(old.id), false);
});

test('a queued matching snapshot cannot schedule a tab that has navigated away', async () => {
  const { tabs, scheduler } = await setup({ rules: [rule('zoom')] });
  const old = tabs._add({ title: 'zoom' });
  tabs._update(old.id, { title: 'Work' });
  await scheduler.evaluateTab(old);
  assert.deepEqual(scheduler.getPending(), {});
});

test('timer is not reset when the same rule keeps matching, but the snapshot is refreshed', async () => {
  const { tabs, clock, scheduler } = await setup({ rules: [rule('zoom')] });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  const deadline = scheduler.getPending()[tab.id].deadline;
  await clock.advance(3000);
  await scheduler.evaluateTab(tabs._update(tab.id, { title: 'zoom - loading' }));
  assert.equal(scheduler.getPending()[tab.id].deadline, deadline);
  assert.equal(scheduler.getPending()[tab.id].title, 'zoom - loading');
  await clock.advance(2000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), false);
});

test('pending close is cancelled when the tab stops matching', async () => {
  const { tabs, clock, scheduler } = await setup({ rules: [rule('zoom')] });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  await scheduler.evaluateTab(tabs._update(tab.id, { title: 'Something else' }));
  assert.deepEqual(scheduler.getPending(), {});
  await clock.advance(10_000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), true);
});

test('fire re-checks the tab: a stale pending entry does not close a changed tab', async () => {
  const { tabs, clock, scheduler } = await setup({ rules: [rule('zoom')] });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  tabs._update(tab.id, { title: 'changed without an event' });
  await clock.advance(5000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), true);
  assert.deepEqual(scheduler.getPending(), {});
});

test('switching to a different matching rule restarts the countdown with that rule', async () => {
  const { tabs, clock, scheduler } = await setup({
    rules: [rule('a', { delaySeconds: 5 }), rule('b', { delaySeconds: 20 })],
  });
  const tab = tabs._add({ title: 'a' });
  await scheduler.evaluateTab(tab);
  await clock.advance(3000);
  await scheduler.evaluateTab(tabs._update(tab.id, { title: 'b' }));
  const entry = scheduler.getPending()[tab.id];
  assert.equal(entry.ruleId, 'b');
  assert.equal(entry.deadline, clock.now() + 20_000);
  await clock.advance(19_999);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), true);
  await clock.advance(1);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), false);
});

test('first rule in order wins when several match', async () => {
  const { tabs, scheduler } = await setup({
    rules: [rule('first', { title: { mode: 'contains', pattern: 'zoom', caseSensitive: false } }), rule('zoom')],
  });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  assert.equal(scheduler.getPending()[tab.id].ruleId, 'first');
});

test('disabled rules never fire', async () => {
  const { tabs, scheduler } = await setup({ rules: [rule('zoom', { enabled: false })] });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  assert.deepEqual(scheduler.getPending(), {});
});

test('pinned tabs are exempt, including when pinned mid-countdown', async () => {
  const { tabs, clock, scheduler } = await setup({ rules: [rule('zoom')] });
  const pinned = tabs._add({ title: 'zoom', pinned: true });
  await scheduler.evaluateTab(pinned);
  assert.deepEqual(scheduler.getPending(), {});

  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  assert.ok(scheduler.getPending()[tab.id]);
  await scheduler.evaluateTab(tabs._update(tab.id, { pinned: true }));
  assert.deepEqual(scheduler.getPending(), {});

  // Pinned without an event reaching us: fire() must still refuse.
  const sneaky = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(sneaky);
  tabs._update(sneaky.id, { pinned: true });
  await clock.advance(5000);
  await scheduler.idle();
  assert.equal(tabs._has(sneaky.id), true);
});

test('long delays use chrome.alarms and fire via handleAlarm', async () => {
  const { tabs, clock, alarms, scheduler } = await setup({ rules: [rule('zoom', { delaySeconds: 60 })] });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  assert.deepEqual(alarms._names(), [ALARM_PREFIX + tab.id]);
  assert.equal(clock.pendingTimers(), 0, 'no close timer (and no ticker)');

  await clock.advance(60_000);
  const due = alarms._due(clock.now());
  assert.equal(due.length, 1);
  await scheduler.handleAlarm(due[0]);
  assert.equal(tabs._has(tab.id), false);
});

test('cancel clears timers and alarms', async () => {
  const { tabs, clock, alarms, scheduler } = await setup({
    rules: [rule('short', { delaySeconds: 5 }), rule('long', { delaySeconds: 120 })],
  });
  const a = tabs._add({ title: 'short' });
  const b = tabs._add({ title: 'long' });
  await scheduler.evaluateTab(a);
  await scheduler.evaluateTab(b);
  assert.equal(await scheduler.cancel(a.id), true);
  assert.equal(await scheduler.cancel(b.id), true);
  assert.equal(await scheduler.cancel(b.id), false);
  assert.equal(clock.pendingTimers(), 0);
  assert.deepEqual(alarms._names(), []);
  await clock.advance(200_000);
  await scheduler.idle();
  assert.equal(tabs._has(a.id), true);
  assert.equal(tabs._has(b.id), true);
});

test('onTabRemoved drops the pending entry; a tab closed by the user is not logged', async () => {
  const { tabs, clock, scheduler, storage } = await setup({ rules: [rule('zoom')] });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  tabs._close(tab.id);
  await scheduler.onTabRemoved(tab.id);
  assert.deepEqual(scheduler.getPending(), {});
  await clock.advance(5000);
  await scheduler.idle();
  assert.deepEqual(await storage.getLog(), []);
});

test('start() rescans already-open tabs', async () => {
  const { tabs, clock, scheduler } = await setup({
    rules: [rule('zoom')],
    tabs: [{ title: 'zoom' }, { title: 'other' }, { title: 'zoom', pinned: true }],
  });
  assert.deepEqual(Object.keys(scheduler.getPending()), ['1']);
  await clock.advance(5000);
  await scheduler.idle();
  assert.equal(tabs._has(1), false);
  assert.equal(tabs._has(2), true);
  assert.equal(tabs._has(3), true);
});

test('a new worker instance restores persisted pending timers and fires overdue ones', async () => {
  const chromeStorage = createChromeStorage();
  const storage = createStorage(chromeStorage);
  await storage.saveRules([rule('zoom', { delaySeconds: 60 })]);
  const tabs = createTabs([{ title: 'zoom' }, { title: 'zoom' }]);
  const clock = createClock();
  // Simulate state left behind by a previous worker: tab 1 overdue, tab 2 with 10s left, tab 99 gone.
  await storage.setPending({
    1: { ruleId: 'zoom', ruleName: 'Rule zoom', deadline: clock.now() - 1000, title: 'zoom', url: '' },
    2: { ruleId: 'zoom', ruleName: 'Rule zoom', deadline: clock.now() + 10_000, title: 'zoom', url: '' },
    99: { ruleId: 'zoom', ruleName: 'Rule zoom', deadline: clock.now() + 10_000, title: 'zoom', url: '' },
  });
  const alarms = createAlarms();
  const scheduler = createScheduler({
    storage, tabs, alarms, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    logger: { error: (...a) => { throw new Error(a.join(' ')); }, warn: () => {} },
  });
  await scheduler.start();
  assert.deepEqual(Object.keys(scheduler.getPending()).sort(), ['1', '2']);
  assert.equal(scheduler.getPending()[2].deadline, clock.now() + 10_000, 'remaining time preserved, not reset to 60s');

  await clock.advance(0);
  await scheduler.idle();
  assert.equal(tabs._has(1), false, 'overdue tab closed immediately');
  assert.equal(tabs._has(2), true);
  await clock.advance(10_000);
  await scheduler.idle();
  assert.equal(tabs._has(2), false);
});

test('pausing clears pending closes; unpausing rescans', async () => {
  const { tabs, clock, scheduler } = await setup({ rules: [rule('zoom')] });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  await scheduler.setPaused(true);
  assert.deepEqual(scheduler.getPending(), {});
  await scheduler.evaluateTab(tab);
  assert.deepEqual(scheduler.getPending(), {}, 'no scheduling while paused');
  await clock.advance(10_000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), true);

  await scheduler.setPaused(false);
  assert.ok(scheduler.getPending()[tab.id], 'rescan on unpause');
  await clock.advance(5000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), false);
});

test('starting paused schedules nothing', async () => {
  const { scheduler } = await setup({ rules: [rule('zoom')], tabs: [{ title: 'zoom' }], paused: true });
  assert.deepEqual(scheduler.getPending(), {});
  assert.equal(scheduler.isPaused(), true);
});

test('onRulesChanged picks up new rules and cancels closes for deleted or disabled rules', async () => {
  const { tabs, storage, scheduler } = await setup({ rules: [rule('a'), rule('b')] });
  const ta = tabs._add({ title: 'a' });
  const tb = tabs._add({ title: 'b' });
  const tc = tabs._add({ title: 'c' });
  await scheduler.rescanAll();
  assert.deepEqual(Object.keys(scheduler.getPending()).sort(), [String(ta.id), String(tb.id)]);

  await storage.deleteRule('a');
  await storage.saveRule(rule('b', { enabled: false }));
  await storage.saveRule(rule('c'));
  await scheduler.onRulesChanged();
  assert.deepEqual(Object.keys(scheduler.getPending()), [String(tc.id)]);
});

test('onTabReplaced moves evaluation to the new tab id', async () => {
  const { tabs, scheduler } = await setup({ rules: [rule('zoom')] });
  const old = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(old);
  tabs._close(old.id);
  const fresh = tabs._add({ title: 'zoom' });
  await scheduler.onTabReplaced(fresh.id, old.id);
  assert.deepEqual(Object.keys(scheduler.getPending()), [String(fresh.id)]);
});

test('fire on an unknown tab id is a no-op', async () => {
  const { scheduler } = await setup({ rules: [rule('zoom')] });
  assert.deepEqual(await scheduler.fire(12345), { closed: false, reason: 'not-pending' });
  await scheduler.handleAlarm({ name: 'unrelated' });
  await scheduler.handleAlarm({ name: ALARM_PREFIX + 'abc' });
});

// ---------------- the Closing group ----------------

test('pending tabs share one red "Closing" group per window, kept at the end of the strip', async () => {
  const { tabs, tabGroups, scheduler } = await setup({ rules: [rule('zoom')] });
  tabs._add({ title: 'first' });
  const a = tabs._add({ title: 'zoom a' });
  tabs._add({ title: 'other' });
  const b = tabs._add({ title: 'zoom b' });
  await scheduler.evaluateTab(a);
  const gid = scheduler.getPending()[a.id].groupId;
  assert.ok(gid != null);
  const g = await tabGroups.get(gid);
  assert.equal(g.title, CLOSING_GROUP_TITLE);
  assert.equal(g.color, GROUP_COLOR);
  assert.deepEqual(tabGroups._groupMoves.at(-1), { groupId: gid, index: -1 }, 'moved to the end');

  await scheduler.evaluateTab(b);
  assert.equal(scheduler.getPending()[b.id].groupId, gid, 'second pending tab joins the same group');
  assert.equal((await tabs.get(b.id)).groupId, gid);
  assert.equal(Object.keys(tabGroups._all()).length, 1);
  assert.equal(tabGroups._groupMoves.length, 2, 'group re-anchored at the end when a tab is added');

  const c = tabs._add({ title: 'zoom c', windowId: 2 });
  await scheduler.evaluateTab(c);
  assert.notEqual(scheduler.getPending()[c.id].groupId, gid, 'other window gets its own Closing group');
});

test('no countdown in the group title: it stays "Closing" as time passes', async () => {
  const { tabs, tabGroups, scheduler, clock } = await setup({ rules: [rule('zoom')] });
  const a = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(a);
  const gid = scheduler.getPending()[a.id].groupId;
  await clock.advance(3000);
  await scheduler.idle();
  assert.equal((await tabGroups.get(gid)).title, CLOSING_GROUP_TITLE);
  assert.equal(clock.pendingTimers(), 1, 'only the close timer');
  await clock.advance(2000);
  await scheduler.idle();
  assert.equal(tabs._has(a.id), false);
  assert.deepEqual(tabGroups._all(), {}, 'empty Closing group removed by Chrome');
});

test('cancel returns the tab to its former group, or its former position, and the group recreates later', async () => {
  const { tabs, tabGroups, scheduler } = await setup({ rules: [rule('zoom')] });
  tabs._add({ title: 'first' });
  const loose = tabs._add({ title: 'zoom loose' });
  const home = tabGroups._create();
  const homed = tabs._add({ title: 'zoom homed', groupId: home });
  tabs._add({ title: 'sibling', groupId: home });
  await scheduler.evaluateTab(loose);
  await scheduler.evaluateTab(homed);
  const gid = scheduler.getPending()[loose.id].groupId;
  assert.equal(scheduler.getPending()[loose.id].prevIndex, 1);

  await scheduler.evaluateTab(tabs._update(loose.id, { title: 'no match' }));
  assert.equal((await tabs.get(loose.id)).groupId, -1);
  assert.deepEqual(tabs._moves, [{ tabId: loose.id, index: 1 }], 'back to its old position');

  assert.equal(await scheduler.cancel(homed.id), true);
  assert.equal((await tabs.get(homed.id)).groupId, home, 'back in its old group');
  assert.equal(tabGroups._exists(gid), false, 'Closing group gone once empty');

  const again = tabs._add({ title: 'zoom again' });
  await scheduler.evaluateTab(again);
  const gid2 = scheduler.getPending()[again.id].groupId;
  assert.notEqual(gid2, gid, 'a fresh Closing group is created');
  assert.equal((await tabGroups.get(gid2)).title, CLOSING_GROUP_TITLE);
});

test('switching rules keeps the tab in the Closing group', async () => {
  const { tabs, scheduler } = await setup({ rules: [rule('a', { delaySeconds: 5 }), rule('b', { delaySeconds: 90 })] });
  const tab = tabs._add({ title: 'a' });
  await scheduler.evaluateTab(tab);
  const gid = scheduler.getPending()[tab.id].groupId;
  await scheduler.evaluateTab(tabs._update(tab.id, { title: 'b' }));
  assert.equal(scheduler.getPending()[tab.id].groupId, gid);
  assert.equal(scheduler.getPending()[tab.id].ruleId, 'b');
});

test('an existing "Closing" group is adopted by title after a restart; the session record is reused otherwise', async () => {
  const chromeStorage = createChromeStorage();
  const storage = createStorage(chromeStorage);
  await storage.saveRules([rule('zoom')]);
  const tabGroups = createTabGroups();
  const tabs = createTabs([], tabGroups);
  const clock = createClock();
  const logger = { error: (...a) => { throw new Error(a.join(' ')); }, warn: () => {} };
  const mk = () => createScheduler({ storage, tabs, alarms: createAlarms(), tabGroups, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, logger });

  // Hand-made group titled Closing (e.g. left over from a previous browser session).
  const other = tabs._add({ title: 'x' });
  const leftover = tabGroups._handMade(1, CLOSING_GROUP_TITLE, other);
  const s1 = mk();
  await s1.start();
  const a = tabs._add({ title: 'zoom' });
  await s1.evaluateTab(a);
  assert.equal(s1.getPending()[a.id].groupId, leftover, 'adopted by title');

  // New worker instance: record in session storage points at the same group.
  const s2 = mk();
  await s2.start();
  const b = tabs._add({ title: 'zoom too' });
  await s2.evaluateTab(b);
  assert.equal(s2.getPending()[b.id].groupId, leftover);
  assert.equal(Object.keys(tabGroups._all()).length, 1);
});

test('grouping failure (e.g. popup window) does not prevent the close', async () => {
  const { tabs, clock, scheduler } = await setup({ rules: [rule('zoom')] });
  const tab = tabs._add({ title: 'zoom', windowType: 'popup' });
  await scheduler.evaluateTab(tab);
  assert.equal(scheduler.getPending()[tab.id].groupId, null);
  await clock.advance(5000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), false);
});

test('without the tabGroups API nothing is grouped', async () => {
  const { tabs, clock, scheduler } = await setup({ rules: [rule('zoom')], groups: false });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  assert.equal(scheduler.getPending()[tab.id].groupId, null);
  await clock.advance(5000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), false);
});

test('pausing releases every tab from the Closing group; unpausing regroups', async () => {
  const { tabs, scheduler, tabGroups } = await setup({ rules: [rule('zoom')] });
  const a = tabs._add({ title: 'zoom a' });
  const b = tabs._add({ title: 'zoom b' });
  await scheduler.evaluateTab(a);
  await scheduler.evaluateTab(b);
  await scheduler.setPaused(true);
  assert.equal((await tabs.get(a.id)).groupId, -1);
  assert.equal((await tabs.get(b.id)).groupId, -1);
  assert.deepEqual(tabGroups._all(), {});
  await scheduler.setPaused(false);
  assert.ok(scheduler.getPending()[a.id].groupId != null);
  assert.equal(scheduler.getPending()[a.id].groupId, scheduler.getPending()[b.id].groupId);
});

// ---------------- grace before grouping ----------------

test('long grouping grace wakes via an alarm and keeps the original close deadline', async () => {
  const { tabs, alarms, clock, scheduler } = await setup({ rules: [rule('login', { delaySeconds: 120, groupAfterSeconds: 45 })] });
  const tab = tabs._add({ title: 'login' });
  const started = clock.now();
  await scheduler.evaluateTab(tab);
  assert.equal(clock.pendingTimers(), 0, 'no in-memory timer needed');
  assert.equal(alarms._get(GROUP_ALARM_PREFIX + tab.id).scheduledTime, started + 45_000);
  await clock.advance(45_000);
  await scheduler.handleAlarm(alarms._get(GROUP_ALARM_PREFIX + tab.id));
  assert.notEqual((await tabs.get(tab.id)).groupId, -1);
  assert.equal(scheduler.getPending()[tab.id].deadline, started + 120_000);
  await clock.advance(75_000);
  await scheduler.handleAlarm(alarms._get(ALARM_PREFIX + tab.id));
  assert.equal(tabs._has(tab.id), false);
  assert.deepEqual(alarms._names(), []);
});

test('cancelling a long grace clears both alarms; a stale grouping alarm does nothing', async () => {
  const { tabs, alarms, scheduler } = await setup({ rules: [rule('login', { delaySeconds: 120, groupAfterSeconds: 45 })] });
  const tab = tabs._add({ title: 'login' });
  await scheduler.evaluateTab(tab);
  const alarm = alarms._get(GROUP_ALARM_PREFIX + tab.id);
  await scheduler.cancel(tab.id);
  assert.deepEqual(alarms._names(), []);
  await scheduler.handleAlarm(alarm);
  assert.equal((await tabs.get(tab.id)).groupId, -1);
});

test('late grouping alarm closes an overdue tab instead of grouping it', async () => {
  const { tabs, alarms, clock, scheduler } = await setup({ rules: [rule('login', { delaySeconds: 120, groupAfterSeconds: 45 })] });
  const tab = tabs._add({ title: 'login' });
  await scheduler.evaluateTab(tab);
  const alarm = alarms._get(GROUP_ALARM_PREFIX + tab.id);
  await clock.advance(130_000);
  await scheduler.handleAlarm(alarm);
  assert.equal(tabs._has(tab.id), false);
  assert.deepEqual(alarms._names(), []);
});

test('grouping alarm rechecks navigation even if the tab update event was missed', async () => {
  const { tabs, alarms, clock, scheduler } = await setup({ rules: [rule('login', { delaySeconds: 120, groupAfterSeconds: 45 })] });
  const tab = tabs._add({ title: 'login' });
  await scheduler.evaluateTab(tab);
  const alarm = alarms._get(GROUP_ALARM_PREFIX + tab.id);
  tabs._update(tab.id, { title: 'work' });
  await clock.advance(45_000);
  await scheduler.handleAlarm(alarm);
  assert.deepEqual(scheduler.getPending(), {});
  assert.deepEqual(alarms._names(), []);
  assert.equal((await tabs.get(tab.id)).groupId, -1);
});

test('groupAfterSeconds: the tab stays put during the grace, then joins the Closing group', async () => {
  const { tabs, tabGroups, clock, scheduler } = await setup({ rules: [rule('okta', { delaySeconds: 20, groupAfterSeconds: 5 })] });
  const home = tabGroups._create();
  const tab = tabs._add({ title: 'okta login', groupId: home });
  tabs._add({ title: 'sibling', groupId: home });
  await scheduler.evaluateTab(tab);
  const entry = scheduler.getPending()[tab.id];
  assert.equal(entry.groupId, null, 'not grouped yet');
  assert.equal(entry.groupAt, clock.now() + 5000);
  assert.equal((await tabs.get(tab.id)).groupId, home, 'still in its own group');

  await clock.advance(4999);
  await scheduler.idle();
  assert.equal((await tabs.get(tab.id)).groupId, home);
  await clock.advance(1);
  await scheduler.idle();
  const after = scheduler.getPending()[tab.id];
  assert.ok(after.groupId != null, 'grouped once the grace passed');
  assert.equal(after.prevGroupId, home, 'remembers where it came from');
  assert.equal((await tabGroups.get(after.groupId)).title, CLOSING_GROUP_TITLE);

  await clock.advance(15_000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), false, 'closed on time regardless of the grace');
});

test('groupAfterSeconds: a redirect back within the grace never touches the group', async () => {
  const { tabs, tabGroups, clock, scheduler } = await setup({ rules: [rule('okta', { delaySeconds: 20, groupAfterSeconds: 5 })] });
  const home = tabGroups._create();
  const tab = tabs._add({ title: 'project!17', groupId: home });
  tabs._add({ title: 'sibling', groupId: home });
  await scheduler.evaluateTab(tabs._update(tab.id, { title: 'okta login' }));
  await clock.advance(2000);
  await scheduler.evaluateTab(tabs._update(tab.id, { title: 'project!17' }));
  assert.deepEqual(scheduler.getPending(), {}, 'countdown cancelled');
  assert.equal(clock.pendingTimers(), 0, 'grace timer cleared too');
  await clock.advance(10_000);
  await scheduler.idle();
  assert.equal((await tabs.get(tab.id)).groupId, home, 'never left its group');
  assert.equal(Object.keys(tabGroups._all()).length, 1, 'no Closing group was ever created');
  assert.deepEqual(tabGroups._groupMoves, []);
});

test('groupAfterSeconds >= delay: closed without ever being grouped', async () => {
  const { tabs, tabGroups, clock, scheduler } = await setup({ rules: [rule('login', { delaySeconds: 5, groupAfterSeconds: 5 })] });
  const tab = tabs._add({ title: 'login' });
  await scheduler.evaluateTab(tab);
  assert.equal(scheduler.getPending()[tab.id].groupAt, null);
  await clock.advance(5000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), false);
  assert.deepEqual(tabGroups._all(), {});
});

test('groupAfterSeconds survives a worker restart: an elapsed grace groups immediately on restore', async () => {
  const chromeStorage = createChromeStorage();
  const storage = createStorage(chromeStorage);
  await storage.saveRules([rule('okta', { delaySeconds: 60, groupAfterSeconds: 10 })]);
  const tabGroups = createTabGroups();
  const tabs = createTabs([], tabGroups);
  const clock = createClock();
  const logger = { error: (...a) => { throw new Error(a.join(' ')); }, warn: () => {} };
  const tab = tabs._add({ title: 'okta login' });
  await storage.setPending({
    [tab.id]: { ruleId: 'okta', ruleName: 'Rule okta', deadline: clock.now() + 40_000, title: 'okta login', url: '', groupId: null, prevGroupId: -1, groupAt: clock.now() - 1000 },
  });
  const scheduler = createScheduler({ storage, tabs, alarms: createAlarms(), tabGroups, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, logger });
  await scheduler.start();
  assert.ok(scheduler.getPending()[tab.id].groupId != null, 'grouped during restore');
  assert.equal((await tabs.get(tab.id)).groupId, scheduler.getPending()[tab.id].groupId);
});

test('onTabCreated re-anchors the Closing group at the end of the strip while tabs are pending', async () => {
  const { tabs, tabGroups, scheduler } = await setup({ rules: [rule('zoom')] });
  const a = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(a);
  const gid = scheduler.getPending()[a.id].groupId;
  const before = tabGroups._groupMoves.length;
  const fresh = tabs._add({ title: 'new tab' });
  await scheduler.onTabCreated(fresh);
  assert.deepEqual(tabGroups._groupMoves.at(-1), { groupId: gid, index: -1 });
  assert.equal(tabGroups._groupMoves.length, before + 1);
  // Nothing pending: no move.
  await scheduler.cancel(a.id);
  await scheduler.onTabCreated(tabs._add({ title: 'another' }));
  assert.equal(tabGroups._groupMoves.length, before + 1);
});

// ---------------- Keep sticks ----------------

test('Keep exempts the tab from that rule while it stays open; other rules still apply; closing the tab forgets it', async () => {
  const { tabs, clock, scheduler, storage } = await setup({ rules: [rule('zoom'), rule('meeting')] });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  assert.equal(await scheduler.cancel(tab.id, { keep: true }), true);
  assert.deepEqual(scheduler.getKept()[tab.id], ['zoom']);

  await scheduler.rescanAll();
  assert.deepEqual(scheduler.getPending(), {}, 'rescan does not reschedule a kept tab');
  await scheduler.onRulesChanged();
  assert.deepEqual(scheduler.getPending(), {}, 'rule edits do not either');
  await clock.advance(60_000);
  await scheduler.idle();
  assert.equal(tabs._has(tab.id), true);

  // A different rule matching the same tab is not exempt.
  await scheduler.evaluateTab(tabs._update(tab.id, { title: 'zoom meeting' }));
  assert.equal(scheduler.getPending()[tab.id].ruleId, 'meeting');
  await scheduler.cancel(tab.id);
  assert.deepEqual(scheduler.getKept()[tab.id], ['zoom'], 'plain cancel does not add an exemption');

  // Survives a worker restart via session storage.
  assert.deepEqual((await storage.getKept())[tab.id], ['zoom']);

  tabs._close(tab.id);
  await scheduler.onTabRemoved(tab.id);
  assert.deepEqual(scheduler.getKept(), {});
});

test('rescan drops Keep records for tabs that no longer exist', async () => {
  const { tabs, scheduler } = await setup({ rules: [rule('zoom')] });
  const tab = tabs._add({ title: 'zoom' });
  await scheduler.evaluateTab(tab);
  await scheduler.cancel(tab.id, { keep: true });
  tabs._close(tab.id);
  await scheduler.rescanAll();
  assert.deepEqual(scheduler.getKept(), {});
});

// ---------------- collapsed Closing group ----------------

test('the Closing group is collapsed by default and left expanded when the option is off', async () => {
  {
    const { tabs, tabGroups, scheduler } = await setup({ rules: [rule('zoom')] });
    const tab = tabs._add({ title: 'zoom' });
    await scheduler.evaluateTab(tab);
    assert.equal((await tabGroups.get(scheduler.getPending()[tab.id].groupId)).collapsed, true);
  }
  {
    const { tabs, tabGroups, scheduler, storage } = await setup({ rules: [rule('zoom')] });
    await storage.setCloseSettings({ collapseClosingGroup: false });
    await scheduler.onRulesChanged();
    const tab = tabs._add({ title: 'zoom' });
    await scheduler.evaluateTab(tab);
    assert.equal((await tabGroups.get(scheduler.getPending()[tab.id].groupId)).collapsed, false);
  }
});
