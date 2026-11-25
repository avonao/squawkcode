import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, sleep } from './cdp.mjs';
import { sameUpToColours } from './colour.mjs';

export const DEFAULTS = {
  pages: ['/'],
  viewports: { desktop: [1440, 900, false], mobile: [390, 844, true] },
  states: { light: '', dark: 'dark' },         // html classes added for the capture, or { class, media, type }: media
                                                // features to emulate ({ 'prefers-color-scheme': 'dark' }) and a media
                                                // type ('print')
  actions: [],                                  // [{ name, eval }]: run in the page, then capture the whole document ("light" state)
  hover: { max: 30, perElement: 40, viewports: null, selector: null }, // hover up to `max` links/buttons per page and compare them, their
                                                // first descendants and their ancestors (viewports: names to hover at;
                                                // null = every viewport except "mobile"; selector: which elements to
                                                // hover, null = links, buttons and fields)
  focus: { max: 20, perElement: 20, viewports: null }, // press Tab up to `max` times and compare the focused element the same way
  colourTolerance: 0.02,                        // ΔE (CIE76, lab) under which two colours count as equal: rgb(169, 169, 169) = lab(69.2378 0 0)
  ignoreProps: ['^--', '^-webkit-text-fill', 'perspective-origin', 'transform-origin'], // regex on property names
  scrollThrough: true,
  reducedMotion: true,
  settleMs: 'auto',                             // 'auto': capture when the page has loaded, its fonts are ready and neither
                                                // the network nor the DOM has changed for quietMs (at most settleMaxMs);
                                                // a number: wait that long after every navigation instead
  quietMs: 500,
  settleMaxMs: 5000,
  carefulSettleMs: 2500,                        // a page that differed is captured again after this fixed wait: only a
                                                // difference that is still there counts
  readyWhen: null,                              // expression evaluated in the page after it settles; capture waits until it is true
                                                // (e.g. an iframe's ready class), at most readyTimeoutMs
  readyTimeoutMs: 20000,
  beforeCapture: null,                          // expression evaluated before every capture, to pin what changes on a timer
                                                // (e.g. reset a carousel that advances every few seconds)
  retries: 1,                                   // pages with differences are captured again and only persistent ones count
  concurrency: null,                            // pages compared at once (each takes two browsers); null: one per processor, at most 4
  maxReport: 15,
  chrome: null,
};

// A 53-bit hash of a string, for the page (cyrb53).
const H53 = `const h53 = (str) => {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };`;

// A whole page's computed styles are tens of megabytes (2,600 elements × 760 properties), too much to move over CDP
// for every state. The page sends one hash per element (and per pseudo-element) of its values, with the ignored
// properties left out and its own origin written as H; `detail` lists the elements whose values it also sends, which
// compareSites asks for once hashes have differed. `props` is the property list both browsers share (compareSites).
// A function for the page (see `call` in cdp.mjs): its data are its arguments.
export const COLLECT = `(ignoreList, detail, propList) => {
  const ignore = ignoreList.map((r) => new RegExp(r));
  const want = new Set(detail ?? []);
  const props = (propList ?? [...getComputedStyle(document.documentElement)]).filter((p) => !ignore.some((r) => r.test(p))).sort();
  const skip = new Set(['SCRIPT','STYLE','LINK','META','TITLE','HEAD','NOSCRIPT']);
  // Every element, in document order, through open shadow roots too (a custom element's parts are styled like any other).
  const deep = (root) => { const out = []; for (const e of root.querySelectorAll('*')) { out.push(e); if (e.shadowRoot) out.push(...deep(e.shadowRoot)); } return out; };
  const els = deep(document).filter(e => !skip.has(e.tagName));
  const host = location.origin;
  const read = (cs) => props.map((k) => cs.getPropertyValue(k)).join('|').split(host).join('H');
  ${H53}
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
}`;

const HOVER_SELECTOR = 'a[href], button, summary, [role="button"], input, select';
// The elements to hover, found once and kept by the page: the element under the pointer and the element read are the
// same one, whatever the pointer changes. Returns how many there are.
const HOVER_TARGETS = `(selector) => {
  window.__squawkHover = [...document.querySelectorAll(selector)].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; });
  return window.__squawkHover.length;
}`;
// Bring the i-th of them into view; where its middle is.
const HOVER_POSITION = `(i) => { const e = window.__squawkHover[i]; if (!e || !e.isConnected) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }`;

// What the page does on its own is watched from the moment it has loaded: `last` is when the document last changed
// (a page is captured when that is quietMs ago), `n` counts the changes that were not made by a state set here
// (setState announces its own with `own`). A page whose count has not moved is the page as it settled.
const WATCH = `if (!window.__squawkQuiet) { const q = window.__squawkQuiet = { last: performance.now(), n: 0, own: false }; new MutationObserver(() => { q.last = performance.now(); if (!q.own) q.n++; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); }`;

// After a navigation: wait until the page can be captured. `scroll` walks down the page and back (what starts lazy
// images and content that appears in view); what it brings in is waited for like everything else. `careful` is the
// second look at a page that differed: a fixed, long wait, so that only a difference that is really there is reported.
async function gotoReady(c, url, cfg, careful, scroll) {
  c.network.reset();
  await c.send('Page.navigate', { url });
  if (careful || typeof cfg.settleMs === 'number') {
    await sleep(careful ? Math.max(cfg.carefulSettleMs, typeof cfg.settleMs === 'number' ? cfg.settleMs : 0) : cfg.settleMs);
    for (let i = 0; i < 30; i++) { if (await c.evaluate('document.readyState') === 'complete') break; await sleep(250); }
    await c.evaluate(`void (() => { ${WATCH} })()`);
    await scroll();
    await sleep(careful ? 400 : 100);
    return;
  }
  // Settled: loaded, fonts ready, scrolled through, and neither a request nor a change to the document for quietMs.
  const end = Date.now() + cfg.settleMaxMs;
  for (let i = 0; Date.now() < end + 5000; i++) { if (await c.evaluate('document.readyState') === 'complete') break; await sleep(40); }
  await c.evaluate(`(async () => { try { await document.fonts.ready; } catch {} ${WATCH} })()`);
  await scroll();
  while (Date.now() < end) {
    const still = await c.evaluate('window.__squawkQuiet ? performance.now() - window.__squawkQuiet.last : 0');
    if (still >= cfg.quietMs && c.network.idleFor() >= cfg.quietMs) return;
    await sleep(Math.max(10, Math.min(50, cfg.quietMs - Math.min(still, c.network.idleFor()))));
  }
}

// A page that finishes after load (an iframe, a client fetch) is captured once it says so; the two sides can be far
// apart in time when one server is busier. Called after the page has been scrolled through, which is what starts lazy
// iframes.
async function waitReady(c, cfg) {
  if (!cfg.readyWhen) return;
  for (const end = Date.now() + cfg.readyTimeoutMs; Date.now() < end; await sleep(250)) {
    if (await c.evaluate(`!!(${cfg.readyWhen})`)) return;
  }
}

/** A state as configured: html classes, or an object with classes, media features and a media type. */
export const stateOf = (value) => (typeof value === 'string' ? { class: value, media: null, type: '' } : { class: value?.class ?? '', media: value?.media ?? null, type: value?.type ?? '' });

// After the state changes, transitions are cancelled frame by frame until none is left: Chrome updates some elements'
// style late (off-screen slides, content-visibility), so their transitions start after a single cancel and a capture
// would catch them half way.
async function setState(c, cfg, value) {
  const state = stateOf(value);
  const all = Object.values(cfg.states).flatMap((v) => stateOf(v).class.split(' ').filter(Boolean));
  const features = Object.entries(state.media ?? {}).map(([name, v]) => ({ name, value: String(v) }));
  if (cfg.reducedMotion && !features.some((f) => f.name === 'prefers-reduced-motion')) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
  await c.send('Emulation.setEmulatedMedia', { media: state.type, features });
  await c.call(SET_CLASSES, all, state.class.split(' ').filter(Boolean));
}

// Wait a frame and cancel the transitions it started, until a frame starts none: every property is then at the value
// it was going to. Used after anything that changes styles (a state, the pointer, the keyboard focus, an action), so
// a capture never reads a value half way through a transition, which would differ between the two sides by timing.
const NO_TRANSITIONS = `for (let i = 0; i < 30; i++) { await new Promise((r) => requestAnimationFrame(() => r())); const t = document.getAnimations().filter((a) => a instanceof CSSTransition); if (!t.length) break; t.forEach((a) => { try { a.cancel(); } catch {} }); }`;
const endTransitions = (c) => c.evaluate(`(async()=>{${NO_TRANSITIONS}})()`);
// Take the classes of every state off the root element and put this state's on. The observer's callback runs before
// the line after the first await: the class changes made here are not counted as the page's own.
const SET_CLASSES = `async (all, classes) => { const q = window.__squawkQuiet; if (q) q.own = true; const l = document.documentElement.classList; for (const k of all) l.remove(k); for (const k of classes) l.add(k); await Promise.resolve(); if (q) q.own = false; document.getAnimations().forEach((a) => { try { a.cancel(); } catch {} }); ${NO_TRANSITIONS} }`;

// One element, its ancestors (a hovered or focused element changes them too: `.card:hover`, `:focus-within`) and its
// first descendants, read once no transition is running: a hash of each one's computed values, like a page capture,
// and the values themselves for the elements in `detail`. Statements for a page function that has `el`, `props`,
// `perElement` and `detail`.
const AROUND = `${NO_TRANSITIONS} ${H53} const want = new Set(detail ?? []); const host = location.origin; const up = []; for (let a = el.parentElement; a && up.length < 6; a = a.parentElement) up.push(a); const list = [el, ...up, ...el.querySelectorAll('*')].slice(0, perElement + 7); return { props, rows: list.map((x, i) => { const cs = getComputedStyle(x); const v = props.map((k) => cs.getPropertyValue(k)).join('|').split(host).join('H'); const r = { t: x.tagName, p: x.tagName.toLowerCase() + (typeof x.className === 'string' && x.className ? '.' + x.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''), h: h53(v) }; if (want.has(i)) r.v = v; return r; }) };`;
// What the i-th hovered element looks like.
const AROUND_HOVERED = `async (i, props, perElement, detail) => { const el = window.__squawkHover[i]; if (!el) return null; ${AROUND} }`;
// What the focused element looks like. 0: no element has the focus; -1: it came round to an element it was on before;
// 1: an element whose capture was not asked for.
const AROUND_FOCUSED = `async (wanted, props, perElement, detail) => { const el = document.activeElement; if (!el || el === document.body || el === document.documentElement) return 0; if (window.__squawkFocused.has(el)) return -1; window.__squawkFocused.add(el); if (!wanted) return 1; ${AROUND} }`;

/**
 * Every capture of one page at one viewport: key -> { props, rows }.
 * @param {{ detail?: Map<string, number[]>, only?: Set<string> | null, careful?: boolean }} [how]
 *   detail: per capture, the elements whose values are read in full; only: the captures to take (the second look at a
 *   page takes the ones that differed, and nothing else); careful: long fixed waits and a new page for every pass
 */
async function capturePage(c, base, page, vpName, vp, cfg, { detail = new Map(), only = null, careful = false } = {}) {
  const out = new Map();
  const keyOf = (part) => `${page}|${vpName}|${part}`;
  const want = (part) => !only || only.has(keyOf(part));
  const wantAny = (prefix) => !only || [...only].some((k) => k.startsWith(keyOf(prefix)));
  const collect = (key) => c.call(COLLECT, cfg.ignoreProps, detail.get(key) ?? [], cfg.props ?? null);
  await c.send('Emulation.setDeviceMetricsOverride', { width: vp[0], height: vp[1], deviceScaleFactor: 1, mobile: !!vp[2] });
  const first = Object.values(cfg.states)[0] ?? '';
  await setStateMedia(c, cfg, first);
  const changes = () => c.evaluate('window.__squawkQuiet ? window.__squawkQuiet.n : -1');
  let settled = null; // the page's own change count when it was opened; null: no page is open
  const scroll = () => (cfg.scrollThrough ? c.evaluate(`(async()=>{for(let y=0;y<(document.body?.scrollHeight??0);y+=600){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,50));}window.scrollTo(0,0);})()`) : null);
  const open = async () => {
    await gotoReady(c, base + page, cfg, careful, scroll);
    await waitReady(c, cfg);
    settled = await changes();
  };
  // A pass starts on the page as it settled: the one that is open when its document has not changed by itself since
  // (states set here do not count), a newly opened one otherwise, and always on the careful second look.
  const untouched = async () => { if (careful || settled === null || settled < 0 || (await changes()) !== settled) await open(); };
  const pin = () => (cfg.beforeCapture ? c.evaluate(`void (${cfg.beforeCapture})`) : null);

  const states = Object.entries(cfg.states).filter(([sn]) => want(sn));
  if (states.length) {
    await open();
    for (const [sn, value] of states) { await pin(); await setState(c, cfg, value); await sleep(careful ? 250 : 80); const key = keyOf(sn); out.set(key, await collect(key)); }
  }
  // The same properties as the page captures: shared by both browsers, ignored ones and custom properties left out.
  const ignore = cfg.ignoreProps.map((r) => new RegExp(r));
  const someProps = (cfg.props ?? []).filter((p) => !ignore.some((r) => r.test(p))).sort();
  const here = (part) => (part.viewports ? part.viewports.includes(vpName) : vpName !== 'mobile');
  if (cfg.focus && cfg.focus.max > 0 && here(cfg.focus) && wantAny('focus:')) {
    // The keyboard's way through the page: Tab, and what the focused element (and what contains it) looks like.
    // Before the hover pass, not after it: where Tab goes first depends on where the page was last scrolled to by
    // an element coming into view, and the hover pass leaves that at its last element. A page that was only loaded
    // starts at the top, like a visitor's.
    await untouched(); await setState(c, cfg, first);
    await c.evaluate('(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); window.__squawkFocused = new WeakSet(); })()');
    const last = only ? Math.max(-1, ...[...only].filter((k) => k.startsWith(keyOf('focus:'))).map((k) => Number(k.slice(keyOf('focus:').length)))) : cfg.focus.max - 1;
    // Captures are numbered by the elements that took the focus, not by key presses: a Tab can land on no element
    // (Chrome's first Tab after a scroll goes to the document), and it does so on both sides or on one.
    for (let taken = 0, misses = 0, press = 0; taken <= last && taken < cfg.focus.max && press < cfg.focus.max + 6; press++) {
      await pin();
      await Promise.all(['keyDown', 'keyUp'].map((type) => c.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })));
      if (careful) await sleep(180);
      const rows = await c.call(AROUND_FOCUSED, want(`focus:${taken}`), someProps, cfg.focus.perElement, detail.get(keyOf(`focus:${taken}`)) ?? []);
      if (rows === -1) break;
      if (rows === 0) { if (++misses > 2) break; continue; } // three in a row: the focus has left the page
      misses = 0;
      if (rows !== 1) out.set(keyOf(`focus:${taken}`), rows);
      taken++;
    }
    await c.evaluate('document.activeElement && document.activeElement.blur()');
  }
  if (cfg.hover && cfg.hover.max > 0 && here(cfg.hover) && wantAny('hover:')) {
    await untouched(); await setState(c, cfg, first);
    const n = await c.call(HOVER_TARGETS, cfg.hover.selector ?? HOVER_SELECTOR);
    const step = Math.max(1, Math.floor(n / cfg.hover.max));
    for (let i = 0, k = 0; i < n && k < cfg.hover.max; i += step, k++) {
      if (!want(`hover:${i}`)) continue;
      const pos = await c.call(HOVER_POSITION, i);
      if (!pos) continue;
      await pin();
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
      if (careful) await sleep(180);
      const rows = await c.call(AROUND_HOVERED, i, someProps, cfg.hover.perElement, detail.get(keyOf(`hover:${i}`)) ?? []);
      if (rows) out.set(keyOf(`hover:${i}`), rows);
    }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  }
  // Actions change the page, so each one gets a page of its own, after the passes that share one.
  for (const a of cfg.actions) {
    if (!want(`action:${a.name}`)) continue;
    await open(); await pin(); await setState(c, cfg, first);
    const key = keyOf(`action:${a.name}`);
    try { await c.evaluate(a.eval); } catch (e) { out.set(key, { props: [], rows: [], error: e.message }); continue; }
    await sleep(careful ? 500 : 150); await endTransitions(c); out.set(key, await collect(key));
  }
  return out;
}

// Media emulation alone (before the first navigation of a capture, so the page loads in the state it is captured in first).
async function setStateMedia(c, cfg, value) {
  const state = stateOf(value);
  const features = Object.entries(state.media ?? {}).map(([name, v]) => ({ name, value: String(v) }));
  if (cfg.reducedMotion && !features.some((f) => f.name === 'prefers-reduced-motion')) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
  await c.send('Emulation.setEmulatedMedia', { media: state.type, features });
}

// Every capture is a hash per element (and per pseudo-element): equal hashes are equal styles, and an element whose
// hash differs is read in full on the next pass, which is what names the properties.
function diffEntry(A, B, cfg) {
  if (A.error || B.error) return [{ where: 'action', detail: A.error || B.error }];
  if (A.props.join() !== B.props.join()) return [{ where: 'properties', detail: 'the two captures list different properties' }];
  if (A.rows.length !== B.rows.length) return [{ where: 'structure', detail: `${A.rows.length} elements vs ${B.rows.length}` }];
  const diffs = [];
  A.rows.forEach((ra, i) => {
    const rb = B.rows[i];
    if (ra.t !== rb.t) { diffs.push({ where: ra.p, detail: `tag ${ra.t} vs ${rb.t}` }); return; }
    for (const hk of new Set([...Object.keys(ra), ...Object.keys(rb)].filter((k) => k === 'h' || k.endsWith('#')))) {
      const vk = hk === 'h' ? 'v' : hk.slice(0, -1);
      if (ra[hk] === rb[hk]) continue;
      if (ra[hk] === undefined || rb[hk] === undefined) { diffs.push({ where: `${ra.p}${vk === 'v' ? '' : vk}`, detail: `${vk} exists on one side only`, idx: i, full: true }); continue; }
      if (ra[vk] === undefined || rb[vk] === undefined) { diffs.push({ where: `${ra.p}${vk === 'v' ? '' : vk}`, detail: 'computed style differs', idx: i }); continue; }
      const d = valueDiffs(A.props, ra[vk], rb[vk], cfg);
      if (d.length) diffs.push({ where: `${ra.p}${vk === 'v' ? '' : vk}`, detail: d.slice(0, 4).join('; '), idx: i, full: true });
    }
  });
  return diffs;
}

function valueDiffs(props, va, vb, cfg) {
  const xa = va.split('|'), xb = vb.split('|'); const d = [];
  xa.forEach((v, k) => {
    if (v === xb[k] || sameUpToColours(v, xb[k], cfg.colourTolerance)) return;
    d.push(`${props[k]}: ${v.slice(0, 60)} → ${xb[k].slice(0, 60)}`);
  });
  return d;
}
/**
 * How many pages are compared at once when the configuration does not say: one per processor, at most four. Each
 * takes two browsers, which wait for the page most of the time (measured on two processors: two at a time is 1.6
 * times faster than one, three no faster than two).
 */
export const defaultConcurrency = () => Math.max(1, Math.min(4, os.availableParallelism()));

/**
 * The configuration as side B needs it when B's classes are renamed: the html classes of a state, the selectors a
 * hover pass picks elements with and the class names in the scripts of actions are written for the site as it was, and
 * the renamed copy knows those classes under other names.
 * @param {{ classes: (text: string) => string, selector: (text: string) => string, js: (text: string) => string }} rename
 */
function renamedConfig(cfg, rename) {
  return {
    ...cfg,
    states: Object.fromEntries(Object.entries(cfg.states).map(([name, value]) => { const st = stateOf(value); return [name, { ...st, class: rename.classes(st.class) }]; })),
    actions: cfg.actions.map((a) => ({ ...a, eval: rename.js(a.eval) })),
    readyWhen: cfg.readyWhen ? rename.js(cfg.readyWhen) : cfg.readyWhen,
    beforeCapture: cfg.beforeCapture ? rename.js(cfg.beforeCapture) : cfg.beforeCapture,
    hover: { ...cfg.hover, selector: cfg.hover.selector ? rename.selector(cfg.hover.selector) : cfg.hover.selector },
  };
}

/**
 * @param {object} userCfg  the `compare` block of the configuration
 * @param {{ a: string, b: string, out?: string, concurrency?: number | string, rename?: Parameters<typeof renamedConfig>[1] }} sides
 *   rename: how side B's classes are renamed (the gate passes it; `squawkcode compare --map` builds it from a map file)
 */
export async function compareSites(userCfg, { a, b, out, concurrency, rename } = {}) {
  if (!a || !b) throw new Error('squawkcode compare needs --a and --b (base URLs of the two copies)');
  const cfg = { ...DEFAULTS, ...userCfg, hover: { ...DEFAULTS.hover, ...(userCfg.hover || {}) }, focus: userCfg.focus === false ? { max: 0 } : { ...DEFAULTS.focus, ...(userCfg.focus || {}) } };
  const cfgB = rename ? renamedConfig(cfg, rename) : cfg;
  const jobs = cfg.pages.flatMap((page) => Object.entries(cfg.viewports).map(([vpName, vp]) => ({ page, vpName, vp })));
  const width = Math.max(1, Math.min(Number(concurrency ?? cfg.concurrency) || defaultConcurrency(), jobs.length));
  const started = Date.now();
  // One pair of browsers per page compared at once, each browser with its own profile: A and B load in parallel and
  // share no cookies or storage.
  const pairs = await Promise.all(Array.from({ length: width }, () => Promise.all([launchChrome(cfg.chrome), launchChrome(cfg.chrome)])));
  const results = new Array(jobs.length);
  try {
    // Values are compared by position, so both sides read the same properties: the ones both browsers know. Two
    // launches of one Chrome can differ (an experimental property enabled in one profile only).
    const lists = await Promise.all(pairs.flat().map((c) => c.evaluate('[...getComputedStyle(document.documentElement)].filter((p) => !p.startsWith("--"))')));
    cfg.props = lists[0].filter((p) => lists.every((l) => l.includes(p)));
    cfgB.props = cfg.props;
    const odd = [...new Set(lists.flat())].filter((p) => !cfg.props.includes(p));
    if (odd.length) console.warn(`squawkcode: the browsers support different properties, left out of the comparison: ${odd.join(', ')}`);
    let next = 0;
    await Promise.all(pairs.map(async ([ca, cb]) => {
      for (;;) {
        const index = next++;
        if (index >= jobs.length) return;
        const { page, vpName, vp } = jobs[index];
        let persistent = null;
        let detail = new Map(); // key -> element indices to read in full
        for (let attempt = 0; ; attempt++) {
          const careful = attempt > 0;
          // The second look takes the captures that differed, and nothing else.
          const how = { detail, careful, only: persistent ? new Set(persistent.keys()) : null };
          const [A, B] = await Promise.all([capturePage(ca, a, page, vpName, vp, cfg, how), capturePage(cb, b, page, vpName, vp, cfgB, how)]);
          const found = new Map();
          for (const key of new Set([...A.keys(), ...B.keys()])) {
            const ea = A.get(key); const eb = B.get(key);
            if (!ea || !eb) { found.set(key, [{ where: 'missing', detail: `capture missing on side ${ea ? 'B' : 'A'}` }]); continue; }
            const d = diffEntry(ea, eb, cfg); if (d.length) found.set(key, d);
          }
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
        results[index] = persistent;
        console.log(`${persistent.size ? 'DIFF' : 'ok  '} ${page} ${vpName}${persistent.size ? ` (${[...persistent.keys()].map((k) => k.split('|')[2]).join(', ')})` : ''}`);
      }
    }));
  } finally { for (const c of pairs.flat()) c.close(); }
  const report = []; let total = 0;
  for (const persistent of results) for (const [key, d] of persistent ?? []) { total += d.length; report.push({ key, diffs: d }); }
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2)); }
  for (const r of report.slice(0, cfg.maxReport)) { console.log(`\n${r.key}`); for (const d of r.diffs.slice(0, 4)) console.log(`  ${d.where}  ${d.detail}`); }
  console.log(total ? `\n${total} difference(s) in ${report.length} capture(s)` : '\nno differences');
  console.log(`compared ${jobs.length} page view(s) in ${((Date.now() - started) / 1000).toFixed(1)} s, ${width} at a time`);
  return total ? 1 : 0;
}
