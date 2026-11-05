// Age-based closing: two global limits, "open longer than X" and "not used for X".
// Runs a sweep once a minute (alarm in background.js). Closes quietly: no countdown
// group, no Closing-soon entry, but every close is logged like a rule close.
//
// Exempt: pinned tabs, the active tab of each window, tabs playing audio, tabs that
// are counting down to a rule close, and tabs that resisted a close once (Chrome was
// showing its "Leave site?" dialog, so the page has unsaved input).

import { addLogEntry, MAX_LOG_ENTRIES } from './log.js';

export const AGE_UNITS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
export const AGE_UNIT_ORDER = ['minutes', 'hours', 'days'];
export const AGE_RULE_IDS = { open: 'age-open', idle: 'age-idle' };
export const MIN_LIMIT_MS = 60_000;

export const MAX_NEVER_CLOSE = 200;

export function defaultCloseSettings() {
  return {
    maxOpen: { enabled: false, value: 8, unit: 'hours' },
    maxIdle: { enabled: false, value: 2, unit: 'days' },
    neverClose: [], // substrings matched case-insensitively against URL and title; age closing leaves these alone
    collapseClosingGroup: true,
  };
}

/** Parse the never-close textarea: one entry per line, trimmed, deduplicated, capped. */
export function parseNeverClose(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= MAX_NEVER_CLOSE) break;
  }
  return out;
}

export function matchesNeverClose(tab, list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const url = String(tab?.url ?? '').toLowerCase();
  const title = String(tab?.title ?? '').toLowerCase();
  return list.some((entry) => {
    const needle = String(entry).toLowerCase();
    return needle && (url.includes(needle) || title.includes(needle));
  });
}

function normalizeLimit(raw, fallback) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const value = Number(r.value);
  return {
    enabled: Boolean(r.enabled),
    value: Number.isInteger(value) && value >= 1 ? value : fallback.value,
    unit: AGE_UNIT_ORDER.includes(r.unit) ? r.unit : fallback.unit,
  };
}

export function normalizeCloseSettings(raw) {
  const d = defaultCloseSettings();
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    maxOpen: normalizeLimit(r.maxOpen, d.maxOpen),
    maxIdle: normalizeLimit(r.maxIdle, d.maxIdle),
    neverClose: Array.isArray(r.neverClose) ? parseNeverClose(r.neverClose.join('\n')) : [],
    collapseClosingGroup: r.collapseClosingGroup === undefined ? true : Boolean(r.collapseClosingGroup),
  };
}

/** Milliseconds for an enabled limit; 0 when disabled. Never below one minute. */
export function limitMs(limit) {
  if (!limit?.enabled) return 0;
  return Math.max(MIN_LIMIT_MS, limit.value * (AGE_UNITS[limit.unit] ?? 0));
}

export function describeLimit(limit) {
  const unit = limit.value === 1 ? limit.unit.slice(0, -1) : limit.unit;
  return `${limit.value} ${unit}`;
}

/** Why a tab must not be age-closed, or null when it may be. */
export function exemptionReason(tab, { isPendingClose = () => false, blocked = new Set(), neverClose = [] } = {}) {
  if (!tab || typeof tab.id !== 'number') return 'no-tab';
  if (tab.pinned) return 'pinned';
  if (tab.active) return 'active';
  if (tab.audible) return 'audible';
  if (isPendingClose(tab.id)) return 'pending-close';
  if (blocked.has(tab.id)) return 'unsaved-input';
  if (matchesNeverClose(tab, neverClose)) return 'never-close';
  return null;
}

/** 'open' | 'idle' | null. `firstSeen` is when the extension first saw the tab. */
export function decideClose(tab, { now, firstSeen, settings }) {
  const openMs = limitMs(settings.maxOpen);
  const idleMs = limitMs(settings.maxIdle);
  if (openMs && Number.isFinite(firstSeen) && now - firstSeen >= openMs) return 'open';
  const lastUsed = Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : firstSeen;
  if (idleMs && Number.isFinite(lastUsed) && now - lastUsed >= idleMs) return 'idle';
  return null;
}

export function createAgeCloser({
  storage,
  tabs,
  now = () => Date.now(),
  setTimeout: setT = globalThis.setTimeout,
  isPendingClose = () => false,
  confirmDelayMs = 1500,
  maxLogEntries = MAX_LOG_ENTRIES,
  logger = console,
}) {
  let settings = defaultCloseSettings();
  let firstSeen = null; // tabId (string key) -> timestamp, session storage
  let blocked = null; // Set of tab ids that resisted a close
  let sweeping = null;

  async function load() {
    if (firstSeen === null) firstSeen = await storage.getFirstSeen();
    if (blocked === null) blocked = new Set(await storage.getAgeBlocked());
  }
  async function persist() {
    await storage.setFirstSeen(firstSeen);
    await storage.setAgeBlocked([...blocked]);
  }
  async function loadSettings() {
    settings = normalizeCloseSettings(await storage.getCloseSettings());
  }

  const wait = (ms) => new Promise((r) => setT(r, ms));

  async function sweep() {
    // Re-read persisted state each sweep (once a minute): survives worker restarts
    // and keeps the picture consistent if anything else touched it.
    firstSeen = await storage.getFirstSeen();
    blocked = new Set(await storage.getAgeBlocked());
    if (await storage.getPaused()) return { closed: [], blocked: [], skipped: 'paused' };
    await loadSettings();
    const all = await tabs.query({});
    const live = new Set(all.map((t) => t.id));
    const t0 = now();
    let changed = false;

    // Forget closed tabs; start the clock for tabs we have not seen before.
    for (const key of Object.keys(firstSeen)) {
      if (!live.has(Number(key))) {
        delete firstSeen[key];
        changed = true;
      }
    }
    for (const id of blocked) if (!live.has(id)) blocked.delete(id);
    for (const tab of all) {
      if (!(tab.id in firstSeen)) {
        firstSeen[tab.id] = t0;
        changed = true;
      }
    }

    const closed = [];
    const newlyBlocked = [];
    if (limitMs(settings.maxOpen) || limitMs(settings.maxIdle)) {
      for (const candidate of all) {
        // A sweep can take seconds per tab. Pause, settings and tab state may
        // have changed since the initial query; check them again before closing.
        await loadSettings();
        if (await storage.getPaused()) break;
        let tab;
        try {
          tab = await tabs.get(candidate.id);
        } catch {
          continue; // closed since the query
        }
        if (exemptionReason(tab, { isPendingClose, blocked, neverClose: settings.neverClose })) continue;
        const why = decideClose(tab, { now: now(), firstSeen: firstSeen[tab.id], settings });
        if (!why) continue;
        const limit = why === 'open' ? settings.maxOpen : settings.maxIdle;
        try {
          await tabs.remove(tab.id);
        } catch {
          continue; // already gone
        }
        await wait(confirmDelayMs);
        let stillThere = false;
        try {
          await tabs.get(tab.id);
          stillThere = true;
        } catch {
          stillThere = false;
        }
        if (stillThere) {
          // Chrome is asking "Leave site?": the page has unsaved input. Leave it alone from now on.
          blocked.add(tab.id);
          newlyBlocked.push(tab.id);
          changed = true;
          logger.warn('[tabkeeper] tab', tab.id, 'resisted closing (unsaved input?); exempt from age-based closing');
          continue;
        }
        delete firstSeen[tab.id];
        changed = true;
        const ruleName = why === 'open' ? `Open longer than ${describeLimit(limit)}` : `Not used for ${describeLimit(limit)}`;
        await addLogEntry(
          storage,
          { title: tab.title ?? '', url: tab.url ?? '', ruleId: AGE_RULE_IDS[why], ruleName, closedAt: now() },
          maxLogEntries,
        );
        closed.push({ tabId: tab.id, why });
      }
    }
    if (changed) await persist();
    return { closed, blocked: newlyBlocked };
  }

  return {
    async start() {
      await loadSettings();
      await load();
    },
    onSettingsChanged: loadSettings,
    async noteCreated(tabId) {
      await load();
      if (!(tabId in firstSeen)) {
        firstSeen[tabId] = now();
        await persist();
      }
    },
    async noteRemoved(tabId) {
      await load();
      const had = tabId in firstSeen || blocked.has(tabId);
      delete firstSeen[tabId];
      blocked.delete(tabId);
      if (had) await persist();
    },
    /** One sweep at a time; concurrent callers share the running one. */
    sweep() {
      if (!sweeping) {
        sweeping = sweep().finally(() => {
          sweeping = null;
        });
      }
      return sweeping;
    },
    getSettings: () => settings,
    getFirstSeen: () => ({ ...(firstSeen ?? {}) }),
    isBlocked: (tabId) => Boolean(blocked?.has(tabId)),
  };
}
