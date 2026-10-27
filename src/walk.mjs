import fs from 'node:fs';
import path from 'node:path';

export function walkFiles(dir, { exclude = [], exts } = {}) {
  const out = [];
  (function rec(d) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (exclude.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile() && (!exts || exts.includes(path.extname(e.name)))) out.push(p);
    }
  })(dir);
  return out;
}
