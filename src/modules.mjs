// postcss and typescript are not bundled: they are resolved from the site being processed (its node_modules), so the
// tool needs no install of its own and always parses with the same versions the site builds with.
import { createRequire } from 'node:module';
import path from 'node:path';

const cache = new Map();
export function loadFrom(projectDir, name) {
  const key = `${projectDir}::${name}`;
  if (cache.has(key)) return cache.get(key);
  const req = createRequire(path.join(path.resolve(projectDir), 'package.json'));
  let mod;
  try { mod = req(name); } catch (e) { throw new Error(`squawkcode: cannot load "${name}" from ${projectDir} (is it installed there?): ${e.message}`); }
  cache.set(key, mod);
  return mod;
}
