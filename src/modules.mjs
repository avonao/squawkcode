// postcss and typescript are resolved from the site being processed first (its node_modules), so the site is parsed
// with the versions it builds with. SquawkCode's own copies are the fallback: for a project that has none, and for one
// whose TypeScript cannot parse (TypeScript 7 ships without the parser API).
import { createRequire } from 'node:module';
import path from 'node:path';

const own = createRequire(import.meta.url);
const USABLE = {
  typescript: (m) => typeof m?.createSourceFile === 'function' && typeof m?.forEachChild === 'function',
  postcss: (m) => typeof m?.parse === 'function',
};

const cache = new Map();
export function loadFrom(projectDir, name) {
  const key = `${projectDir}::${name}`;
  if (cache.has(key)) return cache.get(key);
  const usable = USABLE[name] ?? (() => true);
  let found;
  let reason = 'not installed';
  for (const req of [createRequire(path.join(path.resolve(projectDir), 'package.json')), own]) {
    try {
      const mod = req(name);
      if (usable(mod)) { found = mod; break; }
      reason = `the copy in ${projectDir} has no parser`;
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') reason = e.message;
    }
  }
  if (!found) throw new Error(`squawkcode: cannot load "${name}" (${reason}); install it in ${projectDir} or reinstall squawkcode`);
  cache.set(key, found);
  return found;
}
