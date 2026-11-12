// Prepare a reviewable import without writing settings or enabling automation.
import { DEFAULT_DELAY_SECONDS, generateId, importRules } from './rules.js';
import { importGroupRules } from './group-rules.js';
import { normalizeAwsSettings, compileAwsPattern } from './aws.js';
import { normalizeCloseSettings } from './age-closer.js';
import { compileRule, ruleMatches } from './matcher.js';

export function prepareSettingsImport(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('Expected an export object or an array of close rules.');
  const close = Array.isArray(data) || 'rules' in data ? importRules(text) : { rules: [], errors: [] };
  const group = importGroupRules(text);
  const rules = close.rules.map((rule) => ({
    ...rule, id: generateId(), enabled: false,
    delaySeconds: Math.max(DEFAULT_DELAY_SECONDS, rule.delaySeconds),
  }));
  const groupRules = group.rules.map((rule) => ({ ...rule, id: generateId(), enabled: false }));
  const errors = [...close.errors, ...group.errors];
  let awsSettings = null;
  if (data.awsSettings && typeof data.awsSettings === 'object' && !Array.isArray(data.awsSettings)) {
    const next = normalizeAwsSettings(data.awsSettings);
    if (compileAwsPattern(next)) awsSettings = next;
    else errors.push('AWS settings skipped because the console URL regex is invalid or unsafe.');
  }
  const closeSettings = data.closeSettings && typeof data.closeSettings === 'object' && !Array.isArray(data.closeSettings)
    ? normalizeCloseSettings(data.closeSettings) : null;
  const maxTitleLength = Number.isFinite(data.settings?.maxTitleLength) ? data.settings.maxTitleLength : null;
  return { rules, groupRules, awsSettings, closeSettings, maxTitleLength, errors };
}

/** Warn when a rule matches unrelated web pages, using the same bounded matcher as closing. */
export function hasBroadMatch(rule) {
  const compiled = compileRule(rule);
  return ['http', 'https'].some((scheme) => [
    { title: 'Example page', url: `${scheme}://example.com/` },
    { title: 'A different page', url: `${scheme}://example.org/another-page` },
  ].every((tab) => ruleMatches(compiled, tab)));
}
