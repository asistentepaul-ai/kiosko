'use strict';
// Captura de la portada real de un diario + zonas clicables sobre cada noticia.
// Devuelve { img: 'front.webp', w, h, hotspots: [{ slug, title, x, y, w, h }] }

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { UA_DESKTOP, sleep } = require('./cdp');

const WIDTH = 1400;
const MAX_H = 5200;      // tope de alto capturado
const MIN_BOX = 44;      // lado mínimo de una zona clicable

function curlHtml(url) {
  try {
    return execFileSync('curl', [
      '-sL', '--max-time', '35', '--compressed',
      '-A', UA_DESKTOP,
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: es-ES,es;q=0.9,en;q=0.6',
      url,
    ], { maxBuffer: 80 * 1024 * 1024 }).toString('utf8');
  } catch { return ''; }
}

// Deja el HTML listo para pintarse desde disco: sin scripts, con base y con las
// imágenes perezosas convertidas en imágenes normales.
function prepareHtml(html, baseUrl, dest, opts = {}) {
  let h = String(html);
  h = h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  h = h.replace(/<link\b[^>]*rel=["']?preload["']?[^>]*>/gi, '');
  h = h.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
  // lazy-load -> src real
  h = h.replace(/\s(data-src|data-original|data-lazy-src|data-lazyload|data-img|data-url)\s*=\s*(["'])([^"']+)\2/gi,
    (m, attr, q, val) => (attr === 'data-url' ? m : ` src="${val}"`));
  h = h.replace(/\s(data-srcset|data-lazy-srcset)\s*=\s*(["'])([^"']+)\2/gi, (m, a, q, val) => ` srcset="${val}"`);
  h = h.replace(/\sloading\s*=\s*(["'])[^"']*\1/gi, '');
  h = h.replace(/\sdecoding\s*=\s*(["'])[^"']*\1/gi, '');
  const css = `<style id="kiosko-shot">
    html{scroll-behavior:auto!important}
    img,video,picture{opacity:1!important;visibility:visible!important}
    [class*="cookie"],[id*="cookie"],[class*="consent"],[id*="consent"],
    [class*="Cookie"],[id*="didomi"],[class*="didomi"],[class*="cmp-"],
    [class*="newsletter"][class*="modal"],[class*="paywall-modal"],
    [class*="subscription"][class*="modal"],[class*="overlay"][class*="consent"],
    [aria-label*="cookies"],[id*="onetrust"],[class*="onetrust"]{display:none!important}
    [class*="sticky"]{position:static!important}
    ${opts.css || ''}
  </style>`;
  const base = `<base href="${baseUrl}">`;
  if (/<head[^>]*>/i.test(h)) h = h.replace(/<head([^>]*)>/i, `<head$1>${base}${css}`);
  else h = base + css + h;
  fs.writeFileSync(dest, h, 'utf8');
  return 'file://' + dest;
}

// JS que corre en la página: mide el documento y devuelve las zonas de las noticias.
const ZONES_JS = (urls, maxH) => `(() => {
  const want = ${JSON.stringify(urls)};
  const norm = (u) => {
    try {
      const x = new URL(u, document.baseURI);
      return (x.host.replace(/^www\\./, '') + x.pathname.replace(/\\/+$/, '')).toLowerCase();
    } catch { return ''; }
  };
  const targets = new Map();
  for (const u of want) targets.set(norm(u), u);

  const anchors = [...document.querySelectorAll('a[href]')];
  const hits = [];
  for (const a of anchors) {
    const key = norm(a.getAttribute('href'));
    if (!key || !targets.has(key)) continue;
    if (!a.offsetParent && a.getClientRects().length === 0) continue;
    // Sube hasta la tarjeta: el padre que añade foto/entradilla sin tragarte la página.
    let box = a;
    for (let i = 0; i < 4; i++) {
      const p = box.parentElement;
      if (!p || p === document.body) break;
      const links = p.querySelectorAll('a[href]').length;
      if (links > 3) break;
      const r = p.getBoundingClientRect();
      if (r.width * r.height > 1.6 * (box.getBoundingClientRect().width * box.getBoundingClientRect().height) + 120000) break;
      box = p;
    }
    const r = box.getBoundingClientRect();
    if (r.width < ${MIN_BOX} || r.height < ${MIN_BOX}) continue;
    const top = r.top + window.scrollY;
    if (top < 0 || top > ${maxH}) continue;
    hits.push({ u: targets.get(key), x: Math.round(r.left + window.scrollX), y: Math.round(top),
                w: Math.round(r.width), h: Math.round(r.height), area: r.width * r.height });
  }
  // De menor a mayor área: las tarjetas pequeñas reservan su sitio primero y las
  // grandes no las tapan. Una zona se descarta si ya está mayormente ocupada.
  hits.sort((a, b) => a.area - b.area);
  const kept = [];
  for (const h of hits) {
    if (kept.some((k) => k.u === h.u)) continue;
    kept.push(h);
  }
  const out = [];
  for (const h of kept) {
    let covered = 0;
    for (const o of out) {
      const ix = Math.max(0, Math.min(o.x + o.w, h.x + h.w) - Math.max(o.x, h.x));
      const iy = Math.max(0, Math.min(o.y + o.h, h.y + h.h) - Math.max(o.y, h.y));
      covered += ix * iy;
    }
    if (covered > 0.45 * (h.w * h.h)) continue;
    out.push(h);
  }
  const de = document.documentElement;
  const b = document.body;
  return {
    hits: out,
    docW: Math.max(de ? de.scrollWidth : 0, b ? b.scrollWidth : 0),
    docH: Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0),
  };
})()`;

// Pulsa el botón que cierra el muro de cookies, como haría un lector. Evita los
// botones que además suscriben («Rechazar y suscribirse» de El Mundo y similares).
const DISMISS_JS = `(() => {
  const bad = /suscr[ií]b|premium|pagar|comprar/i;
  const accept = /^(aceptar|aceptar y continuar|aceptar todo|acepto|de acuerdo|consentir|permitir|entendido|ok)/i;
  const btns = [...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"],a')];
  let pressed = null;
  for (const b of btns) {
    const t = ((b.innerText || b.value || '') + '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 40) continue;
    if (bad.test(t)) continue;
    if (!accept.test(t)) continue;
    const r = b.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    try { b.click(); pressed = t; break; } catch {}
  }
  return pressed;
})()`;

const CLEAN_JS = (urls = []) => `(() => {
  const MODAL = /cookie|consent|cmp|didomi|onetrust|trustarc|privacidad|aviso legal|suscr[ií]b|suscripci|bolet[ií]n|newsletter|paywall|muro|registro|inicia sesi|aceptar y|rechazar/i;
  const nrm = (u) => { try { const x = new URL(u, document.baseURI); return (x.host.replace(/^www\\./, '') + x.pathname.replace(/\\/+$/, '')).toLowerCase(); } catch { return ''; } };
  const keep = new Set(${JSON.stringify(urls)}.map(nrm));
  // Nunca tocamos un contenedor que lleve dentro una de las noticias del día.
  const holdsNews = (e) => {
    if (!keep.size) return false;
    for (const a of e.querySelectorAll('a[href]')) {
      if (keep.has(nrm(a.getAttribute('href')))) return true;
    }
    return false;
  };
  let n = 0;
  const roots = [document];
  for (const e of document.querySelectorAll('*')) if (e.shadowRoot) roots.push(e.shadowRoot);
  for (const root of roots) {
    const all = root.querySelectorAll('*');
    for (const e of all) {
      if (e === document.body || e === document.documentElement) continue;
      let cs; try { cs = getComputedStyle(e); } catch { continue; }
      const fixedish = cs.position === 'fixed' || cs.position === 'sticky';
      const z = parseInt(cs.zIndex, 10) || 0;
      const r = e.getBoundingClientRect();
      const idc = (e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : '');
      let txt = '';
      try { txt = (e.innerText || '').slice(0, 260); } catch {}
      const looksModal = MODAL.test(idc) || MODAL.test(txt);
      const vpArea = innerWidth * innerHeight;
      const bigCover = r.width * r.height > vpArea * 0.10;
      const isIframe = e.tagName === 'IFRAME';
      if (isIframe && (bigCover || z > 50)) { e.remove(); n++; continue; }
      if (fixedish && (looksModal || bigCover || z > 500)) { e.remove(); n++; continue; }
      if (z > 900 && r.width > innerWidth * 0.45 && r.height > 60) { e.remove(); n++; continue; }
      if (looksModal && bigCover && (z > 20 || fixedish) && r.width * r.height < vpArea * 0.6) { e.remove(); n++; continue; }
      // Diálogo con botones (boletín, cookies, suscripción) aunque sea pequeño.
      const hasCta = !!e.querySelector('button, [role="button"], input[type="submit"], a[class*="btn"], a[class*="button"]');
      if (looksModal && hasCta && r.width * r.height > vpArea * 0.008 && r.width * r.height < vpArea * 0.6) { e.remove(); n++; continue; }
      // Capa flotante con z-index alto que no es la cabecera del diario: fuera.
      const isHeader = r.top <= 12 && r.height < 130 && r.width > innerWidth * 0.7;
      if (!isHeader && (cs.position === 'fixed' || cs.position === 'absolute') && z >= 100
          && r.width * r.height > innerWidth * innerHeight * 0.02) { e.remove(); n++; continue; }
    }
  }
  // deja el documento en su flujo natural
  for (const e of document.querySelectorAll('[style*="position: fixed"],[style*="position:fixed"]')) { e.remove(); n++; }
  document.documentElement.style.overflow = 'visible';
  document.body.style.overflow = 'visible';
  return n;
})()`;

/**
 * @param page     sesión CDP
 * @param paper    { slug, front }
 * @param items    [{ url, title, slug, ... }] noticias que ya tienen PDF
 * @param outDir   carpeta del diario para el día
 */
async function captureFront(page, paper, items, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 1600, deviceScaleFactor: 1, mobile: false,
  }).catch(() => {});

  const urls = items.map((i) => i.url);
  let measured = null;
  let local = null;

  // 1) en vivo: es lo que ve el lector, pero algunos diarios bloquean el headless
  if (paper.shotMode !== 'snapshot') {
    try {
      await page.goto(paper.front, { settle: 3000, timeoutMs: 60000 });
      await page.eval(`(async () => {
        for (let y = 0; y < 6000; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 140)); }
        window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 500)); return true;
      })()`, { timeoutMs: 30000 }).catch(() => {});
      await page.eval(DISMISS_JS).catch(() => {});
      await sleep(900);
      await page.eval(CLEAN_JS(urls)).catch(() => {});
      const m = await page.eval(ZONES_JS(urls, MAX_H), { timeoutMs: 45000 });
      if (process.env.KO_DEBUG) console.error(`  [dbg live] hits=${m ? m.hits.length : 'null'} docH=${m ? m.docH : '-'}`);
      if (m && m.hits.length >= 6 && m.docH > 1200) measured = m;
    } catch (e) { if (process.env.KO_DEBUG) console.error('  [dbg live] excepción:', e.message); }
  }

  // 2) instantánea por curl: sirve lo mismo que descargamos, sin detección
  if (!measured) {
    const html = curlHtml(paper.front);
    if (!html || html.length < 5000) return null;
    const dest = path.join(outDir, '_front.html');
    local = prepareHtml(html, paper.front, dest);
    await page.goto(local, { settle: 2500, timeoutMs: 60000 });
    await page.eval(DISMISS_JS).catch(() => {});
    await sleep(600);
    await page.eval(CLEAN_JS(urls)).catch(() => {});
    measured = await page.eval(ZONES_JS(urls, MAX_H), { timeoutMs: 45000 });
    try { fs.unlinkSync(dest); } catch {}
  }
  if (!measured) return null;

  // recorta el alto al último hotspot útil + margen
  let needH = 1200;
  for (const h of measured.hits) needH = Math.max(needH, h.y + h.h + 120);
  const H = Math.min(MAX_H, Math.max(1400, needH));

  const shot = await page.send('Page.captureScreenshot', {
    format: 'webp', quality: 74,
    clip: { x: 0, y: 0, width: WIDTH, height: H, scale: 1 },
    captureBeyondViewport: true,
  }, 120000);
  if (!shot?.data) return null;
  const buf = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(path.join(outDir, 'front.webp'), buf);

  const normFor = (u) => {
    try {
      const x = new URL(u);
      return (x.host.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase();
    } catch { return ''; }
  };
  const byKey = new Map();
  for (const it of items) {
    const k = normFor(it.url);
    if (k) byKey.set(k, it);
  }
  const hotspots = [];
  for (const h of measured.hits) {
    const k = String(h.u).replace(/^https?:\/\/(www\.)?/i, '').split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase();
    const it = byKey.get(k);
    if (!it) continue;
    const x = Math.max(0, h.x), y = Math.max(0, h.y);
    const w = Math.min(h.w, WIDTH - x), hh = Math.min(h.h, H - y);
    if (w < MIN_BOX || hh < MIN_BOX) continue;
    hotspots.push({
      n: it.n, title: it.title,
      x: +(x / WIDTH * 100).toFixed(3), y: +(y / H * 100).toFixed(3),
      w: +(w / WIDTH * 100).toFixed(3), h: +(hh / H * 100).toFixed(3),
    });
  }

  const meta = {
    img: 'front.webp', w: WIDTH, h: H,
    bytes: buf.length, hotspots,
  };
  fs.writeFileSync(path.join(outDir, 'front.json'), JSON.stringify(meta, null, 1));
  return meta;
}

module.exports = { captureFront, prepareHtml };
