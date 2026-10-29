'use strict';
// Extracción de la portada: las N noticias principales en orden de aparición.

// Los patrones se construyen en Node (no dentro del template) para no pelearse con los escapes.
const DEFAULT_ARTICLE_RE = String.raw`/20\d\d[-\/]\d\d[-\/]\d\d`;

const BAD_PATH_RE = String.raw`(\/tag\/|\/tags\/|\/autor\/|\/autores\/|\/firmas\/|\/opinion\/|\/opinión\/|\/blogs?\/|\/podcast|\/video|\/videos|\/galeria|\/fotos|\/multimedia|\/newsletter|\/suscri|\/suscrib|\/newsletters|\/rss|\/buscador|\/buscar|\/aviso|\/privacidad|\/cookies|\/contacto|\/publicidad|\/quienes|\/equipo|\/tienda|\/juegos|\/crossword|\/horoscopo|\/loteria|\/loterias|\/clima|\/tiempo\/|mailto:|^javascript:|^#)`;

function normalizeRe(src) {
  if (!src) return DEFAULT_ARTICLE_RE;
  let s = String(src);
  if (s.startsWith('/')) s = s.slice(1);
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

const FRONT_JS = (cfg) => {
  const c = cfg || {};
  const artSrc = normalizeRe(c.articleRe);
  const max = c.max || 20;
  return `(() => {
  const ART = new RegExp(${JSON.stringify(artSrc)}, 'i');
  const BAD = new RegExp(${JSON.stringify(BAD_PATH_RE)}, 'i');
  const MAX = ${JSON.stringify(max)};
  const seen = new Set();
  const out = [];
  const norm = (u) => { try { const x = new URL(u, location.href); x.hash = ''; x.search = ''; return x.href; } catch { return null; } };

  const bestImg = (el) => {
    let node = el, depth = 0;
    while (node && depth < 6) {
      const imgs = node.querySelectorAll ? node.querySelectorAll('img') : [];
      let best = null, bestArea = 0;
      for (const im of imgs) {
        const src = im.currentSrc || im.src || im.getAttribute('data-src') || im.getAttribute('data-lazy-src') || im.getAttribute('data-original');
        if (!src || /^data:image\\/gif|pixel|spacer|blank|1x1/i.test(src)) continue;
        const w = im.naturalWidth || parseInt(im.getAttribute('width') || '0', 10) || 0;
        const h = im.naturalHeight || parseInt(im.getAttribute('height') || '0', 10) || 0;
        const area = w * h;
        if (area > bestArea) { bestArea = area; best = { src, alt: im.alt || '', w, h }; }
      }
      if (best) return best;
      node = node.parentElement; depth++;
    }
    return null;
  };

  const anchors = [...document.querySelectorAll('a[href]')];
  for (const a of anchors) {
    const url = norm(a.getAttribute('href'));
    if (!url || !url.startsWith('http')) continue;
    let u;
    try { u = new URL(url); } catch { continue; }
    if (u.host !== location.host) continue;
    if (BAD.test(u.pathname)) continue;
    if (!ART.test(u.pathname)) continue;
    if (seen.has(url)) continue;
    let title = (a.innerText || '').replace(/\\s+/g, ' ').trim();
    if (title.length < 20) {
      const card = a.closest('article, li, div');
      const h = card && card.querySelector('h1, h2, h3, h4');
      if (h) title = (h.innerText || '').replace(/\\s+/g, ' ').trim();
    }
    if (title.length < 20 || title.length > 220) continue;
    const img = bestImg(a);
    const card = a.closest('article, li, div') || a;
    const kickerEl = card.querySelector('[class*="kicker"], [class*="antetitulo"], [class*="section"], [class*="category"], [class*="tag"]');
    const section = kickerEl ? (kickerEl.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : '';
    let summary = '';
    for (const p of card.querySelectorAll('p, [class*="summary"], [class*="subtitulo"], [class*="excerpt"], [class*="description"], [class*="entradilla"]')) {
      const t = (p.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t.length > 40 && t !== title) { summary = t.slice(0, 220); break; }
    }
    seen.add(url);
    out.push({ url, title, img: img ? img.src : '', imgW: img ? img.w : 0, imgH: img ? img.h : 0, section, summary });
    if (out.length >= MAX) break;
  }
  return { items: out, host: location.host, title: document.title, anchors: anchors.length };
})()`;
};

module.exports = { FRONT_JS, normalizeRe };
