// The comparison in a real Chrome, on the generated site: a renamed copy must show no difference, and a copy with one
// changed rule must show that difference in the state where it applies. Skipped when no Chrome is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareSites } from '../src/compare.mjs';
import { renamer, transformTree } from '../src/transform.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { generateSite, writeSite } from '../benchmarks/site.mjs';
import { serve } from '../benchmarks/serve.mjs';

const HERE = path.resolve(import.meta.dirname, '..');
const CHROME = [process.env.SQUAWKCODE_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find((p) => fs.existsSync(p));
const skip = CHROME ? false : 'no Chrome found (set SQUAWKCODE_CHROME)';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
const quiet = async (fn) => {
  const log = console.log; const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { return { code: await fn(), lines }; } finally { console.log = log; }
};
const FILES = generateSite({ components: 16, pages: 2, perPage: 14 });
const PAGES = ['/', '/page-2.html'];

/** Serve two trees, compare them, return the exit code and the report. */
async function compare(a, b, cfg = {}, rename = undefined) {
  const [sa, sb] = await Promise.all([serve(path.join(a, 'site')), serve(path.join(b, 'site'))]);
  const out = path.join(temp(), 'report.json');
  try {
    const { code, lines } = await quiet(() => compareSites({ pages: PAGES, chrome: CHROME, ...cfg }, { a: sa.url, b: sb.url, out, rename }));
    return { code, lines, report: JSON.parse(fs.readFileSync(out, 'utf8')), hits: sa.hits };
  } finally { await Promise.all([sa.close(), sb.close()]); }
}
const changed = (edit) => {
  const dir = writeSite(temp(), FILES);
  const file = path.join(dir, 'site/styles.css');
  const before = fs.readFileSync(file, 'utf8');
  const after = edit(before);
  assert.notEqual(after, before, 'the mutation changed the stylesheet');
  fs.writeFileSync(file, after);
  return dir;
};
// the kinds of capture a report names: a state's name, or hover, focus, action
const states = (report) => new Set(report.map((r) => r.key.split('|')[2].replace(/:.*$/, '')));
// the second look at a page that differed waits a fixed time: short here, the pages are static
const FAST = { carefulSettleMs: 600 };
const DESKTOP = { viewports: { desktop: [1280, 800, false] } };

test('a renamed copy shows no difference: hashed names and minimal names', { skip }, async () => {
  const plain = writeSite(temp(), FILES);
  for (const names of ['hash', 'min']) {
    const renamed = writeSite(temp(), FILES);
    const cfg = { ...DEFAULTS, srcDirs: ['site'], textExts: ['.html'], names };
    const r = transformTree(renamed, cfg, { moduleDir: HERE });
    assert.deepEqual(r.issues, []);
    assert.ok(r.map.size > 60);
    assert.ok(r.map.has('dark') && r.map.has('modal--open'), 'the theme class and the class a script toggles are renamed like any other');
    assert.ok(!fs.readFileSync(path.join(renamed, 'site/index.html'), 'utf8').includes('site-nav__link'));
    // an action that names classes, and a hover pass picked by class: written for the site as it was
    const compareCfg = { actions: [{ name: 'modal', eval: "document.querySelector('.modal').classList.add('modal--open')" }], hover: { selector: '.site-nav__link, button', max: 12 } };
    const { code, report, lines } = await compare(plain, renamed, compareCfg, renamer(r.map, cfg, HERE));
    assert.deepEqual(report, [], `${names}: ${JSON.stringify(report).slice(0, 600)}`);
    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.includes('no differences')));
    if (names === 'min') {
      // without being told how B is renamed, the dark state never reaches B and the action finds nothing there: both are reported
      const blind = await compare(plain, renamed, { ...compareCfg, ...FAST, ...DESKTOP, pages: ['/'] });
      assert.equal(blind.code, 1);
      assert.ok(states(blind.report).has('dark') && states(blind.report).has('action'));
    }
  }
});

test('a script of the compare configuration that builds a class name cannot be rewritten, and says so', { skip }, async () => {
  const plain = writeSite(temp(), FILES);
  const renamed = writeSite(temp(), FILES);
  const cfg = { ...DEFAULTS, srcDirs: ['site'], textExts: ['.html'] };
  const r = transformTree(renamed, cfg, { moduleDir: HERE });
  const rename = renamer(r.map, cfg, HERE);
  assert.equal(rename.classes('dark other'), `${r.map.get('dark')} other`);
  assert.equal(rename.selector('.modal > .modal__box, #x'), `.${r.map.get('modal')} > .${r.map.get('modal__box')}, #x`);
  await assert.rejects(compare(plain, renamed, { actions: [{ name: 'bad', eval: 'document.body.className = `modal--${state}`' }] }, rename), /cannot be rewritten for the renamed copy/);
});

test('one changed rule is found in the state where it applies', { skip }, async () => {
  const plain = writeSite(temp(), FILES);
  const cases = [
    // [what changed, the edit, the state that must report it, states that must not]
    ['a resting colour', (css) => css.replace('.site-nav__link { color: var(--fg);', '.site-nav__link { color: #15171b;'), 'light', []],
    ['a hover background', (css) => css.replace('.site-nav__link:hover { background: hsl(210 40% 92%); }', '.site-nav__link:hover { background: hsl(210 40% 91%); }'), 'hover', ['light', 'dark']],
    ['a focus ring', (css) => css.replace('.site-nav__link:focus-visible { outline: 2px solid', '.site-nav__link:focus-visible { outline: 3px solid'), 'focus', ['light', 'dark', 'hover']],
    ['a dark-mode value', (css) => css.replace(':root.dark { --bg: #111317;', ':root.dark { --bg: #111318;'), 'dark', ['light']],
    // a rule for a class a script adds: at rest no element has it
    ['what the open modal looks like', (css) => css.replace('.modal--open { display: flex; }', '.modal--open { display: flex; padding: 3px; }'), 'action', ['light', 'dark', 'hover', 'focus']],
  ];
  for (const [what, edit, where, nowhere] of cases) {
    const { code, report } = await compare(plain, changed(edit), { ...FAST, ...DESKTOP, pages: ['/'], actions: [{ name: 'modal', eval: "document.querySelector('[data-open]').click()" }] });
    assert.equal(code, 1, what);
    const found = states(report);
    assert.ok(found.has(where), `${what}: reported in ${[...found].join(', ')}, expected ${where}`);
    for (const other of nowhere) assert.ok(!found.has(other), `${what}: also reported in ${other}`);
  }
});

test('media features are states too: a rule for prefers-color-scheme or print is only seen when that state is captured', { skip }, async () => {
  const plain = writeSite(temp(), FILES);
  const scheme = changed((css) => css.replace('.site-nav { border-bottom-color: hsl(215 14% 34%); }', '.site-nav { border-bottom-color: hsl(215 14% 35%); }'));
  const print = changed((css) => css.replace('@media print { .site-nav { display: none; }', '@media print { .site-nav { display: block; }'));
  const base = { ...FAST, ...DESKTOP, pages: ['/'], hover: { max: 0 }, focus: false };
  assert.equal((await compare(plain, scheme, base)).code, 0, 'the default states (html classes) do not reach a media query');
  const withMedia = { ...base, states: { light: '', 'system dark': { media: { 'prefers-color-scheme': 'dark' } }, print: { type: 'print' } } };
  const a = await compare(plain, scheme, withMedia);
  assert.equal(a.code, 1);
  assert.deepEqual([...states(a.report)], ['system dark']);
  const b = await compare(plain, print, withMedia);
  assert.equal(b.code, 1);
  assert.deepEqual([...states(b.report)], ['print']);
});

test('elements inside an open shadow root are compared', { skip }, async () => {
  const withShadow = (colour) => {
    const dir = writeSite(temp(), FILES);
    fs.appendFileSync(path.join(dir, 'site/app.js'), `\nconst host = document.createElement('div'); document.querySelector('.page').append(host); host.attachShadow({ mode: 'open' }).innerHTML = '<style>p { color: ${colour}; }</style><p>in the shadow</p>';\n`);
    return dir;
  };
  const base = { ...FAST, ...DESKTOP, pages: ['/'], states: { light: '' }, hover: { max: 0 }, focus: false };
  assert.equal((await compare(withShadow('rgb(10, 20, 30)'), withShadow('rgb(10, 20, 30)'), base)).code, 0);
  const differs = await compare(withShadow('rgb(10, 20, 30)'), withShadow('rgb(10, 20, 31)'), base);
  assert.equal(differs.code, 1);
  assert.match(JSON.stringify(differs.report), /color: rgb\(10, 20, 30\) → rgb\(10, 20, 31\)/);
});

test('a page that finishes after load is captured once it is quiet; a slow side is waited for', { skip }, async () => {
  const late = () => {
    const dir = writeSite(temp(), FILES);
    // content that arrives after a request, well after the load event
    fs.writeFileSync(path.join(dir, 'site/late.json'), '{"text":"late"}');
    fs.appendFileSync(path.join(dir, 'site/app.js'), `\nsetTimeout(() => fetch('/late.json').then((r) => r.json()).then((d) => { const p = document.createElement('p'); p.className = 'late'; p.textContent = d.text; document.querySelector('.page').prepend(p); }), 250);\n`);
    return dir;
  };
  const [a, b] = [late(), late()];
  const [sa, sb] = await Promise.all([serve(path.join(a, 'site')), serve(path.join(b, 'site'), 0, { delayMs: 120 })]);
  const out = path.join(temp(), 'report.json');
  try {
    const started = Date.now();
    const { code, lines } = await quiet(() => compareSites({ pages: ['/'], chrome: CHROME, viewports: { desktop: [1280, 800, false] }, states: { light: '' }, hover: { max: 0 }, focus: false }, { a: sa.url, b: sb.url, out }));
    assert.equal(code, 0, lines.join('\n'));
    assert.ok(Date.now() - started < 9000, 'no fixed wait of seconds per navigation');
  } finally { await Promise.all([sa.close(), sb.close()]); }
});

test('pages are compared several at a time with the same result', { skip }, async () => {
  const plain = writeSite(temp(), FILES);
  const other = changed((css) => css.replace('.page__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }', '.page__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }'));
  const base = { ...FAST, hover: { max: 0 }, focus: false };
  const one = await compare(plain, other, { ...base, concurrency: 1 });
  const two = await compare(plain, other, { ...base, concurrency: 2 });
  assert.equal(one.code, 1);
  assert.deepEqual(two.report, one.report);
  assert.ok(two.lines.some((l) => /2 at a time/.test(l)) && one.lines.some((l) => /1 at a time/.test(l)));
  assert.equal(one.report.length, 8, 'both pages, both viewports (one column still has gaps between rows), both states');
});

test('the states, the focus pass and the hover pass share one page load; a page that a pass changed is loaded again', { skip }, async () => {
  const plain = writeSite(temp(), FILES);
  const action = { actions: [{ name: 'modal', eval: "document.querySelector('[data-open]').click()" }] };
  const still = await compare(plain, plain, { ...DESKTOP, pages: ['/'], ...action });
  assert.equal(still.code, 0);
  assert.equal(still.hits.get('/'), 2, 'side A was asked for the page twice: once for the three passes, once for the action');
  // a page whose script answers the keyboard focus: after the focus pass its document is not the one that settled
  const reacting = writeSite(temp(), FILES);
  fs.appendFileSync(path.join(reacting, 'site/app.js'), "\ndocument.addEventListener('focusin', (event) => { document.body.dataset.focused = event.target.className; });\n");
  const moved = await compare(reacting, reacting, { ...DESKTOP, pages: ['/'], ...action });
  assert.equal(moved.code, 0);
  assert.equal(moved.hits.get('/'), 3, 'states and focus share a page, the hover pass gets a new one, and so does the action');
});

test('the keyboard focus pass starts where a visitor\'s Tab starts, also on a page the hover pass scrolls far down', { skip }, async () => {
  // a page of several screens: the hover pass ends at its last button, and Tab on that page would go on from there
  const tall = generateSite({ components: 30, pages: 1, perPage: 60 });
  const plain = writeSite(temp(), tall);
  const ring = writeSite(temp(), tall);
  const file = path.join(ring, 'site/styles.css');
  const css = fs.readFileSync(file, 'utf8');
  assert.ok(css.includes('.site-nav__link:focus-visible { outline: 2px solid'));
  fs.writeFileSync(file, css.replace('.site-nav__link:focus-visible { outline: 2px solid', '.site-nav__link:focus-visible { outline: 3px solid'));
  const { code, report } = await compare(plain, ring, { ...FAST, ...DESKTOP, pages: ['/'], focus: { max: 3 } });
  assert.equal(code, 1);
  assert.deepEqual(report.map((r) => r.key), ['/|desktop|focus:0'], 'the one link of the navigation is the first element the keyboard reaches');
  assert.match(report[0].diffs[0].detail, /outline-width: 2px → 3px/);
  assert.match(report[0].diffs[0].where, /^a\.site-nav__link/);
  // and on the small site, where the navigation has two links
  const small = await compare(writeSite(temp(), FILES), changed((sheet) => sheet.replace('.site-nav__link:focus-visible { outline: 2px solid', '.site-nav__link:focus-visible { outline: 3px solid')), { ...FAST, ...DESKTOP, pages: ['/'], focus: { max: 3 } });
  assert.deepEqual(small.report.map((r) => r.key), ['/|desktop|focus:0', '/|desktop|focus:1']);
});
