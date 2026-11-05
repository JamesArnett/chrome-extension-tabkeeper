// Loads the classic (non-module) src/status-core.js into a vm context for tests.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'status-core.js');

export function loadStatusCore() {
  // Run in this context (not a fresh one) so returned arrays/objects share the
  // test's prototypes and strict deepEqual works.
  if (!globalThis.TabkeeperStatusCore) {
    vm.runInThisContext(readFileSync(file, 'utf8'), { filename: 'status-core.js' });
  }
  return globalThis.TabkeeperStatusCore;
}

/** Tiny element stand-in. `children` builds parentElement links. */
export function el(tagName, attrs = {}, { text = '', value, selected, children = [] } = {}) {
  const node = {
    tagName: tagName.toUpperCase(),
    attrs,
    textContent: text,
    value,
    parentElement: null,
    children,
    getAttribute(name) {
      return name in attrs ? attrs[name] : null;
    },
  };
  for (const c of children) c.parentElement = node;
  if (tagName === 'select') {
    node.selectedOptions = children.filter((c) => c.selected);
  }
  if (tagName === 'option') node.selected = Boolean(selected);
  return node;
}

/** Fake document: `map` is selector -> array of elements; selectors containing "!!" throw. */
export function fakeDoc(map) {
  return {
    querySelectorAll(selector) {
      if (selector.includes('!!')) throw new SyntaxError(`'${selector}' is not a valid selector`);
      return map[selector] ?? [];
    },
  };
}
