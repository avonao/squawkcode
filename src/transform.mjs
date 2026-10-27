import fs from 'node:fs';
import path from 'node:path';
import { processCss } from './css.mjs';
import { processSource } from './source.mjs';
import { makeNamer } from './names.mjs';
import { walkFiles } from './walk.mjs';

const SRC_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const HTML_CLASS_ATTR = /(\bclass(?:Name)?\s*=\s*\\?)(["'])([^"'\\]*)(\\?)\2/g;

const inside = (file, dirs) => dirs.some((d) => file === d || file.startsWith(d + path.sep));

// Rewrites the tree at `root` in place. `moduleDir` is where postcss/typescript are resolved from (the original project).
export function transformTree(root, cfg, { moduleDir = root, log = () => {} } = {}) {
  const srcDirs = cfg.srcDirs.map((d) => path.join(root, d));
  if (!srcDirs.length) throw new Error('classhash: config.srcDirs is empty — say which directories hold the site\'s CSS and components');
  const exclude = cfg.copyExclude;
  const files = srcDirs.flatMap((d) => walkFiles(d, { exclude }));
  const css = files.filter((f) => f.endsWith('.css'));
  const src = files.filter((f) => SRC_EXTS.includes(path.extname(f)) && !f.endsWith('.d.ts'));
  const text = files.filter((f) => cfg.textExts.includes(path.extname(f)));

  // 1. what the site's CSS defines
  const defined = new Set(); const issues = [];
  for (const f of css) {
    const r = processCss(moduleDir, fs.readFileSync(f, 'utf8'), { file: path.relative(root, f) });
    r.defined.forEach((n) => defined.add(n)); issues.push(...r.issues);
  }

  // 2. what must keep its name, and why
  const keep = new Map(); // name -> reason
  const hold = (n, why) => { if (!keep.has(n)) keep.set(n, why); };
  for (const n of defined) {
    if (cfg.keep.includes(n)) hold(n, 'config.keep');
    else if (cfg.keepPrefixes.some((p) => n.startsWith(p))) hold(n, 'config.keepPrefixes');
  }
  const outsideFiles = walkFiles(root, { exclude });
  if (cfg.externalCss === 'auto') {
    for (const f of outsideFiles) if (f.endsWith('.css') && !inside(f, srcDirs)) {
      const r = processCss(moduleDir, fs.readFileSync(f, 'utf8'), { file: path.relative(root, f) });
      for (const n of r.defined) if (defined.has(n)) hold(n, `also defined in ${path.relative(root, f)}`);
    }
  }
  if (cfg.scanOutsideSource) {
    const words = new Map();
    for (const f of outsideFiles) if (SRC_EXTS.includes(path.extname(f)) && !inside(f, srcDirs)) {
      const t = fs.readFileSync(f, 'utf8');
      for (const lit of t.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) for (const w of lit[2].split(/[\s"'`.#>+~,()[\]=:]+/)) if (defined.has(w) && !words.has(w)) words.set(w, path.relative(root, f));
    }
    for (const [w, f] of words) hold(w, `used as a string in ${f}`);
  }

  // 3. the map
  const namer = makeNamer(cfg.seed, cfg.prefix);
  const map = new Map();
  for (const n of [...defined].sort()) if (!keep.has(n)) map.set(n, namer(n));
  log(`classes defined: ${defined.size}, hashed: ${map.size}, kept: ${keep.size}`);

  // 4. rewrite
  let changedFiles = 0;
  const rename = (n) => (map.has(n) ? map.get(n) : n);
  for (const f of css) {
    const t = fs.readFileSync(f, 'utf8'); const r = processCss(moduleDir, t, { rename, file: path.relative(root, f) });
    if (r.text !== t) { fs.writeFileSync(f, r.text); changedFiles++; }
  }
  for (const f of src) {
    const t = fs.readFileSync(f, 'utf8');
    const r = processSource(moduleDir, path.relative(root, f), t, { map, ambiguous: cfg.ambiguous, keepPrefixes: cfg.keepPrefixes, selectorCallees: cfg.selectorCallees, classCallees: cfg.classCallees });
    issues.push(...r.issues);
    if (r.changed) { fs.writeFileSync(f, r.text); changedFiles++; }
  }
  for (const f of text) {
    const t = fs.readFileSync(f, 'utf8');
    const out = t.replace(HTML_CLASS_ATTR, (m, a, q, v, b) => a + q + v.replace(/\S+/g, (x) => (map.has(x) ? map.get(x) : x)) + b + q);
    if (out !== t) { fs.writeFileSync(f, out); changedFiles++; }
  }

  // class-attribute selectors are only fatal when they could match a hashed class
  const fatal = issues.filter((i) => i.kind !== 'class-attribute-selector' || [...map.values()].length > 0);
  return { map, keep, issues: fatal, defined, changedFiles, stats: { css: css.length, src: src.length, text: text.length } };
}

export function copyProject(from, to, exclude) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, filter: (s) => !exclude.includes(path.basename(s)) });
}

export function formatIssues(issues, max = 60) {
  const lines = issues.slice(0, max).map((i) => `  ${i.kind.padEnd(24)} ${i.file}${i.line ? ':' + i.line : ''}  ${i.detail}`);
  if (issues.length > max) lines.push(`  … and ${issues.length - max} more`);
  return lines.join('\n');
}
