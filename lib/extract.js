'use strict';
// Extracción del artículo dentro de la página (se ejecuta en el contexto de Chrome).
// Estrategia: quitar ruido conocido -> puntuar contenedores por densidad de texto -> recoger bloques.

const EXTRACT_JS = (opts) => `(() => {
  const OPTS = ${JSON.stringify(opts || {})};
  const KILL = [
    'script','style','noscript','iframe','form','button','input','select','textarea',
    'aside','nav','footer','header',
    '[class*="newsletter"]','[class*="suscrib"]','[class*="suscrip"]','[class*="subscribe"]',
    '[class*="paywall"]','[class*="muro"]','[class*="premium-"]','[class*="regi"]',
    '[class*="publicidad"]','[class*="advert"]','[class*="ad-slot"]','[class*="ads-"]',
    '[class*="taboola"]','[id*="taboola"]','[class*="outbrain"]','[id*="outbrain"]',
    '[class*="comentario"]','[id*="comentario"]','[class*="comments"]',
    '[class*="related"]','[class*="relacionad"]','[class*="recomend"]','[class*="recomienda"]',
    '[class*="mas-leid"]','[class*="most-read"]','[class*="lo-mas"]','[class*="trending"]',
    '[class*="compart"]','[class*="share"]','[class*="social"]','[class*="toolbar"]',
    '[class*="cookie"]','[class*="consent"]','[class*="modal"]','[class*="popup"]',
    '[class*="banner"]','[class*="promo"]','[class*="cta-"]','[class*="disclaimer"]',
    '[class*="tags"]','[class*="etiquetas"]','[class*="firma-"]','[class*="author-box"]',
    '[class*="amp-ad"]','amp-ad','amp-embed','amp-consent','amp-analytics'
  ];
  const doc = document;

  // --- metadatos ---
  const meta = (sel) => { const e = doc.querySelector(sel); return e ? (e.getAttribute('content') || '').trim() : ''; };
  const txt = (sel) => { const e = doc.querySelector(sel); return e ? e.innerText.trim().replace(/\\s+/g, ' ') : ''; };

  let ld = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { const j = JSON.parse(s.textContent); ld = ld.concat(Array.isArray(j) ? j : [j]); } catch {}
  }
  const flat = [];
  for (const j of ld) {
    if (!j || typeof j !== 'object') continue;
    flat.push(j);
    if (Array.isArray(j['@graph'])) flat.push(...j['@graph']);
  }
  const news = flat.find((j) => {
    const t = [].concat(j['@type'] || []).join(',');
    return /NewsArticle|Article|Reportage|BlogPosting/i.test(t);
  }) || {};

  const title = (news.headline || meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || txt('h1') || doc.title || '').trim();
  let subtitle = (news.description || meta('meta[name="description"]') || meta('meta[property="og:description"]') || txt('h2.subtitle') || '').trim();
  if (subtitle.length > 400) subtitle = subtitle.slice(0, 397) + '...';
  const authorRaw = news.author;
  let author = '';
  if (Array.isArray(authorRaw)) author = authorRaw.map((a) => (typeof a === 'string' ? a : a && a.name) || '').filter(Boolean).join(' y ');
  else if (authorRaw && typeof authorRaw === 'object') author = authorRaw.name || '';
  else if (typeof authorRaw === 'string') author = authorRaw;
  if (!author) author = meta('meta[name="author"]') || '';
  const dateRaw = news.datePublished || news.dateModified || meta('meta[property="article:published_time"]') || meta('meta[name="pubdate"]') || '';
  const section = (news.articleSection && (typeof news.articleSection === 'string' ? news.articleSection : (news.articleSection[0] || ''))) || meta('meta[property="article:section"]') || '';
  const canonical = (doc.querySelector('link[rel="canonical"]') || {}).href || location.href;
  const ogImage = meta('meta[property="og:image"]') || (news.image && (news.image.url || (Array.isArray(news.image) && (news.image[0].url || news.image[0])))) || '';

  // --- limpieza de ruido ---
  const removeNoise = (root) => {
    for (const sel of KILL) {
      let nodes = [];
      try { nodes = root.querySelectorAll(sel); } catch { continue; }
      for (const n of nodes) {
        if (!n || !n.parentNode) continue;
        // no borrar el contenedor del artículo por un falso positivo en clase
        if (n.contains && n.contains(doc.querySelector('h1'))) continue;
        n.remove();
      }
    }
  };

  // --- elegir contenedor del cuerpo ---
  let body = null;
  if (OPTS.contentSelector) {
    for (const sel of String(OPTS.contentSelector).split(',')) {
      const el = doc.querySelector(sel.trim());
      if (el && el.innerText.length > 300) { body = el; break; }
    }
  }
  if (!body) {
    let best = null, bestScore = 0;
    const candidates = doc.querySelectorAll('article, div, section, main');
    for (const el of candidates) {
      const ps = el.querySelectorAll('p');
      if (ps.length < 3) continue;
      let score = 0;
      for (const p of ps) {
        const t = p.innerText.trim();
        if (t.length < 40) continue;
        score += t.length;
      }
      // penalizar contenedores que envuelven demasiada página
      const total = el.innerText.length || 1;
      const density = score / total;
      const s = score * (0.4 + density);
      if (s > bestScore) { bestScore = s; best = el; }
    }
    body = best;
  }
  if (!body) body = doc.body;

  const clone = body.cloneNode(true);
  removeNoise(clone);
  // quitar párrafos-basura cortos
  const TRASH = /^(publicidad|anuncio|compartir|comparte|síguenos|siguenos|te puede interesar|también te puede interesar|más leíd[oa]s?|leer más|read more|ver más|ver comentarios|comentarios|suscríbete|suscribete|hazte suscriptor|hazte premium|ya eres suscriptor|inicia sesión|regístrate|descarga la app|newsletter|boletín|este contenido es exclusivo|contenido exclusivo|exclusivo para suscriptores|si quieres seguir leyendo|continúa leyendo|para seguir leyendo)/i;
  for (const p of [...clone.querySelectorAll('p')]) {
    const t = (p.innerText || p.textContent || '').trim();
    if (!t) { p.remove(); continue; }
    if (t.length < (OPTS.minPara || 45) && TRASH.test(t)) { p.remove(); continue; }
    if (TRASH.test(t) && t.length < 160) { p.remove(); continue; }
  }

  // --- recoger bloques en orden ---
  const blocks = [];
  const seen = new Set();
  const pushText = (tag, text, extra) => {
    const t = (text || '').replace(/\\s+/g, ' ').trim();
    if (!t) return;
    const key = tag + '|' + t.slice(0, 90);
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push({ type: 'text', tag, text: t, ...(extra || {}) });
  };
  const pushImage = (src, alt, caption) => {
    if (!src) return;
    if (/^data:image\\/gif|spacer|pixel\\.gif|blank\\.(gif|png)|1x1/i.test(src)) return;
    if (seen.has('img|' + src)) return;
    seen.add('img|' + src);
    blocks.push({ type: 'image', src, alt: alt || '', caption: caption || '' });
  };
  const pushList = (items, ordered) => {
    const clean = items.map((x) => (x || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
    if (!clean.length) return;
    const key = 'list|' + clean.join('|').slice(0, 90);
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push({ type: 'list', ordered: !!ordered, items: clean });
  };

  const walk = (node) => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { pushText(tag, child.innerText); continue; }
      if (tag === 'p') { pushText('p', child.innerText); continue; }
      if (tag === 'blockquote') { pushText('quote', child.innerText); continue; }
      if (tag === 'figure') {
        const im = child.querySelector('img');
        const cap = child.querySelector('figcaption');
        if (im) pushImage(im.currentSrc || im.src || im.getAttribute('data-src') || im.getAttribute('data-lazy-src'), im.alt, cap ? cap.innerText.trim() : '');
        continue;
      }
      if (tag === 'img') { pushImage(child.currentSrc || child.src || child.getAttribute('data-src'), child.alt, ''); continue; }
      if (tag === 'picture') { const im = child.querySelector('img'); if (im) pushImage(im.currentSrc || im.src, im.alt, ''); continue; }
      if (tag === 'ul' || tag === 'ol') { pushList([...child.querySelectorAll('li')].map((li) => li.innerText), tag === 'ol'); continue; }
      if (tag === 'table') { pushText('pre', child.innerText); continue; }
      if (tag === 'pre') { pushText('pre', child.innerText); continue; }
      if (['div','section','article','main','span','a','strong','em','b','i','u','small','time','p'].includes(tag)) { walk(child); continue; }
      // otros: intentar texto suelto
      if (child.innerText && child.innerText.trim().length > 60 && !child.querySelector('p')) pushText('p', child.innerText);
    }
  };
  walk(clone);

  // párrafos sueltos (cuando el contenedor no tiene estructura clara)
  if (blocks.filter((b) => b.type === 'text').length < 3) {
    for (const p of clone.querySelectorAll('p')) pushText('p', p.innerText);
  }

  // --- posproceso: quitar ecos del titular, sellos de tiempo y tiras de recomendados ---
  const nrm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const head = nrm(title).slice(0, 45);
  const sub = nrm(subtitle);
  const ECHO = /^(hace\s+\d+|publicado|actualizado|última hora|ultima hora|\d{1,2}:\d{2}\s*h?$|compartir|comparte|env[ií]a|imprime|suscr)/i;
  const STRIP = /(te puede interesar|tambi[eé]n te puede interesar|m[aá]s noticias|lo [uú]ltimo|sigue leyendo|no te lo pierdas|lee tambi[eé]n|leer m[aá]s|ver m[aá]s|m[aá]s informaci[oó]n|el redactor recomienda|otros contenidos|contenido relacionado|recomendado por)/i;
  const clean = [];
  for (const b of blocks) {
    if (b.type !== 'text') { clean.push(b); continue; }
    const t = b.text || '';
    const n = nrm(t);
    if (head && n.length > 12 && (head.startsWith(n.slice(0, 30)) || n.startsWith(head))) continue;
    if (sub && n.length > 12 && (n === sub || sub.startsWith(n.slice(0, 40)) || n.startsWith(sub.slice(0, 40)))) continue;
    if (ECHO.test(t.trim()) && t.length < 120) continue;
    if (STRIP.test(t) && t.length < 240) continue;
    if (/\|/.test(t) && t.length < 140) continue;
    clean.push(b);
  }

  return {
    title, subtitle, author, date: dateRaw, section, canonical, ogImage,
    blocks,
    stats: { textChars: blocks.filter(b => b.type === 'text').reduce((a, b) => a + b.text.length, 0), nBlocks: blocks.length },
    finalUrl: location.href,
  };
})()`;

module.exports = { EXTRACT_JS };
