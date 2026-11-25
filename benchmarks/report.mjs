// Write docs/benchmarks.md from benchmarks/results/site.json: `node benchmarks/report.mjs`.
// Every number and every sentence that compares numbers is computed here, so the text cannot drift from the tables.
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const r = JSON.parse(fs.readFileSync(path.join(here, 'results/site.json'), 'utf8'));
const kb = (n) => (n / 1000).toFixed(n < 9995 ? 2 : 1);
const change = (now, before) => { const p = Math.round((now / before - 1) * 1000) / 10; return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`; };
const int = (n) => Math.round(n).toLocaleString('en-US');

let md = `# Benchmarks

Three questions, answered on one generated site: what renaming class names saves, how long the proof takes, and what the proof finds that a screenshot comparison does not. Everything here can be run again with [\`benchmarks/run.mjs\`](../benchmarks/run.mjs); this page is written from its result file by \`benchmarks/report.mjs\`.

The site is ${int(r.site.components)} components with BEM class names (\`card\`, \`card__title\`, \`card--featured\`), ${r.site.pages} pages of ${r.site.elementsPerPage} components each, one stylesheet with hover, focus, dark-theme, breakpoint and print rules, and a script that opens a dialog: ${int(r.site.classes)} classes in all. It is static, so what is measured is SquawkCode and Chrome and not a framework's build. Measured on ${r.date} with Node ${r.machine.node} on ${r.machine.cores} cores (${r.machine.cpu}, ${r.machine.platform}).

`;

if (r.size) {
  const [plain, hash, min] = ['plain', 'hash', 'min'].map((id) => r.size.find((x) => x.id === id));
  md += `## What renaming saves

Sizes in kB (1,000 bytes); every file is compressed on its own, the way a server sends it (Brotli at quality 11, gzip at level 9).

| | Stylesheet | Markup | Script | **Total, Brotli** | Total, gzip | Total, as written | Transform |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
`;
  for (const row of [plain, hash, min]) {
    md += `| ${row.label}${row.averageNameLength ? ` (${row.averageNameLength} characters a name)` : ''} | ${kb(row.css.brotli)} | ${kb(row.html.brotli)} | ${kb(row.js.brotli)} | **${kb(row.total.brotli)}**${row === plain ? '' : ` (${change(row.total.brotli, plain.total.brotli)})`} | ${kb(row.total.gzip)}${row === plain ? '' : ` (${change(row.total.gzip, plain.total.gzip)})`} | ${kb(row.total.raw)}${row === plain ? '' : ` (${change(row.total.raw, plain.total.raw)})`} | ${row.transformMs === undefined ? '' : `${row.transformMs} ms`} |\n`;
  }
  md += `
- **Minimal names** make the site ${change(min.total.brotli, plain.total.brotli).replace('-', '')} smaller compressed (${change(min.total.raw, plain.total.raw).replace('-', '')} as written). The class that is written most often gets a one-letter name.
- **Hashed names** make it ${change(hash.total.raw, plain.total.raw).replace('-', '')} smaller as written and ${change(hash.total.brotli, plain.total.brotli).replace('+', '')} ${hash.total.brotli > plain.total.brotli ? 'larger' : 'smaller'} compressed. A readable name such as \`card__title\` shares most of its letters with \`card\` and \`card__body\`, which is exactly what a compressor removes; a hash shares nothing with anything. Hashed names are for when a name must be the same in every build without a map being kept, not for size.
- Between the two, minimal names are ${change(min.total.brotli, hash.total.brotli).replace('-', '')} smaller compressed.

How much a real site gains depends on how much of it is class names: markup that repeats long BEM names gains most, a page of prose gains little.

`;
}

if (r.speed) {
  const s = r.speed;
  md += `## How long the proof takes

The plain site against the renamed one: ${s.pageViews} page views (${s.pageViews / 2} pages at two viewports), each in the light and the dark state, with the hover pass over up to 30 links and buttons a page.

| | Time |
| --- | ---: |
${s.baseline ? `| SquawkCode ${s.baseline.version}, as released: a fixed wait after every navigation, a page load for every pass, one page at a time | ${s.baseline.seconds.toFixed(1)} s |\n` : ''}| The same captures now, one page at a time | ${s.sameCapturesOneAtATime.toFixed(1)} s |
| The defaults: the keyboard-focus pass added, ${s.concurrency === 1 ? 'one page at a time' : `${s.concurrency} pages at a time (one per processor, at most four)`} | ${s.defaults.toFixed(1)} s |

${s.baseline ? `The same captures take ${(s.baseline.seconds / s.sameCapturesOneAtATime).toFixed(1)} times less time than in ${s.baseline.version}, which was run for this table on the same site (with the plain site on both sides: it cannot be told how a copy is renamed). ` : ''}Four things make the difference:

- **The page is waited for, not the clock.** A page counts as settled when it has loaded, its fonts are ready and neither the network nor the document has changed for half a second.
- **One page load serves the states, the hover pass and the focus pass**, as long as the page's document has not changed by itself since it settled. A page that a pass did change is loaded again for the next one.
- **A hash per element crosses the wire**, not its ${'`'}getComputedStyle${'`'} values; the values are read for the elements whose hashes differ.
- **The second look is aimed.** A page that differs is captured again after a fixed wait, and only a difference that is still there is reported; that second look takes the captures that differed and nothing else.

`;
}

if (r.detect) {
  const d = r.detect;
  md += `## What the proof finds

${d.mutations} copies of the site, each with one rule of the stylesheet changed, compared with the unchanged site in two ways:

- **Computed styles:** \`squawkcode compare\` with the light and dark states, a dark system setting and print as media states, one scripted action (the dialog opened), the hover pass and the keyboard-focus pass.
- **Screenshots:** a full-page screenshot of every page at both viewports, as loaded, compared pixel by pixel with pixelmatch at threshold 0.2 (what Playwright's \`toHaveScreenshot\` uses). This is what a visual regression suite does when it is set up in an afternoon; a suite can be taught more states, one screenshot each.

| Changed | Where it shows | Computed styles | Screenshots |
| --- | --- | :---: | :---: |
`;
  for (const row of d.rows) md += `| ${row.what} | ${row.where} | ${row.computedStyle ? 'found' : '**missed**'} | ${row.screenshot ? 'found' : 'missed'} |\n`;
  md += `| **${d.mutations} changes** | | **${d.computedStyle} found** | **${d.screenshot} found** |

A screenshot shows the page in one state; most of a stylesheet is about the others. What the screenshots miss here is everything that needs a pointer, a keyboard, a theme, a media query or a click, everything that is not painted, and everything below the threshold that keeps a screenshot comparison from failing on noise. The computed-style comparison has no threshold to tune, because it does not look at pixels: it reads what the browser computed for every element, and two sites either agree or they do not.

It also cannot tell you that a difference matters. A text colour one step of 255 away is reported like any other change; whether to accept it is a decision, and \`colourTolerance\` is where the line is drawn for colours that are written differently and mean the same.

`;
}

md += `## What to keep in mind

- The site is generated, by the authors of the tool. It is built to have the kinds of rules a real stylesheet has, not to favour a result; the generator is [\`benchmarks/site.mjs\`](../benchmarks/site.mjs), and a change to it is a pull request away.
- The comparison covers the pages, states and actions it is configured with. A rule for a state nobody listed is not seen by either method.
- No other renaming tool is measured here. Their output size depends on the names they give (the table above covers both kinds); what differs is what they do with a string they cannot classify, and that is not a number.
`;

fs.writeFileSync(path.join(here, '..', 'docs', 'benchmarks.md'), md);

// The README's summary, between its markers: the same numbers, in three sentences.
const lines = [];
if (r.size) {
  const [plain, hash, min] = ['plain', 'hash', 'min'].map((id) => r.size.find((x) => x.id === id));
  lines.push(`- **Size.** Minimal names make the benchmark site ${change(min.total.brotli, plain.total.brotli).replace('-', '')} smaller once compressed with Brotli (${kb(plain.total.brotli)} kB to ${kb(min.total.brotli)} kB of stylesheet, markup and script). Hashed names make it ${change(hash.total.brotli, plain.total.brotli).replace('+', '')} ${hash.total.brotli > plain.total.brotli ? 'larger' : 'smaller'}: a compressor removes what readable names share, and a hash shares nothing.`);
}
if (r.speed) {
  const s = r.speed;
  lines.push(`- **Speed.** The proof of ${s.pageViews} page views takes ${s.defaults.toFixed(1)} s with the defaults.${s.baseline ? ` The captures that took ${s.baseline.version} ${s.baseline.seconds.toFixed(1)} s take ${s.sameCapturesOneAtATime.toFixed(1)} s one page at a time, ${(s.baseline.seconds / s.sameCapturesOneAtATime).toFixed(1)} times less.` : ''}`);
}
if (r.detect) {
  const d = r.detect;
  lines.push(`- **What it finds.** Of ${d.mutations} single-rule changes to the stylesheet (hover, focus, dark theme, media queries, print, an opened dialog, unpainted properties, sub-pixel values), the computed-style comparison finds ${d.computedStyle} and a full-page screenshot comparison ${d.screenshot}.`);
}
const readmeFile = path.join(here, '..', 'README.md');
const readme = fs.readFileSync(readmeFile, 'utf8');
const [START, END] = ['<!-- benchmarks:start -->', '<!-- benchmarks:end -->'];
if (!readme.includes(START) || !readme.includes(END)) throw new Error('README.md has no benchmarks markers');
const summary = `On a generated site of ${int(r.site.components)} components and ${int(r.site.classes)} classes (${r.date}, Node ${r.machine.node}, ${r.machine.cores} cores):\n\n${lines.join('\n')}\n\nMethod, tables and what to keep in mind: [docs/benchmarks.md](docs/benchmarks.md). Run them yourself with \`npm run bench\`.`;
fs.writeFileSync(readmeFile, `${readme.slice(0, readme.indexOf(START) + START.length)}\n${summary}\n${readme.slice(readme.indexOf(END))}`);
console.log(`wrote docs/benchmarks.md (${md.length} characters)`);
