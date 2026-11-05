// Feature A (group tabs by URL rule) and the worker half of Feature B (apply a
// page status to the group title). Every mutation of the group record and every
// group lookup runs through one promise queue so concurrent tab events for the
// same ticket cannot create two groups. Page reads can take seconds, so they run
// outside the queue and re-enter it only to apply their result.

import {
  compileGroupRules,
  matchGroupRules,
  resolveBaseTitle,
  normalizeGroupRule,
  isIgnoredUrl,
  isDynamicTitle,
  pickColor,
  originOf,
} from './group-rules.js';
import { buildTitle, parseTitle, composeStatus, clampLimit, SEPARATOR } from './titles.js';
import { createGroupRecord } from './group-record.js';
import { GROUP_COLORS } from './group-rules.js';
import {
  AWS_RULE_ID,
  normalizeAwsSettings,
  compileAwsPattern,
  awsReadFields,
  parseAwsRead,
  composeAwsTitle,
} from './aws.js';

export const READ_TIMEOUT_MS = 10_000;
export const TEST_TIMEOUT_MS = 3_000;
const NO_GROUP = -1;

export function createGrouper({
  storage,
  tabs,
  tabGroups,
  statusReader = null, // { hasAccess(origin), read(tabId, fields, opts) } or null
  isPendingClose = () => false,
  random = Math.random,
  logger = console,
}) {
  let compiled = [];
  let limit = 0;
  let aws = normalizeAwsSettings(null);
  let awsRegex = null;
  const record = createGroupRecord(storage);
  const inflight = new Set();

  let queue = Promise.resolve();
  function enqueue(fn) {
    const run = queue.then(fn);
    queue = run.catch((err) => logger.error('[tabkeeper] grouping', err));
    return run;
  }
  function track(promise) {
    const safe = promise.catch((err) => logger.warn('[tabkeeper] status read failed', err?.message ?? err));
    inflight.add(safe);
    safe.finally(() => inflight.delete(safe));
    return safe;
  }

  // ---- rules ----

  async function loadRules() {
    compiled = compileGroupRules(await storage.getGroupRules());
    for (const c of compiled) {
      if (c.error) logger.warn(`[tabkeeper] grouping rule "${c.rule.name}" skipped: ${c.error}`);
    }
    aws = normalizeAwsSettings(await storage.getAwsSettings());
    awsRegex = compileAwsPattern(aws);
    if (aws.enabled && !awsRegex) logger.warn('[tabkeeper] AWS console URL pattern does not compile; AWS grouping is off');
  }

  function isAwsTab(tab) {
    return aws.enabled && awsRegex !== null && typeof tab.url === 'string' && awsRegex.test(tab.url);
  }

  function randomColor() {
    return GROUP_COLORS[Math.floor(random() * GROUP_COLORS.length) % GROUP_COLORS.length];
  }

  function matchTab(tab, rules = compiled) {
    const m = matchGroupRules(rules, { url: tab.url, title: tab.title });
    if (!m) return null;
    const baseTitle = resolveBaseTitle(m.rule, m.match);
    return baseTitle ? { ...m, baseTitle } : null;
  }

  // ---- groups ----

  async function groupExists(groupId) {
    try {
      await tabGroups.get(groupId);
      return true;
    } catch {
      return false;
    }
  }

  /** Inside the queue. Returns { entry, created, moved }. */
  async function findOrCreateGroup(tab, { baseTitle, statusEnabled, ruleId, color }) {
    const windowId = tab.windowId;
    let entry = record.get(windowId, baseTitle);
    if (entry && !(await groupExists(entry.groupId))) {
      record.remove(windowId, baseTitle);
      entry = null;
    }

    if (!entry) {
      // Fresh session or restarted worker: adopt an existing group whose title we could have produced.
      let groups = [];
      try {
        groups = await tabGroups.query({ windowId });
      } catch {
        groups = [];
      }
      for (const g of groups) {
        if (record.findByGroupId(g.id)) continue; // owned under another base title
        const parsed = parseTitle(g.title ?? '', baseTitle, { statusEnabled, limit });
        if (parsed) {
          entry = { groupId: g.id, status: parsed.status, ruleId };
          record.set(windowId, baseTitle, entry);
          break;
        }
      }
    }

    if (!entry) {
      const groupId = await tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
      await tabGroups.update(groupId, { title: buildTitle(baseTitle, '', limit), color });
      entry = { groupId, status: null, ruleId };
      record.set(windowId, baseTitle, entry);
      await record.persist();
      return { entry, created: true, moved: true };
    }

    let moved = false;
    if (tab.groupId !== entry.groupId) {
      await tabs.group({ tabIds: [tab.id], groupId: entry.groupId });
      moved = true;
    }
    await record.persist();
    return { entry, created: false, moved };
  }

  /** Inside the queue. */
  async function evaluateTab(tab) {
    if (!tab || typeof tab.id !== 'number') return { matched: false, reason: 'no-tab' };
    if (isIgnoredUrl(tab.url)) return { matched: false, reason: 'ignored-url' };
    if (tab.pinned) return { matched: false, reason: 'pinned' };
    if (isPendingClose(tab.id)) return { matched: false, reason: 'pending-close' };
    await record.load();
    if (isAwsTab(tab)) return evaluateAwsTab(tab);
    const m = matchTab(tab);
    if (!m) return { matched: false, reason: 'no-rule' };

    let placed;
    try {
      placed = await findOrCreateGroup(tab, {
        baseTitle: m.baseTitle,
        statusEnabled: m.rule.statusEnabled,
        ruleId: m.rule.id,
        color: pickColor(m.rule, random, m.baseTitle),
      });
    } catch (err) {
      logger.warn('[tabkeeper] could not group tab', tab.id, err?.message ?? err);
      return { matched: true, grouped: false, baseTitle: m.baseTitle, ruleId: m.rule.id };
    }
    if (m.rule.statusEnabled && statusReader) scheduleRead(tab, m.rule, m.baseTitle, placed.entry.status);
    return {
      matched: true,
      grouped: true,
      baseTitle: m.baseTitle,
      ruleId: m.rule.id,
      groupId: placed.entry.groupId,
      created: placed.created,
      moved: placed.moved,
    };
  }

  // ---- AWS console ----

  /**
   * Inside the queue. The account/role live in the page, so the read runs outside
   * the queue and placement re-enters it. Returns immediately with pending: true.
   */
  async function evaluateAwsTab(tab) {
    if (!statusReader) return { matched: true, aws: true, grouped: false, reason: 'no-reader' };
    const origin = originOf(tab.url);
    if (!origin || !(await statusReader.hasAccess(origin))) {
      logger.warn(`[tabkeeper] no access to ${origin || tab.url}; AWS console tab not grouped`);
      return { matched: true, aws: true, grouped: false, reason: 'no-access' };
    }
    const settings = aws;
    track(
      (async () => {
        const read = await statusReader.read(tab.id, awsReadFields(settings), {
          timeoutMs: READ_TIMEOUT_MS,
          watch: false,
          lastStatus: '',
        });
        const info = parseAwsRead(read, tab.url);
        const title = composeAwsTitle(settings, info);
        if (!title) {
          logger.warn('[tabkeeper] AWS console tab', tab.id, 'exposed none of the chosen fields; not grouped');
          return;
        }
        await enqueue(async () => {
          let fresh;
          try {
            fresh = await tabs.get(tab.id);
          } catch {
            return; // closed meanwhile
          }
          if (!isAwsTab(fresh) || fresh.pinned || isPendingClose(fresh.id)) return;
          try {
            await findOrCreateGroup(fresh, { baseTitle: title, statusEnabled: false, ruleId: AWS_RULE_ID, color: randomColor() });
          } catch (err) {
            logger.warn('[tabkeeper] could not group AWS console tab', fresh.id, err?.message ?? err);
          }
        });
      })(),
    );
    return { matched: true, aws: true, pending: true };
  }

  /** Dry run for the popup: what would be read and what the group would be called. */
  async function testAws(tab, overrideSettings = null) {
    const settings = overrideSettings ? normalizeAwsSettings(overrideSettings) : aws;
    const regex = compileAwsPattern(settings);
    const out = { url: tab?.url ?? '', title: tab?.title ?? '', matched: false, info: null, fields: null, groupTitle: '', finalTitle: '', shortened: false, limit, origin: '', error: null };
    if (!tab || isIgnoredUrl(tab.url)) {
      out.error = 'browser-page';
      return out;
    }
    if (!regex) {
      out.error = 'invalid-regex';
      return out;
    }
    if (!regex.test(tab.url)) {
      out.error = 'not-aws';
      return out;
    }
    out.matched = true;
    out.origin = originOf(tab.url);
    if (!statusReader || !out.origin || !(await statusReader.hasAccess(out.origin))) {
      out.error = 'access-not-granted';
      return out;
    }
    const read = await statusReader.read(tab.id, awsReadFields(settings), { timeoutMs: TEST_TIMEOUT_MS, watch: false, lastStatus: '' });
    if (!read) {
      out.error = 'read-failed';
      return out;
    }
    out.fields = read.results;
    out.info = parseAwsRead(read, tab.url);
    out.groupTitle = composeAwsTitle(settings, out.info);
    if (!out.groupTitle) {
      out.error = 'nothing-read';
      return out;
    }
    out.finalTitle = buildTitle(out.groupTitle, '', limit);
    out.shortened = out.finalTitle !== out.groupTitle;
    return out;
  }

  // ---- status ----

  /** Outside the queue: a read may wait up to READ_TIMEOUT_MS. */
  function scheduleRead(tab, rule, baseTitle, lastStatus) {
    return track(
      (async () => {
        const origin = originOf(tab.url);
        if (!origin || !(await statusReader.hasAccess(origin))) {
          logger.warn(`[tabkeeper] no access to ${origin || tab.url}; status not read for "${baseTitle}"`);
          return;
        }
        const read = await statusReader.read(tab.id, rule.statusFields, {
          timeoutMs: READ_TIMEOUT_MS,
          watch: true,
          lastStatus: lastStatus ?? '',
        });
        if (!read) return;
        const status = composeStatus(rule.statusFields, read.results.map((r) => r.value));
        if (!status) return; // a miss never clears an existing suffix
        await enqueue(() => applyStatus({ tabId: tab.id, windowId: tab.windowId, baseTitle, status }));
      })(),
    );
  }

  /** Inside the queue. The caller states which base title the tab belongs to. */
  async function applyStatus({ tabId, windowId, baseTitle, status }) {
    await record.load();
    if (!status) return { applied: false, reason: 'empty' };
    const entry = record.get(windowId, baseTitle);
    if (!entry) return { applied: false, reason: 'unrecorded' };

    let tab;
    try {
      tab = await tabs.get(tabId);
    } catch {
      return { applied: false, reason: 'tab-gone' };
    }
    if (tab.groupId !== entry.groupId) {
      const owner = record.findByGroupId(tab.groupId);
      logger.warn(
        `[tabkeeper] refusing to rename group ${entry.groupId} ("${baseTitle}"): tab ${tabId} is in group ${tab.groupId}` +
          (owner ? ` recorded as "${owner.baseTitle}"` : ' (not recorded)'),
      );
      return { applied: false, reason: 'mismatched-group' };
    }
    if (entry.status === status) return { applied: false, reason: 'unchanged' };

    try {
      await tabGroups.update(entry.groupId, { title: buildTitle(baseTitle, status, limit) });
    } catch {
      record.remove(windowId, baseTitle);
      await record.persist();
      return { applied: false, reason: 'group-gone' };
    }
    record.set(windowId, baseTitle, { ...entry, status });
    await record.persist();
    return { applied: true, title: buildTitle(baseTitle, status, limit) };
  }

  /** Inside the queue. A report from a page observer; never trusted blindly. */
  async function onStatusReport(senderTab, results) {
    if (!senderTab || typeof senderTab.id !== 'number') return { applied: false, reason: 'no-sender' };
    let tab;
    try {
      tab = await tabs.get(senderTab.id);
    } catch {
      return { applied: false, reason: 'tab-gone' };
    }
    if (tab.groupId === NO_GROUP) return { applied: false, reason: 'ungrouped' };
    const m = matchTab(tab);
    if (!m || !m.rule.statusEnabled) return { applied: false, reason: 'no-status-rule' };
    await record.load();
    const entry = record.get(tab.windowId, m.baseTitle);
    if (!entry || entry.groupId !== tab.groupId) return { applied: false, reason: 'mismatched-group' };
    const status = composeStatus(m.rule.statusFields, (results ?? []).map((r) => r?.value));
    if (!status) return { applied: false, reason: 'empty' };
    return applyStatus({ tabId: tab.id, windowId: tab.windowId, baseTitle: m.baseTitle, status });
  }

  // ---- settings ----

  async function retitleAll() {
    await record.load();
    let changed = 0;
    for (const e of record.entries()) {
      const title = buildTitle(e.baseTitle, e.status ?? '', limit);
      try {
        const g = await tabGroups.get(e.groupId);
        if (g.title !== title) {
          await tabGroups.update(e.groupId, { title });
          changed++;
        }
      } catch {
        record.remove(e.windowId, e.baseTitle);
      }
    }
    await record.persist();
    return { changed, limit };
  }

  async function setTitleLimit(value) {
    limit = clampLimit(value);
    await storage.setMaxTitleLength(limit);
    return retitleAll();
  }

  // ---- popup helpers ----

  /** Dry run of an unsaved rule against a tab: nothing is grouped, no observer is installed. */
  async function testRule(rawRule, tab) {
    const rule = normalizeGroupRule({ ...rawRule, enabled: true });
    const out = {
      url: tab?.url ?? '',
      title: tab?.title ?? '',
      matched: false,
      matchedOn: null,
      baseTitle: '',
      fixed: !isDynamicTitle(rule),
      statusEnabled: rule.statusEnabled,
      status: '',
      fields: null,
      finalTitle: '',
      shortened: false,
      limit,
      origin: '',
      error: null,
      detail: null,
    };
    if (!tab || isIgnoredUrl(tab.url)) {
      out.error = 'browser-page';
      return out;
    }
    const [c] = compileGroupRules([rule]);
    if (!c.regex) {
      out.error = 'invalid-regex';
      out.detail = c.error;
      return out;
    }
    const m = matchGroupRules([c], { url: tab.url, title: tab.title });
    if (!m) {
      out.error = 'regex-no-match';
      return out;
    }
    out.matched = true;
    out.matchedOn = m.matchedOn;
    out.baseTitle = resolveBaseTitle(rule, m.match);
    if (!out.baseTitle) {
      out.error = 'empty-title';
      return out;
    }
    if (rule.statusEnabled) {
      out.origin = originOf(tab.url);
      if (!statusReader || !out.origin || !(await statusReader.hasAccess(out.origin))) {
        out.error = 'access-not-granted';
      } else {
        const read = await statusReader.read(tab.id, rule.statusFields, {
          timeoutMs: TEST_TIMEOUT_MS,
          watch: false,
          lastStatus: '',
        });
        if (read) {
          out.fields = read.results;
          out.status = composeStatus(rule.statusFields, read.results.map((r) => r.value));
        } else {
          out.error = 'read-failed';
        }
      }
    }
    const full = out.baseTitle + (out.status ? SEPARATOR + out.status : '');
    out.finalTitle = buildTitle(out.baseTitle, out.status, limit);
    out.shortened = out.finalTitle !== full;
    return out;
  }

  /** Run every rule (and AWS) against every open tab. Returns counts for the popup. */
  async function applyToAll() {
    const all = await tabs.query({});
    let grouped = 0;
    let pendingReads = 0;
    for (const tab of all) {
      const r = await evaluateTab(tab);
      if (r?.grouped) grouped++;
      if (r?.pending) pendingReads++;
    }
    return { tabs: all.length, grouped, pendingReads };
  }

  async function start() {
    await loadRules();
    limit = clampLimit(await storage.getMaxTitleLength());
    await record.load();
  }

  return {
    start: () => enqueue(start),
    evaluateTab: (tab) => enqueue(() => evaluateTab(tab)),
    applyToTab: (tab) => enqueue(() => evaluateTab(tab)),
    applyToAll: () => enqueue(applyToAll),
    applyStatus: (args) => enqueue(() => applyStatus(args)),
    onStatusReport: (senderTab, results) => enqueue(() => onStatusReport(senderTab, results)),
    onGroupRemoved: (groupId) =>
      enqueue(async () => {
        await record.load();
        if (record.removeGroup(groupId)) await record.persist();
      }),
    onWindowRemoved: (windowId) =>
      enqueue(async () => {
        await record.load();
        if (record.removeWindow(windowId)) await record.persist();
      }),
    onRulesChanged: () => enqueue(loadRules),
    setTitleLimit: (value) => enqueue(() => setTitleLimit(value)),
    retitleAll: () => enqueue(retitleAll),
    testRule: (rule, tab) => enqueue(() => testRule(rule, tab)),
    testAws: (tab, settings) => enqueue(() => testAws(tab, settings)),
    getAwsSettings: () => aws,
    getLimit: () => limit,
    /** Tests: wait for queued work and in-flight page reads. */
    idle: async () => {
      await queue;
      await Promise.all([...inflight]);
      await queue;
    },
    getRecord: () => record.snapshot(),
  };
}
