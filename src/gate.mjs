import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transformTree, copyProject, formatIssues, previousMap, renamer } from './transform.mjs';
import { compareSites } from './compare.mjs';
import { sleep } from './cdp.mjs';

const run = (cmd, cwd, env, label) => new Promise((resolve, reject) => {
  const p = spawn(cmd, { cwd, shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${label} failed (exit ${c}) in ${cwd}`))));
});

async function serve(cmd, cwd, port, env, readyPath, timeoutSec) {
  const p = spawn(cmd.replaceAll('{port}', String(port)), { cwd, shell: true, detached: true, env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' });
  const stop = () => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} };
  for (let i = 0; i < timeoutSec * 2; i++) {
    try { const r = await fetch(`http://localhost:${port}${readyPath}`); if (r.status < 500) return stop; } catch {}
    await sleep(500);
  }
  stop(); throw new Error(`server on :${port} not ready after ${timeoutSec}s (${cmd})`);
}

// Two copies of the project: plain (built as-is) and hashed. Same build, same server, compared in Chrome.
export async function gate(project, cfg, { saveMap = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'squawkcode-gate-'));
  const plain = path.join(base, 'plain'), hashed = path.join(base, 'hashed');
  const exclude = cfg.copyExclude.filter((x) => x !== 'node_modules');
  for (const d of [plain, hashed]) {
    copyProject(project, d, exclude.concat('node_modules'));
    const nm = path.join(project, 'node_modules');
    if (fs.existsSync(nm)) { try { execFileSync("cp", ["-cR", nm, path.join(d, "node_modules")], { stdio: "ignore" }); } catch { fs.symlinkSync(nm, path.join(d, 'node_modules')); } }
  }
  const r = transformTree(hashed, cfg, { moduleDir: project, log: (m) => console.log(m), previous: previousMap(project, cfg) });
  fs.writeFileSync(path.join(hashed, cfg.mapFile), JSON.stringify({ names: cfg.names, seed: cfg.seed, map: Object.fromEntries(r.map), kept: Object.fromEntries(r.keep) }, null, 2));
  if (r.issues.length) { console.error(`\n${r.issues.length} thing(s) squawkcode will not guess at:\n${formatIssues(r.issues)}\n`); return 1; }
  console.log(`renamed ${r.map.size} classes in ${r.changedFiles} files`);
  // The two copies share nothing, so they build side by side unless the configuration says one after the other.
  if (cfg.build.parallel === false) {
    await run(cfg.build.cmd, plain, cfg.build.env, 'plain build');
    await run(cfg.build.cmd, hashed, cfg.build.env, 'hashed build');
  } else await Promise.all([run(cfg.build.cmd, plain, cfg.build.env, 'plain build'), run(cfg.build.cmd, hashed, cfg.build.env, 'hashed build')]);
  const s = cfg.serve, stops = [];
  try {
    stops.push(await serve(s.cmd, plain, s.portPlain, s.env, s.readyPath, s.readyTimeoutSec));
    stops.push(await serve(s.cmd, hashed, s.portHashed, s.env, s.readyPath, s.readyTimeoutSec));
    // The renamed copy is told about states, hover selectors and action scripts in its own names.
    const code = await compareSites(cfg.compare, { a: `http://localhost:${s.portPlain}`, b: `http://localhost:${s.portHashed}`, out: path.join(base, 'compare.json'), rename: renamer(r.map, cfg, project) });
    console.log(code === 0 ? `\nPASS — renamed tree for deploy: ${hashed}` : `\nFAIL — trees kept in ${base}`);
    // The map is only saved into the project for a tree that passed: it is what the next deploy's names follow.
    if (code === 0 && saveMap) { const f = path.join(project, cfg.namesFrom ?? cfg.mapFile); fs.copyFileSync(path.join(hashed, cfg.mapFile), f); console.log(`saved the map to ${f}`); }
    return code;
  } finally { stops.forEach((f) => f()); }
}
