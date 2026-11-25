import fs from 'node:fs';
import path from 'node:path';
import { parseCss, walkCss } from './css.mjs';
import { mapSelector } from './selector.mjs';
import { processSource } from './source.mjs';
import { assignMinNames, makeNamer } from './names.mjs';
import { walkFiles } from './walk.mjs';

const SRC_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const HTML_CLASS_ATTR = /(\bclass(?:Name)?\s*=\s*\\?)(["'])([^"'\\]*)(\\?)\2/g;

const inside = (file, dirs) => dirs.some((d) => file === d || file.startsWith(d + path.sep));

// Rewrites the tree at `root` in place. `moduleDir` is where postcss/typescript are resolved from (the original project).
// `previous` is the map of an earlier run (original -> name): with minimal names, a class keeps the name it had.
export function transformTree(root, cfg, { moduleDir = root, log = () => {}, previous = {} } = {}) {
  const srcDirs = cfg.srcDirs.map((d) => path.join(root, d));
  if (!srcDirs.length) throw new Error('squawkcode: config.srcDirs is empty — say which directories hold the site\'s CSS and components');
  if (cfg.names !== 'hash' && cfg.names !== 'min') throw new Error(`squawkcode: config.names must be "hash" or "min", not ${JSON.stringify(cfg.names)}`);
  const exclude = cfg.copyExclude;
  const files = srcDirs.flatMap((d) => walkFiles(d, { exclude }));
  const css = files.filter((f) => f.endsWith('.css'));
  const src = files.filter((f) => SRC_EXTS.includes(path.extname(f)) && !f.endsWith('.d.ts'));
  const text = files.filter((f) => cfg.textExts.includes(path.extname(f)));
  const read = new Map(); // file -> text, read once
  const textOf = (f) => { if (!read.has(f)) read.set(f, fs.readFileSync(f, 'utf8')); return read.get(f); };

  // 1. what the site's CSS defines (each stylesheet is parsed once and renamed in that same tree)
  const defined = new Set(); const issues = [];
  const sheets = css.map((f) => {
    const rel = path.relative(root, f);
    const tree = parseCss(moduleDir, textOf(f), rel);
    const r = walkCss(tree, { file: rel });
    r.defined.forEach((n) => defined.add(n)); issues.push(...r.issues);
    return { file: f, rel, tree };
  });

  // 2. what must keep its name, and why
  const keep = new Map(); // name -> reason
  const hold = (n, why) => { if (!keep.has(n)) keep.set(n, why); };
  for (const n of defined) {
    if (cfg.keep.includes(n)) hold(n, 'config.keep');
    else if (cfg.keepPrefixes.some((p) => n.startsWith(p))) hold(n, 'config.keepPrefixes');
  }
  const outsideFiles = walkFiles(root, { exclude });
  const foreign = new Set(); // every class name some stylesheet outside the source directories defines
  if (cfg.externalCss === 'auto') {
    for (const f of outsideFiles) if (f.endsWith('.css') && !inside(f, srcDirs)) {
      const rel = path.relative(root, f);
      const r = walkCss(parseCss(moduleDir, fs.readFileSync(f, 'utf8'), rel), { file: rel });
      for (const n of r.defined) { foreign.add(n); if (defined.has(n)) hold(n, `also defined in ${rel}`); }
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
  const map = new Map();
  const renamed = [...defined].filter((n) => !keep.has(n)).sort();
  if (cfg.names === 'min') {
    // How often each class is written, in the stylesheets, the components and the markup: the ranking for the names.
    const counts = new Map(renamed.map((n) => [n, 0]));
    for (const f of [...css, ...src, ...text]) for (const w of textOf(f).match(/[A-Za-z_][\w-]*/g) ?? []) if (counts.has(w)) counts.set(w, counts.get(w) + 1);
    // A new name must not be one that stays in use: a kept class, a class another stylesheet defines, a class that is renamed itself.
    const taken = new Set([...keep.keys(), ...foreign, ...defined, ...cfg.keep]);
    // nor may it look like a member of a family that keeps its names (one built at run time from a kept prefix)
    const avoid = (name) => cfg.keepPrefixes.some((p) => name.startsWith(p));
    for (const [n, name] of assignMinNames(counts, { prefix: cfg.minPrefix ?? '', taken, previous, avoid })) map.set(n, name);
  } else {
    const namer = makeNamer(cfg.seed, cfg.prefix);
    for (const n of renamed) map.set(n, namer(n));
  }
  log(`classes defined: ${defined.size}, ${cfg.names === 'min' ? 'renamed' : 'hashed'}: ${map.size}, kept: ${keep.size}`);

  // 4. rewrite
  let changedFiles = 0;
  const rename = (n) => (map.has(n) ? map.get(n) : n);
  for (const sheet of sheets) {
    const r = walkCss(sheet.tree, { rename, file: sheet.rel });
    if (r.changed) { fs.writeFileSync(sheet.file, sheet.tree.toString()); changedFiles++; }
  }
  for (const f of src) {
    const t = textOf(f);
    if (!mentionsAny(t, map)) continue; // no renamed class is named in this file: nothing to rewrite, nothing to parse
    const r = processSource(moduleDir, path.relative(root, f), t, { map, ambiguous: cfg.ambiguous, keepPrefixes: cfg.keepPrefixes, selectorCallees: cfg.selectorCallees, classCallees: cfg.classCallees });
    issues.push(...r.issues);
    if (r.changed) { fs.writeFileSync(f, r.text); changedFiles++; }
  }
  for (const f of text) {
    const t = textOf(f);
    const out = t.replace(HTML_CLASS_ATTR, (m, a, q, v, b) => a + q + v.replace(/\S+/g, (x) => (map.has(x) ? map.get(x) : x)) + b + q);
    if (out !== t) { fs.writeFileSync(f, out); changedFiles++; }
  }

  // class-attribute selectors are only fatal when they could match a renamed class
  const fatal = issues.filter((i) => i.kind !== 'class-attribute-selector' || map.size > 0);
  return { map, keep, issues: fatal, defined, changedFiles, stats: { css: css.length, src: src.length, text: text.length } };
}

// Does the text contain a renamed class name as a word, or the start of one (a class built with a template string)?
// A file without any is left unparsed. Every word is looked up, and so is every start of a name up to a hyphen or an
// underscore and every end from one, so `slide-${n}` and `${block}__title` still send the file to the parser, which is
// what reports them.
function mentionsAny(text, map) {
  if (map.size === 0) return false;
  if (!mentionsAny.stems || mentionsAny.for !== map) {
    const stems = new Set();
    for (const name of map.keys()) { stems.add(name); for (let i = 0; i < name.length; i++) if (name[i] === '-' || name[i] === '_') { stems.add(name.slice(0, i + 1)); stems.add(name.slice(i)); } }
    mentionsAny.stems = stems; mentionsAny.for = map;
  }
  const { stems } = mentionsAny;
  for (const w of text.match(/[A-Za-z_-][\w-]*/g) ?? []) if (stems.has(w)) return true;
  return false;
}

// How to rewrite what the comparison's configuration says about classes for the renamed copy: the html classes of a
// state (`dark`), a hover selector, and the scripts of actions, `readyWhen` and `beforeCapture`, which are rewritten
// the way source files are. A script that names a class in a way that cannot be rewritten with certainty stops the run.
export function renamer(map, cfg, moduleDir) {
  const get = (n) => (map.has(n) ? map.get(n) : n);
  return {
    classes: (text) => text.replace(/\S+/g, get),
    selector: (text) => mapSelector(text, get),
    js(text) {
      const r = processSource(moduleDir, 'compare-script.js', text, { map, ambiguous: cfg.ambiguous, keepPrefixes: cfg.keepPrefixes, selectorCallees: cfg.selectorCallees, classCallees: cfg.classCallees });
      if (r.issues.length) throw new Error(`squawkcode: a script in the compare configuration cannot be rewritten for the renamed copy (${r.issues.map((i) => `${i.kind} ${i.detail}`).join('; ')}): ${text.slice(0, 120)}`);
      return r.text;
    },
  };
}

// The class map of an earlier run, for minimal names that stay the same between deploys: config.namesFrom, or the map
// file in the project when there is one. Hashed names need none: they are the same in every run by construction.
export function previousMap(project, cfg) {
  if (cfg.names !== 'min') return {};
  const file = path.resolve(project, cfg.namesFrom ?? cfg.mapFile);
  if (!fs.existsSync(file)) {
    if (cfg.namesFrom) throw new Error(`squawkcode: config.namesFrom names ${file}, which does not exist`);
    return {};
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || typeof data.map !== 'object') throw new Error(`squawkcode: ${file} is not a class map`);
  return data.names === 'min' || data.names === undefined ? data.map : {};
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
