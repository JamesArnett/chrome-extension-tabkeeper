// Classic script (no imports/exports) so it can be injected into pages with
// chrome.scripting alongside reader.js, loaded by the popup with a plain
// <script>, and evaluated in Node tests with vm. Everything about reading a
// status from a document that does not need the live page lives here.
(function (root) {
  const MAX_PATTERN_LENGTH = 500;
  const MAX_REGEX_INPUT = 4096;

  /** Conservative structural checks. Compilation alone never evaluates page text. */
  function compileRegex(pattern, flags = '') {
    if (typeof pattern !== 'string' || pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error('Regex must be ' + MAX_PATTERN_LENGTH + ' characters or fewer');
    }
    const regex = new RegExp(pattern, flags);
    const groups = [{ repeated: false, alternative: false }];
    let atom = null;
    let quantified = false;
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      const group = groups[groups.length - 1];
      if (ch === '\\') {
        const next = pattern[++i];
        if (/[1-9]/.test(next) || (next === 'k' && pattern[i + 1] === '<')) {
          throw new Error('Backreferences are unsupported in tab and status regexes');
        }
        atom = { repeated: false, alternative: false };
      } else if (ch === '[') {
        while (++i < pattern.length) {
          if (pattern[i] === '\\') i++;
          else if (pattern[i] === ']') break;
        }
        atom = { repeated: false, alternative: false };
      } else if (ch === '(') {
        groups.push({ repeated: false, alternative: false });
        atom = null;
        // Skip group prefixes, including lookarounds and named captures.
        if (pattern[i + 1] === '?') {
          i += 2;
          if (pattern[i] === '<') {
            if (['=', '!'].includes(pattern[i + 1])) i++;
            else while (i < pattern.length && pattern[i] !== '>') i++;
          }
        }
      } else if (ch === ')') {
        atom = groups.pop();
        const parent = groups[groups.length - 1];
        parent.repeated ||= atom.repeated;
        parent.alternative ||= atom.alternative;
      } else if (ch === '|') {
        group.alternative = true;
        atom = null;
      } else if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
        if (ch === '?' && quantified) continue; // lazy quantifier
        let repeats = ch !== '?';
        if (ch === '{') {
          const count = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
          if (!count) continue;
          const max = count[2] === undefined ? Number(count[1]) : count[2] === '' ? Infinity : Number(count[2]);
          if (max !== Infinity && max > 1000) throw new Error('Regex repetition counts must be 1000 or fewer');
          repeats = max > 1;
          i += count[0].length - 1;
        }
        if (atom && repeats && (atom.repeated || atom.alternative)) {
          throw new Error('Repeated groups cannot contain repetition or alternatives; simplify the regex');
        }
        group.repeated = true;
        quantified = true;
        continue;
      } else {
        atom = { repeated: false, alternative: false };
      }
      quantified = false;
    }
    return regex;
  }

  /** Skip oversized subjects instead of matching a truncated URL or title. */
  function regexSubject(value) {
    return typeof value === 'string' && value.length <= MAX_REGEX_INPUT ? value : null;
  }

  const DEFAULT_SELECTOR =
    '[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"] button, #status-val';

  const ERRORS = {
    INVALID_SELECTOR: 'invalid-selector',
    INVALID_KEEP_REGEX: 'invalid-keep-regex',
    KEEP_NO_MATCH: 'keep-no-match',
    KEEP_EMPTY: 'keep-empty',
    MATCHED_NO_TEXT: 'matched-no-text',
    MATCHED_NOTHING: 'matched-nothing',
  };

  function collapseWhitespace(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /** Split on top-level commas only; quotes, (), [] keep their commas. */
  function splitSelectorList(list) {
    const out = [];
    let depth = 0;
    let quote = null;
    let current = '';
    const s = String(list == null ? '' : list);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        current += ch;
        if (ch === '\\' && i + 1 < s.length) {
          current += s[++i];
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === '(' || ch === '[') {
        depth++;
        current += ch;
      } else if (ch === ')' || ch === ']') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if (ch === ',' && depth === 0) {
        out.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    out.push(current.trim());
    return out.filter(Boolean);
  }

  /** select -> selected option text (then value); input/textarea -> value; else textContent. */
  function textOf(el) {
    if (!el) return '';
    const tag = String(el.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) {
      const type = String(attr(el, 'type') || el.type || '').toLowerCase();
      const autocomplete = String(attr(el, 'autocomplete') || '').toLowerCase().split(/\s+/);
      if (['password', 'hidden'].includes(type) || autocomplete.some((token) =>
        ['username', 'current-password', 'new-password', 'one-time-code'].includes(token) || token.startsWith('cc-')
      )) return '';
    }
    let text;
    if (tag === 'select') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      text = collapseWhitespace(opt ? opt.textContent : '');
      if (!text) text = el.value;
    } else if (tag === 'input' || tag === 'textarea') {
      text = el.value;
    } else {
      text = el.textContent;
    }
    return collapseWhitespace(String(text == null ? '' : text).slice(0, MAX_REGEX_INPUT));
  }

  function applyKeepOnly(text, pattern) {
    text = String(text == null ? '' : text).slice(0, MAX_REGEX_INPUT);
    if (!pattern) return { value: text, error: null };
    let re;
    try {
      re = compileRegex(pattern, 'i');
    } catch (err) {
      return { value: '', error: ERRORS.INVALID_KEEP_REGEX };
    }
    const m = re.exec(text);
    if (!m) return { value: '', error: ERRORS.KEEP_NO_MATCH };
    const kept = collapseWhitespace(m.length > 1 ? m[1] : m[0]);
    if (!kept) return { value: '', error: ERRORS.KEEP_EMPTY };
    return { value: kept, error: null };
  }

  function attr(el, name) {
    return el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
  }

  /** `tag#id`, `tag[data-testid="…"]`, `tag[aria-label="…"]`, `tag.c1.c2` or just `tag`. */
  function identify(el, requireFeature) {
    const tag = String(el.tagName || 'node').toLowerCase();
    const id = attr(el, 'id');
    if (id) return tag + '#' + id;
    const testId = attr(el, 'data-testid');
    if (testId) return tag + '[data-testid="' + testId + '"]';
    const aria = attr(el, 'aria-label');
    if (aria) return tag + '[aria-label="' + aria + '"]';
    const classes = collapseWhitespace(attr(el, 'class')).split(' ').filter(Boolean).slice(0, 2);
    if (classes.length) return tag + '.' + classes.join('.');
    return requireFeature ? '' : tag;
  }

  function describeElement(el) {
    if (!el) return '';
    const self = identify(el, false);
    const ancestors = [];
    let p = el.parentElement;
    let hops = 0;
    while (p && ancestors.length < 2 && hops < 12) {
      const tag = String(p.tagName || '').toLowerCase();
      if (tag === 'html' || tag === 'body') break;
      const d = identify(p, true);
      if (d) ancestors.push(d);
      p = p.parentElement;
      hops++;
    }
    return ancestors.length ? self + ' (inside ' + ancestors.join(' › ') + ')' : self;
  }

  /**
   * Try the field's selector alternatives in order on one document. By default the
   * first element with text wins. With `pickMatching` (and a keepOnly regex) the
   * first element whose text satisfies keepOnly wins; if none does, the first
   * element with text is reported so the diagnostic can show what was there.
   */
  function readField(doc, field) {
    const selector = field && field.selector ? field.selector : DEFAULT_SELECTOR;
    const alternatives = splitSelectorList(selector);
    const pickMatching = Boolean(field && field.pickMatching && field.keepOnly);
    let matched = 0;
    let invalid = 0;
    let found = null;
    let firstText = null;
    for (const alt of alternatives) {
      let nodes;
      try {
        nodes = doc.querySelectorAll(alt);
      } catch (err) {
        invalid++;
        continue;
      }
      matched += nodes.length;
      for (const node of nodes) {
        const text = textOf(node);
        if (!text) continue;
        if (pickMatching) {
          const kept = applyKeepOnly(text, field.keepOnly);
          if (kept.error === ERRORS.INVALID_KEEP_REGEX || kept.error === null) {
            found = { node, text };
            break;
          }
          if (!firstText) firstText = { node, text };
          continue;
        }
        found = { node, text };
        break;
      }
      if (found) break;
    }
    if (!found && firstText) found = firstText;
    if (!found) {
      let error = ERRORS.MATCHED_NOTHING;
      if (alternatives.length > 0 && invalid === alternatives.length) error = ERRORS.INVALID_SELECTOR;
      else if (matched > 0) error = ERRORS.MATCHED_NO_TEXT;
      return { value: '', raw: '', element: '', matched, error };
    }
    const kept = applyKeepOnly(found.text, field && field.keepOnly);
    return {
      value: kept.value,
      raw: found.text,
      element: describeElement(found.node),
      matched,
      error: kept.error,
    };
  }

  function readFields(doc, fields) {
    const list = Array.isArray(fields) && fields.length ? fields : [{ selector: '' }];
    const results = list.map((f) => readField(doc, f));
    const matchedTotal = results.reduce((n, r) => n + r.matched, 0);
    const valueCount = results.filter((r) => r.value).length;
    return { results, matchedTotal, valueCount, complete: valueCount === results.length };
  }

  /** Raw joined status ("label value · value"); the worker normalises and caps it. */
  function joinValues(fields, results) {
    const parts = [];
    (results || []).forEach((r, i) => {
      if (!r || !r.value) return;
      const label = collapseWhitespace(fields && fields[i] ? fields[i].label : '');
      parts.push(label ? label + ' ' + r.value : r.value);
    });
    return parts.join(' · ');
  }

  root.TabkeeperStatusCore = {
    MAX_PATTERN_LENGTH,
    MAX_REGEX_INPUT,
    compileRegex,
    regexSubject,
    DEFAULT_SELECTOR,
    ERRORS,
    collapseWhitespace,
    splitSelectorList,
    textOf,
    applyKeepOnly,
    identify,
    describeElement,
    readField,
    readFields,
    joinValues,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
