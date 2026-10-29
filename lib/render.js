'use strict';
// Construye un HTML limpio y autocontenido (imágenes en base64) para imprimir a PDF.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function fechaLarga(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '';
  return `${DIAS[d.getDay()]}, ${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} h`;
}

function bloque(b, imagesMap) {
  if (b.type === 'text') {
    const tag = b.tag;
    if (tag === 'h2') return `<h2>${esc(b.text)}</h2>`;
    if (tag === 'h3') return `<h3>${esc(b.text)}</h3>`;
    if (tag === 'h4') return `<h4>${esc(b.text)}</h4>`;
    if (tag === 'quote') return `<blockquote>${esc(b.text)}</blockquote>`;
    if (tag === 'pre') return `<pre>${esc(b.text)}</pre>`;
    return `<p>${esc(b.text)}</p>`;
  }
  if (b.type === 'image') {
    const src = imagesMap[b.src];
    if (!src) return '';
    return `<figure><img src="${src}" alt="${esc(b.alt)}">${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`;
  }
  if (b.type === 'list') {
    const t = b.ordered ? 'ol' : 'ul';
    return `<${t}>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</${t}>`;
  }
  return '';
}

function buildHtml(paper, art, imagesMap = {}) {
  const p = paper;
  const body = (art.blocks || []).map((b) => bloque(b, imagesMap)).join('\n');
  const kicker = [art.section, p.name].filter(Boolean).join(' · ');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>${esc(art.title || p.name)}</title>
<style>
  @page { size: A4; margin: 16mm 15mm 18mm 15mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${p.fontBody};
    font-size: 11.2pt; line-height: 1.55; color: #14161a;
    -webkit-font-smoothing: antialiased;
  }
  .top {
    display: flex; align-items: baseline; justify-content: space-between;
    border-bottom: 2.5px solid ${p.color}; padding-bottom: 6px; margin-bottom: 18px;
  }
  .brand {
    font-family: ${p.fontHead}; font-size: 15pt; font-weight: 700; letter-spacing: -.2px;
    color: ${p.color}; text-transform: ${p.uppercase ? 'uppercase' : 'none'};
  }
  .brand small { display:block; font-family: ${p.fontBody}; font-size: 7.5pt; letter-spacing: .12em;
    text-transform: uppercase; color: #8a8f98; font-weight: 400; margin-top: 1px; }
  .meta-top { font-size: 8pt; letter-spacing: .1em; text-transform: uppercase; color: #8a8f98; }
  h1 {
    font-family: ${p.fontHead}; font-size: 25pt; line-height: 1.1; letter-spacing: -.5px;
    font-weight: 700; margin: 0 0 10px; color: #0d0f12; text-wrap: balance;
  }
  .sub {
    font-family: ${p.fontHead}; font-size: 12.6pt; line-height: 1.4; color: #4a5058;
    margin: 0 0 14px; font-weight: 400;
  }
  .byline {
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    font-size: 8.6pt; letter-spacing: .06em; text-transform: uppercase; color: #6b7280;
    border-top: 1px solid #e3e6ea; border-bottom: 1px solid #e3e6ea; padding: 7px 0; margin-bottom: 20px;
  }
  .byline .kicker { color: ${p.color}; font-weight: 700; letter-spacing: .12em; }
  .byline .dot { color: #c9ced6; }
  article p { margin: 0 0 11px; text-align: justify; hyphens: auto; }
  article p:first-of-type::first-letter {
    float: left; font-family: ${p.fontHead}; font-size: 44pt; line-height: .82;
    padding: 4px 7px 0 0; color: ${p.color}; font-weight: 700;
  }
  h2 { font-family: ${p.fontHead}; font-size: 14.5pt; line-height: 1.25; margin: 22px 0 9px; color: #0d0f12; page-break-after: avoid; }
  h3 { font-family: ${p.fontHead}; font-size: 12pt; margin: 18px 0 7px; color: #1b1f25; page-break-after: avoid; }
  blockquote {
    margin: 16px 0; padding: 2px 0 2px 16px; border-left: 3px solid ${p.color};
    font-family: ${p.fontHead}; font-size: 12.4pt; line-height: 1.4; color: #2a2f36; font-style: italic;
  }
  figure { margin: 18px 0; page-break-inside: avoid; }
  figure img { width: 100%; height: auto; display: block; border-radius: 1px; }
  figcaption { font-size: 8.4pt; color: #7a808a; margin-top: 5px; line-height: 1.35; }
  ul, ol { margin: 0 0 12px 0; padding-left: 20px; }
  li { margin-bottom: 4px; }
  pre { background: #f5f6f8; padding: 10px; font-size: 9pt; overflow-wrap: break-word; white-space: pre-wrap; border-radius: 3px; }
  .foot {
    margin-top: 26px; border-top: 1px solid #e3e6ea; padding-top: 9px;
    font-size: 7.6pt; color: #9aa0a8; line-height: 1.5; word-break: break-all;
  }
  .foot b { color: #6b7280; font-weight: 600; }
</style></head>
<body>
  <div class="top">
    <div class="brand">${esc(p.name)}<small>${esc(kicker)}</small></div>
    <div class="meta-top">${esc(fechaLarga(art.date))}</div>
  </div>
  <h1>${esc(art.title)}</h1>
  ${art.subtitle ? `<p class="sub">${esc(art.subtitle)}</p>` : ''}
  <div class="byline">
    ${art.author ? `<span>${esc(art.author)}</span><span class="dot">·</span>` : ''}
    <span class="kicker">${esc(art.section || p.name)}</span>
  </div>
  <article>${body}</article>
  <div class="foot">
    <b>Fuente:</b> ${esc(art.canonical || '')}<br>
    Recorte generado el ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })} · sin publicidad ni recomendaciones.
  </div>
</body></html>`;
}

module.exports = { buildHtml, fechaLarga, esc };
