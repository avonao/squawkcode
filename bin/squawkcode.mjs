#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { transformTree, copyProject, formatIssues, previousMap, renamer } from '../src/transform.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name, def) => { const i = args.indexOf(`--${name}`); if (i < 0) return def; const v = args[i + 1]; return v && !v.startsWith('--') ? v : true; };

const HELP = `squawkcode — rename CSS class names in a copy of a site, and prove the look did not change

  squawkcode transform --project <dir> [--config f] [--out <dir>] [--allow-issues] [--save-map]
        copy the project, rename class names in the copy, write <out>/${'squawkcode-map.json'}; exit 1 on anything it
        cannot rewrite with certainty. --save-map also writes the map into the project (with "names": "min" the next
        run reads it there, so a class keeps its name between deploys)
  squawkcode compare --config <f> --a <baseUrl> --b <baseUrl> [--out report.json] [--concurrency n] [--map <file>]
        headless-Chrome computed-style diff of two running copies of the site. --map: side B is a renamed copy, and
        that is its class map (states, hover selectors and action scripts are rewritten for it)
  squawkcode gate --project <dir> [--config f] [--save-map]
        transform + build both copies + serve + compare; exit 0 only when identical. Leaves the renamed tree for deploy.
  squawkcode explain <name> [--project <dir>] [--map <file>]
        what a renamed class was called, or what a class is renamed to (from the map of the last run)
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
  if (cmd === 'explain') {
    const name = args.find((a) => !a.startsWith('--') && a !== flag('project') && a !== flag('map') && a !== flag('config'));
    if (!name) { console.error('squawkcode explain needs a class name'); return 2; }
    const file = path.resolve(flag('map', path.join(project, cfg.mapFile)));
    if (!fs.existsSync(file)) { console.error(`no class map at ${file} (squawkcode transform writes one; --map names another)`); return 1; }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const lines = [];
    if (Object.hasOwn(data.map ?? {}, name)) lines.push(`${name} is renamed to ${data.map[name]}`);
    for (const [orig, renamed] of Object.entries(data.map ?? {})) if (renamed === name) lines.push(`${name} was ${orig}`);
    if (Object.hasOwn(data.kept ?? {}, name)) lines.push(`${name} keeps its name: ${data.kept[name]}`);
    if (!lines.length) { console.error(`${name} is not in ${file}`); return 1; }
    console.log(lines.join('\n')); return 0;
  }
  const saveMap = (r) => {
    const body = JSON.stringify({ names: cfg.names, seed: cfg.seed, map: Object.fromEntries(r.map), kept: Object.fromEntries(r.keep) }, null, 2);
    if (flag('save-map')) { const f = path.join(project, cfg.namesFrom ?? cfg.mapFile); fs.writeFileSync(f, body + '\n'); console.log(`saved the map to ${f}`); }
    return body;
  };
  if (cmd === 'transform') {
    const out = path.resolve(flag('out', fs.mkdtempSync(path.join(os.tmpdir(), 'squawkcode-'))));
    copyProject(project, out, cfg.copyExclude);
    const r = transformTree(out, cfg, { moduleDir: project, log: (m) => console.log(m), previous: previousMap(project, cfg) });
    const mapPath = path.join(out, cfg.mapFile);
    fs.writeFileSync(mapPath, saveMap(r));
    console.log(`rewrote ${r.changedFiles} files in ${out}\nmap: ${mapPath}`);
    if (r.issues.length) {
      console.error(`\n${r.issues.length} thing(s) squawkcode will not guess at:\n${formatIssues(r.issues)}\n`);
      if (!flag('allow-issues')) return 1;
    }
    return 0;
  }
  if (cmd === 'compare') {
    const { compareSites } = await import('../src/compare.mjs');
    // --map: side B is a renamed copy; states, hover selectors and action scripts are rewritten for it from that map
    let rename;
    if (flag('map')) {
      const data = JSON.parse(fs.readFileSync(path.resolve(flag('map')), 'utf8'));
      rename = renamer(new Map(Object.entries(data.map ?? {})), cfg, project);
    }
    return await compareSites(cfg.compare, { a: flag('a'), b: flag('b'), out: flag('out'), concurrency: flag('concurrency'), rename });
  }
  if (cmd === 'gate') {
    const { gate } = await import('../src/gate.mjs');
    return await gate(project, cfg, { saveMap: Boolean(flag('save-map')) });
  }
  console.error(HELP); return 2;
}
main().then((c) => process.exit(c ?? 0), (e) => { console.error(e.stack || e.message); process.exit(1); });
