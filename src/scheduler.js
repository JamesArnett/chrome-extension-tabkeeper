// Decides when tabs get closed. All state transitions run through a single
// promise queue so concurrent tab events cannot interleave.
//
// Pending closes live in chrome.storage.session so they survive the MV3
// service worker being suspended. Short delays use setTimeout (the worker is
// awake because a tab event just fired); long delays use chrome.alarms.
// At fire time the tab is re-fetched and re-matched before being removed.
//
// Every pending tab is moved into one red "Closing" group per window, kept at
// the end of the tab strip. A rule can delay that move (groupAfterSeconds) so a
// login page that redirects back within a few seconds never visibly leaves its
// group. The countdown itself is shown only in the popup. Group operations are
// best effort and never block a close.

import { compileRules, findMatchingRule, ruleMatches } from './matcher.js';
import { addLogEntry, MAX_LOG_ENTRIES } from './log.js';
import { normalizeCloseSettings } from './age-closer.js';

export const DEFAULT_SHORT_DELAY_MS = 30_000;
export const ALARM_PREFIX = 'close:';
export const GROUP_ALARM_PREFIX = 'group:';
export const CLOSING_GROUP_TITLE = 'Closing';
export const GROUP_COLOR = 'red';
const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

function tabInfo(tab) {
  return {
    title: typeof tab.title === 'string' ? tab.title : '',
    url: typeof tab.url === 'string' ? tab.url : '',
  };
}

export function createScheduler({
  storage,
  tabs,
  alarms,
  tabGroups = null, // chrome.tabGroups; when null, no grouping happens
  now = () => Date.now(),
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
  shortDelayMs = DEFAULT_SHORT_DELAY_MS,
  maxLogEntries = MAX_LOG_ENTRIES,
  logger = console,
}) {
  let compiled = [];
  let paused = false;
  let pending = null; // tabId (string key) -> { ruleId, ruleName, deadline, title, url, groupId, prevGroupId, prevIndex, groupAt }
  let closingGroups = null; // windowId (string key) -> groupId of that window's Closing group
  let kept = null; // tabId (string key) -> rule ids the user pressed Keep on
  let collapseGroup = true; // closeSettings.collapseClosingGroup
  const timers = new Map(); // tabId (number) -> timeout handle for the close
  const groupTimers = new Map(); // tabId (number) -> timeout handle for the delayed move into the Closing group

  let queue = Promise.resolve();
  function enqueue(fn) {
    const run = queue.then(fn);
    queue = run.catch((err) => logger.error('[tabkeeper]', err));
    return run;
  }

  // ---- internal helpers (never enqueue; callers are already inside the queue) ----

  async function loadPending() {
    if (pending === null) pending = await storage.getPending();
    return pending;
  }

  async function persistPending() {
    await storage.setPending(pending);
  }

  async function loadRules() {
    const rules = await storage.getRules();
    compiled = compileRules(rules);
    if (typeof storage.getCloseSettings === 'function') {
      collapseGroup = normalizeCloseSettings(await storage.getCloseSettings()).collapseClosingGroup;
    }
    return rules;
  }

  async function loadKept() {
    if (kept === null) kept = typeof storage.getKept === 'function' ? await storage.getKept() : {};
    return kept;
  }
  async function persistKept() {
    if (typeof storage.setKept === 'function') await storage.setKept(kept);
  }

  function compiledById(id) {
    return compiled.find((c) => c.rule.id === id) ?? null;
  }

  async function disarmGroupTimer(tabId) {
    const handle = groupTimers.get(tabId);
    if (handle !== undefined) {
      clearT(handle);
      groupTimers.delete(tabId);
    }
    await alarms.clear(GROUP_ALARM_PREFIX + tabId);
  }

  async function armGroupTimer(tabId, groupAt) {
    await disarmGroupTimer(tabId);
    const delay = Math.max(0, groupAt - now());
    if (delay >= shortDelayMs) {
      await alarms.create(GROUP_ALARM_PREFIX + tabId, { when: groupAt });
      return;
    }
    const handle = setT(() => {
      groupTimers.delete(tabId);
      enqueue(() => claimLater(tabId));
    }, delay);
    groupTimers.set(tabId, handle);
  }

  async function disarm(tabId) {
    const handle = timers.get(tabId);
    if (handle !== undefined) {
      clearT(handle);
      timers.delete(tabId);
    }
    await disarmGroupTimer(tabId);
    await alarms.clear(ALARM_PREFIX + tabId);
  }

  async function arm(tabId, deadline) {
    await disarm(tabId);
    const delay = Math.max(0, deadline - now());
    if (delay < shortDelayMs) {
      const handle = setT(() => {
        timers.delete(tabId);
        enqueue(() => fire(tabId));
      }, delay);
      timers.set(tabId, handle);
    } else {
      await alarms.create(ALARM_PREFIX + tabId, { when: deadline });
    }
  }

  // ---- the Closing group (one per window, at the end of the strip; best effort) ----

  const groupingEnabled = () =>
    tabGroups !== null && typeof tabs.group === 'function' && typeof tabs.ungroup === 'function';

  async function loadClosingGroups() {
    if (closingGroups === null) {
      closingGroups = typeof storage.getClosingGroups === 'function' ? await storage.getClosingGroups() : {};
    }
    return closingGroups;
  }

  async function persistClosingGroups() {
    if (typeof storage.setClosingGroups === 'function') await storage.setClosingGroups(closingGroups);
  }

  async function groupExists(groupId) {
    try {
      await tabGroups.get(groupId);
      return true;
    } catch {
      return false;
    }
  }

  async function moveToEnd(groupId) {
    if (typeof tabGroups.move !== 'function') return;
    try {
      await tabGroups.move(groupId, { index: -1 });
    } catch {
      // leave it where it is
    }
  }

  /**
   * Put the tab into its window's Closing group, finding it via the session record,
   * then by title (fresh session), else creating it. Returns the group id or null.
   */
  async function claimGroup(tab) {
    if (!groupingEnabled()) return null;
    await loadClosingGroups();
    const windowId = tab.windowId;
    try {
      let groupId = closingGroups[windowId];
      if (groupId != null && !(await groupExists(groupId))) {
        delete closingGroups[windowId];
        groupId = null;
      }
      if (groupId == null && typeof tabGroups.query === 'function') {
        try {
          const found = (await tabGroups.query({ windowId })).find((g) => g.title === CLOSING_GROUP_TITLE);
          if (found) groupId = found.id;
        } catch {
          // no adoption possible
        }
      }
      if (groupId == null) {
        groupId = await tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
        await tabGroups.update(groupId, { title: CLOSING_GROUP_TITLE, color: GROUP_COLOR });
      } else if (tab.groupId !== groupId) {
        await tabs.group({ tabIds: [tab.id], groupId });
      }
      closingGroups[windowId] = groupId;
      await persistClosingGroups();
      await moveToEnd(groupId);
      if (collapseGroup) {
        try {
          await tabGroups.update(groupId, { collapsed: true });
        } catch {
          // Chrome refuses while the active tab is inside; fine
        }
      }
      return groupId;
    } catch (err) {
      // Popup/app windows and some tab states cannot be grouped; closing still works.
      logger.warn?.('[tabkeeper] could not add tab to the Closing group', tab.id, err?.message ?? err);
      return null;
    }
  }

  /** Take the tab out of the Closing group and return it to where it came from. */
  async function releaseGroup(tabId, entry) {
    if (!entry || entry.groupId == null || !groupingEnabled()) return;
    try {
      await tabs.ungroup(tabId);
    } catch {
      return; // tab already gone or already out of the group
    }
    if (typeof entry.prevGroupId === 'number' && entry.prevGroupId !== NO_GROUP) {
      try {
        await tabs.group({ tabIds: [tabId], groupId: entry.prevGroupId });
        return;
      } catch {
        // original group no longer exists; fall back to the position
      }
    }
    if (Number.isInteger(entry.prevIndex) && typeof tabs.move === 'function') {
      try {
        await tabs.move(tabId, { index: entry.prevIndex });
      } catch {
        // best effort only
      }
    }
  }

  /** Grace period over: move the tab into the Closing group if it is still pending and ungrouped by us. */
  async function claimLater(tabId) {
    await loadPending();
    const entry = pending[tabId];
    if (!entry || entry.groupId != null || paused) return;
    let tab;
    try {
      tab = await tabs.get(tabId);
    } catch {
      return;
    }
    if (tab.pinned) return;
    // The wake-up may be late, or a navigation event may still be queued.
    if (entry.deadline <= now()) return fire(tabId);
    const rule = compiledById(entry.ruleId);
    if (!rule || !rule.rule.enabled || !ruleMatches(rule, tabInfo(tab))) return cancel(tabId);
    entry.prevGroupId = typeof tab.groupId === 'number' ? tab.groupId : NO_GROUP;
    entry.prevIndex = Number.isInteger(tab.index) ? tab.index : undefined;
    entry.groupId = await claimGroup(tab);
    entry.groupAt = null;
    await persistPending();
  }

  /** A new tab opened at the end of the strip; keep the Closing group behind it. */
  async function onTabCreated(tab) {
    if (!tab || typeof tab.windowId !== 'number' || !groupingEnabled()) return;
    await loadPending();
    await loadClosingGroups();
    const groupId = closingGroups[tab.windowId];
    if (groupId == null) return;
    if (!Object.values(pending).some((e) => e.groupId === groupId)) return;
    if (!(await groupExists(groupId))) {
      delete closingGroups[tab.windowId];
      await persistClosingGroups();
      return;
    }
    await moveToEnd(groupId);
  }

  /** `keep` records that the user wants this tab left alone by that rule while it stays open. */
  async function cancel(tabId, { keep = false } = {}) {
    await loadPending();
    await disarm(tabId);
    const entry = pending[tabId];
    if (entry) {
      delete pending[tabId];
      await persistPending();
      if (keep) {
        await loadKept();
        const list = kept[tabId] ?? [];
        if (!list.includes(entry.ruleId)) kept[tabId] = [...list, entry.ruleId];
        await persistKept();
      }
      await releaseGroup(tabId, entry);
      return true;
    }
    return false;
  }

  async function forgetKept(tabId) {
    await loadKept();
    if (tabId in kept) {
      delete kept[tabId];
      await persistKept();
    }
  }

  async function schedule(tab, rule) {
    const delayMs = rule.delaySeconds * 1000;
    const graceMs = Math.max(0, (rule.groupAfterSeconds ?? 0) * 1000);
    const deadline = now() + delayMs;
    const existing = pending[tab.id];
    let groupId = null;
    let prevGroupId;
    let prevIndex;
    let groupAt = null;
    if (existing && existing.groupId != null) {
      // Switching rules: the tab is already in the Closing group.
      ({ groupId, prevGroupId, prevIndex } = existing);
    } else {
      await disarmGroupTimer(tab.id);
      prevGroupId = typeof tab.groupId === 'number' ? tab.groupId : NO_GROUP;
      prevIndex = Number.isInteger(tab.index) ? tab.index : undefined;
      if (graceMs === 0) {
        groupId = await claimGroup(tab);
      } else if (graceMs < delayMs) {
        groupAt = now() + graceMs; // grouped later, unless the tab stops matching first
      }
      // graceMs >= delayMs: the tab closes before it would ever be grouped.
    }
    pending[tab.id] = { ruleId: rule.id, ruleName: rule.name, deadline, ...tabInfo(tab), groupId, prevGroupId, prevIndex, groupAt };
    await persistPending();
    await arm(tab.id, deadline);
    if (groupAt !== null) await armGroupTimer(tab.id, groupAt);
  }

  async function evaluateTab(tab) {
    if (!tab || typeof tab.id !== 'number') return;
    await loadPending();
    // Events wait in this queue while grouping and storage calls run. An older
    // loading/title snapshot must not cancel a countdown for the current page.
    try {
      tab = await tabs.get(tab.id);
    } catch {
      return; // closed while the event was queued
    }
    const existing = pending[tab.id];

    if (paused || tab.pinned) {
      if (existing) await cancel(tab.id);
      return;
    }

    await loadKept();
    const rule = findMatchingRule(compiled, tabInfo(tab), kept[tab.id] ?? []);
    if (!rule) {
      if (existing) await cancel(tab.id);
      return;
    }

    if (existing && existing.ruleId === rule.id) {
      // Same rule still matching: keep the original deadline, refresh the snapshot.
      const info = tabInfo(tab);
      if (existing.title !== info.title || existing.url !== info.url) {
        Object.assign(existing, info);
        await persistPending();
      }
      return;
    }

    await schedule(tab, rule);
  }

  async function fire(tabId) {
    await loadPending();
    const entry = pending[tabId];
    if (!entry) {
      await disarm(tabId);
      return { closed: false, reason: 'not-pending' };
    }
    if (paused) {
      await cancel(tabId);
      return { closed: false, reason: 'paused' };
    }

    await disarm(tabId);
    let tab;
    try {
      tab = await tabs.get(tabId);
    } catch {
      delete pending[tabId];
      await persistPending();
      return { closed: false, reason: 'tab-gone' };
    }

    const compiledRule = compiledById(entry.ruleId);
    const info = tabInfo(tab);
    const stillMatches =
      compiledRule !== null &&
      compiledRule.rule.enabled &&
      !tab.pinned &&
      ruleMatches(compiledRule, info);

    if (!stillMatches) {
      await cancel(tabId); // drops the entry and takes the tab out of the Closing group
      // Another rule might match now (or the same one later); re-evaluate from scratch.
      await evaluateTab(tab);
      return { closed: false, reason: 'no-longer-matches' };
    }

    try {
      await tabs.remove(tabId);
    } catch (err) {
      delete pending[tabId];
      await persistPending();
      logger.warn('[tabkeeper] failed to close tab', tabId, err);
      return { closed: false, reason: 'remove-failed' };
    }

    delete pending[tabId];
    await persistPending();
    await addLogEntry(
      storage,
      {
        title: info.title,
        url: info.url,
        ruleId: compiledRule.rule.id,
        ruleName: compiledRule.rule.name,
        closedAt: now(),
      },
      maxLogEntries,
    );
    return { closed: true };
  }

  async function rescanAll() {
    await loadPending();
    await loadKept();
    const all = await tabs.query({});
    const live = new Set(all.map((t) => t.id));
    for (const key of Object.keys(pending)) {
      const tabId = Number(key);
      if (!live.has(tabId)) {
        await disarm(tabId);
        delete pending[key];
      }
    }
    let keptChanged = false;
    for (const key of Object.keys(kept)) {
      if (!live.has(Number(key))) {
        delete kept[key];
        keptChanged = true;
      }
    }
    if (keptChanged) await persistKept();
    for (const tab of all) await evaluateTab(tab);
    await persistPending();
  }

  /** Re-arm timers persisted by a previous service-worker instance. */
  async function restore() {
    pending = null;
    await loadPending();
    const all = await tabs.query({});
    const live = new Set(all.map((t) => t.id));
    for (const [key, entry] of Object.entries(pending)) {
      const tabId = Number(key);
      if (!live.has(tabId) || !entry || typeof entry.deadline !== 'number') {
        delete pending[key];
        continue;
      }
      await arm(tabId, entry.deadline);
      if (entry.groupId == null && typeof entry.groupAt === 'number') {
        if (entry.groupAt <= now()) await claimLater(tabId);
        else await armGroupTimer(tabId, entry.groupAt);
      }
    }
    await persistPending();
  }

  async function start() {
    await loadRules();
    paused = await storage.getPaused();
    await restore();
    await rescanAll();
  }

  async function setPaused(value) {
    paused = Boolean(value);
    if (paused) {
      await loadPending();
      const entries = Object.entries(pending);
      for (const [key] of entries) await disarm(Number(key));
      pending = {};
      await persistPending();
      for (const [key, entry] of entries) await releaseGroup(Number(key), entry);
    } else {
      await rescanAll();
    }
  }

  async function handleAlarm(alarm) {
    if (!alarm || typeof alarm.name !== 'string') return;
    const prefix = alarm.name.startsWith(GROUP_ALARM_PREFIX) ? GROUP_ALARM_PREFIX : ALARM_PREFIX;
    if (!alarm.name.startsWith(prefix)) return;
    const tabId = Number(alarm.name.slice(prefix.length));
    if (!Number.isInteger(tabId)) return;
    if (prefix === GROUP_ALARM_PREFIX) return claimLater(tabId);
    await fire(tabId);
  }

  async function onTabReplaced(addedTabId, removedTabId) {
    await cancel(removedTabId);
    try {
      const tab = await tabs.get(addedTabId);
      await evaluateTab(tab);
    } catch {
      // Tab disappeared between events; nothing to do.
    }
  }

  // ---- public API: every call is serialized through the queue ----
  return {
    start: () => enqueue(start),
    evaluateTab: (tab) => enqueue(() => evaluateTab(tab)),
    onTabCreated: (tab) => enqueue(() => onTabCreated(tab)),
    fire: (tabId) => enqueue(() => fire(tabId)),
    cancel: (tabId, opts) => enqueue(() => cancel(tabId, opts)),
    rescanAll: () => enqueue(rescanAll),
    onRulesChanged: () =>
      enqueue(async () => {
        await loadRules();
        await rescanAll();
      }),
    onTabRemoved: (tabId) =>
      enqueue(async () => {
        await cancel(tabId);
        await forgetKept(tabId);
      }),
    onTabReplaced: (addedTabId, removedTabId) =>
      enqueue(() => onTabReplaced(addedTabId, removedTabId)),
    handleAlarm: (alarm) => enqueue(() => handleAlarm(alarm)),
    setPaused: (value) => enqueue(() => setPaused(value)),
    /** Resolves once all queued work has finished. Used by tests. */
    idle: () => queue,
    /** Snapshot of pending closes. Used by tests. */
    getPending: () => ({ ...(pending ?? {}) }),
    getKept: () => ({ ...(kept ?? {}) }),
    isPaused: () => paused,
  };
}
