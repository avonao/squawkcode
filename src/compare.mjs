import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, sleep } from './cdp.mjs';
import { sameUpToColours } from './colour.mjs';

const DEFAULTS = {
  pages: ['/'],
  viewports: { desktop: [1440, 900, false], mobile: [390, 844, true] },
  states: { light: '', dark: 'dark' },         // html classes added for the capture
  actions: [],                                  // [{ name, eval }]: run in the page, then capture the whole document ("light" state)
  hover: { max: 30, perElement: 40, viewports: null }, // hover up to `max` links/buttons per page and compare them and their first descendants
                                                // (viewports: names to hover at; null = every viewport except "mobile")
  colourTolerance: 0.02,                        // ΔE (CIE76, lab) under which two colours count as equal: rgb(169, 169, 169) = lab(69.2378 0 0)
  ignoreProps: ['^--', '^-webkit-text-fill', 'perspective-origin', 'transform-origin'], // regex on property names
  scrollThrough: true,
  reducedMotion: true,
  settleMs: 2500,
  retries: 1,                                   // pages with differences are captured again and only persistent ones count
  maxReport: 15,
  chrome: null,
};

const COLLECT = `(() => {
  const props = [...getComputedStyle(document.documentElement)].sort();
  const skip = new Set(['SCRIPT','STYLE','LINK','META','TITLE','HEAD','NOSCRIPT']);
  const els = [...document.querySelectorAll('*')].filter(e => !skip.has(e.tagName));
  const row = (e) => {
    const cs = getComputedStyle(e);
    const r = { t: e.tagName, p: e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0,3).join('.') : ''), v: props.map(k => cs.getPropertyValue(k)).join('|') };
    for (const ps of ['::before','::after']) { const c = getComputedStyle(e, ps); if (c.content && c.content !== 'none' && c.content !== 'normal') r[ps] = props.map(k => c.getPropertyValue(k)).join('|'); }
    return r;
  };
  return { props, rows: els.map(row) };
})()`;

const HOVER_TARGETS = `(() => [...document.querySelectorAll('a[href], button, summary, [role="button"], input, select')]
  .filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; }))`;

async function gotoReady(c, url, settleMs) {
  await c.send('Page.navigate', { url });
  await sleep(settleMs);
  for (let i = 0; i < 30; i++) { if (await c.evaluate('document.readyState') === 'complete') break; await sleep(250); }
}
const setState = (c, cls) => c.evaluate(`(()=>{const l=document.documentElement.classList; for (const k of ${JSON.stringify(Object.values(ALLSTATE))}) k.split(' ').filter(Boolean).forEach(x=>l.remove(x)); '${cls}'.split(' ').filter(Boolean).forEach(x=>l.add(x)); document.getAnimations().forEach(a=>{try{a.cancel()}catch{}});})()`);
let ALLSTATE = {};

async function capturePage(c, base, page, vpName, vp, cfg) {
  const out = new Map(); // key -> {props, rows}
  await c.send('Emulation.setDeviceMetricsOverride', { width: vp[0], height: vp[1], deviceScaleFactor: 1, mobile: !!vp[2] });
  if (cfg.reducedMotion) await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const open = async () => {
    await gotoReady(c, base + page, cfg.settleMs);
    if (cfg.scrollThrough) await c.evaluate(`(async()=>{for(let y=0;y<document.body.scrollHeight;y+=600){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,50));}window.scrollTo(0,0);})()`);
    await sleep(400);
  };
  await open();
  for (const [sn, cls] of Object.entries(cfg.states)) { await setState(c, cls); await sleep(250); out.set(`${page}|${vpName}|${sn}`, await c.evaluate(COLLECT)); }
  const firstState = Object.values(cfg.states)[0] ?? '';
  for (const a of cfg.actions) {
    await open(); await setState(c, firstState);
    try { await c.evaluate(a.eval); } catch (e) { out.set(`${page}|${vpName}|action:${a.name}`, { props: [], rows: [], error: e.message }); continue; }
    await sleep(500); out.set(`${page}|${vpName}|action:${a.name}`, await c.evaluate(COLLECT));
  }
  const hoverHere = cfg.hover.viewports ? cfg.hover.viewports.includes(vpName) : vpName !== 'mobile';
  if (cfg.hover && cfg.hover.max > 0 && hoverHere) {
    await open(); await setState(c, firstState);
    const n = await c.evaluate(`${HOVER_TARGETS}().length`);
    const step = Math.max(1, Math.floor(n / cfg.hover.max));
    for (let i = 0, k = 0; i < n && k < cfg.hover.max; i += step, k++) {
      const pos = await c.evaluate(`(()=>{const e=${HOVER_TARGETS}()[${i}]; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};})()`);
      if (!pos) continue;
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y }); await sleep(180);
      out.set(`${page}|${vpName}|hover:${i}`, await c.evaluate(`(()=>{const e=${HOVER_TARGETS}()[${i}]; const props=[...getComputedStyle(document.documentElement)].sort(); const list=[e,...e.querySelectorAll('*')].slice(0,${cfg.hover.perElement}); return {props, rows:list.map(x=>{const cs=getComputedStyle(x); return {t:x.tagName, p:x.tagName.toLowerCase()+(typeof x.className==='string'&&x.className?'.'+x.className.trim().split(/\\s+/).slice(0,3).join('.'):''), v:props.map(k=>cs.getPropertyValue(k)).join('|')};})};})()`));
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    }
  }
  return out;
}

function diffEntry(A, B, cfg, hostsA, hostsB) {
  const norm = (s, hosts) => (s ?? '').split(hosts).join('H');
  if (A.error || B.error) return [{ where: 'action', detail: A.error || B.error }];
  if (A.rows.length !== B.rows.length) return [{ where: 'structure', detail: `${A.rows.length} elements vs ${B.rows.length}` }];
  const ignore = cfg.ignoreProps.map((r) => new RegExp(r));
  const skipIdx = new Set(A.props.map((p, i) => (ignore.some((r) => r.test(p)) ? i : -1)).filter((i) => i >= 0));
  const diffs = [];
  A.rows.forEach((ra, i) => {
    const rb = B.rows[i];
    if (ra.t !== rb.t) { diffs.push({ where: ra.p, detail: `tag ${ra.t} vs ${rb.t}` }); return; }
    for (const key of ['v', '::before', '::after']) {
      const va = norm(ra[key], hostsA), vb = norm(rb[key], hostsB);
      if (va === vb) continue;
      if (!ra[key] || !rb[key]) { diffs.push({ where: ra.p, detail: `${key} exists on one side only` }); continue; }
      const xa = va.split('|'), xb = vb.split('|'); const d = [];
      xa.forEach((v, k) => {
        if (v === xb[k] || skipIdx.has(k) || sameUpToColours(v, xb[k], cfg.colourTolerance)) return;
        d.push(`${A.props[k]}: ${v.slice(0, 60)} → ${xb[k].slice(0, 60)}`);
      });
      if (d.length) diffs.push({ where: `${ra.p}${key === 'v' ? '' : key}`, detail: d.slice(0, 4).join('; ') });
    }
  });
  return diffs;
}

export async function compareSites(userCfg, { a, b, out } = {}) {
  if (!a || !b) throw new Error('classhash compare needs --a and --b (base URLs of the two copies)');
  const cfg = { ...DEFAULTS, ...userCfg, hover: { ...DEFAULTS.hover, ...(userCfg.hover || {}) } };
  ALLSTATE = cfg.states;
  // One browser per side, each with its own profile: A and B load in parallel and share no cookies or storage.
  const [ca, cb] = await Promise.all([launchChrome(cfg.chrome), launchChrome(cfg.chrome)]);
  const report = []; let total = 0;
  try {
    for (const page of cfg.pages) for (const [vpName, vp] of Object.entries(cfg.viewports)) {
      let persistent = null;
      for (let attempt = 0; attempt <= cfg.retries; attempt++) {
        const [A, B] = await Promise.all([capturePage(ca, a, page, vpName, vp, cfg), capturePage(cb, b, page, vpName, vp, cfg)]);
        const found = new Map();
        for (const [key, ea] of A) { const eb = B.get(key); if (!eb) { found.set(key, [{ where: 'missing', detail: 'capture missing on side B' }]); continue; } const d = diffEntry(ea, eb, cfg, a, b); if (d.length) found.set(key, d); }
        // a difference only counts when it shows up in every attempt
        persistent = persistent ? new Map([...found].filter(([k, d]) => persistent.has(k) && persistent.get(k).some((x) => d.some((y) => y.where === x.where && y.detail === x.detail)))) : found;
        if (!persistent.size) break;
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
