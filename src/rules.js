// Rule schema, validation, normalization, and import/export.
// Pure module: no chrome.* access, safe to unit test in Node.
import { compileRegex, MAX_PATTERN_LENGTH } from './regex.js';

export const MODES = ['contains', 'startsWith', 'endsWith', 'equals', 'regex'];
export const MODE_LABELS = {
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  equals: 'equals',
  regex: 'matches regex',
};
export { MAX_PATTERN_LENGTH };
export const MAX_NAME_LENGTH = 100;
export const MAX_DELAY_SECONDS = 86400;
export const DEFAULT_DELAY_SECONDS = 60;
export const EXPORT_VERSION = 3;

export function generateId() {
  return globalThis.crypto.randomUUID();
}

export function emptyCondition() {
  return { mode: 'contains', pattern: '', caseSensitive: false };
}

export function newRule() {
  return {
    id: generateId(),
    name: '',
    enabled: true,
    title: null,
    url: null,
    delaySeconds: DEFAULT_DELAY_SECONDS,
    groupAfterSeconds: 0,
    createdAt: Date.now(),
  };
}

/** Returns an error string, or null when the condition is valid (or absent). */
export function validateCondition(cond) {
  if (cond === null || cond === undefined) return null;
  if (typeof cond !== 'object') return 'Condition must be an object';
  if (!MODES.includes(cond.mode)) return `Unknown match mode "${cond.mode}"`;
  if (typeof cond.pattern !== 'string' || cond.pattern.length === 0) return 'Pattern is required';
  if (cond.pattern.length > MAX_PATTERN_LENGTH) {
    return `Pattern must be ${MAX_PATTERN_LENGTH} characters or fewer`;
  }
  if (typeof cond.caseSensitive !== 'boolean') return 'caseSensitive must be true or false';
  if (cond.mode === 'regex') {
    try {
      compileRegex(cond.pattern, cond.caseSensitive ? '' : 'i');
    } catch (err) {
      return `Invalid regex: ${err.message}`;
    }
  }
  return null;
}

/** Returns { valid, errors } where errors maps field name -> message. */
export function validateRule(rule) {
  if (!rule || typeof rule !== 'object') {
    return { valid: false, errors: { rule: 'Rule must be an object' } };
  }
  const errors = {};
  if (typeof rule.id !== 'string' || rule.id.length === 0) errors.id = 'Missing id';
  if (typeof rule.name !== 'string' || rule.name.trim() === '') {
    errors.name = 'Name is required';
  } else if (rule.name.length > MAX_NAME_LENGTH) {
    errors.name = `Name must be ${MAX_NAME_LENGTH} characters or fewer`;
  }
  if (typeof rule.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';

  const titleError = validateCondition(rule.title);
  if (titleError) errors.title = titleError;
  const urlError = validateCondition(rule.url);
  if (urlError) errors.url = urlError;
  if (rule.title == null && rule.url == null) {
    errors.conditions = 'Add a title condition, a URL condition, or both';
  }

  if (
    !Number.isInteger(rule.delaySeconds) ||
    rule.delaySeconds < 0 ||
    rule.delaySeconds > MAX_DELAY_SECONDS
  ) {
    errors.delaySeconds = `Delay must be a whole number between 0 and ${MAX_DELAY_SECONDS} seconds`;
  }
  // Rules saved before this field existed have no groupAfterSeconds; that means 0.
  const groupAfter = rule.groupAfterSeconds ?? 0;
  if (!Number.isInteger(groupAfter) || groupAfter < 0 || groupAfter > MAX_DELAY_SECONDS) {
    errors.groupAfterSeconds = `"Move to Closing group after" must be a whole number between 0 and ${MAX_DELAY_SECONDS} seconds`;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

function normalizeCondition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pattern = typeof raw.pattern === 'string' ? raw.pattern : '';
  if (pattern === '') return null;
  return {
    mode: typeof raw.mode === 'string' ? raw.mode : 'contains',
    pattern,
    caseSensitive: Boolean(raw.caseSensitive),
  };
}

function normalizeDelay(raw, fallback = DEFAULT_DELAY_SECONDS) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return fallback;
    if (!/^\d+$/.test(trimmed)) return NaN;
    return Number(trimmed);
  }
  return raw;
}

/**
 * Coerce loosely shaped input (form values, imported JSON) into the canonical
 * rule shape. Does not validate; call validateRule on the result.
 */
export function normalizeRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof r.id === 'string' && r.id.length > 0 ? r.id : generateId(),
    name: typeof r.name === 'string' ? r.name.trim() : '',
    enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    title: normalizeCondition(r.title),
    url: normalizeCondition(r.url),
    delaySeconds: normalizeDelay(r.delaySeconds),
    groupAfterSeconds: normalizeDelay(r.groupAfterSeconds, 0),
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
  };
}

/**
 * Suggest form fields for a new rule based on the tab the popup was opened
 * over. Title becomes a "contains" match; URL becomes a "starts with" match on
 * the site origin only, so ids and query strings are not baked in. Returns null
 * for tabs that give nothing useful (blank, chrome://, extension pages).
 */
export function suggestFieldsFromTab(tab) {
  const title = typeof tab?.title === 'string' ? tab.title.trim() : '';
  const url = typeof tab?.url === 'string' ? tab.url : '';
  let origin = '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = `${parsed.origin}/`;
  } catch {
    // not a URL; ignore
  }
  if (!title && !origin) return null;
  return {
    name: (title || origin).slice(0, MAX_NAME_LENGTH),
    titleMode: 'contains',
    titlePattern: title.slice(0, MAX_PATTERN_LENGTH),
    titleCase: false,
    urlMode: 'startsWith',
    urlPattern: origin,
    urlCase: false,
    delay: String(DEFAULT_DELAY_SECONDS),
    groupAfter: '0',
  };
}

export function summarizeCondition(field, cond) {
  if (!cond) return '';
  const label = MODE_LABELS[cond.mode] ?? cond.mode;
  const cs = cond.caseSensitive ? ' (case-sensitive)' : '';
  return `${field} ${label} "${cond.pattern}"${cs}`;
}

export function summarizeRule(rule) {
  return [summarizeCondition('title', rule.title), summarizeCondition('URL', rule.url)]
    .filter(Boolean)
    .join(' and ');
}

export function exportRules(rules, extra = {}) {
  return JSON.stringify({ version: EXPORT_VERSION, rules, ...extra }, null, 2);
}

/**
 * Parse exported JSON (or a bare array of rules). Returns { rules, errors }
 * where rules contains only the valid, normalized entries.
 */
export function importRules(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { rules: [], errors: ['Not valid JSON'] };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.rules) ? data.rules : null;
  if (!list) {
    return { rules: [], errors: ['Expected an array of rules or an object with a "rules" array'] };
  }
  const rules = [];
  const errors = [];
  list.forEach((raw, index) => {
    const rule = normalizeRule(raw);
    const { valid, errors: ruleErrors } = validateRule(rule);
    if (valid) {
      rules.push(rule);
    } else {
      const label = raw && typeof raw.name === 'string' && raw.name ? ` ("${raw.name}")` : '';
      errors.push(`Rule ${index + 1}${label}: ${Object.values(ruleErrors).join('; ')}`);
    }
  });
  return { rules, errors };
}
