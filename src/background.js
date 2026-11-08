// MV3 background (Chrome worker / Firefox event page). Wires browser events to the
// close scheduler and the tab grouper. Listeners are registered synchronously
// at top level (required by MV3) and wait for start() before acting.

import { api as chrome, isExtensionSender } from './browser-api.js';
import { createStorage } from './storage.js';
import { createScheduler } from './scheduler.js';
import { createGrouper } from './grouper.js';
import { createStatusReader } from './status-reader.js';
import { createAgeCloser } from './age-closer.js';
import { computeSourceHash } from './build.js';

const storage = createStorage(chrome.storage);
const scheduler = createScheduler({
  storage,
  tabs: chrome.tabs,
  alarms: chrome.alarms,
  tabGroups: chrome.tabGroups,
});
const grouper = createGrouper({
  storage,
  tabs: chrome.tabs,
  tabGroups: chrome.tabGroups,
  statusReader: createStatusReader({ scripting: chrome.scripting, permissions: chrome.permissions }),
  // A tab counting down to close keeps its countdown group; grouping rules skip it.
  isPendingClose: (tabId) => tabId in scheduler.getPending(),
});

const ageCloser = createAgeCloser({
  storage,
  tabs: chrome.tabs,
  isPendingClose: (tabId) => tabId in scheduler.getPending(),
});
const AGE_SWEEP_ALARM = 'age-sweep';
const UNPAUSE_ALARM = 'unpause';
chrome.alarms.create(AGE_SWEEP_ALARM, { periodInMinutes: 1 });

/** Snooze: a pause with pausedUntil ends itself through an alarm. */
async function syncSnoozeAlarm() {
  const until = await storage.getPausedUntil();
  if (until === null) {
    await chrome.alarms.clear(UNPAUSE_ALARM);
    return;
  }
  if (until <= Date.now()) {
    await storage.setPaused(false);
    return;
  }
  await chrome.alarms.create(UNPAUSE_ALARM, { when: until });
}

// Hash of the source files as they were on disk when this worker started. On
// request the worker hashes them again; a difference means the files changed
// since this worker started, i.e. the running code is stale. Both hashes are
// computed in this one context so the comparison cannot drift between contexts.
let workerBuild = null;
computeSourceHash().then((h) => (workerBuild = h), () => {});

// start() runs on every worker boot (install, browser start, wake from suspend).
const ready = Promise.all([scheduler.start(), grouper.start(), ageCloser.start(), syncSnoozeAlarm()]).catch((err) =>
  console.error('[tabkeeper] failed to start', err),
);
const whenReady = (fn) => ready.then(fn).catch((err) => console.error('[tabkeeper]', err));

// ---- closing ----

chrome.tabs.onCreated.addListener((tab) =>
  whenReady(async () => {
    await ageCloser.noteCreated(tab.id);
    await scheduler.onTabCreated(tab); // keep the Closing group at the end of the strip
    await scheduler.evaluateTab(tab);
  }),
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ('title' in changeInfo || 'url' in changeInfo || 'status' in changeInfo || 'pinned' in changeInfo) {
    whenReady(() => scheduler.evaluateTab(tab));
  }
  // Grouping: on load complete, and on URL change of an already-complete tab (single-page apps).
  if (changeInfo.status === 'complete' || ('url' in changeInfo && tab.status === 'complete')) {
    whenReady(() => grouper.evaluateTab(tab));
  }
});

chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) =>
  whenReady(() => scheduler.onTabReplaced(addedTabId, removedTabId)),
);

chrome.tabs.onRemoved.addListener((tabId) =>
  whenReady(async () => {
    await scheduler.onTabRemoved(tabId);
    await ageCloser.noteRemoved(tabId);
  }),
);

chrome.alarms.onAlarm.addListener((alarm) =>
  whenReady(() => {
    if (alarm.name === AGE_SWEEP_ALARM) return ageCloser.sweep();
    if (alarm.name === UNPAUSE_ALARM) return storage.setPaused(false);
    return scheduler.handleAlarm(alarm);
  }),
);

// Keyboard shortcuts (chrome://extensions/shortcuts to change them).
chrome.commands.onCommand.addListener((command) =>
  whenReady(async () => {
    if (command === 'toggle-pause') {
      await storage.setPaused(!(await storage.getPaused()));
    } else if (command === 'group-current-tab') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) await grouper.applyToTab(tab);
    }
  }),
);

// First install: open the guide once.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('help/guide.html') }).catch(() => {});
});

// ---- grouping ----

chrome.tabGroups.onRemoved.addListener((group) => whenReady(() => grouper.onGroupRemoved(group.id)));
chrome.windows.onRemoved.addListener((windowId) => whenReady(() => grouper.onWindowRemoved(windowId)));

// ---- storage ----

// Saving one rule touches two sync keys; coalesce the resulting onChanged events.
let rulesChangedTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    clearTimeout(rulesChangedTimer);
    rulesChangedTimer = setTimeout(
      () =>
        whenReady(async () => {
          await scheduler.onRulesChanged();
          await grouper.onRulesChanged();
          await ageCloser.onSettingsChanged();
        }),
      100,
    );
  } else if (area === 'local') {
    if ('paused' in changes) whenReady(() => scheduler.setPaused(Boolean(changes.paused.newValue)));
    if ('pausedUntil' in changes) whenReady(syncSnoozeAlarm);
  }
});

// ---- messages from the popup and from injected page readers ----

const handlers = {
  cancel: ({ tabId, keep }) => scheduler.cancel(tabId, { keep: Boolean(keep) }).then((cancelled) => ({ cancelled: Boolean(cancelled) })),
  'group-apply-all': () => grouper.applyToAll(),
  'status-report': ({ results }, sender) => grouper.onStatusReport(sender.tab, results),
  'group-test': async ({ tabId, rule }) => grouper.testRule(rule, await chrome.tabs.get(tabId)),
  'group-apply': async ({ tabId }) => grouper.applyToTab(await chrome.tabs.get(tabId)),
  'aws-test': async ({ tabId, settings }) => grouper.testAws(await chrome.tabs.get(tabId), settings ?? null),
  'set-title-limit': ({ limit }) => grouper.setTitleLimit(limit),
  version: async () => ({ build: workerBuild, now: await computeSourceHash().catch(() => null) }),
  sweep: () => ageCloser.sweep(),
};

const EXTENSION_BASE = chrome.runtime.getURL('');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) return false;
  // Injected page readers (sender.origin is the web page's) may only send status reports.
  if (!isExtensionSender(sender, chrome.runtime.id, EXTENSION_BASE) && message.type !== 'status-report') return false;
  ready
    .then(() => handler(message, sender))
    .then(
      (result) => sendResponse({ ok: true, ...(result ?? {}) }),
      (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
    );
  return true; // keep the channel open for the async response
});
