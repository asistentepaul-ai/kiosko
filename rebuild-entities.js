'use strict';
// Re-render del archivo: re-descarga los artículos ya indexados y regenera sus PDFs
// con el decodificador de entidades (fix doble escape &quot;/&#039;/...).
// No toca filenames, miniaturas ni capturas de portada: solo los *.pdf y los
// campos derivados de la reextracción dentro de cada index.json.

const fs = require('node:fs');
const path = require('node:path');
const { launch, newPage, blockNoise, sleep, UA_DESKTOP } = require('./lib/cdp');
const { execFileSync, execSync } = require('node:child_process');
const { EXTRACT_JS } = require('./lib/extract');
const { inlineImages } = require('./lib/images');
const { buildHtml } = require('./lib/render');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const ONLY = (arg('papers', 'elmundo,elconfidencial,theobjective') || '').split(',').filter(Boolean);
const DATES = (arg('dates', '') || '').split(',').filter(Boolean);
const LIMIT = parseInt(arg('limit', '0'), 10); // 0 = sin límite
const PUSH = !argv.includes('--no-push');
const ALL = argv.includes('--all');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a); // re-render todo, no solo los PDFs con entidades

// Lista quirúrgica: solo los PDFs que el escaneo marcó con entidades visibles
let AFFECTED = null;
try {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, '.tmp', 'affected.json'), 'utf8'));
  AFFECTED = new Set(list.map((a) => `${a.date}/${a.slug}/${a.pdf}`));
  if (!ALL) log(`Lista afectados: ${AFFECTED.size} PDFs`);
} catch {}
if (!ALL && AFFECTED && AFFECTED.size === 0) {
  log('Lista afectada vac\u00eda: ya no queda nada con entidades. Usa --all expl\u00edcito para re-render completo.');
  process.exit(0);
}
if (ALL || !AFFECTED || !AFFECTED.size) AFFECTED = null;

const { PAPERS } = require('./lib/sites');
const papers = PAPERS.filter((p) => ONLY.includes(p.slug));

const allDates = fs.existsSync(DATA)
  ? fs.readdirSync(DATA).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  : [];
const dates = DATES.length ? DATES : allDates;


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

function ampCandidates(url) {
  const out = [];
  try {
    const u = new URL(url);
    const p = u.pathname;
    out.push(`${u.origin}/amp${p}`);
    out.push(`${u.origin}${p.replace(/\/$/, '')}/amp/`);
    out.push(`${u.origin}${p}${p.includes('?') ? '&' : '?'}outputType=amp`);
    out.push(`${u.origin}${p}${p.includes('?') ? '&' : '?'}amp=1`);
  } catch {}
  return out;
}

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

async function extractArticle(page, paper, url) {
  const attempts = [url, ...ampCandidates(url)];
  let best = null;
  if (paper.preferSnapshot) {
    const html0 = curlHtml(url);
    if (html0.length > 5000) {
      const dest0 = path.join(ROOT, '.tmp', `re-snap-${paper.slug}.html`);
      let h = String(html0);
      h = h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      const base = `<base href="${url}">`;
      if (/<head[^>]*>/i.test(h)) h = h.replace(/<head([^>]*)>/i, `<head$1>${base}`);
      else h = base + h;
      fs.writeFileSync(dest0, h, 'utf8');
      try {
        await page.goto('file://' + dest0, { settle: 600, timeoutMs: 40000 });
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
  return best;
}

(async () => {
  const t0 = Date.now();
  log(`Re-render archivo · ${papers.map((p) => p.slug).join(', ')} · ${dates.length} días · push=${PUSH}`);
  const drv = await launch();
  let nav = null, prn = null;
  const stats = { pdfs: 0, skipped: 0, failed: 0 };

  const openPages = async () => {
    nav = await newPage(drv, { width: 1440, height: 1000 });
    prn = await newPage(drv, { width: 1200, height: 1600 });
    await blockNoise(nav);
  };
  const closePages = async () => {
    if (nav) await nav.close().catch(() => {});
    if (prn) await prn.close().catch(() => {});
    nav = prn = null;
  };
  await openPages();

  try {
    for (const date of dates) {
      for (const paper of papers) {
        const outDir = path.join(DATA, date, paper.slug);
        const idxFile = path.join(outDir, 'index.json');
        if (!fs.existsSync(idxFile)) continue;
        let idx;
        try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch { continue; }
        const items = (idx.items || []).filter((it) => it.ok && it.pdf);
        if (!items.length) continue;
        const todo = (LIMIT ? items.slice(0, LIMIT) : items)
          .filter((it) => !AFFECTED || AFFECTED.has(`${date}/${paper.slug}/${it.pdf.replace(/^.*\//, '')}`));
        if (!todo.length) continue;
        log(`[${date} ${paper.slug}] ${todo.length} PDFs a re-render`);
        let dirty = false;
        for (const it of todo) {
          const pdfPath = path.join(outDir, it.pdf.replace(/^.*\//, ''));
          try {
            const art = await extractArticle(nav, paper, it.url);
            const chars = art?.stats?.textChars || 0;
            if (art && chars >= 350) {
              const imgs = await inlineImages(art, paper, null);
              for (const [k, v] of Object.entries(imgs.map)) {
                if (String(v).startsWith('data:image/')) imgs.map[k] = await compressToJpeg(prn, v, 1000, 0.72);
              }
              const html = buildHtml(paper, {
                ...art,
                title: art.title || it.title,
                subtitle: art.subtitle || it.summary,
                section: art.section || it.section,
              }, imgs.map);
              const tmp = path.join(prn.ws.userDataDir || '/tmp', `re-${paper.slug}-${date}-${it.n}.html`);
              fs.writeFileSync(tmp, html, 'utf8');
              await prn.goto('file://' + tmp, { settle: 350, timeoutMs: 45000 });
              const pdf = await prn.pdf();
              fs.writeFileSync(pdfPath, pdf);
              it.author = art.author || it.author || '';
              it.date = art.date || it.date || '';
              it.imgs = imgs.count; it.chars = chars; it.bytes = pdf.length;
              dirty = true; stats.pdfs++;
              try { fs.unlinkSync(tmp); } catch {}
              log(`  ${String(it.n).padStart(2, '0')} ${chars}c ${(pdf.length / 1024).toFixed(0)}KB  ${String(it.title).slice(0, 55)}`);
            } else {
              stats.skipped++;
              log(`  ${String(it.n).padStart(2, '0')} SIN TEXTO (${chars}c), PDF original se conserva  ${String(it.title).slice(0, 55)}`);
            }
          } catch (e) {
            stats.failed++;
            log(`  ${String(it.n).padStart(2, '0')} ERROR: ${e.message.slice(0, 90)}`);
            // sesión CDP muerta: reabrir páginas y seguir
            await closePages().catch(() => {});
            await sleep(300);
            await openPages();
          }
          await sleep(140);
        }
        if (dirty) {
          idx.collectedAt = idx.collectedAt; // se conserva
          fs.writeFileSync(idxFile, JSON.stringify(idx, null, 1));
        }
      }
    }
  } finally {
    await closePages().catch(() => {});
    await drv.kill();
  }

  log(`Hecho: ${stats.pdfs} PDFs re-render, ${stats.skipped} sin texto, ${stats.failed} errores · ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (PUSH && stats.pdfs > 0) {
    try {
      execSync('git add -A data && git commit -q -m "kiosko: re-render archivo con decodificador de entidades" && git push -q', { cwd: ROOT, stdio: 'inherit' });
      log('Publicado en GitHub');
    } catch (e) { log('Aviso: no se pudo publicar (' + e.message.split('\n')[0] + ')'); }
  }
  process.exit(0);
})().catch((e) => { console.error('FALLO GENERAL:', e); process.exit(1); });
