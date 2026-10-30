import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, sleep } from './cdp.mjs';
import { sameUpToColours } from './colour.mjs';

const DEFAULTS = {
  pages: ['/'],
  viewports: { desktop: [1440, 900, false], mobile: [390, 844, true] },
  states: { light: '', dark: 'dark' },         // html classes added for the capture
  actions: [],                                  // [{ name, eval }]: run in the page, then capture the whole document ("light" state)
  hover: { max: 30, perElement: 40, viewports: null, selector: null }, // hover up to `max` links/buttons per page and compare them and their first descendants
                                                // (viewports: names to hover at; null = every viewport except "mobile";
                                                // selector: which elements to hover, null = links, buttons and fields)
  colourTolerance: 0.02,                        // ΔE (CIE76, lab) under which two colours count as equal: rgb(169, 169, 169) = lab(69.2378 0 0)
  ignoreProps: ['^--', '^-webkit-text-fill', 'perspective-origin', 'transform-origin'], // regex on property names
  scrollThrough: true,
  reducedMotion: true,
  settleMs: 2500,
  readyWhen: null,                              // expression evaluated in the page after it settles; capture waits until it is true
                                                // (e.g. an iframe's ready class), at most readyTimeoutMs
  readyTimeoutMs: 20000,
  beforeCapture: null,                          // expression evaluated before every capture, to pin what changes on a timer
                                                // (e.g. reset a carousel that advances every few seconds)
  retries: 1,                                   // pages with differences are captured again and only persistent ones count
  maxReport: 15,
  chrome: null,
};

// A whole page's computed styles are tens of megabytes (2,600 elements × 760 properties), too much to move over CDP
// for every state. The page sends one hash per element (and per pseudo-element) of its values, with the ignored
// properties left out and its own origin written as H; `detail` lists the elements whose values it also sends, which
// compareSites asks for once hashes have differed. `props` is the property list both browsers share (compareSites).
export const collect = (ignore, detail, props) => `(() => {
  const ignore = ${JSON.stringify(ignore)}.map((r) => new RegExp(r));
  const want = new Set(${JSON.stringify(detail ?? [])});
  const props = (${JSON.stringify(props ?? null)} ?? [...getComputedStyle(document.documentElement)]).filter((p) => !ignore.some((r) => r.test(p))).sort();
  const skip = new Set(['SCRIPT','STYLE','LINK','META','TITLE','HEAD','NOSCRIPT']);
  const els = [...document.querySelectorAll('*')].filter(e => !skip.has(e.tagName));
  const host = location.origin;
  const read = (cs) => props.map((k) => cs.getPropertyValue(k)).join('|').split(host).join('H');
  const h53 = (str) => {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  const row = (e, i) => {
    const v = read(getComputedStyle(e));
    const r = { t: e.tagName, p: e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0,3).join('.') : ''), h: h53(v) };
    if (want.has(i)) r.v = v;
    // Pseudo-elements: ::before/::after when they render, and the ones a reset styles where the element has them.
    const pseudos = ['::before', '::after'];
    if ((e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && e.hasAttribute('placeholder')) pseudos.push('::placeholder');
    if (e.tagName === 'INPUT' && e.type === 'file') pseudos.push('::file-selector-button');
    if (e.tagName === 'DIALOG' && e.open) pseudos.push('::backdrop');
    if (getComputedStyle(e).display === 'list-item') pseudos.push('::marker');
    for (const ps of pseudos) {
      const c = getComputedStyle(e, ps);
      if ((ps === '::before' || ps === '::after') && (!c.content || c.content === 'none' || c.content === 'normal')) continue;
      const pv = read(c);
      r[ps + '#'] = h53(pv);
      if (want.has(i)) r[ps] = pv;
    }
    return r;
  };
  return { props, rows: els.map(row) };
})()`;

const HOVER_SELECTOR = 'a[href], button, summary, [role="button"], input, select';
const hoverTargets = (sel) => `(() => [...document.querySelectorAll(${JSON.stringify(sel)})]
  .filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; }))`;
const HOVER_TARGETS = hoverTargets(HOVER_SELECTOR);

async function gotoReady(c, url, cfg) {
  await c.send('Page.navigate', { url });
  await sleep(cfg.settleMs);
  for (let i = 0; i < 30; i++) { if (await c.evaluate('document.readyState') === 'complete') break; await sleep(250); }
}

// A page that finishes after load (an iframe, a client fetch) is captured once it says so; the two sides can be far
// apart in time when one server is busier. Called after the scroll pass, which is what starts lazy iframes.
async function waitReady(c, cfg) {
  if (!cfg.readyWhen) return;
  for (const end = Date.now() + cfg.readyTimeoutMs; Date.now() < end; await sleep(250)) {
    if (await c.evaluate(`!!(${cfg.readyWhen})`)) return;
  }
}
// After the classes change, transitions are cancelled frame by frame until none is left: Chrome updates some elements'
// style late (off-screen slides, content-visibility), so their transitions start after a single cancel and a capture
// would catch them half way.
const setState = (c, cls) => c.evaluate(`(async()=>{const l=document.documentElement.classList; for (const k of ${JSON.stringify(Object.values(ALLSTATE))}) k.split(' ').filter(Boolean).forEach(x=>l.remove(x)); '${cls}'.split(' ').filter(Boolean).forEach(x=>l.add(x)); document.getAnimations().forEach(a=>{try{a.cancel()}catch{}}); for (let i = 0; i < 30; i++) { await new Promise((r) => requestAnimationFrame(() => r())); const t = document.getAnimations().filter((a) => a instanceof CSSTransition); if (!t.length) break; t.forEach((a) => { try { a.cancel(); } catch {} }); }})()`);
let ALLSTATE = {};

async function capturePage(c, base, page, vpName, vp, cfg, detail = new Map()) {
  const out = new Map(); // key -> {props, rows}
  const COLLECT = (key) => collect(cfg.ignoreProps, detail.get(key), cfg.props);
  await c.send('Emulation.setDeviceMetricsOverride', { width: vp[0], height: vp[1], deviceScaleFactor: 1, mobile: !!vp[2] });
  if (cfg.reducedMotion) await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const open = async () => {
    await gotoReady(c, base + page, cfg);
    if (cfg.scrollThrough) await c.evaluate(`(async()=>{for(let y=0;y<(document.body?.scrollHeight??0);y+=600){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,50));}window.scrollTo(0,0);})()`);
    await waitReady(c, cfg);
    await sleep(400);
  };
  await open();
  const pin = () => (cfg.beforeCapture ? c.evaluate(`void (${cfg.beforeCapture})`) : null);
  for (const [sn, cls] of Object.entries(cfg.states)) { await pin(); await setState(c, cls); await sleep(250); const key = `${page}|${vpName}|${sn}`; out.set(key, await c.evaluate(COLLECT(key))); }
  const firstState = Object.values(cfg.states)[0] ?? '';
  for (const a of cfg.actions) {
    await open(); await pin(); await setState(c, firstState);
    try { await c.evaluate(a.eval); } catch (e) { out.set(`${page}|${vpName}|action:${a.name}`, { props: [], rows: [], error: e.message }); continue; }
    const key = `${page}|${vpName}|action:${a.name}`;
    await sleep(500); out.set(key, await c.evaluate(COLLECT(key)));
  }
  const hoverHere = cfg.hover.viewports ? cfg.hover.viewports.includes(vpName) : vpName !== 'mobile';
  if (cfg.hover && cfg.hover.max > 0 && hoverHere) {
    const HOVER_TARGETS = hoverTargets(cfg.hover.selector ?? HOVER_SELECTOR);
    await open(); await setState(c, firstState);
    // The same properties as the page captures: shared by both browsers, ignored ones and custom properties left out.
    const ignore = cfg.ignoreProps.map((r) => new RegExp(r));
    const hoverProps = JSON.stringify((cfg.props ?? []).filter((p) => !ignore.some((r) => r.test(p))).sort());
    const n = await c.evaluate(`${HOVER_TARGETS}().length`);
    const step = Math.max(1, Math.floor(n / cfg.hover.max));
    for (let i = 0, k = 0; i < n && k < cfg.hover.max; i += step, k++) {
      const pos = await c.evaluate(`(()=>{const e=${HOVER_TARGETS}()[${i}]; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
      if (!pos) continue;
      await pin();
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y }); await sleep(180);
      out.set(`${page}|${vpName}|hover:${i}`, await c.evaluate(`(()=>{const e=${HOVER_TARGETS}()[${i}]; const props=${hoverProps}; const list=[e,...e.querySelectorAll('*')].slice(0,${cfg.hover.perElement}); return {props, rows:list.map(x=>{const cs=getComputedStyle(x); return {t:x.tagName, p:x.tagName.toLowerCase()+(typeof x.className==='string'&&x.className?'.'+x.className.trim().split(/\\s+/).slice(0,3).join('.'):''), v:props.map(k=>cs.getPropertyValue(k)).join('|')};})};})()`));
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    }
  }
  return out;
}

function diffEntry(A, B, cfg, hostsA, hostsB) {
  const norm = (s, hosts) => (s ?? '').split(hosts).join('H');
  if (A.error || B.error) return [{ where: 'action', detail: A.error || B.error }];
  if (A.props.join() !== B.props.join()) return [{ where: 'properties', detail: 'the two captures list different properties' }];
  if (A.rows.length !== B.rows.length) return [{ where: 'structure', detail: `${A.rows.length} elements vs ${B.rows.length}` }];
  const ignore = cfg.ignoreProps.map((r) => new RegExp(r));
  const skipIdx = new Set(A.props.map((p, i) => (ignore.some((r) => r.test(p)) ? i : -1)).filter((i) => i >= 0));
  const diffs = [];
  A.rows.forEach((ra, i) => {
    const rb = B.rows[i];
    if (ra.t !== rb.t) { diffs.push({ where: ra.p, detail: `tag ${ra.t} vs ${rb.t}` }); return; }
    // Hashed rows (whole-page captures): equal hashes are equal styles; a differing one is read in full on the next pass.
    if (ra.h !== undefined) {
      for (const hk of new Set([...Object.keys(ra), ...Object.keys(rb)].filter((k) => k === 'h' || k.endsWith('#')))) {
        const vk = hk === 'h' ? 'v' : hk.slice(0, -1);
        if (ra[hk] === rb[hk]) continue;
        if (ra[hk] === undefined || rb[hk] === undefined) { diffs.push({ where: `${ra.p}${vk === 'v' ? '' : vk}`, detail: `${vk} exists on one side only`, idx: i, full: true }); continue; }
        if (ra[vk] === undefined || rb[vk] === undefined) { diffs.push({ where: `${ra.p}${vk === 'v' ? '' : vk}`, detail: 'computed style differs', idx: i }); continue; }
        const d = valueDiffs(A.props, ra[vk], rb[vk], new Set(), cfg);
        if (d.length) diffs.push({ where: `${ra.p}${vk === 'v' ? '' : vk}`, detail: d.slice(0, 4).join('; '), idx: i, full: true });
      }
      return;
    }
    for (const key of ['v', '::before', '::after']) {
      const va = norm(ra[key], hostsA), vb = norm(rb[key], hostsB);
      if (va === vb) continue;
      if (!ra[key] || !rb[key]) { diffs.push({ where: ra.p, detail: `${key} exists on one side only` }); continue; }
      const d = valueDiffs(A.props, va, vb, skipIdx, cfg);
      if (d.length) diffs.push({ where: `${ra.p}${key === 'v' ? '' : key}`, detail: d.slice(0, 4).join('; '), idx: i, full: true });
    }
  });
  return diffs;
}

function valueDiffs(props, va, vb, skipIdx, cfg) {
  const xa = va.split('|'), xb = vb.split('|'); const d = [];
  xa.forEach((v, k) => {
    if (v === xb[k] || skipIdx.has(k) || sameUpToColours(v, xb[k], cfg.colourTolerance)) return;
    d.push(`${props[k]}: ${v.slice(0, 60)} → ${xb[k].slice(0, 60)}`);
  });
  return d;
}

export async function compareSites(userCfg, { a, b, out } = {}) {
  if (!a || !b) throw new Error('classhash compare needs --a and --b (base URLs of the two copies)');
  const cfg = { ...DEFAULTS, ...userCfg, hover: { ...DEFAULTS.hover, ...(userCfg.hover || {}) } };
  ALLSTATE = cfg.states;
  // One browser per side, each with its own profile: A and B load in parallel and share no cookies or storage.
  const [ca, cb] = await Promise.all([launchChrome(cfg.chrome), launchChrome(cfg.chrome)]);
  const report = []; let total = 0;
  try {
    // Values are compared by position, so both sides read the same properties: the ones both browsers know. Two
    // launches of one Chrome can differ (an experimental property enabled in one profile only).
    const [la, lb] = await Promise.all([ca, cb].map((c) => c.evaluate('[...getComputedStyle(document.documentElement)].filter((p) => !p.startsWith("--"))')));
    cfg.props = la.filter((p) => lb.includes(p));
    const odd = [...la.filter((p) => !lb.includes(p)).map((p) => `${p} (A only)`), ...lb.filter((p) => !la.includes(p)).map((p) => `${p} (B only)`)];
    if (odd.length) console.warn(`classhash: the two browsers support different properties, left out of the comparison: ${odd.join(', ')}`);
    for (const page of cfg.pages) for (const [vpName, vp] of Object.entries(cfg.viewports)) {
      let persistent = null;
      let detail = new Map(); // key -> element indices to read in full
      for (let attempt = 0; ; attempt++) {
        const [A, B] = await Promise.all([capturePage(ca, a, page, vpName, vp, cfg, detail), capturePage(cb, b, page, vpName, vp, cfg, detail)]);
        const found = new Map();
        for (const [key, ea] of A) { const eb = B.get(key); if (!eb) { found.set(key, [{ where: 'missing', detail: 'capture missing on side B' }]); continue; } const d = diffEntry(ea, eb, cfg, a, b); if (d.length) found.set(key, d); }
        // a difference only counts when the same element (label and position) differs in every attempt
        persistent = persistent
          ? new Map([...found].filter(([k]) => persistent.has(k)).map(([k, d]) => [k, d.filter((y) => persistent.get(k).some((x) => x.where === y.where && x.idx === y.idx))]).filter(([, d]) => d.length))
          : found;
        if (!persistent.size) break;
        // Retries as configured; then one more pass if a difference is still only known by its hash.
        const unread = [...persistent.values()].some((d) => d.some((x) => !x.full));
        if (attempt >= cfg.retries && (!unread || attempt > cfg.retries)) break;
        detail = new Map([...persistent].map(([k, d]) => [k, [...new Set(d.filter((x) => x.idx !== undefined).map((x) => x.idx))]]));
      }
      for (const [key, d] of persistent) { total += d.length; report.push({ key, diffs: d }); }
      console.log(`${persistent.size ? 'DIFF' : 'ok  '} ${page} ${vpName}${persistent.size ? ` (${[...persistent.keys()].map((k) => k.split('|')[2]).join(', ')})` : ''}`);
    }
  } finally { ca.close(); cb.close(); }
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2)); }
  for (const r of report.slice(0, cfg.maxReport)) { console.log(`\n${r.key}`); for (const d of r.diffs.slice(0, 4)) console.log(`  ${d.where}  ${d.detail}`); }
  console.log(total ? `\n${total} difference(s) in ${report.length} capture(s)` : '\nno differences');
  return total ? 1 : 0;
}
