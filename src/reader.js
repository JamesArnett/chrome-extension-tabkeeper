// Injected into pages (all frames) after status-core.js. Classic script: it must
// not reference anything from the service worker. Exposes
// globalThis.TabkeeperReader.read(payload) which resolves once every field
// has a value or the deadline passes, and optionally installs one persistent
// observer per document that reports status changes back to the worker.
(function () {
  if (globalThis.TabkeeperReader) return;
  const core = globalThis.TabkeeperStatusCore;
  const OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] };
  const watcher = { observer: null, fields: null, lastReported: '', debounce: null };

  function serialize(snapshot) {
    return {
      results: snapshot.results.map((r) => ({
        value: r.value,
        raw: r.raw,
        element: r.element,
        matched: r.matched,
        error: r.error,
      })),
      matchedTotal: snapshot.matchedTotal,
      valueCount: snapshot.valueCount,
      complete: snapshot.complete,
      frameUrl: String(location.href),
    };
  }

  function report() {
    const snap = core.readFields(document, watcher.fields);
    const joined = core.joinValues(watcher.fields, snap.results);
    if (!joined || joined === watcher.lastReported) return;
    watcher.lastReported = joined;
    try {
      const p = chrome.runtime.sendMessage({ type: 'status-report', results: serialize(snap).results });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (err) {
      // Extension reloaded or unloaded; nothing to report to.
    }
  }

  /** One observer per document; a repeat call only refreshes fields and the last-known value. */
  function installWatcher(fields, lastReported) {
    watcher.fields = fields;
    watcher.lastReported = lastReported || '';
    if (watcher.observer) return;
    watcher.observer = new MutationObserver(function () {
      clearTimeout(watcher.debounce);
      watcher.debounce = setTimeout(report, 250);
    });
    watcher.observer.observe(document, OBSERVE);
  }

  function read(payload) {
    const fields = (payload && payload.fields) || [{ selector: '' }];
    const timeoutMs = (payload && payload.timeoutMs) || 10000;
    const watch = Boolean(payload && payload.watch);
    const lastStatus = (payload && payload.lastStatus) || '';

    return new Promise(function (resolve) {
      let done = false;
      let observer = null;
      let deadline = null;
      let tick = null;

      function finish(snapshot) {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        clearTimeout(deadline);
        clearTimeout(tick);
        if (watch) installWatcher(fields, core.joinValues(fields, snapshot.results) || lastStatus);
        resolve(serialize(snapshot));
      }

      const first = core.readFields(document, fields);
      if (first.complete) {
        finish(first);
        return;
      }
      observer = new MutationObserver(function () {
        if (tick) return;
        tick = setTimeout(function () {
          tick = null;
          const snap = core.readFields(document, fields);
          if (snap.complete) finish(snap);
        }, 50);
      });
      observer.observe(document, OBSERVE);
      deadline = setTimeout(function () {
        finish(core.readFields(document, fields)); // return whatever is there now
      }, timeoutMs);
    });
  }

  globalThis.TabkeeperReader = { read };
})();
