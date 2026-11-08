// Grouping rules: schema, validation, compilation, matching and base-title resolution.
// Pure module.

import { collapseWhitespace } from './titles.js';
import { generateId, MAX_NAME_LENGTH, MAX_PATTERN_LENGTH } from './rules.js';

// chrome.tabGroups.Color: the nine colours Chrome allows. Custom colours are not possible.
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const IGNORED_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'moz-extension://', 'about:'];
/** fixed: the chosen colour; random: a random colour per new group; title: the same colour for the same base title. */
export const COLOR_MODES = ['fixed', 'random', 'title'];

export function isIgnoredUrl(url) {
  if (typeof url !== 'string' || url === '') return true;
  return IGNORED_URL_PREFIXES.some((p) => url.startsWith(p));
}

export function emptyStatusField() {
  return { selector: '', keepOnly: '', label: '' };
}

export function newGroupRule() {
  return {
    id: generateId(),
    name: '',
    enabled: true,
    regex: '',
    titleTemplate: '',
    color: 'blue',
    colorMode: 'fixed',
    statusEnabled: false,
    statusFields: [emptyStatusField()],
    siteOrigin: '',
    createdAt: Date.now(),
  };
}

export function templateUsesCaptures(template) {
  return /\$[1-9]/.test(String(template ?? ''));
}

export function isDynamicTitle(rule) {
  return templateUsesCaptures(rule?.titleTemplate);
}

/** True when the pattern has at least one unescaped capturing `(` not followed by `?`. */
export function hasCaptureGroup(pattern) {
  const s = String(pattern ?? '');
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(' && s[i + 1] !== '?') return true;
  }
  return false;
}

/** Normalise whatever the user typed (with or without scheme) to a bare http(s) origin, or ''. */
export function normalizeOrigin(text) {
  const raw = collapseWhitespace(text);
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** Origin of a tab URL if it is http(s), else ''. */
export function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

function normalizeStatusField(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    selector: typeof f.selector === 'string' ? f.selector.trim() : '',
    keepOnly: typeof f.keepOnly === 'string' ? f.keepOnly.trim() : '',
    label: typeof f.label === 'string' ? collapseWhitespace(f.label) : '',
  };
}

export function normalizeGroupRule(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const titleTemplate = typeof r.titleTemplate === 'string' ? r.titleTemplate.trim() : '';
  const name = typeof r.name === 'string' ? collapseWhitespace(r.name) : '';
  const fields = Array.isArray(r.statusFields) ? r.statusFields.map(normalizeStatusField) : [];
  if (fields.length === 0) fields.push(emptyStatusField());
  return {
    id: typeof r.id === 'string' && r.id ? r.id : generateId(),
    name: name || titleTemplate,
    enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    regex: typeof r.regex === 'string' ? r.regex.trim() : '',
    titleTemplate,
    color: GROUP_COLORS.includes(r.color) ? r.color : 'blue',
    // randomColor is the pre-colorMode boolean; keep accepting it.
    colorMode: COLOR_MODES.includes(r.colorMode) ? r.colorMode : r.randomColor ? 'random' : 'fixed',
    statusEnabled: Boolean(r.statusEnabled),
    statusFields: fields,
    siteOrigin: normalizeOrigin(r.siteOrigin),
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
  };
}

/**
 * Validate a (normalised) rule. `probeSelector(selector) -> boolean` checks one CSS
 * selector alternative for validity; the popup passes document.querySelector in a
 * try/catch, tests pass a stub. `splitSelectorList` comes from status-core.
 */
export function validateGroupRule(rule, { forTest = false, probeSelector = null, splitSelectorList = null } = {}) {
  const errors = {};
  if (!rule || typeof rule !== 'object') return { valid: false, errors: { rule: 'Rule must be an object' } };

  if (!rule.regex) {
    errors.regex = 'URL regex is required';
  } else if (rule.regex.length > MAX_PATTERN_LENGTH) {
    errors.regex = `Regex must be ${MAX_PATTERN_LENGTH} characters or fewer`;
  } else {
    try {
      new RegExp(rule.regex);
    } catch (err) {
      errors.regex = `Regex does not compile: ${err.message}`;
    }
  }

  if (!rule.titleTemplate) {
    if (!forTest) errors.titleTemplate = 'Group title is required';
  } else if (templateUsesCaptures(rule.titleTemplate) && !errors.regex && !hasCaptureGroup(rule.regex)) {
    errors.titleTemplate =
      'The title uses $1 but the regex has no capturing group. Wrap the part to capture in parentheses, e.g. ([A-Z]+-\\d+).';
  }

  if (rule.name && rule.name.length > MAX_NAME_LENGTH) errors.name = `Name must be ${MAX_NAME_LENGTH} characters or fewer`;
  if (!GROUP_COLORS.includes(rule.color)) errors.color = 'Pick one of the nine tab group colours';

  if (rule.statusEnabled) {
    rule.statusFields.forEach((field, i) => {
      const n = i + 1;
      if (field.selector && splitSelectorList && probeSelector) {
        const bad = splitSelectorList(field.selector).filter((alt) => !probeSelector(alt));
        if (bad.length) errors[`field${n}`] = `Field ${n}: not a valid CSS selector: ${bad.join(', ')}`;
      }
      if (field.keepOnly) {
        try {
          new RegExp(field.keepOnly, 'i');
        } catch (err) {
          errors[`field${n}`] = `Field ${n}: "keep only" regex does not compile: ${err.message}`;
        }
      }
    });
    if (!forTest && !rule.siteOrigin) errors.siteOrigin = 'Site origin must be an http(s) address, e.g. https://jira.example.com';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Compile once per rule change. Invalid regexes yield { regex: null, error }. */
export function compileGroupRules(rules) {
  return rules.map((rule) => {
    try {
      if (!rule.regex) throw new Error('empty regex');
      return { rule, regex: new RegExp(rule.regex), error: null };
    } catch (err) {
      return { rule, regex: null, error: err.message };
    }
  });
}

/**
 * First enabled rule matching the URL wins; only if none matches the URL are the
 * rules tried against the title. Returns { rule, match, matchedOn } or null.
 */
export function matchGroupRules(compiled, { url, title }) {
  if (isIgnoredUrl(url)) return null;
  const candidates = compiled.filter((c) => c.rule.enabled && c.regex);
  for (const subject of [
    { text: typeof url === 'string' ? url : '', on: 'url' },
    { text: typeof title === 'string' ? title : '', on: 'title' },
  ]) {
    if (!subject.text) continue;
    for (const c of candidates) {
      const match = c.regex.exec(subject.text);
      if (match) return { rule: c.rule, match, matchedOn: subject.on };
    }
  }
  return null;
}

/** Expand $1..$9, collapse whitespace; empty expansion falls back to rule name, then raw template. */
export function resolveBaseTitle(rule, match) {
  const template = String(rule.titleTemplate ?? '').trim();
  if (!templateUsesCaptures(template)) return template;
  const expanded = collapseWhitespace(template.replace(/\$([1-9])/g, (_, n) => match?.[Number(n)] ?? ''));
  if (expanded) return expanded;
  return collapseWhitespace(rule.name) || template;
}

export function summarizeStatusFields(fields) {
  return (fields ?? [])
    .map((f) => {
      const sel = f.selector || '(default Jira selector)';
      const keep = f.keepOnly ? ` → /${f.keepOnly}/` : '';
      return f.label ? `${f.label}: ${sel}${keep}` : `${sel}${keep}`;
    })
    .join(FIELD_JOIN_FOR_SUMMARY);
}
const FIELD_JOIN_FOR_SUMMARY = ' · ';

/** Deterministic colour for a title (FNV-1a), stable across sessions and machines. */
export function colorForTitle(title) {
  let h = 0x811c9dc5;
  for (const ch of String(title ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

export function pickColor(rule, random = Math.random, baseTitle = '') {
  const mode = COLOR_MODES.includes(rule.colorMode) ? rule.colorMode : rule.randomColor ? 'random' : 'fixed';
  if (!isDynamicTitle(rule) || mode === 'fixed') return rule.color;
  if (mode === 'title') return colorForTitle(baseTitle);
  return GROUP_COLORS[Math.floor(random() * GROUP_COLORS.length) % GROUP_COLORS.length];
}

/** Parse exported JSON and return the valid, normalised grouping rules plus per-entry errors. */
export function importGroupRules(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { rules: [], errors: ['Not valid JSON'] };
  }
  const list = Array.isArray(data?.groupRules) ? data.groupRules : [];
  const rules = [];
  const errors = [];
  list.forEach((raw, index) => {
    const rule = normalizeGroupRule(raw);
    const { valid, errors: ruleErrors } = validateGroupRule(rule);
    if (valid) rules.push(rule);
    else errors.push(`Grouping rule ${index + 1}${rule.name ? ` ("${rule.name}")` : ''}: ${Object.values(ruleErrors).join('; ')}`);
  });
  return { rules, errors };
}
