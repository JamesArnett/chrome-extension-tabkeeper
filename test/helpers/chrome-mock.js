// Minimal in-memory stand-ins for the chrome.* APIs the extension uses.

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createStorageArea() {
  const data = new Map();
  return {
    async get(keys) {
      const out = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of data) out[k] = clone(v);
      } else if (typeof keys === 'string') {
        if (data.has(keys)) out[keys] = clone(data.get(keys));
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k));
      } else {
        for (const [k, def] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : def;
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, clone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    async clear() {
      data.clear();
    },
    /** Test-only: raw view of stored data. */
    _dump() {
      return Object.fromEntries([...data].map(([k, v]) => [k, clone(v)]));
    },
  };
}

export function createChromeStorage() {
  return { sync: createStorageArea(), local: createStorageArea(), session: createStorageArea() };
}

export function createTabs(initial = [], tabGroups = null) {
  const tabs = new Map();
  let nextId = 1;
  const removed = [];
  const moves = [];
  const api = {
    async group({ tabIds, groupId, createProperties }) {
      if (!tabGroups) throw new Error('tabGroups not supported in this mock');
      for (const id of tabIds) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        if (tab.pinned) throw new Error('Cannot group pinned tabs.');
        if (tab.windowType === 'popup') throw new Error('Tabs in popup windows cannot be grouped.');
      }
      let target = groupId;
      if (target === undefined) {
        const windowId = createProperties?.windowId ?? tabs.get(tabIds[0]).windowId;
        target = tabGroups._create(windowId);
      } else if (!tabGroups._exists(target)) throw new Error(`No group with id: ${target}.`);
      for (const id of tabIds) {
        const tab = tabs.get(id);
        const old = tab.groupId;
        tab.groupId = target;
        tabGroups._sync(old, [...tabs.values()]);
      }
      return target;
    },
    async ungroup(tabIds) {
      for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        const old = tab.groupId;
        tab.groupId = -1;
        tabGroups?._sync(old, [...tabs.values()]);
      }
    },
    async query() {
      return [...tabs.values()].map((t) => ({ ...t }));
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      return { ...tab };
    },
    async remove(tabId) {
      if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
      const tab = tabs.get(tabId);
      if (tab.sticky) return; // simulates a page holding the tab open with a "Leave site?" dialog
      const old = tab.groupId;
      tabs.delete(tabId);
      removed.push(tabId);
      tabGroups?._sync(old, [...tabs.values()]);
    },
    async move(tabId, { index }) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      tab.index = index;
      moves.push({ tabId, index });
      return { ...tab };
    },
    // ---- test helpers ----
    _add(props = {}) {
      const tab = { id: nextId++, title: '', url: '', pinned: false, active: false, audible: false, groupId: -1, windowId: 1, status: 'complete', index: tabs.size, ...props };
      tabs.set(tab.id, tab);
      return { ...tab };
    },
    _update(tabId, props) {
      const tab = tabs.get(tabId);
      Object.assign(tab, props);
      return { ...tab };
    },
    _close(tabId) {
      const old = tabs.get(tabId)?.groupId;
      tabs.delete(tabId);
      tabGroups?._sync(old, [...tabs.values()]);
    },
    _has(tabId) {
      return tabs.has(tabId);
    },
    _removed: removed,
    _moves: moves,
  };
  for (const t of initial) api._add(t);
  return api;
}

export function createAlarms() {
  const alarms = new Map();
  return {
    async create(name, info) {
      alarms.set(name, { name, scheduledTime: info.when });
    },
    async clear(name) {
      return alarms.delete(name);
    },
    async getAll() {
      return [...alarms.values()];
    },
    _get(name) {
      return alarms.get(name);
    },
    _names() {
      return [...alarms.keys()];
    },
    /** Test-only: fire alarms whose scheduledTime <= time, returning them in order. */
    _due(time) {
      const due = [...alarms.values()].filter((a) => a.scheduledTime <= time);
      for (const a of due) alarms.delete(a.name);
      return due;
    },
  };
}

/** Deterministic clock with setTimeout/clearTimeout that advance manually. */
export function createClock(start = 1_700_000_000_000) {
  let current = start;
  let nextHandle = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, delay) {
      const handle = nextHandle++;
      timers.set(handle, { at: current + Math.max(0, delay), fn, seq: handle });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    /**
     * Advance time, running timers in order. After each timer fires, all async work it
     * spawned is allowed to settle (macrotask boundary) before time moves on, so a timer
     * that re-arms itself asynchronously is not skipped.
     */
    async advance(ms) {
      const target = current + ms;
      // Let async work that is about to register a timer do so before time moves.
      await new Promise((r) => setImmediate(r));
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq);
        if (due.length === 0) break;
        const [handle, timer] = due[0];
        timers.delete(handle);
        current = timer.at;
        timer.fn();
        await new Promise((r) => setImmediate(r));
      }
      current = target;
    },
    pendingTimers: () => timers.size,
  };
}

/** Mock of chrome.tabGroups. Groups vanish when their last tab leaves, like Chrome. */
export function createTabGroups() {
  const groups = new Map();
  let nextId = 100;
  return {
    async update(groupId, props) {
      this._updateCalls++;
      const g = groups.get(groupId);
      if (!g) throw new Error(`No group with id: ${groupId}.`);
      Object.assign(g, props);
      return { id: groupId, ...g };
    },
    async get(groupId) {
      const g = groups.get(groupId);
      if (!g) throw new Error(`No group with id: ${groupId}.`);
      return { id: groupId, ...g };
    },
    async move(groupId, { index }) {
      const g = groups.get(groupId);
      if (!g) throw new Error(`No group with id: ${groupId}.`);
      g.index = index;
      this._groupMoves.push({ groupId, index });
      return { id: groupId, ...g };
    },
    _groupMoves: [],
    async query(info = {}) {
      return [...groups]
        .filter(([, g]) => info.windowId === undefined || g.windowId === info.windowId)
        .map(([id, g]) => ({ id, ...g }));
    },
    _create(windowId = 1) {
      const id = nextId++;
      groups.set(id, { title: '', color: 'grey', windowId, collapsed: false });
      return id;
    },
    /** Test-only: a group the user made by hand. */
    _handMade(windowId, title, tab) {
      const id = this._create(windowId);
      groups.get(id).title = title;
      if (tab) tab.groupId = id;
      return id;
    },
    _updateCalls: 0,
    _exists(id) {
      return groups.has(id);
    },
    /** Drop `groupId` if no tab references it any more. */
    _sync(groupId, allTabs) {
      if (groupId === undefined || groupId === -1) return;
      if (!allTabs.some((t) => t.groupId === groupId)) groups.delete(groupId);
    },
    /** Test-only: simulate the user ungrouping manually. */
    _dissolve(groupId, allTabs) {
      for (const t of allTabs) if (t.groupId === groupId) t.groupId = -1;
      groups.delete(groupId);
    },
    _all() {
      return Object.fromEntries([...groups].map(([id, g]) => [id, { ...g }]));
    },
  };
}
