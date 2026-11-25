import { loadFrom } from './modules.mjs';
import { mapSelector } from './selector.mjs';

// Parse one stylesheet and walk its selectors. `visit(name)` is called for every class and returns the name to write.
// The parsed tree is returned so a caller that first collects and then renames parses the file once.
export function parseCss(projectDir, text, file = '') {
  const postcss = loadFrom(projectDir, 'postcss');
  return postcss.parse(text, { from: file });
}

export function walkCss(root, { rename, file = '' } = {}) {
  const defined = new Set(); const issues = [];
  let changed = false;
  const fn = (n) => { defined.add(n); return rename ? rename(n) : n; };
  const opts = { onSkip: (n) => issues.push({ kind: 'escaped-class', file, detail: `.${n}` }), onAttr: (b) => issues.push({ kind: 'class-attribute-selector', file, detail: b }) };
  root.walk((node) => {
    if (node.type === 'rule') {
      for (let p = node.parent; p; p = p.parent) if (p.type === 'atrule' && /keyframes$/i.test(p.name)) return;
      const next = mapSelector(node.selector, fn, opts);
      if (next !== node.selector) { node.selector = next; changed = true; }
    } else if (node.type === 'atrule' && node.name === 'scope') {
      const next = mapSelector(node.params, fn, opts);
      if (next !== node.params) { node.params = next; changed = true; }
    }
  });
  return { defined, issues, changed };
}

// Walk one stylesheet. rename(name) => new name decides what changes; with no rename it only collects.
export function processCss(projectDir, text, { rename, file = '' } = {}) {
  const root = parseCss(projectDir, text, file);
  const r = walkCss(root, { rename, file });
  return { text: rename && r.changed ? root.toString() : text, defined: r.defined, issues: r.issues };
}
