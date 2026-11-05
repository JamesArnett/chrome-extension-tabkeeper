// Capped, newest-first log of closed tabs, stored in chrome.storage.local.

export const MAX_LOG_ENTRIES = 100;

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
    const next = [entry, ...log].slice(0, max);
    await storage.setLog(next);
    return next;
  });
}

export function clearLog(storage) {
  return withLogLock(storage, () => storage.setLog([]));
}
