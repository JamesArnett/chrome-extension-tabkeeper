// AWS Console tab grouping: pure helpers. Console tabs are grouped by what the
// signed-in account and role are, read from the console's navigation bar.

import { collapseWhitespace } from './titles.js';

export const AWS_RULE_ID = 'aws-console';
// Console hosts can carry several labels. With multi-session support the host is
// <account-id>-<8 chars>.<region>.console.aws.amazon.com
// (https://docs.aws.amazon.com/awsconsolehelpdocs/latest/gsg/multisession.html).
export const AWS_DEFAULT_URL_PATTERN = '^https://([a-z0-9-]+\\.)*console\\.aws\\.amazon\\.com/';
export const AWS_HOST_PERMISSION = 'https://*.console.aws.amazon.com/*';

export const AWS_FIELD_ORDER = ['account', 'accountId', 'role', 'user', 'region'];
export const AWS_FIELD_LABELS = {
  account: 'Account name',
  accountId: 'Account ID',
  role: 'Role',
  user: 'User (part after the slash)',
  region: 'Region (from the URL)',
};
export const AWS_SEPARATORS = [
  { value: ' · ', label: '·  (middle dot)' },
  { value: ' - ', label: '-  (hyphen)' },
  { value: ' / ', label: '/  (slash)' },
  { value: ' | ', label: '|  (bar)' },
  { value: ' ', label: '(space)' },
];

export const AWS_DEFAULT_SELECTORS = {
  account: '[data-testid="account-label"]',
  // Generated class names (globalNav-2246) change between deploys, so the role
  // is found by shape: a span near the account label whose whole text is role/user.
  role: '#awsc-nav-header [data-testid="account-label"] ~ span, [data-testid="account-label"] ~ span, #awsc-nav-header span',
};
/** Whole text must look like role/user; group 1 is the role. */
export const AWS_ROLE_PATTERN = '^([A-Za-z0-9+=,.@_-]+)/[A-Za-z0-9+=,.@_-]+$';

export function defaultAwsSettings() {
  return {
    enabled: false,
    fields: { account: true, accountId: false, role: true, user: false, region: false },
    separator: ' · ',
    urlPattern: AWS_DEFAULT_URL_PATTERN,
    selectors: { ...AWS_DEFAULT_SELECTORS },
  };
}

/** Earlier defaults that were persisted with settings; treated as "not customised" and upgraded. */
const LEGACY_URL_PATTERNS = new Set(['^https://([a-z0-9-]+\\.)?console\\.aws\\.amazon\\.com/']);

export function normalizeAwsSettings(raw) {
  const d = defaultAwsSettings();
  const r = raw && typeof raw === 'object' ? raw : {};
  const fields = { ...d.fields };
  if (r.fields && typeof r.fields === 'object') {
    for (const key of AWS_FIELD_ORDER) if (key in r.fields) fields[key] = Boolean(r.fields[key]);
  }
  const separator = AWS_SEPARATORS.some((s) => s.value === r.separator) ? r.separator : d.separator;
  const selectors = { ...d.selectors };
  if (r.selectors && typeof r.selectors === 'object') {
    for (const key of ['account', 'role']) {
      if (typeof r.selectors[key] === 'string' && r.selectors[key].trim()) selectors[key] = r.selectors[key].trim();
    }
  }
  return {
    enabled: Boolean(r.enabled),
    fields,
    separator,
    urlPattern:
      typeof r.urlPattern === 'string' && r.urlPattern.trim() && !LEGACY_URL_PATTERNS.has(r.urlPattern.trim())
        ? r.urlPattern.trim()
        : d.urlPattern,
    selectors,
  };
}

/** Returns a RegExp or null when the pattern does not compile. */
export function compileAwsPattern(settings) {
  try {
    return new RegExp(settings.urlPattern);
  } catch {
    return null;
  }
}

export function isAwsConsoleUrl(url, regex = new RegExp(AWS_DEFAULT_URL_PATTERN)) {
  return typeof url === 'string' && regex.test(url);
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * Region from ?region= first, then from any hostname label. Multi-session consoles
 * (https://docs.aws.amazon.com/awsconsolehelpdocs/latest/gsg/multisession.html) use
 * <account-id>-<8 chars>.<region>.console.aws.amazon.com, so the region is not
 * necessarily the first label. '' when nothing region-shaped is found.
 */
export function regionFromUrl(url) {
  try {
    const u = new URL(url);
    const q = u.searchParams.get('region');
    if (q && REGION_RE.test(q)) return q;
    const label = u.hostname.split('.').find((part) => REGION_RE.test(part));
    if (label) return label;
  } catch {
    // not a URL
  }
  return '';
}

/** "Acme Dev (123456789012)" -> { account: 'Acme Dev', accountId: '123456789012' }. */
export function parseAccountLabel(text) {
  const t = collapseWhitespace(text);
  if (!t) return { account: '', accountId: '' };
  const m = t.match(/^(.*?)\s*\((\d{12})\)$/);
  if (m) return { account: collapseWhitespace(m[1]), accountId: m[2] };
  if (/^\d{12}$/.test(t)) return { account: '', accountId: t };
  return { account: t, accountId: '' };
}

/** "AdminRole/jane" -> { role: 'AdminRole', user: 'jane' }. */
export function parseRole(text) {
  const t = collapseWhitespace(text);
  if (!t) return { role: '', user: '' };
  const slash = t.indexOf('/');
  if (slash === -1) return { role: t, user: '' };
  return { role: collapseWhitespace(t.slice(0, slash)), user: collapseWhitespace(t.slice(slash + 1)) };
}

/** Fields for the page reader: [account label, role]. */
export function awsReadFields(settings) {
  return [
    { selector: settings.selectors.account, keepOnly: '', label: '' },
    { selector: settings.selectors.role, keepOnly: AWS_ROLE_PATTERN, label: '', pickMatching: true },
  ];
}

/** Some console hosts start with the account id: 123456789012-abcd1234.us-west-2.console... */
export function accountIdFromUrl(url) {
  try {
    const m = new URL(url).hostname.match(/^(\d{12})(?:[-.]|$)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** Turn a reader result (or null) plus the tab URL into { account, accountId, role, user, region }. */
export function parseAwsRead(read, url) {
  const results = read?.results ?? [];
  const parsed = parseAccountLabel(results[0]?.raw ?? results[0]?.value ?? '');
  const { role, user } = parseRole(results[1]?.raw ?? '');
  return {
    account: parsed.account,
    accountId: parsed.accountId || accountIdFromUrl(url),
    role,
    user,
    region: regionFromUrl(url),
  };
}

/** Ticked fields in fixed order, joined by the separator; '' when nothing was read. */
export function composeAwsTitle(settings, info) {
  const parts = [];
  for (const key of AWS_FIELD_ORDER) {
    if (!settings.fields[key]) continue;
    const value = collapseWhitespace(info?.[key]);
    if (value) parts.push(value);
  }
  return parts.join(settings.separator);
}

export const AWS_SAMPLE_INFO = {
  account: 'Acme Dev',
  accountId: '123456789012',
  role: 'AdminRole',
  user: 'jane',
  region: 'us-east-1',
};
