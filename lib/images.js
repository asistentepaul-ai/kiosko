'use strict';
// Descarga imágenes con Referer correcto y las convierte a data URI para incrustarlas en el PDF.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_IMGS = 10;
const MAX_BYTES = 6 * 1024 * 1024;      // por imagen (luego se recomprime a JPEG)
const MAX_TOTAL = 14 * 1024 * 1024;     // por artículo

function absolutize(src, base) {
  try { return new URL(src, base).href; } catch { return null; }
}

function extFromType(ct) {
  if (/jpeg|jpg/i.test(ct)) return 'jpg';
  if (/png/i.test(ct)) return 'png';
  if (/webp/i.test(ct)) return 'webp';
  if (/gif/i.test(ct)) return 'gif';
  if (/avif/i.test(ct)) return 'avif';
  if (/svg/i.test(ct)) return 'svg';
  return 'bin';
}

async function fetchImage(url, referer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Referer': referer || '',
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/^image\//.test(ct) || /svg/.test(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2048 || buf.length > MAX_BYTES) return null;
    return { buf, type: ct.split(';')[0], ext: extFromType(ct) };
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

// Devuelve { map: { originalSrc -> dataURI }, files: [{ name, buf }] }
async function inlineImages(article, paper, outDir) {
  const srcs = [];
  for (const b of article.blocks || []) {
    if (b.type !== 'image') continue;
    const abs = absolutize(b.src, article.canonical || article.finalUrl);
    if (abs && !srcs.includes(abs)) srcs.push(abs);
    if (srcs.length >= MAX_IMGS) break;
  }
  const map = {};
  const files = [];
  let total = 0;
  await Promise.all(srcs.map(async (src) => {
    if (total > MAX_TOTAL) return;
    const img = await fetchImage(src, article.canonical);
    if (!img) return;
    total += img.buf.length;
    map[src] = `data:${img.type};base64,${img.buf.toString('base64')}`;
    if (outDir) {
      const h = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
      files.push({ name: `${paper.slug}-${h}.${img.ext}`, buf: img.buf });
    }
  }));
  // devolver también las claves relativas tal cual venían
  for (const b of article.blocks || []) {
    if (b.type !== 'image') continue;
    const abs = absolutize(b.src, article.canonical || article.finalUrl);
    if (abs && map[abs]) map[b.src] = map[abs];
  }
  return { map, files, count: Object.keys(map).length };
}

module.exports = { inlineImages, fetchImage, absolutize };
