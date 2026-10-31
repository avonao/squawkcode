import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.SQUAWKCODE_CHROME,
  process.env.CLASSHASH_CHROME, // the name this tool had before it became SquawkCode
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

// Every Chrome this process started, stopped with it: a run that is interrupted (Ctrl-C, a killed task) would otherwise
// leave its headless browsers running.
const running = new Set();
const stopAll = () => { for (const p of running) p.kill(); };
process.on('exit', stopAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopAll(); process.exit(128 + os.constants.signals[signal]); });

export async function launchChrome(explicit) {
  const bin = [explicit, ...CHROME_CANDIDATES].filter(Boolean).find((p) => fs.existsSync(p));
  if (!bin) throw new Error('squawkcode: no Chrome found — set SQUAWKCODE_CHROME or config.compare.chrome');
  const port = 9300 + Math.floor(Math.random() * 600);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squawkcode-chrome-'));
  // Two instances capture side by side (compare runs A and B at once): keep a page that is not in front at full speed.
  const quiet = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  // No field trials and no seed or component downloads, so every launch has the same web platform features.
  const fixed = ['--disable-field-trial-config', '--disable-background-networking', '--disable-component-update'];
  const proc = spawn(bin, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--hide-scrollbars', ...quiet, ...fixed, 'about:blank'], { stdio: 'ignore' });
  running.add(proc); proc.on('exit', () => running.delete(proc));
  for (let i = 0; i < 80; i++) { try { await fetch(`http://localhost:${port}/json/version`); break; } catch { await sleep(150); } }
  const tab = await (await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(`${method}: ${JSON.stringify(d.error)}`)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page script failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  };
  await send('Page.enable');
  const close = () => { try { ws.close(); } catch {} proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { send, evaluate, close };
}
