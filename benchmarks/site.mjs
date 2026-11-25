// A static site, generated from a seed: components with BEM class names, a stylesheet with hover, focus, dark-mode,
// print and breakpoint rules, pages that use the components, and a script that toggles classes. No framework and no
// build: the tests and the benchmarks serve it as it is, so what is measured is SquawkCode and Chrome.
import fs from 'node:fs';
import path from 'node:path';

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLOCKS = ['card', 'panel', 'banner', 'teaser', 'tile', 'feature', 'quote', 'stat', 'step', 'profile', 'notice', 'summary', 'listing', 'callout', 'badge-row', 'media', 'pricing', 'faq', 'footer-col', 'toolbar'];
const PARTS = ['title', 'body', 'meta', 'icon', 'action', 'label', 'value', 'image'];
const HUES = [12, 48, 96, 150, 200, 230, 268, 310, 340];

/**
 * @param {{ components?: number, pages?: number, perPage?: number, seed?: number }} [options]
 * @returns {Record<string, string>} file path (relative to the site root) -> content
 */
export function generateSite({ components = 40, pages = 3, perPage = 30, seed = 20261125 } = {}) {
  const rand = prng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const blocks = Array.from({ length: components }, (_, i) => {
    const name = `${BLOCKS[i % BLOCKS.length]}${i >= BLOCKS.length ? `-${Math.floor(i / BLOCKS.length) + 1}` : ''}`;
    const parts = PARTS.filter(() => rand() < 0.6).slice(0, 5);
    if (!parts.includes('title')) parts.unshift('title');
    if (!parts.includes('action')) parts.push('action');
    return { name, parts, hue: pick(HUES), pad: 8 + 4 * Math.floor(rand() * 5), radius: pick([0, 4, 8, 12]), featured: rand() < 0.5 };
  });

  let css = `:root { --bg: #ffffff; --fg: #15171a; --line: #d8dce2; --muted: #5b6470; }
:root.dark { --bg: #111317; --fg: #eceef1; --line: #2a2f37; --muted: #9aa3ae; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
.page { max-width: 1100px; margin: 0 auto; padding: 24px; }
.page__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.site-nav { display: flex; gap: 16px; padding: 12px 24px; border-bottom: 1px solid var(--line); }
.site-nav__link { color: var(--fg); text-decoration: none; padding: 4px 8px; border-radius: 4px; }
.site-nav__link:hover { background: hsl(210 40% 92%); }
.site-nav__link:focus-visible { outline: 2px solid hsl(210 90% 50%); outline-offset: 2px; }
.site-nav__link--current { font-weight: 600; }
.is-hidden { display: none; }
.modal { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgb(0 0 0 / 0.4); }
.modal--open { display: flex; }
.modal__box { background: var(--bg); padding: 24px; border-radius: 8px; min-width: 280px; }
@media (max-width: 700px) { .page__grid { grid-template-columns: 1fr; } .site-nav { flex-wrap: wrap; } }
@media (prefers-color-scheme: dark) { .site-nav { border-bottom-color: hsl(215 14% 34%); } }
@media print { .site-nav { display: none; } .page { padding: 0; } }
`;
  for (const b of blocks) {
    css += `.${b.name} { padding: ${b.pad}px; border: 1px solid var(--line); border-radius: ${b.radius}px; background: var(--bg); transition: border-color 0.2s; }
.${b.name}:hover { border-color: hsl(${b.hue} 60% 50%); }
.${b.name}--featured { border-width: 2px; background: hsl(${b.hue} 70% 97%); }
:root.dark .${b.name}--featured { background: hsl(${b.hue} 30% 16%); }
`;
    for (const part of b.parts) {
      if (part === 'title') css += `.${b.name}__title { margin: 0 0 8px; font-size: ${18 + 2 * Math.floor(rand() * 4)}px; color: hsl(${b.hue} 55% 32%); }\n:root.dark .${b.name}__title { color: hsl(${b.hue} 70% 78%); }\n`;
      else if (part === 'action') css += `.${b.name}__action { display: inline-block; margin-top: 8px; padding: 6px 12px; border: 0; border-radius: 6px; background: hsl(${b.hue} 60% 42%); color: #ffffff; font: inherit; cursor: pointer; }\n.${b.name}__action:hover { background: hsl(${b.hue} 60% 34%); }\n.${b.name}__action:focus-visible { outline: 2px solid hsl(${b.hue} 90% 60%); outline-offset: 2px; }\n.${b.name}__action::after { content: " →"; }\n`;
      else if (part === 'meta') css += `.${b.name}__meta { color: var(--muted); font-size: 13px; }\n`;
      else if (part === 'icon') css += `.${b.name}__icon { width: 24px; height: 24px; border-radius: 50%; background: hsl(${b.hue} 60% 50%); }\n`;
      else if (part === 'image') css += `.${b.name}__image { height: 80px; background: linear-gradient(135deg, hsl(${b.hue} 60% 80%), hsl(${(b.hue + 40) % 360} 60% 70%)); }\n@media (max-width: 700px) { .${b.name}__image { height: 56px; } }\n`;
      else css += `.${b.name}__${part} { margin: 4px 0; }\n`;
    }
  }

  const render = (b, featured) => {
    const inner = b.parts.map((part) => {
      if (part === 'title') return `<h3 class="${b.name}__title">${b.name}</h3>`;
      if (part === 'action') return `<button class="${b.name}__action" data-open="modal">More</button>`;
      if (part === 'icon' || part === 'image') return `<div class="${b.name}__${part}"></div>`;
      return `<p class="${b.name}__${part}">${part} of ${b.name}</p>`;
    }).join('');
    return `<section class="${b.name}${featured ? ` ${b.name}--featured` : ''}">${inner}</section>`;
  };
  const files = { 'site/styles.css': css };
  const names = Array.from({ length: pages }, (_, i) => (i === 0 ? 'index' : `page-${i + 1}`));
  names.forEach((name, n) => {
    const nav = names.map((other) => `<a class="site-nav__link${other === name ? ' site-nav__link--current' : ''}" href="/${other === 'index' ? '' : `${other}.html`}">${other}</a>`).join('');
    const body = Array.from({ length: perPage }, (_, k) => { const b = blocks[(n * 7 + k * 3) % blocks.length]; return render(b, b.featured && rand() < 0.5); }).join('\n');
    files[`site/${name}.html`] = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title><link rel="stylesheet" href="/styles.css"></head>
<body>
<nav class="site-nav">${nav}</nav>
<main class="page"><div class="page__grid">
${body}
</div></main>
<div class="modal" id="modal"><div class="modal__box"><p>Details</p><button class="${blocks[0].name}__action" data-close="modal">Close</button></div></div>
<script src="/app.js"></script>
</body></html>
`;
  });
  files['site/app.js'] = `// Opens and closes the modal, and marks the first card of the page.
for (const button of document.querySelectorAll('[data-open]')) {
  button.addEventListener('click', () => document.getElementById(button.dataset.open).classList.add('modal--open'));
}
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('.modal').classList.remove('modal--open'));
}
const first = document.querySelector('.page__grid > section');
if (first && first.matches('.${blocks[0].name}')) first.classList.add('${blocks[0].name}--featured');
`;
  files['squawkcode.config.json'] = `${JSON.stringify({ srcDirs: ['site'], textExts: ['.html'], build: { cmd: 'node -e 0' }, serve: { cmd: `node ${JSON.stringify(path.join(import.meta.dirname, 'serve.mjs'))} site {port}` }, compare: { pages: names.map((n) => (n === 'index' ? '/' : `/${n}.html`)), actions: [{ name: 'modal', eval: "document.querySelector('[data-open]').click()" }] } }, null, 2)}\n`;
  return files;
}

/** Write a generated site into a directory. */
export function writeSite(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
