#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { transformTree, copyProject, formatIssues } from '../src/transform.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name, def) => { const i = args.indexOf(`--${name}`); if (i < 0) return def; const v = args[i + 1]; return v && !v.startsWith('--') ? v : true; };

const HELP = `squawkcode — hash CSS class names in a copy of a site, and prove the look did not change

  squawkcode transform --project <dir> [--config f] [--out <dir>] [--allow-issues]
        copy the project, hash class names in the copy, write <out>/${'squawkcode-map.json'}; exit 1 on anything it cannot rewrite with certainty
  squawkcode compare --config <f> --a <baseUrl> --b <baseUrl>
        headless-Chrome computed-style diff of two running copies of the site
  squawkcode gate --project <dir> [--config f]
        transform + build both copies + serve + compare; exit 0 only when identical. Leaves the hashed tree for deploy.
  squawkcode init --project <dir>
        write a starter squawkcode.config.json
`;

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { console.log(HELP); return 0; }
  const project = path.resolve(flag('project', process.cwd()));
  if (cmd === 'init') {
    const f = path.join(project, 'squawkcode.config.json');
    if (fs.existsSync(f)) { console.error(`${f} exists`); return 1; }
    fs.writeFileSync(f, JSON.stringify({ srcDirs: ['components'], keep: [], keepPrefixes: [], ambiguous: {}, build: { cmd: 'npm run build' }, serve: { cmd: 'npx next start -p {port}' }, compare: { pages: ['/'] } }, null, 2) + '\n');
    console.log(`wrote ${f}`); return 0;
  }
  const cfg = loadConfig(project, flag('config'));
  if (cmd === 'transform') {
    const out = path.resolve(flag('out', fs.mkdtempSync(path.join(os.tmpdir(), 'squawkcode-'))));
    copyProject(project, out, cfg.copyExclude);
    const r = transformTree(out, cfg, { moduleDir: project, log: (m) => console.log(m) });
    const mapPath = path.join(out, cfg.mapFile);
    fs.writeFileSync(mapPath, JSON.stringify({ seed: cfg.seed, map: Object.fromEntries(r.map), kept: Object.fromEntries(r.keep) }, null, 2));
    console.log(`rewrote ${r.changedFiles} files in ${out}\nmap: ${mapPath}`);
    if (r.issues.length) {
      console.error(`\n${r.issues.length} thing(s) squawkcode will not guess at:\n${formatIssues(r.issues)}\n`);
      if (!flag('allow-issues')) return 1;
    }
    return 0;
  }
  if (cmd === 'compare') {
    const { compareSites } = await import('../src/compare.mjs');
    return await compareSites(cfg.compare, { a: flag('a'), b: flag('b'), out: flag('out') });
  }
  if (cmd === 'gate') {
    const { gate } = await import('../src/gate.mjs');
    return await gate(project, cfg);
  }
  console.error(HELP); return 2;
}
main().then((c) => process.exit(c ?? 0), (e) => { console.error(e.stack || e.message); process.exit(1); });
