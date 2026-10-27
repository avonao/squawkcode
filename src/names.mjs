import { createHash } from 'node:crypto';

// Deterministic, collision-checked short names: same seed + same class => same hash, so browser caches survive a redeploy.
export function makeNamer(seed = 'classhash', prefix = 'h') {
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
    throw new Error(`classhash: could not find a collision-free name for ${orig}`);
  };
}
