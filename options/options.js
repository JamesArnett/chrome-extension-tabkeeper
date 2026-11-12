// Settings page (opened in a tab). Three views behind a Close | Group | AWS tab bar
// plus shared pause, closing-soon, and import/export. All DOM is built with
// createElement/textContent; no innerHTML.

import { api as chrome, IS_FIREFOX, extensionSettingsUrl, hostPermission } from '../src/browser-api.js';
import { applyBrowserCopy } from '../popup/browser-copy.js';
import { createStorage } from '../src/storage.js';
import {
  MODES,
  MODE_LABELS,
  DEFAULT_DELAY_SECONDS,
  newRule,
  normalizeRule,
  validateRule,
  validateCondition,
  summarizeRule,
  exportRules,
  suggestFieldsFromTab,
} from '../src/rules.js';
import {
  GROUP_COLORS,
  COLOR_MODES,
  newGroupRule,
  emptyStatusField,
  normalizeGroupRule,
  validateGroupRule,
  originOf,
  isDynamicTitle,
  summarizeStatusFields,
} from '../src/group-rules.js';
import { PRESETS, getPreset } from '../src/presets.js';
import {
  AWS_FIELD_ORDER,
  AWS_FIELD_LABELS,
  AWS_SEPARATORS,
  AWS_HOST_PERMISSION,
  AWS_SAMPLE_INFO,
  defaultAwsSettings,
  normalizeAwsSettings,
  composeAwsTitle,
} from '../src/aws.js';
import { AGE_UNIT_ORDER, defaultCloseSettings, normalizeCloseSettings, parseNeverClose, describeLimit } from '../src/age-closer.js';
import { prepareSettingsImport, hasBroadMatch } from '../src/import-settings.js';
import { compileRegex } from '../src/regex.js';
import { clampLimit } from '../src/titles.js';
import { explainClose } from '../src/explain.js';
import { compileRule, ruleMatches } from '../src/matcher.js';
import { compileGroupRules, matchGroupRules, isIgnoredUrl } from '../src/group-rules.js';
import { createDraftStore } from '../src/draft.js';
import { clearLog } from '../src/log.js';
import {
  $,
  el,
  formatDelay,
  send,
  setNotice,
  pickActiveTab,
  buildPauseSelect,
  renderPause,
  applyPauseChoice,
  renderPendingList,
  renderLogList,
  reopenEntry,
} from '../popup/shared.js';

const core = globalThis.TabkeeperStatusCore; // loaded by <script src="../src/status-core.js">
applyBrowserCopy();
const storage = createStorage(chrome.storage);
const draft = createDraftStore(storage);
const groupDraft = createDraftStore({
  setDraft: (d) => storage.setGroupDraft(d),
  getDraft: () => storage.getGroupDraft(),
  clearDraft: () => storage.clearGroupDraft(),
});

const ids = [
  'pause-select', 'pause-label', 'stale-banner', 'reload-extension', 'pending-section', 'pending-list',
  'view-close', 'view-group', 'view-aws',
  'test-close', 'close-test-result', 'rules-empty', 'rule-list', 'rules-filter-note', 'group-rules-filter-note', 'add-rule', 'form-section', 'form-title', 'draft-notice', 'prefill-notice',
  'rule-form', 'save-rule', 'cancel-rule', 'log-details', 'log-count', 'log-empty', 'log-list', 'clear-log',
  'export-rules', 'import-text', 'import-rules', 'io-status', 'import-preview', 'import-summary', 'confirm-import', 'cancel-import',
  'opt-open-enabled', 'opt-open-value', 'opt-open-unit', 'opt-idle-enabled', 'opt-idle-value', 'opt-idle-unit', 'opt-error', 'opt-never-close', 'opt-collapse', 'auto-close-details',
  'title-limit', 'save-limit', 'limit-status', 'apply-group', 'apply-all', 'apply-status', 'add-group-rule', 'group-rules-empty', 'group-rule-list',
  'group-form-section', 'group-form-title', 'group-draft-notice', 'preset-select', 'preset-notes', 'group-form', 'swatches', 'status-block', 'status-fields',
  'add-status-field', 'save-group-rule', 'test-group-rule', 'cancel-group-rule', 'test-result',
  'group-permission-save', 'group-permission-test',
  'aws-enabled', 'aws-access', 'aws-grant', 'aws-settings', 'aws-options', 'aws-fields', 'aws-separator', 'aws-preview', 'aws-sel-account', 'aws-sel-role',
  'aws-url-pattern', 'aws-advanced-error', 'aws-reset', 'aws-test', 'aws-apply', 'aws-status', 'aws-result',
];
const camel = (id) => id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const els = { body: document.body, tabs: document.querySelectorAll('.tabs .tab') };
for (const id of ids) els[camel(id)] = $(id);

// The toolbar popup loads this same page with ?popup=1: compact width, only the rules that match the
// current tab, and an "All rules" button that opens the full page in a tab.
const IN_POPUP = new URLSearchParams(location.search).has('popup');

let rules = [];
let groupRules = [];
let awsSettings = defaultAwsSettings();
let closeSettings = defaultCloseSettings();
let formState = { open: false, editingId: null };
let groupFormState = { open: false, editingId: null };
let pendingTick = null;
let activeTab = null; // cached at open so permission requests can run synchronously in click handlers
let pendingImport = null;

// ---------- generic ----------

function fillModeSelect(select) {
  for (const mode of MODES) select.append(el('option', { value: mode, text: MODE_LABELS[mode] }));
}

function showErrors(form, errors) {
  for (const node of form.querySelectorAll('[data-error]')) node.textContent = errors[node.dataset.error] ?? '';
}

function probeSelector(selector) {
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** A collapsible rule entry: one head row (chevron, name, controls) and a details block. */
function ruleEntry({ className = '', name, details, controls, expanded = false }) {
  const detailsBox = el('div', { class: 'details' }, details);
  detailsBox.hidden = !expanded;
  const chevron = el('button', { type: 'button', class: 'icon chevron', title: 'Show details', 'aria-expanded': String(expanded), text: '▸' });
  const toggle = () => {
    detailsBox.hidden = !detailsBox.hidden;
    chevron.setAttribute('aria-expanded', String(!detailsBox.hidden));
    chevron.title = detailsBox.hidden ? 'Show details' : 'Hide details';
  };
  chevron.addEventListener('click', toggle);
  name.classList.add('name');
  name.addEventListener('click', toggle);
  return el('li', { class: className }, [el('div', { class: 'head' }, [chevron, name, el('span', { class: 'controls' }, controls)]), detailsBox]);
}

function showView(view) {
  els.viewClose.hidden = view !== 'close';
  els.viewGroup.hidden = view !== 'group';
  els.viewAws.hidden = view !== 'aws';
  for (const tab of els.tabs) tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  chrome.storage.local.set({ popupView: view }).catch(() => {});
}

async function checkStaleWorker() {
  if (IS_FIREFOX || chrome.runtime.getManifest().update_url) return; // never show the developer banner for AMO/store installs
  const mismatch = async () => {
    const res = await send({ type: 'version' });
    return res?.ok && res.build && res.now && res.build !== res.now ? res : null;
  };
  try {
    if (!(await mismatch())) return;
    await new Promise((r) => setTimeout(r, 1000));
    const second = await mismatch();
    if (!second) return;
    console.info('[tabkeeper] worker started with build', second.build, 'but files on disk hash to', second.now);
    els.staleBanner.hidden = false;
  } catch {
    // stay quiet
  }
}

const pauseUi = () => ({ select: els.pauseSelect, label: els.pauseLabel, body: els.body });

async function renderPending() {
  const n = await renderPendingList(storage, {
    section: els.pendingSection,
    list: els.pendingList,
    onKeep: async (tabId) => {
      await send({ type: 'cancel', tabId, keep: true });
      await renderPending();
    },
  });
  if (n > 0 && !pendingTick) pendingTick = setInterval(renderPending, 1000);
  if (n === 0 && pendingTick) {
    clearInterval(pendingTick);
    pendingTick = null;
  }
}

async function renderLog() {
  await renderLogList(storage, {
    count: els.logCount,
    empty: els.logEmpty,
    list: els.logList,
    clearButton: els.clearLog,
    onReopen: async (entry) => {
      const ok = await reopenEntry(entry);
      setNotice(els.ioStatus, ok ? `Reopened "${entry.title || entry.url}" in a new tab.` : 'Could not reopen that page.', ok ? 'ok' : 'error');
    },
  });
}

// ---------- rules relevant to the current tab (popup) ----------

function tabInfo() {
  return { title: activeTab?.title ?? '', url: activeTab?.url ?? '' };
}

/** Any close rule (enabled or not) whose conditions match the current tab. */
function closeRuleMatchesTab(rule) {
  if (!activeTab) return false;
  return ruleMatches(compileRule(rule), tabInfo());
}

/** Any grouping rule (enabled or not) whose regex matches the current tab's URL or title. */
function groupRuleMatchesTab(rule) {
  if (!activeTab || isIgnoredUrl(activeTab.url)) return false;
  const [c] = compileGroupRules([rule]);
  if (!c.regex) return false;
  const { title, url } = tabInfo();
  return Boolean(matchGroupRules([{ ...c, rule: { ...rule, enabled: true } }], { title, url }));
}

/** In the popup, show only matching rules and explain where the rest are. */
function filterForPopup(all, matches, { note, empty, kind }) {
  if (!IN_POPUP) {
    note.hidden = true;
    return all;
  }
  const shown = all.filter(matches);
  const others = all.length - shown.length;
  empty.hidden = shown.length > 0;
  empty.textContent = all.length === 0 ? (kind === 'close' ? 'No rules yet. Add one to start closing tabs automatically.' : 'No grouping rules yet. Start from a preset or add your own.') : `No ${kind === 'close' ? 'close' : 'grouping'} rule matches this tab.`;
  note.hidden = others === 0;
  note.textContent = others > 0 ? `${shown.length ? 'Showing the rules that match this tab. ' : ''}${others} other rule${others === 1 ? '' : 's'}: see All rules.` : '';
  return shown;
}

/** After saving from the popup, say where a rule went if it does not match this tab. */
function noteSavedElsewhere(rule, matches, note) {
  if (!IN_POPUP || matches(rule)) return;
  note.hidden = false;
  note.textContent = `Saved "${rule.name || 'rule'}". It does not match this tab, so it is listed under All rules.`;
}

// ======================================================================
// CLOSE VIEW
// ======================================================================

async function loadRules() {
  rules = await storage.getRules();
}

function renderRules() {
  els.ruleList.replaceChildren();
  els.rulesEmpty.hidden = rules.length > 0;
  const visible = filterForPopup(rules, closeRuleMatchesTab, { note: els.rulesFilterNote, empty: els.rulesEmpty, kind: 'close' });
  visible.forEach((rule) => {
    const index = rules.indexOf(rule);
    const { valid, errors } = validateRule(rule);
    const summary = valid ? summarizeRule(rule) : `Invalid rule: ${Object.values(errors).join('; ')}`;
    const toggle = el('input', { type: 'checkbox', title: rule.enabled ? 'Disable rule' : 'Enable rule', onChange: (e) => setRuleEnabled(rule.id, e.target.checked) });
    toggle.checked = rule.enabled;
    const grace = rule.groupAfterSeconds ?? 0;
    els.ruleList.append(
      ruleEntry({
        className: rule.enabled ? '' : 'disabled',
        expanded: !valid,
        name: el('span', { text: `${rule.name || '(unnamed)'} · ${formatDelay(rule.delaySeconds)}` }),
        details: [
          el('span', { class: `summary${valid ? '' : ' invalid'}`, text: summary }),
          grace > 0
            ? el('span', { class: 'summary', text: grace >= rule.delaySeconds ? 'Never moved to the Closing group' : `Moved to the Closing group after ${formatDelay(grace)}` })
            : null,
        ],
        controls: [
          toggle,
          // Reordering a filtered subset would be confusing; order is managed on the All rules page.
          IN_POPUP ? null : el('button', { type: 'button', class: 'icon', text: '↑', title: 'Move up', disabled: index === 0, onClick: () => moveRule(rule.id, -1) }),
          IN_POPUP ? null : el('button', { type: 'button', class: 'icon', text: '↓', title: 'Move down', disabled: index === rules.length - 1, onClick: () => moveRule(rule.id, 1) }),
          el('button', { type: 'button', text: 'Edit', onClick: () => openForm(rule) }),
          el('button', { type: 'button', class: 'danger', text: 'Delete', onClick: () => deleteRule(rule) }),
        ],
      }),
    );
  });
}

async function setRuleEnabled(id, enabled) {
  const rule = rules.find((r) => r.id === id);
  if (rule) await storage.saveRule({ ...rule, enabled });
}

async function moveRule(id, direction) {
  const list = rules.map((r) => r.id);
  const from = list.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= list.length) return;
  [list[from], list[to]] = [list[to], list[from]];
  await storage.setRuleOrder(list);
}

async function deleteRule(rule) {
  if (!confirm(`Delete rule "${rule.name}"?`)) return;
  await storage.deleteRule(rule.id);
  if (formState.open && formState.editingId === rule.id) await closeForm();
}

/** "What would happen to the tab I was on?" for close rules and age-based closing. */
async function onTestClose() {
  const tab = activeTab ?? (await pickActiveTab());
  const box = els.closeTestResult;
  box.hidden = false;
  box.replaceChildren();
  if (!tab) {
    box.className = 'result error';
    box.append(el('p', { text: 'Could not find a tab to test. Switch to the tab you mean, then come back here.' }));
    return;
  }
  const [kept, pendingMap] = await Promise.all([storage.getKept(), storage.getPending()]);
  const candidates = [...rules];
  let note = null;
  if (formState.open) {
    const formRule = fieldsToRule(readFields(), currentEditingRule());
    if (validateRule(formRule).valid) {
      const i = candidates.findIndex((r) => r.id === formRule.id);
      if (i >= 0) candidates[i] = formRule;
      else candidates.push(formRule);
      note = `Includes the unsaved rule "${formRule.name}" from the form.`;
    }
  }
  const result = explainClose(tab, { rules: candidates, closeSettings, keptRuleIds: kept[tab.id] ?? [], isPendingClose: (id) => String(id) in pendingMap });
  box.className = `result ${result.level === 'none' ? 'ok' : 'partial'}`;
  box.append(el('p', { class: 'muted', text: `${tab.title || '(untitled)'} — ${tab.url || ''}` }), ...result.lines.map((line) => el('p', { text: line })));
  if (note) box.append(el('p', { class: 'muted', text: note }));
}

// ---------- close rule form ----------

const f = () => els.ruleForm.elements;

function ruleToFields(rule) {
  return {
    name: rule.name ?? '',
    titleMode: rule.title?.mode ?? 'contains',
    titlePattern: rule.title?.pattern ?? '',
    titleCase: Boolean(rule.title?.caseSensitive),
    urlMode: rule.url?.mode ?? 'contains',
    urlPattern: rule.url?.pattern ?? '',
    urlCase: Boolean(rule.url?.caseSensitive),
    delay: String(rule.delaySeconds ?? DEFAULT_DELAY_SECONDS),
    groupAfter: String(rule.groupAfterSeconds ?? 0),
  };
}

function readFields() {
  const e = f();
  return {
    name: e.name.value,
    titleMode: e.titleMode.value,
    titlePattern: e.titlePattern.value,
    titleCase: e.titleCase.checked,
    urlMode: e.urlMode.value,
    urlPattern: e.urlPattern.value,
    urlCase: e.urlCase.checked,
    delay: e.delay.value,
    groupAfter: e.groupAfter.value,
  };
}

function writeFields(fields) {
  const e = f();
  e.name.value = fields.name ?? '';
  e.titleMode.value = MODES.includes(fields.titleMode) ? fields.titleMode : 'contains';
  e.titlePattern.value = fields.titlePattern ?? '';
  e.titleCase.checked = Boolean(fields.titleCase);
  e.urlMode.value = MODES.includes(fields.urlMode) ? fields.urlMode : 'contains';
  e.urlPattern.value = fields.urlPattern ?? '';
  e.urlCase.checked = Boolean(fields.urlCase);
  e.delay.value = fields.delay ?? String(DEFAULT_DELAY_SECONDS);
  e.groupAfter.value = fields.groupAfter ?? '0';
}

function fieldsToRule(fields, existing) {
  return normalizeRule({
    id: existing?.id,
    createdAt: existing?.createdAt,
    enabled: existing ? existing.enabled : true,
    name: fields.name,
    title: { mode: fields.titleMode, pattern: fields.titlePattern, caseSensitive: fields.titleCase },
    url: { mode: fields.urlMode, pattern: fields.urlPattern, caseSensitive: fields.urlCase },
    delaySeconds: fields.delay,
    groupAfterSeconds: fields.groupAfter,
  });
}

function liveValidate(fields) {
  const errors = {};
  if (fields.titlePattern) {
    const err = validateCondition({ mode: fields.titleMode, pattern: fields.titlePattern, caseSensitive: fields.titleCase });
    if (err) errors.title = err;
  }
  if (fields.urlPattern) {
    const err = validateCondition({ mode: fields.urlMode, pattern: fields.urlPattern, caseSensitive: fields.urlCase });
    if (err) errors.url = err;
  }
  if (fields.delay !== '' && !/^\d+$/.test(fields.delay.trim())) errors.delaySeconds = 'Delay must be a whole number of seconds';
  if (fields.groupAfter !== '' && !/^\d+$/.test(fields.groupAfter.trim())) errors.groupAfterSeconds = 'Enter a whole number of seconds';
  showErrors(els.ruleForm, errors);
  const e = f();
  e.titlePattern.setAttribute('aria-invalid', String(Boolean(errors.title)));
  e.urlPattern.setAttribute('aria-invalid', String(Boolean(errors.url)));
  e.delay.setAttribute('aria-invalid', String(Boolean(errors.delaySeconds)));
  els.saveRule.disabled = Object.keys(errors).length > 0;
}

function currentEditingRule() {
  return formState.editingId ? rules.find((r) => r.id === formState.editingId) ?? null : null;
}

async function openForm(rule = null, { fields = null, fromDraft = false } = {}) {
  formState = { open: true, editingId: rule ? rule.id : null };
  els.formTitle.textContent = rule ? `Edit rule: ${rule.name}` : 'New rule';
  els.draftNotice.hidden = !fromDraft;
  let prefilled = false;
  if (!rule && !fields) {
    const suggested = suggestFieldsFromTab(activeTab ?? (await pickActiveTab()));
    if (suggested) {
      fields = suggested;
      prefilled = true;
    }
  }
  els.prefillNotice.hidden = !prefilled;
  writeFields(fields ?? ruleToFields(rule ?? newRule()));
  liveValidate(readFields());
  els.formSection.hidden = false;
  els.addRule.disabled = true;
  if (!fromDraft) draft.save({ editingId: formState.editingId, fields: readFields() });
  if (!els.viewClose.hidden) {
    els.formSection.scrollIntoView({ block: 'nearest' });
    f().name.focus();
  }
}

async function closeForm() {
  formState = { open: false, editingId: null };
  els.formSection.hidden = true;
  els.addRule.disabled = false;
  els.ruleForm.reset();
  showErrors(els.ruleForm, {});
  await draft.clear();
}

async function onSubmit(event) {
  event.preventDefault();
  const rule = fieldsToRule(readFields(), currentEditingRule());
  const { valid, errors } = validateRule(rule);
  if (!valid) {
    showErrors(els.ruleForm, errors);
    return;
  }
  await storage.saveRule(rule);
  await closeForm();
  noteSavedElsewhere(rule, closeRuleMatchesTab, els.rulesFilterNote);
}

function onFormInput() {
  const fields = readFields();
  els.draftNotice.hidden = true;
  els.prefillNotice.hidden = true;
  liveValidate(fields);
  draft.save({ editingId: formState.editingId, fields });
}

async function restoreDraft() {
  const saved = await draft.load();
  if (!saved || typeof saved !== 'object' || !saved.fields) return false;
  const rule = saved.editingId ? rules.find((r) => r.id === saved.editingId) ?? null : null;
  await openForm(rule, { fields: saved.fields, fromDraft: true });
  return true;
}

// ---------- automatic closing & options ----------

function buildCloseOptionControls() {
  for (const select of [els.optOpenUnit, els.optIdleUnit]) select.replaceChildren(...AGE_UNIT_ORDER.map((u) => el('option', { value: u, text: u })));
}

async function loadCloseSettings() {
  closeSettings = normalizeCloseSettings(await storage.getCloseSettings());
}

function renderCloseSettings() {
  els.optOpenEnabled.checked = closeSettings.maxOpen.enabled;
  els.optOpenValue.value = String(closeSettings.maxOpen.value);
  els.optOpenUnit.value = closeSettings.maxOpen.unit;
  els.optIdleEnabled.checked = closeSettings.maxIdle.enabled;
  els.optIdleValue.value = String(closeSettings.maxIdle.value);
  els.optIdleUnit.value = closeSettings.maxIdle.unit;
  for (const [input, enabled] of [[els.optOpenValue, closeSettings.maxOpen.enabled], [els.optOpenUnit, closeSettings.maxOpen.enabled], [els.optIdleValue, closeSettings.maxIdle.enabled], [els.optIdleUnit, closeSettings.maxIdle.enabled]]) input.disabled = !enabled;
  if (document.activeElement !== els.optNeverClose) els.optNeverClose.value = closeSettings.neverClose.join('\n');
  els.optCollapse.checked = closeSettings.collapseClosingGroup;
  if (closeSettings.maxOpen.enabled || closeSettings.maxIdle.enabled || closeSettings.neverClose.length) els.autoCloseDetails.open = true;
}

async function onCloseSettingsChange() {
  const problems = [];
  const readLimit = (enabledEl, valueEl, unitEl, label) => {
    const raw = valueEl.value.trim();
    const ok = /^\d+$/.test(raw) && Number(raw) >= 1;
    if (enabledEl.checked && !ok) problems.push(`${label}: enter a whole number of at least 1.`);
    return { enabled: enabledEl.checked, value: ok ? Number(raw) : undefined, unit: unitEl.value };
  };
  const next = normalizeCloseSettings({
    maxOpen: readLimit(els.optOpenEnabled, els.optOpenValue, els.optOpenUnit, '"Open longer than"'),
    maxIdle: readLimit(els.optIdleEnabled, els.optIdleValue, els.optIdleUnit, '"Not used for"'),
    neverClose: parseNeverClose(els.optNeverClose.value),
    collapseClosingGroup: els.optCollapse.checked,
  });
  els.optError.textContent = problems.join(' ');
  if (problems.length) return;
  closeSettings = next;
  await storage.setCloseSettings(closeSettings);
  renderCloseSettings();
}

// ---------- import / export ----------

async function onExport() {
  const json = exportRules(rules, { groupRules, awsSettings, closeSettings, settings: { maxTitleLength: await storage.getMaxTitleLength() } });
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = el('a', { href: url, download: 'tabkeeper-rules.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setNotice(els.ioStatus, `Exported ${rules.length} close rule${rules.length === 1 ? '' : 's'}, ${groupRules.length} grouping rule${groupRules.length === 1 ? '' : 's'}, AWS Console settings and options.`, 'ok');
}

function cancelImport() {
  pendingImport = null;
  els.importPreview.hidden = true;
  els.importSummary.replaceChildren();
}

function importSetting(key, label, details) {
  const checkbox = el('input', { type: 'checkbox', 'data-import-setting': key });
  els.importSummary.append(
    el('label', {}, [checkbox, el('span', { text: ` ${label}` })]),
    el('p', { class: 'summary', text: details }),
  );
}

function onImport() {
  cancelImport();
  const text = els.importText.value.trim();
  if (!text) {
    setNotice(els.ioStatus, 'Paste an export first.', 'error');
    return;
  }
  try {
    pendingImport = prepareSettingsImport(text);
  } catch (err) {
    setNotice(els.ioStatus, err instanceof SyntaxError ? 'Not valid JSON.' : err.message, 'error');
    return;
  }
  const plan = pendingImport;
  els.importSummary.append(el('p', { text: `${plan.rules.length} close rules and ${plan.groupRules.length} grouping rules will be added as disabled copies. Close delays below 60 seconds are raised to 60 seconds.` }));
  for (const rule of plan.rules) {
    const grace = rule.groupAfterSeconds ?? 0;
    const placement = grace >= rule.delaySeconds
      ? 'Closes without moving to the Closing group.'
      : `Move to Closing group after ${grace} seconds.`;
    els.importSummary.append(el('p', { text: [
      `${rule.name} — ${summarizeRule(rule)}.`,
      `Closes after ${rule.delaySeconds} seconds when enabled.`,
      placement,
    ].join(' ') }));
    if (hasBroadMatch(rule)) els.importSummary.append(el('p', { class: 'notice warn', text: 'Broad match warning. This rule matches unrelated example websites and could close many tabs when enabled.' }));
  }
  for (const rule of plan.groupRules) {
    els.importSummary.append(el('p', { text: [
      `${rule.name} — URL/title regex ${rule.regex}.`,
      `Group title ${rule.titleTemplate}. Colour ${rule.color} (${rule.colorMode}).`,
      `Page status ${rule.statusEnabled ? 'enabled' : 'disabled'}. Site ${rule.siteOrigin || '(none)'}.`,
      summarizeStatusFields(rule.statusFields),
    ].join(' ') }));
  }
  if (plan.awsSettings) {
    const a = plan.awsSettings;
    const fields = AWS_FIELD_ORDER.filter((key) => a.fields[key]).map((key) => AWS_FIELD_LABELS[key]);
    importSetting('aws', 'Replace AWS Console settings', [
      `Grouping ${a.enabled ? 'enabled' : 'disabled'}. Fields ${fields.join(', ') || '(none)'}.`,
      `Separator "${a.separator}". URL regex ${a.urlPattern}.`,
      `Account selector ${a.selectors.account}. Role selector ${a.selectors.role}.`,
    ].join(' '));
  }
  if (plan.closeSettings) {
    const c = plan.closeSettings;
    importSetting('age', 'Replace age-based closing settings and the never-close list', [
      `Open limit ${c.maxOpen.enabled ? describeLimit(c.maxOpen) : 'off'}.`,
      `Idle limit ${c.maxIdle.enabled ? describeLimit(c.maxIdle) : 'off'}.`,
      `Never-close list ${c.neverClose.join(', ') || '(empty — clears the current list)'}.`,
      `Collapse Closing group ${c.collapseClosingGroup ? 'on' : 'off'}. Enabled limits apply to existing tabs.`,
    ].join(' '));
  }
  if (plan.maxTitleLength !== null) {
    const limit = clampLimit(plan.maxTitleLength);
    importSetting('limit', 'Replace the group title length limit', limit ? `New limit ${limit} characters.` : 'New limit is unlimited.');
  }
  for (const error of plan.errors) els.importSummary.append(el('p', { class: 'error', text: error }));
  const empty = !plan.rules.length && !plan.groupRules.length && !plan.awsSettings && !plan.closeSettings && plan.maxTitleLength === null;
  els.confirmImport.disabled = empty;
  els.importPreview.hidden = false;
  setNotice(els.ioStatus, empty ? 'Nothing recognisable to import.' : 'Review the import, then choose Confirm import.', empty ? 'error' : '');
}

async function confirmImport() {
  const plan = pendingImport;
  if (!plan || els.confirmImport.disabled) return;
  const selected = new Set([...els.importSummary.querySelectorAll('input:checked')].map((node) => node.dataset.importSetting));
  if (selected.has('age') && !confirm('Replace the current age-based closing limits and never-close list? Enabled limits can close existing tabs immediately.')) return;
  if (!plan.rules.length && !plan.groupRules.length && selected.size === 0) {
    setNotice(els.ioStatus, 'Select the settings you want to import.', 'error');
    return;
  }
  els.confirmImport.disabled = true;
  els.importRules.disabled = true;
  els.cancelImport.disabled = true;
  els.importText.disabled = true;
  try {
    if (plan.rules.length) await storage.saveRules(plan.rules);
    if (plan.groupRules.length) await storage.saveGroupRules(plan.groupRules);
    if (selected.has('aws')) await storage.setAwsSettings(plan.awsSettings);
    if (selected.has('age')) await storage.setCloseSettings(plan.closeSettings);
    if (selected.has('limit')) {
      const res = await send({ type: 'set-title-limit', limit: plan.maxTitleLength });
      if (!res.ok) throw new Error(res.error || 'Could not set the title limit');
    }
    setNotice(els.ioStatus, `Imported ${plan.rules.length} disabled close rules and ${plan.groupRules.length} disabled grouping rules. Applied ${selected.size} selected settings.`, 'ok');
    els.importText.value = '';
    cancelImport();
  } catch (err) {
    setNotice(els.ioStatus, `Import stopped. Some items may have been saved. Retry to finish this import. ${err.message}`, 'error');
  } finally {
    els.confirmImport.disabled = false;
    els.importRules.disabled = false;
    els.cancelImport.disabled = false;
    els.importText.disabled = false;
  }
}

// ======================================================================
// GROUP VIEW
// ======================================================================

async function loadGroupRules() {
  groupRules = await storage.getGroupRules();
}

function colorCss(color) {
  return { grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038', pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e' }[color] ?? '#5f6368';
}

const COLOR_MODE_TEXT = { fixed: '', random: ' · random colour per group', title: ' · colour by title' };

function renderGroupRules() {
  els.groupRuleList.replaceChildren();
  els.groupRulesEmpty.hidden = groupRules.length > 0;
  const visible = filterForPopup(groupRules, groupRuleMatchesTab, { note: els.groupRulesFilterNote, empty: els.groupRulesEmpty, kind: 'group' });
  visible.forEach((rule) => {
    const index = groupRules.indexOf(rule);
    const { valid, errors } = validateGroupRule(rule);
    const toggle = el('input', { type: 'checkbox', title: rule.enabled ? 'Disable rule' : 'Enable rule', onChange: (e) => setGroupRuleEnabled(rule.id, e.target.checked) });
    toggle.checked = rule.enabled;
    const nameLine = el('span', {}, [
      el('span', { class: 'dot', style: `background:${colorCss(rule.color)}` }),
      document.createTextNode(rule.name || rule.titleTemplate || '(unnamed)'),
      rule.statusEnabled ? el('span', { class: 'badge', text: 'STATUS' }) : null,
    ]);
    const details = [
      el('span', { class: 'summary', text: `Title: ${rule.titleTemplate}${isDynamicTitle(rule) ? COLOR_MODE_TEXT[rule.colorMode] ?? '' : ' (fixed)'}` }),
      el('span', { class: 'summary mono', text: rule.regex }),
    ];
    if (rule.statusEnabled) {
      details.push(el('span', { class: 'summary', text: `Status: ${summarizeStatusFields(rule.statusFields)}` }));
      details.push(el('span', { class: 'summary', text: `Site: ${rule.siteOrigin || '(no origin)'}` }));
    }
    if (!valid) details.push(el('span', { class: 'summary invalid', text: `Invalid: ${Object.values(errors).join('; ')}` }));
    els.groupRuleList.append(
      ruleEntry({
        className: rule.enabled ? '' : 'disabled',
        expanded: !valid,
        name: nameLine,
        details,
        controls: [
          toggle,
          IN_POPUP ? null : el('button', { type: 'button', class: 'icon', text: '↑', title: 'Move up', disabled: index === 0, onClick: () => moveGroupRule(rule.id, -1) }),
          IN_POPUP ? null : el('button', { type: 'button', class: 'icon', text: '↓', title: 'Move down', disabled: index === groupRules.length - 1, onClick: () => moveGroupRule(rule.id, 1) }),
          el('button', { type: 'button', text: 'Edit', onClick: () => openGroupForm(rule) }),
          el('button', { type: 'button', class: 'danger', text: 'Delete', onClick: () => deleteGroupRule(rule) }),
        ],
      }),
    );
  });
}

async function setGroupRuleEnabled(id, enabled) {
  const rule = groupRules.find((r) => r.id === id);
  if (rule) await storage.saveGroupRule({ ...rule, enabled });
}

async function moveGroupRule(id, direction) {
  const list = groupRules.map((r) => r.id);
  const from = list.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= list.length) return;
  [list[from], list[to]] = [list[to], list[from]];
  await storage.setGroupRuleOrder(list);
}

async function deleteGroupRule(rule) {
  if (!confirm(`Delete grouping rule "${rule.name}"?`)) return;
  await storage.deleteGroupRule(rule.id);
  if (groupFormState.open && groupFormState.editingId === rule.id) await closeGroupForm();
}

async function renderLimit() {
  els.titleLimit.value = String(await storage.getMaxTitleLength());
}

async function onSaveLimit() {
  const raw = els.titleLimit.value.trim();
  if (!/^\d+$/.test(raw)) {
    setNotice(els.limitStatus, 'Enter a whole number (0 = no limit).', 'error');
    return;
  }
  const res = await send({ type: 'set-title-limit', limit: Number(raw) });
  if (!res.ok) {
    setNotice(els.limitStatus, `Could not apply: ${res.error}`, 'error');
    return;
  }
  els.titleLimit.value = String(res.limit);
  setNotice(els.limitStatus, `${res.limit === 0 ? 'No limit.' : `Limit ${res.limit}.`} Re-titled ${res.changed} group${res.changed === 1 ? '' : 's'}.${Number(raw) > 0 && res.limit !== Number(raw) ? ' Values under 12 are raised to 12.' : ''}`, 'ok');
}

async function onApplyToTab() {
  const tab = activeTab ?? (await pickActiveTab());
  if (!tab) {
    setNotice(els.applyStatus, 'Could not find a tab to apply to.', 'error');
    return;
  }
  const res = await send({ type: 'group-apply', tabId: tab.id });
  if (!res.ok) {
    setNotice(els.applyStatus, `Could not apply: ${res.error}`, 'error');
    return;
  }
  if (res.matched && (res.grouped || res.pending)) {
    setNotice(els.applyStatus, `Grouped "${tab.title || tab.url}"${res.baseTitle ? ` as "${res.baseTitle}"` : ''}.`, 'ok');
    return;
  }
  if (res.matched) {
    setNotice(els.applyStatus, `Matched "${res.baseTitle}" but the tab could not be grouped (popup windows and pinned tabs cannot be grouped).`, 'error');
    return;
  }
  const why = { 'ignored-url': 'That is a browser page the extension cannot group.', pinned: 'Pinned tabs cannot be grouped.', 'pending-close': 'That tab is counting down to be closed.' }[res.reason] ?? 'No saved grouping rule matches that tab.';
  setNotice(els.applyStatus, `${why} Apply only runs saved rules; use "Test on current tab" for a rule you are editing.`, 'error');
}

async function onApplyToAll() {
  els.applyAll.disabled = true;
  const res = await send({ type: 'group-apply-all' });
  els.applyAll.disabled = false;
  if (!res.ok) {
    setNotice(els.applyStatus, `Could not apply: ${res.error}`, 'error');
    return;
  }
  setNotice(els.applyStatus, `Checked ${res.tabs} tab${res.tabs === 1 ? '' : 's'}: ${res.grouped} grouped${res.pendingReads ? `, ${res.pendingReads} AWS console tab${res.pendingReads === 1 ? '' : 's'} being read` : ''}.`, 'ok');
}

// ---------- grouping rule form ----------

const gf = () => els.groupForm.elements;

function buildSwatches() {
  els.swatches.replaceChildren();
  for (const color of GROUP_COLORS) {
    els.swatches.append(el('label', { class: 'swatch', 'data-color': color, title: color }, [el('input', { type: 'radio', name: 'color', value: color })]));
  }
}

function buildPresetMenu() {
  els.presetSelect.replaceChildren(el('option', { value: '', text: 'Choose a preset…' }));
  for (const p of PRESETS) els.presetSelect.append(el('option', { value: p.id, text: p.verified ? p.name : `${p.name} (unverified)` }));
}

function statusFieldRow(index, field) {
  const n = index + 1;
  return el('div', { class: 'status-field', 'data-index': String(index) }, [
    el('div', { class: 'field-head' }, [
      el('strong', { text: `Field ${n}` }),
      index > 0 ? el('button', { type: 'button', class: 'remove-field', text: 'Remove', onClick: () => removeStatusField(index) }) : null,
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: 'Selector' }),
      el('input', { 'data-key': 'selector', autocomplete: 'off', spellcheck: 'false', placeholder: '[data-testid="status"] button, #status-val', value: field.selector ?? '' }),
      el('small', { text: 'CSS selector. Comma-separated alternatives are tried in order. Blank = the Jira default.' }),
    ]),
    el('div', { class: 'row' }, [
      el('label', { class: 'field' }, [el('span', { text: 'Keep only (regex, optional)' }), el('input', { 'data-key': 'keepOnly', autocomplete: 'off', spellcheck: 'false', placeholder: '#\\d+\\s+(\\S+)', value: field.keepOnly ?? '' })]),
      el('label', { class: 'field' }, [el('span', { text: 'Label (optional)' }), el('input', { 'data-key': 'label', autocomplete: 'off', placeholder: 'CI', value: field.label ?? '' })]),
    ]),
    el('p', { class: 'error', 'data-error': `field${n}` }),
  ]);
}

function renderStatusFields(fields) {
  els.statusFields.replaceChildren(...fields.map((field, i) => statusFieldRow(i, field)));
}

function readStatusFields() {
  return [...els.statusFields.querySelectorAll('.status-field')].map((row) => ({
    selector: row.querySelector('[data-key="selector"]').value,
    keepOnly: row.querySelector('[data-key="keepOnly"]').value,
    label: row.querySelector('[data-key="label"]').value,
  }));
}

function addStatusField() {
  const fields = readStatusFields();
  fields.push(emptyStatusField());
  renderStatusFields(fields);
  onGroupFormInput();
  const rows = els.statusFields.querySelectorAll('.status-field');
  rows[rows.length - 1].querySelector('input').focus();
}

function removeStatusField(index) {
  const fields = readStatusFields();
  if (fields.length <= 1) return;
  fields.splice(index, 1);
  renderStatusFields(fields);
  onGroupFormInput();
}

function groupRuleToFields(rule) {
  return {
    name: rule.name ?? '',
    regex: rule.regex ?? '',
    titleTemplate: rule.titleTemplate ?? '',
    color: GROUP_COLORS.includes(rule.color) ? rule.color : 'blue',
    colorMode: COLOR_MODES.includes(rule.colorMode) ? rule.colorMode : rule.randomColor ? 'random' : 'fixed',
    statusEnabled: Boolean(rule.statusEnabled),
    statusFields: rule.statusFields?.length ? rule.statusFields : [emptyStatusField()],
    siteOrigin: rule.siteOrigin ?? '',
  };
}

function readGroupFields() {
  const e = gf();
  return {
    name: e.name.value,
    regex: e.regex.value,
    titleTemplate: e.titleTemplate.value,
    color: els.groupForm.querySelector('input[name="color"]:checked')?.value ?? 'blue',
    colorMode: els.groupForm.querySelector('input[name="colorMode"]:checked')?.value ?? 'fixed',
    statusEnabled: e.statusEnabled.checked,
    statusFields: readStatusFields(),
    siteOrigin: e.siteOrigin.value,
  };
}

function writeGroupFields(fields) {
  const e = gf();
  e.name.value = fields.name ?? '';
  e.regex.value = fields.regex ?? '';
  e.titleTemplate.value = fields.titleTemplate ?? '';
  const color = GROUP_COLORS.includes(fields.color) ? fields.color : 'blue';
  for (const input of els.groupForm.querySelectorAll('input[name="color"]')) input.checked = input.value === color;
  const mode = COLOR_MODES.includes(fields.colorMode) ? fields.colorMode : 'fixed';
  for (const input of els.groupForm.querySelectorAll('input[name="colorMode"]')) input.checked = input.value === mode;
  e.statusEnabled.checked = Boolean(fields.statusEnabled);
  renderStatusFields(fields.statusFields?.length ? fields.statusFields : [emptyStatusField()]);
  e.siteOrigin.value = fields.siteOrigin ?? '';
  els.statusBlock.hidden = !e.statusEnabled.checked;
  renderGroupPermissionNote();
}

function renderGroupPermissionNote() {
  const origin = originOf(gf().siteOrigin.value.trim());
  const testOrigin = originOf(activeTab?.url ?? '');
  els.groupPermissionSave.textContent = origin
    ? `Saving this rule requests access to ${hostPermission(origin)} for live status.`
    : 'Saving a status rule requests access to the site origin you enter above.';
  els.groupPermissionTest.textContent = testOrigin
    ? `Test on current tab requests access to ${hostPermission(testOrigin)}, which may differ from the saved rule's site.`
    : 'Test on current tab requests access to the current web page’s site; browser pages cannot be read.';
}

function fieldsToGroupRule(fields, existing) {
  return normalizeGroupRule({ id: existing?.id, createdAt: existing?.createdAt, enabled: existing ? existing.enabled : true, ...fields });
}

function validateGroupForm(rule, { forTest = false } = {}) {
  return validateGroupRule(rule, { forTest, probeSelector, splitSelectorList: core.splitSelectorList });
}

function currentEditingGroupRule() {
  return groupFormState.editingId ? groupRules.find((r) => r.id === groupFormState.editingId) ?? null : null;
}

async function openGroupForm(rule = null, { fields = null, fromDraft = false } = {}) {
  groupFormState = { open: true, editingId: rule ? rule.id : null };
  els.groupFormTitle.textContent = rule ? `Edit grouping rule: ${rule.name}` : 'New grouping rule';
  els.groupDraftNotice.hidden = !fromDraft;
  els.saveGroupRule.textContent = rule ? 'Update rule' : 'Add rule';
  els.presetSelect.value = '';
  setNotice(els.presetNotes, '');
  els.testResult.hidden = true;
  els.testResult.replaceChildren();
  const initial = fields ?? groupRuleToFields(rule ?? newGroupRule());
  if (!rule && !fields) {
    const origin = originOf((activeTab ?? (await pickActiveTab()))?.url ?? '');
    if (origin) initial.siteOrigin = origin;
  }
  writeGroupFields(initial);
  showErrors(els.groupForm, {});
  els.groupFormSection.hidden = false;
  els.addGroupRule.disabled = true;
  if (!fromDraft) groupDraft.save({ editingId: groupFormState.editingId, fields: readGroupFields() });
  if (!els.viewGroup.hidden) {
    els.groupFormSection.scrollIntoView({ block: 'nearest' });
    gf().name.focus();
  }
}

async function closeGroupForm() {
  groupFormState = { open: false, editingId: null };
  els.groupFormSection.hidden = true;
  els.addGroupRule.disabled = false;
  els.groupForm.reset();
  renderStatusFields([emptyStatusField()]);
  showErrors(els.groupForm, {});
  els.testResult.hidden = true;
  setNotice(els.presetNotes, '');
  await groupDraft.clear();
}

function onGroupFormInput() {
  els.groupDraftNotice.hidden = true;
  const fields = readGroupFields();
  els.statusBlock.hidden = !fields.statusEnabled;
  renderGroupPermissionNote();
  groupDraft.save({ editingId: groupFormState.editingId, fields });
}

function onPresetChosen() {
  const preset = getPreset(els.presetSelect.value);
  if (!preset) {
    setNotice(els.presetNotes, '');
    return;
  }
  const current = readGroupFields();
  writeGroupFields({
    ...current,
    name: preset.name,
    regex: preset.regex,
    titleTemplate: preset.titleTemplate,
    statusEnabled: true,
    statusFields: preset.statusFields.map((x) => ({ ...x })),
    siteOrigin: current.siteOrigin || originOf(activeTab?.url ?? ''),
  });
  const warn = preset.verified ? '' : ' This preset is unverified: run "Test on current tab" before relying on it.';
  setNotice(els.presetNotes, `${preset.notes} Example title: ${preset.exampleTitle}.${warn}`, preset.verified ? '' : 'warn');
  showErrors(els.groupForm, {});
  onGroupFormInput();
}

/** Save. chrome.permissions.request must run inside the click handler before any other await. */
async function onGroupSubmit(event) {
  event.preventDefault();
  const rule = fieldsToGroupRule(readGroupFields(), currentEditingGroupRule());
  const { valid, errors } = validateGroupForm(rule);
  if (!valid) {
    showErrors(els.groupForm, errors);
    return;
  }
  let permission = null;
  if (rule.statusEnabled && rule.siteOrigin) permission = chrome.permissions.request({ origins: [hostPermission(rule.siteOrigin)] }).catch(() => false);
  await storage.saveGroupRule(rule);
  const granted = permission ? await permission : null;
  await closeGroupForm();
  noteSavedElsewhere(rule, groupRuleMatchesTab, els.groupRulesFilterNote);
  setNotice(
    els.applyStatus,
    granted === false
      ? `Rule saved. Access to ${rule.siteOrigin} was not allowed, so the status will not be read until you grant it (edit the rule and save again, or use Test).`
      : `Rule "${rule.name}" saved.`,
    granted === false ? 'warn' : 'ok',
  );
}

async function onTestGroupRule() {
  const rule = fieldsToGroupRule(readGroupFields(), currentEditingGroupRule());
  const { valid, errors } = validateGroupForm(rule, { forTest: true });
  if (!valid) {
    showErrors(els.groupForm, errors);
    return;
  }
  showErrors(els.groupForm, {});
  const tab = activeTab;
  const origin = originOf(tab?.url ?? '');
  let permission = null;
  if (rule.statusEnabled && origin) permission = chrome.permissions.request({ origins: [hostPermission(origin)] }).catch(() => false);
  renderTestResult({ pending: true });
  if (!tab) {
    renderTestResult({ error: 'browser-page', url: '', title: '' });
    return;
  }
  if (permission) await permission;
  const res = await send({ type: 'group-test', tabId: tab.id, rule });
  renderTestResult(res.ok ? res : { error: 'failed', detail: res.error, url: tab.url ?? '', title: tab.title ?? '' });
}

const FAILURE_TEXT = {
  'regex-no-match': () => 'The URL regex matches neither the URL nor the title. Check escaping (\\. for dots) and that the pattern really appears in the address bar.',
  'access-not-granted': (r) => `Access to ${r.origin || 'this site'} was not granted. Click Test again and allow it.`,
  'matched-nothing': () => 'Selector matched no element within 3 seconds. Right-click the status on the page, Inspect, and copy a stable id or data-testid.',
  'matched-no-text': (r, field) => `Matched ${field.matched} element${field.matched === 1 ? '' : 's'} but none had text. You probably selected a wrapper or an icon. Try the parent, or the inner element that holds the words.`,
  'keep-no-match': (r, field) => `"Keep only" did not match the text that was read: "${field.raw}". Adjust the regex.`,
  'keep-empty': () => '"Keep only" matched but kept nothing. Check the parentheses: the first capture group is what is kept.',
  'invalid-selector': () => 'None of the selector alternatives is valid CSS.',
  'invalid-keep-regex': () => 'The "keep only" regex does not compile.',
  'browser-page': () => 'The current tab is a browser page the extension cannot read. Open a normal web page and try again.',
  'invalid-regex': (r) => `The URL regex does not compile: ${r.detail ?? ''}`,
  'empty-title': () => 'The regex matched but the group title is empty. Fill in the Group title field.',
  'read-failed': () => 'The page could not be read. Reload the page and try again.',
  failed: (r) => `Test failed: ${r.detail ?? 'unknown error'}`,
};

function renderTestResult(r) {
  const box = els.testResult;
  box.replaceChildren();
  box.hidden = false;
  if (r.pending) {
    box.className = 'result';
    box.append(el('p', { class: 'muted', text: 'Testing on the current tab…' }));
    return;
  }
  const dl = el('dl');
  const row = (label, ...children) => dl.append(el('dt', { text: label }), el('dd', {}, children));
  let level = 'ok';
  if (r.error && ['browser-page', 'invalid-regex', 'failed'].includes(r.error)) {
    box.className = 'result error';
    box.append(el('p', { text: FAILURE_TEXT[r.error](r) }));
    return;
  }
  if (!r.matched) {
    level = 'error';
    row('Group title', el('span', { text: FAILURE_TEXT['regex-no-match'](r) }));
    row('Tab URL', el('span', { class: 'mono', text: r.url || '(none)' }));
    row('Tab title', el('span', { text: r.title || '(none)' }));
  } else if (r.error === 'empty-title') {
    level = 'error';
    row('Group title', el('span', { text: FAILURE_TEXT['empty-title'](r) }));
  } else {
    row('Group title', el('span', { text: `${r.baseTitle}${r.fixed ? ' (same for every matching tab)' : ''}${r.matchedOn === 'title' ? ' (matched the tab title)' : ''}` }));
  }
  if (r.matched && r.statusEnabled) {
    if (r.error === 'access-not-granted' || r.error === 'read-failed') {
      level = 'error';
      row('Status', el('span', { text: FAILURE_TEXT[r.error](r) }));
    } else if (Array.isArray(r.fields)) {
      r.fields.forEach((field, i) => {
        const label = r.fields.length === 1 ? 'Status' : `Field ${i + 1}`;
        if (field.value) {
          const parts = [el('strong', { text: field.value })];
          if (field.raw && field.raw !== field.value) parts.push(document.createTextNode(` (kept from "${field.raw}")`));
          if (field.element) parts.push(el('span', { class: 'muted', text: ` read from ${field.element}` }));
          row(label, ...parts);
        } else {
          level = level === 'error' ? 'error' : 'partial';
          row(label, el('span', { text: (FAILURE_TEXT[field.error] ?? (() => 'No value.'))(r, field) }));
        }
      });
      if (r.fields.every((x) => !x.value)) level = 'error';
    }
  }
  if (r.matched && r.baseTitle) row(r.shortened ? `Final title (shortened to ${r.limit})` : 'Final title', el('strong', { text: r.finalTitle }));
  box.className = `result ${level}`;
  box.append(dl);
}

async function restoreGroupDraft() {
  const saved = await groupDraft.load();
  if (!saved || typeof saved !== 'object' || !saved.fields) return false;
  const rule = saved.editingId ? groupRules.find((r) => r.id === saved.editingId) ?? null : null;
  await openGroupForm(rule, { fields: saved.fields, fromDraft: true });
  return true;
}

// ======================================================================
// AWS VIEW
// ======================================================================

function buildAwsControls() {
  els.awsFields.replaceChildren();
  for (const key of AWS_FIELD_ORDER) {
    els.awsFields.append(el('label', { class: 'inline' }, [el('input', { type: 'checkbox', 'data-aws-field': key }), document.createTextNode(` ${AWS_FIELD_LABELS[key]}`)]));
  }
  els.awsSeparator.replaceChildren(...AWS_SEPARATORS.map((sep) => el('option', { value: sep.value, text: sep.label })));
}

async function loadAwsSettings() {
  awsSettings = normalizeAwsSettings(await storage.getAwsSettings());
}

async function awsHasAccess() {
  try {
    if (await chrome.permissions.contains({ origins: [AWS_HOST_PERMISSION] })) return true;
    const { origins = [] } = await chrome.permissions.getAll();
    return origins.some((o) => o === '<all_urls>' || o === 'https://*/*' || o === '*://*/*' || /^(https|\*):\/\/(\*\.)?console\.aws\.amazon\.com\//.test(o));
  } catch {
    return false;
  }
}

async function renderAws() {
  els.awsEnabled.checked = awsSettings.enabled;
  els.awsOptions.classList.toggle('disabled', !awsSettings.enabled);
  for (const input of els.awsFields.querySelectorAll('[data-aws-field]')) input.checked = Boolean(awsSettings.fields[input.dataset.awsField]);
  els.awsSeparator.value = awsSettings.separator;
  els.awsSelAccount.value = awsSettings.selectors.account;
  els.awsSelRole.value = awsSettings.selectors.role;
  els.awsUrlPattern.value = awsSettings.urlPattern;
  els.awsPreview.textContent = composeAwsTitle(awsSettings, AWS_SAMPLE_INFO) || '(nothing selected)';
  els.awsAccess.hidden = !(awsSettings.enabled && !(await awsHasAccess()));
}

function readAwsControls() {
  const fields = {};
  for (const input of els.awsFields.querySelectorAll('[data-aws-field]')) fields[input.dataset.awsField] = input.checked;
  return normalizeAwsSettings({
    enabled: els.awsEnabled.checked,
    fields,
    separator: els.awsSeparator.value,
    selectors: { account: els.awsSelAccount.value, role: els.awsSelRole.value },
    urlPattern: els.awsUrlPattern.value,
  });
}

function validateAwsAdvanced(settings) {
  const problems = [];
  try {
    compileRegex(settings.urlPattern);
  } catch (err) {
    problems.push(`Console URL regex does not compile: ${err.message}`);
  }
  for (const [name, selector] of [['Account label selector', settings.selectors.account], ['Role selector', settings.selectors.role]]) {
    const bad = core.splitSelectorList(selector).filter((alt) => !probeSelector(alt));
    if (bad.length) problems.push(`${name}: not valid CSS: ${bad.join(', ')}`);
  }
  els.awsAdvancedError.textContent = problems.join(' ');
  return problems.length === 0;
}

async function onAwsChange() {
  const next = readAwsControls();
  if (!validateAwsAdvanced(next)) return;
  awsSettings = next;
  await storage.setAwsSettings(awsSettings);
  await renderAws();
}

async function onAwsEnabledChange(event) {
  if (!validateAwsAdvanced(readAwsControls())) {
    els.awsEnabled.checked = awsSettings.enabled;
    return;
  }
  let permission = null;
  if (event.target.checked) permission = chrome.permissions.request({ origins: [AWS_HOST_PERMISSION] }).catch(() => false);
  await onAwsChange();
  if (!permission) {
    setNotice(els.awsStatus, '');
    return;
  }
  const granted = await permission;
  setNotice(
    els.awsStatus,
    granted ? 'AWS Console grouping is on. Open or reload a console tab to see it grouped.' : 'Enabled, but access to the AWS Console was not allowed. Click "Grant access" to let the extension read the account and role.',
    granted ? 'ok' : 'warn',
  );
  await renderAws();
}

async function onAwsGrant() {
  const granted = await chrome.permissions.request({ origins: [AWS_HOST_PERMISSION] }).catch(() => false);
  await renderAws();
  const visible = await awsHasAccess();
  if (granted && visible) setNotice(els.awsStatus, 'Access granted.', 'ok');
  else if (granted) setNotice(els.awsStatus, 'The browser reports permission as approved but not active. Open the extension settings, allow the relevant console.aws.amazon.com sites, then reload the console tab.', 'warn');
  else setNotice(els.awsStatus, 'Access was not granted.', 'warn');
}

async function onAwsReset() {
  const d = defaultAwsSettings();
  awsSettings = normalizeAwsSettings({ ...awsSettings, selectors: d.selectors, urlPattern: d.urlPattern });
  await storage.setAwsSettings(awsSettings);
  validateAwsAdvanced(awsSettings);
  await renderAws();
}

const AWS_FAILURE_TEXT = {
  'browser-page': () => 'The current tab is a browser page the extension cannot read. Open an AWS Console tab and try again.',
  'not-aws': (r) => `This tab is not recognised as an AWS Console tab (URL: ${r.url}). Open a console page, or adjust the console URL regex under Advanced.`,
  'invalid-regex': () => 'The console URL regex under Advanced does not compile.',
  'access-not-granted': (r) => `Access to ${r.origin || 'the console'} was not granted. Click Test again and allow it, or use "Grant access".`,
  'read-failed': () => 'The page could not be read. Reload the console tab and try again.',
  'nothing-read': () => 'The page was read but none of the ticked fields had a value. Check the Advanced selectors with the field details below.',
  failed: (r) => `Test failed: ${r.detail ?? 'unknown error'}`,
};

function renderAwsResult(r) {
  const box = els.awsResult;
  box.replaceChildren();
  box.hidden = false;
  if (r.pending) {
    box.className = 'result';
    box.append(el('p', { class: 'muted', text: 'Reading the current tab…' }));
    return;
  }
  const dl = el('dl');
  const row = (label, ...children) => dl.append(el('dt', { text: label }), el('dd', {}, children));
  let level = 'ok';
  if (r.error && r.error !== 'nothing-read') {
    box.className = 'result error';
    box.append(el('p', { text: (AWS_FAILURE_TEXT[r.error] ?? AWS_FAILURE_TEXT.failed)(r) }));
    return;
  }
  if (r.error === 'nothing-read') {
    level = 'error';
    row('Group title', el('span', { text: AWS_FAILURE_TEXT['nothing-read'](r) }));
  } else {
    row('Group title', el('strong', { text: r.groupTitle }));
    if (r.shortened) row(`Shortened to ${r.limit}`, el('strong', { text: r.finalTitle }));
  }
  const info = r.info ?? {};
  for (const [label, value] of [['Account name', info.account], ['Account ID', info.accountId], ['Role', info.role], ['User', info.user], ['Region', info.region]]) row(label, el('span', { text: value || '(not found)' }));
  if (Array.isArray(r.fields)) {
    const [acct, role] = r.fields;
    if (acct) row('Account read from', el('span', { class: 'muted', text: acct.element ? `${acct.element} ("${acct.raw}")` : `nothing matched (${acct.error})` }));
    if (role) row('Role read from', el('span', { class: 'muted', text: role.element ? `${role.element} ("${role.raw}")` : `nothing matched (${role.error})` }));
    if ((!info.role && awsSettings.fields.role) || (!info.account && awsSettings.fields.account)) level = level === 'error' ? 'error' : 'partial';
  }
  box.className = `result ${level}`;
  box.append(dl);
}

async function onAwsTest() {
  const settings = readAwsControls();
  if (!validateAwsAdvanced(settings)) return;
  const tab = activeTab;
  let permission = null;
  if (tab) permission = chrome.permissions.request({ origins: [AWS_HOST_PERMISSION] }).catch(() => false);
  renderAwsResult({ pending: true });
  if (!tab) {
    renderAwsResult({ error: 'browser-page' });
    return;
  }
  if (permission) await permission;
  const res = await send({ type: 'aws-test', tabId: tab.id, settings });
  renderAwsResult(res.ok ? res : { error: 'failed', detail: res.error });
  await renderAws();
}

async function onAwsApply() {
  const tab = activeTab ?? (await pickActiveTab());
  if (!tab) {
    setNotice(els.awsStatus, 'Could not find a tab to apply to.', 'error');
    return;
  }
  if (!awsSettings.enabled) {
    setNotice(els.awsStatus, 'Turn on "Group AWS Console tabs" first.', 'error');
    return;
  }
  const res = await send({ type: 'group-apply', tabId: tab.id });
  if (!res.ok) setNotice(els.awsStatus, `Could not apply: ${res.error}`, 'error');
  else if (res.matched && (res.grouped || res.pending)) setNotice(els.awsStatus, `Grouping "${tab.title || tab.url}".`, 'ok');
  else if (res.reason === 'no-access') setNotice(els.awsStatus, 'Access to the AWS Console has not been granted. Click "Grant access".', 'error');
  else setNotice(els.awsStatus, res.matched ? 'The tab matched but could not be grouped (popup windows and pinned tabs cannot be grouped).' : 'That tab is not an AWS Console tab. Use Test to see how it is recognised.', 'error');
}

// ======================================================================
// wiring
// ======================================================================

async function init() {
  if (IN_POPUP) {
    document.body.classList.add('in-popup');
    $('page-title').textContent = 'Tabkeeper';
    const openInTab = $('open-in-tab');
    openInTab.hidden = false;
    openInTab.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
  }
  for (const select of els.ruleForm.querySelectorAll('select')) fillModeSelect(select);
  buildSwatches();
  buildPresetMenu();
  buildAwsControls();
  buildCloseOptionControls();
  buildPauseSelect(els.pauseSelect);

  activeTab = await pickActiveTab();
  await Promise.all([loadRules(), loadGroupRules(), loadAwsSettings(), loadCloseSettings()]);
  renderRules();
  renderGroupRules();
  renderCloseSettings();
  await Promise.all([renderPause(storage, pauseUi()), renderPending(), renderLog(), renderLimit(), renderAws()]);

  const { popupView } = await chrome.storage.local.get('popupView');
  const closeDraft = await restoreDraft();
  const groupDraftRestored = await restoreGroupDraft();
  const remembered = ['close', 'group', 'aws'].includes(popupView) ? popupView : null;
  showView(remembered ?? (groupDraftRestored && !closeDraft ? 'group' : 'close'));

  for (const tab of els.tabs) tab.addEventListener('click', () => showView(tab.dataset.view));
  els.reloadExtension.addEventListener('click', () => chrome.runtime.reload());
  void checkStaleWorker();

  els.pauseSelect.addEventListener('change', async (e) => {
    await applyPauseChoice(storage, e.target.value);
    await renderPause(storage, pauseUi());
  });

  // close view
  els.testClose.addEventListener('click', onTestClose);
  els.addRule.addEventListener('click', () => openForm(null));
  els.ruleForm.addEventListener('submit', onSubmit);
  els.ruleForm.addEventListener('input', onFormInput);
  els.ruleForm.addEventListener('change', onFormInput);
  els.cancelRule.addEventListener('click', closeForm);
  els.clearLog.addEventListener('click', async () => {
    await clearLog(storage);
    await renderLog();
  });
  for (const input of [els.optOpenEnabled, els.optOpenValue, els.optOpenUnit, els.optIdleEnabled, els.optIdleValue, els.optIdleUnit, els.optNeverClose, els.optCollapse]) input.addEventListener('change', onCloseSettingsChange);
  els.exportRules.addEventListener('click', onExport);
  els.importRules.addEventListener('click', onImport);
  els.confirmImport.addEventListener('click', confirmImport);
  els.cancelImport.addEventListener('click', cancelImport);
  els.importText.addEventListener('input', cancelImport);

  // group view
  els.saveLimit.addEventListener('click', onSaveLimit);
  els.applyGroup.addEventListener('click', onApplyToTab);
  els.applyAll.addEventListener('click', onApplyToAll);
  els.addGroupRule.addEventListener('click', () => openGroupForm(null));
  els.presetSelect.addEventListener('change', onPresetChosen);
  els.groupForm.addEventListener('submit', onGroupSubmit);
  els.groupForm.addEventListener('input', onGroupFormInput);
  els.groupForm.addEventListener('change', onGroupFormInput);
  els.addStatusField.addEventListener('click', addStatusField);
  els.testGroupRule.addEventListener('click', onTestGroupRule);
  els.cancelGroupRule.addEventListener('click', closeGroupForm);

  // aws view
  els.awsEnabled.addEventListener('change', onAwsEnabledChange);
  els.awsFields.addEventListener('change', onAwsChange);
  els.awsSeparator.addEventListener('change', onAwsChange);
  for (const input of [els.awsSelAccount, els.awsSelRole, els.awsUrlPattern]) input.addEventListener('change', onAwsChange);
  els.awsGrant.addEventListener('click', onAwsGrant);
  els.awsSettings.addEventListener('click', () => {
    const url = extensionSettingsUrl(chrome.runtime.id);
    if (url) chrome.tabs.create({ url }).catch(() => {});
    else setNotice(els.awsStatus, 'In Firefox, open Add-ons and themes → Extensions → Tabkeeper → Permissions, adjust the site access, then reload the console tab.', 'warn');
  });
  els.awsReset.addEventListener('click', onAwsReset);
  els.awsTest.addEventListener('click', onAwsTest);
  els.awsApply.addEventListener('click', onAwsApply);

  const flushDrafts = () => {
    if (formState.open) void draft.flush();
    if (groupFormState.open) void groupDraft.flush();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDrafts();
  });
  window.addEventListener('pagehide', flushDrafts);

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync') {
      await Promise.all([loadRules(), loadGroupRules(), loadAwsSettings(), loadCloseSettings()]);
      renderRules();
      renderGroupRules();
      renderCloseSettings();
      await renderAws();
      if (formState.open && formState.editingId && !currentEditingRule()) {
        formState.editingId = null;
        els.formTitle.textContent = 'New rule';
      }
      if (groupFormState.open && groupFormState.editingId && !currentEditingGroupRule()) {
        groupFormState.editingId = null;
        els.groupFormTitle.textContent = 'New grouping rule';
        els.saveGroupRule.textContent = 'Add rule';
      }
    } else if (area === 'session') {
      if ('pending' in changes) await renderPending();
    } else if (area === 'local') {
      if ('paused' in changes || 'pausedUntil' in changes) await renderPause(storage, pauseUi());
      if ('log' in changes) await renderLog();
      if ('maxTitleLength' in changes) await renderLimit();
    }
  });
}

init().catch((err) => console.error('[tabkeeper] settings page failed to start', err));
