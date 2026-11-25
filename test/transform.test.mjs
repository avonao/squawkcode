import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transformTree } from '../src/transform.mjs';
import { mapSelector } from '../src/selector.mjs';
import { DEFAULTS } from '../src/config.mjs';

// Where postcss and typescript are resolved from in tests: this repository's dev dependencies, or the project that SQUAWKCODE_TEST_PROJECT names.
const WEB = process.env.SQUAWKCODE_TEST_PROJECT ?? path.resolve(import.meta.dirname, '..');

function site(files, cfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); }
  const r = transformTree(root, { ...DEFAULTS, srcDirs: ['src'], ...cfg }, { moduleDir: WEB });
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  return { r, read };
}

test('mapSelector renames classes but not attributes, strings or numbers', () => {
  const out = mapSelector('.a:is(.b, .c) > [data-x=".d"]::before:not(.e):nth-child(2n+1)', (n) => n.toUpperCase());
  assert.equal(out, '.A:is(.B, .C) > [data-x=".d"]::before:not(.E):nth-child(2n+1)');
});

test('css and tsx are rewritten with one map', () => {
  const { r, read } = site({
    'src/a.css': '.card { color: red } .card:hover .title, .x > .card { color: blue } @media (min-width:1px) { .title { margin: 0 } }',
    'src/a.tsx': 'export const A = () => <div className="card title extra">{cond ? <p className={`card ${cls}`} /> : null}</div>;',
  });
  const m = r.map;
  assert.ok(m.has('card') && m.has('title') && m.has('x'));
  assert.ok(!m.has('extra'));
  assert.match(read('src/a.css'), new RegExp(`\\.${m.get('card')} \\{ color: red \\}`));
  assert.match(read('src/a.tsx'), new RegExp(`className="${m.get('card')} ${m.get('title')} extra"`));
  assert.match(read('src/a.tsx'), new RegExp('`' + m.get('card') + ' \\$\\{cls\\}`'));
  assert.equal(r.issues.length, 0);
});

test('classList, querySelector and clsx are class contexts; comparisons are not', () => {
  const { r, read } = site({
    'src/a.css': '.open { x: 1 } .item { y: 1 } .on { z: 1 }',
    'src/a.ts': 'el.classList.toggle("open"); const n = document.querySelector(".item.on"); const c = clsx("item", { on: flag }); if (state === "open") {}',
  }, { ambiguous: {} });
  const m = r.map; const out = read('src/a.ts');
  assert.ok(out.includes(`classList.toggle("${m.get('open')}")`));
  assert.ok(out.includes(`querySelector(".${m.get('item')}.${m.get('on')}")`));
  assert.ok(out.includes(`clsx("${m.get('item')}", { "${m.get('on')}": flag })`));
  assert.ok(out.includes('state === "open"'), 'a comparison string stays');
  // the bare "open" in the comparison is state, not a class: not even reported, because it is compared
  assert.equal(r.issues.length, 0);
});

test('a bare string that equals a class name fails closed until resolved', () => {
  const files = { 'src/a.css': '.open { x: 1 }', 'src/a.ts': 'const mode = "open"; use(mode);' };
  const first = site(files);
  assert.equal(first.r.issues.length, 1);
  assert.equal(first.r.issues[0].kind, 'ambiguous-string');
  const second = site(files, { ambiguous: { open: 'keep' } });
  assert.equal(second.r.issues.length, 0);
  assert.ok(second.read('src/a.ts').includes('"open"'));
});

test('a half-built class name fails closed unless its family is kept', () => {
  const files = { 'src/a.css': '.slide-1 { a: 1 } .slide-2 { a: 2 }', 'src/a.tsx': 'const A = ({n}) => <i className={`slide-${n}`} />;' };
  assert.equal(site(files).r.issues.some((i) => i.kind === 'dynamic-class'), true);
  const ok = site(files, { keepPrefixes: ['slide-'] });
  assert.equal(ok.r.issues.length, 0);
  assert.ok(ok.read('src/a.css').includes('.slide-1'));
});

test('classes also defined outside the source dir, or used there as strings, are kept', () => {
  const { r, read } = site({
    'src/a.css': '.btn { a: 1 } .mine { a: 1 } .shared { a: 1 }',
    'globals.css': '.btn { b: 1 }',
    'app/page.tsx': 'export default () => <div className="shared" />;',
    'src/a.tsx': '<div className="btn mine shared" />',
  });
  assert.ok(r.keep.get('btn').includes('globals.css'));
  assert.ok(r.keep.get('shared').includes('app/page.tsx'));
  assert.ok(r.map.has('mine'));
  assert.ok(read('src/a.tsx').includes(`className="btn ${r.map.get('mine')} shared"`));
});

test('class-attribute selectors and html strings', () => {
  const { r, read } = site({
    'src/a.css': '.a { x:1 } [class^="c-"] { y: 1 }',
    'src/a.ts': 'export const html = "<p class=\\"a b\\">x</p>";',
  });
  assert.ok(r.issues.some((i) => i.kind === 'class-attribute-selector'));
  assert.ok(read('src/a.ts').includes(`class=\\"${r.map.get('a')} b\\"`));
});

test('hashes are deterministic and valid identifiers', () => {
  const a = site({ 'src/a.css': '.foo { a:1 } .bar { a:1 }' }, { names: 'hash' }).r.map;
  const b = site({ 'src/a.css': '.foo { a:1 } .bar { a:1 }' }, { names: 'hash' }).r.map;
  assert.deepEqual([...a], [...b]);
  for (const v of a.values()) assert.match(v, /^[a-z][a-z0-9]+$/);
});

test('what is assigned to className or set as the class attribute is a class list', () => {
  const { r, read } = site({
    'src/a.css': '.card { a: 1 } .open { b: 1 } .wide { c: 1 }',
    'src/a.js': 'el.className = "card open"; el.className += " wide"; el.setAttribute("class", "card"); el.classList.value = "open"; h("div", { className: "card wide", title: "plain words" });',
  });
  const m = r.map; const out = read('src/a.js');
  assert.deepEqual(r.issues, []);
  assert.ok(out.includes(`el.className = "${m.get('card')} ${m.get('open')}"`));
  assert.ok(out.includes(`el.className += " ${m.get('wide')}"`));
  assert.ok(out.includes(`el.setAttribute("class", "${m.get('card')}")`));
  assert.ok(out.includes(`el.classList.value = "${m.get('open')}"`));
  assert.ok(out.includes(`{ className: "${m.get('card')} ${m.get('wide')}", title: "plain words" }`));
});

test('a name next to an expression is whole when the expression starts with a space or is empty, and a piece of a name otherwise', () => {
  const css = '.card { a: 1 } .card--wide { b: 1 } .open { c: 1 } .slide-1 { d: 1 } .card__title { e: 1 }';
  const whole = site({
    'src/a.css': css,
    'src/a.tsx': 'export const A = ({ wide, cls }) => <i className={"card" + (wide ? " card--wide" : "")}><b className={`card${wide ? " card--wide" : ""} open`} /><u className={"card " + cls + " open"} /></i>;',
  });
  const m = whole.r.map; const out = whole.read('src/a.tsx');
  assert.deepEqual(whole.r.issues, []);
  assert.ok(out.includes(`className={"${m.get('card')}" + (wide ? " ${m.get('card--wide')}" : "")}`));
  assert.ok(out.includes('className={`' + m.get('card') + '${wide ? " ' + m.get('card--wide') + '" : ""} ' + m.get('open') + '`}'));
  assert.ok(out.includes(`className={"${m.get('card')} " + cls + " ${m.get('open')}"}`));
  // pieces: reported, and left as they were written
  const pieces = [
    ['el.className = `card--${size}`;', '"card--"'],
    ['el.classList.add("slide-" + n);', '"slide-"'],
    ['const A = ({ b }) => <i className={`${b}__title`} />;', '"__title"'],
    ['const A = ({ cls }) => <i className={"card" + cls} />;', '"card"'],
  ];
  for (const [code, piece] of pieces) {
    const { r, read } = site({ 'src/a.css': css, 'src/a.tsx': code });
    assert.equal(r.issues.length, 1, code);
    assert.equal(r.issues[0].kind, 'dynamic-class');
    assert.ok(r.issues[0].detail.startsWith(piece), r.issues[0].detail);
    assert.equal(read('src/a.tsx'), code);
  }
  // a piece that no renamed class starts or ends with is somebody else's name
  assert.deepEqual(site({ 'src/a.css': css, 'src/a.tsx': 'const A = ({ n }) => <i className={`icon-${n} card`} />;' }).r.issues, []);
});
