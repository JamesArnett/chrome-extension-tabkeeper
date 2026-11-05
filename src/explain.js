// "What would Tabkeeper do with this tab?" Pure: used by the popup's and the
// settings page's Test buttons for close rules and age-based closing.

import { compileRules, findMatchingRule, ruleMatches } from './matcher.js';
import { exemptionReason, limitMs, describeLimit } from './age-closer.js';

const EXEMPTION_TEXT = {
  pinned: 'it is pinned',
  active: 'it is the active tab in its window',
  audible: 'it is playing audio',
  'pending-close': 'a close rule is already counting down on it',
  'unsaved-input': 'it refused to close once (unsaved input), so it is left alone',
  'never-close': 'it matches your never-close list',
  'no-tab': 'there is no tab',
};

/**
 * @returns {{ rule, keptRules, lines: string[], level: 'close'|'quiet'|'none' }}
 *  - rule: the close rule that would fire (first enabled match not kept), or null
 *  - keptRules: rules that match but the user pressed Keep on for this tab
 */
export function explainClose(tab, { rules = [], closeSettings, keptRuleIds = [], isPendingClose = () => false } = {}) {
  const compiled = compileRules(rules);
  const info = { title: tab?.title ?? '', url: tab?.url ?? '' };
  const lines = [];
  let level = 'none';

  const rule = tab?.pinned ? null : findMatchingRule(compiled, info, keptRuleIds);
  const keptRules = compiled
    .filter((c) => c.rule.enabled && keptRuleIds.includes(c.rule.id) && ruleMatches(c, info))
    .map((c) => c.rule);

  if (tab?.pinned) {
    lines.push('Close rules skip pinned tabs.');
  } else if (rule) {
    level = 'close';
    const grace = rule.groupAfterSeconds ?? 0;
    let text = `Close rule "${rule.name}" matches: the tab closes ${rule.delaySeconds} s after it matched`;
    if (grace >= rule.delaySeconds && grace > 0) text += ', without being moved to the Closing group';
    else if (grace > 0) text += `, and moves to the Closing group after ${grace} s`;
    else text += ', and moves to the Closing group straight away';
    lines.push(text + '.');
  } else {
    lines.push('No close rule matches this tab.');
  }
  for (const kept of keptRules) lines.push(`Rule "${kept.name}" matches too, but you pressed Keep on this tab, so it is ignored while the tab stays open.`);

  if (closeSettings) {
    const openMs = limitMs(closeSettings.maxOpen);
    const idleMs = limitMs(closeSettings.maxIdle);
    if (!openMs && !idleMs) {
      lines.push('Age-based closing is off.');
    } else {
      const reason = exemptionReason(tab, { isPendingClose, neverClose: closeSettings.neverClose });
      const limits = [
        openMs ? `open longer than ${describeLimit(closeSettings.maxOpen)}` : null,
        idleMs ? `not used for ${describeLimit(closeSettings.maxIdle)}` : null,
      ].filter(Boolean);
      if (reason) lines.push(`Age-based closing leaves this tab alone because ${EXEMPTION_TEXT[reason] ?? reason}.`);
      else {
        if (level === 'none') level = 'quiet';
        lines.push(`Age-based closing applies: it closes quietly once ${limits.join(' or ')}.`);
      }
    }
  }
  return { rule, keptRules, lines, level };
}
