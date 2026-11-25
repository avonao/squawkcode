import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { assignMinNames, sequenceName } from '../src/names.mjs';
import { loadFrom } from '../src/modules.mjs';
import { previousMap, transformTree } from '../src/transform.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { generateSite, writeSite } from '../benchmarks/site.mjs';

const HERE = path.resolve(import.meta.dirname, '..');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));

test('sequenceName: the shortest names first, every one a CSS identifier', () => {
  assert.deepEqual([0, 1, 51, 52, 53].map((n) => sequenceName(n)), ['a', 'b', 'Z', 'aa', 'ab']);
  assert.equal(sequenceName(52 + 52 * 64), 'aaa');
  assert.deepEqual([0, 63, 64].map((n) => sequenceName(n, '_')), ['_a', '_-', '_aa']);
  const seen = new Set();
  for (let n = 0; n < 5000; n++) {
    const name = sequenceName(n);
    assert.match(name, /^[A-Za-z][\w-]*$/);
    assert.ok(!seen.has(name));
    seen.add(name);
  }
});

test('assignMinNames: the most written class gets the shortest name; taken names are skipped; old names stay', () => {
  const counts = new Map([['card', 40], ['card__title', 40], ['btn', 90], ['rare', 1]]);
  const first = assignMinNames(counts, { taken: new Set(['a']) });
  assert.equal(first.get('btn'), 'b', 'a is taken');
  assert.deepEqual([first.get('card'), first.get('card__title')], ['c', 'd'], 'ties go by name');
  assert.equal(first.get('rare'), 'e');
  // the next deploy: one class is gone, one is new and written most; nothing that existed is renamed
  const next = assignMinNames(new Map([['card', 40], ['btn', 90], ['hero', 500]]), { taken: new Set(['a']), previous: Object.fromEntries(first) });
  assert.equal(next.get('btn'), 'b');
  assert.equal(next.get('card'), 'c');
  assert.equal(next.get('hero'), 'd', 'the shortest name that is free');
  assert.throws(() => assignMinNames(counts, { prefix: '1x' }), /not the start of a CSS identifier/);
  assert.equal(assignMinNames(counts, { prefix: '_' }).get('btn'), '_a');
  // a name that would look like a member of a kept family is passed over
  assert.equal(assignMinNames(counts, { avoid: (name) => name.startsWith('a') }).get('btn'), 'b');
});

test('names "min": the whole site is renamed to names that are shorter and collide with nothing that stays', () => {
  const dir = writeSite(temp(), generateSite({ components: 30, pages: 2, perPage: 20 }));
  fs.writeFileSync(path.join(dir, 'vendor.css'), '.a { color: red } .b { color: blue } .page { margin: 0 }');
  const sizes = () => { const b = Buffer.concat(['site/styles.css', 'site/index.html', 'site/page-2.html', 'site/app.js'].map((f) => fs.readFileSync(path.join(dir, f)))); return { raw: b.length, brotli: zlib.brotliCompressSync(b).length }; };
  const before = sizes();
  const cfg = { ...DEFAULTS, srcDirs: ['site'], textExts: ['.html'], names: 'min', keep: ['is-hidden'] };
  const r = transformTree(dir, cfg, { moduleDir: HERE });
  assert.deepEqual(r.issues, []);
  assert.ok(r.map.size > 100);
  const names = [...r.map.values()];
  assert.equal(new Set(names).size, names.length, 'no two classes share a name');
  for (const name of names) {
    assert.match(name, /^[A-Za-z][\w-]*$/);
    assert.ok(!['a', 'b', 'page', 'is-hidden'].includes(name), `${name} is a name that stays in use`);
    assert.ok(!r.map.has(name), `${name} is the old name of another class`);
  }
  assert.ok(r.keep.get('page').includes('vendor.css'), 'a class another stylesheet also defines keeps its name');
  assert.ok(names.filter((n) => n.length === 1).length >= 40, 'the one-letter names are used');
  const css = fs.readFileSync(path.join(dir, 'site/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
  const after = sizes();
  assert.ok(after.raw < before.raw * 0.9, `smaller as written (${after.raw} of ${before.raw} bytes)`);
  assert.ok(after.brotli < before.brotli * 0.95, `and smaller compressed, where a hashed name is not (${after.brotli} of ${before.brotli} bytes)`);
  // every class the markup and the script name is one the stylesheet defines (or one that was kept)
  const definedNow = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
  for (const m of html.matchAll(/class="([^"]*)"/g)) for (const cls of m[1].split(/\s+/).filter(Boolean)) assert.ok(definedNow.has(cls), `${cls} has a rule`);
  const js = fs.readFileSync(path.join(dir, 'site/app.js'), 'utf8');
  assert.ok(!js.includes('modal--open') && !js.includes("'.modal'"), 'classList and closest() arguments are renamed');
  // the most written class has a one-letter name
  const counts = new Map();
  for (const m of html.matchAll(/class="([^"]*)"/g)) for (const cls of m[1].split(/\s+/)) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  const top = [...counts].sort((x, y) => y[1] - x[1])[0][0];
  assert.equal(top.length, 1);
});

test('names "min": a saved map keeps every name between runs, and hashed names need none', () => {
  const files = generateSite({ components: 12, pages: 1, perPage: 10 });
  const one = writeSite(temp(), files);
  const cfg = { ...DEFAULTS, srcDirs: ['site'], textExts: ['.html'], names: 'min' };
  const first = transformTree(one, cfg, { moduleDir: HERE });
  // the project keeps the map; the site gains a component that is written more than anything else
  const project = writeSite(temp(), files);
  fs.writeFileSync(path.join(project, cfg.mapFile), JSON.stringify({ names: 'min', map: Object.fromEntries(first.map) }));
  fs.appendFileSync(path.join(project, 'site/styles.css'), '\n.hero { margin: 0 } .hero__lead { margin: 0 }\n');
  fs.appendFileSync(path.join(project, 'site/index.html'), '<p class="hero hero__lead"></p>'.repeat(200));
  const previous = previousMap(project, cfg);
  assert.equal(Object.keys(previous).length, first.map.size);
  const second = transformTree(project, cfg, { moduleDir: HERE, previous });
  for (const [name, renamed] of first.map) assert.equal(second.map.get(name), renamed, `${name} keeps its name`);
  assert.ok(second.map.has('hero') && ![...first.map.values()].includes(second.map.get('hero')));
  // a map of hashed names is not a source of minimal names, and hashed runs read no map
  fs.writeFileSync(path.join(project, cfg.mapFile), JSON.stringify({ names: 'hash', map: { card: 'h12345' } }));
  assert.deepEqual(previousMap(project, cfg), {});
  assert.deepEqual(previousMap(project, { ...cfg, names: 'hash' }), {});
  assert.throws(() => previousMap(project, { ...cfg, namesFrom: 'missing.json' }), /does not exist/);
  assert.throws(() => transformTree(project, { ...cfg, names: 'short' }, { moduleDir: HERE }), /"hash" or "min"/);
});

test('a project whose TypeScript has no parser (TypeScript 7), or none at all, is parsed with SquawkCode\'s own', () => {
  const project = temp();
  fs.mkdirSync(path.join(project, 'node_modules/typescript'), { recursive: true });
  fs.writeFileSync(path.join(project, 'node_modules/typescript/package.json'), JSON.stringify({ name: 'typescript', version: '7.0.2', main: 'index.js' }));
  fs.writeFileSync(path.join(project, 'node_modules/typescript/index.js'), 'module.exports = { version: "7.0.2", versionMajorMinor: "7.0" };');
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  const ts = loadFrom(project, 'typescript');
  assert.equal(typeof ts.createSourceFile, 'function');
  assert.notEqual(ts.version, '7.0.2');
  assert.equal(typeof loadFrom(temp(), 'postcss').parse, 'function', 'a project without postcss');
  // and the transform works there
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src/a.css'), '.box { margin: 0 }');
  fs.writeFileSync(path.join(project, 'src/a.tsx'), 'export const A = () => <div className="box" />;');
  const r = transformTree(project, { ...DEFAULTS, srcDirs: ['src'], names: 'hash' }, { moduleDir: project });
  assert.deepEqual(r.issues, []);
  assert.ok(fs.readFileSync(path.join(project, 'src/a.tsx'), 'utf8').includes(`className="${r.map.get('box')}"`));
});

test('a source file that names no renamed class is not parsed, and one that builds a name from a renamed family still is', () => {
  const dir = temp();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.css'), '.slide-1 { margin: 0 } .slide-2 { margin: 0 }');
  fs.writeFileSync(path.join(dir, 'src/broken.ts'), 'this is not ( valid typescript');
  fs.writeFileSync(path.join(dir, 'src/dynamic.tsx'), 'export const A = ({ n }) => <i className={`slide-${n}`} />;');
  const r = transformTree(dir, { ...DEFAULTS, srcDirs: ['src'] }, { moduleDir: HERE });
  assert.equal(r.issues.length, 1, 'only the half-built class name is reported');
  assert.equal(r.issues[0].kind, 'dynamic-class');
  assert.equal(fs.readFileSync(path.join(dir, 'src/broken.ts'), 'utf8'), 'this is not ( valid typescript');
});
