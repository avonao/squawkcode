// SquawkCode's benchmarks, on a generated static site:
//
//   node benchmarks/run.mjs [--components 120] [--pages 4] [--per-page 40] [--only size,speed,detect] [--json results/site.json]
//                           [--baseline <checkout of an earlier SquawkCode>]
//
//   size    what renaming saves: the site as written, with hashed names and with minimal names, raw and compressed
//   speed   how long the proof takes: now, and with --baseline as an earlier version did it (that version is run, on
//           the same site)
//   detect  what the proof finds: single-rule changes to the stylesheet, looked for with the computed-style comparison
//           and with a screenshot comparison (full-page screenshots of every page at both viewports, compared with
//           pixelmatch at the threshold Playwright's toHaveScreenshot uses)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import zlib from 'node:zlib';
import { launchChrome, sleep } from '../src/cdp.mjs';
import { compareSites, defaultConcurrency } from '../src/compare.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { renamer, transformTree } from '../src/transform.mjs';
import { serve } from './serve.mjs';
import { generateSite, writeSite } from './site.mjs';

const here = import.meta.dirname;
const repo = path.join(here, '..');
const { values: args } = parseArgs({
  options: {
    components: { type: 'string', default: '120' },
    pages: { type: 'string', default: '4' },
    'per-page': { type: 'string', default: '40' },
    only: { type: 'string', default: 'size,speed,detect' },
    json: { type: 'string' },
    baseline: { type: 'string' },
  },
});
const only = new Set(args.only.split(','));
const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `sq-bench-${name}-`));
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const CHROME = [process.env.SQUAWKCODE_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((p) => fs.existsSync(p));

const FILES = generateSite({ components: Number(args.components), pages: Number(args.pages), perPage: Number(args['per-page']) });
const PAGES = Object.keys(FILES).filter((f) => f.endsWith('.html')).map((f) => (f === 'site/index.html' ? '/' : `/${path.basename(f)}`));
const cfgFor = (names) => ({ ...DEFAULTS, srcDirs: ['site'], textExts: ['.html'], names });
const silent = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

const report = {
  date: new Date().toISOString().slice(0, 10),
  machine: { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.availableParallelism(), node: process.version, platform: `${os.platform()} ${os.arch()}` },
  site: { components: Number(args.components), pages: PAGES.length, elementsPerPage: Number(args['per-page']), classes: 0 },
};
// how many classes the site has: the ones a renaming renames (whichever sections run)
report.site.classes = transformTree(writeSite(temp('count'), FILES), cfgFor('min'), { moduleDir: repo }).map.size;

// --- size ---------------------------------------------------------------------------------------------------------------
if (only.has('size')) {
  const measure = (dir) => {
    const kinds = { css: [], html: [], js: [] };
    for (const f of Object.keys(FILES)) { const ext = path.extname(f).slice(1); if (kinds[ext]) kinds[ext].push(fs.readFileSync(path.join(dir, f))); }
    const out = {};
    let raw = 0; let brotli = 0; let gzip = 0;
    for (const [kind, list] of Object.entries(kinds)) {
      // every file is compressed on its own, the way a server sends it
      const r = list.reduce((n, b) => n + b.length, 0);
      const br = list.reduce((n, b) => n + zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length, 0);
      const gz = list.reduce((n, b) => n + zlib.gzipSync(b, { level: 9 }).length, 0);
      out[kind] = { raw: r, gzip: gz, brotli: br };
      raw += r; brotli += br; gzip += gz;
    }
    out.total = { raw, gzip, brotli };
    return out;
  };
  const rows = [];
  const plain = writeSite(temp('plain'), FILES);
  rows.push({ id: 'plain', label: 'As written', ...measure(plain) });
  for (const [names, label] of [['hash', 'Hashed names'], ['min', 'Minimal names']]) {
    const times = [];
    let dir; let r;
    for (let i = 0; i < 5; i++) {
      dir = writeSite(temp(names), FILES);
      const t = performance.now();
      r = transformTree(dir, cfgFor(names), { moduleDir: repo });
      times.push(performance.now() - t);
    }
    if (r.issues.length) throw new Error(`the generated site has things SquawkCode will not guess at: ${JSON.stringify(r.issues.slice(0, 3))}`);
    rows.push({ id: names, label, ...measure(dir), transformMs: Math.round(median(times)), averageNameLength: Number(([...r.map.values()].reduce((n, v) => n + v.length, 0) / r.map.size).toFixed(2)) });
  }
  report.size = rows;
  for (const row of rows) console.log(`${row.label.padEnd(16)} raw ${row.total.raw}  gzip ${row.total.gzip}  brotli ${row.total.brotli}${row.transformMs === undefined ? '' : `  transform ${row.transformMs} ms`}`);
}

// --- speed --------------------------------------------------------------------------------------------------------------
async function timed(a, b, cfg, rename) {
  const [sa, sb] = await Promise.all([serve(path.join(a, 'site')), serve(path.join(b, 'site'))]);
  try {
    const t = performance.now();
    const code = await silent(() => compareSites({ pages: PAGES, chrome: CHROME, ...cfg }, { a: sa.url, b: sb.url, rename }));
    return { seconds: Number(((performance.now() - t) / 1000).toFixed(1)), code };
  } finally { await Promise.all([sa.close(), sb.close()]); }
}
if (only.has('speed')) {
  if (!CHROME) throw new Error('the speed benchmark needs Chrome (SQUAWKCODE_CHROME)');
  const plain = writeSite(temp('plain'), FILES);
  const renamed = writeSite(temp('min'), FILES);
  // the renamed copy is told about the dark state in its own names, as the gate does
  const rename = renamer(transformTree(renamed, cfgFor('min'), { moduleDir: repo }).map, cfgFor('min'), repo);
  const views = PAGES.length * 2;
  // An earlier version, run as it was released, with its own defaults. It cannot be told how a copy is renamed, so it
  // gets the plain site on both sides: the same captures, and no difference to look at twice.
  let baseline = null;
  if (args.baseline) {
    const dir = path.resolve(args.baseline);
    const old = await import(pathToFileURL(path.join(dir, 'src/compare.mjs')).href);
    // Chrome does not start as root with its sandbox, and versions before 0.2 had no way to say so
    let chrome = CHROME;
    if (process.getuid?.() === 0 || process.env.CI) {
      chrome = path.join(temp('chrome'), 'chrome');
      fs.writeFileSync(chrome, `#!/bin/sh\nexec ${JSON.stringify(CHROME)} --no-sandbox "$@"\n`, { mode: 0o755 });
    }
    const [sa, sb] = await Promise.all([serve(path.join(plain, 'site')), serve(path.join(plain, 'site'))]);
    try {
      const t = performance.now();
      const code = await silent(() => old.compareSites({ pages: PAGES, chrome }, { a: sa.url, b: sb.url }));
      if (code !== 0) throw new Error('the baseline version finds a difference between two copies of one site');
      baseline = { version: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, seconds: Number(((performance.now() - t) / 1000).toFixed(1)) };
    } finally { await Promise.all([sa.close(), sb.close()]); }
  }
  // the captures 0.1 took (no keyboard-focus pass), one page at a time
  const same = await timed(plain, renamed, { concurrency: 1, focus: false }, rename);
  // the defaults: the focus pass too, and as many pages at once as the machine has processors for
  const now = await timed(plain, renamed, {}, rename);
  for (const r of [same, now]) if (r.code !== 0) throw new Error('the renamed site differs from the plain one: the benchmark has nothing to time');
  report.speed = { pageViews: views, baseline, sameCapturesOneAtATime: same.seconds, defaults: now.seconds, concurrency: Math.min(defaultConcurrency(), views) };
  console.log(`proof of ${views} page views: ${baseline ? `${baseline.seconds} s with ${baseline.version}, ` : ''}${same.seconds} s for the same captures now, ${now.seconds} s with the defaults (focus pass included)`);
}

// --- detect -------------------------------------------------------------------------------------------------------------
// One rule changed each time. `where` is where the change shows: at rest in the light state, or only in another state.
const B0 = FILES['site/styles.css'].match(/^\.([a-z][\w-]*) \{ padding:/m)[1]; // the first component
const MUTATIONS = [
  ['a card\'s padding, 1px more', 'at rest', (css) => css.replace(new RegExp(`\\.${B0} \\{ padding: (\\d+)px;`), (m, n) => `.${B0} { padding: ${Number(n) + 1}px;`)],
  ['the current link\'s weight', 'at rest', (css) => css.replace('.site-nav__link--current { font-weight: 600; }', '.site-nav__link--current { font-weight: 700; }')],
  ['an arrow glyph in a button', 'at rest', (css) => css.replace('::after { content: " →"; }', '::after { content: " ›"; }')],
  ['one column gap, 2px more', 'at rest', (css) => css.replace('grid-template-columns: repeat(3, 1fr); gap: 16px;', 'grid-template-columns: repeat(3, 1fr); gap: 18px;')],
  ['the mobile navigation wraps no more', 'at rest (mobile)', (css) => css.replace('.site-nav { flex-wrap: wrap; }', '.site-nav { flex-wrap: nowrap; }')],
  ['text colour, one step of 255', 'at rest, below what an eye sees', (css) => css.replace(':root { --bg: #ffffff; --fg: #15171a;', ':root { --bg: #ffffff; --fg: #15171b;')],
  ['line height 1.5 to 1.51', 'at rest, below a pixel per line', (css) => css.replace('font: 16px/1.5 system-ui', 'font: 16px/1.51 system-ui')],
  ['a link\'s hover background', 'hover', (css) => css.replace('.site-nav__link:hover { background: hsl(210 40% 92%); }', '.site-nav__link:hover { background: hsl(210 40% 86%); }')],
  ['a card\'s hover border', 'hover', (css) => css.replace(new RegExp(`\\.${B0}:hover \\{ border-color: hsl\\((\\d+) 60% 50%\\); \\}`), (m, h) => `.${B0}:hover { border-color: hsl(${h} 60% 40%); }`)],
  ['a button\'s hover background', 'hover', (css) => css.replace(new RegExp(`\\.${B0}__action:hover \\{ background: hsl\\((\\d+) 60% 34%\\); \\}`), (m, h) => `.${B0}__action:hover { background: hsl(${h} 60% 28%); }`)],
  ['a link\'s focus ring', 'keyboard focus', (css) => css.replace('.site-nav__link:focus-visible { outline: 2px solid', '.site-nav__link:focus-visible { outline: 4px solid')],
  ['a button\'s focus ring offset', 'keyboard focus', (css) => css.replace(new RegExp(`(\\.${B0}__action:focus-visible \\{ outline: 2px solid hsl\\(\\d+ 90% 60%\\); outline-offset: )2px`), '$14px')],
  ['the dark theme\'s background', 'dark theme (a class)', (css) => css.replace(':root.dark { --bg: #111317;', ':root.dark { --bg: #1b1e24;')],
  ['a featured card in the dark theme', 'dark theme (a class)', (css) => css.replace(new RegExp(`:root\\.dark \\.${B0}--featured \\{ background: hsl\\((\\d+) 30% 16%\\); \\}`), (m, h) => `:root.dark .${B0}--featured { background: hsl(${h} 30% 26%); }`)],
  ['a rule for a dark system setting', 'prefers-color-scheme: dark', (css) => css.replace('.site-nav { border-bottom-color: hsl(215 14% 34%); }', '.site-nav { border-bottom-color: hsl(215 14% 64%); }')],
  ['the navigation shows in print', 'print', (css) => css.replace('@media print { .site-nav { display: none; }', '@media print { .site-nav { display: flex; }')],
  ['the open dialog\'s padding', 'after a click', (css) => css.replace('.modal__box { background: var(--bg); padding: 24px;', '.modal__box { background: var(--bg); padding: 32px;')],
  ['the open dialog\'s backdrop', 'after a click', (css) => css.replace('background: rgb(0 0 0 / 0.4); }', 'background: rgb(0 0 0 / 0.6); }')],
  ['a button\'s cursor', 'nothing is painted', (css) => css.replace(new RegExp(`(\\.${B0}__action \\{[^}]*?)cursor: pointer;`), '$1cursor: default;')],
  ['a transition\'s duration', 'nothing is painted', (css) => css.replace(new RegExp(`(\\.${B0} \\{[^}]*?)transition: border-color 0\\.2s;`), '$1transition: border-color 0.6s;')],
];

if (only.has('detect')) {
  if (!CHROME) throw new Error('the detection benchmark needs Chrome (SQUAWKCODE_CHROME)');
  let pixelmatch; let PNG;
  try {
    pixelmatch = (await import(path.join(here, 'node_modules/pixelmatch/index.js'))).default;
    ({ PNG } = await import(path.join(here, 'node_modules/pngjs/lib/png.js')).then((m) => m.default ?? m));
  } catch {
    throw new Error('the detection benchmark compares screenshots with pixelmatch: run `npm install` in benchmarks/ first');
  }
  const VIEWPORTS = { desktop: [1440, 900, false], mobile: [390, 844, true] };
  // Screenshots the way a visual regression suite takes them: every page, both viewports, the whole page, as loaded.
  const chrome = await launchChrome(CHROME);
  const shots = async (base) => {
    const out = [];
    for (const page of PAGES) for (const vp of Object.values(VIEWPORTS)) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width: vp[0], height: vp[1], deviceScaleFactor: 1, mobile: vp[2] });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await chrome.send('Page.navigate', { url: base + page });
      for (let i = 0; i < 100; i++) { if (await chrome.evaluate('document.readyState') === 'complete') break; await sleep(30); }
      await chrome.evaluate('document.fonts.ready.then(() => true)');
      await sleep(150);
      const { data } = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      out.push(PNG.sync.read(Buffer.from(data, 'base64')));
    }
    return out;
  };
  const differ = (a, b) => {
    let pixels = 0;
    a.forEach((img, i) => {
      const other = b[i];
      if (img.width !== other.width || img.height !== other.height) { pixels += Math.abs(img.width * img.height - other.width * other.height) || 1; return; }
      pixels += pixelmatch(img.data, other.data, null, img.width, img.height, { threshold: 0.2 });
    });
    return pixels;
  };
  const plain = writeSite(temp('plain'), FILES);
  const media = { states: { light: '', dark: 'dark', 'system dark': { media: { 'prefers-color-scheme': 'dark' } }, print: { type: 'print' } }, actions: [{ name: 'dialog', eval: "document.querySelector('[data-open]').click()" }] };
  const rows = [];
  try {
    const sp = await serve(path.join(plain, 'site'));
    const reference = await shots(sp.url);
    // the same site twice must be equal for both methods, or neither result below means anything
    const again = await shots(sp.url);
    if (differ(reference, again) !== 0) throw new Error('two screenshots of the same site differ: the screenshot comparison is not stable on this machine');
    for (const [what, where, edit] of MUTATIONS) {
      const dir = writeSite(temp('mut'), FILES);
      const file = path.join(dir, 'site/styles.css');
      const css = fs.readFileSync(file, 'utf8');
      const next = edit(css);
      if (next === css) throw new Error(`the mutation "${what}" did not change the stylesheet`);
      fs.writeFileSync(file, next);
      const sm = await serve(path.join(dir, 'site'));
      try {
        const pixels = differ(reference, await shots(sm.url));
        const t = performance.now();
        const code = await silent(() => compareSites({ pages: PAGES, chrome: CHROME, ...media }, { a: sp.url, b: sm.url }));
        rows.push({ what, where, computedStyle: code === 1, screenshot: pixels > 0, pixels, seconds: Number(((performance.now() - t) / 1000).toFixed(1)) });
        console.log(`${code === 1 ? 'found ' : 'MISSED'}  ${pixels > 0 ? 'found ' : 'missed'}  ${what} (${where})`);
      } finally { await sm.close(); }
    }
    await sp.close();
  } finally { chrome.close(); }
  report.detect = { mutations: rows.length, computedStyle: rows.filter((r) => r.computedStyle).length, screenshot: rows.filter((r) => r.screenshot).length, rows };
  console.log(`computed styles found ${report.detect.computedStyle} of ${rows.length}, screenshots ${report.detect.screenshot} of ${rows.length}`);
}

if (args.json) {
  const file = path.resolve(args.json);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // keep the sections that were not run this time
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, `${JSON.stringify({ ...before, ...report }, null, 2)}\n`);
}
