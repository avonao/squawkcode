import { loadFrom } from './modules.mjs';
import { mapSelector } from './selector.mjs';

// Walk one stylesheet. rename(name) => new name decides what changes; with no rename it only collects.
export function processCss(projectDir, text, { rename, file = '' } = {}) {
  const postcss = loadFrom(projectDir, 'postcss');
  const root = postcss.parse(text, { from: file });
  const defined = new Set(); const issues = [];
  const fn = (n) => { defined.add(n); return rename ? rename(n) : n; };
  const opts = { onSkip: (n) => issues.push({ kind: 'escaped-class', file, detail: `.${n}` }), onAttr: (b) => issues.push({ kind: 'class-attribute-selector', file, detail: b }) };
  root.walk((node) => {
    if (node.type === 'rule') {
      for (let p = node.parent; p; p = p.parent) if (p.type === 'atrule' && /keyframes$/i.test(p.name)) return;
      const next = mapSelector(node.selector, fn, opts);
      if (next !== node.selector) node.selector = next;
    } else if (node.type === 'atrule' && (node.name === 'scope' || node.name === 'container')) {
      if (node.name === 'scope') node.params = mapSelector(node.params, fn, opts);
    }
  });
  return { text: rename ? root.toString() : text, defined, issues };
}
