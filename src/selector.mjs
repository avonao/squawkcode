// Class tokens inside a CSS selector (or a selector-ish string): `.name` outside strings, [attr] blocks and escapes.
// mapSelector(sel, fn) returns the selector with every class name replaced by fn(name). Names containing escapes are
// reported through onSkip and left alone. Attribute selectors that look at `class` are reported through onAttr.
export function mapSelector(sel, fn, { onSkip, onAttr } = {}) {
  let out = '';
  for (let i = 0; i < sel.length; ) {
    const ch = sel[i];
    if (ch === '\\') { out += sel.slice(i, i + 2); i += 2; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < sel.length && sel[j] !== ch) j += sel[j] === '\\' ? 2 : 1;
      out += sel.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '[') {
      let j = i + 1; let q = null;
      while (j < sel.length && (q || sel[j] !== ']')) { if (q) { if (sel[j] === q) q = null; } else if (sel[j] === '"' || sel[j] === "'") q = sel[j]; j++; }
      const block = sel.slice(i, j + 1);
      if (/^\[\s*class\b/i.test(block)) onAttr?.(block);
      out += block; i = j + 1; continue;
    }
    if (ch === '.' && /[A-Za-z_\\-]/.test(sel[i + 1] || '')) {
      let j = i + 1; let hasEscape = false;
      while (j < sel.length && /[\w-]|\\/.test(sel[j])) { if (sel[j] === '\\') { hasEscape = true; j += 2; } else j++; }
      const name = sel.slice(i + 1, j);
      if (hasEscape) { onSkip?.(name); out += '.' + name; } else out += '.' + fn(name);
      i = j; continue;
    }
    out += ch; i++;
  }
  return out;
}

export function classesIn(sel) {
  const found = [];
  mapSelector(sel, (n) => { found.push(n); return n; });
  return found;
}
