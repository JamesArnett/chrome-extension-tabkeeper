// Classic script (no imports/exports) so it can be injected into pages with
// chrome.scripting alongside reader.js, loaded by the popup with a plain
// <script>, and evaluated in Node tests with vm. Everything about reading a
// status from a document that does not need the live page lives here.
(function (root) {
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
    return collapseWhitespace(text);
  }

  function applyKeepOnly(text, pattern) {
    if (!pattern) return { value: text, error: null };
    let re;
    try {
      re = new RegExp(pattern, 'i');
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
