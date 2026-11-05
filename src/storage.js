// Thin wrappers around chrome.storage areas. Accepts the chrome.storage object
// (or an in-memory mock) so it can be tested without a browser.
//
// sync:    rule:<id> + ruleOrder        (close rules)
//          grule:<id> + groupRuleOrder  (grouping rules)
//          awsSettings                  (AWS console grouping)
//          closeSettings                (countdown-group placement, age-based closing)
// local:   paused, pausedUntil, log, draft, groupDraft, maxTitleLength
// session: pending (tabId -> { ruleId, ruleName, deadline, title, url, groupId, prevGroupId })
//          groupRecord (windowId -> baseTitle -> { groupId, status, ruleId })
//          firstSeen (tabId -> timestamp), ageBlocked (tab ids that resisted an age close)
//          closingGroups (windowId -> groupId of that window's "Closing" group)
//          kept (tabId -> rule ids the user pressed Keep on; the tab is exempt from those while open)

export const RULE_PREFIX = 'rule:';
export const GROUP_RULE_PREFIX = 'grule:';

/** One-key-per-rule collection in a storage area, kept under the 8 KB sync item cap. */
function ruleCollection(area, prefix, orderKey) {
  async function getOrder() {
    const { [orderKey]: order } = await area.get(orderKey);
    return Array.isArray(order) ? order : [];
  }
  return {
    async getAll() {
      const all = await area.get(null);
      const order = Array.isArray(all[orderKey]) ? all[orderKey] : [];
      const byId = new Map();
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(prefix) || !value || typeof value !== 'object') continue;
        const id = typeof value.id === 'string' ? value.id : key.slice(prefix.length);
        byId.set(id, value);
      }
      const ordered = [];
      for (const id of order) {
        const rule = byId.get(id);
        if (rule) {
          ordered.push(rule);
          byId.delete(id);
        }
      }
      // Rules missing from the order list (e.g. partial sync) go at the end, oldest first.
      const orphans = [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      return ordered.concat(orphans);
    },
    async save(rule) {
      const order = await getOrder();
      const updates = { [prefix + rule.id]: rule };
      if (!order.includes(rule.id)) updates[orderKey] = [...order, rule.id];
      await area.set(updates);
    },
    async saveMany(rules) {
      const order = await getOrder();
      const updates = {};
      const nextOrder = [...order];
      for (const rule of rules) {
        updates[prefix + rule.id] = rule;
        if (!nextOrder.includes(rule.id)) nextOrder.push(rule.id);
      }
      updates[orderKey] = nextOrder;
      await area.set(updates);
    },
    async delete(id) {
      await area.remove(prefix + id);
      const order = await getOrder();
      await area.set({ [orderKey]: order.filter((x) => x !== id) });
    },
    async setOrder(ids) {
      await area.set({ [orderKey]: ids });
    },
  };
}

export function createStorage(chromeStorage) {
  const { sync, local, session } = chromeStorage;
  const closeRules = ruleCollection(sync, RULE_PREFIX, 'ruleOrder');
  const groupRules = ruleCollection(sync, GROUP_RULE_PREFIX, 'groupRuleOrder');

  return {
    getRules: () => closeRules.getAll(),
    saveRule: (rule) => closeRules.save(rule),
    saveRules: (rules) => closeRules.saveMany(rules),
    deleteRule: (id) => closeRules.delete(id),
    setRuleOrder: (ids) => closeRules.setOrder(ids),

    getGroupRules: () => groupRules.getAll(),
    saveGroupRule: (rule) => groupRules.save(rule),
    saveGroupRules: (rules) => groupRules.saveMany(rules),
    deleteGroupRule: (id) => groupRules.delete(id),
    setGroupRuleOrder: (ids) => groupRules.setOrder(ids),

    async getAwsSettings() {
      const { awsSettings } = await sync.get('awsSettings');
      return awsSettings && typeof awsSettings === 'object' ? awsSettings : null;
    },
    async setAwsSettings(settings) {
      await sync.set({ awsSettings: settings });
    },

    async getCloseSettings() {
      const { closeSettings } = await sync.get('closeSettings');
      return closeSettings && typeof closeSettings === 'object' ? closeSettings : null;
    },
    async setCloseSettings(settings) {
      await sync.set({ closeSettings: settings });
    },

    async getFirstSeen() {
      const { firstSeen } = await session.get('firstSeen');
      return firstSeen && typeof firstSeen === 'object' ? firstSeen : {};
    },
    async setFirstSeen(map) {
      await session.set({ firstSeen: map });
    },
    async getAgeBlocked() {
      const { ageBlocked } = await session.get('ageBlocked');
      return Array.isArray(ageBlocked) ? ageBlocked : [];
    },
    async setAgeBlocked(ids) {
      await session.set({ ageBlocked: ids });
    },

    async getMaxTitleLength() {
      const { maxTitleLength } = await local.get('maxTitleLength');
      return Number.isFinite(maxTitleLength) ? maxTitleLength : 0;
    },
    async setMaxTitleLength(value) {
      await local.set({ maxTitleLength: Number(value) || 0 });
    },

    async getGroupDraft() {
      const { groupDraft } = await local.get('groupDraft');
      return groupDraft ?? null;
    },
    async setGroupDraft(draft) {
      await local.set({ groupDraft: draft });
    },
    async clearGroupDraft() {
      await local.remove('groupDraft');
    },

    async getGroupRecord() {
      const { groupRecord } = await session.get('groupRecord');
      return groupRecord && typeof groupRecord === 'object' ? groupRecord : {};
    },
    async setGroupRecord(record) {
      await session.set({ groupRecord: record });
    },

    async getPaused() {
      const { paused } = await local.get('paused');
      return Boolean(paused);
    },
    /** `until` (ms timestamp) makes it a snooze; null pauses indefinitely. */
    async setPaused(value, until = null) {
      await local.set({ paused: Boolean(value), pausedUntil: value && Number.isFinite(until) ? until : null });
    },
    async getPausedUntil() {
      const { pausedUntil } = await local.get('pausedUntil');
      return Number.isFinite(pausedUntil) ? pausedUntil : null;
    },

    async getKept() {
      const { kept } = await session.get('kept');
      return kept && typeof kept === 'object' ? kept : {};
    },
    async setKept(map) {
      await session.set({ kept: map });
    },

    async getLog() {
      const { log } = await local.get('log');
      return Array.isArray(log) ? log : [];
    },
    async setLog(log) {
      await local.set({ log });
    },

    async getDraft() {
      const { draft } = await local.get('draft');
      return draft ?? null;
    },
    async setDraft(draft) {
      await local.set({ draft });
    },
    async clearDraft() {
      await local.remove('draft');
    },

    async getClosingGroups() {
      const { closingGroups } = await session.get('closingGroups');
      return closingGroups && typeof closingGroups === 'object' ? closingGroups : {};
    },
    async setClosingGroups(map) {
      await session.set({ closingGroups: map });
    },

    async getPending() {
      const { pending } = await session.get('pending');
      return pending && typeof pending === 'object' ? pending : {};
    },
    async setPending(pending) {
      await session.set({ pending });
    },
  };
}
