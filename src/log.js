// Capped, newest-first log of closed tabs, stored in chrome.storage.local.

export const MAX_LOG_ENTRIES = 100;

/** History keeps web origins and paths, with credentials and URL tokens removed. */
export function historyUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function sanitizeLog(log) {
  return log.map((entry) => ({ ...entry, url: historyUrl(entry.url) }));
}

// Web Locks coordinate the worker and settings pages (including Clear history).
// Node 20 has no Web Locks; keep its dependency-injected tests serialized too.
const queues = new WeakMap();
function withLogLock(storage, operation) {
  if (globalThis.navigator?.locks) return navigator.locks.request('tabkeeper-close-log', operation);
  const run = (queues.get(storage) ?? Promise.resolve()).then(operation);
  queues.set(storage, run.catch(() => {}));
  return run;
}

export function addLogEntry(storage, entry, max = MAX_LOG_ENTRIES) {
  return withLogLock(storage, async () => {
    const log = await storage.getLog();
    const next = sanitizeLog([entry, ...log].slice(0, max));
    await storage.setLog(next);
    return next;
  });
}

/** Scrub legacy entries under the same lock as appends and Clear. */
export function readLog(storage) {
  return withLogLock(storage, async () => {
    const log = await storage.getLog();
    const next = sanitizeLog(log);
    if (JSON.stringify(next) !== JSON.stringify(log)) await storage.setLog(next);
    return next;
  });
}

export function clearLog(storage) {
  return withLogLock(storage, () => storage.setLog([]));
}
