'use strict';
// Servidor local del kiosko: recibe la orden de "actualizar" desde la web y lanza el build.
// Expuesto al exterior por Tailscale Funnel en https://<host>.ts.net/kiosko

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const PORT = parseInt(process.env.KIOSKO_PORT || '4780', 10);
const PUBLIC_URL = process.env.KIOSKO_URL || 'https://mac-mini-de-paul.tail790c0b.ts.net/kiosko';
const MIN_GAP_MS = 3 * 60 * 1000;   // no relanzar antes de 3 minutos
const MAX_RUN_MS = 30 * 60 * 1000;  // cortar si se cuelga

const state = {
  building: false,
  startedAt: null,
  last: null,        // { at, exitCode, ok, ms, pdfs, error }
  lastTriggerAt: 0,
  logFile: path.join(ROOT, '.tmp', 'refresh.log'),
};
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });

function writeEndpoint() {
  const p = path.join(ROOT, 'data', 'endpoint.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ url: PUBLIC_URL, updatedAt: new Date().toISOString() }, null, 1));
}

function countPdfs() {
  const data = path.join(ROOT, 'data');
  if (!fs.existsSync(data)) return 0;
  let n = 0;
  for (const d of fs.readdirSync(data)) {
    const dp = path.join(data, d);
    if (!fs.statSync(dp).isDirectory()) continue;
    for (const s of fs.readdirSync(dp)) {
      const sp = path.join(dp, s);
      if (!fs.statSync(sp).isDirectory()) continue;
      const idx = path.join(sp, 'index.json');
      if (fs.existsSync(idx)) {
        try { n += JSON.parse(fs.readFileSync(idx, 'utf8')).ok || 0; } catch {}
      }
    }
  }
  return n;
}

function runBuild(trigger) {
  if (state.building) return { ok: false, code: 409, body: { error: 'Ya se está actualizando', building: true } };
  const gap = Date.now() - state.lastTriggerAt;
  if (gap < MIN_GAP_MS) {
    return { ok: false, code: 429, body: { error: 'Espera un poco antes de volver a actualizar', retryInSec: Math.ceil((MIN_GAP_MS - gap) / 1000) } };
  }
  state.building = true;
  state.startedAt = Date.now();
  state.lastTriggerAt = Date.now();
  const t0 = Date.now();
  const out = fs.createWriteStream(state.logFile, { flags: 'w' });
  out.write(`# ${new Date().toISOString()} refresco manual (${trigger})\n`);
  const child = spawn(process.execPath, [path.join(ROOT, 'build.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, MAX_RUN_MS);

  const finish = (code, error) => {
    clearTimeout(timer);
    state.building = false;
    const ms = Date.now() - t0;
    state.last = { at: new Date().toISOString(), exitCode: code, ok: code === 0, ms, pdfs: countPdfs(), error: error || null };
    out.end(`\n# fin ${new Date().toISOString()} code=${code} ${ms}ms\n`);
  };
  child.on('exit', (code) => finish(code, null));
  child.on('error', (e) => finish(-1, e.message));
  return { ok: true, code: 202, body: { started: true, at: new Date(state.startedAt).toISOString() } };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/^\/kiosko/, '') || '/';

  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (route === '/' || route === '/health') {
    return json(res, 200, {
      ok: true, service: 'kiosko', building: state.building,
      last: state.last, endpoint: PUBLIC_URL, now: new Date().toISOString(),
    });
  }

  if (route === '/status') {
    return json(res, 200, {
      building: state.building,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      elapsedMs: state.building ? Date.now() - state.startedAt : 0,
      last: state.last,
      cooldownSec: Math.max(0, Math.ceil((MIN_GAP_MS - (Date.now() - state.lastTriggerAt)) / 1000)),
    });
  }

  if (route === '/refresh') {
    if (req.method !== 'POST') return json(res, 405, { error: 'usa POST' });
    const r = runBuild(req.headers['user-agent'] || 'web');
    return json(res, r.code, r.body);
  }

  if (route === '/log') {
    try {
      const txt = fs.readFileSync(state.logFile, 'utf8').split('\n').slice(-80).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(txt);
    } catch { return json(res, 404, { error: 'sin log' }); }
  }

  json(res, 404, { error: 'ruta desconocida', routes: ['/', '/health', '/status', 'POST /refresh', '/log'] });
});

server.listen(PORT, '127.0.0.1', () => {
  writeEndpoint();
  console.log(`[kiosko] escuchando en http://127.0.0.1:${PORT} · público ${PUBLIC_URL}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}
