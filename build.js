'use strict';
// Orquestador: portada -> 20 noticias -> PDF limpio -> índice del día.

const fs = require('node:fs');
const path = require('node:path');
const { launch, newPage, blockNoise, sleep, UA_DESKTOP } = require('./lib/cdp');
const { execFileSync } = require('node:child_process');

// --- modo instantánea: para diarios que sirven una página vacía al navegador headless ---
function curlHtml(url) {
  try {
    return execFileSync('curl', [
      '-sL', '--max-time', '30', '--compressed',
      '-A', UA_DESKTOP,
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: es-ES,es;q=0.9,en;q=0.6',
      url,
    ], { maxBuffer: 60 * 1024 * 1024 }).toString('utf8');
  } catch (e) { return ''; }
}

function snapshotFile(html, baseUrl, dest) {
  let h = String(html);
  h = h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<link\b[^>]*rel=["']?preload["']?[^>]*>/gi, '');
  const base = `<base href="${baseUrl}">`;
  if (/<head[^>]*>/i.test(h)) h = h.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  else h = base + h;
  fs.writeFileSync(dest, h, 'utf8');
  return 'file://' + dest;
}
const { EXTRACT_JS } = require('./lib/extract');
const { FRONT_JS } = require('./lib/front');
const { inlineImages } = require('./lib/images');
const { buildHtml } = require('./lib/render');
const { PAPERS, bySlug } = require('./lib/sites');
const { captureFront } = require('./lib/capture');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const KEEP_DAYS = 10;

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const flag = (k) => argv.includes('--' + k);

const LIMIT = parseInt(arg('limit', '20'), 10);
const ONLY = (arg('papers', '') || '').split(',').filter(Boolean);
const NO_PUSH = flag('no-push');

const nowMadrid = () => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date());
};
const DATE = arg('date', nowMadrid());

const slugify = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'noticia';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function ampCandidates(url) {
  const out = [];
  try {
    const u = new URL(url);
    const p = u.pathname;
    // El Confidencial y otros: prefijo /amp/ tras el dominio
    out.push(`${u.origin}/amp${p}`);
    out.push(`${u.origin}${p.replace(/\/$/, '')}/amp/`);
    out.push(`${u.origin}${p}${p.includes('?') ? '&' : '?'}outputType=amp`);
    out.push(`${u.origin}${p}${p.includes('?') ? '&' : '?'}amp=1`);
  } catch {}
  return out;
}

// Recompresión de imágenes en el navegador para que el PDF no pese 2 MB
async function compressToJpeg(page, dataUri, maxW = 900, q = 0.72) {
  try {
    return await page.eval(`(async () => {
      const src = ${JSON.stringify(dataUri)};
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const scale = Math.min(1, ${maxW} / (img.naturalWidth || ${maxW}));
      const w = Math.max(1, Math.round((img.naturalWidth || ${maxW}) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || ${maxW}) * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/jpeg', ${q});
    })()`, { timeoutMs: 20000 });
  } catch { return dataUri; }
}

async function collectFront(page, paper) {
  const snap = path.join(ROOT, '.tmp', `front-${paper.slug}.html`);
  let res = null;
  try {
    await page.goto(paper.front, { settle: 2500, timeoutMs: 60000 });
    res = await page.eval(FRONT_JS({ articleRe: paper.articleRe, max: LIMIT + 14 }), { timeoutMs: 60000 });
  } catch (e) { res = null; }
  if (res && (res.items || []).length >= 5) return res;
  // fallback: instantánea vía curl
  const html = curlHtml(paper.front);
  if (html.length > 5000) {
    const url = snapshotFile(html, paper.front, snap);
    log(`[${paper.slug}] modo instantánea (Chrome bloqueado), ${Math.round(html.length / 1024)} KB`);
    try {
      await page.goto(url, { settle: 800, timeoutMs: 45000 });
      const r2 = await page.eval(FRONT_JS({ articleRe: paper.articleRe, max: LIMIT + 14 }), { timeoutMs: 60000 });
      if (r2 && (r2.items || []).length) return r2;
    } catch {}
  }
  return res || { items: [] };
}

async function collectFrontOld(page, paper) {
  await page.goto(paper.front, { settle: 2500, timeoutMs: 60000 });
  // desplazar para forzar carga diferida de imágenes
  await page.eval(`(async () => {
    for (let y = 0; y < 6000; y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 400));
    return true;
  })()`, { timeoutMs: 30000 }).catch(() => {});
  const res = await page.eval(FRONT_JS({ articleRe: paper.articleRe, max: LIMIT + 14 }), { timeoutMs: 60000 });
  return res || { items: [] };
}

async function extractArticle(page, paper, url) {
  const attempts = [url, ...ampCandidates(url)];
  let best = null;
  if (paper.preferSnapshot) {
    // Diarios con muro en cliente (ABC): el HTML servido trae el texto íntegro.
    const html0 = curlHtml(url);
    if (html0.length > 5000) {
      const dest0 = path.join(ROOT, '.tmp', `art-snap-${paper.slug}.html`);
      const loc0 = snapshotFile(html0, url, dest0);
      try {
        await page.goto(loc0, { settle: 600, timeoutMs: 40000 });
        const a0 = await page.eval(EXTRACT_JS({ contentSelector: paper.contentSelector }));
        if (a0 && (a0.stats?.textChars || 0) > 300) best = { ...a0, requestedUrl: url, canonical: url };
      } catch {}
    }
  }
  for (const u of attempts) {
    try {
      await page.goto(u, { settle: 1400, timeoutMs: 45000 });
      const art = await page.eval(EXTRACT_JS({ contentSelector: paper.contentSelector }));
      if (!art) continue;
      const chars = art.stats?.textChars || 0;
      if (!best || chars > (best.stats?.textChars || 0)) best = { ...art, requestedUrl: u };
      if (chars > 1800) break;
      if (paper.preferSnapshot && (best?.stats?.textChars || 0) > 300) break;
    } catch (e) { /* siguiente intento */ }
  }
  if ((best?.stats?.textChars || 0) < 600) {
    // fallback instantánea
    const html = curlHtml(url);
    if (html.length > 5000) {
      const dest = path.join(ROOT, '.tmp', `art-snap-${paper.slug}.html`);
      const loc = snapshotFile(html, url, dest);
      try {
        await page.goto(loc, { settle: 600, timeoutMs: 40000 });
        const art = await page.eval(EXTRACT_JS({ contentSelector: paper.contentSelector }));
        const chars = art?.stats?.textChars || 0;
        if (art && chars > (best?.stats?.textChars || 0)) best = { ...art, requestedUrl: url, canonical: url };
      } catch {}
    }
  }
  return best;
}

async function processPaper(drv, paper, idx) {
  const nav = await newPage(drv, { width: 1440, height: 1000 });
  const prn = await newPage(drv, { width: 1200, height: 1600 });
  await blockNoise(nav);
  const outDir = path.join(DATA, DATE, paper.slug);
  const thumbDir = path.join(outDir, 'mini');
  fs.mkdirSync(thumbDir, { recursive: true });

  const items = [];
  try {
    const front = await collectFront(nav, paper);
    const SKIP = /^(portada\s+(del|de)\s|la portada de|edici[oó]n impresa|peri[oó]dico de hoy|sumario\b)/i;
    const list = (front.items || [])
      .filter((it) => !SKIP.test(String(it.title || '').trim()))
      .slice(0, LIMIT);
    log(`[${paper.slug}] portada: ${front.items?.length || 0} candidatas, uso ${list.length}`);

    let n = 0;
    for (const it of list) {
      n++;
      const base = String(n).padStart(2, '0') + '-' + slugify(it.title);
      const pdfRel = `${paper.slug}/${base}.pdf`;
      const record = {
        n, title: it.title, section: it.section || '', summary: it.summary || '',
        url: it.url, img: it.img || '', thumb: '', pdf: '', ok: false, bytes: 0,
      };
      // miniatura de portada
      if (it.img) {
        const own = await inlineImages({ blocks: [{ type: 'image', src: it.img }], canonical: it.url }, paper, null).catch(() => null);
        const raw = own && own.map[it.img];
        if (raw) {
          const small = await compressToJpeg(prn, raw, 640, 0.7);
          const buf = Buffer.from(String(small).split(',')[1], 'base64');
          fs.writeFileSync(path.join(thumbDir, `${String(n).padStart(2, '0')}.jpg`), buf);
          record.thumb = `mini/${String(n).padStart(2, '0')}.jpg`;
        }
      }
      // artículo
      const art = await extractArticle(nav, paper, it.url);
      const chars = art?.stats?.textChars || 0;
      if (art && chars >= 350) {
        const imgs = await inlineImages(art, paper, null);
        // recomprimir para aligerar
        for (const [k, v] of Object.entries(imgs.map)) {
          if (String(v).startsWith('data:image/')) imgs.map[k] = await compressToJpeg(prn, v, 1000, 0.72);
        }
        const html = buildHtml(paper, { ...art, title: art.title || it.title, subtitle: art.subtitle || it.summary, section: art.section || it.section }, imgs.map);
        const tmp = path.join(prn.ws.userDataDir || '/tmp', `art-${paper.slug}-${n}.html`);
        fs.writeFileSync(tmp, html, 'utf8');
        await prn.goto('file://' + tmp, { settle: 350, timeoutMs: 45000 });
        const pdf = await prn.pdf();
        fs.writeFileSync(path.join(outDir, `${base}.pdf`), pdf);
        record.pdf = pdfRel; record.ok = true; record.bytes = pdf.length;
        record.author = art.author || ''; record.date = art.date || '';
        record.imgs = imgs.count; record.chars = chars;
        log(`  ${n}/${list.length} ${chars}c ${(pdf.length / 1024).toFixed(0)}KB ${imgs.count}img  ${String(it.title).slice(0, 60)}`);
        try { fs.unlinkSync(tmp); } catch {}
      } else {
        log(`  ${n}/${list.length} SIN TEXTO (${chars}c)  ${String(it.title).slice(0, 60)}`);
      }
      items.push(record);
      await sleep(120);
    }
  } catch (e) {
    log(`[${paper.slug}] FALLO: ${e.message}`);
  } finally {
    await nav.close().catch(() => {});
    await prn.close().catch(() => {});
  }

  const ok = items.filter((i) => i.ok);
  let frontMeta = null;
  if (ok.length) {
    // La página que descargó 20 artículos acaba con la sesión CDP muerta, así que
    // la captura va en página propia y nueva. Si aun así falla, se reintenta una vez.
    for (let attempt = 1; attempt <= 2 && !frontMeta; attempt++) {
      let cap = null;
      try {
        cap = await newPage(drv, { width: 1440, height: 1000 });
        await blockNoise(cap);
        frontMeta = await captureFront(cap, paper, ok, outDir);
      } catch (e) {
        log(`[${paper.slug}] captura intento ${attempt} falló: ${e.message}`);
        frontMeta = null;
      } finally {
        if (cap) await cap.close().catch(() => {});
      }
    }
  }
  if (frontMeta) log(`[${paper.slug}] portada capturada: ${(frontMeta.bytes / 1024).toFixed(0)}KB, ${frontMeta.hotspots.length}/${ok.length} zonas`);

  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({
    paper: { slug: paper.slug, name: paper.name, color: paper.color, accent: paper.accent },
    date: DATE,
    collectedAt: new Date().toISOString(),
    total: items.length,
    ok: ok.length,
    front: frontMeta || undefined,
    items,
  }, null, 1));
  return { slug: paper.slug, name: paper.name, total: items.length, ok: ok.length };
}

function retention() {
  if (!fs.existsSync(DATA)) return [];
  const dirs = fs.readdirSync(DATA).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const removed = [];
  for (const d of dirs) {
    if (d >= DATE) continue;
    const age = (new Date(DATE + 'T00:00:00') - new Date(d + 'T00:00:00')) / 86400000;
    if (age > KEEP_DAYS) {
      fs.rmSync(path.join(DATA, d), { recursive: true, force: true });
      removed.push(d);
    }
  }
  return removed;
}

function writeGlobalIndex() {
  const dirs = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : [];
  const days = [];
  for (const d of dirs) {
    const papers = [];
    for (const p of PAPERS) {
      const f = path.join(DATA, d, p.slug, 'index.json');
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        papers.push({ slug: p.slug, name: p.name, total: j.total, ok: j.ok, color: p.color, accent: p.accent });
      } catch {}
    }
    if (papers.length) days.push({ date: d, papers });
  }
  const index = { updatedAt: new Date().toISOString(), keepDays: KEEP_DAYS, days, papers: PAPERS.map((p) => ({ slug: p.slug, name: p.name, color: p.color, accent: p.accent })) };
  fs.writeFileSync(path.join(DATA, 'index.json'), JSON.stringify(index, null, 1));
  return index;
}

(async () => {
  const t0 = Date.now();
  const papers = ONLY.length ? ONLY.map((s) => bySlug[s]).filter(Boolean) : PAPERS;
  log(`Kiosko ${DATE} · ${papers.length} cabeceras · máx ${LIMIT} noticias`);
  const drv = await launch();
  const results = [];
  try {
    for (const p of papers) {
      const r = await processPaper(drv, p, 0);
      results.push(r);
    }
  } finally { await drv.kill(); }

  const rm = retention();
  if (rm.length) log('Retención: borrados ' + rm.join(', '));
  const idx = writeGlobalIndex();
  log('Índices escritos. Días disponibles: ' + idx.days.map((d) => d.date).join(', '));
  log(`Total ${results.reduce((a, r) => a + r.ok, 0)}/${results.reduce((a, r) => a + r.total, 0)} PDFs en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  fs.writeFileSync(path.join(ROOT, '.last-run.json'), JSON.stringify({ date: DATE, at: new Date().toISOString(), results, ms: Date.now() - t0 }, null, 1));

  if (!NO_PUSH) {
    const { execSync } = require('node:child_process');
    try {
      execSync('git add -A && git commit -q -m "kiosko ' + DATE + '" && git push -q', { cwd: ROOT, stdio: 'inherit' });
      log('Publicado en GitHub');
    } catch (e) { log('Aviso: no se pudo publicar (' + e.message.split('\n')[0] + ')'); }
  }
  process.exit(0);
})().catch((e) => { console.error('FALLO GENERAL:', e); process.exit(1); });
