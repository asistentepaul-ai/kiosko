'use strict';

const state = { index: null, day: null, paper: null, data: null };

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function fechaBonita(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 1);
  const base = `${DIAS[dt.getUTCDay()]}, ${d} de ${MESES[m - 1]}`;
  if (hoy.getFullYear() === y && hoy.getMonth() === m - 1 && hoy.getDate() === d) return `Hoy · ${base}`;
  if (ayer.getFullYear() === y && ayer.getMonth() === m - 1 && ayer.getDate() === d) return `Ayer · ${base}`;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

async function getJSON(url) {
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status + ' ' + url);
  return res.json();
}

function setStatus(msg, isErr) {
  const s = $('#status');
  s.hidden = !msg;
  s.textContent = msg || '';
  s.className = 'status' + (isErr ? ' err' : '');
}

async function loadIndex(keepView) {
  setStatus('Cargando índice…');
  try {
    state.index = await getJSON('data/index.json');
  } catch {
    setStatus('No hay kiosko publicado todavía. Aparecerá cuando acabe la primera descarga.', true);
    return;
  }
  const days = state.index.days || [];
  if (!days.length) { setStatus('Sin números archivados.', true); return; }
  if (!keepView || !days.some((d) => d.date === state.day)) state.day = days[0].date;
  renderDaySelect();
  const dayObj = days.find((d) => d.date === state.day) || days[0];
  const avail = dayObj.papers.map((p) => p.slug);
  if (!keepView || !state.paper || !avail.includes(state.paper)) state.paper = avail[0];
  renderTabs(dayObj);
  await loadPaper();
  stamp();
}

function renderDaySelect() {
  const sel = $('#daySelect');
  sel.innerHTML = '';
  for (const d of state.index.days) {
    const o = el('option', null, fechaBonita(d.date));
    o.value = d.date;
    if (d.date === state.day) o.selected = true;
    sel.appendChild(o);
  }
  const i = state.index.days.findIndex((d) => d.date === state.day);
  $('#prevDay').disabled = i >= state.index.days.length - 1;
  $('#nextDay').disabled = i <= 0;
}

function renderTabs(dayObj) {
  const nav = $('#tabs');
  nav.innerHTML = '';
  const inner = el('div', 'inner');
  for (const p of dayObj.papers) {
    const b = el('button', 'tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', p.slug === state.paper ? 'true' : 'false');
    b.style.setProperty('--brand', p.color || '#14161a');
    b.appendChild(document.createTextNode(p.name));
    b.appendChild(el('span', 'count', String(p.ok)));
    b.addEventListener('click', async () => {
      state.paper = p.slug;
      renderTabs(dayObj);
      await loadPaper();
    });
    inner.appendChild(b);
  }
  nav.appendChild(inner);
}

async function loadPaper() {
  const front = $('#front');
  front.innerHTML = '';
  setStatus('Abriendo portada…');
  try {
    state.data = await getJSON(`data/${state.day}/${state.paper}/index.json`);
  } catch {
    setStatus('Este periódico no tiene número en la fecha elegida.', true);
    return;
  }
  setStatus('');
  const p = state.data.paper || {};
  front.dataset.brand = '1';
  front.style.setProperty('--brand', p.color || '#14161a');
  front.style.setProperty('--brand-ink', p.accent || p.color || '#14161a');
  if (state.data.front && state.data.front.hotspots) renderShot(state.data);
  else renderFront(state.data.items || []);
}

// Portada real capturada + zonas clicables encima.
function renderShot(data) {
  const front = $('#front');
  front.innerHTML = '';
  front.classList.add('shot-mode');
  const f = data.front;
  const items = data.items || [];
  const bySlug = new Map(items.map((i) => [i.n, i]));

  const shot = el('div', 'shot');
  const img = el('img', 'shot-img');
  img.src = `data/${state.day}/${state.paper}/${f.img}`;
  img.width = f.w; img.height = f.h;
  img.alt = `Portada de ${data.paper?.name || state.paper}`;
  img.loading = 'eager';
  shot.appendChild(img);

  let n = 0;
  for (const z of f.hotspots) {
    const item = bySlug.get(z.n);
    if (!item || !item.ok) continue;
    // Sin href a propósito: un enlace real hace que el navegador (y el navegador
    // interno de Telegram) pida permiso o abra el PDF fuera de la página.
    const a = el('div', 'zone');
    a.setAttribute('role', 'link');
    a.tabIndex = 0;
    a.style.left = z.x + '%';
    a.style.top = z.y + '%';
    a.style.width = z.w + '%';
    a.style.height = z.h + '%';
    a.title = item.title;
    a.setAttribute('aria-label', item.title);
    a.dataset.pdf = pdfUrl(item);
    a.appendChild(el('span', 'zone-tag', item.title));
    if (location.search.includes('debug')) a.classList.add('zdebug');
    a.addEventListener('click', (e) => { e.preventDefault(); openViewer(item); });
    a.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(item); }
    });
    shot.appendChild(a);
    n++;
  }
  front.appendChild(shot);

  if (!n) setStatus('Portada sin zonas activas para este día.', true);
}

function thumbNode(item) {
  const d = el('div', 'thumb');
  if (item.thumb) {
    const img = el('img');
    img.loading = 'lazy'; img.alt = '';
    img.src = `data/${state.day}/${state.paper}/${item.thumb}`;
    img.addEventListener('error', () => { img.remove(); d.classList.add('placeholder'); d.appendChild(el('span', null, '§')); });
    d.appendChild(img);
  } else {
    d.classList.add('placeholder');
    d.appendChild(el('span', null, '§'));
  }
  if (!item.ok) d.appendChild(el('span', 'badge-miss', 'sin texto'));
  return d;
}

function cardFor(item, kind) {
  const c = el('div', 'card ' + kind + (item.ok ? '' : ' no-pdf'));
  const tag = kind === 'lead' ? 'h2' : kind === 'stack' ? 'h3' : 'h4';
  c.appendChild(thumbNode(item));
  const box = el('div');
  if (item.section) box.appendChild(el('div', 'kicker', item.section));
  box.appendChild(el(tag, null, item.title));
  if (kind === 'lead' && item.summary) box.appendChild(el('p', null, item.summary));
  c.appendChild(box);
  if (item.ok && item.pdf) {
    c.tabIndex = 0;
    c.setAttribute('role', 'link');
    c.addEventListener('click', () => openViewer(item));
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(item); } });
  }
  return c;
}

function renderFront(items) {
  const front = $('#front');
  front.innerHTML = '';
  front.classList.remove('shot-mode');
  if (!items.length) { setStatus('Sin noticias guardadas para este día.', true); return; }
  const [lead, ...rest] = items;
  front.appendChild(cardFor(lead, 'lead'));
  const stackItems = rest.slice(0, 4);
  if (stackItems.length) {
    const stack = el('div', 'stack');
    for (const it of stackItems) stack.appendChild(cardFor(it, 'stack'));
    front.appendChild(stack);
  }
  const chunkItems = rest.slice(4);
  if (chunkItems.length) {
    front.appendChild(el('div', 'grid-sep', 'Resto de la portada'));
    for (const it of chunkItems) front.appendChild(cardFor(it, 'chunk'));
  }
}

const pdfUrl = (item) => `data/${state.day}/${item.pdf}`;

function openViewer(item) {
  $('#viewerTitle').textContent = item.title;
  $('#viewerFrame').src = pdfUrl(item);
  $('#viewerOpen').href = pdfUrl(item);
  $('#viewer').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeViewer() {
  $('#viewer').hidden = true;
  $('#viewerFrame').src = 'about:blank';
  document.body.style.overflow = '';
}

function stamp() {
  const idx = state.index;
  if (!idx) return;
  const when = idx.updatedAt ? new Date(idx.updatedAt) : null;
  $('#stamp').textContent = 'Última descarga: ' + (when
    ? when.toLocaleString('es-ES', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : '—');
}

// ---------- refresco real contra el Mac ----------
let endpoint = null;

async function loadEndpoint() {
  try {
    const j = await getJSON('data/endpoint.json');
    if (j && j.url) endpoint = j.url.replace(/\/$/, '');
  } catch { endpoint = null; }
}

function setBtn(label, busy) {
  const b = $('#refresh');
  b.classList.toggle('busy', !!busy);
  b.innerHTML = '';
  b.appendChild(el('span', 'dot'));
  b.appendChild(document.createTextNode(' ' + label));
}

async function macStatus() {
  const res = await fetch(endpoint + '/status', { cache: 'no-store' });
  if (!res.ok) throw new Error('status ' + res.status);
  return res.json();
}

async function esperarBuild(t0) {
  const limite = Date.now() + 20 * 60 * 1000;
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 3500));
    let st;
    try { st = await macStatus(); } catch { continue; }
    const seg = Math.round((Date.now() - t0) / 1000);
    setBtn(st.building ? `Descargando ${seg}s` : 'Rematando', true);
    if (!st.building && st.last && new Date(st.last.at).getTime() >= t0 - 5000) return st.last;
  }
  return null;
}

$('#refresh').addEventListener('click', async () => {
  if (!endpoint) await loadEndpoint();
  if (!endpoint) {
    setBtn('Recargando', true);
    await loadIndex(true);
    setBtn('Actualizar', false);
    return;
  }
  const t0 = Date.now();
  setBtn('Llamando al Mac', true);
  let r = {};
  try {
    const res = await fetch(endpoint + '/refresh', { method: 'POST', cache: 'no-store' });
    r = await res.json().catch(() => ({}));
    if (res.status === 429) {
      setStatus(`El Mac pide esperar ${r.retryInSec || 60} s antes de otra descarga. Recargo lo que ya hay.`);
      await loadIndex(true);
      setBtn('Actualizar', false);
      return;
    }
    if (res.status !== 202 && res.status !== 409) throw new Error(r.error || ('HTTP ' + res.status));
  } catch (e) {
    setStatus('No he podido hablar con el Mac (' + e.message + '). Recargo lo publicado.', true);
    await loadIndex(true);
    setBtn('Actualizar', false);
    return;
  }

  setStatus('El Mac está descargando los periódicos. Tarda unos minutos; la página se refresca sola al terminar.');
  const last = await esperarBuild(t0);
  if (!last) {
    setStatus('La descarga sigue en marcha. Pulsa «Actualizar» otra vez en un rato.', true);
    setBtn('Actualizar', false);
    return;
  }
  if (last.ok) {
    await loadIndex(true);
    setStatus(`Listo: ${last.pdfs} PDFs en el archivo, descarga de ${Math.round(last.ms / 1000)} s.`);
    setTimeout(() => setStatus(''), 7000);
  } else {
    setStatus('El Mac terminó con errores (código ' + last.exitCode + ').', true);
  }
  setBtn('Actualizar', false);
});

// ---------- eventos ----------
$('#daySelect').addEventListener('change', async (e) => {
  state.day = e.target.value;
  const dayObj = state.index.days.find((d) => d.date === state.day);
  const avail = dayObj ? dayObj.papers.map((p) => p.slug) : [];
  if (!avail.includes(state.paper)) state.paper = avail[0];
  renderDaySelect();
  if (dayObj) renderTabs(dayObj);
  await loadPaper();
});

$('#prevDay').addEventListener('click', () => {
  const days = state.index?.days || [];
  const i = days.findIndex((d) => d.date === state.day);
  if (i >= 0 && i < days.length - 1) { $('#daySelect').value = days[i + 1].date; $('#daySelect').dispatchEvent(new Event('change')); }
});
$('#nextDay').addEventListener('click', () => {
  const days = state.index?.days || [];
  const i = days.findIndex((d) => d.date === state.day);
  if (i > 0) { $('#daySelect').value = days[i - 1].date; $('#daySelect').dispatchEvent(new Event('change')); }
});

$('#viewerClose').addEventListener('click', closeViewer);
$('#viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeViewer();
  else if ($('#viewer').hidden) {
    if (e.key === 'ArrowLeft') $('#prevDay').click();
    if (e.key === 'ArrowRight') $('#nextDay').click();
  }
});

(async () => {
  await loadEndpoint();
  await loadIndex(false);
})();
