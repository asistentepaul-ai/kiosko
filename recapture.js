'use strict';
// Regenera la captura de portada de un día ya descargado, sin tocar PDFs.
// uso: node recapture.js [--date=YYYY-MM-DD] [--papers=slug,slug]

const fs = require('node:fs');
const path = require('node:path');
const { launch, newPage } = require('./lib/cdp');
const { captureFront } = require('./lib/capture');
const { PAPERS, bySlug } = require('./lib/sites');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const DATE = arg('date', new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()));
const ONLY = (arg('papers', '') || '').split(',').filter(Boolean);
const papers = ONLY.length ? ONLY.map((s) => bySlug[s]).filter(Boolean) : PAPERS;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const drv = await launch();
  const page = await newPage(drv, { width: 1400, height: 1600 });
  try {
    for (const p of papers) {
      const dir = path.join(DATA, DATE, p.slug);
      const idxF = path.join(dir, 'index.json');
      if (!fs.existsSync(idxF)) { log(`[${p.slug}] sin índice, salto`); continue; }
      const idx = JSON.parse(fs.readFileSync(idxF, 'utf8'));
      const items = idx.items || [];
      if (!items.length) { log(`[${p.slug}] 0 noticias`); continue; }
      const t0 = Date.now();
      const meta = await captureFront(page, p, items, dir);
      if (!meta) { log(`[${p.slug}] captura FALLIDA`); continue; }
      idx.front = { img: meta.img, w: meta.w, h: meta.h, hotspots: meta.hotspots };
      fs.writeFileSync(idxF, JSON.stringify(idx, null, 1));
      log(`[${p.slug}] ${(meta.bytes / 1024).toFixed(0)}KB ${meta.w}x${meta.h} · ${meta.hotspots.length}/${items.length} zonas · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  } finally { await drv.kill(); }
})().catch((e) => { console.error('FALLO', e); process.exit(1); });
