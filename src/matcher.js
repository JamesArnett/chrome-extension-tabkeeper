// Compiles rules into predicate functions and evaluates tabs against them.
// Pure module: no chrome.* access.

/** Returns a (string) => boolean predicate, or null for an absent condition. Throws on bad input. */
export function compileCondition(cond) {
  if (cond === null || cond === undefined) return null;
  const { mode, pattern, caseSensitive } = cond;
  if (typeof pattern !== 'string') throw new Error('Pattern must be a string');

  if (mode === 'regex') {
    const re = new RegExp(pattern, caseSensitive ? '' : 'i');
    return (s) => re.test(s);
  }

  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const prep = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  switch (mode) {
    case 'contains':
      return (s) => prep(s).includes(needle);
    case 'startsWith':
      return (s) => prep(s).startsWith(needle);
    case 'endsWith':
      return (s) => prep(s).endsWith(needle);
    case 'equals':
      return (s) => prep(s) === needle;
    default:
      throw new Error(`Unknown match mode "${mode}"`);
  }
}

/** Returns { rule, title, url, error }. Invalid rules get error set and never match. */
export function compileRule(rule) {
  try {
    const title = compileCondition(rule.title);
    const url = compileCondition(rule.url);
    if (!title && !url) return { rule, title: null, url: null, error: 'Rule has no conditions' };
    return { rule, title, url, error: null };
  } catch (err) {
    return { rule, title: null, url: null, error: err.message };
  }
}

export function compileRules(rules) {
  return rules.map(compileRule);
}

export function ruleMatches(compiled, tab) {
  if (compiled.error) return false;
  const title = typeof tab.title === 'string' ? tab.title : '';
  const url = typeof tab.url === 'string' ? tab.url : '';
  if (compiled.title && !compiled.title(title)) return false;
  if (compiled.url && !compiled.url(url)) return false;
  return true;
}

/** First enabled rule (in list order) that matches, or null. `excludeIds` are skipped (kept tabs). */
export function findMatchingRule(compiledRules, tab, excludeIds = []) {
  for (const compiled of compiledRules) {
    if (!compiled.rule.enabled) continue;
    if (excludeIds.length && excludeIds.includes(compiled.rule.id)) continue;
    if (ruleMatches(compiled, tab)) return compiled.rule;
  }
  return null;
}
