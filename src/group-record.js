// Session-scoped record of the groups the extension created or adopted:
// { [windowId]: { [baseTitle]: { groupId, status, ruleId } } }.
// Group ids do not survive a browser restart, hence chrome.storage.session.
// Callers must serialise access (the grouper's queue does).

export function createGroupRecord(storage) {
  let data = null;

  async function load() {
    if (data === null) {
      const stored = await storage.getGroupRecord();
      data = stored && typeof stored === 'object' ? stored : {};
    }
    return data;
  }

  async function persist() {
    await storage.setGroupRecord(data ?? {});
  }

  return {
    load,
    persist,
    get(windowId, baseTitle) {
      return data?.[windowId]?.[baseTitle] ?? null;
    },
    set(windowId, baseTitle, entry) {
      if (!data[windowId]) data[windowId] = {};
      data[windowId][baseTitle] = { ...entry };
    },
    remove(windowId, baseTitle) {
      if (!data?.[windowId]) return false;
      const had = baseTitle in data[windowId];
      delete data[windowId][baseTitle];
      if (Object.keys(data[windowId]).length === 0) delete data[windowId];
      return had;
    },
    /** Which (window, baseTitle) owns this group id, if any. */
    findByGroupId(groupId) {
      for (const [windowId, byTitle] of Object.entries(data ?? {})) {
        for (const [baseTitle, entry] of Object.entries(byTitle)) {
          if (entry.groupId === groupId) return { windowId: Number(windowId), baseTitle, entry };
        }
      }
      return null;
    },
    removeGroup(groupId) {
      const hit = this.findByGroupId(groupId);
      if (!hit) return false;
      this.remove(hit.windowId, hit.baseTitle);
      return true;
    },
    removeWindow(windowId) {
      if (!data?.[windowId]) return false;
      delete data[windowId];
      return true;
    },
    entries() {
      const out = [];
      for (const [windowId, byTitle] of Object.entries(data ?? {})) {
        for (const [baseTitle, entry] of Object.entries(byTitle)) {
          out.push({ windowId: Number(windowId), baseTitle, ...entry });
        }
      }
      return out;
    },
    snapshot() {
      return JSON.parse(JSON.stringify(data ?? {}));
    },
  };
}
