// Helpers shared by the quick popup and the settings page.
import { api as chrome, isExtensionUrl } from '../src/browser-api.js';
import { historyUrl, readLog } from '../src/log.js';

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

export function formatDelay(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function formatTime(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

export function formatClock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { timeStyle: 'short' });
}

export function send(message) {
  return chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
}

export function setNotice(node, message, kind = '') {
  node.hidden = !message;
  node.textContent = message ?? '';
  node.className = `notice${kind ? ` ${kind}` : ''}`;
}

const EXTENSION_BASE = chrome.runtime.getURL('');

/**
 * The tab the user is "on". In the popup that is the active tab. On the settings page
 * (itself a tab) it is the most recently used non-extension tab of the window.
 */
export async function pickActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const active = tabs.find((t) => t.active);
    if (active && !isExtensionUrl(active.url, EXTENSION_BASE)) return active;
    const candidates = tabs
      .filter((t) => !isExtensionUrl(t.url, EXTENSION_BASE))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

// ---------- pause / snooze ----------

export const PAUSE_OPTIONS = [
  { value: 'off', label: 'Active' },
  { value: '15', label: 'Pause 15 minutes' },
  { value: '60', label: 'Pause 1 hour' },
  { value: '240', label: 'Pause 4 hours' },
  { value: 'tomorrow', label: 'Pause until tomorrow 8:00' },
  { value: 'indefinite', label: 'Pause until I resume' },
];

export function pauseUntilFor(value, now = Date.now()) {
  if (value === 'off' || value === 'indefinite') return null;
  if (value === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  }
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? now + minutes * 60_000 : null;
}

export function buildPauseSelect(select) {
  select.replaceChildren(...PAUSE_OPTIONS.map((o) => el('option', { value: o.value, text: o.label })));
}

/** Reflect storage in the select and label; returns the paused state. */
export async function renderPause(storage, { select, label, body }) {
  const paused = await storage.getPaused();
  const until = await storage.getPausedUntil();
  if (!paused) select.value = 'off';
  else if (until) {
    // Keep whichever option is selected unless it is "off"; the exact minutes do not round-trip.
    if (select.value === 'off') select.value = 'indefinite';
  } else select.value = 'indefinite';
  label.textContent = !paused ? '' : until ? `Paused until ${formatClock(until)}` : 'Paused';
  body.classList.toggle('paused', paused);
  return paused;
}

export async function applyPauseChoice(storage, value) {
  if (value === 'off') await storage.setPaused(false);
  else await storage.setPaused(true, pauseUntilFor(value));
}

// ---------- shared lists ----------

export async function renderPendingList(storage, { section, list, onKeep }) {
  const pending = await storage.getPending();
  const entries = Object.entries(pending)
    .map(([tabId, entry]) => ({ tabId: Number(tabId), ...entry }))
    .sort((a, b) => a.deadline - b.deadline);
  list.replaceChildren();
  section.hidden = entries.length === 0;
  const now = Date.now();
  for (const entry of entries) {
    const remaining = Math.max(0, Math.ceil((entry.deadline - now) / 1000));
    list.append(
      el('li', {}, [
        el('span', { class: 'name', text: entry.title || entry.url || `Tab ${entry.tabId}` }),
        el('span', { class: 'meta', text: `${entry.ruleName} · closes in ${remaining}s` }),
        el('span', { class: 'controls' }, [
          el('button', { type: 'button', text: 'Keep', title: 'Cancel this close and leave the tab alone for this rule', onClick: () => onKeep(entry.tabId) }),
        ]),
      ]),
    );
  }
  return entries.length;
}

export async function renderLogList(storage, { count, empty, list, clearButton, onReopen }) {
  const log = await readLog(storage);
  if (count) count.textContent = log.length ? `(${log.length})` : '';
  empty.hidden = log.length > 0;
  if (clearButton) clearButton.disabled = log.length === 0;
  list.replaceChildren();
  for (const entry of log) {
    const canReopen = Boolean(historyUrl(entry.url));
    list.append(
      el('li', {}, [
        el('span', { class: 'name', text: entry.title || '(untitled)' }),
        el('span', { class: 'meta', text: entry.url }),
        el('span', { class: 'meta', text: `${entry.ruleName} · ${formatTime(entry.closedAt)}` }),
        el('span', { class: 'controls' }, [
          el('button', { type: 'button', text: 'Reopen', disabled: !canReopen, title: canReopen ? 'Open this page in a new tab' : 'Nothing to reopen', onClick: () => onReopen(entry) }),
        ]),
      ]),
    );
  }
  return log.length;
}

export async function reopenEntry(entry) {
  const url = historyUrl(entry?.url);
  if (!url) return false;
  try {
    await chrome.tabs.create({ url, active: false });
    return true;
  } catch {
    return false;
  }
}
