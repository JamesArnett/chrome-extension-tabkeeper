// Debounced persistence of the in-progress rule form so that closing the
// popup mid-edit does not lose work.

export const DEFAULT_DEBOUNCE_MS = 100;

export function createDraftStore(
  storage,
  {
    debounceMs = DEFAULT_DEBOUNCE_MS,
    setTimeout: setT = globalThis.setTimeout,
    clearTimeout: clearT = globalThis.clearTimeout,
  } = {},
) {
  let timer = null;
  let latest = null;
  let dirty = false;

  function cancelTimer() {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  }

  async function flush() {
    cancelTimer();
    if (!dirty) return;
    dirty = false;
    await storage.setDraft(latest);
  }

  return {
    /** Record new form state; written after the debounce window or on flush(). */
    save(state) {
      latest = state;
      dirty = true;
      cancelTimer();
      timer = setT(() => {
        timer = null;
        void flush();
      }, debounceMs);
    },
    flush,
    load() {
      return storage.getDraft();
    },
    async clear() {
      cancelTimer();
      dirty = false;
      latest = null;
      await storage.clearDraft();
    },
  };
}
