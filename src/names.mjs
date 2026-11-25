import { createHash } from 'node:crypto';

// Deterministic, collision-checked short names: same seed + same class => same hash, so browser caches survive a redeploy.
export function makeNamer(seed = 'squawkcode', prefix = 'h') {
  const used = new Map(); // hashed -> original
  return function nameFor(orig) {
    const digest = createHash('sha256').update(`${seed}:${orig}`).digest();
    for (let len = 5; len < 20; len++) {
      let n = 0n;
      for (const b of digest.subarray(0, 12)) n = (n << 8n) | BigInt(b);
      const s = prefix + n.toString(36).slice(0, len);
      const prior = used.get(s);
      if (prior === undefined || prior === orig) { used.set(s, orig); return s; }
    }
    throw new Error(`squawkcode: could not find a collision-free name for ${orig}`);
  };
}

const FIRST = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const REST = `${FIRST}0123456789_-`;

// The n-th shortest class name (0-based): a, b, … Z, aa, ab, … A name starts with a letter so it is a valid CSS
// identifier whatever follows; with a prefix (itself an identifier start) every character may be any of the 64.
export function sequenceName(n, prefix = '') {
  const first = prefix ? REST : FIRST;
  let length = 1; let block = first.length; let i = n;
  while (i >= block) { i -= block; length++; block *= 64; }
  let out = '';
  for (let k = 0; k < length - 1; k++) { out = REST[i % 64] + out; i = Math.floor(i / 64); }
  return prefix + first[i] + out;
}

// Minimal names: the class that is written most often gets the shortest name. A hash is the same in every build but
// costs its full length wherever the class appears; a ranked name costs one or two characters for the classes that
// make up most of the markup. `previous` (the map of an earlier run) keeps names stable between deploys: a class that
// had a name keeps it, new classes take the shortest names that are free.
export function assignMinNames(counts, { prefix = '', taken = new Set(), previous = {}, avoid = () => false } = {}) {
  if (prefix && !/^[A-Za-z_][\w-]*$/.test(prefix)) throw new Error(`squawkcode: prefix "${prefix}" is not the start of a CSS identifier`);
  const map = new Map();
  const used = new Set(taken);
  for (const name of counts.keys()) {
    const kept = previous[name];
    if (typeof kept === 'string' && /^[A-Za-z_][\w-]*$/.test(kept) && !used.has(kept) && !avoid(kept)) { map.set(name, kept); used.add(kept); }
  }
  const fresh = [...counts.keys()].filter((name) => !map.has(name)).sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  let next = 0;
  for (const name of fresh) {
    let candidate;
    do candidate = sequenceName(next++, prefix); while (used.has(candidate) || avoid(candidate));
    used.add(candidate);
    map.set(name, candidate);
  }
  return map;
}
