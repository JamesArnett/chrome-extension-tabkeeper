// Everything about group titles lives here: the separator and ellipsis are
// load-bearing for shortening, title-scan adoption and status recovery, so they
// are defined once.

export const ELLIPSIS = '…';
export const SEPARATOR = ' - ';
export const FIELD_JOIN = ' · ';
export const MAX_STATUS_LENGTH = 80;
export const MIN_BASE_LENGTH = 8;
export const MIN_TITLE_LIMIT = 12;
export const MIN_SCAN_HEAD = 3;

export function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 0 = no limit; 1..11 are raised to 12; anything else floored. */
export function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.floor(n);
  return whole < MIN_TITLE_LIMIT ? MIN_TITLE_LIMIT : whole;
}

/** Collapse whitespace and cap at MAX_STATUS_LENGTH, ending in … when cut. */
export function normalizeStatus(value) {
  const text = collapseWhitespace(value);
  if (text.length <= MAX_STATUS_LENGTH) return text;
  return text.slice(0, MAX_STATUS_LENGTH - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}

/**
 * Join per-field values ("label value") with the field separator and normalise.
 * `values[i]` is the string value for `fields[i]`, or empty/null when the field
 * produced nothing; such fields are omitted rather than failing the whole status.
 */
export function composeStatus(fields, values) {
  const parts = [];
  fields.forEach((field, i) => {
    const value = collapseWhitespace(values[i]);
    if (!value) return;
    const label = collapseWhitespace(field?.label);
    parts.push(label ? `${label} ${value}` : value);
  });
  return normalizeStatus(parts.join(FIELD_JOIN));
}

/**
 * `<base>` or `<base> - <status>`, shortened to `limit` by cutting the base
 * (never the status, never below MIN_BASE_LENGTH characters of base).
 */
export function buildTitle(base, status, limit = 0) {
  const suffix = status ? SEPARATOR + status : '';
  const full = base + suffix;
  const max = clampLimit(limit);
  if (max === 0 || full.length <= max) return full;
  const available = max - suffix.length - ELLIPSIS.length;
  const headLength = Math.max(MIN_BASE_LENGTH, available);
  if (headLength >= base.length) return full;
  return base.slice(0, headLength).trimEnd() + ELLIPSIS + suffix;
}

/**
 * Could `title` have been produced from `base` by buildTitle? Returns
 * { status, shortened } when so, else null. Tolerance is deliberately narrow:
 *  - exact match always counts;
 *  - `base - status` only when the rule has status enabled;
 *  - `head…` / `head… - status` only when a limit is on, head >= 3 chars and base starts with head.
 */
export function parseTitle(title, base, { statusEnabled = false, limit = 0 } = {}) {
  if (typeof title !== 'string' || !base) return null;
  if (title === base) return { status: null, shortened: false };

  if (statusEnabled && title.startsWith(base + SEPARATOR)) {
    const status = title.slice(base.length + SEPARATOR.length);
    if (status) return { status, shortened: false };
  }

  if (clampLimit(limit) > 0) {
    const cut = title.indexOf(ELLIPSIS);
    if (cut >= MIN_SCAN_HEAD) {
      const head = title.slice(0, cut);
      const rest = title.slice(cut + ELLIPSIS.length);
      if (head.length < base.length && base.startsWith(head)) {
        if (rest === '') return { status: null, shortened: true };
        if (statusEnabled && rest.startsWith(SEPARATOR) && rest.length > SEPARATOR.length) {
          return { status: rest.slice(SEPARATOR.length), shortened: true };
        }
      }
    }
  }
  return null;
}
