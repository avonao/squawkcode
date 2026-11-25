import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.SQUAWKCODE_CHROME,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squawkcode-chrome-'));
  // Two instances capture side by side (compare runs A and B at once): keep a page that is not in front at full speed.
  const quiet = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  // No field trials and no seed or component downloads, so every launch has the same web platform features.
  const fixed = ['--disable-field-trial-config', '--disable-background-networking', '--disable-component-update'];
  // Chrome's sandbox needs user namespaces, which CI containers often lack, and it refuses to run as root at all.
  // There (and with SQUAWKCODE_NO_SANDBOX=1) it runs without; the pages it loads are the two copies of your own site.
  const sandbox = process.env.CI || process.env.SQUAWKCODE_NO_SANDBOX === '1' || process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  // Chrome is driven over two pipes (file descriptors 3 and 4), not over a port: nothing listens anywhere, any
  // number of browsers can start at once, and there is nothing to wait for before the first command. A message is
  // JSON followed by a zero byte.
  const proc = spawn(bin, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${dir}`, '--no-first-run', '--hide-scrollbars', ...sandbox, ...quiet, ...fixed, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  running.add(proc); proc.on('exit', () => running.delete(proc));
  const [toChrome, fromChrome] = [proc.stdio[3], proc.stdio[4]];
  let id = 0; const pending = new Map(); const listeners = new Map();
  let session = null; // the tab's session; commands and events of the page carry it
  const receive = (text) => {
    const d = JSON.parse(text);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method && d.sessionId === session) for (const fn of listeners.get(d.method) ?? []) fn(d.params);
  };
  let parts = []; // the message that is arriving, as it came
  fromChrome.setEncoding('utf8');
  fromChrome.on('data', (chunk) => {
    let start = 0;
    for (let end = chunk.indexOf('\0'); end !== -1; end = chunk.indexOf('\0', start)) {
      parts.push(chunk.slice(start, end));
      receive(parts.join(''));
      parts = []; start = end + 1;
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  });
  toChrome.on('error', () => {}); // a browser that has gone: the pending commands say so
  let exited = null;
  proc.on('exit', (code, signal) => {
    exited = `exited (${signal ?? `code ${code}`})`;
    for (const answer of pending.values()) answer({ error: { message: `Chrome ${exited}` } });
    pending.clear();
  });
  const command = (method, params, sessionId) => new Promise((res, rej) => {
    if (exited) { rej(new Error(`${method}: Chrome ${exited}`)); return; }
    const i = ++id;
    pending.set(i, (d) => (d.error ? rej(new Error(`${method}: ${JSON.stringify(d.error)}`)) : res(d.result)));
    toChrome.write(`${JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params })}\0`);
  });
  try {
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    ({ sessionId: session } = await command('Target.attachToTarget', { targetId, flatten: true }));
  } catch (err) {
    proc.kill();
    throw new Error(`squawkcode: ${bin} did not start as a browser to drive (${err.message}). In a container or as root it needs to run without its sandbox: SQUAWKCODE_NO_SANDBOX=1`);
  }
  const send = (method, params = {}) => command(method, params, session);
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page script failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  };
  await send('Page.enable');
  // Which requests are under way, and when the network last did anything: what "the page has settled" is read from.
  // Streams that never end (server-sent events, sockets) and beacons are not waited for.
  const network = { open: new Set(), last: Date.now(), reset() { this.open.clear(); this.last = Date.now(); }, idleFor() { return this.open.size ? 0 : Date.now() - this.last; } };
  const ENDLESS = new Set(['EventSource', 'WebSocket', 'Ping', 'CSPViolationReport']);
  on('Network.requestWillBeSent', (e) => { if (ENDLESS.has(e.type) || e.request?.url?.startsWith('data:')) return; network.open.add(e.requestId); network.last = Date.now(); });
  for (const done of ['Network.loadingFinished', 'Network.loadingFailed']) on(done, (e) => { if (network.open.delete(e.requestId)) network.last = Date.now(); });
  await send('Network.enable');
  const close = () => { try { toChrome.end(); } catch {} proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { send, evaluate, on, network, close };
}
