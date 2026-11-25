// A static file server for the generated site: `node serve.mjs <dir> <port>`, or serve(dir, port) from code.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

/**
 * @param {string} dir
 * @param {number} port 0 picks a free one
 * @param {{ delayMs?: number }} [options] delayMs: answer every request this much later (a slow server)
 * @returns {Promise<{ url: string, port: number, hits: Map<string, number>, close: () => Promise<void> }>} hits: requests per path
 */
export function serve(dir, port = 0, { delayMs = 0 } = {}) {
  const root = path.resolve(dir);
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    let file = path.join(root, pathname);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    const answer = () => {
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
      });
    };
    if (delayMs) setTimeout(answer, delayMs); else answer();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ url: `http://127.0.0.1:${actual}`, port: actual, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, port] = process.argv.slice(2);
  const s = await serve(dir, Number(port));
  console.log(`serving ${dir} on ${s.url}`);
}
