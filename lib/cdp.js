'use strict';
// Driver mínimo de Chrome DevTools Protocol. Sin dependencias: WebSocket nativo de Node + Chrome local.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws, sessionId) { this.ws = ws; this.sessionId = sessionId; }
  send(method, params = {}, timeoutMs = 60000) {
    return this.ws.send(method, params, this.sessionId, timeoutMs);
  }
  async eval(expression, { awaitPromise = true, timeoutMs = 60000 } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, timeoutMs,
    }, timeoutMs + 5000);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval: ' + (d.exception?.description || d.text || 'error'));
    }
    return r.result?.value;
  }
  async goto(url, { settle = 900, timeoutMs = 45000 } = {}) {
    const loaded = this.ws.waitFor('Page.loadEventFired', this.sessionId, timeoutMs).catch(() => null);
    const nav = await this.send('Page.navigate', { url }, timeoutMs);
    if (nav.errorText) throw new Error('navegación: ' + nav.errorText);
    await loaded;
    if (settle) await sleep(settle);
    return nav;
  }
  async pdf({ width = 8.27, height = 11.69, margin = 0, scale = 1 } = {}) {
    const r = await this.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      paperWidth: width,
      paperHeight: height,
      marginTop: margin, marginBottom: margin, marginLeft: margin, marginRight: margin,
      scale,
    }, 120000);
    if (!r.data) throw new Error('printToPDF sin datos');
    return Buffer.from(r.data, 'base64');
  }
  async shot({ format = 'png', quality, width = 1280, height = 900 } = {}) {
    const r = await this.send('Page.captureScreenshot', {
      format, ...(quality && format === 'jpeg' ? { quality } : {}),
      clip: { x: 0, y: 0, width, height, scale: 1 },
      captureBeyondViewport: true,
    }, 60000);
    return Buffer.from(r.data, 'base64');
  }
  close() { return this.ws.call('Target.closeTarget', { targetId: this.targetId }).catch(() => {}); }
}

class WS {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => this._onMessage(ev));
  }
  _onMessage(ev) {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const key = `${msg.sessionId || ''}|${msg.method}`;
      const subs = this.listeners.get(key);
      if (subs) for (const fn of subs.slice()) fn(msg.params);
      const anyKey = `*|${msg.method}`;
      const anys = this.listeners.get(anyKey);
      if (anys) for (const fn of anys.slice()) fn(msg.params, msg.sessionId);
    }
  }
  call(method, params = {}, sessionId, timeoutMs = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  send(method, params, sessionId, timeoutMs) { return this.call(method, params, sessionId, timeoutMs); }
  waitFor(method, sessionId, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const key = `${sessionId || ''}|${method}`;
      const arr = this.listeners.get(key) || [];
      let timer;
      const fn = (params) => {
        clearTimeout(timer);
        const cur = this.listeners.get(key) || [];
        this.listeners.set(key, cur.filter((f) => f !== fn));
        resolve(params);
      };
      timer = setTimeout(() => {
        const cur = this.listeners.get(key) || [];
        this.listeners.set(key, cur.filter((f) => f !== fn));
        resolve(null);
      }, timeoutMs);
      arr.push(fn);
      this.listeners.set(key, arr);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function launch({ port = 0, ua = UA_DESKTOP, width = 1440, height = 1000, args = [] } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosko-chrome-'));
  const argv = [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-networking', '--disable-component-update',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
    '--hide-scrollbars', '--mute-audio',
    '--window-size=' + width + ',' + height,
    '--user-agent=' + ua,
    ...args,
    'about:blank',
  ];
  const child = spawn(CHROME, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
  let wsUrl = null;
  const deadline = Date.now() + 25000;
  child.stderr.setEncoding('utf8');
  let buf = '';
  child.stderr.on('data', (chunk) => {
    buf += chunk;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m && !wsUrl) wsUrl = m[1];
  });
  while (!wsUrl && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('Chrome murió al arrancar');
    await sleep(60);
  }
  if (!wsUrl) throw new Error('Chrome no expuso DevTools');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket CDP falló')), { once: true });
    setTimeout(() => rej(new Error('WebSocket CDP timeout')), 15000);
  });
  const drv = new WS(ws);
  drv.userDataDir = userDataDir;
  drv.proc = child;
  drv.base = wsUrl.replace(/\/devtools\/browser\/.*$/, '');
  drv.kill = async () => {
    drv.close();
    try { child.kill('SIGKILL'); } catch {}
    await sleep(120);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };
  return drv;
}

async function newPage(drv, { ua, width = 1440, height = 1000 } = {}) {
  const { targetId } = await drv.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await drv.call('Target.attachToTarget', { targetId, flatten: true });
  const s = new Session(drv, sessionId);
  s.targetId = targetId;
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  }).catch(() => {});
  if (ua) await s.send('Network.setUserAgentOverride', { userAgent: ua }).catch(() => {});
  return s;
}

// Bloquea peticiones de anuncios/analítica: menos ruido y carga más rápida.
const BLOCK_PATTERNS = [
  'doubleclick.net', 'googlesyndication', 'googletagmanager', 'google-analytics',
  'adservice', '/ads/', 'adsystem', 'taboola', 'outbrain', 'criteo', 'amazon-adsystem',
  'facebook.net', 'hotjar', 'chartbeat', 'permutive', 'didomi', 'privacy-center',
  'scorecardresearch', 'teads', 'pubmatic', 'rubiconproject', 'smartclip', 'prebid',
];

async function blockNoise(s) {
  await s.send('Network.enable');
  const patterns = BLOCK_PATTERNS.map((p) => ({ urlPattern: '*' + p + '*', requestStage: 'Request' }));
  await s.send('Fetch.enable', { patterns }).catch(() => {});
  const key = `${s.sessionId}|Fetch.requestPaused`;
  const drv = s.ws;
  const arr = drv.listeners.get(key) || [];
  const handler = (params) => {
    if (/\.(png|jpe?g|webp|gif|svg|avif|css|woff2?|ttf)(\?|$)/i.test(params.request.url)) {
      s.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    } else {
      s.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  };
  arr.push(handler);
  drv.listeners.set(key, arr);
}

module.exports = { launch, newPage, blockNoise, sleep, UA_DESKTOP, CHROME };
